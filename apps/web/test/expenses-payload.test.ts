import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  claimItemsPayload,
  clearedByNewImage,
  clearedQrResultPatch,
  clearedTaxSource,
  scannedItemPatch,
  type DraftItem,
} from "../src/pages/Expenses.tsx";
import type { EInvoiceQr } from "../src/einvoice-qr.ts";

/**
 * 送出去的 **payload 形狀**——不是畫面。
 *
 * 為什麼非測 payload 不可：taxSource／qrPayload 各有兩種「沒有值」，而它們的意思相反——
 * `undefined`＝前端沒送這個欄位 → 伺服端**沿用**它自己存著的上一次選擇；
 * `null`＝使用者明確清掉 → 伺服端重新問一次（見 api/src/services/expenses.ts 的 carried 段）。
 * `JSON.stringify` 會把值是 undefined 的欄位整個丟掉，所以「取消指定」若送 undefined，
 * 使用者看到的是「已取消」、伺服端收到的是「沒提到這件事」——按鈕按了等於沒按，
 * 而畫面上沒有任何跡象。只有把 payload 真的 stringify 一次才看得見這件事。
 */
const wire = (items: DraftItem[]) => {
  const json = JSON.stringify({ items: claimItemsPayload(items) });
  return { json, items: (JSON.parse(json) as { items: Record<string, unknown>[] }).items };
};

const SCANNED: DraftItem = {
  docType: "einvoice",
  accountCode: "6111",
  description: "計程車",
  amount: 1050,
  invoiceNumber: "AB12345678",
  invoiceDate: "2026-07-21",
  sellerTaxId: "87654321",
  qrPayload: "AB123456781150721123400000000000000041A",
  taxSource: "voucher",
  deductible: true,
  qrNote: null,
  qrIssue: false,
};

describe("送出去的 taxSource：undefined（沿用）與 null（清掉）是兩件不同的事", () => {
  it("JSON.stringify 留得住 null、留不住 undefined——整條規則就建立在這上面", () => {
    expect(JSON.stringify({ taxSource: undefined })).toBe("{}");
    expect(JSON.stringify({ taxSource: null })).toBe('{"taxSource":null}');
  });

  it("「取消指定」送出的是 null（欄位在、值是 null），不是把欄位丟掉", () => {
    const sent = wire([{ ...SCANNED, ...clearedTaxSource() }]);
    expect(sent.json).toContain('"taxSource":null');
    expect(Object.hasOwn(sent.items[0]!, "taxSource")).toBe(true);
    expect(sent.items[0]!["taxSource"]).toBeNull();
  });

  it("改了金額＝上一次的指定是對著另一個數字做的，一樣送 null", () => {
    // 畫面上金額 onChange 送的就是這個形狀
    const sent = wire([{ ...SCANNED, amount: 2100, ...clearedTaxSource() }]);
    expect(sent.json).toContain('"taxSource":null');
    expect(sent.items[0]!["amount"]).toBe(2100);
  });

  it("使用者沒動過的那一筆才是「沿用」：欄位根本不出現在 payload 裡", () => {
    const untouched: DraftItem = { ...SCANNED, taxSource: undefined };
    const sent = wire([untouched]);
    expect(sent.json).not.toContain("taxSource");
    expect(Object.hasOwn(sent.items[0]!, "taxSource")).toBe(false);
  });
});

describe("清除這張憑證的辨識結果（四欄交叉核對 422 的出路）", () => {
  it("qrPayload 與 taxSource 都送 null——送 undefined 的話伺服端會沿用它存著的 QR 原文，等於沒清", () => {
    const sent = wire([{ ...SCANNED, ...clearedQrResultPatch() }]);
    expect(sent.json).toContain('"qrPayload":null');
    expect(sent.json).toContain('"taxSource":null');
    expect(sent.items[0]!["qrPayload"]).toBeNull();
    expect(sent.items[0]!["taxSource"]).toBeNull();
  });

  it("清掉之後不再替這筆主張可扣抵（系統手上沒有可據以導出稅額的憑證原文了）", () => {
    expect(clearedQrResultPatch().deductible).toBe(false);
    // 使用者填的發票號碼／金額不動：出路的定義就是「改用你自己填的數字」
    const sent = wire([{ ...SCANNED, ...clearedQrResultPatch() }]);
    expect(sent.items[0]!["invoiceNumber"]).toBe("AB12345678");
    expect(sent.items[0]!["amount"]).toBe(1050);
  });

  it("提示要講得出「清掉了什麼」與「怎麼恢復」", () => {
    const note = String(clearedQrResultPatch().qrNote);
    expect(note).toContain("交叉核對");
    expect(note).toContain("重新上傳");
  });
});

describe("換了一張照片、這次沒辨識成功", () => {
  it("上一張的 QR 原文與稅額來源都送 null（不是丟掉欄位）", () => {
    // hadQr=false：使用者自己打過金額的那一列。hadQr=true 的那一列金額被清成 0，
    // 在 claimItemsPayload 就被過濾掉了（他還沒填新的數字），根本輪不到 payload 這一關
    const sent = wire([{ ...SCANNED, ...clearedByNewImage(false) }]);
    expect(sent.json).toContain('"qrPayload":null');
    expect(sent.json).toContain('"taxSource":null');
    expect(sent.items[0]!["amount"]).toBe(1050);
  });

  it("原本是掃出來的金額才清成 0；使用者自己打的數字不因為換張照片就沒了", () => {
    expect(clearedByNewImage(true).amount).toBe(0);
    expect(Object.hasOwn(clearedByNewImage(false), "amount")).toBe(false);
  });

  it("發票欄位一併清掉——留著就是把前一張的號碼安到這張照片上", () => {
    const patch = clearedByNewImage(true);
    expect(patch.invoiceNumber).toBeUndefined();
    expect(patch.invoiceDate).toBeUndefined();
    expect(patch.sellerTaxId).toBeUndefined();
    expect(patch.docType).toBe("receipt");
    expect(patch.deductible).toBe(false);
  });
});

const QR: EInvoiceQr = {
  invoiceNumber: "CD87654321",
  invoiceDate: "2026-08-03",
  salesAmount: 2000,
  totalAmount: 2100,
  buyerTaxId: "12345678",
  sellerTaxId: "87654321",
};

describe("掃到唯一一個左碼", () => {
  it("換了一張憑證＝上一張選的稅額來源不算數，送 null 讓伺服端重新問", () => {
    const sent = wire([{ ...SCANNED, ...scannedItemPatch(QR, "LEFT-RAW", "12345678") }]);
    expect(sent.json).toContain('"taxSource":null');
    expect(sent.items[0]!["taxSource"]).toBeNull();
  });

  it("送出去的是左碼**原文**，不是解析後的銷售額（稅額的信任邊界在伺服端）", () => {
    const sent = wire([{ ...SCANNED, ...scannedItemPatch(QR, "LEFT-RAW", "12345678") }]);
    expect(sent.items[0]!["qrPayload"]).toBe("LEFT-RAW");
    expect(sent.json).not.toContain("salesAmount");
    expect(sent.items[0]!["amount"]).toBe(2100);
    expect(sent.items[0]!["invoiceNumber"]).toBe("CD87654321");
    expect(sent.items[0]!["invoiceDate"]).toBe("2026-08-03");
    expect(sent.items[0]!["sellerTaxId"]).toBe("87654321");
  });

  it("買方統編與公司基本檔相同才先勾可扣抵；不同、沒有、或公司統編沒填都先不勾", () => {
    expect(scannedItemPatch(QR, "L", "12345678").deductible).toBe(true);
    expect(scannedItemPatch(QR, "L", "99999999").deductible).toBe(false);
    expect(scannedItemPatch({ ...QR, buyerTaxId: null }, "L", "12345678").deductible).toBe(false);
    // 公司基本檔沒填統編＝無從比對，不是「相同」
    expect(scannedItemPatch(QR, "L", null).deductible).toBe(false);
  });

  it("提示要說得出比對的兩邊各是什麼（不同時把兩個統編都寫出來）", () => {
    const note = String(scannedItemPatch(QR, "L", "99999999").qrNote);
    expect(note).toContain("12345678");
    expect(note).toContain("99999999");
    expect(note).toContain("CD87654321");
  });
});

describe("claimItemsPayload 的過濾", () => {
  it("沒選分類或金額 0 的那幾列不送出（畫面上的「有效明細」與送出去的必須是同一批）", () => {
    const empty: DraftItem = { docType: "receipt", accountCode: "", description: "", amount: 0, deductible: false, qrNote: null, qrIssue: false };
    expect(claimItemsPayload([empty])).toHaveLength(0);
    expect(claimItemsPayload([{ ...empty, accountCode: "6111" }])).toHaveLength(0);
    expect(claimItemsPayload([{ ...empty, amount: 100 }])).toHaveLength(0);
    expect(claimItemsPayload([SCANNED, empty])).toHaveLength(1);
  });

  it("說明留空時不送空字串（伺服端的 description 是選填欄位）", () => {
    const sent = wire([{ ...SCANNED, description: "" }]);
    expect(Object.hasOwn(sent.items[0]!, "description")).toBe(false);
  });
});

/**
 * 上面測的是幾支純函式；畫面有沒有真的接到它們，是另一件事。
 *
 * 這一組刻意驗**原始碼的字面**：這個檔案的 render 在這個環境跑不起來
 * （apps/web 沒有裝 testing-library，也不能為了測試裝——不在這一輪能動的檔案裡），
 * 所以「按鈕按下去送的是 null」這條線的最後一段只驗得到「按鈕接的是哪一支」。
 * 少了這一段的話，把 onClick 改回 `{ taxSource: undefined }` 不會有任何測試變紅，
 * 而那正是這一輪要修的那個缺陷。
 */
describe("畫面真的接到了那幾支（不是另外就地寫一份 undefined）", () => {
  const source = readFileSync(new URL("../src/pages/Expenses.tsx", import.meta.url), "utf8");

  it("整個檔案裡沒有任何一處把 taxSource／qrPayload 設成 undefined", () => {
    expect(source).not.toContain("taxSource: undefined");
    expect(source).not.toContain("qrPayload: undefined");
  });

  it("「取消指定」那個按鈕送的是 clearedTaxSource()", () => {
    const line = source.split("\n").find((l) => l.includes("取消指定</button>"));
    expect(line).toBeDefined();
    expect(line).toContain("clearedTaxSource()");
  });

  it("金額改動時一併清掉稅額來源（那個指定是對著另一個數字做的）", () => {
    const line = source.split("\n").find((l) => l.includes("金額（發票上的總額）"));
    expect(line).toBeDefined();
    expect(line).toContain("clearedTaxSource()");
  });

  it("「清除這張憑證的辨識結果」那個按鈕存在，而且走 clearQrResult", () => {
    const line = source.split("\n").find((l) => l.includes("清除這張憑證的辨識結果</button>"));
    expect(line).toBeDefined();
    expect(line).toContain("clearQrResult(i)");
    expect(source).toContain("setItem(i, clearedQrResultPatch())");
  });

  it("報銷單詳情把伺服端重建的 taxNotes 列出來（核准者看得到那兩個競爭的數字）", () => {
    expect(source).toContain("<TaxNotes notes={detail.taxNotes} />");
  });
});
