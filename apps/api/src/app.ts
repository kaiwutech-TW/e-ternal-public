import { zValidator } from "@hono/zod-validator";
import {
  ACCOUNT_PREFIX_LABELS,
  ASSET_CATEGORIES,
  CASH_ACCOUNT_CODES,
  EXPENSE_CATEGORIES,
  ROLES,
  SEED_ACCOUNTS,
  allowedTypesForCode,
  canAccessPage,
  featureMapFor,
  isValidTaxId,
  type AccountType,
} from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, ne, or, sql as sqlExpr, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { AppError, type Db } from "./db.ts";
import {
  authorize,
  beginTotpSetup,
  deleteUserSessions,
  disableTotp,
  enableTotp,
  hashPassword,
  login,
  logout,
  needsSetup,
  sessionUser,
  setup,
  TotpRequiredError,
  unusedRecoveryCount,
  type AuthUser,
} from "./services/auth.ts";
import {
  AGENT_PROVIDERS,
  getAgentSettings,
  updateAgentSettings,
} from "./services/agent-settings.ts";
import { createApiKey, listApiKeys, revokeApiKey, userFromApiKey } from "./services/api-keys.ts";
import { resolveLlm, runAgentChat, type LlmCall } from "./services/agent-chat.ts";
import { localeOf, translateFor } from "./i18n.ts";
import { guideIndex, readGuide } from "./services/agent-guides.ts";
import {
  approveMemory,
  archiveMemory,
  createMemory,
  deleteMemory,
  listMemories,
  memoryIndex,
  memoryStats,
  readMemory,
  searchMemories,
  updateMemory,
} from "./services/agent-memories.ts";
import { assertDateOrder } from "./services/dates.ts";
import {
  CONTRACT_KINDS,
  addInstallments,
  billInstallment,
  billingDue,
  deleteInstallment,
  expiringContracts,
  generateSchedule,
  listInstallments,
  matchInstallment,
  renewContract,
  unmatchInstallment,
  updateInstallment,
} from "./services/contracts.ts";
import {
  createPayable,
  deleteItem as deletePayableItem,
  dueList as payableDueList,
  generateItems as generatePayableItems,
  listItems as listPayableItems,
  listPayables,
  settleItem as settlePayableItem,
  unsettleItem as unsettlePayableItem,
  updateItem as updatePayableItem,
  updatePayable,
} from "./services/recurring-payables.ts";
import type { ListFilter } from "./services/list.ts";
import {
  getAttendanceSettings,
  listDepartments,
  listPunches,
  monthlySummary,
  myAttendance,
  punch,
  scheduleBoard,
  setSchedules,
} from "./services/attendance.ts";
import {
  DAY_TYPES,
  cancelRequest,
  createLeaveType,
  createRequest,
  decideStep,
  deleteCalendarDay,
  grantBalance,
  listBalances,
  listCalendar,
  listLeaveTypes,
  listRequests,
  myRequests,
  patchLeaveType,
  pendingApprovals,
  setCalendarDays,
} from "./services/hr-leave.ts";
import {
  createOvertimeRate,
  createRun,
  createSalary,
  deleteOvertimeRate,
  finalizeRun,
  getRun,
  listOvertimeRates,
  listRuns,
  listSalaries,
  patchItem,
  recalcRun,
} from "./services/payroll.ts";
import { listAudit, recordAudit, shouldAudit, targetIdOf } from "./services/audit.ts";
import { createPurchase, createSale, inventoryMovementLedger, inventoryStatus, onHand, saleDetail, trialBalance, updateSaleZeroTaxCert } from "./services/documents.ts";
import {
  approveClaim,
  createClaim,
  getClaim,
  getClaimItemImage,
  listClaims,
  lockInvoiceNumbers,
  payableSummary,
  payClaim,
  rejectClaim,
  resubmitClaim,
  sellerCategorySuggestions,
} from "./services/expenses.ts";
import { saleAllowanceG0401, saleAllowanceG0501 } from "./services/allowance-xml.ts";
import { depreciationScheduleExport, einvoiceXmlExport, expenseClaimsExport, journalExport, purchasesExport, salesInvoicesExport } from "./services/exports.ts";
import { cancelInvoice, issueDisposalInvoice, issueInvoice } from "./services/invoices.ts";
import {
  applyPrepaid,
  balanceSheet,
  createCashDoc,
  createManualEntry,
  getCashDoc,
  incomeStatement,
  inventoryOpening,
  listJournalEntries,
  openDocuments,
  partnerBalances,
  prepaidDocs,
} from "./services/ledger.ts";
import {
  createInventoryAdjustment,
  createStocktake,
  listInventoryAdjustments,
  stocktakeSheet,
} from "./services/inventory-adjustments.ts";
import { createOpeningBalance, listOpeningBalances } from "./services/opening.ts";
import { decryptPii, encryptPii } from "./services/pii.ts";
import { cashFlow, ledgerReport } from "./services/reports.ts";
import {
  createPurchaseReturn,
  createSaleReturn,
  listPurchaseReturns,
  listSaleReturns,
  purchaseReturnable,
  saleReturnable,
  updateReturnCertificate,
} from "./services/returns.ts";
import {
  apAging,
  arAging,
  cancelOrder,
  closeOrder,
  convertQuote,
  createOrder,
  createQuote,
  listOrders,
  listQuotes,
  setQuoteLost,
  shipOrder,
} from "./services/orders.ts";
import { createAsset, depreciationSchedule, disposeAsset, listAssets, previewDisposal, runDepreciation, updateAsset } from "./services/assets.ts";
import {
  assertPeriodOpen,
  checkPeriod,
  closePeriod,
  listCloses,
  listYearCloses,
  reopenLatest,
  yearClose,
} from "./services/period.ts";
import { dashboard } from "./services/dashboard.ts";
import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  listPurchaseOrders,
  receivePurchaseOrder,
} from "./services/purchase-orders.ts";
import {
  deleteReturn401Filing,
  fileReturn401,
  generate401,
  listReturn401Filings,
} from "./services/vat.ts";
import {
  RECORD_ONLY_KINDS,
  createParameter,
  listParameters,
  resolveDeductible,
} from "./services/tax-parameters.ts";
import {
  createCategory,
  createPayment,
  estimatePayment,
  listCategories,
  listPayments,
  paymentSummary,
  updateCategory,
} from "./services/withholding.ts";
import {
  voidAssetDisposal,
  voidCashDoc,
  voidExpenseClaim,
  voidFixedAsset,
  voidInventoryAdjustment,
  voidManualEntry,
  voidOpeningBalance,
  voidPurchase,
  voidPurchaseReturn,
  voidQuote,
  voidSale,
  voidSaleReturn,
  voidWithholdingPayment,
} from "./services/void.ts";

/** 預設科目表涵蓋的代號：這些科目的 is_system/is_cash 由 seedAccounts() 每次啟動校正 */
const SEED_CODES = new Set(SEED_ACCOUNTS.map((a) => a.code));

const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  asset: "資產 asset",
  liability: "負債 liability",
  equity: "權益 equity",
  revenue: "收入 revenue",
  expense: "費用 expense",
};

/**
 * 代號首碼 vs 類別的交叉驗證（新增與改類別共用）。
 * 訊息刻意寫成可操作的句子：講出這個首碼是什麼、應該選哪個類別——
 * 原本只有 regex 擋格式，錯誤訊息描述了首碼語意卻從不驗證，等於白紙黑字騙人。
 */
function assertTypeMatchesCode(code: string, type: AccountType): void {
  const allowed = allowedTypesForCode(code);
  if (allowed.includes(type)) return;
  const prefix = code.charAt(0);
  const label = ACCOUNT_PREFIX_LABELS[prefix] ?? "未定義的首碼";
  throw new AppError(
    400,
    "代號 {prefix}xxx 是{label}，類別應為 {allowedLabels}，不是 {typeLabel}。請改類別，或改用{label}以外的代號首碼",
    { prefix, label, allowedLabels: allowed.map((t) => ACCOUNT_TYPE_LABEL[t]).join(" 或 "), typeLabel: ACCOUNT_TYPE_LABEL[type] },
  );
}

/**
 * 交易對象。個人與法人的識別碼互斥：
 * - 法人：taxId（統一編號 8 碼，驗檢查碼），選填。
 * - 個人：idNo（身分證統一編號／居留證號），年度憑單申報需要；**不驗格式**——
 *   居留證號、護照號碼的格式各不相同，驗錯了會把合法的對象擋在系統外面，
 *   而這個欄位的用途是「要填年度憑單時抄得出來」，抄錯的風險遠低於填不進去的風險。
 *   ⚠️ idNo 是 PII：不進 GET /partners 的回傳（只回 hasIdNo），明文限財務／管理者單筆查詢。
 *
 * 兩者互斥是 DB CHECK（ck_partners_individual_no_tax_id）＋這裡的 refine 雙層把關；
 * refine 存在的理由是 DB CHECK 的錯誤訊息是英文約束名，使用者看不懂也不知道怎麼脫困。
 */
/** 選填文字欄的共同形狀：nullable＝「明確送 null 才是清空」，空字串一律擋（前端要負責轉 null） */
const optionalText = (max = 200) => z.string().trim().min(1).max(max).nullable().optional();

const partnerBase = {
  name: z.string().min(1),
  // nullable 是脫困路徑：法人要改成個人時必須先清掉統編，
  // 而 optional 的語意是「沒帶＝不改」，只有明確送 null 才表達得出「清空」
  taxId: z.string().refine(isValidTaxId, "統一編號檢查碼錯誤").nullable().optional(),
  idNo: z.string().trim().min(1).max(20).nullable().optional(),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  isIndividual: z.boolean().optional(),
  // ── 0022 補齊（B1／3.1）：以前這些欄位送進來會被 zod 靜默丟棄、回 201 但什麼都沒存 ──
  contactPerson: optionalText(100),
  phone: optionalText(50),
  email: optionalText(200),
  address: optionalText(500),
  shipToAddress: optionalText(500),
  /** 付款條件（天）：null＝未約定；0＝貨到付款。上限擋掉「手滑打成年份」這類輸入 */
  paymentTermDays: z.number().int().min(0).max(3650).nullable().optional(),
  /** 信用額度（整數元）：null＝不設限。超過只提示不硬擋——授信是商業判斷不是系統判斷 */
  creditLimit: z.number().int().min(0).nullable().optional(),
  salesOwnerEmployeeId: z.number().int().positive().nullable().optional(),
  note: optionalText(1000),
};

/** 個人不得有統編（統編是營利事業的識別碼，填了一定是資料錯置）；訊息要講出怎麼脫困 */
function assertPartnerIdentity(v: {
  isIndividual?: boolean | undefined;
  taxId?: string | null | undefined;
  idNo?: string | null | undefined;
}) {
  if (v.isIndividual && v.taxId) {
    throw new AppError(
      422,
      "勾選「個人」的交易對象不能有統一編號：統編是營利事業的識別碼。個人房東／個人接案者請把統編欄清空，改填身分證統一編號（年度憑單申報要用）；若對方其實是公司，請取消「個人」的勾選",
    );
  }
  if (!v.isIndividual && v.idNo) {
    throw new AppError(
      422,
      "只有勾選「個人」的交易對象才需要身分證統一編號。若這筆是個人，請勾選「個人」並清空統一編號；若是公司，請把身分證號欄清空、改填統一編號",
    );
  }
}

const partnerInput = z.object({
  ...partnerBase,
  isCustomer: z.boolean().default(false),
  isSupplier: z.boolean().default(false),
  isIndividual: z.boolean().default(false),
});

// partial()：PATCH 只帶要改的欄位，name 在這裡也是選填（partnerBase 的 name 是必填，那是給 POST 用的）
const partnerPatchInput = z.object(partnerBase).partial();

const productInput = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1).default("個"),
  // ── 0022 補齊（B2／3.2）──
  /** 標準售價（整數元）：null＝未定價（開單時仍可手填）。標準成本刻意不設——移動加權平均是成本的事實來源 */
  listPrice: z.number().int().min(0).nullable().optional(),
  category: optionalText(100),
  /** 服務項目（運費、安裝費、顧問費）：銷貨不檢查庫存、成本 0；進貨側不收（理由見 documents.ts） */
  isService: z.boolean().optional(),
  minStock: z.number().int().min(0).nullable().optional(),
  note: optionalText(1000),
});

// PATCH 只帶要改的欄位；sku 欄位收下來只為了給出「不可改」的明確訊息（比照 PATCH /accounts 的 code）
const productPatchInput = z.object({
  sku: z.string().optional(),
  name: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  listPrice: z.number().int().min(0).nullable().optional(),
  category: optionalText(100),
  isService: z.boolean().optional(),
  minStock: z.number().int().min(0).nullable().optional(),
  note: optionalText(1000),
});

const employeeInput = z.object({
  name: z.string().min(1),
  // ── 0022 補齊（B3／3.3）──
  title: optionalText(100),
  phone: optionalText(50),
  email: optionalText(200),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "到職日格式須為 YYYY-MM-DD").nullable().optional(),
  note: optionalText(1000),
  // ── 0039 HR：部門、直屬主管、全職/部分工時、免打卡 ──
  departmentId: z.number().int().positive().nullable().optional(),
  managerEmployeeId: z.number().int().positive().nullable().optional(),
  employmentType: z.enum(["fulltime", "parttime"]).optional(),
  punchExempt: z.boolean().optional(),
});

// active 只在 PATCH 開放：B3 的修正——停用（離職）之後，報銷與業務負責人都選不到這個人，
// 服務層的「員工已停用」把關（expenses.ts）從死碼變成真的會執行
const employeePatchInput = employeeInput.partial().extend({ active: z.boolean().optional() });

const companyInput = z.object({
  name: z.string().min(1),
  taxId: z.string().refine(isValidTaxId, "統一編號檢查碼錯誤"),
  address: z.string().optional(),
  personInCharge: z.string().optional(),
  telephone: z.string().optional(),
  email: z.string().optional(),
  taxRegistrationNo: z.string().regex(/^\d{9}$/).optional(),
  cityCode: z.string().regex(/^[A-Z]$/).optional(),
  // ── 0024：401 申報人（第 99-103 欄）與委託記帳士（第 98／104 欄）──
  // 長度上限照申報書欄寬在**存檔時**就擋下：等到產出 401 才炸，使用者已離開設定頁很久了。
  // 空字串＝清空該欄（filerIdNo 例外：它是 PII，清空走 DELETE /company-profile/filer-id-no）
  filerName: z.string().trim().max(12, "申報人姓名最長 12 個字（申報書欄寬限制）").optional(),
  filerIdNo: z
    .string()
    .trim()
    .regex(/^[\x20-\x7E]{1,10}$/, "申報人身分證統一編號最長 10 碼，不可含中文或全形字元")
    .optional(),
  filerAreaCode: z.string().trim().regex(/^[\x20-\x7E]{0,4}$/, "電話區碼最長 4 碼").optional(),
  filerPhone: z.string().trim().regex(/^[\x20-\x7E]{0,11}$/, "電話最長 11 碼（可含連字號，不可含全形）").optional(),
  filerExt: z.string().trim().regex(/^[\x20-\x7E]{0,5}$/, "分機最長 5 碼").optional(),
  declarationAgentNo: z
    .string()
    .trim()
    .regex(/^[\x20-\x7E]{0,20}$/, "代理申報人登錄字號最長 20 碼，不可含中文或全形字元")
    .optional(),
  // 兼營免稅／特種稅額標記（0028，B12）：true＝產 401 直接 422 指路 403，不靜默產出錯類別的申報書
  vatMixedBusiness: z.boolean().optional(),
});

const supplierInvoiceInput = z.object({
  track: z.string().regex(/^[A-Z]{2}$/),
  no: z.string().regex(/^\d{8}$/),
  format: z.enum(["21", "22", "25"]).optional(),
  deductionCode: z.enum(["1", "2", "3", "4"]).optional(),
  // 供應商發票開立日期（0029，R20）：401 進項歸期優先用它。未帶＝維持 NULL（歸期退回進貨單日期）
  invDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "發票日期格式須為 YYYY-MM-DD").optional(),
});

const trackInput = z.object({
  period: z.string().regex(/^\d{6}$/),
  track: z.string().regex(/^[A-Z]{2}$/),
  rangeStart: z.number().int().nonnegative(),
  rangeEnd: z.number().int().nonnegative(),
});

const issueInput = z.object({
  mode: z.enum(["B2B", "B2C"]),
  invoiceTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
  randomNumber: z.string().regex(/^\d{4}$/).optional(),
  // 載具（0029 起落地到 invoices 欄位）：三欄都不可為空字串——空載具號寫進 XML 等於歸不了戶
  carrier: z
    .object({
      type: z.string().trim().min(1, "載具類別不可為空"),
      id1: z.string().trim().min(1, "載具號碼不可為空"),
      id2: z.string().trim().min(1, "載具號碼不可為空"),
    })
    .optional(),
  donateMark: z.enum(["0", "1"]).optional(),
  npoban: z.string().trim().min(1, "捐贈碼不可為空字串（不捐贈請整欄不帶）").optional(),
  printMark: z.enum(["Y", "N"]).optional(),
});

// 處分發票（0034）：形狀同銷貨發票，多一個買受人——處分單上沒有交易對象，開票時指定
const disposalIssueInput = issueInput.extend({ partnerId: z.number().int().positive() });

const docInput = z.object({
  partnerId: z.number().int().positive(),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        qty: z.number().positive(),
        unitPrice: z.number().nonnegative(),
      }),
    )
    .min(1),
});

// 進貨多一個付款到期日（0033）：未帶＝依供應商付款條件推算；供應商也沒約定＝NULL（應付帳齡以單據日估算）
const purchaseDocInput = docInput.extend({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "付款到期日格式須為 YYYY-MM-DD").optional(),
});

// 銷貨多一個收款到期日（0022）：未帶＝依客戶付款條件推算；客戶也沒約定＝NULL（帳齡以單據日估算）
// 課稅別（0028，B12）：'1' 應稅（預設）／'2' 零稅率／'3' 免稅（服務層拒收並指路 403）。
// 零稅率必帶 zeroTaxViaCustoms（401 分經海關／非經海關兩欄）；證明文件號碼可留空事後補登
const saleDocInput = docInput.extend({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "收款到期日格式須為 YYYY-MM-DD").optional(),
  taxType: z.enum(["1", "2", "3"]).optional(),
  zeroTaxViaCustoms: z.boolean().optional(),
  zeroTaxCertNo: z.string().trim().min(1, "證明文件號碼不可為空字串（未取得請整欄不帶，之後補登）").max(50).optional(),
});

/**
 * 作廢輸入（0025，B4）：理由必填——原單會永久留存這個理由，事後查得出誰為什麼廢了它。
 * voidDate＝反向傳票日期（未帶＝原單日期），只有收付款單／手工傳票／扣繳單接受：
 * 這三種單據的跨期沖轉是合法出路（原期已關就以開放期間的日期沖）。
 * 銷貨單／進貨單刻意**不收** voidDate——它們的彙總與 401 依單據日歸期，
 * 原單期間已關就只能走退回／折讓單，收了這個欄位等於承諾一條不存在的路。
 */
const voidInput = z.object({
  reason: z.string().trim().min(1, "作廢理由必填（原單會永久留存這個理由）").max(500),
  voidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "voidDate 格式須為 YYYY-MM-DD").optional(),
});
const voidReasonOnly = z.object({
  reason: z.string().trim().min(1, "作廢理由必填（原單會永久留存這個理由）").max(500),
});

/**
 * 路徑上的 id 參數。Number("abc") 是 NaN，直接送進 SQL 會變成
 * `where id = NaN` → Postgres 語法錯誤 → 500 internal error，使用者看到的是「系統壞了」。
 * 網址打錯是使用者的輸入錯誤，該回 400。
 */
function idParam(c: Context, name = "id"): number {
  const raw = c.req.param(name);
  // 用 regex 而不是 Number()：Number(" 12 ")、Number("0x0c")、Number("1e2") 都會過，
  // 於是同一筆資料有一堆 URL 別名，而錯誤訊息又說「必須是正整數」——說到做不到
  if (!/^[1-9]\d*$/.test(raw ?? "")) {
    throw new AppError(400, "網址中的 {name} 必須是正整數（收到「{raw}」）", { name, raw });
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new AppError(400, "網址中的 {name} 超出範圍（收到「{raw}」）", { name, raw });
  }
  return n;
}

/**
 * 清單查詢參數（R3）：from/to/partnerId/limit/offset。與 idParam 同一條原則——
 * 參數打錯是使用者的輸入錯誤，該回 400 出聲，不是靜默忽略後回全表
 * （原本 /quotes?partnerId=999999 照樣 200 回 44 筆，腳本對帳拿到的是全公司總額）。
 */
function listQuery(c: Context): ListFilter {
  const q = c.req.query();
  const date = (name: "from" | "to"): string | undefined => {
    const v = q[name];
    if (v === undefined || v === "") return undefined;
    // regex 只擋形狀；「2026-13-45」形狀對但不是日期，放進 SQL 會炸 500——真日期用往返驗證
    const parsed = new Date(`${v}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== v
    ) {
      throw new AppError(400, "{name} 須為真實存在的日期（YYYY-MM-DD，收到「{v}」）", { name, v });
    }
    return v;
  };
  const int = (name: string, def: number, min: number, max: number): number => {
    const v = q[name];
    if (v === undefined || v === "") return def;
    if (!/^\d+$/.test(v)) throw new AppError(400, "{name} 須為非負整數（收到「{v}」）", { name, v });
    const n = Number(v);
    if (n < min || n > max) throw new AppError(400, "{name} 須在 {min}–{max} 之間（收到 {n}）", { name, min, max, n });
    return n;
  };
  const from = date("from");
  const to = date("to");
  if (from && to && from > to) {
    throw new AppError(400, "日期範圍顛倒：from（{from}）晚於 to（{to}），請對調", { from, to });
  }
  let partnerId: number | undefined;
  const rawPartner = q["partnerId"];
  if (rawPartner !== undefined && rawPartner !== "") {
    if (!/^[1-9]\d*$/.test(rawPartner)) {
      throw new AppError(400, "partnerId 須為正整數（收到「{rawPartner}」）", { rawPartner });
    }
    partnerId = Number(rawPartner);
  }
  return {
    from,
    to,
    partnerId,
    // 上限 500 與 audit-logs 同一格：要更多請翻頁（offset），不是一次搬全表
    limit: int("limit", 200, 1, 500),
    offset: int("offset", 0, 0, 10_000_000),
  };
}

/** X-Total-Count 標頭（R3）：分頁資訊不進 body——回應形狀維持陣列，不破壞既有前端 */
function setTotalCount(c: Context, total: number): void {
  c.header("X-Total-Count", String(total));
}

/**
 * 退回單的退現路徑要另外檢查 cash 頁權限。
 *
 * 退回單指定現金科目時會直接貸／借記現金或銀行科目，等於在銷貨頁做了一筆現金收付；
 * ROLE_PAGES 只把 cash 頁開給 admin/finance，若不在這裡一併檢查，sales 角色就能靠開退回單
 * 繞過那道限制動現金。路由層檢查是因為它取決於 request body（settlement），authorize() 只看路徑。
 */
function assertCashSettlementAllowed(user: AuthUser, body: { settlement?: "auto" | "cash" | undefined }): void {
  if (body.settlement !== "cash" || canAccessPage(user.role, "cash")) return;
  throw new AppError(
    403,
    "「當場退現」會直接動到現金／銀行科目，需要「收付款」頁的權限，您的角色沒有。請取消勾選「當場退現」再送出：系統會自動沖掉對方還欠的貨款，沖不掉的部分掛在其他應付款／其他應收款，之後由財務開一張付款單退款——退回單本身照樣開得成立。",
  );
}

/**
 * session cookie 該不該帶 `Secure`——**只能依這個請求實際上是不是 https 決定，不能寫死任一邊**。
 *
 * 寫死 true：內網 http 部署（本專案目前的實際形狀）升級後全公司登不進來，而且畫面上零徵兆——
 * 瀏覽器對 http 連線根本不回傳帶 Secure 的 cookie，症狀只是「登入成功後又跳回登入頁」。
 * 寫死 false：上公網後 session token 在 http 明文可截，等於整套權限系統白做。
 *
 * 反代（caddy/nginx）終結 TLS 時 app 自己看到的是 http，真相在 X-Forwarded-Proto。
 * 這個標頭可以被任何人偽造，但偽造它只會改到**偽造者自己那個請求**的 cookie 屬性：
 * 送 https 讓自己的 cookie 多一個 Secure（自找麻煩），送 http 讓自己的 cookie 少一個
 * （自己降自己的安全）。攻擊者無法在受害者的瀏覽器請求上加標頭，所以這裡信任它是安全的。
 *
 * SESSION_COOKIE_SECURE=1/0 供「反代不帶 X-Forwarded-Proto」或「app 直接吃 https」等
 * 情形明確覆寫；不設就是自動判斷。
 */
function isHttps(c: Context): boolean {
  const forced = process.env["SESSION_COOKIE_SECURE"];
  if (forced === "1") return true;
  if (forced === "0") return false;
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  return new URL(c.req.url).protocol === "https:";
}

/**
 * 請求的來源位址（登入節流的第二個桶用）。取不到就回空字串＝「不知道」，
 * 服務層會跳過來源桶——寧可少擋一層，也不要把所有取不到來源的請求當成同一個來源。
 *
 * X-Forwarded-For 只在 TRUST_PROXY=1 時才採信，而且**必須**在反代後面時設它：
 * - 不設而站在反代後面：socket 位址永遠是反代自己，全公司算同一個桶
 *   （所以來源門檻才訂得比帳號門檻鬆很多，見 services/auth.ts）
 * - 設了卻直接暴露在公網：任何人都能自己編一個 X-Forwarded-For，來源桶形同虛設
 * 兩種錯法方向相反，沒有一個「都對」的預設值，只能要求部署時講清楚（docs/deployment.md）。
 */
function clientSource(c: Context): string {
  if (process.env["TRUST_PROXY"] === "1") {
    const first = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (first) return first;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "";
}

/**
 * 單埠部署時本 app 掛在 /api 之下（server-app.ts），c.req.path 會帶前綴。
 * 權限比對、操作日誌的路徑都用正規化後的形狀——否則同一條路由在兩種部署下
 * 會在日誌裡長成兩個樣子，事後查詢得記住當時是怎麼部署的。
 */
function normalizePath(raw: string): string {
  return raw.startsWith("/api/") ? raw.slice(4) : raw;
}

export function buildApp(db: Db, opts?: { agentLlm?: LlmCall }) {
  const app = new Hono<{
    Variables: { user: AuthUser; sessionToken: string; auditUsername: string; auditNote: string };
  }>();

  app.onError((err, c) => {
    // 「密碼對了但還要驗證碼」必須讓前端分辨得出來，否則畫面只能顯示一句紅字，
    // 使用者不知道該補填什麼（狀態碼刻意仍是 401——沒拿到 session 就是沒登入）
    if (err instanceof TotpRequiredError) return c.json({ error: err.message, totpRequired: true }, 401);
    // 依 Accept-Language 翻譯；沒翻的 key 原樣回中文（永遠不會空白）
    if (err instanceof AppError) return c.json({ error: translateFor(localeOf(c))(err.key, err.params) }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // --- 認證：全路由 default-deny，僅登入/初始設定為公開 ---
  const SESSION_COOKIE = "sid";
  const setSessionCookie = (c: Context, token: string) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isHttps(c),
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });

  /**
   * 操作日誌。**必須是最外層的 middleware**——它要看得到下面那層認證守衛擋掉的 401／403，
   * 而被擋下的嘗試正是安全上最該留紀錄的事件。
   *
   * 錯誤路徑：服務層丟的 AppError 由 app.onError 轉成回應。這裡仍用 try/catch 兜住，
   * 因為「Hono 內部是否已把錯誤接住並填好 c.res」是框架實作細節，
   * 押在上面的話某次升版就會靜默漏掉所有 4xx——而漏掉的當下沒有任何徵兆。
   */
  app.use("*", async (c, next) => {
    const path = normalizePath(c.req.path);
    if (!shouldAudit(c.req.method, path)) return next();
    let thrown: unknown;
    try {
      await next();
    } catch (err) {
      thrown = err;
    }
    const status = thrown ? (thrown instanceof AppError ? thrown.status : 500) : c.res.status;
    const user = c.get("user") as AuthUser | undefined;
    await recordAudit(db, {
      userId: user?.id ?? null,
      // 未登入時退回路由自願登記的帳號字串（目前只有登入路由會填）。
      // 這是白名單而非「順手抓 body」：帳號本身不是秘密，而 body 裡的密碼是
      username: user?.username ?? c.get("auditUsername") ?? "",
      role: user?.role ?? null,
      method: c.req.method,
      path,
      status,
      source: clientSource(c),
      targetId: thrown ? null : await targetIdOf(c.res),
      note: c.get("auditNote") ?? "",
    });
    if (thrown) throw thrown;
  });

  app.use("*", async (c, next) => {
    const path = normalizePath(c.req.path);
    const isPublic =
      (c.req.method === "POST" && (path === "/auth/login" || path === "/auth/setup")) ||
      (c.req.method === "GET" && path === "/auth/setup-status");
    if (isPublic) return next();

    // 兩種身分來源：瀏覽器的 session cookie，或 agent／腳本的 API 金鑰。
    // 金鑰**刻意略過二階段驗證**——第二因子證明的是「螢幕前面是本人」，
    // 而 agent 前面本來就沒有人（設計說明見 migration 0021）。
    const token = getCookie(c, SESSION_COOKIE);
    const user =
      (token ? await sessionUser(db, token) : null) ??
      (await userFromApiKey(db, c.req.header("authorization")));
    if (!user) return c.json({ error: "未登入" }, 401);
    c.set("user", user);
    if (token) c.set("sessionToken", token);
    if (path.startsWith("/auth/")) return next(); // me / logout

    const denied = authorize(user.role, c.req.method, path);
    if (denied) return c.json({ error: denied }, 403);
    return next();
  });

  app.get("/auth/setup-status", async (c) => c.json({ needsSetup: await needsSetup(db) }));
  const setupInput = z.object({
    username: z.string().min(1),
    displayName: z.string().min(1),
    password: z.string().min(6, "密碼至少 6 碼"),
  });
  app.post("/auth/setup", zValidator("json", setupInput), async (c) => {
    const { token, user } = await setup(db, c.req.valid("json"));
    setSessionCookie(c, token);
    return c.json(user, 201);
  });
  app.post(
    "/auth/login",
    zValidator(
      "json",
      z.object({
        username: z.string().min(1),
        password: z.string().min(1),
        // 已啟用二階段驗證的帳號才需要；第一次送出時前端還不知道要不要填
        totpCode: z.string().trim().min(1).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      // 登入失敗時沒有 c.get("user")，日誌只剩下這個線索——所以在驗證密碼之前就登記
      c.set("auditUsername", body.username);
      const { token, user } = await login(db, body.username, body.password, clientSource(c), body.totpCode);
      setSessionCookie(c, token);
      return c.json(user);
    },
  );
  app.get("/auth/me", async (c) => c.json(c.get("user")));

  // --- 二階段驗證（TOTP）：一律**只能設定自己的**，路徑上沒有 userId 這個參數 ---
  //
  // 管理者替別人關閉的逃生門在 PATCH /users/:id（totpEnabled:false），
  // 那條會被操作日誌記下來；而唯一管理者自己被鎖在外面時走 scripts/disable-totp.ts
  // （需要資料庫存取權，刻意不做成 API——那正是攻擊者最想要的端點）。
  app.get("/auth/totp", async (c) => {
    const me = c.get("user");
    return c.json({ enabled: me.totpEnabled, recoveryCodesLeft: await unusedRecoveryCount(db, me.id) });
  });
  app.post(
    "/auth/totp/setup",
    // 第一次啟用不需要密碼（session 本身就是剛用密碼換來的）；已啟用者重新設定才需要
    zValidator("json", z.object({ password: z.string().optional() })),
    async (c) => c.json(await beginTotpSetup(db, c.get("user"), c.req.valid("json").password)),
  );
  app.post(
    "/auth/totp/enable",
    zValidator("json", z.object({ code: z.string().min(1) })),
    async (c) => {
      const codes = await enableTotp(db, c.get("user").id, c.req.valid("json").code);
      // 明文備援碼只在這一刻存在於回應裡，之後資料庫只有雜湊——沒有任何 API 能再取得
      return c.json({ recoveryCodes: codes });
    },
  );
  // 用 POST 而不是 DELETE：關閉要重新輸入密碼，而帶 body 的 DELETE 會被部分反向代理
  // 與 HTTP 客戶端丟掉 body（本專案的公網形狀就是站在 caddy 後面）。
  // 症狀會是「按了關閉卻說密碼不正確」，而且只在正式環境重現得出來
  app.post(
    "/auth/totp/disable",
    zValidator("json", z.object({ password: z.string().min(1) })),
    async (c) => {
      await disableTotp(db, c.get("user").id, c.req.valid("json").password);
      return c.json({ ok: true });
    },
  );
  app.post("/auth/logout", async (c) => {
    // 以 API 金鑰呼叫時沒有 session 可登出——回 200 而不是炸掉，因為「登出」對它是無操作。
    // 要停掉一把金鑰請用 DELETE /api-keys/:id（登出不該能撤銷金鑰：那是管理者的動作）
    const sessionToken = c.get("sessionToken");
    if (!sessionToken) return c.json({ ok: true, note: "API 金鑰無 session 可登出" });
    await logout(db, sessionToken);
    // 刪除用的 Set-Cookie 屬性要與當初種下時一致，否則瀏覽器當成另一顆 cookie 而不刪
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isHttps(c), sameSite: "Lax" });
    return c.json({ ok: true });
  });

  // --- 操作日誌（ACL 已限 admin；與使用者管理同一層級，見 services/auth.ts 的 RULES）---
  //
  // 只讀不寫：沒有刪除、沒有編輯、沒有保留天數設定。**能被關掉的稽核不是稽核**——
  // 一個「清空日誌」的按鈕會讓整張表在事後失去證明力（無法分辨「沒發生」與「被刪了」）。
  // 真要縮容量請直接下 SQL，那是有意識的維運動作，不該做成畫面上一個鍵。
  app.get("/audit-logs", async (c) => {
    const q = c.req.query();
    const rows = await listAudit(db, {
      limit: Math.min(Number(q["limit"] ?? 100) || 100, 500),
      before: q["before"] ? Number(q["before"]) : undefined,
      userId: q["userId"] ? Number(q["userId"]) : undefined,
      method: q["method"] || undefined,
      path: q["path"] || undefined,
      failedOnly: q["failedOnly"] === "1",
    });
    return c.json(rows);
  });

  // --- Agent 接入（ACL 已限 admin；見 migration 0021）---
  app.get("/api-keys", async (c) => c.json(await listApiKeys(db)));
  app.post(
    "/api-keys",
    zValidator("json", z.object({ name: z.string().min(1), userId: z.number().int().positive() })),
    async (c) => {
      const body = c.req.valid("json");
      const created = await createApiKey(db, { ...body, createdBy: c.get("user").id });
      c.set("auditNote", `建立金鑰「${body.name}」給 user#${body.userId}`);
      // 明文金鑰只在這一次出現；操作日誌不記 body 與回應，所以它不會落到任何地方
      return c.json(created, 201);
    },
  );
  app.delete("/api-keys/:id", async (c) => {
    await revokeApiKey(db, idParam(c));
    return c.json({ ok: true });
  });

  app.get("/agent-settings", async (c) => c.json(await getAgentSettings(db)));
  app.put(
    "/agent-settings",
    zValidator(
      "json",
      z.object({
        provider: z.enum(AGENT_PROVIDERS).optional(),
        model: z.string().optional(),
        baseUrl: z.string().url("請填完整網址（含 https://）").nullable().optional(),
        apiKey: z.string().min(1).nullable().optional(),
        enabled: z.boolean().optional(),
      }),
    ),
    async (c) => c.json(await updateAgentSettings(db, c.req.valid("json"), c.get("user").id)),
  );

  // --- 使用者管理（ACL 已限 admin）---
  /**
   * 使用者的對外形狀。**用挑出來的白名單而不是「刪掉幾個欄位」**——
   * 排除法在新增欄位時會失敗開放（下一個機密欄位會自動出現在回應裡，而且沒有人會發現）。
   * totpSecret 雖然是密文，但它是第二因子的全部，沒有理由讓它離開資料庫。
   */
  const publicUser = (u: typeof schema.users.$inferSelect) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    employeeId: u.employeeId,
    active: u.active,
    createdAt: u.createdAt,
    totpEnabled: u.totpEnabledAt !== null,
  });
  const newUserInput = z.object({
    username: z.string().min(1),
    displayName: z.string().min(1),
    password: z.string().min(6, "密碼至少 6 碼"),
    role: z.enum(ROLES),
    employeeId: z.number().int().positive().nullable().optional(),
  });
  /**
   * R11：一個員工只能連一個帳號——兩個帳號連到同一個員工，等於把一個人的報銷紀錄
   * （住哪家旅館、吃了什麼）全開給另一個帳號，且能以他的名義送單。
   * DB 有 partial unique（0036）當最後防線，這裡先查是為了把 500 換成講得清楚的 409。
   */
  const assertEmployeeNotLinked = async (employeeId: number, excludeUserId?: number) => {
    const [linked] = await db
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.employeeId, employeeId),
          excludeUserId === undefined ? undefined : ne(schema.users.id, excludeUserId),
        ),
      );
    if (linked) {
      throw new AppError(
        409,
        "該員工已連結帳號「{username}」——一個員工只能連一個帳號（報銷紀錄是個人資料）。要換帳號請先把「{username}」的連結解除",
        { username: linked.username },
      );
    }
  };
  app.post("/users", zValidator("json", newUserInput), async (c) => {
    const body = c.req.valid("json");
    const [dup] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, body.username));
    if (dup) throw new AppError(409, "帳號已存在: {username}", { username: body.username });
    if (body.employeeId != null) await assertEmployeeNotLinked(body.employeeId);
    const [row] = await db
      .insert(schema.users)
      .values({
        username: body.username,
        displayName: body.displayName,
        passwordHash: hashPassword(body.password),
        role: body.role,
        employeeId: body.employeeId ?? null,
      })
      .returning();
    return c.json(publicUser(row!), 201);
  });
  app.get("/users", async (c) => c.json((await db.select().from(schema.users)).map(publicUser)));
  const patchUserInput = z.object({
    displayName: z.string().min(1).optional(),
    password: z.string().min(6, "密碼至少 6 碼").optional(),
    role: z.enum(ROLES).optional(),
    active: z.boolean().optional(),
    employeeId: z.number().int().positive().nullable().optional(),
    /**
     * 只接受 false——這是「同事手機掉了」的逃生門，不是開關。
     * 管理者無法**替別人啟用**二階段驗證（別人的密鑰只有他自己的手機掃得到），
     * 所以 true 在這裡沒有任何意義，接受它只會製造一個做不到的承諾。
     */
    totpEnabled: z.literal(false).optional(),
  });
  app.patch("/users/:id", zValidator("json", patchUserInput), async (c) => {
    const id = Number(c.req.param("id"));
    const body = c.req.valid("json");
    const me = c.get("user");
    if (id === me.id && ((body.role && body.role !== me.role) || body.active === false)) {
      throw new AppError(400, "不能變更自己的角色或停用自己");
    }
    if (body.employeeId != null) await assertEmployeeNotLinked(body.employeeId, id);
    const [row] = await db
      .update(schema.users)
      .set({
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.password ? { passwordHash: hashPassword(body.password) } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.employeeId !== undefined ? { employeeId: body.employeeId } : {}),
        ...(body.totpEnabled === false
          ? { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null }
          : {}),
      })
      .where(eq(schema.users.id, id))
      .returning();
    if (!row) throw new AppError(404, "使用者不存在: {id}", { id });
    // 舊的備援碼跟著密鑰一起作廢，否則它們會變成一組繞過重新設定的後門
    if (body.totpEnabled === false) {
      await db.delete(schema.totpRecoveryCodes).where(eq(schema.totpRecoveryCodes.userId, id));
    }
    if (body.active === false || body.password) await deleteUserSessions(db, id);
    return c.json(publicUser(row));
  });

  /**
   * 交易對象的對外形狀：白名單挑欄位（不用 {idNo, ...rest} 排除法——之後任何人新增欄位，
   * 排除法都是失敗開放，PII 只要再出現一個就直接漏出去）。id_no 只回「有沒有填」。
   */
  const publicPartner = (p: typeof schema.partners.$inferSelect) => ({
    id: p.id,
    name: p.name,
    taxId: p.taxId,
    isCustomer: p.isCustomer,
    isSupplier: p.isSupplier,
    isIndividual: p.isIndividual,
    contactPerson: p.contactPerson,
    phone: p.phone,
    email: p.email,
    address: p.address,
    shipToAddress: p.shipToAddress,
    paymentTermDays: p.paymentTermDays,
    creditLimit: p.creditLimit,
    salesOwnerEmployeeId: p.salesOwnerEmployeeId,
    note: p.note,
    createdAt: p.createdAt,
    hasIdNo: !!p.idNo,
  });

  /**
   * 統編唯一（R5 的一半，DB 另有 partial unique index 當最後防線）：
   * 先查再擋是為了把 23505 的英文約束名換成「撞到誰、該去哪裡處理」的句子。
   */
  async function assertTaxIdAvailable(taxId: string, excludeId?: number) {
    const [dup] = await db
      .select({ id: schema.partners.id, name: schema.partners.name })
      .from(schema.partners)
      .where(eq(schema.partners.taxId, taxId));
    if (dup && dup.id !== excludeId) {
      throw new AppError(
        409,
        "統一編號 {taxId} 已登記在「{name}」（#{id}）。同一家公司請直接用既有的那筆；若既有那筆建錯了，請先修改或清空它的統編",
        { taxId, name: dup.name, id: dup.id },
      );
    }
  }

  /** 業務負責人必須是在職員工：停用（離職）的員工不可再被指派到客戶上 */
  async function assertSalesOwnerActive(employeeId: number) {
    const [emp] = await db.select().from(schema.employees).where(eq(schema.employees.id, employeeId));
    if (!emp) throw new AppError(404, "員工不存在: {employeeId}（業務負責人請先在「客戶與商品」頁的員工區建立）", { employeeId });
    if (!emp.active) {
      throw new AppError(422, "員工「{name}」已停用，不可指派為業務負責人。請改指派在職員工，或先把他復職", { name: emp.name });
    }
  }

  app.post("/partners", zValidator("json", partnerInput), async (c) => {
    const body = c.req.valid("json");
    assertPartnerIdentity(body);
    if (body.taxId) await assertTaxIdAvailable(body.taxId);
    if (body.salesOwnerEmployeeId) await assertSalesOwnerActive(body.salesOwnerEmployeeId);
    const [row] = await db
      .insert(schema.partners)
      .values({
        name: body.name,
        taxId: body.taxId ?? null,
        idNo: encryptPii(body.idNo) ?? null,
        isCustomer: body.isCustomer,
        isSupplier: body.isSupplier,
        isIndividual: body.isIndividual,
        contactPerson: body.contactPerson ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
        address: body.address ?? null,
        shipToAddress: body.shipToAddress ?? null,
        paymentTermDays: body.paymentTermDays ?? null,
        creditLimit: body.creditLimit ?? null,
        salesOwnerEmployeeId: body.salesOwnerEmployeeId ?? null,
        note: body.note ?? null,
      })
      .returning();
    return c.json(publicPartner(row!), 201);
  });
  app.get("/partners", async (c) =>
    c.json((await db.select().from(schema.partners)).map(publicPartner)),
  );
  /**
   * 修改交易對象。之所以需要它（原本主檔只能新增）：扣繳支出單要求對象是「個人」，
   * 而被擋下來的人多半只是建檔時忘了勾——若唯一的出路是「另建一筆」，
   * 已經掛在原對象上的合約與單據就得跟著搬，那不是脫困指示而是刁難。
   */
  app.patch("/partners/:id", zValidator("json", partnerPatchInput), async (c) => {
    const id = idParam(c);
    const body = c.req.valid("json");
    const [target] = await db.select().from(schema.partners).where(eq(schema.partners.id, id));
    if (!target) throw new AppError(404, "交易對象不存在: {id}", { id });
    if (Object.keys(body).length === 0) {
      throw new AppError(
        400,
        "未提供要修改的欄位（可改：name、taxId、idNo、isCustomer、isSupplier、isIndividual、contactPerson、phone、email、address、shipToAddress、paymentTermDays、creditLimit、salesOwnerEmployeeId、note）",
      );
    }
    // 互斥檢查要用「改完之後」的狀態判斷：同一次請求可能一邊勾個人、一邊清統編。
    // 不能用 ?? 合併——body 送 null 的語意是「清空」，?? 會把它當成沒帶而回頭取舊值，
    // 於是「勾個人＋清統編」這條唯一的脫困路徑會永遠被自己的驗證擋住
    const merged = {
      isIndividual: body.isIndividual ?? target.isIndividual,
      taxId: body.taxId !== undefined ? body.taxId : target.taxId,
      idNo: body.idNo !== undefined ? body.idNo : target.idNo,
    };
    assertPartnerIdentity(merged);
    if (body.taxId != null && body.taxId !== target.taxId) await assertTaxIdAvailable(body.taxId, id);
    if (body.salesOwnerEmployeeId != null && body.salesOwnerEmployeeId !== target.salesOwnerEmployeeId) {
      await assertSalesOwnerActive(body.salesOwnerEmployeeId);
    }
    const [row] = await db
      .update(schema.partners)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.taxId !== undefined ? { taxId: body.taxId } : {}),
        ...(body.idNo !== undefined ? { idNo: encryptPii(body.idNo) ?? null } : {}),
        ...(body.isCustomer !== undefined ? { isCustomer: body.isCustomer } : {}),
        ...(body.isSupplier !== undefined ? { isSupplier: body.isSupplier } : {}),
        ...(body.isIndividual !== undefined ? { isIndividual: body.isIndividual } : {}),
        ...(body.contactPerson !== undefined ? { contactPerson: body.contactPerson } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.shipToAddress !== undefined ? { shipToAddress: body.shipToAddress } : {}),
        ...(body.paymentTermDays !== undefined ? { paymentTermDays: body.paymentTermDays } : {}),
        ...(body.creditLimit !== undefined ? { creditLimit: body.creditLimit } : {}),
        ...(body.salesOwnerEmployeeId !== undefined ? { salesOwnerEmployeeId: body.salesOwnerEmployeeId } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      })
      .where(eq(schema.partners.id, id))
      .returning();
    return c.json(publicPartner(row!));
  });
  /**
   * 清空個人識別欄位（改回法人、或使用者要求刪除自己的資料時的出口）。
   * 用 PATCH 送 null 也能做，但 zod 的 optional 語意下 null 與「沒帶」很容易混淆，
   * 這裡給一個意圖明確的端點——PII 的清除路徑不該靠猜。
   */
  app.delete("/partners/:id/id-no", async (c) => {
    const id = idParam(c);
    const [row] = await db
      .update(schema.partners)
      .set({ idNo: null })
      .where(eq(schema.partners.id, id))
      .returning();
    if (!row) throw new AppError(404, "交易對象不存在: {id}", { id });
    return c.json(publicPartner(row));
  });
  /**
   * 身分證統一編號的明文（PII）：單筆、需財務／管理者權限（見 auth.ts 的 RULES）。
   * 存在的理由是填各類所得憑單時要抄這個號碼；刻意不做成清單，
   * 這樣就沒有任何一支 API 會一次吐出全部人的身分證號。
   */
  app.get("/partners/:id/id-no", async (c) => {
    const id = idParam(c);
    const [row] = await db
      .select({ id: schema.partners.id, name: schema.partners.name, idNo: schema.partners.idNo })
      .from(schema.partners)
      .where(eq(schema.partners.id, id));
    if (!row) throw new AppError(404, "交易對象不存在: {id}", { id });
    // 全系統唯一會把這個欄位還原成明文的地方（寫入端見 encryptPii 的三個呼叫點）
    return c.json({ ...row, idNo: decryptPii(row.idNo) });
  });

  app.post("/products", zValidator("json", productInput), async (c) => {
    const body = c.req.valid("json");
    // SKU 撞號先查再擋：讓 unique index 去攔會回 500 internal error，使用者看到的是「系統壞了」
    const [dup] = await db
      .select({ id: schema.products.id, name: schema.products.name })
      .from(schema.products)
      .where(eq(schema.products.sku, body.sku));
    if (dup) {
      throw new AppError(409, "SKU {sku} 已存在（「{name}」#{id}）。同一項商品請直接用既有的那筆，或改用別的 SKU", { sku: body.sku, name: dup.name, id: dup.id });
    }
    const [row] = await db
      .insert(schema.products)
      .values({
        sku: body.sku,
        name: body.name,
        unit: body.unit,
        listPrice: body.listPrice ?? null,
        category: body.category ?? null,
        isService: body.isService ?? false,
        minStock: body.minStock ?? null,
        note: body.note ?? null,
      })
      .returning();
    return c.json(row, 201);
  });
  app.get("/products", async (c) => c.json(await db.select().from(schema.products)));
  /**
   * 修改商品（0022 起）：品名打錯、規格改版、定價調整都要有出路——之前連改名都不行（全 404）。
   * sku 一律不可改：它是使用者自己的編號規則，歷史單據與倉庫標籤都對著它。
   */
  app.patch("/products/:id", zValidator("json", productPatchInput), async (c) => {
    const id = idParam(c);
    const body = c.req.valid("json");
    if (body.sku !== undefined) {
      throw new AppError(400, "SKU 不可修改：歷史單據與倉庫標籤都對著它。打錯 SKU 請另建正確的商品，舊的那筆不再選用");
    }
    const [target] = await db.select().from(schema.products).where(eq(schema.products.id, id));
    if (!target) throw new AppError(404, "商品不存在: {id}", { id });
    if (Object.keys(body).length === 0) {
      throw new AppError(400, "未提供要修改的欄位（可改：name、unit、listPrice、category、isService、minStock、note）");
    }
    // 已有庫存的商品不可改成服務項目：帳上的存貨金額會變成永遠出不去的殭屍餘額
    if (body.isService === true && !target.isService) {
      const { qty } = await onHand(db, id);
      if (qty > 0) {
        throw new AppError(
          422,
          "「{name}」目前在庫 {qty} {unit}，不可改成服務項目（改了之後這批庫存再也無法出貨）。請先把在庫量出清或以退出處理，再改設定",
          { name: target.name, qty, unit: target.unit },
        );
      }
    }
    const [row] = await db
      .update(schema.products)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        ...(body.listPrice !== undefined ? { listPrice: body.listPrice } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.isService !== undefined ? { isService: body.isService } : {}),
        ...(body.minStock !== undefined ? { minStock: body.minStock } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      })
      .where(eq(schema.products.id, id))
      .returning();
    return c.json(row!);
  });

  // --- 會計科目維護（ACL：GET 任何登入者可讀＝各頁下拉；寫入限 accounts 頁＝admin/finance）---
  // 設計取捨：
  // 1. 沒有 DELETE。科目一旦入帳就必須永遠查得到名稱，刪除會讓歷史傳票變孤兒；「不用了」＝停用。
  // 2. 已有分錄的科目「可以」停用——停用只影響新單據的下拉選單，不動任何既有分錄，
  //    明細分類帳與報表照樣抓得到；反過來禁止停用才荒謬（用越久越不能整理科目表）。
  // 3. code 一律不可改（連沒入帳的也不行）：改碼會讓匯出給記帳士的歷史檔與帳上對不起來，
  //    而「打錯字」的正解是停用錯的、另開正確的，成本遠低於維護一套改碼連動。
  // 4. 代號首碼與類別必須一致（allowedTypesForCode）：type 決定報表歸屬與年度結轉是否結清，
  //    首碼只是給人看的分群——不一致不會有任何徵兆，只會讓該科目在損益表上默默消失。
  // 5. isCash 由使用者自行勾選，但限資產類：現金流量表與儀表板現金水位以此欄位取數，
  //    勾在負債或費用科目上算出來的「現金」沒有任何意義，只會讓報表對不起來。
  const newAccountInput = z.object({
    code: z
      .string()
      .regex(/^[1-8]\d{3}$/, "科目代號需為 4 碼數字，首碼 1-8（1 資產 2 負債 3 權益 4 收入 5 成本 6 費用 7 業外 8 所得稅）"),
    name: z.string().min(1),
    type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
    isCash: z.boolean().optional(),
  });

  /** 現金科目只能是資產類（現金流量表的取數依據） */
  function assertCashIsAsset(code: string, type: AccountType) {
    if (type !== "asset") {
      throw new AppError(
        400,
        "{code} 是{typeLabel}科目，不可設為現金科目：現金流量表與現金水位只取資產類的現金/銀行科目",
        { code, typeLabel: ACCOUNT_TYPE_LABEL[type] },
      );
    }
  }

  /**
   * 某科目的分錄筆數與餘額（借餘科目借正、貸餘科目貸正，與明細分類帳同一符號規則）。
   * 用 SQL 聚合而非撈回來 reduce：這支被 PATCH 每次呼叫，而 journal_lines 是全系統最大的表，
   * 一個記了幾年帳的科目可以有十萬筆分錄，全撈進記憶體只為了算兩個數字
   */
  async function accountEntryStats(accountId: number, type: AccountType) {
    const sign = type === "asset" || type === "expense" ? 1 : -1;
    // 轉 text 再由 JS 轉數字：debit/credit 各自是 integer，但跨筆 SUM 是 bigint——
    // 一家成立十年的公司光 4101 銷貨收入的累計就會超過 int4 上限，::int 會讓整支 PATCH 變成
    // 500 integer out of range（連「已有 N 筆分錄不可改類別」的 422 都到不了）。
    const [agg] = await db
      .select({
        count: sqlExpr<string>`count(*)::text`,
        net: sqlExpr<string>`coalesce(sum(${schema.journalLines.debit} - ${schema.journalLines.credit}), 0)::text`,
      })
      .from(schema.journalLines)
      .where(eq(schema.journalLines.accountId, accountId));
    return { count: Number(agg?.count ?? 0), balance: sign * Number(agg?.net ?? 0) };
  }

  app.post("/accounts", zValidator("json", newAccountInput), async (c) => {
    const body = c.req.valid("json");
    assertTypeMatchesCode(body.code, body.type);
    if (body.isCash) assertCashIsAsset(body.code, body.type);
    const [dup] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.code, body.code));
    if (dup) throw new AppError(409, "科目代號已存在: {code}", { code: body.code });
    const [row] = await db
      .insert(schema.accounts)
      .values({ code: body.code, name: body.name, type: body.type, isCash: body.isCash ?? false })
      .returning();
    return c.json(row!, 201);
  });
  const patchAccountInput = z.object({
    name: z.string().min(1).optional(),
    active: z.boolean().optional(),
    type: z.enum(["asset", "liability", "equity", "revenue", "expense"]).optional(),
    isCash: z.boolean().optional(),
    code: z.string().optional(), // 只為了給出「不可改碼」的明確訊息，不是真的接受
  });
  app.patch("/accounts/:id", zValidator("json", patchAccountInput), async (c) => {
    const id = Number(c.req.param("id"));
    const body = c.req.valid("json");
    if (body.code !== undefined) {
      throw new AppError(400, "科目代號不可修改：已入帳的分錄會對不起來。請停用舊科目後新增正確的科目");
    }
    const [target] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    if (!target) throw new AppError(404, "科目不存在: {id}", { id });
    if (body.name === undefined && body.active === undefined && body.type === undefined && body.isCash === undefined) {
      // drizzle 的 .set({}) 會丟 "No values to set"（500）——空 body 是使用者輸入問題，不是伺服器錯誤
      throw new AppError(400, "未提供要修改的欄位（可修改：name、active、type、isCash）");
    }
    if (body.active === false && target.isSystem) {
      throw new AppError(
        422,
        "{code} {name} 是系統科目，進銷貨/收付款/折舊/報銷/結轉的自動分錄直接指定它，停用會讓這些單據無法過帳",
        { code: target.code, name: target.name },
      );
    }
    // 類別可改，但僅限「還沒入過帳」：類別一改，該科目的歷史分錄會整批換一張報表出現
    // （費用→資產＝損益表憑空少一段、年度結轉也不再結清它）。實務上打錯類別幾乎都發生在剛建立、
    // 還沒入帳的當下，完全不給更正途徑比開放更糟——只能停用重建的代價是科目表堆一堆殭屍科目。
    if (body.type !== undefined && body.type !== target.type) {
      if (target.isSystem) {
        throw new AppError(
          422,
          "{code} {name} 是系統科目，自動分錄依它的類別決定借貸方向與報表歸屬，不可改類別",
          { code: target.code, name: target.name },
        );
      }
      assertTypeMatchesCode(target.code, body.type);
      const { count } = await accountEntryStats(id, target.type);
      if (count > 0) {
        throw new AppError(
          422,
          "{code} {name} 已有 {count} 筆分錄，不可改類別（改了會讓既有分錄整批換一張報表，歷史帳與已申報數字對不起來）。請停用後另建正確代號的科目",
          { code: target.code, name: target.name, count },
        );
      }
    }
    // 現金科目限資產類：以「改完之後」的類別判斷（同一次請求可能連類別一起改）
    if (body.isCash === true) assertCashIsAsset(target.code, body.type ?? target.type);
    const [row] = await db
      .update(schema.accounts)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.isCash !== undefined ? { isCash: body.isCash } : {}),
      })
      .where(eq(schema.accounts.id, id))
      .returning();

    const warnings: string[] = [];
    // 現值與代號首碼不符（交叉驗證上線前建的舊資料）：警告而不阻擋。
    // 曾經改成回 400，結果是「已入帳的錯配科目連改名都做不到」——送原類別撞 400、
    // 送正確類別撞 422（已有分錄），使用者被鎖死在一個修不了也整理不掉的科目上。
    // PATCH 的職責是套用被要求的變更，不該拿一個無關的既有缺陷去擋改名或停用。
    const allowed = allowedTypesForCode(row!.code);
    if (allowed.length > 0 && !allowed.includes(row!.type)) {
      warnings.push(
        `${row!.code} ${row!.name} 目前的類別（${ACCOUNT_TYPE_LABEL[row!.type]}）與代號首碼不符，` +
          `應為 ${allowed.map((t) => ACCOUNT_TYPE_LABEL[t]).join(" 或 ")}。` +
          `這個科目的金額在損益表／資產負債表上會歸錯區，年度結轉也可能不結清它——` +
          `尚未入帳的話請直接改類別，已入帳的請停用後另建正確代號的科目`,
      );
    }
    // 停用有餘額的科目不阻擋（整理科目表是正當需求，且餘額還在資產負債表上），但要講出來：
    // 停用後這個科目不會再出現在下拉選單，餘額只能靠手工傳票轉出。
    if (body.active === false) {
      const { balance } = await accountEntryStats(id, row!.type);
      if (balance !== 0) {
        warnings.push(
          `${row!.code} ${row!.name} 停用時仍有餘額 ${balance.toLocaleString("zh-TW")} 元。` +
            `餘額不會消失（報表照樣列示），但此科目已不再出現在傳票與收付款的下拉選單，` +
            `若要把餘額轉到別的科目，請先開一張手工傳票再停用`,
        );
      }
    }
    // 種子科目的 is_cash 由 seedAccounts() 每次啟動校正回 core 的定義，改了會在下次重啟被蓋掉。
    // 不擋（要試就讓他試），但一定要說，否則使用者會以為設定生效、幾天後報表又變回去卻查不出原因。
    if (body.isCash !== undefined && SEED_CODES.has(row!.code) && row!.isCash !== CASH_ACCOUNT_CODES.includes(row!.code)) {
      warnings.push(
        `${row!.code} ${row!.name} 是預設科目表內建的科目，它的「現金科目」設定會在下次系統啟動時` +
          `校正回預設值（${CASH_ACCOUNT_CODES.includes(row!.code) ? "現金科目" : "非現金科目"}）。` +
          `要自訂現金帳戶請另建一個科目（例如 1104 銀行存款－玉山）並勾選現金科目`,
      );
    }
    return warnings.length ? c.json({ ...row!, warning: warnings.join("　") }) : c.json(row!);
  });
  // 預設只回啟用中的科目：各頁下拉選單（傳票、收付款、報銷）不該再選到已停用的科目。
  // includeInactive=1 給科目維護頁與明細分類帳用——查歷史必須看得到當時用的停用科目。
  app.get("/accounts", async (c) => {
    const includeInactive = c.req.query("includeInactive") === "1";
    const rows = await db
      .select()
      .from(schema.accounts)
      .where(includeInactive ? undefined : eq(schema.accounts.active, true))
      .orderBy(asc(schema.accounts.code));
    return c.json(rows);
  });

  app.post("/purchases", zValidator("json", purchaseDocInput), async (c) => {
    return c.json(await createPurchase(db, c.req.valid("json")), 201);
  });
  // 清單篩選分頁（R3）：from/to（單據日）＋partnerId＋limit/offset，總筆數在 X-Total-Count。
  // 新到舊排序——原本沒有 orderBy，作廢一張之後整個順序還會漂移
  app.get("/purchases", async (c) => {
    const f = listQuery(c);
    const where = and(
      f.from ? gte(schema.purchases.docDate, f.from) : undefined,
      f.to ? lte(schema.purchases.docDate, f.to) : undefined,
      f.partnerId ? eq(schema.purchases.partnerId, f.partnerId) : undefined,
    );
    const [agg] = await db.select({ total: count() }).from(schema.purchases).where(where);
    setTotalCount(c, agg!.total);
    return c.json(
      await db.select().from(schema.purchases).where(where)
        .orderBy(desc(schema.purchases.id)).limit(f.limit).offset(f.offset),
    );
  });
  // 作廢進貨單（0025，B4；限 admin/finance，見 auth.ts RULES）：反向傳票＋庫存沖出＋
  // 採購單收貨量退回。有退出單、期間已關、在庫不足都會 409 並指路
  app.post("/purchases/:id/void", zValidator("json", voidReasonOnly), async (c) => {
    return c.json(await voidPurchase(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });

  app.post("/sales", zValidator("json", saleDocInput), async (c) => {
    return c.json(await createSale(db, c.req.valid("json")), 201);
  });
  // 清單篩選分頁（R3）：形狀同 /purchases
  app.get("/sales", async (c) => {
    const f = listQuery(c);
    const where = and(
      f.from ? gte(schema.sales.docDate, f.from) : undefined,
      f.to ? lte(schema.sales.docDate, f.to) : undefined,
      f.partnerId ? eq(schema.sales.partnerId, f.partnerId) : undefined,
    );
    const [agg] = await db.select({ total: count() }).from(schema.sales).where(where);
    setTotalCount(c, agg!.total);
    return c.json(
      await db.select().from(schema.sales).where(where)
        .orderBy(desc(schema.sales.id)).limit(f.limit).offset(f.offset),
    );
  });
  // 作廢銷貨單（0025，B4；限 admin/finance）：僅限「未開發票或發票已作廢」的單——
  // 有 issued 發票要先到電子發票頁作廢發票（那條路本來就能連動沖銷）
  app.post("/sales/:id/void", zValidator("json", voidReasonOnly), async (c) => {
    return c.json(await voidSale(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });
  // 單筆銷貨單（B5）：列印出貨單／銷貨單、B2C 證明聯拆算未稅額都要它——
  // 之前只有清單，連「這張單出了什麼給誰」都查不到，遑論印出來給倉庫與客戶簽收
  app.get("/sales/:id", async (c) => c.json(await saleDetail(db, idParam(c))));
  // 零稅率證明文件補登（0028，B12）：出口報單／外匯證明幾乎一定在建單後才拿得到。
  // 系統不驗證文件真偽，只登錄號碼；非零稅率／已作廢的單服務層會擋
  app.patch(
    "/sales/:id/zero-tax-cert",
    zValidator("json", z.object({ certNo: z.string().trim().min(1, "證明文件號碼不可為空").max(50) })),
    async (c) => c.json(await updateSaleZeroTaxCert(db, idParam(c), c.req.valid("json"))),
  );

  // --- 銷貨退回／折讓、進貨退出／折讓（帳務面）---
  // 入口掛在來源單據上（POST /sales/:id/returns），不新增 PageKey：使用者手上握的是那張原單，
  // 原單資訊自動帶入、退回量不會超過原量、成本對應得到原明細，錯誤在輸入端就被擋掉。
  // kind：return＝貨退回來了（動庫存與成本）；allowance＝貨沒退但要少收錢（只動收入與稅）
  const returnInput = z
    .object({
      kind: z.enum(["return", "allowance"]),
      docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      certDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      certNo: z.string().trim().min(1).max(50).optional(),
      memo: z.string().optional(),
      settlement: z.enum(["auto", "cash"]).optional(),
      cashAccountId: z.number().int().positive().optional(),
      lines: z
        .array(
          z.object({
            sourceLineId: z.number().int().positive(),
            qty: z.number().positive().optional(),
            amount: z.number().int().positive().optional(),
          }),
        )
        .min(1),
    })
    .refine((v) => v.settlement !== "cash" || v.cashAccountId !== undefined, {
      message: "當場退款需指定現金科目（cashAccountId）",
    });

  app.post("/sales/:id/returns", zValidator("json", returnInput), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    assertCashSettlementAllowed(user, body);
    return c.json(await createSaleReturn(db, idParam(c), body, user.id), 201);
  });
  app.get("/sales/:id/returnable", async (c) => c.json(await saleReturnable(db, idParam(c))));
  app.get("/sales-returns", async (c) => c.json(await listSaleReturns(db)));

  // 折讓證明單 XML 單張下載（G0401，第二批）：與 /invoices/:id/xml 同一套習慣——
  // content-disposition 帶 MIG 慣例檔名（G0401-<證明單號碼>.xml），拿去 Turnkey 上傳不用改名。
  // 檔名純 ASCII（號碼在服務層驗過字元集），不需 RFC 5987 編碼。產不出來的每一種情況
  // 都回 422＋下一步（缺號碼/日期、退回單、原發票未開立或已作廢）
  app.get("/sales-returns/:id/g0401-xml", async (c) => {
    const { fileName, xml } = await saleAllowanceG0401(db, idParam(c));
    return c.text(xml, 200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
    });
  });

  // 證明單補登（B11b）：證明單一定是退貨入帳後才在外面開立，建單時那兩欄幾乎注定是空的。
  // 沒有這條 PATCH，「缺證明單 N 筆」的計數器永遠歸不了零，退回也永遠進不了 401 減項
  const certInput = z.object({
    certNo: z.string().trim().min(1, "證明單號碼不可為空").max(50),
    certDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "證明單日期格式須為 YYYY-MM-DD").optional(),
  });
  app.patch("/sales-returns/:id", zValidator("json", certInput), async (c) => {
    return c.json(await updateReturnCertificate(db, "sale", idParam(c), c.req.valid("json")));
  });
  // 作廢銷貨退回／折讓單（0030；限 admin/finance，見 auth.ts RULES）：反向傳票＋庫存反向回沖，
  // returnable 餘量回復；已登錄證明單的折讓單作廢後改由 g0501-xml 產作廢訊息。
  // 不收 voidDate（與銷貨／進貨同一嚴格度）：docDate 與證明單歸期已關帳都 409
  app.post("/sales-returns/:id/void", zValidator("json", voidReasonOnly), async (c) => {
    return c.json(await voidSaleReturn(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });
  // 作廢折讓證明單 XML（G0501，0030）：已作廢且登錄過證明單的折讓單才有這份訊息——
  // 與 g0401-xml 同一套下載習慣（純 XML＋MIG 慣例檔名），產不出的每一種情況都 422 指路
  app.get("/sales-returns/:id/g0501-xml", async (c) => {
    const { fileName, xml } = await saleAllowanceG0501(db, idParam(c));
    return c.text(xml, 200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
    });
  });

  app.post("/purchases/:id/returns", zValidator("json", returnInput), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    assertCashSettlementAllowed(user, body);
    return c.json(await createPurchaseReturn(db, idParam(c), body, user.id), 201);
  });
  app.get("/purchases/:id/returnable", async (c) => c.json(await purchaseReturnable(db, idParam(c))));
  app.get("/purchase-returns", async (c) => c.json(await listPurchaseReturns(db)));
  app.patch("/purchase-returns/:id", zValidator("json", certInput), async (c) => {
    return c.json(await updateReturnCertificate(db, "purchase", idParam(c), c.req.valid("json")));
  });
  // 作廢進貨退出／折讓單（0030；限 admin/finance）：退出的貨按原成本補回、折讓的 1301 帳面回復
  app.post("/purchase-returns/:id/void", zValidator("json", voidReasonOnly), async (c) => {
    return c.json(await voidPurchaseReturn(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });

  app.get("/inventory", async (c) => c.json(await inventoryStatus(db)));
  // 庫存異動明細帳（R9，0035）：單一商品逐筆異動＋結存。權限與 /inventory 同（dashboard 頁）
  app.get("/inventory/movements", async (c) => {
    const productId = Number(c.req.query("productId"));
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new AppError(400, "缺少 productId 參數（正整數）——明細帳一次查一個商品");
    }
    const from = c.req.query("from");
    const to = c.req.query("to");
    for (const [name, v] of [["from", from], ["to", to]] as const) {
      if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new AppError(400, "{name} 須為 YYYY-MM-DD（收到「{v}」）", { name, v });
      }
    }
    return c.json(await inventoryMovementLedger(db, productId, from, to));
  });
  app.get("/trial-balance", async (c) => c.json(await trialBalance(db)));

  /**
   * 公司基本檔的對外形狀：白名單挑欄位（同 publicPartner 的理由——排除法在新增欄位時失敗開放）。
   * filerIdNo 是 PII：GET /company-profile 是「任何已登入者可讀」的參考資料，
   * 明文只走 /company-profile/filer-id-no（限財務／管理者），這裡只回「有沒有填」。
   */
  const publicCompany = (r: typeof schema.companyProfile.$inferSelect) => ({
    id: r.id,
    name: r.name,
    taxId: r.taxId,
    address: r.address,
    personInCharge: r.personInCharge,
    telephone: r.telephone,
    email: r.email,
    taxRegistrationNo: r.taxRegistrationNo,
    cityCode: r.cityCode,
    filerName: r.filerName,
    hasFilerIdNo: !!r.filerIdNo,
    filerAreaCode: r.filerAreaCode,
    filerPhone: r.filerPhone,
    filerExt: r.filerExt,
    declarationAgentNo: r.declarationAgentNo,
    vatMixedBusiness: r.vatMixedBusiness,
    updatedAt: r.updatedAt,
  });

  app.put("/company-profile", zValidator("json", companyInput), async (c) => {
    const body = c.req.valid("json");
    // 空字串＝清空（使用者把欄位刪光按儲存，意圖就是清掉）；filerIdNo 例外——
    // 畫面不回顯明文，空欄位的語意是「不改」，清空走專用的 DELETE 端點
    const clearable = (v: string | undefined) => (v === "" ? null : v);
    const values = {
      ...body,
      filerName: clearable(body.filerName),
      filerAreaCode: clearable(body.filerAreaCode),
      filerPhone: clearable(body.filerPhone),
      filerExt: clearable(body.filerExt),
      declarationAgentNo: clearable(body.declarationAgentNo),
      ...(body.filerIdNo !== undefined ? { filerIdNo: encryptPii(body.filerIdNo) ?? null } : {}),
    };
    const [row] = await db
      .insert(schema.companyProfile)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: schema.companyProfile.id, set: { ...values, updatedAt: new Date() } })
      .returning();
    return c.json(publicCompany(row!));
  });
  app.get("/company-profile", async (c) => {
    const [row] = await db.select().from(schema.companyProfile);
    if (!row) throw new AppError(404, "公司基本檔未設定");
    return c.json(publicCompany(row));
  });
  /** 申報人身分證統一編號明文（PII）：限財務／管理者（auth.ts RULES），全系統唯一的還原點 */
  app.get("/company-profile/filer-id-no", async (c) => {
    const [row] = await db.select().from(schema.companyProfile);
    if (!row) throw new AppError(404, "公司基本檔未設定");
    return c.json({ filerIdNo: decryptPii(row.filerIdNo) });
  });
  /** 清空申報人身分證統一編號：與 partners 的 id-no 同一個理由——PII 的清除路徑不該靠猜 */
  app.delete("/company-profile/filer-id-no", async (c) => {
    const [row] = await db
      .update(schema.companyProfile)
      .set({ filerIdNo: null, updatedAt: new Date() })
      .where(eq(schema.companyProfile.id, 1))
      .returning();
    if (!row) throw new AppError(404, "公司基本檔未設定");
    return c.json(publicCompany(row));
  });

  app.post("/invoice-tracks", zValidator("json", trackInput), async (c) => {
    const body = c.req.valid("json");
    // 期別驗證（B7）：配號永遠走 periodOf（雙月一期、奇數月起算），偶數月或不存在的月份
    // 建出來的區間是死資料——永遠配不出號，而使用者只會反覆懷疑系統壞了
    const month = Number(body.period.slice(4));
    if (month < 1 || month > 12 || month % 2 === 0) {
      throw new AppError(
        422,
        "期別 {period} 不是有效的發票期別：發票字軌以兩個月為一期、從奇數月起算，月份只能是 01、03、05、07、09、11（例如 202607 代表 7-8 月）。請改用該區間所屬期別的起始奇數月",
        { period: body.period },
      );
    }
    // 發票號碼固定 8 位：超過 8 位的區間每次開票都會在 XML 驗證炸掉，而且 rollback 後
    // 這組壞字軌永遠是「有餘號」的那筆，該期別從此開不出任何發票
    if (body.rangeEnd > 99999999) {
      throw new AppError(422, "迄號 {rangeEnd} 超過 8 位數：發票號碼固定 8 碼，起訖號須在 0 到 99999999 之間，請核對核准函上的號碼區間", { rangeEnd: body.rangeEnd });
    }
    if (body.rangeStart > body.rangeEnd) throw new AppError(422, "起號 {rangeStart} 大於迄號 {rangeEnd}，請核對後對調或修正", { rangeStart: body.rangeStart, rangeEnd: body.rangeEnd });
    // 撞號先查再擋（同 SKU／統編的做法）：讓 uq_track_range 去攔會回 500 internal error，
    // 使用者以為沒存進去而重按，得到的正是同一個 500
    const [dup] = await db
      .select({ id: schema.invoiceTracks.id })
      .from(schema.invoiceTracks)
      .where(
        and(
          eq(schema.invoiceTracks.period, body.period),
          eq(schema.invoiceTracks.track, body.track),
          eq(schema.invoiceTracks.rangeStart, body.rangeStart),
        ),
      );
    if (dup) {
      throw new AppError(
        409,
        "期別 {period} 字軌 {track} 起號 {rangeStart} 的區間已存在（#{id}）。若剛才按過一次「新增區間」，代表已建立成功，直接使用即可；要接續號碼請用新的起號",
        { period: body.period, track: body.track, rangeStart: body.rangeStart, id: dup.id },
      );
    }
    // 區間重疊也要擋（B7 尾款）：同期別同字軌的 1-50 與 30-80 建得進去的話，
    // 兩組會在配號時撞發票號碼 UNIQUE 而 500——同一個號碼被核准兩次在現實中不存在，
    // 幾乎一定是抄核准函時看錯行。與上面的「完全相同」分開回：那個是重按（409 直接使用），
    // 這個是資料錯（422 要人回去核對）
    const [overlap] = await db
      .select({
        id: schema.invoiceTracks.id,
        rangeStart: schema.invoiceTracks.rangeStart,
        rangeEnd: schema.invoiceTracks.rangeEnd,
      })
      .from(schema.invoiceTracks)
      .where(
        and(
          eq(schema.invoiceTracks.period, body.period),
          eq(schema.invoiceTracks.track, body.track),
          lte(schema.invoiceTracks.rangeStart, body.rangeEnd),
          gte(schema.invoiceTracks.rangeEnd, body.rangeStart),
        ),
      );
    if (overlap) {
      throw new AppError(
        422,
        "期別 {period} 字軌 {track} 的新區間 {rangeStart}-{rangeEnd} 與既有區間 #{id}（{oStart}-{oEnd}）重疊——同一個號碼不會被核准兩次，請核對核准函上的號碼區間。要接續號碼請從 {next} 起",
        { period: body.period, track: body.track, rangeStart: body.rangeStart, rangeEnd: body.rangeEnd, id: overlap.id, oStart: overlap.rangeStart, oEnd: overlap.rangeEnd, next: overlap.rangeEnd + 1 },
      );
    }
    const [row] = await db
      .insert(schema.invoiceTracks)
      .values({ ...body, nextNo: body.rangeStart })
      .returning();
    return c.json(row, 201);
  });
  app.get("/invoice-tracks", async (c) => c.json(await db.select().from(schema.invoiceTracks)));
  // 只允許刪「一張都還沒開」的區間（B7）：填錯期別／字軌／號碼的救濟途徑。
  // 配過號的區間是配號紀錄，刪了會讓已開發票的號碼失去來歷——只能逐張作廢已開的發票
  app.delete("/invoice-tracks/:id", async (c) => {
    const id = idParam(c);
    const [track] = await db.select().from(schema.invoiceTracks).where(eq(schema.invoiceTracks.id, id));
    if (!track) throw new AppError(404, "字軌區間不存在: {id}", { id });
    if (track.nextNo !== track.rangeStart) {
      throw new AppError(
        409,
        "期別 {period} 字軌 {track} 這組區間已配出 {used} 個號碼，不可刪除（區間是已開發票號碼的來歷紀錄）。開錯的發票請到「電子發票」頁逐張作廢；剩下的號碼不再使用即可",
        { period: track.period, track: track.track, used: track.nextNo - track.rangeStart },
      );
    }
    await db.delete(schema.invoiceTracks).where(eq(schema.invoiceTracks.id, id));
    return c.json({ ok: true, id });
  });

  app.post("/sales/:id/invoice", zValidator("json", issueInput), async (c) => {
    return c.json(await issueInvoice(db, Number(c.req.param("id")), c.req.valid("json")), 201);
  });
  // 清單白名單挑欄位（第一批覆核 recorded）：不含 xml/cancelXml——一張 F0401 幾 KB、
  // 一年幾千張，清單全列等於每次開頁面搬整個發票倉；檔案本身走單張端點
  // （GET /invoices/:id/xml、/invoices/:id/cancel-xml，帶 MIG 檔名）與批次匯出
  // 清單篩選分頁（R3）：from/to 對發票日期＋limit/offset（發票沒有 partnerId 欄，
  // 買受人請用發票上的 buyerTaxId／來源銷貨單過濾）。新到舊排序——原本沒有 orderBy，
  // 作廢一張之後順序還會漂移
  app.get("/invoices", async (c) => {
    const f = listQuery(c);
    if (f.partnerId !== undefined) {
      throw new AppError(400, "發票清單不支援 partnerId 篩選（發票記的是買受人統編，不是交易對象編號）；請改用 from/to 或由來源銷貨單查");
    }
    const where = and(
      f.from ? gte(schema.invoices.invoiceDate, f.from) : undefined,
      f.to ? lte(schema.invoices.invoiceDate, f.to) : undefined,
    );
    const [agg] = await db.select({ total: count() }).from(schema.invoices).where(where);
    setTotalCount(c, agg!.total);
    return c.json(
      await db
        .select({
          id: schema.invoices.id,
          saleId: schema.invoices.saleId,
          // 處分發票（0034）：saleId 與 assetId 恰有一個有值，前端據此分流（證明聯／連動作廢文案）
          assetId: schema.invoices.assetId,
          invoiceNumber: schema.invoices.invoiceNumber,
          invoiceDate: schema.invoices.invoiceDate,
          mode: schema.invoices.mode,
          buyerTaxId: schema.invoices.buyerTaxId,
          buyerName: schema.invoices.buyerName,
          salesAmount: schema.invoices.salesAmount,
          taxAmount: schema.invoices.taxAmount,
          totalAmount: schema.invoices.totalAmount,
          vatRateBp: schema.invoices.vatRateBp,
          taxType: schema.invoices.taxType,
          randomNumber: schema.invoices.randomNumber,
          printMark: schema.invoices.printMark,
          status: schema.invoices.status,
          cancelReason: schema.invoices.cancelReason,
          canceledAt: schema.invoices.canceledAt,
          carrierType: schema.invoices.carrierType,
          carrierId: schema.invoices.carrierId,
          donateMark: schema.invoices.donateMark,
          npoban: schema.invoices.npoban,
          createdAt: schema.invoices.createdAt,
        })
        .from(schema.invoices)
        .where(where)
        .orderBy(desc(schema.invoices.id))
        .limit(f.limit)
        .offset(f.offset),
    );
  });
  app.get("/invoices/:id/xml", async (c) => {
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, Number(c.req.param("id"))));
    if (!row) throw new AppError(404, "發票不存在");
    // content-disposition（B5）：這個端點的用途是「拿到能上傳 Turnkey 的檔案」，
    // 沒有它瀏覽器會 inline 顯示，使用者只能自己另存並手打檔名。檔名照 MIG 官方範例慣例；
    // 發票號碼是 2 大寫字母＋8 碼數字，純 ASCII，不需要 RFC 5987 編碼
    return c.text(row.xml, 200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="F0401-${row.invoiceNumber}.xml"`,
    });
  });
  // 作廢訊息的單張下載（與 F0401 同一套習慣；批次匯出也會帶，這裡是逐張要檔的入口）
  app.get("/invoices/:id/cancel-xml", async (c) => {
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, idParam(c)));
    if (!row) throw new AppError(404, "發票不存在");
    if (!row.cancelXml) {
      throw new AppError(422, "發票 {invoiceNumber} 未作廢，沒有 F0501 作廢訊息（作廢請在電子發票頁操作）", { invoiceNumber: row.invoiceNumber });
    }
    return c.text(row.cancelXml, 200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="F0501-${row.invoiceNumber}.xml"`,
    });
  });
  app.post(
    "/invoices/:id/cancel",
    zValidator(
      "json",
      z.object({
        reason: z.string().min(1),
        cancelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        cancelTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
        reverseSale: z.boolean().optional(),
        // 處分發票限定（0034）：連動沖回資產處分。旗標與發票來源對不上會 422（服務層把關）
        reverseDisposal: z.boolean().optional(),
      }),
    ),
    async (c) => {
      // userId 傳進去讓連動沖銷的銷貨單／處分留下 voided_by 軌跡（0025／0034）
      return c.json(await cancelInvoice(db, Number(c.req.param("id")), c.req.valid("json"), c.get("user").id));
    },
  );

  app.patch("/purchases/:id/supplier-invoice", zValidator("json", supplierInvoiceInput), async (c) => {
    const id = Number(c.req.param("id"));
    const body = c.req.valid("json");
    /**
     * 整段包成一個交易，並先取發票號碼的 advisory lock（與報銷側同一個鎖鍵空間，
     * 見 services/expenses.ts 的 lockInvoiceNumbers）。
     *
     * 原本這裡是**沒有交易**的 read-then-write：查重的 SELECT 與登錄的 UPDATE 是兩個各自獨立的
     * 語句，兩個並行請求（一邊登進貨、一邊送報銷）各自讀到「這張發票還沒人用」就都放行，
     * 同一張進項發票的稅額進 401 兩次＝少繳稅。0029 的 partial unique index 只擋得住
     * 進貨對進貨那一半，跨到 expense_items 的另一半沒有任何 DB 層防線。
     */
    return db.transaction(async (tx) => {
      // B13：這支端點不拋傳票，但 401 與進項媒體檔依進貨單日期歸期、讀的是當下的發票欄位——
      // 已關帳（可能已申報）期間補登供應商發票，等於無聲改掉該期的進項稅額。
      // 鎖的是進貨單日期（被改動數字的那一期），不是登錄動作的日期。
      const [purchase] = await tx.select().from(schema.purchases).where(eq(schema.purchases.id, id));
      if (!purchase) throw new AppError(404, "進貨單不存在: {id}", { id });
      // R20 之後 401 進項歸期優先吃 inv_date（無值退回 doc_date）：鎖帳要鎖「數字被改動的那幾期」——
      // 原本的有效歸期（已登錄過的單）與這次的新歸期都要開著，否則已申報期間仍會被無聲改寫
      const effectiveDates = new Set<string>([body.invDate ?? purchase.docDate]);
      if (purchase.invNo) effectiveDates.add(purchase.invDate ?? purchase.docDate);
      for (const d of effectiveDates) await assertPeriodOpen(tx, d);
      const invoiceNumber = `${body.track}${body.no}`;
      // 查重是 read-then-write：先把這個號碼鎖住，報銷側（prepareItems）取的是同一個鎖鍵
      await lockInvoiceNumbers(tx, [invoiceNumber]);
      // R5：同一供應商的同一張發票號碼只能登錄一次——兩張單都 200 的話，401 媒體檔
      // 出現兩筆同賣方同號碼的記錄、進項稅重複列報＝少繳稅。排除自己（改格式／改日期不換號碼）
      // 與已作廢的單（作廢重開沿用同號是正常出路）；未登錄（欄位空白）不擋。
      // DB 另有 partial unique index（0029）做最後防線
      const [dupInv] = await tx
        .select({ id: schema.purchases.id })
        .from(schema.purchases)
        .where(
          and(
            eq(schema.purchases.partnerId, purchase.partnerId),
            eq(schema.purchases.invTrack, body.track),
            eq(schema.purchases.invNo, body.no),
            isNull(schema.purchases.voidedAt),
            ne(schema.purchases.id, id),
          ),
        );
      if (dupInv) {
        throw new AppError(
          422,
          "這家供應商的發票 {track}{no} 已登錄在進貨單 #{id}——同一張發票登兩次會讓進項稅重複列報（少繳稅）。請核對號碼；若 #{id} 才是登錯的那張，先去修正或作廢它",
          { track: body.track, no: body.no, id: dupInv.id },
        );
      }
      // R5（反向，第四批）：報銷側建單時已查 purchases（expenses.ts assertInvoiceNotClaimed），
      // 這裡補上對稱的另一半——同一張發票先走報銷、再登進貨，一樣是進項稅重複列報。
      // 放行條件照報銷側：退回（rejected）／已作廢（0036）的報銷單不算數（登錯退回重報是正常出路）；
      // 兩邊賣方統編**都有值且不同**＝跨期重用的同號發票，不擋。任一邊沒統編就無從分辨，
      // 一律擋下並指路——寧可多按一次，也不讓重複列報無聲通過
      const [supplier] = await tx.select().from(schema.partners).where(eq(schema.partners.id, purchase.partnerId));
      const claimHits = await tx
        .select({ claimId: schema.expenseItems.claimId, sellerTaxId: schema.expenseItems.sellerTaxId })
        .from(schema.expenseItems)
        .innerJoin(schema.expenseClaims, eq(schema.expenseItems.claimId, schema.expenseClaims.id))
        .where(
          and(
            eq(schema.expenseItems.invoiceNumber, invoiceNumber),
            ne(schema.expenseClaims.status, "rejected"),
            isNull(schema.expenseClaims.voidedAt),
          ),
        );
      const dupClaim = claimHits.find((d) => !(supplier?.taxId && d.sellerTaxId && supplier.taxId !== d.sellerTaxId));
      if (dupClaim) {
        throw new AppError(
          422,
          "發票 {invoiceNumber} 已列報在報銷單 #{claimId}——同一張發票再登進貨會讓進項稅重複列報（少繳稅）。請核對號碼；若 #{claimId} 才是登錯的那張，請先退回它。確為不同賣方的同號發票，報銷明細補上賣方統編即可放行",
          { invoiceNumber, claimId: dupClaim.claimId },
        );
      }
      const [row] = await tx
        .update(schema.purchases)
        .set({
          invTrack: body.track,
          invNo: body.no,
          ...(body.format ? { invFormat: body.format } : {}),
          ...(body.deductionCode ? { deductionCode: body.deductionCode } : {}),
          ...(body.invDate ? { invDate: body.invDate } : {}),
        })
        .where(eq(schema.purchases.id, id))
        .returning();
      return c.json(row!);
    });
  });

  /** prevCarryForward 查詢參數：人工覆寫上期累積留抵（例如從舊系統帶進來的留抵） */
  const parsePrevCarryForward = (c: Context): number | undefined => {
    const raw = c.req.query("prevCarryForward");
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new AppError(422, "上期累積留抵須為非負整數元，收到「{raw}」——留抵不可能是負數或小數", { raw });
    }
    return n;
  };

  app.get("/vat-returns/401", async (c) => {
    const period = c.req.query("period");
    if (!period) throw new AppError(400, "缺少 period 參數（YYYYMM，奇數月）");
    return c.json(await generate401(db, period, { prevCarryForward: parsePrevCarryForward(c) }));
  });

  // 申報紀錄（0024）：存檔讓下一期自動承轉留抵。gm 唯讀由 authorize 統一擋（非 GET 一律 403）
  app.post(
    "/vat-returns/401/file",
    zValidator(
      "json",
      z.object({
        period: z.string().regex(/^\d{6}$/, "期別須為 YYYYMM（奇數月）"),
        prevCarryForward: z.number().int().nonnegative().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const user = c.get("user");
      return c.json(
        await fileReturn401(db, body.period, user.id, { prevCarryForward: body.prevCarryForward }),
        201,
      );
    },
  );
  app.get("/vat-returns/401/filings", async (c) => c.json(await listReturn401Filings(db)));
  app.delete("/vat-returns/401/filings/:period", async (c) => {
    const period = c.req.param("period");
    if (!/^\d{6}$/.test(period)) throw new AppError(400, "期別格式須為 YYYYMM: {period}", { period });
    return c.json(await deleteReturn401Filing(db, period));
  });

  // 記帳士匯出（Phase 4）：三種 CSV，回 JSON { name, content, rows } 由前端下載
  const exportQuery = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });
  app.get("/exports/journal", zValidator("query", exportQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json(await journalExport(db, from, to));
  });
  app.get("/exports/sales-invoices", zValidator("query", exportQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json(await salesInvoicesExport(db, from, to));
  });
  app.get("/exports/purchases", zValidator("query", exportQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json(await purchasesExport(db, from, to));
  });
  // 費用報銷明細（R12）：給記帳士對帳的第四種 CSV
  app.get("/exports/expense-claims", zValidator("query", exportQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json(await expenseClaimsExport(db, from, to));
  });
  // 電子發票 XML 批次（B5）：期間內全部 F0401＋已作廢者的 F0501，一包 JSON 由前端逐檔下載
  // （不打包 zip 的理由見 services/exports.ts 的 einvoiceXmlExport 檔頭）
  app.get("/exports/einvoice-xml", zValidator("query", exportQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json(await einvoiceXmlExport(db, from, to));
  });

  // 帳務完整性批次：手工傳票、收付款單、庫存開帳、財務報表
  const manualEntryInput = z.object({
    entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    memo: z.string().min(1),
    lines: z
      .array(
        z.object({
          accountCode: z.string().min(1),
          debit: z.number().int().nonnegative(),
          credit: z.number().int().nonnegative(),
          memo: z.string().optional(), // 行摘要（0038）：這一行在動什麼
        }),
      )
      .min(2),
  });
  app.post("/journal-entries", zValidator("json", manualEntryInput), async (c) => {
    return c.json(await createManualEntry(db, c.req.valid("json")), 201);
  });
  // 作廢手工傳票（0025，B4；限 admin/finance）：只收 source_type='manual'——
  // 系統拋轉的傳票要作廢其來源單據，訊息會指路
  app.post("/journal-entries/:id/void", zValidator("json", voidInput), async (c) => {
    return c.json(await voidManualEntry(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });
  // 清單篩選分頁（R3）：from/to 對傳票日期＋limit/offset；傳票沒有交易對象欄位
  app.get("/journal-entries", async (c) => {
    const f = listQuery(c);
    if (f.partnerId !== undefined) {
      throw new AppError(400, "傳票清單不支援 partnerId 篩選（傳票沒有交易對象欄位）；請改用 from/to 或明細分類帳");
    }
    const { rows, total } = await listJournalEntries(db, f);
    setTotalCount(c, total);
    return c.json(rows);
  });

  const cashDocInput = z.object({
    kind: z.enum(["receipt", "payment"]),
    partnerId: z.number().int().positive(),
    docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: z.number().int().positive(),
    accountId: z.number().int().positive(),
    memo: z.string().optional(),
    allocations: z
      .array(
        z.object({
          targetId: z.number().int().positive(),
          amount: z.number().int().positive(),
          // 未帶＝收款沖銷貨/付款沖進貨（舊行為）；'opening'＝沖期初應收付單（0023）
          targetType: z.enum(["sale", "purchase", "opening"]).optional(),
        }),
      )
      .optional(),
  });
  app.post("/cash-docs", zValidator("json", cashDocInput), async (c) => {
    return c.json(await createCashDoc(db, c.req.valid("json")), 201);
  });
  // 用預收/預付餘額沖銷後續單據（0027，B9）：生自己的傳票（借 2231 貸 1144／借 2144 貸 1212），
  // 沖用日受關帳鎖
  const applyPrepaidInput = z.object({
    applyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    allocations: z
      .array(
        z.object({
          targetId: z.number().int().positive(),
          amount: z.number().int().positive(),
          targetType: z.enum(["sale", "purchase", "opening"]).optional(),
        }),
      )
      .min(1),
  });
  app.post("/cash-docs/:id/apply-prepaid", zValidator("json", applyPrepaidInput), async (c) => {
    return c.json(await applyPrepaid(db, idParam(c), c.req.valid("json")), 201);
  });
  // 清單篩選分頁（R3）：形狀同 /sales（from/to 對收付款日）
  app.get("/cash-docs", async (c) => {
    const f = listQuery(c);
    const where = and(
      f.from ? gte(schema.cashDocs.docDate, f.from) : undefined,
      f.to ? lte(schema.cashDocs.docDate, f.to) : undefined,
      f.partnerId ? eq(schema.cashDocs.partnerId, f.partnerId) : undefined,
    );
    const [agg] = await db.select({ total: count() }).from(schema.cashDocs).where(where);
    setTotalCount(c, agg!.total);
    return c.json(
      await db.select().from(schema.cashDocs).where(where)
        .orderBy(desc(schema.cashDocs.id)).limit(f.limit).offset(f.offset),
    );
  });
  // 收付款單詳細（R6）：沖了哪幾張單、各沖多少、那些單現在還剩多少——
  // 立沖關係不再只在建立當下的回應看得到一次。權限走 auth.ts 既有的 cash-docs 規則（page: cash）
  app.get("/cash-docs/:id", async (c) => c.json(await getCashDoc(db, idParam(c))));
  // 作廢收付款單（0025，B4；限 admin/finance）：反向傳票沖現金與應收/應付，
  // 立沖紀錄保留但不再計入——被沖過的單據未沖餘額自動回復
  app.post("/cash-docs/:id/void", zValidator("json", voidInput), async (c) => {
    return c.json(await voidCashDoc(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });
  app.get("/partner-balances", async (c) => c.json(await partnerBalances(db)));
  app.get("/open-documents", async (c) => {
    const partnerId = Number(c.req.query("partnerId"));
    const kind = c.req.query("kind");
    if (!partnerId || (kind !== "receipt" && kind !== "payment")) {
      throw new AppError(400, "缺少 partnerId / kind（receipt|payment）參數");
    }
    // asOf 預設不帶（看當下全貌）；建立收付款單的畫面會帶上該單的日期，
    // 這樣勾選清單與服務層的驗證用同一個基準，不會出現「畫面能勾、送出被擋」
    const asOf = c.req.query("asOf");
    // 預收/預付餘額（0027，B9）以 docType 'prepaid' 分開列在同一份清單——
    // 不與未沖單據淨額互抵（分列才看得出「他欠我 X、我欠他 Y」，淨額會把兩個事實抵成一個假數字）
    const docs = await openDocuments(db, partnerId, kind, asOf);
    const prepaid = await prepaidDocs(db, partnerId, kind);
    return c.json([
      ...docs,
      ...prepaid.map((p) => ({
        docType: "prepaid" as const,
        id: p.id,
        docDate: p.docDate,
        total: p.unapplied,
        returned: 0,
        allocated: p.applied,
        fifoApplied: 0, // 預收/預付餘額不是可被沖銷的單據，FIFO 不會攤到它
        remaining: p.remaining,
      })),
    ]);
  });

  const openingInput = z.object({
    docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lines: z
      .array(
        z.object({
          productId: z.number().int().positive(),
          qty: z.number().positive(),
          unitCost: z.number().nonnegative(),
        }),
      )
      .min(1),
  });
  app.post("/inventory/opening", zValidator("json", openingInput), async (c) => {
    return c.json(await inventoryOpening(db, c.req.valid("json")), 201);
  });

  // --- 庫存調整單（0026，B8；限 admin/finance，見 auth.ts RULES）---
  // 盤盈／盤虧／報廢的入口：以當下移動平均成本計價、自動拋轉（盤盈借 1301 貸 7121、
  // 盤虧報廢借 7521 貸 1301）。在此之前庫存只能加不能減，過期報廢只能開手工傳票，
  // 總帳動了、庫存子帳一件未動，之後每張銷貨繼續用虛高的均價算成本
  const adjustmentInput = z.object({
    docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.enum(["count", "scrap", "expiry"]),
    memo: z.string().optional(),
    lines: z
      .array(
        z.object({
          productId: z.number().int().positive(),
          // 正數＝盤盈、負數＝盤虧／報廢；0 在服務層擋（那裡有品名可講人話）
          qtyDiff: z.number(),
        }),
      )
      .min(1),
  });
  app.post("/inventory/adjustments", zValidator("json", adjustmentInput), async (c) => {
    return c.json(await createInventoryAdjustment(db, c.req.valid("json"), c.get("user").id), 201);
  });
  app.get("/inventory/adjustments", async (c) => c.json(await listInventoryAdjustments(db)));
  // 作廢調整單（與 0025 各單據同一形狀）：反向傳票＋庫存以原成本反向回補；
  // 原單期間已關、盤盈的貨已賣掉（在庫不足）都會 409 並指路
  app.post("/inventory/adjustments/:id/void", zValidator("json", voidReasonOnly), async (c) => {
    return c.json(await voidInventoryAdjustment(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });

  // 盤點輔助：GET 底稿（現有品項＋帳面量，留空欄填實盤量）→ POST 實盤量整批建調整單。
  // 差異由**系統**算（實盤−帳面），不是使用者算——使用者算錯的方向永遠是「帳配合人」
  app.get("/inventory/stocktake", async (c) => c.json(await stocktakeSheet(db)));
  const stocktakeInput = z.object({
    docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    memo: z.string().optional(),
    lines: z
      .array(
        z.object({
          productId: z.number().int().positive(),
          countedQty: z.number().nonnegative(),
        }),
      )
      .min(1),
  });
  app.post("/inventory/stocktake", zValidator("json", stocktakeInput), async (c) => {
    const result = await createStocktake(db, c.req.valid("json"), c.get("user").id);
    // 全部一致＝沒建單，回 200 而不是 201（也不是錯誤——盤點結果一致是好事）
    return c.json(result, result.adjustment ? 201 : 200);
  });

  // 期初應收／應付單（0023，B6）：既有公司導入時把舊欠款建進子帳，
  // 自動拋轉傳票（應收＝借應收帳款、貸累積盈虧；應付反向），不進 401。限 admin/finance（auth.ts RULES）
  const openingBalanceInput = z.object({
    kind: z.enum(["receivable", "payable"]),
    partnerId: z.number().int().positive(),
    entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    amount: z.number().int().positive(),
    memo: z.string().optional(),
  });
  app.post("/opening-balances", zValidator("json", openingBalanceInput), async (c) => {
    return c.json(await createOpeningBalance(db, c.req.valid("json"), c.get("user").id), 201);
  });
  app.get("/opening-balances", async (c) => c.json(await listOpeningBalances(db)));
  // 作廢期初應收付單（0030；/opening-balances 整組已限 admin/finance）：反向傳票沖開帳分錄；
  // 已被收付款單沖銷者懸空 409。期初單不按期間申報，比照收付款單收 voidDate（跨期沖轉可行）
  app.post("/opening-balances/:id/void", zValidator("json", voidInput), async (c) => {
    return c.json(await voidOpeningBalance(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });

  app.get("/reports/balance-sheet", async (c) => {
    const asOf = c.req.query("asOf");
    if (!asOf) throw new AppError(400, "缺少 asOf 參數（YYYY-MM-DD）");
    return c.json(await balanceSheet(db, asOf));
  });
  app.get("/reports/income-statement", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) throw new AppError(400, "缺少 from/to 參數（YYYY-MM-DD）");
    return c.json(await incomeStatement(db, from, to));
  });

  // 員工費用報銷＋合約管理
  app.post("/employees", zValidator("json", employeeInput), async (c) => {
    const body = c.req.valid("json");
    const [row] = await db
      .insert(schema.employees)
      .values({
        name: body.name,
        title: body.title ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
        hireDate: body.hireDate ?? null,
        note: body.note ?? null,
        // 0040 修補：0039 讓 employeeInput 收這四欄卻沒寫進 insert——收了就丟，
        // 簽核鏈永遠取不到主管（「說了卻沒做」trap 的又一例）
        departmentId: body.departmentId ?? null,
        managerEmployeeId: body.managerEmployeeId ?? null,
        ...(body.employmentType !== undefined ? { employmentType: body.employmentType } : {}),
        ...(body.punchExempt !== undefined ? { punchExempt: body.punchExempt } : {}),
      })
      .returning();
    return c.json(row, 201);
  });
  app.get("/employees", async (c) => c.json(await db.select().from(schema.employees)));

  // --- HR 出勤（0039）：部門／班別／排班／打卡（設計紀律見 migration 檔頭與 services/attendance.ts）---
  app.get("/departments", async (c) => c.json(await listDepartments(db)));
  const departmentInput = z.object({
    name: z.string().min(1),
    parentId: z.number().int().positive().nullable().optional(),
    managerEmployeeId: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional(),
  });
  app.post("/departments", zValidator("json", departmentInput), async (c) => {
    const [row] = await db.insert(schema.departments).values(c.req.valid("json")).returning();
    return c.json(row!, 201);
  });
  app.patch("/departments/:id", zValidator("json", departmentInput.partial()), async (c) => {
    const id = idParam(c);
    const body = c.req.valid("json");
    if (Object.keys(body).length === 0) throw new AppError(400, "未提供要修改的欄位");
    if (body.parentId === id) throw new AppError(422, "部門不能是自己的上級");
    const [row] = await db.update(schema.departments).set(body).where(eq(schema.departments.id, id)).returning();
    if (!row) throw new AppError(404, "部門不存在: {id}", { id });
    return c.json(row);
  });

  const timeStr = z.string().regex(/^\d{2}:\d{2}$/, "時間格式須為 HH:MM");
  const shiftInput = z.object({
    code: z.string().min(1).max(10),
    name: z.string().min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    startTime: timeStr,
    endTime: timeStr, // 小於 startTime＝跨日班（刻意允許）
    breaks: z.array(z.object({ start: timeStr, end: timeStr })).max(4).optional(),
    dayCutoff: timeStr.optional(),
    active: z.boolean().optional(),
    note: z.string().optional(),
  });
  app.get("/shifts", async (c) => c.json(await db.select().from(schema.shifts).orderBy(schema.shifts.code)));
  app.post("/shifts", zValidator("json", shiftInput), async (c) => {
    const body = c.req.valid("json");
    const [dup] = await db.select({ id: schema.shifts.id }).from(schema.shifts).where(eq(schema.shifts.code, body.code));
    if (dup) throw new AppError(409, "班別代碼已存在: {code}", { code: body.code });
    const [row] = await db.insert(schema.shifts).values({ ...body, breaks: body.breaks ?? [] }).returning();
    return c.json(row!, 201);
  });
  app.patch("/shifts/:id", zValidator("json", shiftInput.partial().omit({ code: true })), async (c) => {
    // 代碼不可改（排班與歷史打卡的歸屬都對著它）——與 SKU、科目代號同一條紀律
    const id = idParam(c);
    const body = c.req.valid("json");
    if (Object.keys(body).length === 0) throw new AppError(400, "未提供要修改的欄位（班別代碼不可改）");
    const [row] = await db.update(schema.shifts).set(body).where(eq(schema.shifts.id, id)).returning();
    if (!row) throw new AppError(404, "班別不存在: {id}", { id });
    return c.json(row);
  });

  app.get("/schedules", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) throw new AppError(400, "缺少 from/to 參數（YYYY-MM-DD）");
    return c.json(await scheduleBoard(db, from, to));
  });
  app.post(
    "/schedules",
    zValidator(
      "json",
      z.object({
        employeeIds: z.array(z.number().int().positive()).min(1).max(100),
        shiftId: z.number().int().positive(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        weekdays: z.array(z.number().int().min(1).max(7)).optional(),
        note: z.string().optional(),
      }),
    ),
    async (c) => c.json(await setSchedules(db, c.req.valid("json")), 201),
  );
  app.delete("/schedules/:id", async (c) => {
    // 排班是計畫不是單據：可刪（打卡紀錄才是事實，不因刪排班而消失）
    const [row] = await db.delete(schema.schedules).where(eq(schema.schedules.id, idParam(c))).returning();
    if (!row) throw new AppError(404, "這一天沒有排班");
    return c.json({ ok: true });
  });

  /** 打卡：身分取自 session（不收 employeeId——打卡永遠打自己的） */
  app.post(
    "/attendance/punch",
    zValidator("json", z.object({ direction: z.enum(["in", "out"]), memo: z.string().max(200).optional() })),
    async (c) => {
      const me = c.get("user");
      if (me.employeeId === null) {
        throw new AppError(422, "你的帳號沒有連結員工主檔，無法打卡。請管理者在「設定 → 使用者管理」連結員工");
      }
      const body = c.req.valid("json");
      const row = await punch(db, {
        employeeId: me.employeeId,
        direction: body.direction,
        sourceIp: clientSource(c),
        memo: body.memo,
      });
      return c.json(row, 201);
    },
  );
  app.get("/attendance/my", async (c) => {
    const me = c.get("user");
    if (me.employeeId === null) return c.json({ today: null, punches: [], schedule: [], notLinked: true });
    return c.json(await myAttendance(db, me.employeeId));
  });
  app.get("/attendance/punches", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) throw new AppError(400, "缺少 from/to 參數（YYYY-MM-DD）");
    const employeeId = c.req.query("employeeId");
    return c.json(await listPunches(db, { from, to, employeeId: employeeId ? Number(employeeId) : undefined }));
  });
  app.get("/attendance/settings", async (c) => c.json(await getAttendanceSettings(db)));
  app.put(
    "/attendance/settings",
    zValidator(
      "json",
      z.object({
        ipAllowlist: z.string().max(2000).optional(),
        flexMinutes: z.number().int().min(0).max(240).optional(),
        lateEarlyMode: z.enum(["schedule", "shortfall"]).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const [row] = await db
        .update(schema.attendanceSettings)
        .set({ ...body, updatedAt: new Date(), updatedBy: c.get("user").id })
        .where(eq(schema.attendanceSettings.id, 1))
        .returning();
      return c.json(row!);
    },
  );

  // --- 假別／額度帳／申請簽核／行事曆（0040）＋月彙總（設計紀律見 services/hr-leave.ts）---
  app.get("/leave-types", async (c) => c.json(await listLeaveTypes(db)));
  const leaveTypeInput = z.object({
    code: z.string().min(1).max(20).regex(/^[a-z0-9_]+$/, "代碼限小寫英數與底線"),
    name: z.string().min(1),
    // 給薪比率不預填：這是勞基法數字，使用者自己查證後填入（NULL＝未填，算薪時明講不算）
    payRatioPercent: z.number().int().min(0).max(100).nullable().optional(),
    sourceNote: z.string().max(500).optional(),
    minUnitMinutes: z.number().int().min(1).max(480).optional(),
    note: z.string().max(500).optional(),
  });
  app.post("/leave-types", zValidator("json", leaveTypeInput), async (c) =>
    c.json(await createLeaveType(db, c.req.valid("json")), 201),
  );
  app.patch("/leave-types/:id", zValidator("json", leaveTypeInput.partial().omit({ code: true }).extend({ active: z.boolean().optional() })), async (c) => {
    const body = c.req.valid("json");
    if (Object.keys(body).length === 0) throw new AppError(400, "未提供要修改的欄位（假別代碼不可改）");
    return c.json(await patchLeaveType(db, idParam(c), body));
  });

  app.get("/leave-balances", async (c) => {
    const year = Number(c.req.query("year") ?? new Date().getFullYear());
    const employeeId = c.req.query("employeeId");
    return c.json(await listBalances(db, year, employeeId ? Number(employeeId) : undefined));
  });
  app.post(
    "/leave-balances",
    zValidator(
      "json",
      z.object({
        employeeId: z.number().int().positive(),
        leaveTypeId: z.number().int().positive(),
        year: z.number().int().min(2000).max(2100),
        grantedMinutes: z.number().int().min(0).max(600_000),
        note: z.string().max(500).optional(),
      }),
    ),
    async (c) => c.json(await grantBalance(db, c.req.valid("json"), c.get("user").id), 201),
  );
  /** 我的額度（打卡頁／申請表單用）：身分取自 session */
  app.get("/attendance/my-balances", async (c) => {
    const me = c.get("user");
    if (me.employeeId === null) return c.json([]);
    const year = Number(c.req.query("year") ?? new Date().getFullYear());
    return c.json(await listBalances(db, year, me.employeeId));
  });

  const hhmmStr = z.string().regex(/^\d{2}:\d{2}$/, "時刻格式須為 HH:MM");
  const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式須為 YYYY-MM-DD");
  app.post(
    "/hr-requests",
    zValidator(
      "json",
      z.object({
        kind: z.enum(["leave", "overtime", "punch_correction"]),
        reason: z.string().max(500).optional(),
        leaveTypeId: z.number().int().positive().optional(),
        startAt: z.string().datetime({ offset: true }).optional(),
        endAt: z.string().datetime({ offset: true }).optional(),
        minutes: z.number().int().min(1).max(31 * 24 * 60).optional(),
        dayType: z.enum(DAY_TYPES).optional(),
        workDate: dateStr.optional(),
        direction: z.enum(["in", "out"]).optional(),
        claimedTime: hhmmStr.optional(),
      }),
    ),
    async (c) => {
      const me = c.get("user");
      if (me.employeeId === null) {
        throw new AppError(422, "你的帳號沒有連結員工主檔，無法送出申請。請管理者在「設定 → 使用者管理」連結員工");
      }
      // 申請永遠是替自己申請（不收 employeeId 參數）——代客申請等於代簽到，不開這個口
      const row = await createRequest(db, { ...c.req.valid("json"), employeeId: me.employeeId }, me.id);
      return c.json(row, 201);
    },
  );
  app.get("/hr-requests/my", async (c) => {
    const me = c.get("user");
    if (me.employeeId === null) return c.json([]);
    return c.json(await myRequests(db, me.employeeId));
  });
  app.get("/hr-requests/pending-approvals", async (c) => {
    const me = c.get("user");
    if (me.employeeId === null) return c.json([]);
    return c.json(await pendingApprovals(db, me.employeeId));
  });
  app.get("/hr-requests", async (c) =>
    c.json(await listRequests(db, { status: c.req.query("status"), kind: c.req.query("kind") })),
  );
  const decideInput = z.object({ comment: z.string().max(200).optional() });
  app.post("/hr-requests/:id/approve", zValidator("json", decideInput), async (c) => {
    const me = c.get("user");
    return c.json(
      await decideStep(
        db,
        { requestId: idParam(c), action: "approve", comment: c.req.valid("json").comment },
        { userId: me.id, employeeId: me.employeeId, isAdmin: me.role === "admin" },
      ),
    );
  });
  app.post("/hr-requests/:id/reject", zValidator("json", decideInput), async (c) => {
    const me = c.get("user");
    return c.json(
      await decideStep(
        db,
        { requestId: idParam(c), action: "reject", comment: c.req.valid("json").comment },
        { userId: me.id, employeeId: me.employeeId, isAdmin: me.role === "admin" },
      ),
    );
  });
  app.post("/hr-requests/:id/cancel", async (c) => {
    const me = c.get("user");
    return c.json(await cancelRequest(db, idParam(c), me.employeeId));
  });

  app.get("/calendar-days", async (c) => {
    const year = Number(c.req.query("year") ?? new Date().getFullYear());
    return c.json(await listCalendar(db, year));
  });
  app.put(
    "/calendar-days",
    zValidator(
      "json",
      z.object({
        entries: z
          .array(z.object({ day: dateStr, kind: z.enum(["holiday", "makeup_workday"]), name: z.string().max(50).optional() }))
          .min(1)
          .max(400),
      }),
    ),
    async (c) => c.json(await setCalendarDays(db, c.req.valid("json").entries)),
  );
  app.delete("/calendar-days/:day", async (c) => {
    const day = c.req.param("day");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError(400, "日期格式須為 YYYY-MM-DD（收到「{day}」）", { day });
    return c.json(await deleteCalendarDay(db, day));
  });

  app.get("/attendance/summary", async (c) => {
    const month = c.req.query("month");
    if (!month) throw new AppError(400, "缺少 month 參數（YYYY-MM）");
    return c.json(await monthlySummary(db, month));
  });

  // --- 薪資（0041）：薪資檔／加班費率／發薪作業（設計紀律見 services/payroll.ts）---
  app.get("/employee-salaries", async (c) => {
    const employeeId = c.req.query("employeeId");
    return c.json(await listSalaries(db, employeeId ? Number(employeeId) : undefined));
  });
  app.post(
    "/employee-salaries",
    zValidator(
      "json",
      z.object({
        employeeId: z.number().int().positive(),
        validFrom: dateStr,
        payType: z.enum(["monthly", "hourly"]),
        baseAmount: z.number().int().min(0).max(100_000_000),
        hourlyDivisor: z.number().int().min(1).max(10_000).nullable().optional(),
        mealAllowance: z.number().int().min(0).max(100_000_000).optional(),
        mealAllowanceInBase: z.boolean().optional(),
        laborInsEmployee: z.number().int().min(0).optional(),
        laborInsEmployer: z.number().int().min(0).optional(),
        healthInsEmployee: z.number().int().min(0).optional(),
        healthInsEmployer: z.number().int().min(0).optional(),
        pensionEmployer: z.number().int().min(0).optional(),
        sourceNote: z.string().max(500).optional(),
        note: z.string().max(500).optional(),
      }),
    ),
    async (c) => c.json(await createSalary(db, c.req.valid("json"), c.get("user").id), 201),
  );

  app.get("/overtime-rates", async (c) => c.json(await listOvertimeRates(db)));
  app.post(
    "/overtime-rates",
    zValidator(
      "json",
      z.object({
        dayType: z.enum(DAY_TYPES),
        fromMinutes: z.number().int().min(0).max(24 * 60),
        multiplierBp: z.number().int().min(1).max(100_000),
        // 「以固定時數計」：例假日 0-8 小時一律以 8 小時計酬（做 6 給 8）的形狀
        fixedMinutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
        sourceNote: z.string().max(500).optional(),
      }),
    ),
    async (c) => c.json(await createOvertimeRate(db, c.req.valid("json")), 201),
  );
  app.delete("/overtime-rates/:id", async (c) => c.json(await deleteOvertimeRate(db, idParam(c))));

  app.get("/payroll-runs", async (c) => c.json(await listRuns(db)));
  app.post(
    "/payroll-runs",
    zValidator("json", z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, "月份格式須為 YYYY-MM") })),
    async (c) => c.json(await createRun(db, c.req.valid("json").month, c.get("user").id), 201),
  );
  app.get("/payroll-runs/:id", async (c) => c.json(await getRun(db, idParam(c))));
  app.post("/payroll-runs/:id/recalc", async (c) => c.json(await recalcRun(db, idParam(c))));
  app.post("/payroll-runs/:id/finalize", async (c) => c.json(await finalizeRun(db, idParam(c), c.get("user").id)));
  app.patch(
    "/payroll-items/:id",
    zValidator(
      "json",
      z.object({
        otherEarning: z.number().int().min(0).max(100_000_000).optional(),
        otherDeduction: z.number().int().min(0).max(100_000_000).optional(),
        memo: z.string().max(200).optional(),
      }),
    ),
    async (c) => c.json(await patchItem(db, idParam(c), c.req.valid("json"))),
  );

  // --- 內建 agent（Phase 1，DECISIONS 2026-08-13）：聊天 → tool-use 迴圈 → 打自己的 API ---
  // 工具執行以「目前登入者」身分對本 app 內部發請求：ACL 與操作日誌原樣生效，零新增。
  // 工具集只有讀取與草稿類寫入（紅線見 services/agent-chat.ts 檔頭）。
  app.post(
    "/agent/chat",
    zValidator(
      "json",
      z.object({
        messages: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }))
          .min(1)
          .max(40),
      }),
    ),
    async (c) => {
      const me = c.get("user");
      const llm = opts?.agentLlm ?? (await resolveLlm(db));
      const cookie = c.req.header("cookie");
      const authorization = c.req.header("authorization");
      const locale = localeOf(c);
      const result = await runAgentChat({
        llm,
        locale,
        // 內部請求走完整 middleware（認證→ACL→audit）；轉發原憑證＝以同一個人的身分
        api: async (path, init) => {
          const res = await app.request(path, {
            method: init?.method ?? "GET",
            headers: {
              ...(cookie ? { cookie } : {}),
              ...(authorization ? { authorization } : {}),
              "accept-language": locale, // agent 看到的錯誤訊息也要跟使用者同語言，它會照唸給人看
              ...(init?.body ? { "content-type": "application/json" } : {}),
            },
            ...(init?.body ? { body: init.body } : {}),
          });
          return { status: res.status, text: await res.text() };
        },
        // 記憶與指南：服務直呼不走 per-user ACL——公司記憶本來就是全員的 agent 共用；
        // 提議的落地仍是 proposed，生效要 admin 在設定頁核准（責任紅線同構）
        ops: {
          readMemory: (name) => readMemory(db, name),
          searchMemories: (q) => searchMemories(db, q),
          proposeMemory: async (input) => {
            const row = await createMemory(db, input, me.id, "proposed", "agent");
            return `已提議記憶「${row.name}」（${row.title}）。狀態：待核准——請管理者到「設定 → Agent 接入」核准後才會生效。`;
          },
          readGuide,
        },
        context: {
          featureMap: featureMapFor(me.role),
          memoryIndex: await memoryIndex(db),
          guideIndex: guideIndex(),
        },
        messages: c.req.valid("json").messages,
        user: { displayName: me.displayName, role: me.role },
      });
      return c.json(result);
    },
  );

  // --- 記憶管理（admin；設定頁）：agent 提議、人在這裡核准/編輯/封存 ---
  app.get("/agent-memories", async (c) => c.json(await listMemories(db, c.req.query("status"))));
  app.get("/agent-memories/stats", async (c) => c.json(await memoryStats(db)));
  const memoryInput = z.object({
    name: z.string().min(2).max(64),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
    type: z.string().max(30).optional(),
    tags: z.string().max(300).optional(),
    staleAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  });
  app.post("/agent-memories", zValidator("json", memoryInput), async (c) =>
    c.json(await createMemory(db, c.req.valid("json"), c.get("user").id, "active", "user"), 201),
  );
  app.patch("/agent-memories/:id", zValidator("json", memoryInput.partial().omit({ name: true })), async (c) => {
    const body = c.req.valid("json");
    if (Object.keys(body).length === 0) throw new AppError(400, "未提供要修改的欄位（記憶代號不可改）");
    return c.json(await updateMemory(db, idParam(c), body));
  });
  app.post("/agent-memories/:id/approve", async (c) => c.json(await approveMemory(db, idParam(c), c.get("user").id)));
  app.post("/agent-memories/:id/archive", async (c) => c.json(await archiveMemory(db, idParam(c))));
  app.delete("/agent-memories/:id", async (c) => c.json(await deleteMemory(db, idParam(c))));
  /**
   * 修改員工（0022 起）：改名（打錯字會永久寫進每一張傳票摘要）與停用（離職）。
   * B3 修的正是這裡——active 欄位與下游把關（expenses.ts 的 422、前端下拉的過濾）早就存在，
   * 但整個系統沒有任何一行會把 active 寫成 false，那些把關全是跑不到的死碼。
   * 停用不擋歷史：既有報銷單照樣查得到名字，只是不再出現在新單據的選項。
   */
  app.patch("/employees/:id", zValidator("json", employeePatchInput), async (c) => {
    const id = idParam(c);
    const body = c.req.valid("json");
    const [target] = await db.select().from(schema.employees).where(eq(schema.employees.id, id));
    if (!target) throw new AppError(404, "員工不存在: {id}", { id });
    if (Object.keys(body).length === 0) {
      throw new AppError(
        400,
        "未提供要修改的欄位（可改：name、title、phone、email、hireDate、note、active、departmentId、managerEmployeeId、employmentType、punchExempt）",
      );
    }
    if (body.managerEmployeeId != null && body.managerEmployeeId === id) {
      throw new AppError(422, "直屬主管不能是自己");
    }
    const [row] = await db
      .update(schema.employees)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.hireDate !== undefined ? { hireDate: body.hireDate } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        // 0040 修補：同 POST——0039 收了這四欄卻沒寫，簽核鏈取不到主管
        ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
        ...(body.managerEmployeeId !== undefined ? { managerEmployeeId: body.managerEmployeeId } : {}),
        ...(body.employmentType !== undefined ? { employmentType: body.employmentType } : {}),
        ...(body.punchExempt !== undefined ? { punchExempt: body.punchExempt } : {}),
      })
      .where(eq(schema.employees.id, id))
      .returning();
    return c.json(row!);
  });
  /**
   * 報銷分類：白話標籤與費用科目對應（**結構**，來自 core），
   * 加上「可扣抵性目前是誰說了算」（**稅法參數**，來自 tax_parameters）。
   *
   * 兩者一起回，是為了讓報銷頁能明白告訴使用者「這一類目前用的是系統預設，還是你自己設定的值」。
   * 只回一個布林值的話，畫面上「可扣抵」三個字看起來就像系統的判斷——而它不是。
   * onDate 未給＝以今天解析（清單是給使用者看現況用的；實際建單一律以報銷單日期解析）。
   */
  app.get("/expense-categories", async (c) => {
    const raw = c.req.query("onDate");
    if (raw !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new AppError(400, "onDate 須為 YYYY-MM-DD（收到「{raw}」）", { raw });
    }
    const onDate = raw ?? new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const cat of EXPENSE_CATEGORIES) {
      const rule = await resolveDeductible(db, cat.accountCode, onDate, cat.inputTaxDeductible);
      rows.push({
        ...cat,
        // inputTaxDeductible 保持「實際生效值」的語意（既有前端直接讀它判斷要不要勾可扣抵）；
        // 系統預設值另放 defaultDeductible，讓畫面能把兩者的差別講出來
        inputTaxDeductible: rule.deductible,
        defaultDeductible: cat.inputTaxDeductible,
        deductibleSource: rule.source,
        deductibleParameterId: rule.parameterId,
        deductibleSourceNote: rule.sourceNote,
        deductibleValidFrom: rule.validFrom,
        deductibleValidTo: rule.validTo,
      });
    }
    return c.json(rows);
  });
  /**
   * 賣方統編 → 歷史分類候選（W7）。**純確定性查詢，沒有任何推測**：
   * 掃完 QR 之後號碼／金額／日期／統編都帶好了，只剩「這筆是什麼」還要自己從下拉選，
   * 而選錯會連帶影響可扣抵性。這裡回的是「這家賣方，公司過去核准過的單最常歸到哪幾類」。
   *
   * 刻意不做成自動選中（畫面只當候選用）：同一家賣方可以橫跨伙食／福利／交際三個分類，
   * 決定的是用途，而用途不在發票裡。母體判準（哪些單算數）見 services/expenses.ts。
   * 每筆候選的 claimCount 是**幾張單這樣歸過**（不是幾筆明細）：一張單＝一次被公司接受的
   * 歸類決定，否則一張批次上傳的單就能壓過好幾張各自被核准的單。
   * 沒有歷史就回空陣列——冷啟動時不猜一個給使用者。
   */
  app.get("/expense-categories/suggestions", async (c) => {
    const sellerTaxId = c.req.query("sellerTaxId");
    // 形狀與建單時明細的 sellerTaxId 同一條（claimInput 的 /^\d{8}$/）：對不上就是打錯了，
    // 回 400 而不是靜靜回空陣列——空陣列會被讀成「這家店沒有歷史」
    if (!sellerTaxId || !/^\d{8}$/.test(sellerTaxId)) {
      throw new AppError(400, "sellerTaxId 須為 8 位數字（收到「{value}」）", { value: sellerTaxId ?? "" });
    }
    return c.json(await sellerCategorySuggestions(db, sellerTaxId));
  });

  const claimInput = z.object({
    employeeId: z.number().int().positive().optional(), // 僅財務/管理者可代他人報銷；其他角色一律本人
    claimDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    memo: z.string().optional(),
    // R13：'company'＝公司支付（公司卡／公司帳戶），核准時直接貸付款科目、狀態進 paid
    paidBy: z.enum(["employee", "company"]).optional(),
    items: z
      .array(
        z.object({
          accountCode: z.string().min(1),
          description: z.string().optional(),
          docType: z.enum(["einvoice", "receipt", "other"]),
          amount: z.number().int().positive(),
          deductible: z.boolean().optional(),
          // B4：收的是掃到的電子發票 QR 左碼**原文**，銷售額由伺服端自己解析（services/expenses.ts）。
          // 前一版收的是 salesAmount 這個數字，等於任何人都能把任意金額宣稱成進項稅
          //（amount 10000、salesAmount 0 → 稅額 10000 進 401）——稅額的信任邊界必須在伺服端。
          // 上限只擋離譜長度：左碼定長段只有 77 碼，之後的自行使用區與明細長度不由本系統決定。
          // nullable：退回重送時 null＝使用者把掃到的憑證拿掉了、undefined＝這次沒送這個欄位（沿用）
          qrPayload: z.string().max(4096, "QR 內容過長，這不像是電子發票證明聯的左碼").nullable().optional(),
          // 兩個稅額來源不一致時使用者指定的那一個：'voucher'＝憑證所載的銷售額回推、'rate'＝設定的稅率回推。
          // 刻意沒有預設值——有預設就等於系統替使用者選了一個他沒看到的數字進 401。
          // nullable 同上：null＝把上次選的清掉（重新問一次），與「沒送這個欄位」是兩件事
          taxSource: z.enum(["voucher", "rate"]).nullable().optional(),
          invoiceNumber: z.string().optional(),
          invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          sellerTaxId: z.string().regex(/^\d{8}$/).optional(),
          image: z.string().max(2_000_000, "影像過大，請壓縮後再上傳").optional(),
        }),
      )
      .min(1),
  });
  const canSeeAllClaims = (u: AuthUser) => u.role === "finance" || u.role === "admin" || u.role === "gm";
  app.post("/expense-claims", zValidator("json", claimInput), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const privileged = user.role === "finance" || user.role === "admin";
    const employeeId = privileged ? (body.employeeId ?? user.employeeId) : user.employeeId;
    if (!employeeId) throw new AppError(422, "帳號未連結員工主檔，請管理者在設定頁連結後再報銷");
    return c.json(await createClaim(db, { ...body, employeeId }), 201);
  });
  // 清單篩選分頁（R3）：from/to 對報銷單日期＋limit/offset＋status（R13）；
  // 員工可見範圍照舊（本人 vs 全部）
  app.get("/expense-claims", async (c) => {
    const user = c.get("user");
    const f = listQuery(c);
    if (f.partnerId !== undefined) {
      throw new AppError(400, "報銷清單不支援 partnerId 篩選（報銷掛的是員工，不是交易對象）；請改用 from/to");
    }
    const rawStatus = c.req.query("status");
    const statusParse = z.enum(["submitted", "approved", "rejected", "paid"]).optional().safeParse(rawStatus);
    if (!statusParse.success) {
      throw new AppError(400, "status 須為 submitted/approved/rejected/paid（收到「{rawStatus}」）", { rawStatus });
    }
    const { rows, total } = await listClaims(
      db,
      canSeeAllClaims(user) ? undefined : (user.employeeId ?? -1),
      f,
      statusParse.data,
    );
    setTotalCount(c, total);
    return c.json(rows);
  });
  // R13：「公司欠員工多少」——approved 未付、未作廢的報銷依員工彙總。
  // 全公司的欠款視角，只給看得到全部報銷單的角色（本人視角看清單就夠了）。
  // 必須註冊在 /expense-claims/:id 之前（否則 "payable-summary" 會被當成 :id 吃掉）
  app.get("/expense-claims/payable-summary", async (c) => {
    if (!canSeeAllClaims(c.get("user"))) throw new AppError(403, "此彙總需要財務、總經理或管理者權限");
    return c.json(await payableSummary(db));
  });
  app.get("/expense-claims/:id", async (c) => {
    const user = c.get("user");
    const claim = await getClaim(db, idParam(c));
    if (!canSeeAllClaims(user) && claim.employeeId !== user.employeeId) {
      throw new AppError(403, "只能查看自己的報銷單");
    }
    return c.json(claim);
  });
  // R12：單筆憑證影像的下載端點（記帳士要單獨拿一張收據；清單刻意不含影像避免 payload 過大）
  app.get("/expense-claims/:id/items/:itemId/image", async (c) => {
    const user = c.get("user");
    const { claim, fileName, image } = await getClaimItemImage(db, idParam(c), idParam(c, "itemId"));
    if (!canSeeAllClaims(user) && claim.employeeId !== user.employeeId) {
      throw new AppError(403, "只能查看自己的報銷單");
    }
    return c.json({ fileName, image });
  });
  // R11：退回的單可改明細後重送（rejected 專屬；本人或財務/管理者）
  app.patch("/expense-claims/:id", zValidator("json", claimInput.omit({ employeeId: true })), async (c) => {
    const user = c.get("user");
    const id = idParam(c);
    const claim = await getClaim(db, id);
    const privileged = user.role === "finance" || user.role === "admin";
    if (!privileged && claim.employeeId !== user.employeeId) {
      throw new AppError(403, "只能修改自己的報銷單");
    }
    return c.json(await resubmitClaim(db, id, c.req.valid("json")));
  });
  // 核准（R11：取登入者比對申請人、留 approved_by 痕）。
  // accountId 僅公司支付（paidBy='company'）的單需要：核准分錄直接貸這個付款科目
  app.post(
    "/expense-claims/:id/approve",
    zValidator("json", z.object({ accountId: z.number().int().positive().optional() })),
    async (c) => {
      return c.json(await approveClaim(db, idParam(c), c.get("user"), c.req.valid("json").accountId));
    },
  );
  app.post(
    "/expense-claims/:id/reject",
    zValidator("json", z.object({ reason: z.string().min(1) })),
    async (c) => {
      return c.json(await rejectClaim(db, idParam(c), c.req.valid("json").reason, c.get("user")));
    },
  );
  app.post(
    "/expense-claims/:id/pay",
    zValidator("json", z.object({ accountId: z.number().int().positive(), payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(await payClaim(db, idParam(c), body.accountId, body.payDate));
    },
  );
  // 作廢（0036，R11）：核准後發現打錯的唯一出路——手工反向傳票救得了總帳、救不了 401
  app.post("/expense-claims/:id/void", zValidator("json", z.object({ reason: z.string().min(1) })), async (c) => {
    return c.json(await voidExpenseClaim(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });

  const contractInput = z.object({
    partnerId: z.number().int().positive().optional(),
    counterparty: z.string().min(1),
    title: z.string().min(1),
    amount: z.number().int().nonnegative().optional(),
    signDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(["draft", "active", "ended", "terminated"]).optional(),
    memo: z.string().optional(),
    fileName: z.string().optional(),
    fileData: z.string().max(5_000_000, "附件過大（上限約 3.5MB）").optional(),
    // 0037：類型與續約提醒。kind 沿用四種已知值＋自由字串的逃生門會讓 UI 難做，
    // 先收四種；真的有第五種型態時 enum 再擴（text 欄位不需要 migration）
    kind: z.enum(CONTRACT_KINDS).optional(),
    // 0046：方向與 kind 正交——sale＝我方請款（銷貨側）、purchase＝我方付款（進貨側）
    direction: z.enum(["sale", "purchase"]).optional(),
    renewNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
  });
  app.post("/contracts", zValidator("json", contractInput), async (c) => {
    const body = c.req.valid("json");
    // R2：截止日早於生效日的合約會被前端當成「已逾期」計入頁首警示——
    // 一份還沒開始的合約被催著續約，當場擋下比事後追查省事
    assertDateOrder(
      { date: body.startDate, label: "合約生效日" },
      { date: body.endDate, label: "合約截止日" },
    );
    const [row] = await db.insert(schema.contracts).values(body).returning();
    return c.json(row, 201);
  });
  app.get("/contracts", async (c) => {
    const rows = await db.select().from(schema.contracts);
    // 清單不回附件內容，僅回有無；附件走 /contracts/:id/file
    return c.json(rows.map(({ fileData, ...rest }) => ({ ...rest, hasFile: !!fileData })));
  });

  // --- 合約請款計畫與續約（0037；顧問／軟體開發業的營收形狀）---
  //
  // 「待請款」要排在 /contracts/:id 類路由前面註冊，避免 billing-due 被當成 :id 吃掉
  // 快到期（0047）：逐約用自己的 renew_notice_days——同樣要排在 /contracts/:id 之前
  app.get("/contracts/expiring", async (c) =>
    c.json(await expiringContracts(db, new Date().toISOString().slice(0, 10))),
  );
  app.get("/contracts/billing-due", async (c) => {
    const within = Math.min(Number(c.req.query("within") ?? 30) || 30, 366);
    const today = new Date().toISOString().slice(0, 10);
    return c.json(await billingDue(db, today, within));
  });
  app.get("/contracts/:id/installments", async (c) => c.json(await listInstallments(db, idParam(c))));
  const installmentItem = z.object({
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: z.number().int().positive("金額必須是正整數（未稅、元）"),
    description: z.string().optional(),
  });
  app.post(
    "/contracts/:id/installments",
    zValidator("json", z.object({ items: z.array(installmentItem).min(1).max(60) })),
    async (c) => c.json(await addInstallments(db, idParam(c), c.req.valid("json").items), 201),
  );
  app.post(
    "/contracts/:id/installments/generate",
    zValidator(
      "json",
      z.object({
        monthlyAmount: z.number().int().positive(),
        dayOfMonth: z.number().int().min(1).max(31),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        description: z.string().optional(),
      }),
    ),
    async (c) => c.json(await generateSchedule(db, idParam(c), c.req.valid("json")), 201),
  );
  app.patch(
    "/contracts/:id/installments/:iid",
    zValidator("json", installmentItem.partial()),
    async (c) =>
      c.json(await updateInstallment(db, idParam(c), Number(c.req.param("iid")), c.req.valid("json"))),
  );
  app.delete("/contracts/:id/installments/:iid", async (c) => {
    await deleteInstallment(db, idParam(c), Number(c.req.param("iid")));
    return c.json({ ok: true });
  });
  app.post(
    "/contracts/:id/installments/:iid/bill",
    zValidator(
      "json",
      z.object({
        productId: z.number().int().positive(),
        docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        taxType: z.enum(["1", "2", "3"]).optional(),
        zeroTaxViaCustoms: z.boolean().optional(),
        zeroTaxCertNo: z.string().optional(),
      }),
    ),
    async (c) =>
      c.json(await billInstallment(db, idParam(c), Number(c.req.param("iid")), c.req.valid("json")), 201),
  );
  // 進貨側（0046）：勾對／解除勾對既有進貨單——不生成單據，只動計畫列的指標
  app.post(
    "/contracts/:id/installments/:iid/match",
    zValidator("json", z.object({ purchaseId: z.number().int().positive() })),
    async (c) =>
      c.json(await matchInstallment(db, idParam(c), Number(c.req.param("iid")), c.req.valid("json").purchaseId)),
  );
  app.post("/contracts/:id/installments/:iid/unmatch", async (c) =>
    c.json(await unmatchInstallment(db, idParam(c), Number(c.req.param("iid")))),
  );
  app.post(
    "/contracts/:id/renew",
    zValidator(
      "json",
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        amount: z.number().int().nonnegative().optional(),
        signDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      assertDateOrder(
        { date: body.startDate, label: "新約生效日" },
        { date: body.endDate, label: "新約截止日" },
      );
      return c.json(await renewContract(db, idParam(c), body), 201);
    },
  );
  // --- 週期性支出（0047）：每月/每季/每年固定要付的錢。設計紀律見 services/recurring-payables.ts ---
  // due 要排在 :id 類路由前面註冊，避免被當成 :id 吃掉（同 contracts/billing-due 的先例）
  app.get("/recurring-payables/due", async (c) => {
    const within = Math.min(Number(c.req.query("within") ?? 30) || 30, 366);
    return c.json(await payableDueList(db, new Date().toISOString().slice(0, 10), within));
  });
  app.get("/recurring-payables", async (c) => c.json(await listPayables(db)));
  const payableInput = z.object({
    name: z.string().min(1).max(100),
    partnerId: z.number().int().positive().nullable().optional(),
    defaultAccountCode: z.string().max(10).optional(),
    // 依據必填：系統不預設任何金額或頻率，這一欄是使用者自己查到的出處
    basis: z.string().min(1, "請填依據（這筆錢的來源：合約條款、帳單、你查到的規定）").max(500),
    // 週期只收「每 N 個月」的純數字——不提供任何以稅目/險種命名的範本（那本身就是斷言）
    intervalMonths: z.number().int().min(1).max(12),
    dayOfMonth: z.number().int().min(1).max(31),
    defaultAmount: z.number().int().min(0).max(1_000_000_000).optional(),
    startDate: dateStr,
    endDate: dateStr.nullable().optional(),
    memo: z.string().max(500).optional(),
  });
  app.post("/recurring-payables", zValidator("json", payableInput), async (c) =>
    c.json(await createPayable(db, c.req.valid("json"), c.get("user").id), 201),
  );
  app.patch(
    "/recurring-payables/:id",
    zValidator("json", payableInput.partial().extend({ status: z.enum(["active", "ended"]).optional() })),
    async (c) => c.json(await updatePayable(db, idParam(c), c.req.valid("json"))),
  );
  app.get("/recurring-payables/:id/items", async (c) => c.json(await listPayableItems(db, idParam(c))));
  app.post(
    "/recurring-payables/:id/items/generate",
    zValidator("json", z.object({ to: dateStr })),
    async (c) => c.json(await generatePayableItems(db, idParam(c), c.req.valid("json").to), 201),
  );
  app.patch(
    "/recurring-payables/:id/items/:iid",
    zValidator(
      "json",
      z.object({
        dueDate: dateStr.optional(),
        amount: z.number().int().positive().optional(),
        description: z.string().max(200).optional(),
      }),
    ),
    async (c) => c.json(await updatePayableItem(db, idParam(c), Number(c.req.param("iid")), c.req.valid("json"))),
  );
  app.delete("/recurring-payables/:id/items/:iid", async (c) => {
    await deletePayableItem(db, idParam(c), Number(c.req.param("iid")));
    return c.json({ ok: true });
  });
  // 結清＝把既有的報銷單或傳票指過來（不生成任何單據）；解除結清只動指標
  app.post(
    "/recurring-payables/:id/items/:iid/settle",
    zValidator(
      "json",
      z.object({
        expenseClaimId: z.number().int().positive().optional(),
        journalEntryId: z.number().int().positive().optional(),
      }),
    ),
    async (c) => c.json(await settlePayableItem(db, idParam(c), Number(c.req.param("iid")), c.req.valid("json"))),
  );
  app.post("/recurring-payables/:id/items/:iid/unsettle", async (c) =>
    c.json(await unsettlePayableItem(db, idParam(c), Number(c.req.param("iid")))),
  );

  app.get("/contracts/:id/file", async (c) => {
    const [row] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, Number(c.req.param("id"))));
    if (!row) throw new AppError(404, "合約不存在");
    if (!row.fileData) throw new AppError(404, "合約無附件");
    return c.json({ fileName: row.fileName, fileData: row.fileData });
  });
  /**
   * 修改合約（B4）：金額談錯、展期改截止日、改名都要有出路——原本只收 status/memo，
   * 送其他欄位會被 zod 靜默丟棄（單送 amount 得到 500 "No values to set"、
   * 混著 status 送則 200 但金額靜默不變，兩種都是說到做不到）。
   * 合約的「取消」是**終止**（status: terminated）不是作廢：簽過的合約是事實，不能當作沒發生。
   */
  app.patch("/contracts/:id", zValidator("json", contractInput.partial()), async (c) => {
    const id = idParam(c);
    const body = c.req.valid("json");
    if (Object.keys(body).length === 0) {
      // drizzle 的 .set({}) 會丟 "No values to set"（500）——空 body 是使用者輸入問題
      throw new AppError(
        400,
        "未提供要修改的欄位（可改：title、counterparty、partnerId、amount、signDate、startDate、endDate、status、memo、kind、direction、fileName、fileData）",
      );
    }
    // R2：先後檢查要用「改完之後」的狀態——單改 endDate 也要跟既有的 startDate 比
    const [existing] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, id));
    if (!existing) throw new AppError(404, "合約不存在: {id}", { id });
    // 0046：方向改錯要有出路，但已對上單據（含已作廢的指標）就不能翻面——
    // 銷貨單指標掛在進貨合約上是資料矛盾，翻面前先把各期的單據處理乾淨
    if (body.direction && body.direction !== existing.direction) {
      const linked = await db
        .select({ id: schema.contractInstallments.id })
        .from(schema.contractInstallments)
        .where(
          and(
            eq(schema.contractInstallments.contractId, id),
            or(isNotNull(schema.contractInstallments.saleId), isNotNull(schema.contractInstallments.purchaseId)),
          ),
        );
      if (linked.length) {
        throw new AppError(
          409,
          "這份合約已有 {n} 期對上單據，不能改方向。請先作廢銷貨單／解除勾對後再改",
          { n: linked.length },
        );
      }
    }
    assertDateOrder(
      { date: body.startDate ?? existing.startDate, label: "合約生效日" },
      { date: body.endDate !== undefined ? body.endDate : existing.endDate, label: "合約截止日" },
    );
    const [row] = await db
      .update(schema.contracts)
      .set(body)
      .where(eq(schema.contracts.id, id))
      .returning();
    if (!row) throw new AppError(404, "合約不存在: {id}", { id });
    const { fileData, ...rest } = row;
    return c.json({ ...rest, hasFile: !!fileData });
  });

  /**
   * 扣繳追蹤（付個人的租金／專業服務費等）。
   *
   * ★ 費率一律由使用者填寫：這裡的 z.number() 只驗「是 0–10000 的整數 basis point」，
   *   不預設任何值、也不對費率的合理性做任何判斷（10% 與 1% 在系統眼裡沒有差別）。
   *   nullable 是有意義的：null＝清回「尚未設定」，與 0（查過、不用扣）語意不同。
   */
  const rateBp = z
    .number()
    .int()
    .min(0)
    .max(10_000, "費率上限 10000（＝100%）：請確認是否多打了一個零")
    .nullable();
  const categoryInput = z.object({
    label: z.string().trim().min(1),
    expenseAccountCode: z.string().regex(/^[1-8]\d{3}$/, "費用科目代號需為 4 碼數字"),
    taxRateBp: rateBp.optional(),
    supplementRateBp: rateBp.optional(),
    sourceNote: z.string().trim().max(500).nullable().optional(),
  });
  app.post("/withholding-categories", zValidator("json", categoryInput), async (c) => {
    return c.json(await createCategory(db, c.req.valid("json")), 201);
  });
  app.get("/withholding-categories", async (c) => c.json(await listCategories(db)));
  app.patch(
    "/withholding-categories/:id",
    zValidator("json", categoryInput.partial().extend({ active: z.boolean().optional() })),
    async (c) => {
      return c.json(await updateCategory(db, idParam(c), c.req.valid("json")));
    },
  );

  const paymentInput = z.object({
    partnerId: z.number().int().positive(),
    categoryId: z.number().int().positive(),
    payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // 給付總額＝扣繳前的總額（不是實際匯出去的錢）；淨額由系統相減，不接受使用者直接填
    grossAmount: z.number().int().positive(),
    // 未給＝採用依費率的試算值；給了＝覆寫（門檻與例外我們沒有模型，一律以使用者填的為準）
    taxWithheld: z.number().int().nonnegative().optional(),
    supplementWithheld: z.number().int().nonnegative().optional(),
    cashAccountId: z.number().int().positive(),
    memo: z.string().optional(),
  });
  app.post("/withholding-payments", zValidator("json", paymentInput), async (c) => {
    return c.json(await createPayment(db, c.req.valid("json"), c.get("user").id), 201);
  });
  // 作廢扣繳支出單（0025，B4；限 admin/finance）：年度彙總（憑單取數）隨之排除——
  // 打錯金額的正路是「作廢＋重開」，不是手工傳票沖帳（那救得了總帳、救不了彙總）
  app.post("/withholding-payments/:id/void", zValidator("json", voidInput), async (c) => {
    return c.json(await voidWithholdingPayment(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });
  // 試算：建單畫面即時顯示預設值與「尚未設定費率」提示，與 POST 共用同一份算式
  app.post("/withholding-payments/estimate", zValidator("json", paymentInput), async (c) => {
    return c.json(await estimatePayment(db, c.req.valid("json")));
  });
  const yearQuery = z.coerce.number().int().min(2000).max(2200);
  // 註冊順序重要：/summary 必須在任何 /withholding-payments/:id 之前（目前沒有 :id，但別留坑）
  app.get("/withholding-payments/summary", async (c) => {
    const parsed = yearQuery.safeParse(c.req.query("year"));
    if (!parsed.success) throw new AppError(400, "缺少或無效的 year 參數（西元年，例如 2026）");
    return c.json(await paymentSummary(db, parsed.data));
  });
  app.get("/withholding-payments", async (c) => {
    const raw = c.req.query("year");
    if (raw === undefined) return c.json(await listPayments(db));
    const parsed = yearQuery.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "無效的 year 參數（西元年，例如 2026）");
    return c.json(await listPayments(db, parsed.data));
  });

  /**
   * 稅法參數（使用者自己查證後填入的稅率／級距／可扣抵性，附生效期間與依據來源）。
   *
   * ★ 這裡的 zod 只驗**結構**：日期是不是 YYYY-MM-DD、費率是不是 0–10000 的 basis point、
   *   級距的上下界是不是整數。它**不驗證任何數值的合理性**——系統沒有立場說 3.5% 比 50% 對，
   *   也不知道使用者要記的是哪一種稅。合理性是使用者的責任，依據寫在 sourceNote 裡。
   *
   * ★ append-only：只有 POST，沒有 PATCH、沒有 DELETE。改動舊列的唯一途徑是新增一列時
   *   勾 supersedePrevious（把前一列的 valid_to 設為新列 valid_from 的前一天）。
   *   理由見 services/tax-parameters.ts 的檔頭：舊年度必須算得回來。
   */
  const bracketInput = z.object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative().nullable(),
    mode: z.enum(["exempt", "rate_on_total", "rate_of_excess"]),
    rateBp: z
      .number()
      .int()
      .min(0)
      .max(10_000, "費率上限 10000（＝100%）：請確認是否多打了一個零")
      .nullable()
      .optional(),
  });
  const taxParameterInput = z.object({
    // kind 不是 z.enum：使用者必須能自訂（查定課徵稅率、某類支出的列報限額都可能是我們沒想過的）。
    // 只擋明顯的手滑：空字串、超長、以及會讓維護頁分組錯亂的空白開頭
    kind: z.string().trim().min(1).max(64),
    scopeKey: z.string().trim().min(1).max(64).nullable().optional(),
    label: z.string().trim().min(1).max(200),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    brackets: z.array(bracketInput).nullable().optional(),
    boolValue: z.boolean().nullable().optional(),
    sourceNote: z.string().trim().max(1000).nullable().optional(),
    supersedePrevious: z.boolean().optional(),
  });
  app.post("/tax-parameters", zValidator("json", taxParameterInput), async (c) => {
    const { brackets: rawBrackets, ...rest } = c.req.valid("json");
    // zod 的 rateBp 允許 null（前端把費率欄清空送過來就是 null），
    // 而 core 的 TaxBracket 用 undefined 表示「沒填」——在邊界一次轉乾淨，
    // 不讓兩種「沒有值」的表示法流進服務層（exactOptionalPropertyTypes 之下它們不相容）
    const brackets = rawBrackets?.map((b) => ({
      from: b.from,
      to: b.to,
      mode: b.mode,
      ...(b.rateBp === null || b.rateBp === undefined ? {} : { rateBp: b.rateBp }),
    }));
    return c.json(await createParameter(db, { ...rest, brackets }, c.get("user").id), 201);
  });
  app.get("/tax-parameters", async (c) => {
    const raw = c.req.query("asOf");
    if (raw !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new AppError(400, "asOf 須為 YYYY-MM-DD（收到「{raw}」）", { raw });
    }
    return c.json({
      rows: await listParameters(db, raw),
      // 前端據此把「系統只保管、不計算」的 kind 標出來：使用者存了營所稅級距之後
      // 最容易產生的誤解就是「那系統會幫我算了吧」
      recordOnlyKinds: RECORD_ONLY_KINDS,
    });
  });

  // 銷售前段（角色化第二批）：報價單 → 訂單 → 出貨轉銷貨 ＋ 應收帳齡。
  // 課稅別三欄（0032）與銷貨單（docInput）同形狀；形狀規則（零稅率必答經海關與否等）
  // 統一在服務層 assertZeroTaxShape 檢查，zod 只管型別
  const quoteInput = z.object({
    partnerId: z.number().int().positive(),
    quoteDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    memo: z.string().optional(),
    // 預計交期（0035）：報價/訂單＝交貨承諾、採購單＝預計到貨。選填——未約定就留空，不捏造
    expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    taxType: z.enum(["1", "2", "3"]).optional(),
    zeroTaxViaCustoms: z.boolean().optional(),
    zeroTaxCertNo: z.string().trim().max(100).optional(),
    lines: z
      .array(
        z.object({
          productId: z.number().int().positive(),
          qty: z.number().positive(),
          unitPrice: z.number().nonnegative(),
        }),
      )
      .min(1),
  });
  // 短交結案：理由必填——「誰砍的單、為什麼」是營業紀錄，三個月後看報表要答得出來
  const closeReasonInput = z.object({
    reason: z.string().trim().min(1, "結案原因必填（例如：客戶砍單、廠商斷貨）").max(500),
  });
  app.post("/quotes", zValidator("json", quoteInput), async (c) => {
    return c.json(await createQuote(db, c.req.valid("json"), c.get("user").id), 201);
  });
  // 清單篩選分頁（R3）：from/to 對報價日期＋partnerId＋limit/offset
  app.get("/quotes", async (c) => {
    const { rows, total } = await listQuotes(db, listQuery(c));
    setTotalCount(c, total);
    return c.json(rows);
  });
  // 作廢報價單（0025，B4；限 admin/finance）：與「失單」是兩件事——失單是客戶沒成交（成交率分母），
  // 作廢是單子建錯（不進任何統計）。未拋轉傳票，直接標記；won 不可作廢
  app.post("/quotes/:id/void", zValidator("json", voidReasonOnly), async (c) => {
    return c.json(await voidQuote(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });
  app.post("/quotes/:id/lost", async (c) => c.json(await setQuoteLost(db, Number(c.req.param("id")))));
  app.post(
    "/quotes/:id/convert",
    zValidator("json", z.object({ orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
    async (c) => {
      return c.json(
        await convertQuote(db, Number(c.req.param("id")), c.req.valid("json").orderDate, c.get("user").id),
        201,
      );
    },
  );

  const orderInput = quoteInput.omit({ quoteDate: true }).extend({
    orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });
  app.post("/orders", zValidator("json", orderInput), async (c) => {
    return c.json(await createOrder(db, c.req.valid("json"), c.get("user").id), 201);
  });
  // 清單篩選分頁（R3）：from/to 對訂單日期＋partnerId＋limit/offset
  app.get("/orders", async (c) => {
    const { rows, total } = await listOrders(db, listQuery(c));
    setTotalCount(c, total);
    return c.json(rows);
  });
  app.post(
    "/orders/:id/ship",
    zValidator(
      "json",
      z.object({
        docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        lines: z
          .array(z.object({ orderLineId: z.number().int().positive(), qty: z.number().positive() }))
          .min(1)
          .optional(),
      }),
    ),
    async (c) => {
      return c.json(await shipOrder(db, Number(c.req.param("id")), c.req.valid("json")), 201);
    },
  );
  app.post("/orders/:id/cancel", async (c) => c.json(await cancelOrder(db, Number(c.req.param("id")))));
  // 短交結案（0032）：partial 的單終於有正路可走（之前只能「假出貨」再開退回單）
  app.post("/orders/:id/close", zValidator("json", closeReasonInput), async (c) => {
    return c.json(await closeOrder(db, idParam(c), c.req.valid("json").reason, c.get("user").id));
  });

  // 採購前段（角色化第三批）：採購單 → 收貨轉進貨 ＋ 總經理儀表板。
  // 課稅別是銷項的語言（進項的申報屬性＝憑證格式＋扣抵代號，登錄在進貨單上），採購單不收
  const purchaseOrderInput = orderInput.omit({ taxType: true, zeroTaxViaCustoms: true, zeroTaxCertNo: true });
  app.post("/purchase-orders", zValidator("json", purchaseOrderInput), async (c) => {
    return c.json(await createPurchaseOrder(db, c.req.valid("json"), c.get("user").id), 201);
  });
  // 清單篩選分頁（R3）：from/to 對採購單日期＋partnerId＋limit/offset
  app.get("/purchase-orders", async (c) => {
    const { rows, total } = await listPurchaseOrders(db, listQuery(c));
    setTotalCount(c, total);
    return c.json(rows);
  });
  app.post(
    "/purchase-orders/:id/receive",
    zValidator(
      "json",
      z.object({
        docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        lines: z
          .array(
            z.object({
              poLineId: z.number().int().positive(),
              qty: z.number().positive(),
              // 收貨單價覆寫（0032）：未帶＝採購單價；帶了就以收貨價入帳（漲價、匯率差終於有路）
              unitPrice: z.number().nonnegative().optional(),
            }),
          )
          .min(1)
          .optional(),
      }),
    ),
    async (c) => {
      return c.json(await receivePurchaseOrder(db, Number(c.req.param("id")), c.req.valid("json")), 201);
    },
  );
  app.post("/purchase-orders/:id/cancel", async (c) =>
    c.json(await cancelPurchaseOrder(db, Number(c.req.param("id")))),
  );
  app.post("/purchase-orders/:id/close", zValidator("json", closeReasonInput), async (c) => {
    return c.json(await closePurchaseOrder(db, idParam(c), c.req.valid("json").reason, c.get("user").id));
  });

  // 月結關帳＋年度結轉（缺口第二層批次 B）
  app.get("/period-closes", async (c) => c.json(await listCloses(db)));
  app.get("/period-closes/check", async (c) => {
    const period = c.req.query("period");
    if (!period || !/^\d{4}-\d{2}$/.test(period)) throw new AppError(400, "缺少 period 參數（YYYY-MM）");
    return c.json(await checkPeriod(db, period));
  });
  app.post(
    "/period-closes",
    zValidator("json", z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) })),
    async (c) => {
      return c.json(await closePeriod(db, c.req.valid("json").period, c.get("user").id), 201);
    },
  );
  app.delete("/period-closes/latest", async (c) => c.json(await reopenLatest(db)));
  app.get("/year-closes", async (c) => c.json(await listYearCloses(db)));
  app.post(
    "/year-closes",
    zValidator("json", z.object({ year: z.number().int().min(2000).max(2200) })),
    async (c) => {
      return c.json(await yearClose(db, c.req.valid("json").year, c.get("user").id), 201);
    },
  );

  // 固定資產＋自動折舊（缺口第二層批次 A）
  app.get("/asset-categories", (c) => c.json(ASSET_CATEGORIES));
  const assetInput = z.object({
    name: z.string().min(1),
    category: z.string().min(1),
    cost: z.number().int().positive(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    usefulYears: z.number().int().positive().optional(),
    salvage: z.number().int().nonnegative().optional(),
    memo: z.string().optional(),
  });
  app.post("/fixed-assets", zValidator("json", assetInput), async (c) => {
    return c.json(await createAsset(db, c.req.valid("json"), c.get("user").id), 201);
  });
  app.get("/fixed-assets", async (c) => c.json(await listAssets(db)));
  // PATCH（0031，B14 建議 4）：未提折舊可改基本資料（成本少打一個零不再只能假處分）；
  // 已提折舊後只可改名稱與備註——限制在服務層判斷，這裡照樣收下欄位以給出明確的 422
  const assetPatchInput = z.object({
    name: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    cost: z.number().int().positive().optional(),
    salvage: z.number().int().nonnegative().optional(),
    usefulYears: z.number().int().positive().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    memo: z.string().optional(),
  });
  app.patch("/fixed-assets/:id", zValidator("json", assetPatchInput), async (c) => {
    return c.json(await updateAsset(db, idParam(c), c.req.valid("json")));
  });
  // 作廢登錄（未提折舊限定；已提折舊 409 指路處分）／作廢處分（反向傳票沖回損益與累折）
  app.post("/fixed-assets/:id/void", zValidator("json", voidReasonOnly), async (c) => {
    return c.json(await voidFixedAsset(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });
  app.post("/fixed-assets/:id/dispose/void", zValidator("json", voidReasonOnly), async (c) => {
    return c.json(await voidAssetDisposal(db, idParam(c), c.req.valid("json"), c.get("user").id));
  });
  app.post(
    "/depreciations/run",
    zValidator("json", z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) })),
    async (c) => {
      return c.json(await runDepreciation(db, c.req.valid("json").period), 201);
    },
  );
  const disposeInput = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    proceeds: z.number().int().nonnegative().optional(),
    // 收款科目不在此寫死代號：現金科目是資料庫狀態（accounts.is_cash），零用金與使用者自建的
    // 銀行帳戶科目都該收得了處分價款。實際是不是現金科目由 disposeAsset() 查資料庫驗證
    accountCode: z.string().regex(/^[1-8]\d{3}$/).optional(),
    // B14(b)：是否計銷項稅額（預設 true）與價款是否含稅（預設 true）——
    // 系統無從斷言哪筆處分免稅，不計稅必須是使用者的明示選擇
    taxable: z.boolean().optional(),
    proceedsIncludeTax: z.boolean().optional(),
    // 同時開立發票（0034，可選）：金額＝處分價款、稅額＝處分稅額，同一交易內開立，
    // 開不出來整筆處分回滾。不帶＝不開（taxNotes 出聲），可事後補開
    invoice: disposalIssueInput.optional(),
  });
  app.post("/fixed-assets/:id/dispose", zValidator("json", disposeInput), async (c) => {
    return c.json(await disposeAsset(db, idParam(c), c.req.valid("json")));
  });
  // 處分發票的事後補開／作廢重開入口（0034）：處分時沒勾、或「僅作廢」發票後重開。
  // 發票日期＝處分日、金額稅額取處分落地值（issueDisposalInvoice 檔頭）
  app.post("/fixed-assets/:id/invoice", zValidator("json", disposalIssueInput), async (c) => {
    return c.json(await issueDisposalInvoice(db, idParam(c), c.req.valid("json")), 201);
  });
  // 處分試算（與實際處分同一套計算與檢查，不落帳）：表單先看到預計損益再送出
  const disposePreviewQuery = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date 格式須為 YYYY-MM-DD"),
    proceeds: z.coerce.number().int().nonnegative().optional(),
    taxable: z.enum(["true", "false"]).optional(),
    proceedsIncludeTax: z.enum(["true", "false"]).optional(),
  });
  app.get("/fixed-assets/:id/dispose-preview", async (c) => {
    const parsed = disposePreviewQuery.safeParse({
      date: c.req.query("date"),
      proceeds: c.req.query("proceeds"),
      taxable: c.req.query("taxable"),
      proceedsIncludeTax: c.req.query("proceedsIncludeTax"),
    });
    if (!parsed.success) {
      throw new AppError(400, "試算參數有誤：{issues}", { issues: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；") });
    }
    const q = parsed.data;
    return c.json(
      await previewDisposal(db, idParam(c), {
        date: q.date,
        proceeds: q.proceeds,
        taxable: q.taxable === undefined ? undefined : q.taxable === "true",
        proceedsIncludeTax: q.proceedsIncludeTax === undefined ? undefined : q.proceedsIncludeTax === "true",
      }),
    );
  });

  app.get("/reports/dashboard", async (c) => {
    const asOf = c.req.query("asOf");
    if (!asOf) throw new AppError(400, "缺少 asOf 參數（YYYY-MM-DD）");
    return c.json(await dashboard(db, asOf));
  });

  app.get("/reports/ledger", async (c) => {
    const accountCode = c.req.query("accountCode");
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!accountCode || !from || !to) throw new AppError(400, "缺少 accountCode/from/to 參數");
    return c.json(await ledgerReport(db, accountCode, from, to));
  });
  app.get("/reports/cash-flow", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) throw new AppError(400, "缺少 from/to 參數（YYYY-MM-DD）");
    return c.json(await cashFlow(db, from, to));
  });

  // 折舊明細表（gap 3.7，0035 批）：?year=YYYY；format=csv 回 ExportFile 形狀（name/content/rows）
  // 供前端 downloadText——CSV 掛同一條路由（而非 /exports）：看得到報表的人就下載得了它
  app.get("/reports/depreciation-schedule", async (c) => {
    const raw = c.req.query("year");
    if (!raw || !/^\d{4}$/.test(raw)) throw new AppError(400, "缺少 year 參數（四位數西元年，收到「{raw}」）", { raw: raw ?? "" });
    const year = Number(raw);
    if (c.req.query("format") === "csv") return c.json(await depreciationScheduleExport(db, year));
    return c.json(await depreciationSchedule(db, year));
  });

  app.get("/reports/ar-aging", async (c) => {
    const asOf = c.req.query("asOf");
    if (!asOf) throw new AppError(400, "缺少 asOf 參數（YYYY-MM-DD）");
    return c.json(await arAging(db, asOf));
  });

  // 應付帳齡（0033）：與 ar-aging 同形狀（rows/notes/totals；credit 欄＝預付）。
  // 掛進貨頁權限（auth.ts RULES）：排付款的人看的是進貨視角，與業務催款的 ar-aging 對稱
  app.get("/reports/ap-aging", async (c) => {
    const asOf = c.req.query("asOf");
    if (!asOf) throw new AppError(400, "缺少 asOf 參數（YYYY-MM-DD）");
    return c.json(await apAging(db, asOf));
  });

  app.get("/journal-entries/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, id));
    if (!entry) throw new AppError(404, "傳票不存在: {id}", { id });
    const lines = await db
      .select({
        code: schema.accounts.code,
        accountName: schema.accounts.name,
        debit: schema.journalLines.debit,
        credit: schema.journalLines.credit,
        memo: schema.journalLines.memo,
      })
      .from(schema.journalLines)
      .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
      .where(eq(schema.journalLines.entryId, id));
    return c.json({ ...entry, lines });
  });

  return app;
}
