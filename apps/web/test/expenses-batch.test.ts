import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_IMAGES,
  MAX_SOURCE_BYTES_PER_FILE,
  MAX_SOURCE_BYTES_TOTAL,
  batchOutcomeMessage,
  batchSelectionIssue,
  blankSurfaceAdvice,
  buildBatchItems,
  claimItemsPayload,
  clearedByNewImage,
  firstRowPlacement,
  isLargeSurface,
  mbPair,
  mergeIntoRow,
  scanAdvice,
  scanFailureNote,
  uniformRgba,
  type BatchScan,
  type DraftItem,
  type UniformSurface,
} from "../src/pages/Expenses.tsx";
import type { EInvoiceQr, EInvoiceQrScan } from "../src/einvoice-qr.ts";

/**
 * 批次上傳（一次選 N 張）。
 *
 * 這一組驗的**不是「跑得完」**，而是那幾件「跑得完但其實壞掉了」的事：
 * 某一張失敗會不會把整批吃掉（或把使用者原本那一列連坐清掉）、同一批裡的重複發票號碼會不會
 * 一路帶到伺服端才被整批退回、進來的順序是不是選檔的順序、超過上限時使用者有沒有被**照實**告知。
 * 這些在畫面上全都看不出來——十筆進來了、看起來很順，錯的只有其中一筆。
 */

/* ───────────────────────── fixture 的大小是這一包的前提 ─────────────────────────
 *
 * ★ 縮圖字串**一定要用實測大小**。前一版的 fixture 是 `"data:image/jpeg;base64,ok0"`（26 bytes），
 *   於是「POST 預算」那條執行期護欄在結構上永遠不可能被觸發：一萬張也累加不到 8 MB。
 *   那條分支是張數上限的唯一防線，卻零覆蓋——測試在一個「一定會過」的組態上取樣，
 *   守的東西其實一次都沒被守到。把下面兩個常數改小，整包關於預算的斷言就全部變成空跑，
 *   所以另有一條測試盯著它們（見「fixture 是實測大小」）。
 *
 * 數字來源（同 Expenses.tsx 的 THUMB_BASE64_BYTES_WORST）：
 *   readReceiptImage 的規格是最長邊 1200px、JPEG 0.8，再 toDataURL 成 base64。
 *   1200×1200 的單據影像實測：乾淨（掃描件、無雜訊）485 KB；帶手機感光雜訊的翻拍 758 KB。
 */
const THUMB_CLEAN_BYTES = 485 * 1024;
const THUMB_NOISY_BYTES = 758 * 1024;
/** Expenses.tsx 的 POST_BUDGET_BYTES（那邊沒有匯出——這裡寫死一份，並用一條測試釘住兩邊一致） */
const POST_BUDGET_BYTES = 8 * 1024 * 1024;

const DATA_URL_PREFIX = "data:image/jpeg;base64,";
/** 造一個**長度就是實測長度**的縮圖字串；tag 讓每一張分得出來（訊息與斷言都要指得出是哪一張） */
const thumb = (bytes: number, tag: string) => DATA_URL_PREFIX + tag + "A".repeat(bytes - DATA_URL_PREFIX.length - tag.length);

const EMPTY: DraftItem = {
  docType: "receipt",
  accountCode: "",
  description: "",
  amount: 0,
  deductible: false,
  qrNote: null,
  qrIssue: false,
};

const qrOf = (n: number): EInvoiceQr => ({
  invoiceNumber: `AB${String(10000000 + n)}`,
  invoiceDate: "2026-07-21",
  salesAmount: 1000 + n,
  totalAmount: 1050 + n,
  buyerTaxId: "12345678",
  sellerTaxId: "87654321",
});

const okScan = (n: number, bytes = THUMB_CLEAN_BYTES): BatchScan => ({
  image: thumb(bytes, `ok${n}-`),
  qr: qrOf(n),
  scan: { reason: "ok", lefts: [`left-${n}`], left: `left-${n}` },
  uniformSurface: null,
});

/** 帶感光雜訊的翻拍：同樣掃得到，但縮圖大得多——張數的真正判準就是這件事 */
const noisyOkScan = (n: number): BatchScan => okScan(n, THUMB_NOISY_BYTES);

const noQrScan = (n: number): BatchScan => ({
  image: thumb(THUMB_CLEAN_BYTES, `plain${n}-`),
  qr: null,
  scan: { reason: "no-qr", lefts: [], left: null },
  uniformSurface: { uniform: false, width: 3000, height: 4000 },
});

/** 檔名帶進 name，因為失敗訊息必須講得出「是哪一張」——十張裡壞了一張，光說「有一張壞了」等於沒說 */
const named = (names: string[]) => names.map((name) => ({ name }));

/** 檔名 → 該讀出什麼。沒登記的檔名視為讀取途中丟例外（局部失敗那條路） */
function reader(map: Record<string, BatchScan>) {
  return async (file: { name: string }): Promise<BatchScan> => {
    const hit = map[file.name];
    if (!hit) throw new Error("影像格式不支援");
    return hit;
  };
}

describe("fixture 是實測大小（不是隨手寫的短字串）", () => {
  it("縮圖 fixture 的長度就是實測長度——改小它，預算護欄就變回不可能觸發的死碼", () => {
    expect(okScan(0).image.length).toBe(THUMB_CLEAN_BYTES);
    expect(noisyOkScan(0).image.length).toBe(THUMB_NOISY_BYTES);
    expect(noQrScan(0).image.length).toBe(THUMB_CLEAN_BYTES);
    // 一張最壞的縮圖佔掉預算的一成——所以十來張就會撞到，這條路是走得到的
    expect(THUMB_NOISY_BYTES * MAX_BATCH_IMAGES).toBeLessThanOrEqual(POST_BUDGET_BYTES);
    expect(THUMB_NOISY_BYTES * (MAX_BATCH_IMAGES + 1)).toBeGreaterThan(POST_BUDGET_BYTES);
  });
});

describe("一次十張：全部落成明細，順序與選檔順序一致", () => {
  const names = Array.from({ length: 10 }, (_, k) => `IMG_${k}.jpg`);
  // 混合：偶數張有 QR、奇數張沒有（沒有 QR 的要留白等人填，不是消失）
  const map = Object.fromEntries(names.map((n, k) => [n, k % 2 === 0 ? okScan(k) : noQrScan(k)]));

  it("十張全部進來、順序不變，有 QR 的帶入號碼與金額、沒 QR 的留白", async () => {
    const seenProgress: string[] = [];
    const streamed: DraftItem[] = [];
    const { items, skipped } = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing: [] }, {
      onProgress: (current, total) => seenProgress.push(`${current}/${total}`),
      onItem: (item) => streamed.push(item),
    });

    expect(items).toHaveLength(10);
    expect(skipped).toEqual([]);
    // 順序：第 k 筆一定是第 k 個選到的檔案（訊息裡帶著檔名，所以順序是驗得到的）
    for (let k = 0; k < 10; k++) expect(items[k]!.qrNote).toContain(`IMG_${k}.jpg`);
    // 偶數張帶入了那一張自己的發票號碼（不是隔壁那張的）
    for (let k = 0; k < 10; k += 2) {
      expect(items[k]!.invoiceNumber).toBe(qrOf(k).invoiceNumber);
      expect(items[k]!.amount).toBe(qrOf(k).totalAmount);
      expect(items[k]!.docType).toBe("einvoice");
      expect(items[k]!.qrIssue).toBe(false);
    }
    // 奇數張留白等人填——留白不等於消失，那一列還在，而且說得出為什麼沒帶入
    for (let k = 1; k < 10; k += 2) {
      expect(items[k]!.invoiceNumber).toBeUndefined();
      expect(items[k]!.amount).toBe(0);
      expect(items[k]!.qrIssue).toBe(true);
      // 沒辨識成功的那幾筆送 null（清掉），不是 undefined（伺服端讀成「沒送」而沿用上一份）
      expect(items[k]!.qrPayload).toBeNull();
      expect(items[k]!.taxSource).toBeNull();
    }
    // 逐張進度：講得出「第幾張／共幾張」，而且是一張一張報，不是跑完才報一次
    expect(seenProgress).toEqual(Array.from({ length: 10 }, (_, k) => `${k + 1}/10`));
    // 畫面拿的是 onItem 這條路、測試驗的是回傳值——兩者不是同一批的話這個測試沒有在驗畫面
    expect(streamed).toEqual(items);
  });
});

/**
 * 【①④】張數的**真正判準**：執行期累加的真實 base64 長度。
 * 選檔當下那個 MAX_BATCH_IMAGES 是保守下界，它過得了不代表塞得下。
 */
describe("POST 預算：到頂就停手，而且照實說少帶了幾張", () => {
  it("保守下界守得住：整批都是最壞的雜訊縮圖，MAX_BATCH_IMAGES 張仍然全部進得來", async () => {
    const names = Array.from({ length: MAX_BATCH_IMAGES }, (_, k) => `noisy_${k}.jpg`);
    const map = Object.fromEntries(names.map((n, k) => [n, noisyOkScan(k)]));
    const { items, skipped } = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing: [] });
    expect(items).toHaveLength(MAX_BATCH_IMAGES);
    expect(skipped).toEqual([]);
  });

  it("再多一張就到頂：停在那裡，剩下的**整批**回報成沒帶入（不是靜默截斷、不是一堆空列）", async () => {
    const names = Array.from({ length: MAX_BATCH_IMAGES + 3 }, (_, k) => `noisy_${k}.jpg`);
    const map = Object.fromEntries(names.map((n, k) => [n, noisyOkScan(k)]));
    const { items, skipped } = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing: [] });

    expect(items).toHaveLength(MAX_BATCH_IMAGES);
    // 沒帶入的那幾張**點得出名字**，而且沒有偷偷變成一列看起來像明細的空列
    expect(skipped).toEqual([`noisy_${MAX_BATCH_IMAGES}.jpg`, `noisy_${MAX_BATCH_IMAGES + 1}.jpg`, `noisy_${MAX_BATCH_IMAGES + 2}.jpg`]);
    expect(items.some((l) => l.qrNote?.includes(`noisy_${MAX_BATCH_IMAGES}.jpg`))).toBe(false);
    // 真正要守的那件事：帶進來的縮圖加起來沒有超過預算
    const bytes = items.reduce((s, l) => s + (l.image?.length ?? 0), 0);
    expect(bytes).toBeLessThanOrEqual(POST_BUDGET_BYTES);
  });

  it("表單上已經有的照片一起算進預算（同一個 POST 裝的是全部）", async () => {
    const existing: DraftItem[] = Array.from({ length: MAX_BATCH_IMAGES - 2 }, (_, k) => ({
      ...EMPTY,
      image: thumb(THUMB_NOISY_BYTES, `old${k}-`),
      accountCode: "6111",
      amount: 100,
    }));
    const names = Array.from({ length: 5 }, (_, k) => `new_${k}.jpg`);
    const map = Object.fromEntries(names.map((n, k) => [n, noisyOkScan(100 + k)]));
    const { items, skipped } = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing });
    expect(items).toHaveLength(2);
    expect(skipped).toEqual(["new_2.jpg", "new_3.jpg", "new_4.jpg"]);
  });

  it("縮圖小的時候塞得下比 MAX_BATCH_IMAGES 更多張——真正的判準是實際大小，不是那個常數", async () => {
    const n = MAX_BATCH_IMAGES + 4;
    const names = Array.from({ length: n }, (_, k) => `clean_${k}.jpg`);
    const map = Object.fromEntries(names.map((nm, k) => [nm, okScan(k)]));
    const { items, skipped } = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing: [] });
    expect(items).toHaveLength(n);
    expect(skipped).toEqual([]);
    expect(n).toBeGreaterThan(MAX_BATCH_IMAGES);
  });

  it("選檔當下的張數上限與這裡用的是同一個預算（兩邊各寫一份就會各漂各的）", () => {
    expect(MAX_BATCH_IMAGES).toBe(Math.floor(POST_BUDGET_BYTES / THUMB_NOISY_BYTES));
  });
});

describe("局部失敗隔離：壞一張，其餘照樣進來", () => {
  const names = Array.from({ length: 10 }, (_, k) => `IMG_${k}.jpg`);
  // 第 4 張讀不進來（沒有登記在 map 裡＝reader 丟例外）
  const map = Object.fromEntries(names.filter((_, k) => k !== 3).map((n, _i) => [n, okScan(Number(n.slice(4, -4)))]));

  it("第 4 張炸掉，另外九張仍然帶入，且位置沒有前移", async () => {
    const { items } = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing: [] });
    expect(items).toHaveLength(10);
    for (let k = 0; k < 10; k++) {
      if (k === 3) continue;
      expect(items[k]!.invoiceNumber).toBe(qrOf(k).invoiceNumber);
      expect(items[k]!.image).toBeTruthy();
    }
  });

  it("失敗那一張留下看得見的記號與原因（不是靜默消失，也不是一筆沒有記號的空列）", async () => {
    const { items } = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing: [] });
    const bad = items[3]!;
    expect(bad.qrIssue).toBe(true); // 記號：畫面用它決定警示色
    expect(bad.qrNote).toContain("IMG_3.jpg"); // 是哪一張
    expect(bad.qrNote).toContain("影像格式不支援"); // 為什麼
    expect(bad.image).toBeUndefined();
    // 帶著原因的空列不會被偷偷送出去（沒有分類、金額 0）——但它留在畫面上讓人看見
    expect(claimItemsPayload([bad])).toHaveLength(0);
  });

  it("失敗的是最後一張時，前面九張一樣都在（不是靠「壞的排在中間」才成立）", async () => {
    const only9 = Object.fromEntries(names.slice(0, 9).map((n) => [n, okScan(Number(n.slice(4, -4)))]));
    const { items } = await buildBatchItems(named(names), reader(only9), { companyTaxId: null, existing: [] });
    expect(items).toHaveLength(10);
    expect(items.filter((l) => l.invoiceNumber)).toHaveLength(9);
    expect(items[9]!.qrIssue).toBe(true);
  });
});

describe("同號防重：同一批裡重複的發票號碼當下就擋", () => {
  it("同一張發票掃到兩次：第二筆不帶入號碼與金額，並說得出跟誰重複", async () => {
    const names = ["a.jpg", "b.jpg", "c.jpg"];
    const map = { "a.jpg": okScan(1), "b.jpg": okScan(2), "c.jpg": okScan(1) };
    const { items } = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing: [] });
    expect(items[0]!.invoiceNumber).toBe(qrOf(1).invoiceNumber);
    expect(items[1]!.invoiceNumber).toBe(qrOf(2).invoiceNumber);
    // 第三筆是重複的那一張
    expect(items[2]!.invoiceNumber).toBeUndefined();
    expect(items[2]!.amount).toBe(0);
    expect(items[2]!.qrIssue).toBe(true);
    expect(items[2]!.qrNote).toContain(qrOf(1).invoiceNumber);
    expect(items[2]!.qrNote).toContain("a.jpg"); // 跟誰重複
    // 照片仍留著：使用者要判斷「是不是選到同一個檔案」得看得到那張圖
    expect(items[2]!.image).toBeTruthy();
    // 真正的重點：送出去的那一批裡沒有兩筆同號（否則伺服端 422 會把整批退回來）
    const numbers = claimItemsPayload(items.map((l) => ({ ...l, accountCode: "6111", amount: l.amount || 1 })))
      .map((l) => l.invoiceNumber)
      .filter(Boolean);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("跟表單上已經有的明細重複也擋（不是只比這一批自己）", async () => {
    const existing: DraftItem[] = [{ ...EMPTY, invoiceNumber: qrOf(7).invoiceNumber, amount: 500, accountCode: "6111" }];
    const { items } = await buildBatchItems(named(["x.jpg"]), reader({ "x.jpg": okScan(7) }), {
      companyTaxId: "12345678",
      existing,
    });
    expect(items[0]!.invoiceNumber).toBeUndefined();
    expect(items[0]!.qrNote).toContain("表單上已經有的明細");
  });

  /**
   * 【②】只選一張時的防重。畫面那條路（onFiles）以前在 files.length === 1 時繞過整個 buildBatchItems，
   * 於是同號一路帶到伺服端、422 把**整張單**退回——正是前端防重宣稱要避免的結果。
   * 這一條驗的是同一批東西在「只有一個檔案」時照樣被擋。
   */
  it("只選一張也擋得住（一張也是一批，不是另一條沒有防重的捷徑）", async () => {
    const existing: DraftItem[] = [{ ...EMPTY, invoiceNumber: qrOf(7).invoiceNumber, amount: 500, accountCode: "6111" }];
    const { items } = await buildBatchItems(named(["only.jpg"]), reader({ "only.jpg": okScan(7) }), {
      companyTaxId: "12345678",
      existing,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.invoiceNumber).toBeUndefined();
    expect(items[0]!.qrNote).toContain("表單上已經有的明細");
  });

  it("不同號碼不會被誤擋（防重不是「第二張一律擋」）", async () => {
    const { items } = await buildBatchItems(named(["a.jpg", "b.jpg"]), reader({ "a.jpg": okScan(1), "b.jpg": okScan(2) }), {
      companyTaxId: "12345678",
      existing: [],
    });
    expect(items.map((l) => l.invoiceNumber)).toEqual([qrOf(1).invoiceNumber, qrOf(2).invoiceNumber]);
  });
});

describe("選檔當下的上限：擋得下來，而且講得出上限是多少", () => {
  const file = (name: string, size: number) => ({ name, size });

  it("張數超過就擋，訊息帶著上限與現況的數字", () => {
    const msg = batchSelectionIssue(
      Array.from({ length: MAX_BATCH_IMAGES + 1 }, (_, k) => file(`f${k}.jpg`, 1024)),
      0,
    );
    expect(msg).toBeTruthy();
    expect(msg).toContain(String(MAX_BATCH_IMAGES));
    expect(msg).toContain(String(MAX_BATCH_IMAGES + 1));
  });

  it("張數上限含表單上已經帶著照片的明細（同一個 POST 裝的是全部）", () => {
    const files = Array.from({ length: 5 }, (_, k) => file(`f${k}.jpg`, 1024));
    expect(batchSelectionIssue(files, MAX_BATCH_IMAGES - 5)).toBeNull();
    expect(batchSelectionIssue(files, MAX_BATCH_IMAGES - 4)).toContain(String(MAX_BATCH_IMAGES));
  });

  /** 【⑥】「16 MB 超過 16 MB」是這道護欄自己失效的樣子：使用者看不出要縮到多小 */
  it("單張過大就擋，訊息點名是哪一個檔案，而且兩個數字分得出來", () => {
    const msg = batchSelectionIssue([file("小.jpg", 1024), file("巨大.jpg", MAX_SOURCE_BYTES_PER_FILE + 1)], 0)!;
    expect(msg).toContain("巨大.jpg");
    const [got, cap] = mbPair(MAX_SOURCE_BYTES_PER_FILE + 1, MAX_SOURCE_BYTES_PER_FILE);
    expect(got).not.toBe(cap); // 差一個 byte 也要講成兩個不同的數字
    expect(msg).toContain(got);
    expect(msg).toContain(cap);
    // 而且不能兩邊都印成同一個四捨五入後的 "16 MB"（前一版就是這樣，斷言還照樣綠）
    expect(msg.split("16 MB")).toHaveLength(1);
  });

  it("差得多的時候照樣講人看得懂的 MB（不是為了分辨就一律印 bytes）", () => {
    const msg = batchSelectionIssue([file("大.jpg", 25 * 1024 * 1024)], 0)!;
    expect(msg).toContain("25 MB");
    expect(msg).toContain("16 MB");
  });

  it("整批加起來過大就擋，兩個數字同樣分得出來", () => {
    const each = Math.floor(MAX_SOURCE_BYTES_TOTAL / 8) + 1; // 8 張就超過總量，但每一張都在單張上限內
    expect(each).toBeLessThanOrEqual(MAX_SOURCE_BYTES_PER_FILE);
    const msg = batchSelectionIssue(Array.from({ length: 8 }, (_, k) => file(`f${k}.jpg`, each)), 0)!;
    const [got, cap] = mbPair(each * 8, MAX_SOURCE_BYTES_TOTAL);
    expect(got).not.toBe(cap);
    expect(msg).toContain(got);
    expect(msg).toContain(cap);
  });

  it("在上限之內不擋（護欄不是「一律不准批次」）", () => {
    expect(batchSelectionIssue(Array.from({ length: MAX_BATCH_IMAGES }, (_, k) => file(`f${k}.jpg`, 3 * 1024 * 1024)), 0)).toBeNull();
    expect(batchSelectionIssue([], 0)).toBeNull();
  });

  it("上限是算出來的，不是寫死的：8 MB 的 POST 預算 ÷ 實測最大的一張縮圖", () => {
    expect(MAX_BATCH_IMAGES).toBe(Math.floor((8 * 1024 * 1024) / (758 * 1024)));
    expect(MAX_SOURCE_BYTES_PER_FILE).toBe((240 * 1024 * 1024) / 15);
  });
});

describe("mbPair：兩個數字一定分得出來", () => {
  it("差很多就講整數 MB", () => {
    expect(mbPair(25 * 1024 * 1024, 16 * 1024 * 1024)).toEqual(["25 MB", "16 MB"]);
  });

  it("四捨五入後會撞在一起時，自己加小數位", () => {
    const [a, b] = mbPair(16.4 * 1024 * 1024, 16 * 1024 * 1024);
    expect(a).not.toBe(b);
    expect(a).toBe("16.4 MB");
  });

  it("小數位加到三位還一樣（差不到 0.001 MB）就直接講 bytes——寧可難看也不要自相矛盾", () => {
    const [a, b] = mbPair(16 * 1024 * 1024 + 1, 16 * 1024 * 1024);
    expect(a).toBe("16777217 bytes");
    expect(b).toBe("16777216 bytes");
    expect(a).not.toBe(b);
  });
});

describe("整片同色的像素：講「可能超過瀏覽器上限」，不是「沒有 QR」", () => {
  const noQr: Pick<EInvoiceQrScan, "reason" | "lefts"> = { reason: "no-qr", lefts: [] };
  /** 手機直出照片的量級：遠大於我們自己縮出來的圖（最長邊 1200） */
  const bigBlank: UniformSurface = { uniform: true, width: 4032, height: 3024 };

  it("uniformRgba 認得出整片同色與不同色", () => {
    const flat = new Uint8ClampedArray(4 * 100).fill(255);
    expect(uniformRgba(flat)).toBe(true);
    const almost = new Uint8ClampedArray(4 * 100).fill(255);
    almost[4 * 99 + 1] = 254; // 一萬個像素裡只有一個差一階，也不算同色
    expect(uniformRgba(almost)).toBe(false);
    // 全 0（透明黑）＝ canvas 取不回東西時的樣子，同樣算同色
    expect(uniformRgba(new Uint8ClampedArray(4 * 10))).toBe(true);
    // 取不回像素（長度不足一個像素對）也視為「沒拿到可用的像素」
    expect(uniformRgba(new Uint8ClampedArray(4))).toBe(true);
  });

  it("no-qr ＋ 整片同色 ＋ 影像夠大 → 換成「解析度可能超過上限」那一句", () => {
    const msg = scanFailureNote(noQr, bigBlank);
    expect(msg).toBe(blankSurfaceAdvice());
    expect(msg).toContain("超過瀏覽器單張畫布能處理的上限");
    expect(msg).not.toBe(scanAdvice(noQr));
    // 最怕的就是講成「沒掃到，請拍大一點」——照著做只會拍出更大的照片、更確定踩到同一個上限
    expect(msg).not.toContain("拍大一點");
    // 也不能寫死任何面積數值（那是各瀏覽器各版本自己的事）
    expect(msg).not.toMatch(/\d{4,}/);
  });

  /** 【⑦】全白／全黑／過曝／純色截圖的**小圖**：整片同色是它本來的樣子，不是取像素失敗 */
  it("整片同色但影像不大時，講回「沒有解出 QR，請手動填」——不拿畫布上限去蓋掉它", () => {
    for (const size of [
      { width: 800, height: 600 }, // 純色截圖
      { width: 1200, height: 1200 }, // 剛好是縮圖的尺寸
      { width: 2400, height: 1000 }, // 最長邊剛好在門檻上（不算「明顯大於」）
    ]) {
      const msg = scanFailureNote(noQr, { uniform: true, ...size });
      expect(msg).toBe(scanAdvice(noQr));
      expect(msg).not.toBe(blankSurfaceAdvice());
    }
  });

  it("isLargeSurface 是相對判斷（相對於縮圖的最長邊），而且不寫死任何面積數值", () => {
    expect(isLargeSurface(2400, 1000)).toBe(false);
    expect(isLargeSurface(2401, 10)).toBe(true);
    expect(isLargeSurface(10, 2401)).toBe(true); // 直拍也算
    expect(isLargeSurface(4032, 3024)).toBe(true); // 手機直出
  });

  it("探不出來（null）或畫布正常（uniform: false）時，照原本那句 no-qr 講", () => {
    expect(scanFailureNote(noQr, null)).toBe(scanAdvice(noQr));
    expect(scanFailureNote(noQr, { uniform: false, width: 4032, height: 3024 })).toBe(scanAdvice(noQr));
  });

  it("掃到了碼就不拿同色去蓋掉診斷（掃到碼代表畫布上確實有內容）", () => {
    for (const reason of ["not-einvoice", "ambiguous"] as const) {
      const scan: Pick<EInvoiceQrScan, "reason" | "lefts"> = { reason, lefts: reason === "ambiguous" ? ["a", "b"] : [] };
      expect(scanFailureNote(scan, bigBlank)).toBe(scanAdvice(scan));
    }
  });

  it("批次裡整片同色的那一張，訊息走的是同一句", async () => {
    const blank: BatchScan = { ...noQrScan(0), uniformSurface: bigBlank };
    const { items } = await buildBatchItems(named(["big.jpg"]), reader({ "big.jpg": blank }), {
      companyTaxId: null,
      existing: [],
    });
    expect(items[0]!.qrNote).toContain(blankSurfaceAdvice());
    expect(items[0]!.qrIssue).toBe(true);
  });
});

/**
 * 【④】第一張讀不進來時，使用者原本站著的那一列**留著**（firstRowPlacement 說 insert）。
 * 留著就得跟表單上其餘各列一樣占名額——前一版把它交給 existing 之外就不管了，
 * 於是同一批後面的檔案可以帶著跟它相同的發票號碼過關，伺服端 422 把**整張單**退回，
 * 而前端擋重複的唯一理由就是不要走到那一步。
 */
describe("留下來的那一列（第一張讀失敗）照樣算進防重與預算", () => {
  const rowWithInvoice = (n: number, bytes = THUMB_CLEAN_BYTES): DraftItem => ({
    ...EMPTY,
    invoiceNumber: qrOf(n).invoiceNumber,
    amount: 500,
    accountCode: "6111",
    image: thumb(bytes, `row${n}-`),
  });

  it("同號防重：後面的檔案不能帶著跟它相同的發票號碼過關", async () => {
    const { items } = await buildBatchItems(named(["boom.jpg", "dup.jpg"]), reader({ "dup.jpg": okScan(7) }), {
      companyTaxId: "12345678",
      existing: [],
      replacing: rowWithInvoice(7),
    });
    expect(items).toHaveLength(2);
    // 第一張讀不進來 ⇒ 那一列會留著（這一筆是另起的空列，沒有 image）
    expect(items[0]!.image).toBeUndefined();
    expect(items[1]!.invoiceNumber).toBeUndefined();
    expect(items[1]!.qrNote).toContain(qrOf(7).invoiceNumber);
    expect(items[1]!.qrNote).toContain("表單上已經有的明細");
  });

  it("第一張讀得進來時它**不**占名額（那一列正要被整列換掉——換張照片還是同一張發票不算重複）", async () => {
    const { items } = await buildBatchItems(named(["same.jpg"]), reader({ "same.jpg": okScan(7) }), {
      companyTaxId: "12345678",
      existing: [],
      replacing: rowWithInvoice(7),
    });
    expect(items[0]!.invoiceNumber).toBe(qrOf(7).invoiceNumber);
    expect(items[0]!.qrNote).not.toContain("與表單上已經有的明細相同");
  });

  it("位元組預算：它的縮圖也算進去（不然這一批會超出單次送出的預算）", async () => {
    // 表單上另外 8 列 + 留下來的那一列 = 9 張最壞縮圖；接著兩張同樣大的檔案，第二張就該被截斷
    const existing: DraftItem[] = Array.from({ length: 8 }, (_, k) => ({
      ...EMPTY,
      image: thumb(THUMB_NOISY_BYTES, `old${k}-`),
    }));
    const names = ["boom.jpg", "b.jpg", "c.jpg"];
    const map = { "b.jpg": noisyOkScan(1), "c.jpg": noisyOkScan(2) };
    const withRow = await buildBatchItems(named(names), reader(map), {
      companyTaxId: "12345678",
      existing,
      replacing: { ...EMPTY, image: thumb(THUMB_NOISY_BYTES, "row-") },
    });
    expect(withRow.skipped).toEqual(["c.jpg"]);
    // 對照組：那一列若真的被換掉（replacing 不傳）就還塞得下——證明上面那條紅是它造成的，不是門檻本身
    const withoutRow = await buildBatchItems(named(names), reader(map), { companyTaxId: "12345678", existing });
    expect(withoutRow.skipped).toEqual([]);
  });
});

/**
 * 【⑤】一批跑完之後畫面上那一句話。三個數字各自對應到使用者接下來要做的事，
 * 而它們在畫面上長得一模一樣——講錯了沒有任何徵兆。
 */
describe("批次結果那一句話（batchOutcomeMessage）", () => {
  const brought = (n: number): DraftItem => ({ ...EMPTY, image: thumb(THUMB_CLEAN_BYTES, `got${n}-`) });
  const unreadable = (n: number): DraftItem => ({
    ...EMPTY,
    qrIssue: true,
    qrNote: `IMG_${n}.jpg：這張沒有讀進來（影像格式不支援），照片與發票欄位都是空的。`,
  });

  it("全部讀得進來：講的就是張數", () => {
    expect(batchOutcomeMessage([brought(1), brought(2)], [])).toContain("已帶入 2 張");
  });

  it("讀不進來的那幾列不算進「已帶入」，而且要另外講出來", () => {
    const msg = batchOutcomeMessage([brought(1), unreadable(2), unreadable(3)], []);
    expect(msg).toContain("已帶入 1 張");
    expect(msg).toContain("2 張沒有讀進來");
    expect(msg).not.toContain("已帶入 3 張");
  });

  it("沒有讀不進來的就不多講那半句（沒發生的事不佔版面）", () => {
    expect(batchOutcomeMessage([brought(1)], [])).not.toContain("沒有讀進來");
  });

  it("被總量截斷時三個數字各講各的：帶進來幾張、讀不進來幾張、完全沒帶進來哪幾個檔案", () => {
    const msg = batchOutcomeMessage([brought(1), unreadable(2)], ["c.jpg", "d.jpg"]);
    expect(msg).toContain("這批帶了 1 張");
    expect(msg).toContain("1 張沒有讀進來");
    expect(msg).toContain("其餘 2 張");
    expect(msg).toContain("c.jpg");
    expect(msg).toContain("d.jpg");
  });
});

/** 【③】第一張要不要併回使用者原本站著的那一列 */
describe("批次結果落在使用者原本站著的那一列上", () => {
  it("讀不進來的那一張**不併**：它手上什麼都沒有，併進去等於把原本那一列清掉", () => {
    const failed: DraftItem = { ...EMPTY, qrIssue: true, qrNote: "IMG_1.jpg：這張沒有讀進來（影像格式不支援）…" };
    expect(firstRowPlacement(failed)).toBe("insert");
  });

  it("讀得到東西的（含掃不到 QR、同號被擋的）才併——那一列的照片確實換成了這一張", () => {
    expect(firstRowPlacement({ ...EMPTY, image: thumb(THUMB_CLEAN_BYTES, "x-") })).toBe("merge");
    expect(firstRowPlacement({ ...EMPTY, image: thumb(THUMB_CLEAN_BYTES, "y-"), qrIssue: true, qrNote: "同號" })).toBe("merge");
  });

  it("批次第一張失敗時，那一筆的確是「不可併」的（buildBatchItems 與 firstRowPlacement 對得起來）", async () => {
    const { items } = await buildBatchItems(named(["boom.jpg", "ok.jpg"]), reader({ "ok.jpg": okScan(2) }), {
      companyTaxId: "12345678",
      existing: [],
    });
    expect(firstRowPlacement(items[0]!)).toBe("insert");
    expect(firstRowPlacement(items[1]!)).toBe("merge");
  });

  it("使用者已經填的分類與說明留著；辨識出來的金額蓋過原本手打的", () => {
    const row: DraftItem = { ...EMPTY, accountCode: "6111", description: "計程車", amount: 300 };
    const first: DraftItem = { ...EMPTY, image: "img", docType: "einvoice", amount: 1051, invoiceNumber: "AB10000001" };
    const merged = mergeIntoRow(row, first);
    expect(merged.accountCode).toBe("6111");
    expect(merged.description).toBe("計程車");
    // 辨識出來的金額與同一列的發票號碼是同一張憑證上的數字，留著手打的舊金額就是張冠李戴
    expect(merged.amount).toBe(1051);
    expect(merged.invoiceNumber).toBe("AB10000001");
  });

  it("新結果沒有金額（沒掃到）時，使用者**自己打的**金額不會被清成 0", () => {
    const row: DraftItem = { ...EMPTY, accountCode: "6111", amount: 300 };
    expect(mergeIntoRow(row, { ...EMPTY, image: "img", qrIssue: true, qrNote: "x" }).amount).toBe(300);
  });

  it("原本那一列的金額是上一張憑證掃出來的（有 qrPayload），換一張沒掃到的照片就要清掉", () => {
    const scannedRow: DraftItem = { ...EMPTY, accountCode: "6111", amount: 1051, invoiceNumber: "AB10000001", qrPayload: "left-1" };
    const merged = mergeIntoRow(scannedRow, { ...EMPTY, image: "img", ...clearedByNewImage(false), qrIssue: true, qrNote: "沒掃到" });
    // 留著就是「畫面上是這張新照片、金額卻是上一張發票的」，而伺服端的交叉核對也擋不到
    expect(merged.amount).toBe(0);
    expect(merged.invoiceNumber).toBeUndefined();
    expect(merged.qrPayload).toBeNull();
    expect(merged.accountCode).toBe("6111"); // 分類是使用者填的，照樣留著
  });
});

/**
 * 上面驗的是有匯出的那幾支；畫面那一段沒有匯出、在這個環境也 render 不起來
 * （apps/web 沒有裝 testing-library）。所以「畫面真的接到了這幾支」只驗得到原始碼的字面——
 * 少了這一段的話，把 multiple 拿掉、或把批次結果接成另外就地寫的一份，不會有任何測試變紅。
 */
describe("畫面真的接到了批次那一段", () => {
  const source = readFileSync(new URL("../src/pages/Expenses.tsx", import.meta.url), "utf8");
  /** 原始碼裡真的在執行的那幾行——註解裡提到某個寫法（例如「前一版是怎麼壞的」）不該讓斷言變色 */
  const codeLines = source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

  /** 從 `<tag` 起取到這個開始標籤的結尾；大括號裡的 `=>`／`>` 不算結尾 */
  function openingTag(src: string, at: number): string {
    let depth = 0;
    for (let k = at; k < src.length; k++) {
      const ch = src[k]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) return src.slice(at, k + 1);
    }
    throw new Error(`標籤沒有結尾：${src.slice(at, at + 60)}`);
  }

  /** 每一列明細的那一段 JSX（批次期間要鎖住的就是這裡面的每一個控制項） */
  const itemRow = (() => {
    const from = source.indexOf("{items.map((l, i) => (");
    const to = source.indexOf("\n        ))}", from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
  })();

  it("檔案輸入是 multiple，而且走 onFiles（不是只取第一個檔案）", () => {
    expect(source).toMatch(/<input\s+type="file"[^]*?multiple/);
    expect(source).toContain("void onFiles(i, picked)");
  });

  it("選檔當下就叫 batchSelectionIssue，而且擋下來時不繼續跑", () => {
    expect(source).toContain("const issue = batchSelectionIssue(files, items.filter((l, j) => !!l.image && j !== i).length);");
    expect(source).toMatch(/if \(issue\) \{[^}]*setError\(issue\);[^}]*return;/);
  });

  it("同號防重不拿「正要被換掉的那一列」去比（換張照片還是同一張發票不算重複）", () => {
    expect(source).toContain("existing: items.filter((_, j) => j !== i)");
    // 【④】但那一列要交給 replacing：第一張讀不進來時它會留著，那時它就得算進防重與預算
    //（行為由 test/expenses-form.dom.test.tsx 那條端到端測試守，這裡只擋「參數被拿掉」）
    expect(source).toContain("replacing: items[i] ?? null");
  });

  /**
   * 【②】沒有「只選一張」的捷徑：一張與多張走同一條路，防重才守得住。
   *
   * ★ 這裡**不再**逐字比對 `files.length === 1`。那一行是裝飾品：複核實測把捷徑寫成
   *   `files.length < 2` 就照樣全綠——它擋的是某一種寫法，不是那個行為。
   *   真正的護欄是 test/expenses-form.dom.test.tsx 的【②】那一組（真的選一張、再單獨選一張
   *   同號的，斷言第二張被擋下且講得出跟誰重複）。
   *
   * ★ 留下來的兩行守的是**呼叫點的數量**（讀檔只有一條路），不是某個比較式的字面，
   *   但同樣有射程：取個別名再包一層就掃不到。它是便宜的第二道，不是那條紅線本身。
   */
  it("讀檔只有一個呼叫點，而且在批次那條路上（行為由 expenses-form.dom.test.tsx 守）", () => {
    // readReceiptImage 只在批次那支讀檔函式裡被叫；另外開一條路的話這裡會變成兩個
    expect(codeLines.filter((l) => l.includes("readReceiptImage("))).toHaveLength(1);
    // 那唯一一個呼叫在批次的讀檔函式裡（onFiles → buildBatchItems → readBatchFile 這一條）
    const readBatch = source.slice(source.indexOf("const readBatchFile"), source.indexOf("const onFiles"));
    expect(readBatch).toContain("await readReceiptImage(file)");
    expect(source).toContain("const readBatchFile = async (file: File): Promise<BatchScan> =>");
  });

  /**
   * 【①⑤】那句話**不在這裡驗內容**（見下面 batchOutcomeMessage 那一組真的斷言它說什麼）。
   * 這裡只驗接線：畫面用的就是那支純函式，沒有另外在 JSX 裡就地寫一句。
   * 就地寫的字串沒有任何測試守得住——前一版「已帶入 ${files.length} 張」正是那樣進去的。
   */
  it("成功訊息接的是 batchOutcomeMessage（不是在畫面上就地拼一句）", () => {
    expect(codeLines.filter((l) => l.includes("setOk(batchOutcomeMessage(brought, skipped))"))).toHaveLength(1);
    // 掃 codeLines 而不是整份 source：註解裡寫「前一版是這樣壞的」不該讓這條變紅
    const code = codeLines.join("\n");
    expect(code).not.toContain("已帶入 ${files.length} 張");
    expect(code).not.toContain("已帶入 ${brought.length} 張");
  });

  /** 【③】第一張失敗時不併回原本那一列 */
  it("第一張要不要併回原本那一列，由 firstRowPlacement 決定", () => {
    expect(source).toContain("const merge = placed === 0 && firstRowPlacement(item) === \"merge\";");
    expect(source).toContain("if (merge && row) return [...ls.slice(0, at), mergeIntoRow(row, item), ...ls.slice(at + 1)];");
  });

  it("逐張進度接到畫面上（不是只算了沒顯示）", () => {
    expect(source).toContain("onProgress: (current, total) => setBatchProgress({ current, total })");
    expect(source).toContain("正在辨識第 {batchProgress.current}／{batchProgress.total} 張");
  });

  it("一張一張進畫面（onItem），不是整批跑完才更新一次", () => {
    expect(source).toContain("onItem: (item) => {");
  });

  it("只有 no-qr 那條路才去探畫布（掃到碼就不必再展開一次像素）", () => {
    expect(source).toContain('uniformSurface: scan.reason === "no-qr" ? await probeUniformSurface(file) : null');
  });

  it("探測把尺寸帶出來（沒有它就分不出「畫布回空白」與「這張本來就是純色的」）", () => {
    expect(source).toContain("async function probeUniformSurface(file: File): Promise<UniformSurface | null>");
    expect(source).toContain("return { uniform: true, width: w, height: h };");
    expect(source).toContain("return { uniform: false, width: w, height: h };");
  });

  it("失敗那幾筆刪得掉（沒有刪除鍵的話，帶原因的空列只能整張單重來）", () => {
    const line = source.split("\n").find((l) => l.includes("刪除這筆</button>"));
    expect(line).toContain("removeItem(i)");
  });

  it("沒有靜默縮圖：批次這一段不自己改解析度（縮圖會糊掉小 QR）", () => {
    expect(source).not.toContain("drawImage(img, 0, 0, ");
  });

  /**
   * 【⑧】批次期間鎖住編輯。
   * 這一條不是列一張「該鎖哪幾個」的清單（那種清單會跟著畫面長出新控制項而過期），
   * 而是把明細那一列裡**每一個** select／input／button 都掃出來，一個沒鎖就紅。
   */
  it("批次進行中，明細那一列的每一個控制項都鎖住（patch 是 index-based，而批次正在往中間插列）", () => {
    const tags = [...itemRow.matchAll(/<(select|input|button|CategorySuggestions)\b/g)];
    expect(tags.length).toBeGreaterThanOrEqual(8);
    const unlocked = tags
      .map((m) => openingTag(itemRow, m.index!))
      .filter((tag) => !/disabled=\{/.test(tag));
    expect(unlocked).toEqual([]);
  });

  it("鎖的來源是批次進度本身（不是另外一個會忘記同步的旗標）", () => {
    const tags = [...itemRow.matchAll(/<(select|input|button|CategorySuggestions)\b/g)].map((m) => openingTag(itemRow, m.index!));
    for (const tag of tags) expect(tag).toContain("disabled={!!batchProgress}");
    expect(source).toContain('<button className="primary" onClick={submit} disabled={!!batchProgress}>');
  });
});
