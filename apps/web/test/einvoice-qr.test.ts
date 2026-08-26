import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readBarcodes } from "zxing-wasm/reader";
import zxingWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { blank, fillRect, pasteOn, renderCode39, renderQr, sideBySide, type Bitmap } from "./qr-fixtures.ts";
import {
  buildEInvoiceQrPayloads,
  receiptBarcodeText,
  parseEInvoiceQr,
  scanEInvoiceQr,
  ZXING_MODULE_OVERRIDES,
} from "../src/einvoice-qr.ts";

/**
 * 放在 src 外面：apps/web 的 tsconfig 只收 src，vitest 又不是這個 package 的相依，
 * 測試檔留在 src 裡會讓 `pnpm typecheck` 找不到 "vitest" 而整包紅掉。
 * 點陣圖工具在 qr-fixtures.ts（不用 canvas：測試環境沒有 canvas 實作，解碼器只吃 RGBA 陣列）。
 */

/**
 * ── 「執行期不向外部網路取任何資產」是**跑出來的**，不是註解裡的宣稱 ────────────
 *
 * zxing-wasm 的預設 `locateFile` 指向 `https://fastly.jsdelivr.net/npm/zxing-wasm@…`
 * （見 node_modules/zxing-wasm/dist/es/share.js）。einvoice-qr.ts 在模組頂層把它覆寫成
 * vite 打包出來的自家資產；這裡不繞過那條路，而是**讓它照原樣跑**：
 *
 * - 把 emscripten glue 推進「瀏覽器」那條分支（它只認 window／WorkerGlobalScope／Bun，
 *   沒有 node 讀檔路徑），於是它會呼叫 fetch 去抓 wasm；
 * - 用一個只認得自家資產路徑的 fetch 假替身接住：外部 URL 一律丟例外，並把每一次
 *   請求記在 FETCHED 裡。
 *
 * 所以只要有人拿掉那行覆寫、或把它指到 CDN，**整份測試會在第一次解碼時就炸**，
 * 而不是安靜地從網路上抓一個檔跑綠燈。下面還有一個 it 直接斷言 FETCHED 的內容。
 *
 * （wasm 檔案位置從同一個 `?url` import 推出來，不另外寫死路徑：正式環境那個 import
 *   要是指到別的東西，這裡會先炸，而不是測到另一個檔。）
 */
const WASM_PATH = zxingWasmUrl.startsWith("/@fs/") ? zxingWasmUrl.slice("/@fs".length) : zxingWasmUrl;
const FETCHED: string[] = [];
// glue 用 `!!globalThis.window` 判斷環境；node 底下沒有 window，補一個上去它才會走 fetch 這條路
(globalThis as Record<string, unknown>).window ??= globalThis;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  FETCHED.push(url);
  if (url !== zxingWasmUrl) throw new Error(`測試不允許對外取資產：${url}`);
  return new Response(readFileSync(WASM_PATH), { headers: { "content-type": "application/wasm" } });
}) as typeof fetch;

it("解碼器的 wasm 位置是自家資產，不是外部 CDN", () => {
  // 覆寫本身：einvoice-qr.ts 登記給 zxing-wasm 的那一個
  expect(ZXING_MODULE_OVERRIDES.locateFile("zxing_reader.wasm", "https://fastly.jsdelivr.net/npm/")).toBe(zxingWasmUrl);
  expect(zxingWasmUrl).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
});

// 固定欄位用的樣本。銷售額與總計額在這裡只是「兩個要原樣搬進 QR 的固定欄位」，
// 測試不驗算兩者之間的關係，也不代表任何稅率。
const SAMPLE: Parameters<typeof buildEInvoiceQrPayloads>[0] = {
  invoiceNumber: "AB12345678",
  invoiceDate: "2026-07-21",
  randomNumber: "7788",
  salesAmount: 4321,
  totalAmount: 4567,
  buyerTaxId: "12345678",
  sellerTaxId: "87654321",
  items: [{ name: "文具", qty: 2, unitPrice: 100 }],
};
const SAMPLE_FIELDS = {
  invoiceNumber: "AB12345678",
  invoiceDate: "2026-07-21",
  salesAmount: 4321,
  totalAmount: 4567,
  buyerTaxId: "12345678",
  sellerTaxId: "87654321",
};

const RIGHT = "**:文具:2:100";
const scanOf = (bmp: Bitmap) => scanEInvoiceQr(bmp.data, bmp.width, bmp.height);

describe("scanEInvoiceQr", () => {
  it("只有左碼時解得出固定欄位", async () => {
    const { left } = buildEInvoiceQrPayloads(SAMPLE);
    const scan = await scanOf(renderQr(left));
    expect(scan.reason).toBe("ok");
    expect(scan.left).toBe(left);
    // 銷售額（未稅）與總計額是兩個各自獨立的固定欄位，這裡只驗「原樣搬進去、原樣解出來」，
    // 不驗兩者之間的關係——它們的差是憑證自己載明的，不是這支函式算出來的
    expect(scan.qr).toEqual(SAMPLE_FIELDS);
    expect(scan.right).toBeNull();
  });

  // 沒打統編的 B2C 發票：買方欄是 8 個 0，要回 null 而不是字串 "00000000"——
  // 呼叫端是拿它跟公司統編比對來決定可不可扣抵的，比錯就會標成可扣抵。
  it("買方統編欄全 0 時回 null", async () => {
    const { left } = buildEInvoiceQrPayloads({ ...SAMPLE, buyerTaxId: null });
    const scan = await scanOf(renderQr(left));
    expect(scan.reason).toBe("ok");
    expect(scan.qr?.buyerTaxId).toBeNull();
    expect(scan.qr?.sellerTaxId).toBe("87654321");
  });

  it("左碼在左、右碼在右：解出左碼欄位並原樣帶出右碼", async () => {
    const { left } = buildEInvoiceQrPayloads(SAMPLE);
    const scan = await scanOf(sideBySide([renderQr(left), renderQr(RIGHT)]));
    expect(scan.reason).toBe("ok");
    expect(scan.qr?.invoiceNumber).toBe("AB12345678");
    expect(scan.qr?.totalAmount).toBe(4567);
    expect(scan.right).toBe(RIGHT);
  });

  // 位置對調：左碼在右、右碼在左。左碼欄位仍然要解得出來，證明判斷靠的是內容不是位置。
  it("右碼在左、左碼在右也一樣解得出左碼欄位（不是靠位置猜的）", async () => {
    const { left } = buildEInvoiceQrPayloads(SAMPLE);
    const scan = await scanOf(sideBySide([renderQr(RIGHT), renderQr(left)]));
    expect(scan.reason).toBe("ok");
    expect(scan.left).toBe(left);
    expect(scan.qr).toEqual(SAMPLE_FIELDS);
  });

  it("只拍到右碼：回報「不是電子發票左碼」而不是「沒有 QR」", async () => {
    const scan = await scanOf(renderQr(RIGHT));
    expect(scan.reason).toBe("not-einvoice");
    expect(scan.qr).toBeNull();
    expect(scan.left).toBeNull();
    expect(scan.lefts).toEqual([]);
    expect(scan.right).toBe(RIGHT);
    expect(scan.codes).toContain(RIGHT);
  });

  it("影像裡有 QR 但根本不是電子發票：也是 not-einvoice", async () => {
    const scan = await scanOf(renderQr("https://example.invalid/pay"));
    expect(scan.reason).toBe("not-einvoice");
    expect(scan.qr).toBeNull();
    expect(scan.right).toBeNull();
    expect(scan.codes).toEqual(["https://example.invalid/pay"]);
  });

  it("整張空白：沒有任何碼", async () => {
    const scan = await scanOf(blank(320, 240));
    expect(scan.reason).toBe("no-qr");
    expect(scan.codes).toEqual([]);
    expect(scan.qr).toBeNull();
    expect(scan.right).toBeNull();
  });

  it("同一張發票在影像裡出現兩次（重複的碼）不算兩張——去重後仍是 ok", async () => {
    const { left } = buildEInvoiceQrPayloads(SAMPLE);
    const one = renderQr(left);
    const photo = pasteOn(blank(1200, 900), sideBySide([one, one], 40), 100, 100);
    const scan = await scanOf(photo);
    expect(scan.reason).toBe("ok");
    expect(scan.lefts).toEqual([left]);
    expect(scan.qr?.invoiceNumber).toBe("AB12345678");
  });

  it("一個左碼＋兩個右碼：左碼照樣解出，但右碼分不出是誰的續頁就不帶", async () => {
    const { left } = buildEInvoiceQrPayloads(SAMPLE);
    const photo = blank(1400, 1000);
    pasteOn(photo, renderQr(left), 40, 40);
    pasteOn(photo, renderQr(RIGHT), 1000, 40);
    pasteOn(photo, renderQr("**:紙張:1:50"), 1000, 500);
    const scan = await scanOf(photo);
    expect(scan.reason).toBe("ok");
    expect(scan.qr?.invoiceNumber).toBe("AB12345678");
    expect(scan.right).toBeNull();
    expect(scan.codes).toHaveLength(3);
  });
});

/**
 * 證明聯中段還有一條 Code39 一維條碼。它**不是**「拍到別的 QR」——
 * 把它算進 codes，只拍到條碼的照片就會從 no-qr（請手動填）變成 not-einvoice
 * （請去拍左邊那個 QR），而那張照片上根本沒有 QR 可拍。
 */
describe("同框的一維條碼不算 QR", () => {
  const barcodeText = receiptBarcodeText(SAMPLE.invoiceNumber, SAMPLE.invoiceDate, SAMPLE.randomNumber);
  const barcode = renderCode39(barcodeText);

  // 先證明這個 fixture 是**真的解得出來**的條碼——否則下面那句「沒被算進去」是空的
  it("（前提）這條 Code39 在不限格式時解得出來", async () => {
    const results = await readBarcodes({ ...barcode } as unknown as ImageData, {});
    expect(results.map((r) => ({ format: r.format, text: r.text }))).toContainEqual({
      format: "Code39",
      text: barcodeText,
    });
  });

  it("整張證明聯入鏡（左碼＋右碼＋中段條碼）：codes 只有兩個 QR", async () => {
    const { left } = buildEInvoiceQrPayloads(SAMPLE);
    const photo = blank(1600, 1200);
    pasteOn(photo, barcode, 200, 200);
    pasteOn(photo, sideBySide([renderQr(left), renderQr(RIGHT)], 16), 200, 500);
    const scan = await scanOf(photo);
    expect(scan.reason).toBe("ok");
    expect(scan.codes).toHaveLength(2);
    expect(scan.codes).not.toContain(barcodeText);
  });

  it("只拍到中段條碼、沒拍到 QR：是 no-qr（請手動填），不是 not-einvoice", async () => {
    const scan = await scanOf(pasteOn(blank(1600, 1200), barcode, 200, 200));
    expect(scan.reason).toBe("no-qr");
    expect(scan.codes).toEqual([]);
  });
});

/**
 * ── 平移普查 ──────────────────────────────────────────────────────────────
 *
 * 這一段是本輪的成敗判準，不是補充。
 *
 * 為什麼要一次量一整片、而不是挑一個座標：前三版每一版都通過了全套測試，每一版都在
 * 「換個位置就換個結果」上死掉——測試只取樣了會過的那一格，於是綠燈證明不了任何事。
 * 所以這裡用固定步距掃過底圖上放得下這個構圖的**整個範圍**，斷言的是
 * 「某個 reason 的計數 ＝ 取樣點總數」，也就是**分布與位置無關**。
 * 有任何位置不符，就把不符的座標留在失敗訊息裡（`toEqual([])` 會印出來），
 * 不從取樣裡拿掉、也不調參數把它蓋過去。
 */
const STEP = 100;

interface Census {
  /** reason → 出現在哪些座標 */
  byReason: Map<string, string[]>;
  /** 每個座標的掃描結果，供進一步斷言（例如欄位是否處處相同） */
  scans: { at: string; scan: Awaited<ReturnType<typeof scanEInvoiceQr>> }[];
  total: number;
}

/** 把 part 以固定步距貼遍 width×height 的底圖，每個位置掃一次。 */
async function sweep(width: number, height: number, part: Bitmap): Promise<Census> {
  const xs: number[] = [];
  for (let x = 0; x + part.width <= width; x += STEP) xs.push(x);
  const ys: number[] = [];
  for (let y = 0; y + part.height <= height; y += STEP) ys.push(y);
  const byReason = new Map<string, string[]>();
  const scans: Census["scans"] = [];
  for (const x of xs) {
    for (const y of ys) {
      const at = `${x},${y}`;
      const scan = await scanOf(pasteOn(blank(width, height), part, x, y));
      byReason.set(scan.reason, [...(byReason.get(scan.reason) ?? []), at]);
      scans.push({ at, scan });
    }
  }
  // 把取樣規模印出來：「普查」這兩個字要拿數字兌現，不能只是註解裡的宣稱
  console.log(
    `[普查] 底圖 ${width}x${height}、構圖 ${part.width}x${part.height}、步距 ${STEP}` +
      ` → ${xs.length} 欄 × ${ys.length} 列 = ${xs.length * ys.length} 個位置`,
  );
  return { byReason, scans, total: xs.length * ys.length };
}

/** 某個 reason 以外的所有座標（斷言失敗時會被印出來，才知道是哪些位置不合格）。 */
const others = (c: Census, reason: string) =>
  [...c.byReason].filter(([r]) => r !== reason).flatMap(([r, at]) => at.map((a) => `${a}=${r}`));

describe("平移普查：單張發票（左碼＋右碼）", () => {
  it("每一個取樣位置都 ok，且解出的欄位完全相同", async () => {
    const { left } = buildEInvoiceQrPayloads(SAMPLE);
    const receipt = sideBySide([renderQr(left), renderQr(RIGHT)], 16);
    const c = await sweep(1600, 1200, receipt);
    expect(c.total).toBeGreaterThan(50); // 取樣點夠多才叫普查
    expect(others(c, "ok")).toEqual([]);
    expect(c.byReason.get("ok")).toHaveLength(c.total);
    // 「位置無關」不只是 reason 一樣：欄位也必須逐個位置都一模一樣，
    // 否則就是同一張發票在不同位置被解成不同的號碼／金額
    const distinct = new Set(c.scans.map((s) => JSON.stringify(s.scan.qr)));
    expect([...distinct]).toEqual([JSON.stringify(SAMPLE_FIELDS)]);
    expect(new Set(c.scans.map((s) => s.scan.left))).toEqual(new Set([left]));
    expect(new Set(c.scans.map((s) => s.scan.right))).toEqual(new Set([RIGHT]));
  }, 300_000);
});

/**
 * 前兩版死在這裡：兩張完整證明聯同框（四個碼）時，53% 的位置回 ok，
 * 而那個 ok 是靜默挑了其中一張——平移 100px 就換成另一張，使用者零徵兆。
 */
describe("平移普查：兩張完整證明聯同框（四個碼）", () => {
  const first = buildEInvoiceQrPayloads(SAMPLE).left;
  const second = buildEInvoiceQrPayloads({
    ...SAMPLE,
    invoiceNumber: "CD11112222",
    salesAmount: 9000,
    totalAmount: 9999,
  }).left;
  const twoReceipts = (gap: number) =>
    sideBySide(
      [
        sideBySide([renderQr(first), renderQr(RIGHT)], 16),
        sideBySide([renderQr(second), renderQr("**:紙張:1:50")], 16),
      ],
      gap,
    );

  // 兩張單據靠得多近不影響結論：兩種間距都要處處 ambiguous
  for (const gap of [24, 120]) {
    it(`間距 ${gap}px：每一個取樣位置都 ambiguous，一個都不挑`, async () => {
      const c = await sweep(2200, 1200, twoReceipts(gap));
      expect(c.total).toBeGreaterThan(50);
      expect(others(c, "ambiguous")).toEqual([]);
      expect(c.byReason.get("ambiguous")).toHaveLength(c.total);
      // 每個位置都要看見**兩個**左碼，而且是那兩張；只看見一個就是又在挑了
      const seen = new Set(c.scans.map((s) => [...s.scan.lefts].sort().join("|")));
      expect([...seen]).toEqual([[first, second].sort().join("|")]);
      expect(c.scans.every((s) => s.scan.qr === null && s.scan.left === null && s.scan.right === null)).toBe(true);
    }, 300_000);
  }
});

describe("平移普查：只有右碼／完全沒有碼", () => {
  it("只有右碼：每一個取樣位置都 not-einvoice", async () => {
    const c = await sweep(1200, 900, renderQr(RIGHT));
    expect(c.total).toBeGreaterThan(50);
    expect(others(c, "not-einvoice")).toEqual([]);
    expect(c.byReason.get("not-einvoice")).toHaveLength(c.total);
    expect(new Set(c.scans.map((s) => s.scan.right))).toEqual(new Set([RIGHT]));
  }, 300_000);

  it("空白圖：不同尺寸都是 no-qr", async () => {
    for (const [w, h] of [[320, 240], [1600, 1200], [2200, 1200]] as const) {
      const scan = await scanOf(blank(w, h));
      expect({ w, h, reason: scan.reason }).toEqual({ w, h, reason: "no-qr" });
    }
  }, 60_000);
});

/**
 * 效能與資源：前一版在 12MP、有單據文字背景的影像上要 45 秒（同步、鎖住事件迴圈），
 * 暫時記憶體約 439MB。換解碼器的驗收要拿同一種輸入量。
 * 這個 it 不設效能門檻當斷言（CI 機器快慢不一，卡在門檻上只會變成調數字），
 * 只斷言「這種輸入解得出來」，數字印出來給人看。
 */
it("12MP、有單據文字背景：解得出兩個碼，並印出耗時與記憶體", async () => {
  const { left } = buildEInvoiceQrPayloads(SAMPLE);
  const [W, H] = [4032, 3024]; // 手機 12MP
  const photo = blank(W, H);
  // 模擬單據上密密麻麻的文字：偽隨機小黑塊。用固定 seed，才不會每次跑量到不同的圖。
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 40_000; i++) {
    fillRect(photo, Math.floor(rnd() * (W - 12)), Math.floor(rnd() * (H - 12)), 2 + Math.floor(rnd() * 8), 2 + Math.floor(rnd() * 6), 0);
  }
  const receipt = sideBySide([renderQr(left), renderQr(RIGHT)], 16);
  pasteOn(photo, blank(receipt.width + 40, receipt.height + 40), 800, 1500); // 證明聯本身是白底
  pasteOn(photo, receipt, 820, 1520);

  const before = process.memoryUsage();
  const t0 = performance.now();
  const scan = await scanOf(photo);
  const ms = performance.now() - t0;
  const after = process.memoryUsage();
  console.log(
    `[12MP ${W}x${H}] ${Math.round(ms)}ms  rss+${Math.round((after.rss - before.rss) / 1e6)}MB` +
      `  external+${Math.round((after.external - before.external) / 1e6)}MB`,
  );
  expect(scan.reason).toBe("ok");
  expect(scan.qr).toEqual(SAMPLE_FIELDS);
  expect(scan.right).toBe(RIGHT);
}, 300_000);

/**
 * 銷售額欄位（未稅）：報銷送單**不送這個數字**（只送左碼原文，由伺服端自己解析），
 * 但它仍是左碼的固定欄位之一，而列印那條路要反向用同一套欄位配置。
 */
describe("parseEInvoiceQr 的銷售額欄位", () => {
  it("原樣解出銷售額（未稅），與總計額各自獨立", () => {
    const { left } = buildEInvoiceQrPayloads({ ...SAMPLE, salesAmount: 1234, totalAmount: 1300 });
    const qr = parseEInvoiceQr(left);
    expect(qr?.salesAmount).toBe(1234);
    expect(qr?.totalAmount).toBe(1300);
  });

  // 憑證自己說「銷售額＝總計額」的情形（兩個欄位相減＝0）。解析端不對此做任何判斷，
  // 原樣搬出來就是全部的工作——那兩個欄位代表什麼、要不要照它算，是使用者的判斷。
  it("銷售額等於總計額時照樣原樣解出（不解讀、不改寫）", () => {
    const { left } = buildEInvoiceQrPayloads({ ...SAMPLE, salesAmount: 900, totalAmount: 900 });
    const qr = parseEInvoiceQr(left);
    expect(qr?.salesAmount).toBe(900);
    expect(qr?.totalAmount).toBe(900);
  });

  it("掃描結果帶得出左碼原文（送單要送的就是它，不是解析後的數字）", async () => {
    const { left } = buildEInvoiceQrPayloads({ ...SAMPLE, salesAmount: 4321, totalAmount: 4567 });
    const scan = await scanOf(renderQr(left));
    expect(scan.reason).toBe("ok");
    expect(scan.left).toBe(left);
    expect(scan.qr?.salesAmount).toBe(4321);
  });
});

/**
 * 收尾：整份測試跑完，解碼器實際對外發過哪些請求。
 * 放在檔案最後（vitest 依宣告順序跑），此時 wasm 早已載入過。
 * 期望是「只有自家那一個資產路徑，一次」——不是零，零代表這個假替身根本沒被走到，
 * 那樣的話上面那句「不走 CDN」就沒有任何東西在保。
 */
it("整份測試跑下來，解碼器只取過自家那一個 wasm 資產", () => {
  expect(FETCHED).toEqual([zxingWasmUrl]);
});
