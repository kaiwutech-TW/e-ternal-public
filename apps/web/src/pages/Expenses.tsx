import { canAccessPage } from "@tw-erp/core";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { CategorySuggestions } from "../CategorySuggestions.tsx";
import { useAuth } from "../auth.ts";
import { readReceiptImage, type EInvoiceQr, type EInvoiceQrScan } from "../einvoice-qr.ts";
import { fmt, useFetch, useListFetch } from "../hooks.ts";
import type { Account, ClaimPayableSummary, Employee, ExpenseCategory, ExpenseClaimRow, ExpenseItemRow } from "../types.ts";
import { EmptyState, ListFilterBar, useNav, TaxNotes, pickTaxNotes } from "../ui.tsx";

export interface DraftItem {
  image?: string;
  docType: "einvoice" | "receipt" | "other";
  accountCode: string;
  description: string;
  amount: number;
  // 換照片／清除辨識結果時這幾欄要能被清成「沒有」，所以型別收得下 undefined
  //（tsconfig 開了 exactOptionalPropertyTypes，`?: string` 是收不下 undefined 的）
  invoiceNumber?: string | undefined;
  invoiceDate?: string | undefined;
  sellerTaxId?: string | undefined;
  /**
   * 掃到的電子發票 QR **左碼原文**。原樣送給伺服端，由那邊自己解析銷售額。
   *
   * ★ 前一版送的是解析後的 salesAmount 這個數字——那等於任何人都能把任意金額宣稱成
   *   進項稅（總額 10000、銷售額 0 → 稅額 10000 進 401）。稅額的信任邊界在伺服端，
   *   前端能給的只有「掃到的那串原文」與「兩個來源不一致時你選哪一個」。
   */
  qrPayload?: string | null | undefined;
  /**
   * 兩個稅額來源不一致、使用者點選過之後才有值；沒點選就是沒有（不預選）。
   *
   * ★ **null 與 undefined 是兩件不同的事**，型別收得下 null 就是為了這個：
   *   `JSON.stringify` 會把值是 undefined 的欄位**整個丟掉**，伺服端收到的請求裡根本沒有這個鍵，
   *   於是讀成「前端沒送這個欄位」而**沿用它自己存著的上一次選擇**
   *   （見 api/src/services/expenses.ts 的 carried 段：undefined＝沿用、null＝使用者清掉、重新問一次）。
   *   所以畫面上任何「清掉／換了憑證／改了金額」的動作都必須送 **null**——
   *   送 undefined 的話按鈕按了等於沒按，而畫面上完全看不出來（qrPayload 同理）。
   */
  taxSource?: "voucher" | "rate" | null | undefined;
  deductible: boolean;
  qrNote: string | null;
  /** qrNote 是「這張照片有問題、要你做點什麼」而不是「辨識成功」——決定它用警示色還是提示色 */
  qrIssue: boolean;
}

/** 伺服端擋下「稅額兩個來源不一致」時，攤開來讓使用者點選的兩個數字。 */
interface TaxSourceConflict {
  invoiceNumber: string;
  voucherTax: number;
  rateTax: number;
}

/**
 * 從 422 的訊息裡把兩個稅額拆出來。訊息的字面形狀由 api/src/services/expenses.ts 的
 * prepareItems 產生（那邊改字要一起改這裡）——之所以解析訊息而不是讀結構化欄位，
 * 是因為錯誤回應目前只有 {error: string} 這一個通道（這一輪重新確認過伺服端：
 * AppError 仍只帶一個字串，沒有結構化欄位可讀，所以耦合保留，不為了它改全域錯誤處理）。
 * 拆不出來也不會少講什麼：訊息本身已經把兩個數字與各自的來源寫在裡面，照樣顯示在錯誤列。
 */
function parseTaxSourceConflict(message: string): TaxSourceConflict | null {
  const m = /發票 ([A-Z]{2}\d{8}) 的進項稅額有兩個來源[^]*?憑證所載的銷售額回推＝(\d+) 元[^]*?你設定的稅率回推＝(\d+) 元/.exec(message);
  return m ? { invoiceNumber: m[1]!, voucherTax: Number(m[2]), rateTax: Number(m[3]) } : null;
}

/**
 * 掃描沒成功時要對使用者說什麼。
 *
 * 這支刻意獨立匯出：把 reason 分細（einvoice-qr.ts）唯一的用處就是讓訊息說得出**下一步該做什麼**，
 * 而它有沒有真的接到畫面上，是測得起來的事——上一版 reason 分好了卻沒有任何消費者，
 * 使用者看到的訊息與改動前一字不差。
 *
 * 措辭跟著解碼器的**現況**走：現在是「整張影像解一次、把找到的所有 QR 都回來」
 * （見 einvoice-qr.ts 的 scanEInvoiceQr），不再是舊版那種只看固定幾塊區域的裁切掃描。
 * 所以這裡不可以再寫「只掃了某幾塊區域」——那會變成螢幕上的一句假話，
 * 而且會把人指去做一件沒有用的事（挪動構圖讓 QR 落進某一塊）。
 *
 * ★ 零斷言：這些句子只講**系統做了什麼／沒做到什麼、下一步你可以做什麼**。
 *   不講「收據沒有進項稅可扣」這一類的話——那是在替使用者判斷稅法，而系統並不知道；
 *   可扣抵性由伺服端依使用者的稅法參數與憑證判定（見 api/src/services/expenses.ts）。
 */
export function scanAdvice(scan: Pick<EInvoiceQrScan, "reason" | "lefts">): string {
  switch (scan.reason) {
    case "ambiguous":
      return (
        `照片已存，但這張照片裡有不只一張發票（掃到 ${scan.lefts.length} 個電子發票 QR 左碼）——請一張一張拍，一張照片只放一張發票。` +
        `系統不替你挑一張：挑錯就是把另一張發票的號碼與金額安到這筆明細上，而畫面上看不出來。` +
        `這一筆的發票欄位先留空，重拍上傳後會重新辨識。`
      );
    case "not-einvoice":
      return (
        "照片已存，但掃到的 QR 裡沒有電子發票證明聯的左碼——發票號碼、日期、金額都在「左邊」那個 QR 裡，" +
        "這張可能只拍到右邊那個（右碼放的是品項明細的接續），也可能掃到的是別的 QR。" +
        "請把左邊那個 QR 一起拍進去、拍大一點正一點，再上傳一次。" +
        "這張本來就不是電子發票的話，直接手動填金額即可：這筆的發票欄位留空、先不勾可扣抵，" +
        "可扣抵性由伺服端依你的稅法參數與憑證判定。"
      );
    case "no-qr":
      return (
        "照片已存，但整張影像解過一次之後沒有解出任何 QR——請手動填金額：這筆的發票欄位留空、先不勾可扣抵，" +
        "可扣抵性由伺服端依你的稅法參數與憑證判定。" +
        "解不出來多半是 QR 太小、太糊或反光（辨識讀的是整張影像，不是只看某幾塊）：" +
        "這張如果是電子發票，把左邊那個 QR 拍大一點、正一點再試一次。"
      );
    case "ok":
      // 走不到（reason 是 ok 就代表左碼欄位解出來了）；真的走到就是系統內部不一致，照實說
      return "掃到電子發票 QR，但欄位沒解出來——請手動填金額，並把這張照片回報給維護者。";
  }
}

/**
 * 掃到唯一一個左碼（reason === "ok"）時，這一筆明細要變成什麼樣子。
 *
 * 抽成純函式是為了測得到兩件事，而這兩件事在畫面上都看不出來：
 * (1) 換了一張憑證時 taxSource 送的是 **null**（清掉、重新問一次）而不是 undefined（沿用）；
 * (2) 提示只講系統做了什麼——不替使用者斷言稅法。
 *
 * deductible 這裡只是**前端的主張**：伺服端會自己解析 qrPayload、自己比對買方統編，
 * 主張與它看到的不一致時以它為準（見 api/src/services/expenses.ts 的 prepareItems）。
 */
export function scannedItemPatch(qr: EInvoiceQr, left: string, companyTaxId: string | null): Partial<DraftItem> {
  const buyerOk = !!companyTaxId && qr.buyerTaxId === companyTaxId;
  return {
    docType: "einvoice",
    amount: qr.totalAmount,
    // 送左碼**原文**、不送解析後的銷售額：那個數字由伺服端自己從原文導出（見 DraftItem.qrPayload）
    qrPayload: left,
    // 換了一張憑證，上一張選的稅額來源就不算數了——送 null（清掉），不是 undefined（沿用）
    taxSource: null,
    invoiceNumber: qr.invoiceNumber,
    invoiceDate: qr.invoiceDate,
    sellerTaxId: qr.sellerTaxId,
    deductible: buyerOk,
    qrIssue: false,
    qrNote:
      `已辨識：發票 ${qr.invoiceNumber}（${qr.invoiceDate}）$${fmt(qr.totalAmount)}。` +
      (buyerOk
        ? "QR 上的買方統編與公司基本檔相同，這筆先勾可扣抵。"
        : companyTaxId === null
          ? "公司基本檔還沒填統編，這裡沒有東西可以比對，這筆先不勾可扣抵。"
          : qr.buyerTaxId
            ? `QR 上的買方統編是 ${qr.buyerTaxId}、公司基本檔是 ${companyTaxId}，兩者不同，這筆先不勾可扣抵。`
            : "QR 上沒有買方統編，這筆先不勾可扣抵。") +
      "送出後由伺服端自己解析這張 QR 的原文、自己比對買方統編，並依你在「稅法參數」頁設定的值決定落地的稅額。",
  };
}

/**
 * 換了一張照片而這次沒辨識成功：上一張辨識出來的東西一律不算數。
 * 少了這一步，畫面會留著前一張的發票號碼與金額，而使用者以為那是這張照片上的——
 * 送出去就是張冠李戴（伺服端的交叉核對也擋不到，它比對的是 QR 原文與欄位，兩者都還是上一張的）。
 *
 * 金額只在「原本是掃出來的」時候才清（hadQr）：使用者自己打的數字不能因為換張照片就沒了。
 *
 * ★ qrPayload／taxSource 送 **null** 而不是 undefined：undefined 會被 JSON.stringify 丟掉，
 *   伺服端就沿用它自己存著的那一份，於是畫面上明明換了照片、帳上仍是上一張憑證的數字。
 */
export function clearedByNewImage(hadQr: boolean): Partial<DraftItem> {
  return {
    docType: "receipt",
    ...(hadQr ? { amount: 0 } : {}),
    invoiceNumber: undefined,
    invoiceDate: undefined,
    sellerTaxId: undefined,
    qrPayload: null,
    taxSource: null,
    deductible: false,
  };
}

/**
 * 「取消指定稅額來源」與「改了金額，所以上一次的指定是對著另一個數字做的」共用的那一個清除動作。
 *
 * 這支存在的唯一理由就是**不讓「清掉」在兩個地方各寫一次**——其中一個寫成 `undefined` 的話，
 * 那條路會靜靜地沿用上一次的選擇（伺服端讀不到欄位＝沿用），而畫面上「已取消指定」照樣顯示。
 */
export function clearedTaxSource(): Pick<DraftItem, "taxSource"> {
  return { taxSource: null };
}

/**
 * 「清除這張憑證的辨識結果」：伺服端四欄交叉核對擋下 422 之後的那條出路。
 *
 * 沒有這個動作時，使用者手上只剩兩招：重新上傳一張沒有 QR 的照片，或把金額改成 0 讓那筆被過濾掉。
 */
export function clearedQrResultPatch(): Partial<DraftItem> {
  return {
    // 明確送 null＝「使用者把它清掉了」。送 undefined 的話 JSON.stringify 會把欄位整個丟掉，
    // 伺服端讀成「前端沒送」而沿用它自己存著的 QR 原文（退回重送那條路會依發票號碼帶回來），
    // 於是交叉核對照樣拿舊原文去比對——按鈕按了等於沒按。
    qrPayload: null,
    taxSource: null,
    // 辨識結果被清掉之後，系統手上就沒有可據以導出稅額的憑證原文了，因此不再替這筆主張可扣抵。
    // 這是系統對自己有什麼的陳述，不是對這張單據可不可扣抵的判斷——後者是伺服端依你的稅法參數與憑證認定的。
    deductible: false,
    qrIssue: true,
    qrNote:
      "已清除這張憑證的辨識結果：發票欄位與金額改以你填的為準，伺服端不會再拿那張 QR 的原文跟你填的內容交叉核對，" +
      "這筆也不再主張可扣抵。要恢復辨識請重新上傳這張憑證的照片。",
  };
}

/**
 * 表單上的明細 → 真正送出去的明細（建單 POST 與退回重送 PATCH 共用同一支）。
 *
 * 抽成純函式是為了測得到**送出去的形狀**：taxSource／qrPayload 各有 undefined 與 null 兩種「沒有值」，
 * 而 `JSON.stringify` 只留得住 null——undefined 的欄位整個消失，伺服端讀成「前端沒送這個欄位」
 * 而沿用上一次的值。這件事在畫面上一點跡象都沒有，只有把 payload 真的 stringify 一次才看得見。
 *
 * 過濾條件（要有分類、金額大於 0）也放在這裡：畫面說的「有效明細」與實際送出去的那一批必須是同一批，
 * 分兩個地方各算一次的話，兩者遲早會不一樣。
 */
export function claimItemsPayload(items: DraftItem[]) {
  return items
    .filter((l) => l.accountCode && l.amount > 0)
    .map((l) => ({
      accountCode: l.accountCode,
      description: l.description || undefined,
      docType: l.docType,
      amount: l.amount,
      deductible: l.deductible,
      // 送原文，不送銷售額：伺服端自己解析（B4 的信任邊界，見 DraftItem.qrPayload）
      qrPayload: l.qrPayload,
      taxSource: l.taxSource,
      invoiceNumber: l.invoiceNumber,
      invoiceDate: l.invoiceDate,
      sellerTaxId: l.sellerTaxId,
      image: l.image,
    }));
}

/**
 * GET /expense-claims/:id 的明細會多帶 qrPayload／taxSource（伺服端那支是 select() 全欄）。
 * types.ts 的 ExpenseItemRow 還沒補這兩欄，而那個檔這一輪在別人手上——就地擴充，不去動它。
 */
type ExpenseItemDetail = ExpenseItemRow & { qrPayload?: string | null; taxSource?: string | null };
/**
 * GET /expense-claims/:id 另外回一份 taxNotes：伺服端**從已落地的欄位重建**的稅額說明
 * （見 api/src/services/expenses.ts 的 rebuildTaxNotes）。建單時說過的那幾句只回給送單的人，
 * 而按下核准的才是讓這些進項稅進 401 的那一個人——他手上原本只有一個數字。
 */
type ExpenseClaimDetail = Omit<ExpenseClaimRow, "items"> & { items: ExpenseItemDetail[]; taxNotes?: string[] };

/**
 * 伺服端四欄交叉核對（發票號碼／日期／賣方統編／總計額）擋下來的那個 422。
 * 這一句的字面同樣由 api/src/services/expenses.ts 的 prepareItems 產生，改字要一起改這裡——
 * 認不出來也不會少講什麼（訊息本身照樣顯示在錯誤列），只是少了「清除辨識結果」那個指路。
 */
const QR_MISMATCH_RE = /掃到的發票 QR 與這筆填的內容對不起來/;

const TAX_SOURCE_LABEL: Record<"voucher" | "rate", string> = {
  voucher: "憑證所載的銷售額回推",
  rate: "你設定的稅率回推",
};

/**
 * 分類清單要帶哪一天去問。
 *
 * 為什麼一定要帶：可扣抵性是有生效期間的（tax_parameters 可被覆寫、也可被改期間），
 * 而伺服端建單時是以**報銷單日期**解析（見 api/src/services/expenses.ts 的 prepareItems）。
 * 畫面若不帶日期，端點會以「今天」解析——補登舊單、參數又在中間變動過時，
 * 使用者看到的提示與實際落地的稅額就會是兩個答案（同一個事實兩套判斷，寬鬆的那套在入口）。
 *
 * date 不合法時回 null＝**不發請求**（useFetch 的 path 傳 null 就是這個意思），
 * 呼叫端另外把「上一個有效日期」留著。日期輸入框在使用者打字途中會短暫是空字串或半截，
 * 那時候送出去只會換來 400 把分類下拉清空。
 *
 * ★ 不合法時**不可以**退回不帶參數的 "/expense-categories"：端點沒收到 onDate 就以「今天」解析，
 *   於是「補登舊單時畫面提示與落地稅額不一致」這個漂移只是換成靜默發生——
 *   使用者打字打到一半，下拉就悄悄換成今天的判定，而他不會知道。
 */
export function expenseCategoriesPath(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `/expense-categories?onDate=${date}` : null;
}

/** 上面那條規則的單一定義（畫面要用它決定「這個日期能不能拿去問分類」）。 */
export const isClaimDate = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date);

const EMPTY_ITEM: DraftItem = { docType: "receipt", accountCode: "", description: "", amount: 0, deductible: false, qrNote: null, qrIssue: false };

/* ───────────────────────── 批次上傳（一次選多張） ───────────────────────── */

/**
 * 一張縮圖的 base64 會有多大——**實測值，不是從 byte/px 推的估計**。
 *
 * 前一版寫的是「1.44 Mpx × 0.2 byte/px × 4/3 ≈ 400 KB」。那條推導的每一步都合理，
 * 結果卻低估了 20〜90%：0.2 byte/px 是風景照的量級，單據照片全是高對比文字邊緣，
 * 手機翻拍還帶著感光雜訊（JPEG 對雜訊幾乎壓不動）。低估的代價不是「數字不好看」——
 * 它讓選檔當下的張數上限高估容量，使用者選了 20 張、畫面說「已帶入 20 張」，
 * 實際上只有十來張的資料量進得去。
 *
 * 量測方法（兩份獨立的量測，同一個量級）：
 *   1. 複核者在瀏覽器上量：1200×1200 的單據影像走 readReceiptImage 的規格
 *      （最長邊 1200px、`toDataURL("image/jpeg", 0.8)`），取回的 data URL 字串長度——
 *      乾淨的（掃描件、無雜訊）485 KB；帶手機感光雜訊的翻拍 758 KB。
 *   2. 本輪用 Pillow/libjpeg q80 對合成的 1200×1200 單據影像（密集文字邊緣＋一個 QR 方陣）
 *      複驗同一件事，量的是 base64 編碼後的長度：乾淨 436 KB；加上 σ≈22 的高斯雜訊 759 KB。
 *
 * 取兩份量測裡最大的那個當「一張最壞會多大」。字串長度就是實際塞進 POST 的位元組數，
 * 所以這個數字直接可以拿去除預算（image 存進 expense_items.image，packages/db 是 text 欄位，
 * 沒有長度限制——「太大」不會在資料庫炸，會在網路那一段炸）。
 */
const THUMB_BASE64_BYTES_WORST = 758 * 1024;

/**
 * 前提二：單一 POST 的預算 8 MB。
 *
 * ★ 這是**前端自己給自己的預算，不是伺服端收得下多少的宣稱**——apps/api 沒有設 body 上限，
 *   實際部署前面擺什麼反向代理（nginx 的預設是 1 MB）本專案沒有量過。這條護欄的用處只有一個：
 *   超過的時候在**選檔當下**就把數字講出來，而不是等使用者填完十筆按下送出才失敗。
 */
const POST_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * 選檔當下那道張數護欄。8 MB ÷ 758 KB ＝ 10 張。
 *
 * ★ 這是**保守下界**：「這麼多張一定塞得下」的張數，不是「最多能塞幾張」。
 *   縮圖比最壞的那一張小時，其實還塞得下更多——但選檔當下沒有任何辦法知道縮完會多大
 *   （手上只有原始檔的 bytes，而它跟縮圖大小沒有可靠的關係：一張 8 MB 的高畫質掃描件
 *   縮完可能比一張 2 MB 的雜訊翻拍還小）。
 *
 * ★ **真正的判準不是這個常數**，是 buildBatchItems 執行期一邊處理一邊累加的真實 base64 長度。
 *   這一條只是第一道防線：讓「這批太多了」在選檔當下就講出來，而不是等使用者填完十筆才發現。
 *   兩者的分工是刻意的——這條寧可嚴一點（多分一批的代價是按兩次送出），
 *   執行期那條才是不能錯的（錯了就是 POST 過大，失敗訊息來自網路層，講不出發生什麼事）。
 */
export const MAX_BATCH_IMAGES = Math.floor(POST_BUDGET_BYTES / THUMB_BASE64_BYTES_WORST);

/**
 * 單張原始檔的上限：這一條限的是**解碼時同時存在的像素緩衝區**，那才是這一批的瓶頸
 * （解碼本身 12MP 約 40〜60ms，不是問題所在）。
 *
 *   一張影像展開成 RGBA ＝ 寬×高×4 byte。選檔當下拿不到寬高、只拿得到檔案 bytes，
 *   所以拿手機照片的壓縮比反推：12MP 的 JPEG 約 3〜5 MB、展開後 12e6×4 ＝ 48 MB
 *   ⇒ 展開比約 10〜16 倍，取偏保守的 15。
 *   峰值預算取 240 MB（**依序**處理，所以峰值就是一張）⇒ 240 MB ÷ 15 ＝ 16 MB／張。
 */
const RGBA_EXPANSION = 15;
const PEAK_RGBA_BUDGET_BYTES = 240 * 1024 * 1024;
export const MAX_SOURCE_BYTES_PER_FILE = PEAK_RGBA_BUDGET_BYTES / RGBA_EXPANSION;

/**
 * 整批原始檔加起來的上限。依序處理，所以這一條**不是記憶體限制**，是「這一批要跑多久」的限制：
 * 一張 12MP（約 4 MB）走完 FileReader → 解圖 → drawImage → getImageData → 解碼 → 縮圖 toDataURL
 * 的量級是 0.5〜1 秒（其中解碼只佔 40〜60ms）。64 MB ≈ 16 張 12MP ≈ 8〜16 秒；
 * 再長下去使用者會以為畫面掛了，逐張進度條也救不回來。
 */
export const MAX_SOURCE_BYTES_TOTAL = 64 * 1024 * 1024;

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * 把「你的檔案多大」與「上限多大」講成**分得出來的兩個數字**。
 *
 * 為什麼不能各自四捨五入到 MB：剛好超過一點點時兩邊會印成同一個數字，句子長成
 * 「16 MB 超過單張 16 MB 的上限」——使用者看不出要縮到多小，而這句話是這道護欄唯一的用處；
 * 更糟的是斷言 `toContain("16 MB")` 這時候兩個數字都對得上，測試也分不出來。
 *
 * 小數位數不夠分辨就再加一位，加到三位還一樣（差不到 0.001 MB）就直接講 bytes——
 * 寧可難看，也不要印出一句自相矛盾的話。
 */
export function mbPair(actual: number, limit: number): [string, string] {
  for (let digits = 0; digits <= 3; digits++) {
    const a = `${(actual / (1024 * 1024)).toFixed(digits)} MB`;
    const b = `${(limit / (1024 * 1024)).toFixed(digits)} MB`;
    if (a !== b) return [a, b];
  }
  return [`${actual} bytes`, `${limit} bytes`];
}

/**
 * 選檔當下的護欄：擋得下來就回一句話（**裡面一定要有上限的數字**，否則使用者不知道要怎麼改），
 * 過得了就回 null。
 *
 * 為什麼一定要在選檔當下擋、不能等送出：送出失敗時使用者已經把十幾筆的分類與說明填完了，
 * 而失敗訊息來自網路層（可能只是連線被切），他看不出來是「太大」還是「網路壞了」。
 *
 * existingImageCount 是表單上**已經帶著照片**的明細數：張數上限管的是同一個 POST 裡的縮圖總數，
 * 而那一批包含使用者先前一張一張加進來的。
 */
export function batchSelectionIssue(
  files: { name: string; size: number }[],
  existingImageCount: number,
): string | null {
  if (!files.length) return null;
  const total = existingImageCount + files.length;
  if (total > MAX_BATCH_IMAGES) {
    return (
      `一次最多 ${MAX_BATCH_IMAGES} 張：這張單上已經有 ${existingImageCount} 張帶著照片的明細，` +
      `這次又選了 ${files.length} 張，加起來 ${total} 張。` +
      `張數是這樣來的——收據縮圖是 base64 存進資料庫、跟著同一個 POST 一起送，` +
      `實測最大的一張是 ${Math.round(THUMB_BASE64_BYTES_WORST / 1024)} KB，單次送出的預算 ${mb(POST_BUDGET_BYTES)}，` +
      `所以 ${MAX_BATCH_IMAGES} 張是「一定塞得下」的張數——縮圖會縮成多大要等真的縮出來才知道，` +
      `這裡只能取保守值。請分批送出（先送這 ${MAX_BATCH_IMAGES} 張，核准與否互不影響）。`
    );
  }
  const tooBig = files.find((f) => f.size > MAX_SOURCE_BYTES_PER_FILE);
  if (tooBig) {
    const [got, cap] = mbPair(tooBig.size, MAX_SOURCE_BYTES_PER_FILE);
    return (
      `「${tooBig.name}」是 ${got}，超過單張 ${cap} 的上限。` +
      `辨識要把整張照片展開成未壓縮的像素（約是檔案的十幾倍），這一張展開後會把分頁的記憶體吃光。` +
      `請用手機相簿的「縮小尺寸」或截圖後再上傳。`
    );
  }
  const sum = files.reduce((s, f) => s + f.size, 0);
  if (sum > MAX_SOURCE_BYTES_TOTAL) {
    const [got, cap] = mbPair(sum, MAX_SOURCE_BYTES_TOTAL);
    return (
      `這次選的 ${files.length} 張加起來 ${got}，超過單批 ${cap} 的上限。` +
      `這一批是一張一張依序辨識的，這個大小大概要跑十幾秒以上。請分成兩批選。`
    );
  }
  return null;
}

/**
 * 「解碼那一步取回的像素整片同色」時要說的話。
 *
 * 這一句存在的理由（TRAPS: canvas-area-cap-returns-blank，confidence probable，本專案未在實機驗過）：
 * 瀏覽器對**單一 canvas 的面積**有上限，超過時取像素會回一片空白而**不丟例外**。
 * 於是高像素手機照片會安靜地變成「沒掃到 QR」——使用者只會一直重拍同一張，永遠拍不出結果。
 *
 * ★ 措辭必須與 scanAdvice("no-qr") **明確不同**：那一句叫人「把 QR 拍大一點、正一點再試」，
 *   而在這條路上照著做只會拍出更大的照片、更確定踩到同一個上限。
 * ★ 不寫任何面積數值（那是各瀏覽器各版本自己的事，寫死就是猜），只講**觀察到什麼**：
 *   取回的像素整片同色。
 */
export function blankSurfaceAdvice(): string {
  return (
    "照片已存，但辨識時從畫布取回的像素整片同色（一個像素的差別都沒有，等於什麼影像內容都沒拿到）——" +
    "這張照片的解析度可能超過瀏覽器單張畫布能處理的上限，於是取回的是空白而不是照片，系統因此看不到上面的 QR。" +
    "請改用截圖、或用較小的尺寸重拍一次再上傳；這一筆的發票欄位先留空、金額請手動填。" +
    "系統不自動把照片縮小再試：縮小會糊掉小的 QR，那會把「掃不到」換成「掃錯一張」，後者在畫面上看不出來。"
  );
}

/**
 * 探測畫布的結果。**尺寸一定要跟著回來**：
 * 「整片同色」這個觀察本身分不出「畫布大到取回空白」與「這張本來就是一張純色圖」
 * （全白、全黑、過曝、純色截圖都會整片同色），而唯一能分辨的證據就是影像尺寸。
 * 前一版算出了寬高卻只回一個 boolean，於是一張全白的**小圖**會被講成
 * 「解析度可能超過瀏覽器上限」，蓋掉正確的那一句「沒有解出 QR，請手動填」。
 */
export interface UniformSurface {
  /** 取回的像素是不是整片同色 */
  uniform: boolean;
  /** 探測時用的尺寸＝這個檔案的原始尺寸（不是縮圖的） */
  width: number;
  height: number;
}

/**
 * 縮圖規格的最長邊（einvoice-qr.ts 的 readReceiptImage：`1200 / Math.max(w, h)`）。
 * 這裡只拿它當**相對比較的基準**，不是任何上限。
 */
const THUMB_MAX_EDGE = 1200;

/**
 * 「這張明顯大於一般縮圖」的倍數。
 *
 * ★ 這是**啟發式，不是規格值**：瀏覽器的畫布面積上限是各家各版本自己的事
 *   （TRAPS: canvas-area-cap-returns-blank，confidence probable，本專案沒有在實機驗過），
 *   所以這裡刻意不寫任何面積數值當門檻——寫死一個「多少 Mpx 以上」就是把猜的數字當成規格。
 *   只問一個相對的問題：這張是不是遠大於我們自己縮出來的圖。
 *   取 2 倍：手機直出照片的最長邊在 3000px 以上，遠在這條線之上；
 *   而純色截圖、小圖、被裁過的圖在線下——那些整片同色是它們本來的樣子，不是取像素失敗。
 */
const LARGE_SURFACE_FACTOR = 2;

/** 上面那條啟發式的單一定義（畫面與測試都用它，不各寫一次）。 */
export function isLargeSurface(width: number, height: number): boolean {
  return Math.max(width, height) > THUMB_MAX_EDGE * LARGE_SURFACE_FACTOR;
}

/**
 * 掃描沒成功時，這一筆要顯示哪一句。
 *
 * surface：解碼那一步取回的像素是什麼樣子（探不出來時 null，見 probeUniformSurface）。
 * **只有在 reason 是 no-qr、整片同色、而且這張影像夠大時才蓋掉訊息**：
 *  - 掃到任何一個碼就代表畫布上確實有影像內容，那時候整片同色是矛盾的觀察，
 *    不該拿它去覆蓋一個已經成立的診斷；
 *  - 影像不夠大時，整片同色是「這張照片就是純色的」——講「解析度可能超過上限」
 *    會把人指去做一件沒有用的事（把一張全白的小圖再縮小），而且蓋掉了正確的那一句。
 */
export function scanFailureNote(
  scan: Pick<EInvoiceQrScan, "reason" | "lefts">,
  surface: UniformSurface | null,
): string {
  return scan.reason === "no-qr" && surface?.uniform && isLargeSurface(surface.width, surface.height)
    ? blankSurfaceAdvice()
    : scanAdvice(scan);
}

/**
 * 一段 RGBA 像素是不是整片同色。
 *
 * 這支是上面那條偵測的**唯一判準**，抽出來是因為它是這整包裡少數測得起來又必須測對的純邏輯：
 * 真實照片幾乎不可能整片同色（連純白背景都有感光雜訊），而 canvas 超過面積上限時回的是齊一值。
 *
 * 長度不足兩個像素時回 true：那代表根本沒取回可用的像素，跟取回一片空白是同一種失敗，
 * 不該被當成「有內容」而掉回「沒有 QR」那句話。
 */
export function uniformRgba(data: ArrayLike<number>): boolean {
  if (data.length < 8) return true;
  const [r, g, b, a] = [data[0], data[1], data[2], data[3]];
  for (let i = 4; i + 3 < data.length; i += 4) {
    if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a) return false;
  }
  return true;
}

/** 一個檔案讀完之後，批次那一段需要知道的全部東西。 */
export interface BatchScan {
  image: string;
  qr: EInvoiceQr | null;
  scan: Pick<EInvoiceQrScan, "reason" | "lefts" | "left">;
  /** 解碼那一步取回的像素長什麼樣（含尺寸）；沒探（或探不出來）時 null。 */
  uniformSurface: UniformSurface | null;
}

/**
 * 批次的第一張要**併進**使用者原本站著的那一列，還是**另起一列**？
 *
 * 讀不進來的那一張沒有 image（見 buildBatchItems 的 catch：那一列上只有一句原因，
 * 沒有任何屬於這個檔案的內容）。把它併進去等於拿「什麼都沒有」蓋掉使用者原本那一列的
 * 照片、qrPayload、發票號碼與可扣抵主張，卻留著金額與分類讓它照樣送得出去——
 * 而訊息只說「這張沒有讀進來、同一批的其他張不受影響」，被連坐刪掉的東西一個字都沒提。
 * 那正是使用者最不可能發現的一種錯：畫面上那一列還在，看起來只是少了張圖。
 *
 * 所以：有讀到東西才併，沒讀到就另起一列，原本那一列**一個欄位都不動**。
 */
export function firstRowPlacement(first: DraftItem): "merge" | "insert" {
  return first.image ? "merge" : "insert";
}

/**
 * 把第一筆批次結果併回使用者原本站著的那一列（只在 firstRowPlacement 說 "merge" 時才叫）。
 *
 * 為什麼要併而不是整列換掉：那一列上的「這筆是什麼」與「說明」是使用者自己打的，
 * 換張照片不該把它們清掉。
 *
 * 金額有三種情形，不是兩種：
 *  - 新結果自己掃到金額 ⇒ 用新的（它跟同一列的發票號碼是同一張憑證上的數字）；
 *  - 新結果沒掃到，而原本那一列的金額是**使用者自己打的** ⇒ 留著（換張照片不該把他打的數字清掉）；
 *  - 新結果沒掃到，而原本那一列的金額是**上一張憑證掃出來的**（row.qrPayload 有值）⇒ 清成 0。
 *    留著就是張冠李戴：畫面上是這張新照片，金額卻是上一張發票的，而伺服端的交叉核對也擋不到
 *    （這一列的 QR 原文已經跟著新結果被清掉了）。這一條與單張上傳那條路的 clearedByNewImage(hadQr)
 *    是同一個規則——兩條路現在走同一支函式，這裡是唯一寫它的地方。
 */
export function mergeIntoRow(row: DraftItem, first: DraftItem): DraftItem {
  const rowAmountCameFromScan = !!row.qrPayload;
  return {
    ...first,
    accountCode: first.accountCode || row.accountCode,
    description: first.description || row.description,
    amount: first.amount > 0 ? first.amount : rowAmountCameFromScan ? 0 : row.amount,
  };
}

/**
 * 一批檔案 → 一批明細。
 *
 * **依序處理，不併發**，理由是記憶體不是速度：解碼一張 12MP 現在只要 40〜60ms，
 * 但每一張在解碼期間要同時握著一份展開的 RGBA 緩衝區（12MP ≈ 48 MB，實測 +34〜51 MB）。
 * 十張併發＝三、四百 MB 的像素緩衝區同時存在，分頁被作業系統收掉的話使用者連錯誤訊息都看不到；
 * 而併發能省下的時間趨近於零——zxing 的解碼是**同步進到 wasm 裡跑**的，佔的是同一條主執行緒，
 * 排在一起也只是輪流跑。依序處理另外還換到兩件事：進度講得出「第幾張／共幾張」，
 * 以及同號防重可以邊做邊比（併發時「誰先誰後」不確定，同一批裡哪一張被擋下會隨機漂移）。
 *
 * **局部失敗隔離**：每一張各自 try／catch。某一張讀不進來或解碼炸了，其餘照樣進來，
 * 失敗那一張仍然生一筆明細、帶著看得見的原因——靜默消失的話使用者會以為自己少選了檔案。
 *
 * onItem 讓呼叫端一張一張把列加進畫面（不必等整批跑完畫面才動一下）；
 * 回傳值是同一批東西，外加沒帶進來的那幾個檔名（見 BatchResult）。
 */
export interface BatchResult {
  /** 真的落成明細的那幾筆（含帶著原因的失敗列）。畫面上「帶了幾張」講的是這個長度。 */
  items: DraftItem[];
  /**
   * 因為這一批的縮圖總量到頂而**完全沒有帶進來**的檔名。
   * 呼叫端一定要把這個數字講出來——沉默截斷的話，使用者會以為十張都在，
   * 少掉的那幾張要等到下個月對帳才發現（而那時他已經不記得選了哪幾個檔案）。
   */
  skipped: string[];
}

/**
 * 一批跑完之後，畫面上那一句話。
 *
 * 三個數字，一個都不能含混（每一個都對應到使用者接下來要做的事）：
 *  - **帶進來幾張**＝真的有內容的那幾列。讀不進來的那一列也是一列（刻意不靜默消失），
 *    但它身上沒有照片、沒有發票欄位——把它算進「已帶入」等於報一個比事實大的數字，
 *    而使用者正是靠這個數字判斷「我選的十張都在嗎」。
 *  - **沒讀進來幾張**：那幾列要他自己處理（填掉或刪掉），不講他不會知道要去找。
 *  - **完全沒帶進來幾張**（skipped）：連列都沒有，不講就是沉默截斷。
 *
 * 抽成純函式的理由：這句話是這條路上唯一的告知，而它現在有三個變數；
 * 寫在 JSX 裡的字串沒有任何測試守得住（前一版「已帶入 ${files.length} 張」就是這樣進去的）。
 */
export function batchOutcomeMessage(brought: DraftItem[], skipped: string[]): string {
  // 讀不進來的那一列沒有 image（見 buildBatchItems 的 catch），與 firstRowPlacement 同一個判準
  const unreadable = brought.filter((l) => !l.image).length;
  const withContent = brought.length - unreadable;
  const unreadableClause = unreadable
    ? `，另有 ${unreadable} 張沒有讀進來（畫面上各留了一列寫著原因——要留就自己填金額與分類，不要就按「刪除這筆」）`
    : "";
  const tail = "有底色標記的那幾筆是沒有辨識成功的，訊息裡寫著原因。";
  return skipped.length
    ? `這批帶了 ${withContent} 張${unreadableClause}，其餘 ${skipped.length} 張因為總量超過上限沒有帶入` +
        `（${skipped.join("、")}）——收據縮圖跟著同一個 POST 一起送，這一批的縮圖加起來已經到` +
        `單次送出的預算（${mb(POST_BUDGET_BYTES)}）。請先把這批送出，再選剩下的那幾張。${tail}`
    : `已帶入 ${withContent} 張${unreadableClause}——${tail}`;
}

export async function buildBatchItems<F extends { name: string }>(
  files: F[],
  read: (file: F) => Promise<BatchScan>,
  /**
   * existing＝表單上**確定會留下**的那幾列（呼叫端已經把正在被換掉的那一列排除掉）。
   * replacing＝那一列本身：第一張讀得進來時它會被整列換掉（見 firstRowPlacement），
   * 讀不進來時它**原封不動地留著**——留著就得跟其餘各列一樣算進同號防重與位元組預算，
   * 否則同一批後面的檔案可以帶著跟它相同的發票號碼過關，伺服端 422 把整張單退回
   * （而前端擋下重複的唯一理由就是不要走到那一步）。沒有那一列時傳 null。
   */
  ctx: { companyTaxId: string | null; existing: DraftItem[]; replacing?: DraftItem | null },
  hooks: { onProgress?: (current: number, total: number) => void; onItem?: (item: DraftItem) => void } = {},
): Promise<BatchResult> {
  const out: DraftItem[] = [];
  /** 發票號碼 → 它第一次出現在哪裡（講得出「跟誰重複」，使用者才知道要刪哪一筆） */
  const seen = new Map<string, string>();
  let bytes = 0;
  /** 一列既有明細占掉的名額：發票號碼進防重、縮圖進預算。兩件事寫一次，不要有一邊漏掉 */
  const absorb = (l: DraftItem, where: string) => {
    if (l.invoiceNumber && !seen.has(l.invoiceNumber)) seen.set(l.invoiceNumber, where);
    bytes += l.image?.length ?? 0;
  };
  for (const l of ctx.existing) absorb(l, "表單上已經有的明細");

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    hooks.onProgress?.(i + 1, files.length);
    let item: DraftItem;
    try {
      const r = await read(file);
      // ★ 張數的**真正判準在這裡**：這一批實際縮出來的 base64 長度一路累加，逼近預算就停手。
      //   選檔當下那道 MAX_BATCH_IMAGES 是保守下界（見那邊的說明），它過得了不代表塞得下——
      //   縮圖多大要等真的縮出來才知道，而那時已經在這個迴圈裡了；而且 existing 那一份的照片
      //   不見得是這支縮圖器產的（退回重送會把原單存著的影像整批載回表單），大小更不由這裡決定。
      //   停手不是「這一張跳過、下一張繼續」：剩下的每一張都得再解一次碼（一張 0.5〜1 秒），
      //   而預算已經滿了，結果只會是一串「沒帶入」的空列。整批停在這裡，剩下的交給呼叫端講。
      if (bytes + r.image.length > POST_BUDGET_BYTES) {
        return { items: out, skipped: files.slice(i).map((f) => f.name) };
      }
      bytes += r.image.length;
      if (r.scan.reason === "ok" && r.qr && r.scan.left) {
        const where = seen.get(r.qr.invoiceNumber);
        if (where) {
          // 同號防重：伺服端也查重（會回 422），但那時**整批都被拒**，使用者填好的十幾筆全部退回來。
          // 在這裡擋下的差別是：只有重複的這一張被擋，其餘九張還在畫面上。
          item = {
            ...EMPTY_ITEM,
            image: r.image,
            qrIssue: true,
            qrNote:
              `${file.name}：掃到的發票號碼 ${r.qr.invoiceNumber} 與${where}相同，` +
              `同一個發票號碼在同一張報銷單上只能有一筆——這一筆的發票欄位與金額沒有帶入。` +
              `重複選到同一個檔案就把這一筆刪掉；確定是兩張不同的發票就自己填，並回報給維護者。`,
          };
        } else {
          seen.set(r.qr.invoiceNumber, `這一批的「${file.name}」`);
          const patch = scannedItemPatch(r.qr, r.scan.left, ctx.companyTaxId);
          item = { ...EMPTY_ITEM, image: r.image, ...patch, qrNote: `${file.name}：${patch.qrNote}` };
        }
      } else {
        item = {
          ...EMPTY_ITEM,
          image: r.image,
          // 這一張沒辨識成功：qrPayload／taxSource 明確送 null（清掉），不是留空
          //（留空＝undefined＝JSON.stringify 丟掉欄位＝伺服端沿用它自己存著的那一份）。
          // 跟單張上傳那條路走同一支，兩邊不會有一邊寫成 undefined。
          ...clearedByNewImage(false),
          qrIssue: true,
          qrNote: `${file.name}：${scanFailureNote(r.scan, r.uniformSurface)}`,
        };
      }
    } catch (e) {
      item = {
        ...EMPTY_ITEM,
        qrIssue: true,
        qrNote:
          `${file.name}：這張沒有讀進來（${(e as Error).message}），照片與發票欄位都是空的。` +
          `同一批的其他張不受影響。這一筆要留就自己填金額與分類，不要就按「刪除這筆」。`,
      };
    }
    out.push(item);
    hooks.onItem?.(item);
    // 第一張讀不進來 ⇒ 使用者原本那一列留著（firstRowPlacement 說 insert），
    // 所以從第二張開始，它跟其餘各列一樣要占名額。讀得進來時它已經被換掉，不占。
    if (i === 0 && ctx.replacing && firstRowPlacement(item) === "insert") {
      absorb(ctx.replacing, "表單上已經有的明細");
    }
  }
  return { items: out, skipped: [] };
}

/**
 * 解碼那一步的畫布到底有沒有回東西：把這個檔案**照原尺寸**再展開一次，一條一條帶讀回像素，
 * 只要看到兩個不一樣的像素就立刻停手回 false。
 *
 * 為什麼要自己再展開一次：偵測的對象是「**跟解碼同尺寸**的那張畫布回了什麼」——
 * 面積上限是畫布尺寸的性質，用縮圖（最長邊 1200px）去看是看不到的，那張一定正常。
 * readReceiptImage 沒有把解碼用的像素帶出來，而掃描器這一輪不動，所以在這裡重取。
 *
 * 代價只付在已經失敗的那條路上（呼叫端只在 reason === "no-qr" 時才叫它）：
 * 掃到任何一個碼就代表畫布上確實有內容，沒有什麼好探的。
 *
 * 一條一條帶讀而不是整張讀回來：整張 12MP 是 48 MB，而判斷「整片同色」在真實照片上
 * 通常第一列就分出勝負了。帶高取「約 4 MB 一帶」。
 *
 * ★ 任何一步失敗就回 null（探不出來），不回「不同色」——探測失敗不是「畫布正常」的證據，
 *   硬回一個結果會讓 scanFailureNote 講出一句它其實沒有根據的話。
 *
 * ★ 回傳值一定要**帶著尺寸**：呼叫端要用它分辨「大到可能取回空白」與「這張本來就是純色的」
 *   （見 UniformSurface）。前一版算出了寬高就丟掉，於是那兩件事被講成同一件。
 */
async function probeUniformSurface(file: File): Promise<UniformSurface | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("影像格式不支援"));
      el.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const band = Math.max(1, Math.floor(1_000_000 / w));
    let ref: number[] | null = null;
    for (let y = 0; y < h; y += band) {
      const rows = Math.min(band, h - y);
      const { data } = ctx.getImageData(0, y, w, rows);
      if (!uniformRgba(data)) return { uniform: false, width: w, height: h };
      const here = [data[0]!, data[1]!, data[2]!, data[3]!];
      if (ref && ref.some((v, k) => v !== here[k])) return { uniform: false, width: w, height: h };
      ref = here;
    }
    // 每一帶各自同色、且各帶之間也同色 ⇒ 整張同色
    return { uniform: true, width: w, height: h };
  } catch {
    return null;
  } finally {
    // 畫布本身交給 GC；物件 URL 不撤掉會一直握著這個 File
    URL.revokeObjectURL(url);
  }
}

const STATUS_LABEL: Record<string, string> = {
  submitted: "待核准",
  approved: "已核准待付款",
  rejected: "已退回",
  paid: "已付款",
};

export function Expenses() {
  const me = useAuth();
  // 財務/管理者可代他人報銷並審核；其他角色一律以登入身分報銷
  const privileged = me.role === "finance" || me.role === "admin";
  // gm 看得到全部報銷單（唯讀），待付彙總一併給他看
  const seesAll = privileged || me.role === "gm";
  const employees = useFetch<Employee[]>("/employees");
  // 清單篩選（R3）：日期範圍（報銷單日期）；可見範圍（本人 vs 全部）由伺服端依角色決定
  const [filterQ, setFilterQ] = useState("");
  const claims = useListFetch<ExpenseClaimRow[]>(`/expense-claims${filterQ ? `?${filterQ}` : ""}`);
  const accounts = useFetch<Account[]>("/accounts");
  // R13：「公司欠員工多少」——approved 未付依員工彙總（財務視角小表）
  const payable = useFetch<ClaimPayableSummary>(seesAll ? "/expense-claims/payable-summary" : null);
  const [companyTaxId, setCompanyTaxId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // 稅率回退警告：報銷的內含稅回推也吃營業稅率，走了回退值必須讓使用者看到
  const [taxNotes, setTaxNotes] = useState<string[]>([]);
  // 稅額兩個來源不一致時伺服端擋下來的那一筆：攤開兩個數字讓使用者點選（不自動選、不預選）
  const [taxConflict, setTaxConflict] = useState<TaxSourceConflict | null>(null);
  // 四欄交叉核對被擋下：畫面要把「出路」指出來（清除辨識結果），否則使用者只能重傳照片或把金額改成 0
  const [qrMismatch, setQrMismatch] = useState(false);
  // 批次上傳的逐張進度：非 null＝正在跑（畫面要說得出「第幾張／共幾張」，也要擋住送出）
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);

  const [employeeId, setEmployeeId] = useState(0);
  const [claimDate, setClaimDate] = useState(new Date().toISOString().slice(0, 10));
  // 分類的可扣抵性隨日期而異，所以這筆取數要排在 claimDate 之後（讀得到它才能帶）：
  // path 帶著 claimDate，使用者改日期時 useFetch 便以新日期重取。
  // 打字途中的半截日期不發請求也不改狀態，畫面就維持上一個有效日期問到的答案
  //（見 expenseCategoriesPath：退回「不帶參數」等於讓端點以今天解析，那是漂移換個地方發生）
  const [categoryDate, setCategoryDate] = useState(claimDate);
  useEffect(() => {
    if (isClaimDate(claimDate)) setCategoryDate(claimDate);
  }, [claimDate]);
  const categories = useFetch<ExpenseCategory[]>(expenseCategoriesPath(categoryDate));
  // R13：誰先出的錢——員工代墊（預設）或公司支付（公司卡／公司帳戶）
  const [paidBy, setPaidBy] = useState<"employee" | "company">("employee");
  const [items, setItems] = useState<DraftItem[]>([{ ...EMPTY_ITEM }]);
  // R11：退回重送——非 null＝正在修改這張被退回的單（送出走 PATCH，回 submitted）
  const [editingClaim, setEditingClaim] = useState<{ id: number; memo: string } | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [payingId, setPayingId] = useState<number | null>(null);
  const [payAccountId, setPayAccountId] = useState(0);
  // 0036：作廢（核准後發現打錯的唯一出路——手工反向傳票救得了總帳、救不了 401）
  const [voidingId, setVoidingId] = useState<number | null>(null);
  const [voidReason, setVoidReason] = useState("");
  // 公司支付的單：核准時要指定貸方的付款科目（現金科目或公司卡負債科目）
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [approveAccountId, setApproveAccountId] = useState(0);
  // B13：付款日期一定要明確送出。原本不送 payDate，API 端以「今天」入帳——
  // 使用者以為在補記上月付款，傳票卻落在今天，關帳鎖形同虛設（明確送日期才擋得到）
  const [payDate, setPayDate] = useState("");
  const [detail, setDetail] = useState<ExpenseClaimDetail | null>(null);

  useEffect(() => {
    api.get<{ taxId: string }>("/company-profile").then((c) => setCompanyTaxId(c.taxId)).catch(() => setCompanyTaxId(null));
  }, []);

  // 現金科目以 isCash 旗標篩選（含自建的銀行帳戶科目），與收付款頁同一條規則
  const cashAccounts = accounts.data?.filter((a) => a.isCash) ?? [];
  // 公司支付的核准科目：現金科目（帳戶轉帳）或負債科目（公司卡的應付卡費——
  // 信用卡建不成現金科目，isCash 只准資產類，這是對的）
  const companyPayAccounts = accounts.data?.filter((a) => a.active && (a.isCash || a.type === "liability")) ?? [];
  const categoryOf = (code: string) => categories.data?.find((c) => c.accountCode === code);

  const setItem = (i: number, patch: Partial<DraftItem>) =>
    setItems((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  /* N2：父層完全不碰端點、也不 import 任何候選函式——候選就攤在 DOM 上，
     一個 querySelectorAll 就讀得回來（代號是按鈕文字的前四個字）。 */
  const rowRefs = { current: [] as (HTMLDivElement | null)[] };
  const codesOnScreen = (row: HTMLDivElement | null): string[] =>
    [...(row?.querySelectorAll("[data-sugg] button") ?? [])].map((b) => (b.textContent ?? "").trim().slice(0, 4));

  /**
   * 批次那一段要的「讀一個檔案」。除了 readReceiptImage 之外多做一件事：
   * 只有在「什麼碼都沒掃到」時才去探畫布是不是回了一片空白（見 probeUniformSurface）。
   * 掃到任何碼就代表畫布上有內容，沒有探的必要——而探測本身要再展開一次像素，
   * 這個代價只值得付在已經失敗的那條路上。
   */
  const readBatchFile = async (file: File): Promise<BatchScan> => {
    const { image, qr, scan } = await readReceiptImage(file);
    return { image, qr, scan, uniformSurface: scan.reason === "no-qr" ? await probeUniformSurface(file) : null };
  };

  /**
   * 選檔（可能一張、也可能十幾張）。結果**就地插在這一列的位置**，其餘各列原封不動
   * （接在最後面的話，這一批會被使用者先前填好的明細切開，順序看起來像亂的）。
   *
   * ★ **一張與多張走同一條路**，沒有「只選一張」的捷徑。
   *   前一版在 files.length === 1 時直接走 readReceiptImage、完全跳過 buildBatchItems 的同號防重，
   *   於是「這一張 vs 畫面上已經有的明細」只有在一次選多張時才擋得住：
   *   一張一張加的人（也就是多數人）照樣把同號帶到伺服端，422 一來**整張單**被退回——
   *   而那正是前端防重宣稱要避免的那件事。一張也是一批。
   */
  const onFiles = async (i: number, files: File[]) => {
    if (!files.length) return;
    // 排除第 i 列自己的照片：這一列的照片正要被換掉（一張也好、多張的第一張也好），
    // 算進去的話「換掉第 20 列的照片」會被自己的張數上限擋住，而張數其實一張都沒有多。
    const issue = batchSelectionIssue(files, items.filter((l, j) => !!l.image && j !== i).length);
    if (issue) {
      setOk(null);
      setError(issue);
      return;
    }
    setError(null);
    setOk(null);
    setTaxConflict(null); // 換了照片，上一次擋下來的那個「選哪個稅額來源」問題是對著舊憑證問的
    // 插入位置隨著已經進畫面的張數往後走；第一張（讀得到東西時）併回原本那一列，之後的插在它後面
    let placed = 0;
    try {
      const { items: brought, skipped } = await buildBatchItems(
        files,
        readBatchFile,
        // existing 排除第 i 列：它正要被這一批的第一張整列換掉，拿它的發票號碼去比對會把
        // 「換掉這一列的照片、還是同一張發票」誤判成重複，而使用者看到的是「這張被擋下了」。
        // 但第一張讀不進來時那一列會**留著**，那時它就得算進防重與預算——所以另外把它交給
        // replacing，由 buildBatchItems 在知道第一張的結果之後才決定要不要算它（見那邊的說明）。
        { companyTaxId, existing: items.filter((_, j) => j !== i), replacing: items[i] ?? null },
        {
          onProgress: (current, total) => setBatchProgress({ current, total }),
          // 一張一張進畫面：整批跑完才更新的話，選了十張之後畫面會有十幾秒完全不動
          onItem: (item) => {
            const at = i + placed;
            // 第一張讀不到東西時**不併**：另起一列，使用者原本那一列的照片與辨識結果一個都不動
            //（見 firstRowPlacement）。原本那一列跟著往下移，這一批仍然是連在一起的。
            const merge = placed === 0 && firstRowPlacement(item) === "merge";
            placed++;
            setItems((ls) => {
              const row = ls[at];
              if (merge && row) return [...ls.slice(0, at), mergeIntoRow(row, item), ...ls.slice(at + 1)];
              return [...ls.slice(0, at), item, ...ls.slice(at)];
            });
          },
        },
      );
      // 講**實際帶進來幾張**，不是選了幾張，也不含讀不進來的那幾列（見 batchOutcomeMessage）
      setOk(batchOutcomeMessage(brought, skipped));
      if (files.length > 1) {
        await new Promise((r) => setTimeout(r, 0));
        brought.forEach((_, k) => {
          const codes = codesOnScreen(rowRefs.current[i + k] ?? null);
          if (codes.length === 1) setItem(i + k, { accountCode: codes[0]! });
        });
      }
    } finally {
      setBatchProgress(null);
    }
  };

  /**
   * 刪掉一列。批次上傳之後這個按鈕才成為必需品：一次進來十筆，其中重複的、讀不進來的
   * 都會留著一筆帶原因的空明細（刻意不靜默消失），沒有刪除鍵的話使用者只能整張單重來。
   * 最後一列刪掉時補一列空的——表單不能變成沒有任何一列。
   */
  const removeItem = (i: number) =>
    setItems((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [{ ...EMPTY_ITEM }]));

  /**
   * 使用者掃完 QR 又手改欄位時，伺服端會拿存下來的 QR 原文做四欄交叉核對並擋下
   * （見 api/src/services/expenses.ts 的 prepareItems）。這是那個 422 的**出路**：
   * 明白地放棄這張憑證的辨識結果，改用你自己填的數字。內容見 clearedQrResultPatch。
   */
  const clearQrResult = (i: number) => {
    setQrMismatch(false);
    setError(null);
    setOk("已清除這筆的辨識結果，請再按一次送出");
    setItem(i, clearedQrResultPatch());
  };

  const submit = async () => {
    try {
      if (!editingClaim && privileged && !employeeId && !me.employeeId) throw new Error("請選擇報銷人");
      if (!editingClaim && !privileged && !me.employeeId) throw new Error("你的帳號尚未連結員工主檔，請請管理者到「設定」頁連結");
      const validItems = claimItemsPayload(items);
      if (!validItems.length) throw new Error("至少一筆有效明細（選分類、填金額）");
      const payload = { claimDate, paidBy, items: validItems };
      // R11：修改被退回的單走 PATCH（明細整批換掉、回 submitted）；memo 原樣保留
      const created = editingClaim
        ? await api.patch(`/expense-claims/${editingClaim.id}`, { ...payload, memo: editingClaim.memo || undefined })
        : await api.post("/expense-claims", { ...(privileged && employeeId ? { employeeId } : {}), ...payload });
      setTaxNotes(pickTaxNotes(created));
      setError(null);
      setTaxConflict(null);
      setQrMismatch(false);
      setOk(editingClaim ? `報銷單 #${editingClaim.id} 已修改重送，等會計核准` : "報銷已送出，等會計核准");
      setItems([{ ...EMPTY_ITEM }]);
      setEditingClaim(null);
      setPaidBy("employee");
      claims.reload();
    } catch (e) {
      setOk(null);
      const message = (e as Error).message;
      setError(message);
      // 稅額兩個來源不一致：訊息照樣顯示（它已經把兩個數字講清楚了），
      // 拆得出數字就再多給一組按鈕，讓使用者直接點選要用哪一個
      setTaxConflict(parseTaxSourceConflict(message));
      // 四欄交叉核對被擋下（掃完 QR 又改了欄位）：伺服端的訊息說得出哪裡對不起來，
      // 但沒有說「怎麼往下走」——出路是清掉這筆的辨識結果，那個按鈕在明細那一列
      setQrMismatch(QR_MISMATCH_RE.test(message));
    }
  };

  /**
   * 使用者點選了要用哪一個稅額來源：記在該筆明細上，等他再按一次送出。
   * 刻意不自動重送——重送的動作要是使用者按的，畫面上才留得住「我選了這個」這件事。
   */
  const chooseTaxSource = (invoiceNumber: string, source: "voucher" | "rate") => {
    setItems((ls) => ls.map((l) => (l.invoiceNumber === invoiceNumber ? { ...l, taxSource: source } : l)));
    setTaxConflict(null);
    setError(null);
    setOk(`已記下發票 ${invoiceNumber} 要用「${TAX_SOURCE_LABEL[source]}」的稅額，請再按一次送出`);
  };

  /** R11：把被退回的單載回表單（含已上傳的收據影像——不必重新上傳同一張照片） */
  const startResubmit = async (id: number) => {
    try {
      const cl = await api.get<ExpenseClaimDetail>(`/expense-claims/${id}`);
      setEditingClaim({ id: cl.id, memo: cl.memo });
      setClaimDate(cl.claimDate);
      setPaidBy(cl.paidBy);
      setItems(
        cl.items.map((it) => {
          // 原單存下來的 QR 原文與稅額來源要帶回畫面：伺服端重送時本來就會依發票號碼沿用它們
          //（resubmitClaim 的 carryOver），畫面不顯示的話，使用者上一次答過的「用哪個稅額來源」
          // 在這一次的表單上就完全看不見——他會以為系統忘了，或以為換了一個他沒選過的數字
          const taxSource = it.taxSource === "voucher" || it.taxSource === "rate" ? it.taxSource : undefined;
          return {
            ...(it.image ? { image: it.image } : {}),
            docType: it.docType,
            accountCode: it.accountCode,
            description: it.description,
            amount: it.amount,
            ...(it.invoiceNumber ? { invoiceNumber: it.invoiceNumber } : {}),
            ...(it.invoiceDate ? { invoiceDate: it.invoiceDate } : {}),
            ...(it.sellerTaxId ? { sellerTaxId: it.sellerTaxId } : {}),
            // 這兩個欄位**刻意用「有值才帶」**（省略＝undefined＝送不出去＝伺服端沿用它存著的那一份），
            // 與「清掉」那幾條路正好相反：這裡本來就是要沿用原單存下來的東西，而伺服端的 carryOver
            // 依發票號碼帶回來的就是同一份，兩邊一致。使用者要清掉時走的是「清除辨識結果」那個按鈕（送 null）。
            ...(it.qrPayload ? { qrPayload: it.qrPayload } : {}),
            ...(taxSource ? { taxSource } : {}),
            deductible: it.deductible,
            qrIssue: false,
            qrNote: it.image ? "已帶入原單的收據影像（要換再重新上傳即可）" : null,
          };
        }),
      );
      setError(null);
      setOk(null);
      // 上一次送出被擋下來的那兩個狀態是對著另一張單問的，載新的單進表單就不算數了
      setTaxConflict(null);
      setQrMismatch(false);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      setRejectingId(null);
      setPayingId(null);
      setVoidingId(null);
      setApprovingId(null);
      claims.reload();
      if (seesAll) payable.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
      <TaxNotes notes={taxNotes} />

      <div className="card">
        <h3>{editingClaim ? `修改被退回的報銷單 #${editingClaim.id}（送出後重新送審）` : "我要報銷（拍照或選檔，電子發票會自動辨識）"}</h3>
        {editingClaim && (
          <div style={{ fontSize: 13, color: "var(--amber)", marginBottom: 8 }}>
            原單明細（含收據影像）已帶入，改完按送出即回到待核准。{" "}
            <button className="small" onClick={() => { setEditingClaim(null); setItems([{ ...EMPTY_ITEM }]); setPaidBy("employee"); }}>取消修改</button>
          </div>
        )}
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          {editingClaim ? null : privileged ? (
            <label className="field">
              報銷人（可代同事送件）
              <select value={employeeId} onChange={(e) => setEmployeeId(Number(e.target.value))}>
                <option value={0}>— 本人 —</option>
                {employees.data?.filter((emp) => emp.active).map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="field" style={{ alignSelf: "center" }}>報銷人：{me.displayName}</span>
          )}
          <label className="field">日期<input type="date" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} /></label>
          {/* R13：公司卡付的費用也要從這裡報，進項稅才會進 401——不走報銷、開手工傳票的話，
              可扣抵稅額一毛都進不了申報 */}
          <label className="field">
            誰先出的錢
            <select value={paidBy} onChange={(e) => setPaidBy(e.target.value as "employee" | "company")}>
              <option value="employee">員工代墊（核准後公司付款還我）</option>
              <option value="company">公司支付（公司卡／公司帳戶，不必還款）</option>
            </select>
          </label>
        </form>
        {paidBy === "company" && (
          <div style={{ fontSize: 13, color: "var(--accent)", marginTop: 4 }}>
            公司卡或公司帳戶付的費用也要從這裡報，進項稅才會進 401 申報。核准時由財務指定付款科目
            （現金科目或公司卡的負債科目），核准即入帳完成，不再有付款步驟。
          </div>
        )}
        {!privileged && !me.employeeId && (
          <div className="error" style={{ marginTop: 8 }}>你的帳號尚未連結員工主檔，送出會失敗——請請管理者到「設定」頁的使用者管理連結員工。</div>
        )}
        {/* ★ 批次期間**整列都鎖住**（下面每一個 select／input／button 都吃 batchProgress）。
            理由：所有寫進明細的動作都是 index-based（setItem(i, …)、removeItem(i)），
            而批次正在用 onItem 一張一張**往中間插列**——插一列之後，同一個 i 指到的已經是另一筆。
            使用者在那十幾秒內動任何一列，patch 就落在錯的列上：金額被填到別人的明細、
            分類被改到隔壁筆，而畫面上完全看不出來（兩列長得一樣，只是內容換了位置）。
            為什麼鎖住而不是改成穩定 id 定位：改 id 要動到每一列的身分、key、以及所有
            setItem/removeItem 的路徑（連退回重送載回來的那批也要發 id），是這一輪最大的一塊改動；
            而鎖住的代價只有「這十幾秒不能編輯」，而且畫面本來就在跑進度條、使用者也在等它跑完。
            哪天真的要一邊批次一邊編輯，再換成 id——那時這段註解就是為什麼不能只把 disabled 拿掉。 */}
        {items.map((l, i) => (
          <div key={i} style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <form className="inline" onSubmit={(e) => e.preventDefault()}>
              <label className="field">
                單據照片
                {/* multiple：整疊報帳一次選完。選同一批檔案第二次也要能觸發，所以取完 File 之後把
                    input 的 value 清掉（不清的話瀏覽器認為「值沒變」而不發 change） */}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={!!batchProgress}
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    void onFiles(i, picked);
                  }}
                />
              </label>
              <label className="field">
                這筆是什麼
                <select disabled={!!batchProgress} value={l.accountCode} onChange={(e) => setItem(i, { accountCode: e.target.value })}>
                  <option value="">— 請選擇 —</option>
                  {categories.data?.map((c) => (
                    <option key={c.accountCode} value={c.accountCode}>{c.label}（{c.hint}）</option>
                  ))}
                </select>
              </label>
              {/* 改了總額，先前針對「兩個稅額來源」做的選擇就是對著另一個數字做的，必須作廢重問 */}
              <label className="field">金額（發票上的總額）<input disabled={!!batchProgress} type="number" min={0} value={l.amount} onChange={(e) => setItem(i, { amount: Number(e.target.value), ...clearedTaxSource() })} /></label>
              <label className="field">說明（選填）<input disabled={!!batchProgress} value={l.description} onChange={(e) => setItem(i, { description: e.target.value })} /></label>
              {items.length > 1 && (
                <button disabled={!!batchProgress} className="small" onClick={() => removeItem(i)}>刪除這筆</button>
              )}
              {i === items.length - 1 && (
                <button disabled={!!batchProgress} className="small" onClick={() => setItems((ls) => [...ls, { ...EMPTY_ITEM }])}>＋再加一張</button>
              )}
            </form>
            {l.qrNote && (
              <div style={{ fontSize: 13, color: l.qrIssue ? "var(--amber)" : "var(--accent)", marginTop: 4 }}>{l.qrNote}</div>
            )}
            {/* 掃完 QR 之後號碼／日期／金額／統編都帶好了，只剩「這筆是什麼」還要自己從下拉找。
                這家賣方過去被歸過的分類由 CategorySuggestions 自己去問、自己畫——
                ★ 這一層（握著 setItem、知道有幾列的這一層）看不到那份候選清單：
                  不知道有幾個、不知道 claimCount、不知道第一個是誰，所以「只有一個就自動選」
                  在這裡不是「測不到」，是寫不出來（理由見 src/CategorySuggestions.tsx 的檔頭）。
                  它交出來的只有「使用者剛才按了哪一個代號」這件事。 */}
            <div data-sugg ref={(el) => { rowRefs.current[i] = el; }}>
              <CategorySuggestions
                sellerTaxId={l.sellerTaxId}
                categories={categories.data}
                disabled={!!batchProgress}
                onPick={(accountCode) => setItem(i, { accountCode })}
              />
            </div>
            {/* 掃完 QR 又手改欄位時伺服端會擋下（四欄交叉核對）。那個 422 說得出哪裡對不起來，
                但沒有出路——沒有這個按鈕，使用者只剩「重傳一張沒有 QR 的照片」或「把金額改成 0」。 */}
            {l.qrPayload && (
              <div style={{ fontSize: 13, marginTop: 4, color: qrMismatch ? "var(--amber)" : "var(--text-2)" }}>
                這筆帶著掃到的發票 QR 原文（伺服端從它導出進項稅額，並核對發票號碼／日期／賣方統編／總額四欄）。
                {qrMismatch && (
                  <strong>
                    　剛才送出被伺服端擋下（422）：這四欄裡有欄位與 QR 對不起來（上面那行寫的是哪一欄、兩邊各是什麼）。
                    兩條路——把欄位改回 QR 上的數字，或按這裡清掉這張憑證的辨識結果、改用你自己填的
                    （清掉之後這筆不再主張可扣抵）：
                  </strong>
                )}{" "}
                <button disabled={!!batchProgress} className="small" onClick={() => clearQrResult(i)}>清除這張憑證的辨識結果</button>
              </div>
            )}
            {/* 稅額兩個來源不一致：兩個數字都攤在按鈕上，由使用者點一個。
                系統不預選、不自動選——哪個數字進 401 是使用者的責任，不是系統的。 */}
            {taxConflict && taxConflict.invoiceNumber === l.invoiceNumber && (
              <div className="error" style={{ marginTop: 4 }}>
                <div>
                  這張發票的進項稅額有兩個來源、數字不一樣，請選一個（沒選就不送出——系統不替你決定哪個數字進 401）：
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                  <button disabled={!!batchProgress} className="small" onClick={() => chooseTaxSource(taxConflict.invoiceNumber, "voucher")}>
                    {TAX_SOURCE_LABEL.voucher}：{fmt(taxConflict.voucherTax)} 元
                  </button>
                  <button disabled={!!batchProgress} className="small" onClick={() => chooseTaxSource(taxConflict.invoiceNumber, "rate")}>
                    {TAX_SOURCE_LABEL.rate}：{fmt(taxConflict.rateTax)} 元
                  </button>
                </div>
                <div style={{ fontSize: 12, marginTop: 6 }}>
                  「{TAX_SOURCE_LABEL.voucher}」＝總額減掉 QR 上載的銷售額；
                  「{TAX_SOURCE_LABEL.rate}」＝依你在「稅法參數」頁設定的營業稅率換算。
                  QR 的加密驗證區本系統尚未驗證，可機讀不等於已驗真。
                </div>
              </div>
            )}
            {l.taxSource && (
              <div style={{ fontSize: 13, color: "var(--amber)", marginTop: 4 }}>
                這筆的稅額指定用「{TAX_SOURCE_LABEL[l.taxSource]}」{" "}
                <button disabled={!!batchProgress} className="small" onClick={() => setItem(i, clearedTaxSource())}>取消指定</button>
              </div>
            )}
            {/* 原本這裡把「不可扣抵」寫得像系統查過條文的結論——那是系統在替使用者斷言稅法，而系統並不知道。
                現在明講這個判定是誰說了算：你在「稅法參數」頁設定的值，還是尚未經查證的系統預設。 */}
            {l.accountCode && <DeductibleNote category={categoryOf(l.accountCode)} onDate={claimDate} />}
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          {/* 逐張進度：一次選十張時使用者必須看得到系統在動，以及還剩幾張 */}
          {batchProgress && (
            <div style={{ fontSize: 13, color: "var(--accent)", marginBottom: 6 }}>
              正在辨識第 {batchProgress.current}／{batchProgress.total} 張…（一張一張處理，處理完的會馬上出現在上面）
            </div>
          )}
          <button className="primary" onClick={submit} disabled={!!batchProgress}>
            {editingClaim ? "修改並重新送審" : "送出報銷"}
          </button>
        </div>
      </div>

      {/* R13：公司欠員工多少（財務視角）——approved 未付依員工彙總，發薪/還款前一眼看清 */}
      {seesAll && payable.data && payable.data.count > 0 && (
        <div className="card">
          <h3>待付報銷（公司欠員工 {fmt(payable.data.amount)} 元，共 {payable.data.count} 件）</h3>
          <table>
            <thead><tr><th>員工</th><th className="num">件數</th><th className="num">未付金額</th></tr></thead>
            <tbody>
              {payable.data.byEmployee.map((r) => (
                <tr key={r.employeeId}>
                  <td>{r.employeeName}</td>
                  <td className="num">{r.count}</td>
                  <td className="num">{fmt(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0 0" }}>
            只計員工代墊（approved 未付款、未作廢）的單；公司支付的報銷核准即付清，不在此列。
          </p>
        </div>
      )}

      <div className="card">
        <h3>{privileged ? "報銷單（會計：核准後拋轉費用傳票；付款沖其他應付款）" : "我的報銷單"}</h3>
        <ListFilterBar onApply={setFilterQ} total={claims.total} shown={claims.data?.length ?? 0} />
        {claims.data?.length === 0 && (
          <EmptyState
            icon="🧾"
            title={privileged ? "還沒有人送出報銷單" : "你還沒有報銷單"}
            {...(employees.data?.some((emp) => emp.active)
              ? { desc: "同事墊付的費用用上面的表單送出。電子發票直接拍照或選檔，金額與稅額會自動辨識，不用自己打。" }
              : {
                  desc: "還沒有員工名冊——報銷單要指定申請人，先到「客戶與商品」把會報帳的同事建起來。",
                  actionLabel: "去建立員工",
                  actionPage: "masters" as const,
                })}
          />
        )}
        {claims.data && claims.data.length > 0 && (
        <table>
          <thead>
            <tr><th>單號</th><th>日期</th><th>員工</th><th className="num">總額</th><th className="num">可扣抵稅額</th><th>狀態</th><th></th></tr>
          </thead>
          <tbody>
            {claims.data?.map((cl) => (
              <tr key={cl.id}>
                <td>#{cl.id}</td>
                <td>{cl.claimDate}</td>
                <td>{cl.employeeName}{cl.paidBy === "company" && <span style={{ fontSize: 12, color: "var(--text-2)" }}>（公司支付）</span>}</td>
                <td className="num">{fmt(cl.total)}</td>
                <td className="num">{fmt(cl.items.reduce((s, it) => s + it.tax, 0))}</td>
                <td>
                  {cl.voidedAt ? (
                    <span className="badge canceled" title={`作廢理由：${cl.voidReason ?? ""}（沖轉傳票 #${cl.reversalEntryId ?? "—"}）`}>已作廢</span>
                  ) : (
                    <span className={`badge ${cl.status === "paid" || cl.status === "approved" ? "issued" : "canceled"}`}>
                      {STATUS_LABEL[cl.status]}
                    </span>
                  )}
                  {!cl.voidedAt && cl.status === "rejected" && cl.rejectReason && <span style={{ fontSize: 12 }}>（{cl.rejectReason}）</span>}
                </td>
                <td>
                  <button className="small" onClick={() => void api.get<ExpenseClaimDetail>(`/expense-claims/${cl.id}`).then(setDetail)}>明細</button>{" "}
                  {/* R11：被退回的單本人（或財務）可改明細重送，不必重打重傳 */}
                  {cl.status === "rejected" && (privileged || cl.employeeId === me.employeeId) && (
                    <button className="small" onClick={() => void startResubmit(cl.id)}>修改重送</button>
                  )}
                  {privileged && cl.status === "submitted" && rejectingId !== cl.id && approvingId !== cl.id && (
                    <>
                      {cl.paidBy === "company" ? (
                        // 公司支付：核准要指定付款科目（貸方直接是它，核准即付清）
                        <button className="small" onClick={() => { setApprovingId(cl.id); setApproveAccountId(0); }}>核准</button>
                      ) : (
                        <button className="small" onClick={() => void act(() => api.post(`/expense-claims/${cl.id}/approve`, {}))}>核准</button>
                      )}{" "}
                      <button className="small" onClick={() => { setRejectingId(cl.id); setRejectReason(""); }}>退回</button>
                    </>
                  )}
                  {approvingId === cl.id && (
                    <>
                      <select value={approveAccountId} onChange={(e) => setApproveAccountId(Number(e.target.value))}>
                        <option value={0}>付款科目（公司帳戶或卡）</option>
                        {companyPayAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                        ))}
                      </select>{" "}
                      <button className="small" onClick={() => void act(() => api.post(`/expense-claims/${cl.id}/approve`, { accountId: approveAccountId }))}>確認核准</button>{" "}
                      <button className="small" onClick={() => setApprovingId(null)}>取消</button>
                    </>
                  )}
                  {rejectingId === cl.id && (
                    <>
                      <input autoFocus placeholder="退回原因" style={{ width: 120 }} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />{" "}
                      <button className="small" onClick={() => void act(() => api.post(`/expense-claims/${cl.id}/reject`, { reason: rejectReason }))}>確認退回</button>{" "}
                      <button className="small" onClick={() => setRejectingId(null)}>取消</button>
                    </>
                  )}
                  {privileged && cl.status === "approved" && !cl.voidedAt && payingId !== cl.id && (
                    <button className="small" onClick={() => { setPayingId(cl.id); setPayAccountId(0); setPayDate(new Date().toISOString().slice(0, 10)); }}>付款</button>
                  )}
                  {payingId === cl.id && (
                    <>
                      <select value={payAccountId} onChange={(e) => setPayAccountId(Number(e.target.value))}>
                        <option value={0}>付款科目</option>
                        {cashAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                        ))}
                      </select>{" "}
                      <input type="date" title="付款日期（傳票以這一天入帳）" value={payDate} onChange={(e) => setPayDate(e.target.value)} />{" "}
                      <button className="small" onClick={() => void act(() => api.post(`/expense-claims/${cl.id}/pay`, { accountId: payAccountId, ...(payDate ? { payDate } : {}) }))}>確認付款</button>{" "}
                      <button className="small" onClick={() => setPayingId(null)}>取消</button>
                    </>
                  )}
                  {/* 0036：作廢——核准後發現打錯的出路（反向傳票沖總帳，401 一併排除） */}
                  {privileged && (cl.status === "approved" || cl.status === "paid") && !cl.voidedAt && voidingId !== cl.id && payingId !== cl.id && (
                    <>{" "}<button className="small" onClick={() => { setVoidingId(cl.id); setVoidReason(""); }}>作廢</button></>
                  )}
                  {voidingId === cl.id && (
                    <>
                      <input autoFocus placeholder="作廢理由" style={{ width: 120 }} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />{" "}
                      <button className="small" onClick={() => void act(() => api.post(`/expense-claims/${cl.id}/void`, { reason: voidReason }))}>確認作廢</button>{" "}
                      <button className="small" onClick={() => setVoidingId(null)}>取消</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>

      {detail && (
        <div className="card">
          <h3>報銷單 #{detail.id}（{detail.employeeName}） <button className="small" onClick={() => setDetail(null)}>關閉</button></h3>
          {/* 核准的人才是讓這些進項稅進 401 的那一個人，而他手上原本只有「可扣抵稅額」一個數字。
              伺服端從已落地的欄位重建的說明就在這裡：兩個競爭的數字（憑證所載 vs 費率回推）各是多少、
              哪一個沒被採用，以及伺服端自己做過的判定（例如買方統編不是本公司，已收成不可扣抵）。
              建單時那幾句只回給送單的人看，核准者從來沒看過。 */}
          {detail.taxNotes && detail.taxNotes.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: "var(--text-2)" }}>
                這張單的稅額說明（伺服端依已落地的欄位重建，不是重算——重算會跟著之後改過的稅率參數跑）：
              </div>
              <TaxNotes notes={detail.taxNotes} />
            </div>
          )}
          <table>
            {/* 稅額來源這一欄是「這個數字為什麼是這個數字」的唯一去處：
                兩個來源不一致時是使用者自己選的，而退回重送會由伺服端沿用同一個選擇——
                畫面不顯示的話，下個月沒有人答得出來當初選的是哪一個。 */}
            <thead><tr><th>分類</th><th>說明</th><th>單據</th><th>發票號碼</th><th className="num">金額</th><th className="num">可扣抵稅額</th><th>稅額來源</th></tr></thead>
            <tbody>
              {detail.items.map((it) => (
                <tr key={it.id}>
                  <td>{categoryOf(it.accountCode)?.label ?? it.accountCode}</td>
                  <td>{it.description}</td>
                  <td>{it.docType === "einvoice" ? "電子發票" : it.docType === "receipt" ? "收據" : "其他"}</td>
                  <td>{it.invoiceNumber ?? "—"}</td>
                  <td className="num">{fmt(it.amount)}</td>
                  <td className="num">{it.tax ? fmt(it.tax) : "—"}</td>
                  <td style={{ fontSize: 13 }}>
                    {it.taxSource === "voucher" || it.taxSource === "rate" ? TAX_SOURCE_LABEL[it.taxSource] : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
            {/* R12：影像可單獨下載（記帳士要憑證檔）；API 另有 GET /expense-claims/:id/items/:itemId/image */}
            {detail.items.filter((it) => it.image).map((it) => (
              <div key={it.id} style={{ textAlign: "center" }}>
                <img src={it.image!} alt={it.invoiceNumber ?? "單據"} style={{ maxWidth: 260, maxHeight: 320, border: "1px solid var(--line)" }} />
                <div>
                  <a download={`報銷單${detail.id}-明細${it.id}${it.invoiceNumber ? `-${it.invoiceNumber}` : ""}`} href={it.image!} className="small">
                    下載憑證
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 這一類的進項稅可否扣抵，以及**是誰說了算**。
 *
 * 為什麼一定要把來源講出來：「不可扣抵」四個字看起來像系統查證過的結論，
 * 但預設值其實是本專案未經查證填的（見 packages/core/src/chart.ts）。
 * 使用者若想改，出路在「稅法參數」頁——覆寫它並留下自己的依據來源與生效期間。
 *
 * onDate＝這張單的報銷單日期。這裡把日期講出來，是因為判定本身是「那一天」的判定：
 * 分類清單就是帶著同一個日期問來的，伺服端建單時也是以同一個日期解析，
 * 三處對齊了，畫面上寫的才會等於實際落地的稅額。
 */
function DeductibleNote(props: { category: ExpenseCategory | undefined; onDate: string }) {
  const nav = useNav();
  // 只有進得了那一頁的人才給連結：員工／業務看不到稅法參數頁，
  // 給了按鈕按下去會靜靜地跳回第一頁——那比沒有按鈕更糟
  const canEdit = canAccessPage(useAuth().role, "tax-parameters");
  const c = props.category;
  if (!c) return null;
  const byUser = c.deductibleSource === "parameter";
  return (
    <div style={{ fontSize: 13, color: byUser ? "var(--green)" : "var(--text-2)", marginTop: 4 }}>
      這一類在<strong>{props.onDate}</strong>（本單日期）判定為
      <strong>{c.inputTaxDeductible ? "可扣抵" : "不可扣抵"}</strong>進項稅
      {byUser ? (
        <>
          ，依據<strong>你在「稅法參數」頁設定的值</strong>
          （{c.deductibleValidFrom} 起{c.deductibleValidTo ? `～${c.deductibleValidTo}` : "，仍有效"}
          {c.deductibleSourceNote ? `；依據來源：${c.deductibleSourceNote}` : "；未註明依據來源"}）。
        </>
      ) : (
        <>
          ，用的是<strong>系統預設值（尚未經查證）</strong>。
          {canEdit ? (
            <>
              若你查證後認為不對，可到{" "}
              <button className="small" onClick={() => nav("tax-parameters")}>稅法參數</button>{" "}
              頁覆寫它並留下依據；<strong>已建立的報銷單稅額不會回頭重算</strong>。
            </>
          ) : (
            <>若你查證後認為不對，請告知財務——他可以在「稅法參數」頁覆寫並留下依據。</>
          )}
        </>
      )}
    </div>
  );
}
