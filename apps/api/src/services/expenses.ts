/**
 * 員工費用報銷：員工送出 → 會計核准（拋轉費用傳票）→ 付款（沖其他應付款）。
 *
 * 進項稅可扣抵由伺服端把關，條件是三個**結構**條件同時成立：
 * 統編電子發票（docType/發票號碼/賣方統編齊全）＋前端有主張＋**該分類目前判定為可扣抵**。
 *
 * ★ 最後那一項是**稅法參數，不是系統的知識**：先查 tax_parameters
 *   （kind='input_tax_deductible'、scope_key＝費用科目代號），查不到才用 core 的 EXPENSE_CATEGORIES
 *   預設值。使用者可以在「稅法參數」頁覆寫並留下自己的依據來源與生效期間。
 *   本檔（與前身的註解）刻意不再引述任何法條號碼——那是系統對稅法的斷言，
 *   而本專案的紀律是「法規原文為一級規格，沒有一級來源就不寫成程式」。
 *
 * 稅額的算術也不再寫死費率：內含稅回推用的營業稅率由 resolveVatRate 依日期解析。
 * 可扣抵明細以發票日期進 401 媒體檔（services/vat.ts）。
 *
 * ★ **稅額一律由伺服端從單據事實導出**（本檔與進貨側共用的不變量：docInput 根本沒有 tax 欄位）。
 *   前端能給的只有「掃到的 QR 原文」與「兩個來源不一致時你選哪一個」，永遠不是稅額本身。
 */
import { ACCOUNT, EXPENSE_CATEGORIES, roundHalfUp } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { parseEInvoiceLeftQr } from "@tw-erp/einvoice";
import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNull, lte, ne, sql, sum } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import type { AuthUser } from "./auth.ts";
import { assertNotFarFuture } from "./dates.ts";
import type { ListFilter } from "./list.ts";
import { assertClaimPeriodsOpen, assertPeriodOpen } from "./period.ts";
import { resolveDeductible, resolveVatRate } from "./tax-parameters.ts";

const CATEGORY_BY_CODE = new Map(EXPENSE_CATEGORIES.map((c) => [c.accountCode, c]));

/** 422 EXPENSE_CONFLICT 的 details 元素（前端 Expenses.tsx 依此分岔，與訊息文字脫鉤） */
export type ExpenseConflictDetail =
  | { kind: "qr_mismatch"; lineIndex: number }
  | { kind: "tax_source_conflict"; lineIndex: number; invoiceNumber: string | null; voucherTax: number; rateTax: number };

export interface ExpenseItemInput {
  accountCode: string;
  description?: string | undefined;
  docType: "einvoice" | "receipt" | "other";
  amount: number; // 含稅整數元
  deductible?: boolean | undefined; // 前端依 QR 買方統編判斷；伺服端仍會套硬規則
  /**
   * 掃到的電子發票 QR 左碼**原文**（不是解析後的數字）。銷售額由伺服端自己解析導出。
   *
   * ★ 收原文而不收 salesAmount，是這條路的**信任邊界**：前端若能直接給銷售額，
   *   「總額 − 銷售額 = 進項稅」就等於讓任何人把任意金額宣稱成進項稅
   *   （amount 10000、salesAmount 0 → 稅額 10000 進 401）。收原文之後，
   *   稅額只能從「被宣稱的那張憑證」導出（見 prepareItems 的殘餘風險說明）。
   * ⚠️ 稱「憑證所載的結構化值」而不是「權威值」：加密驗證區本系統從未驗證，可機讀不等於已驗真。
   */
  qrPayload?: string | null | undefined;
  /**
   * 兩個稅額來源不一致時，使用者選了哪一個：'voucher'＝憑證所載的銷售額回推、'rate'＝設定的稅率回推。
   * 不指定就不會有預設——不一致時伺服端擋下要求確認（見 prepareItems）。
   * 它只是在**兩個伺服端算出來的數字**之間選一個，本身不帶任何金額。
   *
   * ★ undefined 與 null 是**兩件不同的事**（qrPayload 同理，理由見 prepareItems 的 carried 段）：
   *   undefined＝前端沒送這個欄位、null＝使用者明確清掉。
   */
  taxSource?: "voucher" | "rate" | null | undefined;
  invoiceNumber?: string | undefined;
  invoiceDate?: string | undefined;
  sellerTaxId?: string | undefined;
  image?: string | undefined; // base64 縮圖
}

export interface ClaimInput {
  employeeId: number;
  claimDate: string;
  memo?: string | undefined;
  /**
   * R13：誰先出的錢。'employee'（預設）＝員工代墊，核准貸 2201、之後付款還員工；
   * 'company'＝公司支付（公司卡／公司帳戶），核准時直接貸付款科目、狀態進 paid——
   * 沒有這個欄位之前，公司卡費用要嘛用「假員工」workaround，要嘛走手工傳票而讓進項稅
   * 一毛都進不了 401（generate401 只掃 invoices/purchases/expense_items，不讀總帳）。
   */
  paidBy?: "employee" | "company" | undefined;
  items: ExpenseItemInput[];
}

/** FNV-1a 32-bit：把發票號碼壓成 int4 當鎖鍵。要的是穩定與均勻，不是密碼學強度 */
function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0; // int4 是有號的
}

/**
 * advisory lock 的命名空間（pg_advisory_xact_lock 的 key1）。整個資料庫共用一個鎖鍵空間，
 * 各子系統各佔一個命名空間才不會互撞（撞到不會算錯，只是白等一下）。
 * 由字串導出而不是寫一個魔術數字：讀的人不必去記某個常數當初代表什麼。
 */
const INVOICE_LOCK_NAMESPACE = fnv1a32("invoice_number");

/**
 * R5 查重的**序列化點**。`assertInvoiceNotClaimed` 是交易內的 read-then-write：
 * READ COMMITTED 下兩個並行請求各自讀到「這張發票還沒人報」，兩邊都插入成功——
 * 同一張進項發票的稅額進 401 兩次（＝少繳稅），而且兩張單在畫面上看起來都正常。
 *
 * 為什麼是 advisory lock 而不是像 documents.ts 那樣鎖一列：這個不變量的錨點是
 * 「發票號碼」這個**還不存在的東西**（要擋的正是它被插入第二次），沒有天然的列可鎖；
 * 而且它橫跨 purchases 與 expense_items 兩張表，鎖任何一張表的列都只擋得住一半。
 *
 * 為什麼不改用 DB 唯一約束當最後防線：`assertInvoiceNotClaimed` 的放行條件
 * （rejected／已作廢的單不算數、兩邊賣方統編都有值且不同就放行、跨兩張表比對）
 * 沒有一條是 unique index 表達得出來的——status 與 voided_at 在父表 expense_claims 上，
 * 索引也看不到另一張表。硬做一個索引會擋掉「作廢重開沿用同號」這種正常出路，
 * 比現在這個併發窗口更糟（見本次回報的 openIssues）。
 *
 * 取鎖順序統一由小到大（與 documents.ts 的 lockProducts 同一條紀律）：同一張單有多個號碼時
 * 順序一致，兩個交易才不會各持一半互相等待成死鎖。
 *
 * ⚠️ 誠實講：PGlite 只有單一連線，測試看不出併發（與 returns.ts 的 FOR UPDATE 同樣的處境）。
 *    測得到的是「鎖有沒有取、取了幾個」，不是「並行時擋不擋得住」。
 */
export async function lockInvoiceNumbers(tx: Db, invoiceNumbers: (string | null | undefined)[]): Promise<void> {
  const keys = [...new Set(invoiceNumbers.filter((n): n is string => !!n))].sort();
  for (const invoiceNumber of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock(${INVOICE_LOCK_NAMESPACE}::int4, ${fnv1a32(invoiceNumber)}::int4)`);
  }
}

/**
 * R5（報銷側）：同一張進項發票只能在系統裡列報一次——purchases 與 expense_items
 * 兩條路都會把進項稅算進 401 扣抵，同號碼登兩次＝進項稅重複列報（少繳稅，被查到補稅加罰）。
 * 放行的例外（照 0029 進貨側的模式）：
 * - 已作廢進貨單／已退回（rejected）／已作廢（0036 voided_at）的報銷單不算數——
 *   作廢重開沿用同號是正常出路；
 * - 兩邊賣方統編**都有值且不同**：發票號碼跨期會重用，不同賣方撞號是現實，不能擋。
 *   任一邊沒填統編就無從分辨，一律擋下並指路「確為不同賣方請補上賣方統編」——
 *   寧可多按一次，也不讓重複列報無聲通過。
 * excludeClaimId：退回重送（0036）改的是同一張單，自己既有的明細不算撞號。
 */
async function assertInvoiceNotClaimed(
  tx: Db,
  invoiceNumber: string,
  sellerTaxId: string | undefined,
  excludeClaimId?: number,
): Promise<void> {
  // 同號可能已存在多筆（不同賣方的跨期重用是合法的）：要逐筆比對，找到任何一筆
  // 「無法以賣方統編區別」的既有登錄就擋——只看第一筆會漏掉排在後面的真撞號
  const distinguishable = (existing: string | null) => !!sellerTaxId && !!existing && sellerTaxId !== existing;
  const dupItems = await tx
    .select({ claimId: schema.expenseItems.claimId, sellerTaxId: schema.expenseItems.sellerTaxId })
    .from(schema.expenseItems)
    .innerJoin(schema.expenseClaims, eq(schema.expenseItems.claimId, schema.expenseClaims.id))
    .where(
      and(
        eq(schema.expenseItems.invoiceNumber, invoiceNumber),
        ne(schema.expenseClaims.status, "rejected"),
        isNull(schema.expenseClaims.voidedAt),
        excludeClaimId === undefined ? undefined : ne(schema.expenseClaims.id, excludeClaimId),
      ),
    );
  const dupItem = dupItems.find((d) => !distinguishable(d.sellerTaxId));
  if (dupItem) {
    throw new AppError(
      422,
      "發票 {invoiceNumber} 已列報在報銷單 #{claimId}——同一張發票列報兩次會讓進項稅重複扣抵（少繳稅）。請核對號碼；若 #{claimId} 才是登錯的那張，請先退回它。確為不同賣方的同號發票，兩筆都補上賣方統編即可放行",
      { invoiceNumber, claimId: dupItem.claimId },
    );
  }
  const dupPurchases = await tx
    .select({ id: schema.purchases.id, partnerTaxId: schema.partners.taxId })
    .from(schema.purchases)
    .innerJoin(schema.partners, eq(schema.purchases.partnerId, schema.partners.id))
    .where(
      and(
        eq(schema.purchases.invTrack, invoiceNumber.slice(0, 2)),
        eq(schema.purchases.invNo, invoiceNumber.slice(2)),
        isNull(schema.purchases.voidedAt),
      ),
    );
  const dupPurchase = dupPurchases.find((d) => !distinguishable(d.partnerTaxId));
  if (dupPurchase) {
    throw new AppError(
      422,
      "發票 {invoiceNumber} 已登錄在進貨單 #{purchaseId}——同一張發票再走報銷會讓進項稅重複扣抵（少繳稅）。請核對號碼；若 #{purchaseId} 才是登錯的那張，請先修正或作廢它。確為不同賣方的同號發票，報銷明細補上賣方統編即可放行",
      { invoiceNumber, purchaseId: dupPurchase.id },
    );
  }
}

/**
 * 本公司統編（憑證上的買方統編要跟它比）。
 * 回 null 代表公司基本檔還沒填統編——那是「無從判定」，不是「不符」，兩者的處置不同（見 prepareItems）。
 */
async function resolveCompanyTaxId(db: Db): Promise<string | null> {
  const [company] = await db.select({ taxId: schema.companyProfile.taxId }).from(schema.companyProfile);
  // char(8) 取出來可能帶尾隨空白；空字串與未設定是同一件事
  return company?.taxId?.trim() || null;
}

/**
 * 買方統編不是本公司時的說法。建單當下與詳情頁重建都用這一句（措辭只寫一次）。
 * ⚠️ 零斷言：只講結構事實與**系統做了什麼**，不說「依法不可扣抵」，也不評價這張憑證。
 */
function buyerMismatchNote(invoiceNumber: string, buyerTaxId: string | null): string {
  return (
    `發票 ${invoiceNumber} 的 QR 上，買方統編是${buyerTaxId ?? "「未打統編」（規格以全 0 表示）"}，` +
    `與公司基本檔的統編不同——系統不把這筆算進可扣抵的進項稅額（不進 401 的進項），稅額以 0 元落地。` +
    `若這張憑證確實是開給本公司的，請向賣方索取買方統編正確的憑證再報銷`
  );
}

/**
 * 公司基本檔還沒填統編時的說法。買方統編核對（憑證上的買方是不是本公司）拿去比的就是它，
 * 沒有它那道核對從頭到尾沒有執行過——新裝、或還沒填統編的環境，等於這道防線不存在。
 *
 * ⚠️ 不硬擋：擋了，新環境連一張報銷單都送不出去。但**一定要說**——不說的話，
 *    畫面上這些可扣抵的明細與核對過的長得一模一樣，沒有人看得出來差別。
 * ⚠️ 零斷言：只講系統做了什麼（沒有核對、照主張落地），不評價這些憑證能不能扣抵。
 * 措辭寫一次：建單／重送的回應與詳情頁（rebuildTaxNotes）共用同一句。
 */
function companyTaxIdMissingNote(deductibleCount: number, taxTotal: number): string {
  return (
    `公司基本檔還沒填統編，系統無從核對憑證上的買方統編是不是本公司——` +
    `這張單有 ${deductibleCount} 筆明細以可扣抵落地（進項稅額合計 ${taxTotal} 元），` +
    `是照明細上的主張走的，這道核對沒有跑過。請到「公司基本檔」填上統編`
  );
}

/**
 * 日曆上真的存在的日期。zod 的 /^\d{4}-\d{2}-\d{2}$/ 只驗**形狀**：
 * QR 左碼的民國日期 1150230 換算出來的 2026-02-30 形狀完全合格，一路通過四欄交叉核對，
 * 最後才炸在 expense_items.invoice_date 的 date 欄位——使用者拿到 500 internal error，
 * 沒有一個字說得出是哪一筆、哪一欄、哪一天有問題。
 *
 * 用 Date 反算而不是自己查每月天數：閏年規則不必在本專案裡再寫一次。
 * （Date.UTC 把 0–99 的年份映到 1900+，那種年份會落進下面的不相等而被擋下——
 *   對這道檢核來說擋下來就是對的。）
 */
function assertRealDate(date: string | null | undefined, label: string): void {
  if (!date) return;
  const [y, m, d] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(y!, m! - 1, d!));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) {
    throw new AppError(422, "{label}（{date}）不是日曆上存在的日期——請核對月份與日數再送出", { label, date });
  }
}

/** 落地用的明細：qrPayload／taxSource 是**解析過帶入值之後**的結果，不一定等於 input 上的那個 */
type PreparedItem = Omit<ExpenseItemInput, "qrPayload" | "taxSource"> & {
  deductible: boolean;
  tax: number;
  qrPayload: string | null;
  taxSource: "voucher" | "rate" | null;
};

/** 退回重送時從既有明細帶出來的東西（key＝發票號碼，那是明細跨一次重送唯一穩定的身分） */
type CarriedItem = { qrPayload: string | null; taxSource: "voucher" | "rate" | null };

/**
 * 明細的驗證與稅額落地（建單與退回重送共用——兩條路少一條檢查，R5 的查重就有洞可鑽）。
 * excludeClaimId：重送時排除自己既有的明細。
 * carryOver：重送時沿用的 QR 原文與稅額來源（見 resubmitClaim）。
 *
 * 需要使用者回答的衝突**一次收齊再回報**：一張單有 N 筆要確認時逐筆 throw
 * 等於逼使用者按 N 次送出，每按一次只換到下一個問題。
 */
async function prepareItems(
  tx: Db,
  claimDate: string,
  inputs: ExpenseItemInput[],
  excludeClaimId?: number,
  carryOver?: Map<string, CarriedItem>,
): Promise<{ items: PreparedItem[]; notes: string[] }> {
  const notes: string[] = [];
  const items: PreparedItem[] = [];
  // 要使用者確認的衝突：收集完整批再一起回報（訊息指得出第幾筆／哪張發票）
  /**
   * 擋下整批的衝突。text 給人看（會依語言翻譯的是外層那句抬頭，這裡的句子目前仍是中文組的）；
   * detail 給前端分岔流程用（哪一筆、什麼事、數字各是多少）——前端**不得**解析 text。
   */
  const conflicts: Array<{ text: string; detail: ExpenseConflictDetail }> = [];
  // 一張報銷單裡本公司統編不會變，撈一次就好
  const companyTaxId = await resolveCompanyTaxId(tx);
  // 同一張報銷單內的重號也要擋（四筆同號＝50 元的進項稅被算成 200，gap R5 實測過）
  const seenInvoiceNumbers = new Set<string>();
  // 查重是 read-then-write：先把這張單用到的號碼一次全鎖起來（順序固定，見 lockInvoiceNumbers）
  await lockInvoiceNumbers(tx, inputs.map((i) => i.invoiceNumber));
  for (const [index, item] of inputs.entries()) {
    const at = `第 ${index + 1} 筆明細`;
    const category = CATEGORY_BY_CODE.get(item.accountCode);
    if (!category) throw new AppError(422, "報銷分類不存在: {code}", { code: item.accountCode });
    // 可扣抵性以**報銷單日期**解析生效期間（單據的歸屬日期就是它，核准傳票也記在這一天）
    const rule = await resolveDeductible(tx, item.accountCode, claimDate, category.inputTaxDeductible);
    // 硬規則：可扣抵需為電子發票＋發票號碼/賣方統編齊全＋分類允許；前端未主張（統編未打公司）也不扣。
    // ★ 這裡的 true 還會被下面**伺服端自己判定的買方統編核對**收回去（有 QR 解得出來時）——
    //   少了那一道，可扣抵與否 100% 由 client 說了算，QR 上明寫著別家公司也照樣扣得到。
    //   ⚠️ 殘餘（誠實講）：**沒有 qrPayload 的明細**（手動填、只拍到右碼）伺服端沒有東西可核對，
    //      那條路上「買方是不是本公司」仍然是使用者的主張。這一包收掉的是「QR 上明明寫著、
    //      伺服端卻沒看」的那一段，不是把主張整個換成驗證。
    let deductible =
      (item.deductible ?? false) &&
      item.docType === "einvoice" &&
      !!item.invoiceNumber &&
      !!item.sellerTaxId &&
      rule.deductible;
    if (item.invoiceNumber && !/^[A-Z]{2}\d{8}$/.test(item.invoiceNumber)) {
      throw new AppError(422, "發票號碼格式錯誤: {invoiceNumber}", { invoiceNumber: item.invoiceNumber });
    }
    // invoice_date 是 date 欄位，收不了日曆上不存在的日期；擋在這裡才講得出是哪一筆哪一欄
    assertRealDate(item.invoiceDate, `${at}的發票日期`);
    /**
     * 離譜的未來發票日（年份打錯）也要擋，理由與報銷單日期**不同**：
     * 費用傳票以報銷單日期入帳，可扣抵明細卻以**發票日期**進 401（services/vat.ts 依 invoice_date 歸期）。
     * 2062 年的發票日會讓 1288 進項稅額借在總帳裡，卻永遠不落在任何一期 401 的取數區間——
     * 總帳與 401 從此分歧，而且沒有任何徵兆。門檻與 claimDate 共用同一道檢核
     *（過去日期照樣不擋：補報上季的費用是正常作業）。
     */
    assertNotFarFuture(item.invoiceDate, `${at}的發票日期`);
    if (item.invoiceNumber) {
      if (seenInvoiceNumbers.has(item.invoiceNumber)) {
        throw new AppError(
          422,
          "發票 {invoiceNumber} 在同一張報銷單裡出現兩次——同一張發票只能列報一次，請刪掉重複的那筆",
          { invoiceNumber: item.invoiceNumber },
        );
      }
      seenInvoiceNumbers.add(item.invoiceNumber);
      // R5：查 purchases 與 expense_items 兩邊的既有號碼（進項稅重複列報的另一半）
      await assertInvoiceNotClaimed(tx, item.invoiceNumber, item.sellerTaxId, excludeClaimId);
    }
    /**
     * 重送時沿用既有明細的 QR 原文與稅額來源：不沿用的話，明細被整批刪掉重建之後
     * 使用者原本選的來源會無聲換回費率回推（＝系統替他做了一個他不知道的決定）。
     *
     * ★ **undefined 與 null 要分開看**（0048 複核點名）：
     *   undefined＝前端沒送這個欄位（例如只改了描述）→ 沿用上一次的值；
     *   null＝使用者在畫面上把它清掉了 → 就是要清掉，重新問一次。
     *   兩者用 `??` 合併的話，「我不要用憑證那個數字了」這件事永遠傳不進來——
     *   選過 voucher 之後沒有任何路徑收得回來（除非換一個發票號碼，而那是另一張憑證）。
     */
    const carried = item.invoiceNumber ? carryOver?.get(item.invoiceNumber) : undefined;
    const qrPayload = item.qrPayload === undefined ? (carried?.qrPayload ?? null) : item.qrPayload;
    const requestedSource = item.taxSource === undefined ? (carried?.taxSource ?? null) : item.taxSource;
    /**
     * 憑證所載的銷售額（未稅）——**由伺服端從 QR 原文解析**，前端說什麼都不算數。
     * undefined 代表這筆沒有第二個稅額來源可比（沒掃到 QR、解不出來、或不可扣抵）。
     */
    let voucherSalesAmount: number | undefined;
    if (deductible && item.invoiceNumber && qrPayload) {
      const qr = parseEInvoiceLeftQr(qrPayload);
      // 解不出來就當作沒掃到 QR，**不報錯**：使用者可能拍到的根本不是電子發票證明聯
      // （右碼、店家自己的付款 QR、糊掉的圖）。那不是錯誤，只是少了一個可比的來源。
      if (qr) {
        /**
         * QR 上的民國日期**本身**可能是日曆上不存在的一天（1150230）。解析只做民國→西元的換算、
         * 不做曆法檢核，那個日期會原封不動拿去與明細比對，比中了就往 date 欄位落地 → 500。
         * 擋在這裡，訊息指的是**憑證上那一欄**：使用者是照著掃到的東西填的，該去看的是那張照片。
         *（明細自己填的發票日期在上面已經驗過；兩者相等時是那一道先擋下。）
         */
        assertRealDate(qr.invoiceDate, `${at}：掃到的 QR 上的開立日期`);
        /**
         * 交叉核對：解析出來的四個欄位必須與這筆明細送上來的欄位相符。
         * 這道檢查才是「稅額來自這張憑證」的定義——少了它，QR 只是一串可以隨便挑的數字，
         * 貼一張別張發票的 QR 就能把它的銷售額安到這筆金額上。
         * 不符多半是掃完 QR 又手改了欄位，所以指路是「重新上傳這張憑證的照片」。
         */
        const mismatches: string[] = [];
        const check = (label: string, fromQr: string | number, filled: string | number | undefined) => {
          if (fromQr !== filled) mismatches.push(`${label}（QR 是 ${fromQr}、這筆填的是 ${filled ?? "空白"}）`);
        };
        check("發票號碼", qr.invoiceNumber, item.invoiceNumber);
        check("發票日期", qr.invoiceDate, item.invoiceDate);
        check("賣方統編", qr.sellerTaxId, item.sellerTaxId);
        check("總計額", qr.totalAmount, item.amount);
        if (mismatches.length > 0) {
          conflicts.push({
            text:
              `${at}：掃到的發票 QR 與這筆填的內容對不起來——${mismatches.join("、")}。` +
              `進項稅額是從這張憑證導出來的，欄位對不起來就不能算：請重新上傳這張憑證的照片（掃完 QR 之後又改過欄位嗎？）`,
            detail: { kind: "qr_mismatch", lineIndex: index },
          });
        } else {
          /**
           * 第五欄：買方統編。這是**可扣抵性**的伺服端判定（與上面的硬規則同一個形狀）——
           * 前端送的 `deductible: true` 只是「主張」，QR 上明白寫著買方是誰時，
           * 該由伺服端自己看，而不是照著主張走。
           * 未打統編的憑證解出來是 null（規格以全 0 表示），一樣不是本公司。
           * 公司基本檔沒有統編時是「無從判定」，不是「不符」：那時不改動主張，但要出聲說清楚，
           * 否則使用者會以為系統核對過了。那句話在迴圈外以整張單為單位講一次（見下方）。
           */
          if (companyTaxId !== null && qr.buyerTaxId !== companyTaxId) {
            deductible = false;
            notes.push(buyerMismatchNote(item.invoiceNumber, qr.buyerTaxId));
          }
          if (deductible) {
            if (qr.salesAmount > qr.totalAmount) {
              // QR 自己的兩個欄位就對不起來。放行的話「總額 − 銷售額」是負數，
              // 一筆負的進項稅會一路無聲進 401，沒有任何畫面看得出來
              conflicts.push({
                text:
                  `${at}：發票 ${item.invoiceNumber} 的 QR 上，銷售額 ${qr.salesAmount} 元大於總計額 ${qr.totalAmount} 元——` +
                  `這張 QR 自己的兩個欄位對不起來，系統不敢從它導出進項稅額。請重新上傳這張憑證的照片`,
                detail: { kind: "qr_mismatch", lineIndex: index },
              });
            } else {
              voucherSalesAmount = qr.salesAmount;
            }
          }
        }
      }
    }
    // 內含稅回推的費率以**發票日期**解析（沒填發票日就退回報銷單日期）：
    // 那張發票上的稅是開立當天的費率算出來的，用今天的費率回推會回推出錯的未稅額。
    // ⚠️ 稅額在這裡就落地到 expense_items.tax，補設參數**不會回頭重算已建立的報銷單**。
    // 位置在買方統編核對**之後**：那道核對可能把 deductible 收成 false，
    // 先解析會為一筆根本沒有稅額的明細吐出一則費率設定的警告
    const vat = await resolveVatRate(tx, item.invoiceDate ?? claimDate);
    if (deductible && vat.fallback) notes.push(...vat.notes);
    const rateTax = deductible ? item.amount - roundHalfUp(item.amount / (1 + vat.rate)) : 0;
    let tax = rateTax;
    /** 落地的稅額**實際上**出自哪一個來源（不是使用者送了什麼）；語意見下方 items.push 前的註解 */
    let landedSource: "voucher" | "rate" | null = null;
    /**
     * 回退費率的加註：**原樣帶 resolveVatRate 自己的診斷**，不要改寫成一句概括的話。
     *
     * vat.fallback 有三種成因（找不到涵蓋該日的列／那一列沒有級距內容／那一列不是單一費率），
     * 後兩種的使用者**其實設定過而且涵蓋該日**——寫成「你還沒設定涵蓋 X 的營業稅率」
     * 是螢幕上的一句假話，還把人指向錯的修法（去新增一列，但問題在既有那一列的內容）。
     * 422 那條路尤其嚴重：AppError 只帶一個字串，不接上去診斷就整個掉了。
     * 落地那條路不必再接一次——上面的 notes.push(...vat.notes) 已經把同一句話帶到同一個地方。
     */
    const fallbackNote = vat.fallback ? `（注意：${vat.notes.join(" ")}）` : "";
    /**
     * 稅額的兩個來源（W2）。費率回推一直都在，但它是**系統依使用者設定的費率算出來的**；
     * 電子發票 QR 左碼另外載了一個銷售額（未稅），總額減掉它就是憑證自己載明的稅額。
     * 兩個數字可能不一樣——差 1 元的捨入殘差，或整筆差一個級距；
     * 而其中一個會被寫進 expense_items.tax、進 401 的進項。
     *
     * 不一致時擋下要人指定，而不是靜默選一個：這條路的既有紀律是
     * 「走了回退費率而不說，等於系統替使用者做了一個他不知道的決定」（見 createClaim 的註解）。
     * 哪個數字進 401 是使用者的責任，系統看得出兩者不同就必須說出來。
     *
     * 一致時**完全不出聲**：絕大多數憑證會落在這裡，多一句話等於把噪音餵給每一個人。
     *
     * ⚠️ 這裡完全沒有判斷「這筆交易該不該課稅、該課多少」——那是使用者的判斷。
     *    voucherTax 純粹是憑證自己兩個結構化欄位相減的結果（可機讀不等於已驗真：
     *    QR 的加密驗證區本系統從未驗證）。
     *
     * ★ **殘餘風險（誠實講）**：交叉核對之後，稅額仍不是「已驗真」的數字——
     *    沒有人驗過那 24 碼加密驗證區，自己印一張欄位齊全的紙照樣解得出來。
     *    這一包買到的是：稅額**從被宣稱的那張憑證導出**，與 invoiceNumber／amount
     *    同一個信任層級——而那兩者已經有查重（assertInvoiceNotClaimed）與稽核留痕。
     *    要偽造就得偽造一張整體一致、且號碼沒被別人用過的發票，不再是「隨手填個數字」。
     *    ——而「整體一致的偽造」正是下面那道單向上限要收的殘餘：偽得出來也只能把稅額
     *    往**小**的方向拉，拉不過使用者自己設定的費率所隱含的上限。
     */
    /**
     * ★ **單向上限**（0048 安全複核第二次點名的繞法）：voucherTax > rateTax 時不接受 'voucher'。
     *
     * 繞法長這樣：自己拼一段 77 碼、四個欄位都與明細對得起來、**銷售額填 0** 的左碼字串，
     * 配 taxSource:'voucher'，稅額就落地成全額（實測 amount 10000 → tax 10000、
     * 核准後 1288 進項稅額 debit 10000、401 的進項稅額 10000，而且一般 employee 角色就做得到）。
     * 交叉核對擋得住「貼別張發票的 QR」，擋不住「整張自己編一致的」——
     * 而伺服端明明同時握著 rateTax 與 voucherTax，卻對「憑證稅額＝總額的 100%」沒有任何上限。
     *
     * 為什麼**只擋這一個方向**：
     * - voucherTax < rateTax（憑證自己說的稅比費率回推少）正是這條路存在的理由，必須保留；
     * - voucherTax > rateTax 是唯一能把 401 的進項灌大的方向。系統不讓一個掃進來的數字
     *   超過**使用者自己的參數**所隱含的上限——這是使用者對自己設定的責任邊界，不是稅法判斷。
     * - 這樣**不需要任何門檻值**（沒有容差、沒有百分比）：捨入向上造成的 1 元差會落到 rateTax，
     *   方向永遠保守，也不擋死流程。
     *
     * 這個方向不再問「你要用哪一個」：voucher 不是可選項時還問，是把人推進一條沒有出口的迴圈。
     */
    // deductible 的硬規則已保證 invoiceNumber 非空，這裡一起判是為了訊息指得出是哪一張發票
    if (deductible && item.invoiceNumber && voucherSalesAmount !== undefined) {
      const voucherTax = item.amount - voucherSalesAmount;
      if (voucherTax > rateTax) {
        // ⚠️ 零斷言：只講**結構事實**（哪個數字超過哪個數字、系統採用了哪一個），
        //    不說「稅率應該是多少」，也不說這張憑證合不合法
        notes.push(
          `發票 ${item.invoiceNumber} 的憑證所載稅額 ${voucherTax} 元` +
            `（總額 ${item.amount} − 憑證上的銷售額 ${voucherSalesAmount}），` +
            `超過依你設定的營業稅率回推的 ${rateTax} 元。` +
            `系統不採用超出你自己參數所隱含的數字，這筆以 ${rateTax} 元落地。` +
            `若你認為憑證上的數字是對的，請先檢查「稅法參數」頁的營業稅率設定。` +
            fallbackNote,
        );
        // 使用者若明確選了 'rate'，落地的就是他選的那個；選 'voucher' 的沒有落地，不記成他的選擇
        landedSource = requestedSource === "rate" ? "rate" : null;
      } else if (voucherTax !== rateTax) {
        if (!requestedSource) {
          // 兩個數字給前端做按鈕用的是 detail（結構化），訊息文字可以自由改、也會被翻譯
          conflicts.push({
            detail: { kind: "tax_source_conflict", lineIndex: index, invoiceNumber: item.invoiceNumber, voucherTax, rateTax },
            text:
              `${at}：發票 ${item.invoiceNumber} 的進項稅額有兩個來源、算出來的數字不一樣：` +
              `憑證所載的銷售額回推＝${voucherTax} 元（總額 ${item.amount} − 憑證上的銷售額 ${voucherSalesAmount}）；` +
              `你設定的稅率回推＝${rateTax} 元（總額 ${item.amount} − 依你在「稅法參數」頁設定的營業稅率換算出的未稅額）。` +
              fallbackNote +
              `哪一個數字進 401 是你的判斷，系統不替你選：請指定這筆明細要用哪一個來源，再送出一次`,
          });
        } else {
          const chosen = requestedSource === "voucher" ? voucherTax : rateTax;
          const other = requestedSource === "voucher" ? rateTax : voucherTax;
          // 出聲管道沿用 taxNotes（與費率回退同一條）：使用者做過的選擇要在畫面上留下痕跡，
          // 否則「這張單的稅額為什麼是這個數字」下個月就沒人答得出來
          notes.push(
            `發票 ${item.invoiceNumber} 的進項稅額兩個來源不一致：憑證所載的銷售額回推＝${voucherTax} 元、` +
              `你設定的稅率回推＝${rateTax} 元。已依你指定的` +
              `「${requestedSource === "voucher" ? "憑證所載的銷售額回推" : "你設定的稅率回推"}」落地 ${chosen} 元，` +
              `另一個（未採用）是 ${other} 元。`,
          );
          tax = chosen;
          landedSource = requestedSource;
        }
      } else {
        // 兩個來源相等：不出聲（絕大多數憑證落在這裡），但使用者選過的話那個選擇確實成立
        landedSource = requestedSource;
      }
    }
    /**
     * tax_source 記的是**這個稅額出自哪一個來源**，不是「使用者按過哪個鈕」——
     * 詳情頁靠它重建說明（rebuildTaxNotes），寫錯就是螢幕上的一句假話。
     * 因此：沒有憑證來源可比時是 null；被上限擋下時使用者選的 'voucher' 沒有落地，
     * 也不能記成他的選擇（記 null 之後，下一次重送——例如他改好了稅率設定——會重新問一次，
     * 而不是沿用一個他其實沒得到的答案）。
     */
    items.push({
      ...item,
      deductible,
      tax,
      qrPayload,
      taxSource: landedSource,
    });
  }
  /**
   * 公司統編沒填時的出聲，放在迴圈外、以**整張單**為單位講一次。
   * - 為什麼不逐筆講：統編是公司層級的設定，逐筆會把同一句話複製 N 遍。
   * - 為什麼條件是「落地成可扣抵的明細」而不是「解得出 QR 的明細」：沒掃 QR 的明細
   *   一樣沒被核對過，而使用者要知道的是「這張單有進項稅額落地，而那道核對沒跑過」。
   * - 為什麼放在 conflicts 之前不重要：有 conflicts 就整批擋下、什麼都沒落地。
   */
  const unverified = items.filter((i) => i.deductible);
  if (companyTaxId === null && unverified.length > 0) {
    notes.push(companyTaxIdMissingNote(unverified.length, unverified.reduce((s, i) => s + i.tax, 0)));
  }
  if (conflicts.length > 0) {
    // 多筆才加抬頭：單筆時多一行「共 1 筆」只是噪音，訊息本身已經指出是第幾筆
    throw new AppError(
      422,
      conflicts.length === 1
        ? conflicts[0]!.text
        : "這張報銷單有 {n} 筆明細要你確認（一次列出，不必來回送）：\n{list}",
      { n: conflicts.length, list: conflicts.map((c) => c.text).join("\n") },
      { code: "EXPENSE_CONFLICT", details: conflicts.map((c) => c.detail) },
    );
  }
  return { items, notes };
}

function toItemRows(claimId: number, items: PreparedItem[]) {
  return items.map((i) => ({
    claimId,
    accountCode: i.accountCode,
    description: i.description ?? "",
    docType: i.docType,
    amount: i.amount,
    tax: i.tax,
    deductible: i.deductible,
    invoiceNumber: i.invoiceNumber ?? null,
    invoiceDate: i.invoiceDate ?? null,
    sellerTaxId: i.sellerTaxId ?? null,
    image: i.image ?? null,
    // 稅額若來自憑證，這串原文就是它唯一的出處；重送時伺服端拿它重新推導（0048）
    qrPayload: i.qrPayload,
    taxSource: i.taxSource,
  }));
}

export async function createClaim(db: Db, input: ClaimInput) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來報銷單當場擋下（過去日期不擋——補報上季的費用是正常作業）
    // claim_date 也是 date 欄位：2026-02-30 這種形狀合格、日曆上不存在的日期會炸成 500
    assertRealDate(input.claimDate, "報銷單日期");
    assertNotFarFuture(input.claimDate, "報銷單日期");
    const [employee] = await tx.select().from(schema.employees).where(eq(schema.employees.id, input.employeeId));
    if (!employee) throw new AppError(404, "員工不存在: {id}", { id: input.employeeId });
    if (!employee.active) throw new AppError(422, "員工已停用: {name}", { name: employee.name });

    const { items, notes } = await prepareItems(tx, input.claimDate, input.items);
    const total = items.reduce((s, i) => s + i.amount, 0);

    const [claim] = await tx
      .insert(schema.expenseClaims)
      .values({
        employeeId: input.employeeId,
        claimDate: input.claimDate,
        memo: input.memo ?? "",
        total,
        paidBy: input.paidBy ?? "employee",
      })
      .returning();
    await tx.insert(schema.expenseItems).values(toItemRows(claim!.id, items));
    // 走了回退費率而不說，等於系統替使用者做了一個他不知道的決定（去重：多筆明細會湊出同一句話）
    return { ...claim!, taxNotes: [...new Set(notes)] };
  });
}

/**
 * 退回重送（R11）：rejected 的單可以改明細後回 submitted——原本 rejected 是終點狀態，
 * 重建要重打全部明細**並重新上傳同一張收據照片**。就地改而不是另開新單，
 * 是因為 rejected 的單沒有任何帳務足跡（沒拋轉過傳票、不進 401），
 * 「更正＝作廢＋重開」的紀律管的是有足跡的單據。
 * 明細整批換掉（刪舊插新）：報銷單的明細是一體送審的，逐筆 diff 只會多出
 * 「改了金額但沒改稅額」這類半套狀態。
 */
export async function resubmitClaim(db: Db, claimId: number, input: Omit<ClaimInput, "employeeId">) {
  return db.transaction(async (tx) => {
    const claim = await requireClaim(tx, claimId);
    if (claim.status !== "rejected") {
      throw new AppError(
        409,
        "報銷單狀態不可修改重送: {status}（只有被退回的單可以改；已核准的單要更正請用作廢，送審中的請先請財務退回）",
        { status: claim.status },
      );
    }
    // claim_date 也是 date 欄位：2026-02-30 這種形狀合格、日曆上不存在的日期會炸成 500
    assertRealDate(input.claimDate, "報銷單日期");
    assertNotFarFuture(input.claimDate, "報銷單日期");
    /**
     * 明細整批刪掉重建，但 QR 原文與使用者選過的稅額來源要跟著同一張發票走（0048）。
     * 沒有這一段，重送會把稅額無聲換回費率回推——使用者上一次被問過、也答過的那個問題，
     * 系統自己改掉了答案還不說。以發票號碼為 key：那是明細跨一次重建唯一穩定的身分
     *（明細 id 會換、順序可以改、金額可以改）。
     * input 上有值時以 input 為準——使用者重新掃了一張 QR 或改了選擇，那就是新的事實。
     */
    const existing = await tx
      .select({
        invoiceNumber: schema.expenseItems.invoiceNumber,
        qrPayload: schema.expenseItems.qrPayload,
        taxSource: schema.expenseItems.taxSource,
      })
      .from(schema.expenseItems)
      .where(eq(schema.expenseItems.claimId, claimId));
    const carryOver = new Map<string, CarriedItem>();
    for (const row of existing) {
      if (!row.invoiceNumber) continue;
      carryOver.set(row.invoiceNumber, {
        qrPayload: row.qrPayload,
        // DB 是 text（見 0048 檔頭），值域在這裡收斂回型別；認不得的值一律當作沒選過
        taxSource: row.taxSource === "voucher" || row.taxSource === "rate" ? row.taxSource : null,
      });
    }
    const { items, notes } = await prepareItems(tx, input.claimDate, input.items, claimId, carryOver);
    const total = items.reduce((s, i) => s + i.amount, 0);

    await tx.delete(schema.expenseItems).where(eq(schema.expenseItems.claimId, claimId));
    await tx.insert(schema.expenseItems).values(toItemRows(claimId, items));
    const [updated] = await tx
      .update(schema.expenseClaims)
      .set({
        claimDate: input.claimDate,
        memo: input.memo ?? "",
        total,
        paidBy: input.paidBy ?? claim.paidBy,
        status: "submitted",
        rejectReason: null,
      })
      .where(eq(schema.expenseClaims.id, claimId))
      .returning();
    return { ...updated!, taxNotes: [...new Set(notes)] };
  });
}

async function requireClaim(tx: Db, id: number) {
  const [claim] = await tx.select().from(schema.expenseClaims).where(eq(schema.expenseClaims.id, id));
  if (!claim) throw new AppError(404, "報銷單不存在: {id}", { id });
  return claim;
}

async function accountIdByCode(tx: Db): Promise<Map<string, { id: number; name: string; active: boolean }>> {
  const rows = await tx.select().from(schema.accounts);
  return new Map(rows.map((r) => [r.code, { id: r.id, name: r.name, active: r.active }]));
}

/**
 * 自我核准／自我退回的把關（R11）：審核的意義是「另一雙眼睛」，approve 端點原本
 * 連登入者都沒取，財務送單→核准→付款三個動作可以同一個 session 完成，零阻擋。
 * admin 例外放行（gap 建議的第二選項）：一人公司裡老闆本來就是自己核自己，
 * 擋死等於逼他建第二個帳號；admin 的每一次核准都在 audit_logs 與 approved_by 留痕。
 */
function assertNotSelf(user: AuthUser, claimEmployeeId: number, action: string): void {
  if (user.role !== "admin" && user.employeeId !== null && user.employeeId === claimEmployeeId) {
    throw new AppError(
      409,
      "不能{action}自己送的報銷單——請由其他財務或管理者審核（審核的意義是另一雙眼睛）",
      { action },
    );
  }
}

/**
 * 核准：借 各費用科目（未稅）＋進項稅額；貸 其他應付款（總額）。
 * paid_by='company'（R13）時貸的是**付款科目**（現金科目或公司卡負債科目，核准時指定），
 * 狀態直接進 paid——錢是公司出的，沒有「欠員工」這一段。
 */
export async function approveClaim(db: Db, claimId: number, approver: AuthUser, companyAccountId?: number) {
  return db.transaction(async (tx) => {
    const claim = await requireClaim(tx, claimId);
    if (claim.status !== "submitted") throw new AppError(409, "報銷單狀態不可核准: {status}", { status: claim.status });
    assertNotSelf(approver, claim.employeeId, "核准");
    const items = await tx.select().from(schema.expenseItems).where(eq(schema.expenseItems.claimId, claimId));
    // 費用傳票以單據日入帳，可扣抵明細卻以發票日進 401——兩個日期都要檢查關帳
    //（與作廢端共用同一份實作，見 period.ts；只鎖單據日會讓進項稅無聲加進已申報的期間）
    await assertClaimPeriodsOpen(tx, claim, items);
    const [employee] = await tx.select().from(schema.employees).where(eq(schema.employees.id, claim.employeeId));

    const codeToId = await accountIdByCode(tx);
    const need = (code: string) => {
      const account = codeToId.get(code);
      if (!account) throw new AppError(500, "科目未初始化: {code}", { code });
      // 與手工傳票／收付款單／報銷付款同一條規則：停用的科目不得再過帳。
      // 報銷單可能在送出後、核准前才被停用該費用科目（會計整理科目表的正常操作），
      // 少了這道檢查，核准會照樣把分錄寫進已停用的科目，等於「停用」只是把下拉選單藏起來
      if (!account.active) {
        throw new AppError(400, "科目已停用，不可再過帳: {code} {name}（請改用其他科目，或先啟用它）", { code, name: account.name });
      }
      return account.id;
    };
    // 公司支付的貸方科目：現金科目（isCash，公司帳戶轉帳/現金）或負債科目（公司信用卡的
    // 應付卡費）。信用卡本來就建不成現金科目（isCash 只准資產類，這是對的——卡費不是現金），
    // 所以這裡必須放行負債類，否則公司卡這條路等於沒開。
    let creditAccountId: number;
    if (claim.paidBy === "company") {
      if (!companyAccountId) {
        throw new AppError(
          422,
          "報銷單 #{id} 是公司支付（公司卡／公司帳戶），核准時請指定付款科目（現金科目，或公司卡的負債科目）",
          { id: claimId },
        );
      }
      const rows = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, companyAccountId));
      const acct = rows[0];
      if (!acct) throw new AppError(404, "科目不存在: {id}", { id: companyAccountId });
      if (!acct.active) throw new AppError(400, "科目已停用，不可再過帳: {code} {name}", { code: acct.code, name: acct.name });
      if (!acct.isCash && acct.type !== "liability") {
        throw new AppError(
          422,
          "{code} {name} 不能當公司支付的付款科目——請選現金科目（公司帳戶）或負債科目（公司信用卡的應付卡費）",
          { code: acct.code, name: acct.name },
        );
      }
      creditAccountId = acct.id;
    } else {
      creditAccountId = need(ACCOUNT.OTHER_PAYABLE);
    }

    const byAccount = new Map<string, number>();
    let taxTotal = 0;
    for (const i of items) {
      byAccount.set(i.accountCode, (byAccount.get(i.accountCode) ?? 0) + (i.amount - i.tax));
      taxTotal += i.tax;
    }
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({
        entryDate: claim.claimDate,
        memo: `報銷單 #${claimId} - ${employee?.name ?? ""}${claim.paidBy === "company" ? "（公司支付）" : ""}`,
        sourceType: "expense",
        sourceId: claimId,
      })
      .returning();
    const lines = [
      ...[...byAccount.entries()].map(([code, net]) => ({
        entryId: entry!.id,
        accountId: need(code),
        debit: net,
        credit: 0,
      })),
      ...(taxTotal > 0 ? [{ entryId: entry!.id, accountId: need(ACCOUNT.INPUT_TAX), debit: taxTotal, credit: 0 }] : []),
      { entryId: entry!.id, accountId: creditAccountId, debit: 0, credit: claim.total },
    ];
    await tx.insert(schema.journalLines).values(lines);
    const [updated] = await tx
      .update(schema.expenseClaims)
      .set({
        // 公司支付：同一張傳票就是付款的全部（貸的直接是付款科目），
        // paidJournalEntryId 指向同一張——「這單付掉了沒、憑哪張傳票」兩個問題都答得出來
        ...(claim.paidBy === "company"
          ? { status: "paid" as const, journalEntryId: entry!.id, paidJournalEntryId: entry!.id }
          : { status: "approved" as const, journalEntryId: entry!.id }),
        approvedByUserId: approver.id,
        approvedAt: new Date(),
      })
      .where(eq(schema.expenseClaims.id, claimId))
      .returning();
    return updated!;
  });
}

export async function rejectClaim(db: Db, claimId: number, reason: string, rejecter: AuthUser) {
  return db.transaction(async (tx) => {
    const claim = await requireClaim(tx, claimId);
    if (claim.status !== "submitted") throw new AppError(409, "報銷單狀態不可退回: {status}", { status: claim.status });
    assertNotSelf(rejecter, claim.employeeId, "退回");
    const [updated] = await tx
      .update(schema.expenseClaims)
      .set({ status: "rejected", rejectReason: reason })
      .where(eq(schema.expenseClaims.id, claimId))
      .returning();
    return updated!;
  });
}

/** 付款：借 其他應付款；貸 現金/銀行 */
export async function payClaim(db: Db, claimId: number, accountId: number, payDate?: string) {
  return db.transaction(async (tx) => {
    const claim = await requireClaim(tx, claimId);
    if (claim.status !== "approved") throw new AppError(409, "報銷單狀態不可付款: {status}", { status: claim.status });
    // 0036：作廢後 status 保持原值（「它曾被核准」是事實），所以付款要另擋 voided_at——
    // 不擋的話，作廢的單照樣付得出錢，反向傳票只沖了費用、錢卻真的出去了
    if (claim.voidedAt) {
      throw new AppError(409, "報銷單 #{id} 已作廢（理由：{reason}），不可付款", { id: claimId, reason: claim.voidReason ?? "未記錄" });
    }
    // R2：付款日同樣擋「不合理的未來」——payDate 2030 會落進 2030 年度的帳，追都追不到
    // 傳票的 entry_date 也是 date 欄位：日曆上不存在的付款日同樣要在這裡擋成 422，不是 500
    assertRealDate(payDate, "付款日期");
    assertNotFarFuture(payDate, "付款日期");
    await assertPeriodOpen(tx, payDate ?? new Date().toISOString().slice(0, 10));
    const accounts = await tx.select().from(schema.accounts);
    const cash = accounts.find((a) => a.id === accountId);
    if (!cash) throw new AppError(404, "科目不存在: {id}", { id: accountId });
    // 與收付款單同一條規則：必須是現金科目，否則付出去的錢不會進現金流量表（見 ledger.ts createCashDoc）
    if (!cash.isCash) {
      throw new AppError(
        422,
        "{code} {name} 不是現金科目，不能當付款科目（若這是銀行帳戶，請到「會計科目」頁把它勾選為現金科目，付出的錢才會進現金流量表）",
        { code: cash.code, name: cash.name },
      );
    }
    // 與手工傳票／收付款單同一條規則：停用的科目不得再過帳（付款科目由使用者從下拉選，可能是自建的銀行科目）
    if (!cash.active) throw new AppError(400, "科目已停用，不可再過帳: {code} {name}", { code: cash.code, name: cash.name });
    const otherPayableId = accounts.find((a) => a.code === ACCOUNT.OTHER_PAYABLE)!.id;

    const [employee] = await tx.select().from(schema.employees).where(eq(schema.employees.id, claim.employeeId));
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({
        entryDate: payDate ?? new Date().toISOString().slice(0, 10),
        memo: `報銷付款 #${claimId} - ${employee?.name ?? ""}`,
        sourceType: "expense",
        sourceId: claimId,
      })
      .returning();
    await tx.insert(schema.journalLines).values([
      { entryId: entry!.id, accountId: otherPayableId, debit: claim.total, credit: 0 },
      { entryId: entry!.id, accountId, debit: 0, credit: claim.total },
    ]);
    const [updated] = await tx
      .update(schema.expenseClaims)
      .set({ status: "paid", paidJournalEntryId: entry!.id })
      .where(eq(schema.expenseClaims.id, claimId))
      .returning();
    return updated!;
  });
}

/**
 * 清單（不含影像，避免 payload 過大）；影像走 GET /expense-claims/:id。
 * R3 起收 ListFilter（from/to 對報銷單日期＋limit/offset）並回總筆數；
 * 明細只查頁內報銷單（原本整張 expense_items 全撈回來配對）。
 */
export async function listClaims(
  db: Db,
  employeeId: number | undefined,
  f: ListFilter,
  status?: "submitted" | "approved" | "rejected" | "paid",
) {
  const where = and(
    employeeId === undefined ? undefined : eq(schema.expenseClaims.employeeId, employeeId),
    f.from ? gte(schema.expenseClaims.claimDate, f.from) : undefined,
    f.to ? lte(schema.expenseClaims.claimDate, f.to) : undefined,
    // R13：status 篩選（「這個月要發多少報銷款」原本只能全撈下來手動篩）。
    // 篩 approved 時排除已作廢——問這個問題的人要的是「還欠員工的」，不是歷史狀態
    status === undefined ? undefined : eq(schema.expenseClaims.status, status),
    status === "approved" ? isNull(schema.expenseClaims.voidedAt) : undefined,
  );
  const [agg] = await db.select({ total: count() }).from(schema.expenseClaims).where(where);
  const claims = await db
    .select()
    .from(schema.expenseClaims)
    .where(where)
    .orderBy(desc(schema.expenseClaims.id))
    .limit(f.limit)
    .offset(f.offset);
  const claimIds = claims.map((c) => c.id);
  const employees = await db.select().from(schema.employees);
  const items = claimIds.length
    ? await db
        .select({
          id: schema.expenseItems.id,
          claimId: schema.expenseItems.claimId,
          accountCode: schema.expenseItems.accountCode,
          description: schema.expenseItems.description,
          docType: schema.expenseItems.docType,
          amount: schema.expenseItems.amount,
          tax: schema.expenseItems.tax,
          deductible: schema.expenseItems.deductible,
          invoiceNumber: schema.expenseItems.invoiceNumber,
          invoiceDate: schema.expenseItems.invoiceDate,
          sellerTaxId: schema.expenseItems.sellerTaxId,
        })
        .from(schema.expenseItems)
        .where(inArray(schema.expenseItems.claimId, claimIds))
    : [];
  const nameOf = new Map(employees.map((e) => [e.id, e.name]));
  return {
    rows: claims.map((c) => ({
      ...c,
      employeeName: nameOf.get(c.employeeId) ?? `#${c.employeeId}`,
      items: items.filter((i) => i.claimId === c.id),
    })),
    total: agg!.total,
  };
}

/**
 * 詳情頁的稅額說明：從**已落地的欄位**（tax／tax_source／qr_payload）重建，不另存一份文字。
 *
 * 為什麼詳情要有這個：核准的人才是決定這筆進項稅進不進 401 的人，而他看到的只有一個數字。
 * 建單時說過的那兩句（哪兩個來源在競爭、為什麼用了這一個）只回給送單的人，核准者從來沒看過。
 *
 * 為什麼不在這裡重算費率回推：讀取時再依日期解析參數，會讓「之後新增一列參數」
 * 追溯改掉舊單的說明（rateFromSnapshot 的註解記過同型事故：畫面上的數字與帳上的不一致）。
 * 所以這裡只講**存下來的事實**：落地的數字出自哪一個來源，以及憑證自己載明的那個數字。
 */
function rebuildTaxNotes(
  items: {
    invoiceNumber: string | null;
    amount: number;
    tax: number;
    deductible: boolean;
    qrPayload: string | null;
    taxSource: string | null;
  }[],
  companyTaxId: string | null,
): string[] {
  const notes: string[] = [];
  /**
   * 公司統編沒填 → 買方統編核對整條沒跑過。建單時說過的那一句只回給送單的人，
   * **核准的人**看的是這一份——而按下核准就是讓這些進項稅進 401 的那一個動作。
   * 這裡不需要 qr_payload：沒掃 QR 的明細一樣沒被核對過（見 companyTaxIdMissingNote）。
   */
  const unverified = companyTaxId === null ? items.filter((i) => i.deductible) : [];
  if (unverified.length > 0) {
    notes.push(companyTaxIdMissingNote(unverified.length, unverified.reduce((s, i) => s + i.tax, 0)));
  }
  for (const item of items) {
    const qr = item.qrPayload ? parseEInvoiceLeftQr(item.qrPayload) : null;
    if (!qr) continue;
    const invoiceNumber = item.invoiceNumber ?? qr.invoiceNumber;
    if (!item.deductible) {
      // 不可扣抵而憑證買方不是本公司：把伺服端當初收掉這筆扣抵的理由講出來（同一句措辭）
      if (companyTaxId !== null && qr.buyerTaxId !== companyTaxId) {
        notes.push(buyerMismatchNote(invoiceNumber, qr.buyerTaxId));
      }
      continue;
    }
    if (item.taxSource === "voucher") {
      notes.push(
        `發票 ${invoiceNumber} 的進項稅額 ${item.tax} 元出自憑證所載的銷售額回推` +
          `（總額 ${item.amount} − 憑證上的銷售額 ${qr.salesAmount}）。` +
          `依營業稅率回推的那個數字沒有隨單存下來，這裡不重算——重算會跟著之後改過的稅率參數跑，` +
          `就不是當初入帳的那個數字了`,
      );
      continue;
    }
    // tax_source 不是 'voucher'（明確選了費率回推、或憑證那個數字沒有落地）：
    // 落地的就是費率回推值，而憑證自己載明的那個數字解得出來——兩個競爭的數字這裡都看得到
    const voucherTax = item.amount - qr.salesAmount;
    if (voucherTax !== item.tax) {
      notes.push(
        `發票 ${invoiceNumber} 的進項稅額 ${item.tax} 元出自依營業稅率回推；` +
          `這張憑證自己載明的銷售額回推是 ${voucherTax} 元（未採用）`,
      );
    }
  }
  return [...new Set(notes)];
}

export async function getClaim(db: Db, id: number) {
  const claim = await requireClaim(db, id);
  const items = await db.select().from(schema.expenseItems).where(eq(schema.expenseItems.claimId, id));
  const [employee] = await db.select().from(schema.employees).where(eq(schema.employees.id, claim.employeeId));
  return {
    ...claim,
    employeeName: employee?.name ?? `#${claim.employeeId}`,
    items,
    // 建單時的 taxNotes 只回給送單的人；核准者看的是這一份（同樣的事實，從落地欄位重建）
    taxNotes: rebuildTaxNotes(items, await resolveCompanyTaxId(db)),
  };
}

/**
 * R13：「公司欠員工多少」——approved 未付、未作廢的報銷單依員工彙總。
 * 之前唯一的查法是 /reports/ledger?accountCode=2201 的期末餘額，但那條路不乾淨：
 * posting.ts 的銷貨退回分錄也貸 2201，會混入應付客戶的退款。
 * （公司支付的單核准即 paid，天然不會出現在這裡——欠的是公司卡帳單，不是員工。）
 */
export async function payableSummary(db: Db) {
  const rows = await db
    .select({
      employeeId: schema.expenseClaims.employeeId,
      employeeName: schema.employees.name,
      count: count(),
      amount: sum(schema.expenseClaims.total).mapWith(Number),
    })
    .from(schema.expenseClaims)
    .innerJoin(schema.employees, eq(schema.expenseClaims.employeeId, schema.employees.id))
    .where(and(eq(schema.expenseClaims.status, "approved"), isNull(schema.expenseClaims.voidedAt)))
    .groupBy(schema.expenseClaims.employeeId, schema.employees.name)
    .orderBy(desc(sum(schema.expenseClaims.total).mapWith(Number)));
  return {
    count: rows.reduce((s, r) => s + r.count, 0),
    amount: rows.reduce((s, r) => s + r.amount, 0),
    byEmployee: rows,
  };
}

/**
 * R12：單筆明細的憑證影像取出口。存進去的是 data URI（base64），原本只有
 * GET /expense-claims/:id 的整包回應帶得出來——記帳士要單獨拿一張收據時沒有下載端點。
 * 本人限定的檢查在路由層（與 GET /expense-claims/:id 同一條規則）。
 */
export async function getClaimItemImage(db: Db, claimId: number, itemId: number) {
  const claim = await requireClaim(db, claimId);
  const [item] = await db
    .select()
    .from(schema.expenseItems)
    .where(and(eq(schema.expenseItems.id, itemId), eq(schema.expenseItems.claimId, claimId)));
  if (!item) throw new AppError(404, "報銷明細不存在: 單 #{claimId} 明細 #{itemId}", { claimId, itemId });
  if (!item.image) throw new AppError(404, "報銷明細 #{itemId} 沒有憑證影像", { itemId });
  return {
    claim,
    fileName: `報銷單${claimId}-明細${itemId}${item.invoiceNumber ? `-${item.invoiceNumber}` : ""}`,
    image: item.image,
  };
}

/** 分類「被公司接受過」的狀態；判準與理由見 sellerCategorySuggestions 的註解 */
const ACCEPTED_CLAIM_STATUSES = ["approved", "paid"] as const;

/** 候選數量上限：這是給人掃一眼就按的東西，列到第四個就不如自己開下拉選 */
const SELLER_CATEGORY_LIMIT = 3;

/**
 * 「公司過去核准過的單裡，這家賣方最常被歸到哪幾個分類」（W7）。**候選，不是決定。**
 * 「最常」的量尺是**幾張單這樣歸過**（claimCount），不是幾筆明細——理由見下方 ★。
 *
 * 為什麼是查歷史而不是從品名推：決定分類的是**用途**（誰吃的、為了什麼），
 * 而用途不在發票裡也不在照片裡。同一家餐廳可以橫跨 6112 員工伙食／6115 員工福利／
 * 6137 餐飲與交際，這三個的可扣抵預設值還不一樣（EXPENSE_CATEGORIES）。
 * 所以這裡只回「別人以前怎麼歸的」，選哪一個仍然由填單的人決定。
 *
 * ★ 母體的判準（下一個人一定會問「為什麼我剛送的那筆沒出現」）：
 *   只算 status ∈ ACCEPTED_CLAIM_STATUSES 且 voided_at IS NULL 的單。
 *   - rejected：財務看過而且退回了，那個分類從來沒有被接受過。拿它當慣例，
 *     等於把一個已知的錯誤複製給下一個掃到同一家店的人。
 *   - voided_at（0036）：核准後才發現打錯的唯一出路。單子已經被反向傳票撤掉，
 *     它的分類也不該再算數——否則作廢救得了總帳，救不了它留下的示範效果。
 *   - submitted：**還沒有人看過**。它是申請人自己的選擇，不是「公司做過的選擇」，
 *     而且下一步可能就是被退回。算進來的話，一個人的誤選會在被糾正之前先傳染出去。
 *   - approved 與 paid 同權重：付款只是核准之後的出納動作，分類在核准那一刻就被接受了。
 *
 * ★ 權重是**不同單據數**（count(distinct claim_id)），不是明細筆數。
 *   一開始寫成明細筆數，理由是「每一筆明細都是一次獨立歸類」——那是錯的：
 *   同一張單裡的 5 筆明細只經過**一次**核准，是一個人的一個歸類決定被接受了一次。
 *   照明細筆數算，一張批次上傳的單（同一次核准動作）就能壓過好幾張各自被核准的單，
 *   而這裡要回答的問題是「公司的慣例是什麼」——慣例由幾次被接受的決定堆出來，
 *   不由某一次上傳了幾張收據決定。
 *   欄位因此叫 claimCount 而不是 count：叫 count 的話下一個人只會讀成「幾筆」。
 *
 * 只留仍然是現行分類的科目（inArray CATEGORY_BY_CODE）：回一個下拉選單裡已經不存在的
 * 舊科目，使用者按不下去。過濾寫在 WHERE 而不是取完前三名再篩，否則會回不滿三筆。
 *
 * 回傳刻意只有分類代號、標籤與單據數：金額、報銷人、單號一律不給——
 * 這個端點對所有角色開放（見 auth.ts 的 RULES），多回一個欄位就是多開一條跨員工的資料通道。
 * 沒有歷史就回空陣列，不補預設分類：猜一個放在「候選」的位置，使用者會以為那是系統查出來的。
 */
export async function sellerCategorySuggestions(
  db: Db,
  sellerTaxId: string,
): Promise<{ accountCode: string; label: string; claimCount: number }[]> {
  const rows = await db
    .select({
      accountCode: schema.expenseItems.accountCode,
      claimCount: countDistinct(schema.expenseItems.claimId),
    })
    .from(schema.expenseItems)
    .innerJoin(schema.expenseClaims, eq(schema.expenseItems.claimId, schema.expenseClaims.id))
    .where(
      and(
        eq(schema.expenseItems.sellerTaxId, sellerTaxId),
        inArray(schema.expenseClaims.status, [...ACCEPTED_CLAIM_STATUSES]),
        isNull(schema.expenseClaims.voidedAt),
        inArray(schema.expenseItems.accountCode, [...CATEGORY_BY_CODE.keys()]),
      ),
    )
    .groupBy(schema.expenseItems.accountCode)
    // 單據數相同時以科目代號決勝：沒有第二個排序鍵的話，同分的兩個分類誰進前三名由
    // 資料庫當下的掃描順序決定，同一份資料按兩次可能給出不一樣的答案。
    // 同分在這裡是常態而不是巧合——改成不同單據數之後，數字小、撞在一起的機會更大
    .orderBy(desc(countDistinct(schema.expenseItems.claimId)), asc(schema.expenseItems.accountCode))
    .limit(SELLER_CATEGORY_LIMIT);
  return rows.map((r) => ({
    accountCode: r.accountCode,
    label: CATEGORY_BY_CODE.get(r.accountCode)!.label,
    claimCount: r.claimCount,
  }));
}
