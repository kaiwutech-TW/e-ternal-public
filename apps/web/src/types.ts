export interface Partner {
  id: number;
  name: string;
  taxId: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
  /** 自然人（個人房東、個人接案者）：付款給他們可能有代扣與年度憑單義務（系統不判斷，由使用者查證） */
  isIndividual: boolean;
  /**
   * 有沒有填身分證統一編號。**明文不會出現在任何清單 API**（PII），
   * 要看明文得單筆呼叫 GET /partners/:id/id-no（限財務／管理者）。
   */
  hasIdNo: boolean;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  shipToAddress: string | null;
  /** 付款條件（天）：null＝未約定；0＝貨到付款。銷貨單的收款到期日由它推算 */
  paymentTermDays: number | null;
  /** 信用額度（整數元）：null＝不設限。超過只提示不硬擋 */
  creditLimit: number | null;
  salesOwnerEmployeeId: number | null;
  note: string | null;
}

/** 扣繳類別：使用者自訂的「白話標籤 → 費用科目 → 費率」。費率為 null＝尚未設定（不是 0） */
export interface WithholdingCategory {
  id: number;
  label: string;
  expenseAccountCode: string;
  /** basis point（萬分之一）：3.5% = 350。null＝使用者還沒填（不是 0） */
  taxRateBp: number | null;
  supplementRateBp: number | null;
  /** 使用者自己寫的依據來源（系統不驗證內容） */
  sourceNote: string | null;
  active: boolean;
}

export interface WithholdingPaymentRow {
  id: number;
  partnerId: number;
  partnerName: string;
  categoryId: number;
  categoryLabel: string;
  payDate: string;
  grossAmount: number;
  taxWithheld: number;
  supplementWithheld: number;
  netAmount: number;
  cashAccountName: string;
  journalEntryId: number | null;
  memo: string;
  /** 作廢標記（0025）：已作廢的單不進年度彙總（憑單取數） */
  voidedAt: string | null;
  voidReason: string | null;
}

/** 試算結果：金額只是預設值，notes 說明系統「沒有」替使用者判斷什麼 */
export interface WithholdingEstimate {
  taxWithheld: number;
  supplementWithheld: number;
  netAmount: number;
  notes: string[];
}

export interface WithholdingSummaryRow {
  partnerId: number;
  partnerName: string;
  hasIdNo: boolean;
  categoryId: number;
  categoryLabel: string;
  count: number;
  grossAmount: number;
  taxWithheld: number;
  supplementWithheld: number;
  netAmount: number;
  /** 有幾筆是在「費率尚未設定」時建立的——那些 0 不是「不用扣」，是「系統不知道要扣多少」 */
  unsetTaxRateCount: number;
  unsetSupplementRateCount: number;
}

export interface WithholdingSummary {
  year: number;
  rows: WithholdingSummaryRow[];
  total: Omit<WithholdingSummaryRow, "partnerId" | "partnerName" | "hasIdNo" | "categoryId" | "categoryLabel">;
  /** 2211／2212 的當下餘額＝已扣未繳的稅款／保費。刻意不含任何繳納期限（未查證） */
  liabilities: { code: string; name: string; balance: number }[];
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  unit: string;
  /** 標準售價（整數元）：null＝未定價。開單時帶入為預設單價、可覆寫 */
  listPrice: number | null;
  category: string | null;
  /** 服務項目（運費、安裝費、顧問費）：不入庫存 */
  isService: boolean;
  minStock: number | null;
  note: string | null;
}

export interface DocRow {
  id: number;
  partnerId: number;
  docDate: string;
  /** 收款到期日（銷貨）／付款到期日（進貨，0033）：null＝未約定或舊單 */
  dueDate?: string | null;
  subtotal: number;
  tax: number;
  total: number;
  cogs?: number;
  invTrack?: string | null;
  invNo?: string | null;
  /** 供應商發票開立日期（0029，R20，進貨單）：401 進項歸期優先用它；null＝舊單或未登錄（歸期退回單據日） */
  invDate?: string | null;
  /** 進項憑證格式代號（進貨單）：25 電子發票／21 三聯式統一發票扣抵聯／22 載有稅額之其他憑證 */
  invFormat?: string;
  /** 進項扣抵代號（進貨單）：1 進貨費用可扣抵／2 固資可扣抵／3、4 不可扣抵 */
  deductionCode?: string;
  reversalEntryId?: number | null;
  /** 作廢標記（0025，B4）：非 null＝已作廢，原單保留、反向傳票沖平 */
  voidedAt?: string | null;
  voidReason?: string | null;
  /** 課稅別（0028，B12，銷貨單）：'1' 應稅／'2' 零稅率／'3' 免稅（目前開不出） */
  taxType?: "1" | "2" | "3";
  /** 零稅率：true＝經海關出口；false＝非經海關；非零稅率為 null */
  zeroTaxViaCustoms?: boolean | null;
  /** 零稅率證明文件號碼（出口報單／外匯證明等）；null＝尚未補登 */
  zeroTaxCertNo?: string | null;
}

/** 銷貨單單筆（GET /sales/:id，B5）：列印出貨單與 B2C 證明聯的資料來源 */
export interface SaleDetail extends DocRow {
  partnerName: string;
  /** 客戶抬頭（白名單欄位；partner 被刪時為 null） */
  partner: {
    name: string;
    taxId: string | null;
    contactPerson: string | null;
    phone: string | null;
    address: string | null;
    shipToAddress: string | null;
  } | null;
  lines: {
    id: number;
    productId: number;
    productName: string;
    sku: string;
    unit: string;
    qty: string;
    unitPrice: string;
    amount: number;
  }[];
}

/** 公司抬頭（GET /company-profile 的白名單欄位中列印會用到的那幾個） */
export interface CompanyHeader {
  name: string;
  taxId: string;
  address: string | null;
  personInCharge: string | null;
  telephone: string | null;
  email: string | null;
}

/** return＝貨退回來了（動庫存與成本）；allowance＝貨沒退但要少收錢（只動收入與稅） */
export type ReturnKind = "return" | "allowance";

export interface ReturnableLine {
  id: number;
  productId: number;
  productName: string;
  qty: number;
  unitPrice: number;
  amount: number;
  returnedQty: number;
  /** 已「退回」攤到的金額（不含折讓） */
  returnedAmount: number;
  /** 已「折讓」的金額 */
  allowanceAmount: number;
  /** 還可退幾個＝原數量 − 已退數量（進貨端另受在庫量限制） */
  remainingQty: number;
  /** 還可折讓多少錢＝原金額 − 已退回 − 已折讓；與 remainingQty 是兩個獨立的上限 */
  remainingAllowance: number;
  /** 進貨端才有：當下在庫量（可退量同時受原進貨量與在庫量兩道限制） */
  onHandQty?: number;
}

export interface Returnable {
  docDate: string;
  partnerId: number;
  subtotal: number;
  tax: number;
  total: number;
  returnedNet: number;
  reversed?: boolean;
  lines: ReturnableLine[];
}

export interface ReturnLineRow {
  id: number;
  productId: number;
  qty: string;
  unitPrice: string;
  amount: number;
  cost?: number;
  invCredit?: number;
}

export interface ReturnRow {
  id: number;
  partnerId: number;
  partnerName: string;
  kind: ReturnKind;
  docDate: string;
  certDate: string | null;
  certNo: string | null;
  memo: string;
  subtotal: number;
  tax: number;
  total: number;
  journalEntryId: number | null;
  createdBy: number | null;
  /** 0030 作廢層：原單留痕，彙總與 401 減項排除；折讓單作廢後改產 G0501 */
  voidedAt: string | null;
  voidReason: string | null;
  reversalEntryId: number | null;
  lines: ReturnLineRow[];
  /** 銷貨端 */
  saleId?: number;
  cogs?: number;
  arOffset?: number;
  payableAmount?: number;
  /** 進貨端 */
  purchaseId?: number;
  apOffset?: number;
  receivableAmount?: number;
  costDiff?: number;
  cashAmount: number;
}

export interface InvoiceRow {
  id: number;
  /** 來源二擇一（0034）：saleId＝銷貨發票、assetId＝固定資產處分發票 */
  saleId: number | null;
  assetId: number | null;
  invoiceNumber: string;
  invoiceDate: string;
  mode: "B2B" | "B2C";
  buyerTaxId: string | null;
  buyerName: string;
  /** B2C 依 MIG 慣例存含稅總額（taxAmount=0）；B2B 為未稅額 */
  salesAmount: number;
  taxAmount: number;
  totalAmount: number;
  /** 開立當時的營業稅率快照（bp）；null＝快照欄位上線前的舊發票 */
  vatRateBp: number | null;
  /** 課稅別快照（0028）：'1' 應稅／'2' 零稅率 */
  taxType: "1" | "2" | "3";
  randomNumber: string;
  status: "issued" | "canceled";
  /** 載具／捐贈碼快照（0029）：null＝無載具／舊發票。XML 本體走單張端點，清單刻意不含（瘦身） */
  carrierType: string | null;
  carrierId: string | null;
  donateMark: "0" | "1" | null;
  npoban: string | null;
}

export interface InventoryRow {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  amount: number;
  avgUnitCost: number | null;
  /** 安全庫存（主檔設定）：null＝不設；belowMinStock＝在庫量低於安全庫存（提示，不擋單） */
  minStock: number | null;
  belowMinStock: boolean;
}

export interface TrialBalance {
  rows: { code: string; name: string; debit: number; credit: number }[];
  totalDebit: number;
  totalCredit: number;
}

/** 庫存調整單明細（0026，B8）：qty 系列是 DB numeric，經 JSON 後為字串 */
export interface AdjustmentLine {
  id: number;
  adjustmentId: number;
  productId: number;
  productName: string;
  sku: string;
  direction: "in" | "out";
  qty: string;
  unitCost: string;
  amount: number;
  /** 盤點入口才有：帳面量與實盤量（手動調整為 null） */
  bookQty: string | null;
  countedQty: string | null;
}

export interface InventoryAdjustment {
  id: number;
  docDate: string;
  reason: "count" | "scrap" | "expiry";
  memo: string;
  totalIn: number;
  totalOut: number;
  journalEntryId: number | null;
  voidedAt: string | null;
  voidReason: string | null;
  reversalEntryId: number | null;
  lines: AdjustmentLine[];
}

/** 盤點底稿列：帳面量由後端算好，畫面只補「實盤量」欄 */
export interface StocktakeRow {
  productId: number;
  sku: string;
  name: string;
  unit: string;
  bookQty: number;
}

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  active: boolean;
  /** 系統科目：自動分錄直接指定它，不可停用（後端 422 擋） */
  isSystem: boolean;
  /** 現金科目：現金流量表與儀表板現金水位的取數依據，也是收付款/報銷/處分價款下拉選單的來源 */
  isCash: boolean;
}

export interface JournalEntryRow {
  id: number;
  entryDate: string;
  memo: string;
  sourceType: string | null;
  sourceId: number | null;
  totalDebit: number;
  /** 作廢標記（0025）：僅手工傳票可直接作廢；系統傳票作廢其來源單據 */
  voidedAt: string | null;
  voidReason: string | null;
  reversalEntryId: number | null;
}

export interface CashDocRow {
  id: number;
  kind: "receipt" | "payment";
  partnerId: number;
  docDate: string;
  amount: number;
  memo: string;
  /** 溢收/溢付掛 2231 預收／1212 預付的金額（0027，B9）；剩餘可沖用＝它減掉事後沖用合計 */
  unappliedAmount: number;
  /** 作廢標記（0025）：非 null＝已作廢，反向傳票沖平、立沖釋放 */
  voidedAt: string | null;
  voidReason: string | null;
  reversalEntryId: number | null;
}

export interface PartnerBalance {
  partnerId: number;
  name: string;
  ar: number;
  ap: number;
  /** 預收／預付餘額（0027，B9）：與 ar/ap 分列，不淨額互抵——資產負債表不得以淨額表達 */
  prepaidReceived: number;
  prepaidPaid: number;
}

export interface ReportLine {
  code: string;
  name: string;
  amount: number;
}

export interface IncomeStatement {
  from: string;
  to: string;
  revenue: ReportLine[];
  expense: ReportLine[];
  totalRevenue: number;
  totalExpense: number;
  netIncome: number;
}

export interface BalanceSheet {
  asOf: string;
  assets: ReportLine[];
  liabilities: ReportLine[];
  equity: ReportLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
}

export interface Employee {
  id: number;
  name: string;
  active: boolean;
  title: string | null;
  phone: string | null;
  email: string | null;
  hireDate: string | null;
  note: string | null;
  // ── 0039/0040 HR：簽核鏈與出勤的取數來源 ──
  departmentId?: number | null;
  managerEmployeeId?: number | null;
  employmentType?: string;
  punchExempt?: boolean;
}

export interface ExpenseCategory {
  accountCode: string;
  label: string;
  hint: string;
  /** **目前生效**的可扣抵性（有稅法參數覆寫就是覆寫值，否則是系統預設） */
  inputTaxDeductible: boolean;
  /** 系統預設值（core 的 EXPENSE_CATEGORIES）——**尚未經查證**，可在稅法參數頁覆寫 */
  defaultDeductible: boolean;
  /** 'parameter'＝你在稅法參數頁設定的；'default'＝系統預設 */
  deductibleSource: "parameter" | "default";
  deductibleParameterId: number | null;
  deductibleSourceNote: string | null;
  deductibleValidFrom: string | null;
  deductibleValidTo: string | null;
}

/** 稅法參數的級距：三種 mode 都是通用的算術形狀，不以任何特定稅制命名 */
export interface TaxBracket {
  from: number;
  to: number | null;
  mode: "exempt" | "rate_on_total" | "rate_of_excess";
  rateBp?: number | null;
}

/**
 * 稅法參數：使用者自己查證後填入的稅率／級距／是否，附生效期間與依據來源。
 * **append-only**——舊列永遠留著（舊年度必須算得回來），只有「接續」會改動舊列的 validTo。
 */
export interface TaxParameterRow {
  id: number;
  kind: string;
  scopeKey: string | null;
  label: string;
  validFrom: string;
  validTo: string | null;
  brackets: TaxBracket[] | null;
  boolValue: boolean | null;
  sourceNote: string | null;
  enteredBy: number | null;
  enteredByName: string | null;
  enteredAt: string;
  status: "active" | "expired" | "future";
}

export interface TaxParameterList {
  rows: TaxParameterRow[];
  /** 系統只保管、不計算的 kind（存了不代表會自動報稅） */
  recordOnlyKinds: string[];
}

export interface ExpenseItemRow {
  id: number;
  claimId: number;
  accountCode: string;
  description: string;
  docType: "einvoice" | "receipt" | "other";
  amount: number;
  tax: number;
  deductible: boolean;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  sellerTaxId: string | null;
  image?: string | null;
}

export interface ExpenseClaimRow {
  id: number;
  employeeId: number;
  employeeName: string;
  claimDate: string;
  status: "submitted" | "approved" | "rejected" | "paid";
  memo: string;
  total: number;
  rejectReason: string | null;
  /** R13：employee＝員工代墊（核准後付款）；company＝公司支付（核准即付清） */
  paidBy: "employee" | "company";
  /** 0036：核准留痕 */
  approvedByUserId: number | null;
  approvedAt: string | null;
  /** 0036 作廢層：voidedAt 非 null＝已作廢（status 保持原值，彙總與 401 都已排除） */
  voidedAt: string | null;
  voidReason: string | null;
  reversalEntryId: number | null;
  items: ExpenseItemRow[];
}

/** R13：「公司欠員工多少」——approved 未付（未作廢）依員工彙總 */
export interface ClaimPayableSummary {
  count: number;
  amount: number;
  byEmployee: { employeeId: number; employeeName: string; count: number; amount: number }[];
}

export interface ContractRow {
  id: number;
  partnerId: number | null;
  counterparty: string;
  title: string;
  amount: number | null;
  signDate: string | null;
  startDate: string;
  endDate: string | null;
  status: "draft" | "active" | "ended" | "terminated";
  memo: string;
  fileName: string | null;
  hasFile: boolean;
  /** 0037：project 專案／retainer 顧問月費／maintenance 維護／other */
  kind: "project" | "retainer" | "maintenance" | "other";
  /** 0046：sale＝我方請款（銷貨側）；purchase＝我方付款（進貨側）。與 kind 正交 */
  direction: "sale" | "purchase";
  /** 續約提醒提前天數；null＝系統預設 45 天 */
  renewNoticeDays: number | null;
  /** 續約鏈：這份合約從哪一份續來 */
  renewedFromId: number | null;
}

/** 合約的一期請款/付款計畫。billed＝對上的單（銷貨或進貨）存在且未作廢（作廢後自動回到 false 可重來） */
export interface InstallmentRow {
  id: number;
  seq: number;
  dueDate: string;
  amount: number; // 未稅
  description: string;
  saleId: number | null;
  /** 進貨側（0046）：勾對到的進貨單 */
  purchaseId: number | null;
  billed: boolean;
}

export interface BillingDueRow {
  contractId: number;
  contractTitle: string;
  counterparty: string;
  partnerId: number | null;
  /** 0046：sale＝待請款；purchase＝待付款 */
  direction: "sale" | "purchase";
  installmentId: number;
  seq: number;
  dueDate: string;
  amount: number;
  description: string;
  overdue: boolean;
}

export interface Track {
  id: number;
  period: string;
  track: string;
  rangeStart: number;
  rangeEnd: number;
  nextNo: number;
}

export interface Vat401 {
  period: string;
  rocPeriod: string;
  months: [string, string];
  summary: {
    invoiceCount: number;
    outputSales: number;
    outputTax: number;
    inputExpense: number;
    inputExpenseTax: number;
    inputFixedAsset: number;
    inputFixedAssetTax: number;
    payable: number;
    carryForward: number;
    salesTotal: number;
    outputTaxTotal: number;
    deductibleInputTaxTotal: number;
  };
  /** 已列入申報書減項的退回／折讓（有證明單）；媒體檔明細未產出的提醒在 note */
  returnsInFiling: {
    sales: { count: number; amount: number; tax: number };
    purchases: {
      expense: { count: number; amount: number; tax: number };
      fixedAsset: { count: number; amount: number; tax: number };
    };
    note?: string;
  };
  /** 缺證明單而「未列入減項」的退回／折讓（依退回日歸期） */
  returnsNotReflected: {
    sales: { count: number; subtotal: number; tax: number };
    purchases: { count: number; subtotal: number; tax: number };
    /** 只在真的有退回／折讓時出現：沒有退回還帶著警語是雜訊 */
    note?: string;
  };
  /** 不可扣抵進項（扣抵代號 3/4）：只進媒體檔明細，不進可扣抵合計——排除清單要看得到 */
  nonDeductible: {
    count: number;
    amount: number;
    tax: number;
    items: {
      purchaseId: number;
      docDate: string;
      invoice: string;
      deductionCode: string;
      amount: number;
      tax: number;
    }[];
  };
  /** 進項歸期退回（0029，R20）：沒登供應商發票日期、以進貨單日期歸期的單 */
  inputDateFallback: {
    count: number;
    items: { purchaseId: number; docDate: string; invoice: string }[];
    notes: string[];
  };
  /** 零稅率（0028，B12）：分欄金額、缺證明文件清單與提醒 */
  zeroRate: {
    nonCustoms: number;
    customs: number;
    returns: number;
    total: number;
    missingCert: {
      count: number;
      items: { saleId: number; docDate: string; subtotal: number; viaCustoms: boolean }[];
    };
    notes: string[];
  };
  /** 上期累積留抵的承轉：manual 手動輸入／filed 上期申報紀錄／none 無紀錄預設 0 */
  carryover: {
    prevPeriod: string;
    prevCarryForward: number;
    source: "manual" | "filed" | "none";
    notes: string[];
  };
  /** 申報人（白名單：不含身分證明文） */
  filer: {
    name: string | null;
    hasIdNo: boolean;
    areaCode: string | null;
    phone: string | null;
    ext: string | null;
    agentNo: string | null;
    selfFiled: boolean;
    notes: string[];
  };
  /** 稅法參數的警告（B2C 拆算找不到涵蓋發票日的營業稅率，走了回退值）；沒事時是空陣列 */
  parameterNotes?: string[];
  mediaFile: { name: string; content: string; records: number };
  returnFile: { name: string; content: string };
}

/** 401 申報紀錄一列（vat_returns）：留抵承轉的鏈 */
export interface VatFiling {
  id: number;
  period: string;
  rocPeriod: string;
  outputSales: number;
  outputTax: number;
  deductibleInputTax: number;
  prevCarryForward: number;
  payable: number;
  carryForward: number;
  createdAt: string;
}

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: import("@tw-erp/core").Role;
  employeeId: number | null;
  totpEnabled: boolean;
}

export interface UserRow extends AuthUser {
  active: boolean;
}

/** API 金鑰列表一列。刻意沒有金鑰本體——明文只在建立時回傳一次 */
export interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  userId: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** LLM 供應商設定。金鑰永不回傳明文，只回「有沒有」與末四碼 */
export interface AgentSettingsRow {
  provider: string;
  model: string;
  baseUrl: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  updatedAt: string | null;
}

export interface TotpStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

/** 操作日誌一列。刻意沒有 body／回應內容欄位——設計紀律見 migration 0018 */
export interface AuditRow {
  id: number;
  at: string;
  userId: number | null;
  username: string;
  role: import("@tw-erp/core").Role | null;
  method: string;
  path: string;
  status: number;
  source: string;
  targetId: number | null;
  note: string;
}

export interface QuoteLineRow {
  id: number;
  productId: number;
  qty: string;
  unitPrice: string;
  amount: number;
}

export interface QuoteRow {
  id: number;
  partnerId: number;
  partnerName: string;
  quoteDate: string;
  status: "open" | "won" | "lost";
  memo: string;
  subtotal: number;
  tax: number;
  total: number;
  orderId: number | null;
  /** 預計交期（0035）：null＝未約定；轉訂單時原樣帶入 */
  expectedDate: string | null;
  /** 課稅別（0032）：'1' 應稅／'2' 零稅率；零稅率時 viaCustoms 必有值 */
  taxType: "1" | "2" | "3";
  zeroTaxViaCustoms: boolean | null;
  zeroTaxCertNo: string | null;
  /** 作廢標記（0025）：作廢（單子建錯）與失單（客戶沒成交）是兩件事 */
  voidedAt: string | null;
  voidReason: string | null;
  lines: QuoteLineRow[];
}

export interface OrderLineRow extends QuoteLineRow {
  productName: string;
  shippedQty: string;
  remainingQty: number;
}

export interface OrderRow {
  id: number;
  partnerId: number;
  partnerName: string;
  orderDate: string;
  status: "open" | "partial" | "closed" | "canceled";
  memo: string;
  subtotal: number;
  tax: number;
  total: number;
  quoteId: number | null;
  /** 預計交期（0035）：null＝未約定；清單「今天 > 交期且未結」標逾期 */
  expectedDate: string | null;
  /** 課稅別（0032）：出貨開銷貨單時原樣帶入 */
  taxType: "1" | "2" | "3";
  zeroTaxViaCustoms: boolean | null;
  zeroTaxCertNo: string | null;
  /** 短交結案（0032）：closedAt 有值＝短交結案（理由在 closeReason）；closed 而三欄空＝全數出清 */
  closedAt: string | null;
  closeReason: string | null;
  lines: OrderLineRow[];
  saleIds: number[];
}

/**
 * 帳齡桶（0022 起依**到期日**分桶）：notDue＝未到期；d0_30 起是逾期天數。
 * 沒有到期日的舊單／未約定客戶：以單據日估算、前 30 天進 d0_30 但不算 overdue（回應的 notes 會標註）。
 */
export interface ArAgingRow {
  partnerId: number;
  name: string;
  notDue: number;
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90plus: number;
  total: number;
  /** 已過收款到期日的未收合計（儀表板「逾期應收」取這格） */
  overdue: number;
  credit: number;
}

export interface ArAging {
  asOf: string;
  rows: ArAgingRow[];
  /** 例如「N 張單沒有到期日，以單據日估算」——回退不可靜默 */
  notes: string[];
  totals: Omit<ArAgingRow, "partnerId" | "name">;
}

/** 應付帳齡（0033）：與應收同形狀、同引擎——credit 欄在這裡是預付（1212）餘額 */
export type ApAging = ArAging;

export interface PurchaseOrderLineRow extends QuoteLineRow {
  productName: string;
  receivedQty: string;
  remainingQty: number;
}

export interface PurchaseOrderRow {
  id: number;
  partnerId: number;
  partnerName: string;
  orderDate: string;
  status: "open" | "partial" | "closed" | "canceled";
  memo: string;
  subtotal: number;
  tax: number;
  total: number;
  /** 預計到貨日（0035）：null＝未約定；清單「今天 > 到貨日且未結」標逾期 */
  expectedDate: string | null;
  /** 短交結案（0032）：closedAt 有值＝短交結案；closed 而兩欄空＝全數收訖 */
  closedAt: string | null;
  closeReason: string | null;
  lines: PurchaseOrderLineRow[];
  purchaseIds: number[];
}

export interface DashboardData {
  asOf: string;
  month: string;
  revenue: { subtotal: number; grossProfit: number; count: number };
  cash: number;
  ar: number;
  ap: number;
  backlog: { count: number; amount: number };
  inbound: { count: number; amount: number };
  pendingClaims: { count: number; amount: number };
  /** R13：已核准未付（未作廢）＝公司現在欠員工的報銷款 */
  approvedUnpaidClaims: { count: number; amount: number };
  overdueAr: number;
  /** 0047：還沒做完的事（合約待請款/待付款、固定支出到期、合約快到期）——全是使用者自己設的日期 */
  upcoming: UpcomingRow[];
}

export interface UpcomingRow {
  kind: "billing" | "payable" | "contract";
  label: string;
  detail: string;
  date: string;
  amount: number | null;
  overdue: boolean;
  page: "contracts" | "recurring";
}

export interface AssetCategoryRow {
  key: string;
  label: string;
  hint: string;
  years: number;
  assetCode: string;
  accumCode: string;
}

export interface FixedAssetRow {
  id: number;
  name: string;
  category: string;
  categoryLabel: string;
  assetCode: string;
  accumCode: string;
  cost: number;
  salvage: number;
  usefulYears: number;
  startDate: string;
  memo: string;
  status: "active" | "disposed";
  disposedAt: string | null;
  accumulated: number;
  bookValue: number;
  monthly: number;
  remainingDepreciable: number;
  lastPeriod: string | null;
  // ── 0031（B14）──登錄作廢與處分作廢的軌跡
  voidedAt: string | null;
  voidReason: string | null;
  disposalProceeds: number | null;
  disposalTax: number | null;
  disposalReversalEntryId: number | null;
  disposalVoidedAt: string | null;
  disposalVoidReason: string | null;
}

/** 處分試算（GET /fixed-assets/:id/dispose-preview）：與實際處分同一套計算，先看到損益再送出 */
export interface DisposalPreview {
  assetId: number;
  name: string;
  catchUp: { count: number; total: number; items: { period: string; amount: number }[] };
  accumulated: number;
  bookValue: number;
  proceeds: number;
  netProceeds: number;
  tax: number;
  gain: number;
  taxNotes: string[];
}

export interface DepreciationRunResult {
  period: string;
  count: number;
  total: number;
  items: { assetId: number; name: string; amount: number; journalEntryId: number }[];
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}

export interface PeriodCloses {
  closedThrough: string | null;
  closes: { id: number; period: string; closedBy: number; createdAt: string }[];
}

export interface OpenDocument {
  /**
   * sale/purchase/opening 各自是獨立的 id 空間——立沖送出時必須連著 docType 一起帶。
   * 'prepaid'（0027，B9）＝這一列是收付款單的預收/預付餘額（id 是收付款單號），
   * 分開列、不與未沖單據互抵；它不能被新收款沖銷，只能拿去沖別的單據
   */
  docType: "sale" | "purchase" | "opening" | "prepaid";
  id: number;
  docDate: string;
  /** 退回／折讓後的淨額（不是原單金額）——顯示時要講清楚，否則對不上銷貨／進貨頁的數字 */
  total: number;
  /** 已沖回應收／應付的退回金額（掛其他應付款與退現金的部分不算在內） */
  returned: number;
  allocated: number;
  /**
   * 先前「未指定沖銷」的收付款餘額依日期沖最舊分攤到這張單的金額（R6 統一口徑，
   * 與帳齡同一條規則）——remaining 已扣掉它，畫面分欄顯示才解釋得了數字
   */
  fifoApplied: number;
  remaining: number;
}

/** GET /cash-docs/:id 的沖銷明細列（R6）：沖了哪張單、多少錢、那張單現在還剩多少 */
export interface CashDocAllocationDetail {
  targetType: "sale" | "purchase" | "opening";
  targetId: number;
  amount: number;
  /** true＝事後用預收/預付餘額沖用（有自己的沖用日與傳票）；false＝建單當下的立沖 */
  fromPrepaid: boolean;
  allocDate: string | null;
  journalEntryId: number | null;
  targetDocDate: string | null;
  /** 目標單退回後淨額；null＝目標單已作廢/沖銷（立沖紀錄照列，是軌跡） */
  targetTotal: number | null;
  /** 目標單「當下」未沖餘額（含 FIFO 口徑） */
  targetRemaining: number | null;
}

export interface CashDocDetail extends CashDocRow {
  partnerName: string;
  accountId: number;
  journalEntryId: number | null;
  /** 預收/預付還剩多少可沖用（unappliedAmount − 已沖用；作廢＝0） */
  prepaidRemaining: number;
  allocations: CashDocAllocationDetail[];
}

/** 期初應收／應付單（0023，B6）：設定頁的清單列 */
export interface OpeningBalanceRow {
  id: number;
  kind: "receivable" | "payable";
  partnerId: number;
  partnerName: string;
  entryDate: string;
  docDate: string;
  dueDate: string | null;
  amount: number;
  memo: string;
  journalEntryId: number | null;
  /** 0030 作廢層：已作廢的單 remaining 恆為 0，合計與沖銷清單皆排除 */
  voidedAt: string | null;
  voidReason: string | null;
  allocated: number;
  remaining: number;
}

/** 庫存異動明細帳（R9，0035）：單一商品逐筆異動＋逐筆結存 */
export interface InventoryMovementLedger {
  product: { id: number; sku: string; name: string; unit: string };
  from: string | null;
  to: string | null;
  opening: { qty: number; amount: number };
  rows: {
    id: number;
    docDate: string;
    direction: "in" | "out";
    qty: number;
    unitCost: number;
    amount: number;
    sourceType: string;
    sourceId: number;
    /** 來源單據（作廢回沖的列標明「作廢回補／回沖」） */
    sourceLabel: string;
    balanceQty: number;
    balanceAmount: number;
  }[];
  closing: { qty: number; amount: number };
}

/** 折舊明細表（gap 3.7）：各資產的年度折舊、累折、帳面淨值 */
export interface DepreciationScheduleRow {
  assetId: number;
  name: string;
  categoryLabel: string;
  startDate: string;
  usefulYears: number;
  cost: number;
  salvage: number;
  openingAccum: number;
  yearDepreciation: number;
  accumulated: number;
  bookValue: number;
  status: "active" | "disposed";
  disposedAt: string | null;
}

export interface DepreciationSchedule {
  year: number;
  rows: DepreciationScheduleRow[];
  totals: { cost: number; openingAccum: number; yearDepreciation: number; accumulated: number; bookValue: number };
}

export interface LedgerReport {
  account: { code: string; name: string; type: string };
  from: string;
  to: string;
  opening: number;
  lines: { entryId: number; entryDate: string; memo: string; debit: number; credit: number; balance: number }[];
  closing: number;
}

export interface CashFlow {
  from: string;
  to: string;
  opening: number;
  operating: number;
  investing: number;
  financing: number;
  net: number;
  closing: number;
  detail: { entryId: number; date: string; memo: string; activity: "operating" | "investing" | "financing"; amount: number }[];
}
