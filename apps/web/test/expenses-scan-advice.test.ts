import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clearedQrResultPatch, scanAdvice, scannedItemPatch } from "../src/pages/Expenses.tsx";
import type { EInvoiceQr } from "../src/einvoice-qr.ts";

/**
 * 掃描結果 → 使用者看到的訊息。
 *
 * 為什麼這件事值得測：把 reason 分細（einvoice-qr.ts）唯一的用處就是讓訊息說得出下一步。
 * reason 分好了卻沒有任何消費者的話，使用者看到的訊息與改動前一字不差。
 * 所以這裡驗的不是字面漂亮，而是「每一種 reason 各自講出**不同的、做得到的**下一步」。
 */
describe("scanAdvice", () => {
  it("not-einvoice：指路是「把左邊那個碼一起拍進去」，不是「請手動填」", () => {
    const msg = scanAdvice({ reason: "not-einvoice", lefts: [] });
    expect(msg).toContain("左邊");
    // 這條路最怕的就是被講成「沒掃到」——那會讓一張有左碼的電子發票被當成沒有憑證的單據，
    // 使用者只會一直重拍同一種構圖（右碼入鏡、左碼在框外）
    expect(msg).not.toContain("沒有解出任何 QR");
  });

  it("ambiguous：講明白「有不只一張發票」與「請一張一張拍」，並說出掃到幾張", () => {
    const msg = scanAdvice({ reason: "ambiguous", lefts: ["A", "B"] });
    expect(msg).toContain("不只一張發票");
    expect(msg).toContain("一張一張拍");
    expect(msg).toContain("2 個");
    // 掃到三張就要說三張：寫死在某個數字上等於沒接到 lefts
    expect(scanAdvice({ reason: "ambiguous", lefts: ["A", "B", "C"] })).toContain("3 個");
  });

  it("no-qr：才是「請手動填」，而且照解碼器的現況講（整張影像解一次，不是只掃某幾塊）", () => {
    const msg = scanAdvice({ reason: "no-qr", lefts: [] });
    expect(msg).toContain("手動填");
    expect(msg).toContain("整張影像");
    // 解碼器換成 zxing 之後就沒有「固定幾塊區域」這回事了（見 einvoice-qr.ts 的 scanEInvoiceQr）。
    // 留著舊說法會把人指去做一件沒有用的事：挪動構圖讓 QR 落進某一塊
    expect(msg).not.toContain("只掃");
    expect(msg).not.toContain("掃過的區域");
  });

  it("ok：這條走不到；真的走到就照實說是系統內部不一致，而不是假裝辨識成功", () => {
    const msg = scanAdvice({ reason: "ok", lefts: ["A"] });
    expect(msg).toContain("回報給維護者");
  });

  it("四種 reason 給的是四種不同的訊息（分不出來就等於沒分）", () => {
    const msgs = (["not-einvoice", "ambiguous", "no-qr", "ok"] as const).map((reason) =>
      scanAdvice({ reason, lefts: [] }),
    );
    expect(new Set(msgs).size).toBe(4);
    for (const m of msgs) expect(m.length).toBeGreaterThan(20);
  });
});

const QR: EInvoiceQr = {
  invoiceNumber: "AB12345678",
  invoiceDate: "2026-07-21",
  salesAmount: 1000,
  totalAmount: 1050,
  buyerTaxId: "12345678",
  sellerTaxId: "87654321",
};

/**
 * 零斷言：畫面上的每一句話都不得替使用者判斷稅法（連「收據無進項稅可扣」都不行——
 * 那是系統在說一張單據在稅法上能不能扣，而系統並不知道）。
 * 可以講的是**系統做了什麼**：先勾了什麼、先不勾什麼、由誰依什麼判定。
 *
 * 這一組把所有「會出現在使用者眼前」的字串都跑一次，而不是只看某一句：
 * 只挑一句來驗的話，下一句寫回斷言時沒有任何測試會紅。
 */
const ASSERTION_WORDS = [
  "無進項稅可扣", // 上一輪複核點名的那一句
  "依法",
  "法規",
  "稅法規定",
  "報稅時",
  "不能扣",
  "可以扣",
  "應稅",
  "免稅",
];

describe("零斷言：使用者看得到的字串不替他判斷稅法", () => {
  const messages = [
    ...(["not-einvoice", "ambiguous", "no-qr", "ok"] as const).map((reason) => scanAdvice({ reason, lefts: ["A", "B"] })),
    String(scannedItemPatch(QR, "left", "12345678").qrNote),
    String(scannedItemPatch(QR, "left", "99999999").qrNote),
    String(scannedItemPatch({ ...QR, buyerTaxId: null }, "left", "99999999").qrNote),
    String(scannedItemPatch(QR, "left", null).qrNote),
    String(clearedQrResultPatch().qrNote),
  ];

  it("沒有任何一句在講稅法上可不可以扣", () => {
    for (const m of messages) {
      for (const word of ASSERTION_WORDS) expect(m).not.toContain(word);
    }
  });

  it("掃描失敗時講的是「系統先不勾、由伺服端判定」，不是「這張不能扣」", () => {
    for (const reason of ["not-einvoice", "no-qr"] as const) {
      const msg = scanAdvice({ reason, lefts: [] });
      expect(msg).toContain("先不勾可扣抵");
      // 判定的主體要講出來：是伺服端依使用者自己的參數與憑證判定，不是這個提示框說了算
      expect(msg).toContain("由伺服端依你的稅法參數與憑證判定");
    }
  });

  /**
   * 上面驗的是有匯出的那幾支；畫面上還有一堆寫死在 JSX 裡的字串（沒有匯出、在這個環境
   * 也 render 不起來——apps/web 沒有裝 testing-library，見 vitest 的設定）。
   * 那些字串同樣會出現在使用者眼前，所以整個檔案再掃一次字面。
   */
  it("整個檔案（含 JSX 裡寫死的字串與註解）都沒有留下斷言句", () => {
    const source = readFileSync(new URL("../src/pages/Expenses.tsx", import.meta.url), "utf8");
    for (const word of ASSERTION_WORDS) expect(source).not.toContain(word);
  });
});
