import { canAccessPage } from "@tw-erp/core";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
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

  const onFile = async (i: number, file: File | null) => {
    if (!file) return;
    try {
      const { image, qr, scan } = await readReceiptImage(file);
      setTaxConflict(null); // 換了照片，上一次擋下來的那個「選哪個稅額來源」問題是對著舊憑證問的
      if (scan.reason === "ok" && qr && scan.left) {
        setItem(i, { image, ...scannedItemPatch(qr, scan.left, companyTaxId) });
      } else {
        // 三種失敗的出路完全不同，訊息就得完全不同——講成同一句「沒掃到」，
        // 使用者只會一直重拍同一種構圖（見 einvoice-qr.ts 的 EInvoiceQrScan.reason）
        setItem(i, { image, ...clearedByNewImage(!!items[i]?.qrPayload), qrIssue: true, qrNote: scanAdvice(scan) });
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
        {items.map((l, i) => (
          <div key={i} style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <form className="inline" onSubmit={(e) => e.preventDefault()}>
              <label className="field">
                單據照片
                <input type="file" accept="image/*" onChange={(e) => void onFile(i, e.target.files?.[0] ?? null)} />
              </label>
              <label className="field">
                這筆是什麼
                <select value={l.accountCode} onChange={(e) => setItem(i, { accountCode: e.target.value })}>
                  <option value="">— 請選擇 —</option>
                  {categories.data?.map((c) => (
                    <option key={c.accountCode} value={c.accountCode}>{c.label}（{c.hint}）</option>
                  ))}
                </select>
              </label>
              {/* 改了總額，先前針對「兩個稅額來源」做的選擇就是對著另一個數字做的，必須作廢重問 */}
              <label className="field">金額（發票上的總額）<input type="number" min={0} value={l.amount} onChange={(e) => setItem(i, { amount: Number(e.target.value), ...clearedTaxSource() })} /></label>
              <label className="field">說明（選填）<input value={l.description} onChange={(e) => setItem(i, { description: e.target.value })} /></label>
              {i === items.length - 1 && (
                <button className="small" onClick={() => setItems((ls) => [...ls, { ...EMPTY_ITEM }])}>＋再加一張</button>
              )}
            </form>
            {l.qrNote && (
              <div style={{ fontSize: 13, color: l.qrIssue ? "var(--amber)" : "var(--accent)", marginTop: 4 }}>{l.qrNote}</div>
            )}
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
                <button className="small" onClick={() => clearQrResult(i)}>清除這張憑證的辨識結果</button>
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
                  <button className="small" onClick={() => chooseTaxSource(taxConflict.invoiceNumber, "voucher")}>
                    {TAX_SOURCE_LABEL.voucher}：{fmt(taxConflict.voucherTax)} 元
                  </button>
                  <button className="small" onClick={() => chooseTaxSource(taxConflict.invoiceNumber, "rate")}>
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
                <button className="small" onClick={() => setItem(i, clearedTaxSource())}>取消指定</button>
              </div>
            )}
            {/* 原本這裡把「不可扣抵」寫得像系統查過條文的結論——那是系統在替使用者斷言稅法，而系統並不知道。
                現在明講這個判定是誰說了算：你在「稅法參數」頁設定的值，還是尚未經查證的系統預設。 */}
            {l.accountCode && <DeductibleNote category={categoryOf(l.accountCode)} onDate={claimDate} />}
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={submit}>{editingClaim ? "修改並重新送審" : "送出報銷"}</button>
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
