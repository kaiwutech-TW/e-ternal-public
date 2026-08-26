/**
 * 左碼解析：伺服端要靠這支自己讀 QR 原始字串，才不必相信前端送來的金額。
 * 因此這裡的重點不是「能解出來」，而是「不該解出來的一律 null」——
 * 一旦回了半套或猜出來的欄位，那個數字會直接變成帳上的進項稅。
 */
import { describe, expect, it } from "vitest";
import { parseEInvoiceLeftQr } from "../src/qr.ts";

/** 依規格拼一段左碼：前 77 碼定長，之後接自行使用區。 */
function left(o: {
  number?: string;
  rocDate?: string;
  random?: string;
  sales?: string;
  total?: string;
  buyer?: string;
  seller?: string;
  tail?: string;
}): string {
  return (
    (o.number ?? "AB12345678") +
    (o.rocDate ?? "1150721") +
    (o.random ?? "1234") +
    (o.sales ?? "000003E8") +
    (o.total ?? "0000041A") +
    (o.buyer ?? "12345675") +
    (o.seller ?? "53212539") +
    "0".repeat(24) +
    (o.tail ?? ":**********:1:1:1:測試品:1:1050")
  );
}

describe("parseEInvoiceLeftQr", () => {
  it("正常左碼：所有欄位都解出來，民國年換成西元、hex 金額換成整數元", () => {
    expect(parseEInvoiceLeftQr(left({}))).toEqual({
      invoiceNumber: "AB12345678",
      invoiceDate: "2026-07-21",
      salesAmount: 1000,
      totalAmount: 1050,
      buyerTaxId: "12345675",
      sellerTaxId: "53212539",
    });
  });

  it("買方統編全 0＝未打統編 → null，不能讓 \"00000000\" 流進帳上", () => {
    expect(parseEInvoiceLeftQr(left({ buyer: "00000000" }))?.buyerTaxId).toBeNull();
  });

  it("銷售額與總計額分別解析：兩者相等時也各自解對（不是把總計額複製一份）", () => {
    const r = parseEInvoiceLeftQr(left({ sales: "000003E8", total: "000003E8" }));
    expect(r?.salesAmount).toBe(1000);
    expect(r?.totalAmount).toBe(1000);
  });

  it("銷售額不是從總計額回推的：換掉銷售額欄位，總計額不動", () => {
    const r = parseEInvoiceLeftQr(left({ sales: "0000000F", total: "000003E8" }));
    expect(r?.salesAmount).toBe(15);
    expect(r?.totalAmount).toBe(1000);
  });

  it("小寫 hex 也吃得下（規格未限定大小寫，掃到什麼算什麼）", () => {
    expect(parseEInvoiceLeftQr(left({ sales: "0000041a", total: "0000041a" }))?.totalAmount).toBe(1050);
  });

  it("民國年跨百位：099 年＝2010 年", () => {
    expect(parseEInvoiceLeftQr(left({ rocDate: "0991231" }))?.invoiceDate).toBe("2010-12-31");
  });

  it("右碼（** 開頭）→ null：右碼只有明細接續，沒有金額欄位", () => {
    expect(parseEInvoiceLeftQr("**")).toBeNull();
    expect(parseEInvoiceLeftQr("**測試品:2:525")).toBeNull();
  });

  it("格式不符 → null：不是發票號碼、欄位太短、非 hex 金額、空字串都不猜", () => {
    expect(parseEInvoiceLeftQr("")).toBeNull();
    expect(parseEInvoiceLeftQr("https://example.test/pay/123")).toBeNull();
    expect(parseEInvoiceLeftQr(left({}).slice(0, 40))).toBeNull(); // 定長段被截斷
    expect(parseEInvoiceLeftQr(left({ number: "A123456789" }))).toBeNull(); // 只有一碼英文
    expect(parseEInvoiceLeftQr(left({ sales: "0000ZZ00" }))).toBeNull(); // 非 hex
    expect(parseEInvoiceLeftQr(left({ buyer: "1234567X" }))).toBeNull(); // 統編非數字
  });

  it("解析不做驗真：欄位齊全的自製字串照樣解得出來，呼叫端不得當成已驗證", () => {
    // 加密驗證區這裡塞任意值也不影響——本系統從未驗證那 24 碼，這是刻意記錄下來的事實
    expect(parseEInvoiceLeftQr(left({}).replace("0".repeat(24), "X".repeat(24)))).not.toBeNull();
  });
});
