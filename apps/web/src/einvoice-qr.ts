import { parseEInvoiceLeftQr, type EInvoiceLeftQr } from "@tw-erp/einvoice";
import { t } from "./i18n.ts";
import { prepareZXingModule, readBarcodes, type ReaderOptions } from "zxing-wasm/reader";
// vite 會把這個 .wasm 當成資產打包、emit 到自家 origin（dist/assets/…），import 拿到的是那個路徑。
// 這一行是「不走 CDN」的關鍵：見下面 prepareZXingModule 的說明。
import zxingWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

/**
 * 左碼（台灣電子發票證明聯左側 QR）的**欄位配置與解析只有一份定義**，
 * 在 packages/einvoice/src/qr.ts；這個檔案裡的是薄轉接，沿用 apps/web 既有的名稱而已。
 *
 * 為什麼解析放在 packages/einvoice 而不是這裡：報銷送單只送左碼原文（qrPayload），
 * 金額與稅額一律由**伺服端自己解析後認定**——前端若能決定銷售額，任何人都能把任意金額
 * 宣稱成進項稅（總額 10000、銷售額 0 → 稅額 10000 進 401）。伺服端要做到「不相信前端的數字」，
 * 就得有一支自己跑得動、不依賴 DOM 的解析；而前後端各留一份實作必然漂移
 * （同一張左碼在兩邊解出不同結果，畫面與帳上就對不起來，且沒有任何測試會紅）。
 * 所以定義留在 packages/einvoice 一份，瀏覽器這一側 import 同一支。
 *
 * ⚠️ 「可機讀」不等於「已驗真」：24 碼加密驗證區本系統從未驗證
 * （見 buildEInvoiceQrPayloads 的說明，我方自印的那一段還是 24 個 0）。
 * ⚠️ salesAmount 是**憑證所載的結構化值**，不是系統算出來的；報銷送單不送這個數字。
 */
export type EInvoiceQr = EInvoiceLeftQr;

/** 見上：實作在 packages/einvoice，這裡只保留 apps/web 原本的匯出名稱。 */
export const parseEInvoiceQr: (text: string) => EInvoiceQr | null = parseEInvoiceLeftQr;

/**
 * B2C 證明聯左右二維條碼的內容（B5）：把左碼的欄位配置（packages/einvoice/src/qr.ts）**反向使用**。
 * 前 77 碼固定欄位之後接「:營業人自行使用區(10):完整品目筆數:本碼品目筆數:編碼參數(1=UTF-8)」
 * 再接每項「品名:數量:單價」；右側 QR 以「**」開頭接續放不下的明細。
 *
 * ★ 加密驗證區（24 碼）以 24 個 0 佔位：那一段須以財政部大平台核發的 QRCode 專用金鑰
 *   將「發票號碼＋隨機碼」做 AES 加密產生，本系統尚未申請金鑰（見 STATE 的行政事項）。
 *   佔位不影響掃描其餘欄位（號碼、日期、金額、統編都是明碼），但**驗證區在正式接上
 *   Turnkey 金鑰前不具驗真效力**——列印畫面上有對操作者的提示。
 */
export function buildEInvoiceQrPayloads(input: {
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  randomNumber: string; // 4 碼
  salesAmount: number; // 未稅銷售額（整數元）
  totalAmount: number; // 含稅總計（整數元）
  buyerTaxId: string | null; // B2C 未打統編＝null → 00000000
  sellerTaxId: string;
  items: { name: string; qty: number; unitPrice: number }[];
}): { left: string; right: string } {
  const [y, m, d] = input.invoiceDate.split("-");
  const rocDate = `${String(Number(y) - 1911).padStart(3, "0")}${m}${d}`;
  const hex8 = (n: number) => Math.max(0, Math.round(n)).toString(16).toUpperCase().padStart(8, "0");
  const encrypt = "0".repeat(24); // 佔位：見檔頭說明
  // 明細塞在左碼、右碼只放接續：QR 版本自動長大，逐字元分頁對掃描端沒有差別
  const itemText = input.items.map((i) => `${i.name.replaceAll(":", "：")}:${i.qty}:${i.unitPrice}`).join(":");
  const left =
    `${input.invoiceNumber}${rocDate}${input.randomNumber}` +
    `${hex8(input.salesAmount)}${hex8(input.totalAmount)}` +
    `${input.buyerTaxId ?? "00000000"}${input.sellerTaxId}${encrypt}` +
    `:${"*".repeat(10)}:${input.items.length}:${input.items.length}:1` +
    (itemText ? `:${itemText}` : "");
  return { left, right: "**" };
}

/**
 * 證明聯中段一維條碼（Code39）的內容：民國年＋期別迄月(5)＋發票號碼(10)＋隨機碼(4)。
 * 期別雙月一期、迄月＝起始奇數月＋1（例：2026-07-21 → 11508）。
 */
export function receiptBarcodeText(invoiceNumber: string, invoiceDate: string, randomNumber: string): string {
  const [y, m] = invoiceDate.split("-");
  const month = Number(m);
  const endMonth = month - ((month - 1) % 2) + 1;
  return `${Number(y) - 1911}${String(endMonth).padStart(2, "0")}${invoiceNumber}${randomNumber}`;
}


/** 右碼的判準：規格規定右碼固定以 ** 起頭，左碼的 ** 在第 78 碼之後（自行使用區）不會在開頭。 */
function isRightPayload(text: string): boolean {
  return text.startsWith("**");
}

/**
 * 一張證明聯影像的掃描結果。
 *
 * 之所以不只回一個 `EInvoiceQr | null`：呼叫端必須講得出幾種不同的失敗，
 * 因為它們的出路完全不同——
 * - 只入鏡右碼／拍到別的 QR：請使用者把左邊那個碼一起拍進去；
 * - 一次拍到兩張發票：請使用者一張一張拍；
 * - 什麼碼都沒掃到：請使用者手動填。
 * 混為一談的話，一張有效的電子發票會被歸成收據、進項稅就此漏掉
 * （伺服端對 receipt 是硬規則不可扣抵）。
 */
export interface EInvoiceQrScan {
  /** 左碼解析出的固定欄位；沒解出唯一一個左碼時為 null（絕不猜） */
  qr: EInvoiceQr | null;
  /** 左碼原始字串（唯一一個左碼時才有值） */
  left: string | null;
  /**
   * 右碼原始字串（** 起頭的明細接續）。這裡只原樣帶出不解碼：
   * 明細段的編碼參數有 0=Big5／1=UTF-8／2=Base64 三種，規格尚未核對，
   * 解錯會產生看似正確的假品名——留給之後核對過規格的人接。
   *
   * ★ 只在「至多一個左碼＋恰好一個右碼」時才帶出來。右碼身上沒有發票號碼
   *   （它就是 ** 之後接明細），一次拍到兩張發票時無從分辨它是誰的續頁，
   *   配錯的話明細會掛到另一張發票上而畫面看不出來——那時寧可不帶。
   */
  right: string | null;
  /** 掃到的**所有**左碼原文（去重）。兩個以上＝一次拍到兩張發票，見 reason 的 ambiguous */
  lefts: string[];
  /**
   * 掃到的所有 **QR** 原始字串（去重，含左右碼與不相干的碼），供除錯與後續解析。
   * 只有 QR：證明聯中段那條 Code39 不收進來（見 READER_OPTIONS）。
   */
  codes: string[];
  /**
   * ok＝解出**唯一一個**左碼；
   * ambiguous＝解出兩個以上的左碼（一次拍到兩張發票）——不挑一個，因為挑錯就是把
   *   另一張發票的號碼與金額安到這筆明細上，而使用者看不出來；
   * not-einvoice＝掃到 QR 但裡面沒有左碼（只入鏡右碼、或那是別的 QR）；
   * no-qr＝整張影像裡沒有解得出來的 QR。
   */
  reason: "ok" | "ambiguous" | "not-einvoice" | "no-qr";
}

/**
 * 解碼器：**zxing-wasm**（ZXing-C++ 編成 WebAssembly；npm 套件 zxing-wasm 3.x）。
 *
 * 授權：wrapper `zxing-wasm` 是 **MIT**；被編進去的 `zxing-cpp` 是 **Apache-2.0**。
 * 兩者都與本專案的 LGPL-3.0-or-later 相容（MIT 與 Apache-2.0 都可單向併入 GPLv3／LGPLv3 之下；
 * 反向不成立，所以不要把本專案的程式碼複製到 Apache-2.0 專案裡）。
 * Apache-2.0 §4(a) 要求散布時附上授權副本，而建置產物
 * `dist/assets/zxing_reader-*.wasm` 就是那份程式碼的散布形式——授權副本放在 repo 根目錄的
 * `THIRD-PARTY-NOTICES.md` 與 `licenses/`，**部署時要跟 dist 一起帶上**。
 * （寫「照辦即可」而不實際放檔案，等於沒辦。）
 *
 * 為什麼換掉 jsQR（這是整個換裝**唯一**的理由）：
 * jsQR 的 `locate()` 只拿分數最好的那一組定位圖去解，**一次只回一個碼**，
 * 沒有多碼 API。於是「畫面上有幾張發票」這件事在 jsQR 上是量不出來的——
 * 前兩版用裁切＋塗白重掃去湊涵蓋率，實測的結果是：兩張證明聯同框時，
 * 32 個平移位置裡有 53% 回 ok，而那個 ok 是**靜默挑了其中一張**；平移 100px
 * 就換成另一張，使用者零徵兆。這不是參數沒調好，是「一次只回一個碼」的必然結果。
 * ZXing-C++ 的 `ReadBarcodes` 會把影像裡**所有**符合的碼一次回來
 * （`maxNumberOfSymbols` 預設 255），歧義因此變成可觀測、可回報的事實。
 *
 * 為什麼不選這幾個：
 * - `@zxing/library`（純 JS 移植，Apache-2.0）：多碼是 `GenericMultipleBarcodeReader`，
 *   作法就是「解到一個→切四象限遞迴」，跟前兩版的裁切是同一招、同一組毛病。
 * - `rxing-wasm`（Rust 移植，Apache-2.0）：同樣是移植版的多碼語意，且體積與維護量沒有優勢。
 * - `barcode-detector`：底下包的就是 zxing-wasm，多一層轉接沒有換到東西。
 *
 * ★ **不向外部網路取任何資產**：zxing-wasm 的預設 `locateFile` 指向
 *   `https://fastly.jsdelivr.net/npm/zxing-wasm@…`（見 dist/es/share.js）。
 *   自架、可能裝在內網的 ERP 不能這樣跑，所以這裡**在模組載入時就把它覆寫掉**，
 *   指到 vite 打包出來的自家資產（檔頭那個 `?url` import）。
 *   覆寫必須發生在第一次 `readBarcodes()` 之前——放在模組頂層就是為了這個；
 *   `fireImmediately` 不設（預設 false），所以只是登記覆寫，不會在 import 時就去抓 wasm。
 *   匯出這個物件是為了讓測試驗得到「指向自家資產」這件事（見 test/einvoice-qr.test.ts）。
 */
export const ZXING_MODULE_OVERRIDES = {
  // 兩個參數（檔名、預設前綴）刻意收下卻不用：不管 zxing 想從哪裡拿，一律回自家那一個資產
  locateFile: (_fileName: string, _prefix: string): string => zxingWasmUrl,
};
prepareZXingModule({ overrides: ZXING_MODULE_OVERRIDES });

/**
 * 只找 QR（不找一維條碼）。證明聯中段有一條 Code39，它不是「拍到別的 QR」；
 * 把它也收進 codes 會讓「只拍到條碼、沒拍到 QR」的照片從 no-qr 變成 not-einvoice，
 * 而這兩句話要使用者做的事完全不同。其餘選項用套件預設
 * （tryHarder／tryRotate／tryInvert／tryDownscale 都是 true，maxNumberOfSymbols 255）。
 */
const READER_OPTIONS: ReaderOptions = { formats: ["QRCode"] };

/**
 * 從 RGBA 像素找出證明聯的 QR。
 * 這一段刻意跟 DOM 脫鉤（不碰 canvas／File），才測得起來——測試自己組 pixel array 餵進來。
 *
 * 策略就是一句話：**解一次，然後分類**。沒有裁切、沒有滑窗、沒有塗白重掃、沒有掃描預算——
 * 那些東西存在的唯一理由是 jsQR 一次只回一個碼，換了解碼器之後它們全是負債
 * （它們讓結果隨碼在畫面上的位置飄，而測試只要取樣到會過的那一格就會綠）。
 *
 * ★ 非同步：wasm 模組是 `WebAssembly.instantiate` 出來的，第一次呼叫要等它下載＋編好
 *   （dist 那個資產 1.07MB、gzip 後 457KB，同源、只付一次）。編好之後真正的解碼是
 *   **同步**進到 wasm 裡跑的，那一段仍佔住主執行緒——只是它現在很短：
 *   12MP、有單據文字背景的影像實測 40〜60ms（前一版同樣條件是 45 秒）。
 *   要連這 40〜60ms 都不佔主執行緒的話得搬進 worker，這一版沒做。
 */
export async function scanEInvoiceQr(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<EInvoiceQrScan> {
  // readBarcodes 的型別標的是 DOM 的 ImageData，但它只讀 data/width/height 三個欄位；
  // 測試環境沒有 ImageData 建構子（也不該為了測試裝 canvas），所以結構相符即可。
  const image = { data, width, height } as unknown as ImageData;
  const results = await readBarcodes(image, READER_OPTIONS);
  const codes: string[] = [];
  for (const r of results) {
    // 同一個碼在影像裡出現兩次（例如影印重疊）不算兩張發票，所以照原文去重。
    // 文字用 ZXing 解出來的 text：左碼前 77 個固定欄位全是 ASCII，任何字集猜法都一樣；
    // 後面明細段的字集是憑證自己說了算，這裡不改寫、原樣帶出（見 EInvoiceQrScan.right）。
    if (r.text && !codes.includes(r.text)) codes.push(r.text);
  }
  return summarize(codes);
}

function summarize(codes: string[]): EInvoiceQrScan {
  const lefts = codes.filter((c) => parseEInvoiceQr(c) !== null);
  const rights = codes.filter((c) => !lefts.includes(c) && isRightPayload(c));
  const left = lefts.length === 1 ? lefts[0]! : null;
  // 左碼多於一個（兩張發票同框）或右碼多於一個時，right 分不出是誰的續頁——寧可不帶
  const right = lefts.length <= 1 && rights.length === 1 ? rights[0]! : null;
  return {
    qr: left ? parseEInvoiceQr(left) : null,
    left,
    right,
    lefts,
    codes,
    // 這四種分不出來的話：只拍到右碼的有效發票會被當成收據（進項稅永遠扣不到），
    // 兩張發票同框會靜默挑一張（使用者拿到別張發票的號碼與金額）
    reason: lefts.length > 1 ? "ambiguous" : lefts.length === 1 ? "ok" : codes.length ? "not-einvoice" : "no-qr",
  };
}

/**
 * 讀取影像檔：縮圖成 base64（DB 儲存用）＋掃出證明聯的 QR。
 * `qr` 是左碼欄位（沿用原本的回傳形狀，呼叫端不必馬上改）；
 * 幾種失敗的差別（只拍到右碼／一次兩張發票／什麼都沒掃到）看 `scan.reason`，
 * 要送給伺服端的左碼原文看 `scan.left`。
 */
export async function readReceiptImage(
  file: File,
): Promise<{ image: string; qr: EInvoiceQr | null; scan: EInvoiceQrScan }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t("讀取影像失敗")));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(t("影像格式不支援")));
    el.src = dataUrl;
  });

  /**
   * QR 解碼用原尺寸（縮圖會糊掉小 QR）；儲存用縮圖（最長邊 1200px、JPEG 0.8）。
   * 12MP 的照片解一次實測 40〜60ms（測試裡量的，見 test/einvoice-qr.test.ts），
   * 不必再為了延遲先降解析度——降解析度換來的是小 QR 糊掉、掃不到。
   * 這一步真正的大宗反而是 getImageData 本身（12MP＝48MB 的 RGBA 緩衝區）。
   */
  const decodeCanvas = document.createElement("canvas");
  decodeCanvas.width = img.naturalWidth;
  decodeCanvas.height = img.naturalHeight;
  const dctx = decodeCanvas.getContext("2d")!;
  dctx.drawImage(img, 0, 0);
  const imageData = dctx.getImageData(0, 0, decodeCanvas.width, decodeCanvas.height);
  const scan = await scanEInvoiceQr(imageData.data, imageData.width, imageData.height);

  const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = Math.round(img.naturalWidth * scale);
  thumbCanvas.height = Math.round(img.naturalHeight * scale);
  thumbCanvas.getContext("2d")!.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);
  return { image: thumbCanvas.toDataURL("image/jpeg", 0.8), qr: scan.qr, scan };
}
