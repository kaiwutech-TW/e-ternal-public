import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const accountType = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);
export const movementDirection = pgEnum("movement_direction", ["in", "out"]);
export const docSource = pgEnum("doc_source", [
  "purchase",
  "sale",
  "manual",
  "receipt",
  "payment",
  "opening",
  "expense",
  "depreciation",
  "disposal",
  "closing",
  // 退回／折讓共用同一個來源別（單頭的 kind 才區分退回與折讓）：
  // 再拆 sale_allowance/purchase_allowance 會讓 cash_doc_allocations.target_type 的合法值爆炸，
  // 而那一欄目前只認 sale/purchase 兩種
  "sale_return",
  "purchase_return",
  // 扣繳支出單（付個人的租金／專業服務費等，migration 0015）：借費用／貸 2211、2212、現金
  "withholding",
  // 庫存調整單（盤盈／盤虧／報廢，migration 0026）：盤盈借 1301 貸 7121、盤虧報廢借 7521 貸 1301
  "adjustment",
  // 發薪作業定案的計提傳票（migration 0041）：借 6111/6113/6114、貸 2202/2212/2203
  "payroll",
]);
export const cashDocKind = pgEnum("cash_doc_kind", ["receipt", "payment"]);
export const claimStatus = pgEnum("claim_status", ["submitted", "approved", "rejected", "paid"]);
export const expenseDocType = pgEnum("expense_doc_type", ["einvoice", "receipt", "other"]);
export const contractStatus = pgEnum("contract_status", ["draft", "active", "ended", "terminated"]);

export const partners = pgTable("partners", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  taxId: char("tax_id", { length: 8 }),
  isCustomer: boolean("is_customer").notNull().default(false),
  isSupplier: boolean("is_supplier").notNull().default(false),
  // 自然人（個人房東、個人接案者）：付款給他們**可能**有代扣與年度憑單義務，流程與付公司不同。
  // 要不要扣、扣多少、什麼時候申報，系統一律不判斷（沒有門檻與適用情形的模型），由使用者查證後填。
  // DB CHECK 保證 is_individual 為真時 tax_id 必為 NULL（統編是營利事業的識別碼）。
  isIndividual: boolean("is_individual").notNull().default(false),
  /**
   * ⚠️ 個人資料（PII）：身分證統一編號／居留證號，只有年度憑單申報需要。
   * 紀律（migration 0015 有完整說明）：不得出現在任何飛行紀錄／規格文件／匯出範例／測試 fixture
   * 的真實值中（本 repo 可能公開）；不建索引；不進 list API 的預設回傳——
   * GET /partners 只回 hasIdNo 布林值，明文走單筆專用端點且限財務／管理者。
   */
  idNo: text("id_no"),
  // ── 0022 補齊（B1／3.1）：NULL 一律表示「未設定」而不是 0 ──
  contactPerson: text("contact_person"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  shipToAddress: text("ship_to_address"),
  /** 付款條件（天）：NULL＝未約定（帳齡退回以單據日估算）；0＝貨到付款（當天到期） */
  paymentTermDays: integer("payment_term_days"),
  /** 信用額度（整數元）：NULL＝不設限。超過只提示不阻擋——授信是商業判斷不是系統判斷 */
  creditLimit: integer("credit_limit"),
  /** 業務負責人（員工主檔）：會跑客戶但不登入系統的業務也存在，所以指向 employees 而非 users */
  salesOwnerEmployeeId: integer("sales_owner_employee_id").references(() => employees.id),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  unit: text("unit").notNull().default("個"),
  // ── 0022 補齊（B2／3.2）──
  /** 標準售價（整數元）：NULL＝未定價。開單時帶入為預設單價、可覆寫；標準成本刻意不設（移動加權平均） */
  listPrice: integer("list_price"),
  category: text("category"),
  /**
   * 服務項目（運費、安裝費、顧問費）：不入庫存——銷貨跳過在庫檢查、成本 0、不寫庫存異動。
   * 進貨側不接受服務項目（進貨拋轉一律借記存貨，服務費記成存貨會讓資產負債表虛胖）。
   */
  isService: boolean("is_service").notNull().default(false),
  /** 安全庫存：NULL＝不設。低於此量時庫存頁提示（不阻擋任何單據） */
  minStock: integer("min_stock"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  type: accountType("type").notNull(),
  // 停用而非刪除：歷史傳票必須永遠查得到科目名稱
  active: boolean("active").notNull().default(true),
  // 系統科目：被拋轉邏輯硬引用（core 的 SYSTEM_ACCOUNT_CODES），不可停用、不可改碼
  isSystem: boolean("is_system").notNull().default(false),
  // 現金科目：現金流量表與儀表板現金水位的取數依據（限資產類）。
  // 之所以是欄位而非寫死代號清單：使用者自建的銀行帳戶科目（1104 銀行存款－玉山之類）
  // 必須能被算進現金流量表，否則那些錢會在報表間憑空消失
  isCash: boolean("is_cash").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journalEntries = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  entryDate: date("entry_date").notNull(),
  memo: text("memo").notNull().default(""),
  sourceType: docSource("source_type"),
  sourceId: integer("source_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // ── 0025（B4）作廢層：只有 source_type='manual' 的傳票能直接作廢（系統傳票作廢其來源單據）。
  // 作廢＝產生反向傳票（reversal_entry_id 自參照）＋標記，永不刪除；兩張傳票都留在總帳上對沖
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by"),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id"),
});

export const journalLines = pgTable("journal_lines", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull().references(() => journalEntries.id),
  accountId: integer("account_id").notNull().references(() => accounts.id),
  debit: integer("debit").notNull().default(0),
  credit: integer("credit").notNull().default(0),
  /** 行摘要（0038）：這一行在動什麼。手工傳票用；自動拋轉留空（語意由來源單據承載） */
  memo: text("memo").notNull().default(""),
});

export const purchases = pgTable(
  "purchases",
  {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  docDate: date("doc_date").notNull(),
  subtotal: integer("subtotal").notNull(),
  tax: integer("tax").notNull(),
  total: integer("total").notNull(),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  invTrack: char("inv_track", { length: 2 }),
  invNo: char("inv_no", { length: 8 }),
  /**
   * 供應商發票開立日期（憑證日，0029／R20）：401 進項歸期優先用它——
   * 發票 6/30 開、貨 7/2 才入帳時，doc_date（帳務日）與憑證歸期是兩回事。
   * NULL＝本欄位出現前的舊單或尚未登錄，歸期退回 doc_date 並於 401 產檔出聲。
   */
  invDate: date("inv_date"),
  invFormat: char("inv_format", { length: 2 }).notNull().default("25"),
  deductionCode: char("deduction_code", { length: 1 }).notNull().default("1"),
  purchaseOrderId: integer("purchase_order_id"), // 由採購單收貨產生時回連（migration 0009）
  /** 建單當下解析到的營業稅率（bp）；NULL＝本欄位出現前的舊單 */
  vatRateBp: integer("vat_rate_bp"),
  /** 付款到期日（0033）：doc_date＋供應商付款條件天數的預設，可覆寫；NULL＝未約定或舊單，應付帳齡退回以單據日估算 */
  dueDate: date("due_date"),
  // ── 0025（B4）作廢層：作廢＝反向傳票＋標記，401／餘額／匯出以 voided_at 排除。
  // 條件：原單期間未關帳、無退出／折讓單、在庫量足以沖回原入庫量（服務層把關）
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // R5（0029）：同一供應商的同一張發票只能登錄一次——重複列報進項稅＝少繳稅。
  // 排除未登錄與已作廢：作廢重開的新單要能沿用同一號碼（作廢單的進項不申報）
  (t) => [
    uniqueIndex("uq_purchases_supplier_invoice")
      .on(t.partnerId, t.invTrack, t.invNo)
      .where(sql`inv_no IS NOT NULL AND voided_at IS NULL`),
  ],
);

export const purchaseLines = pgTable("purchase_lines", {
  id: serial("id").primaryKey(),
  purchaseId: integer("purchase_id").notNull().references(() => purchases.id),
  productId: integer("product_id").notNull().references(() => products.id),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  amount: integer("amount").notNull(),
});

export const sales = pgTable("sales", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  docDate: date("doc_date").notNull(),
  subtotal: integer("subtotal").notNull(),
  tax: integer("tax").notNull(),
  total: integer("total").notNull(),
  cogs: integer("cogs").notNull(),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
  // ── 0025（B4）：沖銷旗標仍是 reversal_entry_id（0004），這三欄補「誰、何時、為什麼」的軌跡。
  // 0025 前經發票作廢連動沖銷的舊單這三欄為 NULL
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  orderId: integer("order_id"), // 由訂單出貨產生時回連（migration 0008）
  /** 建單當下解析到的營業稅率（bp）；NULL＝本欄位出現前的舊單。零稅率單快照為 0 */
  vatRateBp: integer("vat_rate_bp"),
  /** 收款到期日（doc_date＋付款條件天數的預設，可覆寫）；NULL＝未約定或 0022 前的舊單，帳齡退回以單據日估算 */
  dueDate: date("due_date"),
  // ── 0028（B12）課稅別：'1' 應稅／'2' 零稅率／'3' 免稅（附件五代號，'3' 目前服務層拒收——
  // 兼營免稅要用 403 申報，本系統未支援）。零稅率必須指明經海關與否（401 分兩欄），
  // 證明文件號碼可事後補登（PATCH /sales/:id/zero-tax-cert）；系統不驗證文件真偽
  taxType: char("tax_type", { length: 1 }).notNull().default("1"),
  /** 零稅率：true＝經海關出口（申報書代號 15）；false＝非經海關（代號 7）；非零稅率為 NULL */
  zeroTaxViaCustoms: boolean("zero_tax_via_customs"),
  /** 零稅率證明文件號碼（經海關＝出口報單號碼；非經海關＝外匯證明文件號碼等）；缺＝出聲提醒 */
  zeroTaxCertNo: text("zero_tax_cert_no"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const saleLines = pgTable("sale_lines", {
  id: serial("id").primaryKey(),
  saleId: integer("sale_id").notNull().references(() => sales.id),
  productId: integer("product_id").notNull().references(() => products.id),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  amount: integer("amount").notNull(),
  cost: integer("cost").notNull(),
});

export const invoiceStatus = pgEnum("invoice_status", ["issued", "canceled"]);
export const invoiceMode = pgEnum("invoice_mode", ["B2B", "B2C"]);

export const companyProfile = pgTable("company_profile", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull(),
  taxId: char("tax_id", { length: 8 }).notNull(),
  address: text("address"),
  personInCharge: text("person_in_charge"),
  telephone: text("telephone"),
  email: text("email"),
  taxRegistrationNo: char("tax_registration_no", { length: 9 }),
  cityCode: char("city_code", { length: 1 }),
  // ── 0024：401 申報人（第 99-103 欄）與委託記帳士（第 98／104 欄）──
  filerName: text("filer_name"),
  /** 申報人身分證統一編號：PII，紀律同 partners.id_no（可能是 pii1$ 密文，讀明文走專用端點） */
  filerIdNo: text("filer_id_no"),
  filerAreaCode: text("filer_area_code"),
  filerPhone: text("filer_phone"),
  filerExt: text("filer_ext"),
  /** 委託記帳士登錄字號：有值＝委託申報（第 98 欄 2）、空＝自行申報（第 98 欄 1） */
  declarationAgentNo: text("declaration_agent_no"),
  /**
   * 兼營免稅／特種稅額標記（0028，B12）：true＝本公司兼營免稅或特種稅額銷售。
   * 兼營要用 403 申報（含不得扣抵比例計算），本系統未支援——標記後 generate401 直接 422
   * 指路，而不是靜默產出一份看起來完全正常、實則報錯類別的 401。
   */
  vatMixedBusiness: boolean("vat_mixed_business").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 401 申報紀錄（0024）：一列＝一期存檔的申報結果。
 * 存在的理由是留抵是跨期的鏈——本期第 88 欄「上期累積留抵」＝上期的第 95 欄「累積留抵」，
 * 不存每期結果，鏈就斷在每一次產檔之後。period 唯一；更正申報＝刪最新一列重存（服務層把關）。
 */
export const vatReturns = pgTable("vat_returns", {
  id: serial("id").primaryKey(),
  period: char("period", { length: 6 }).notNull().unique(),
  rocPeriod: char("roc_period", { length: 5 }).notNull(),
  outputSales: integer("output_sales").notNull(),
  outputTax: integer("output_tax").notNull(),
  deductibleInputTax: integer("deductible_input_tax").notNull(),
  prevCarryForward: integer("prev_carry_forward").notNull(),
  payable: integer("payable").notNull(),
  carryForward: integer("carry_forward").notNull(),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invoiceTracks = pgTable("invoice_tracks", {
  id: serial("id").primaryKey(),
  period: char("period", { length: 6 }).notNull(),
  track: char("track", { length: 2 }).notNull(),
  rangeStart: integer("range_start").notNull(),
  rangeEnd: integer("range_end").notNull(),
  nextNo: integer("next_no").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invoices = pgTable(
  "invoices",
  {
    id: serial("id").primaryKey(),
    // 同一銷貨單僅能有一張 issued 發票（partial unique index，見 0004）；作廢後可重開。
    // 0034 起 nullable：發票來源泛化——sale_id 與 asset_id 恰有一個有值
    // （CHECK ck_invoices_single_source），NULL＝處分發票
    saleId: integer("sale_id").references(() => sales.id),
    /**
     * 處分發票的來源資產（0034）：固定資產處分認列的 2288 銷項稅額，開了發票才會進 401
     * （401 銷項取數來源是發票清單）。金額＝處分價款、稅額＝處分稅額（取自 fixed_assets 的
     * disposal_proceeds／disposal_tax 落地值，不重算）。同一筆處分至多一張 issued 發票。
     */
    assetId: integer("asset_id").references(() => fixedAssets.id),
    invoiceNumber: char("invoice_number", { length: 10 }).notNull().unique(),
    invoiceDate: date("invoice_date").notNull(),
    mode: invoiceMode("mode").notNull(),
    buyerTaxId: char("buyer_tax_id", { length: 8 }),
    buyerName: text("buyer_name").notNull(),
    salesAmount: integer("sales_amount").notNull(),
    taxAmount: integer("tax_amount").notNull(),
    totalAmount: integer("total_amount").notNull(),
    /**
     * 開立當下解析到的營業稅率（bp）。B2C 的 sales_amount 依 MIG 慣例存的是**含稅總額**，
     * 401 必須把它拆回未稅＋稅額——那個拆算若用「今天的費率」，新增一列參數就會
     * 追溯改掉已申報期間的申報數字。存快照之後一律用開立當時的費率拆。
     */
    vatRateBp: integer("vat_rate_bp"),
    /**
     * 課稅別快照（0028，B12）：'1' 應稅／'2' 零稅率。與 vat_rate_bp 同一個理由——
     * 401 媒體檔依發票產明細，課稅別必須是開立當時那張銷貨單的，不能事後跟著 sales 改。
     * 零稅率發票 sales_amount 存 0（對齊 XML 的 SalesAmount＝應稅銷售額），金額在 total_amount。
     */
    taxType: char("tax_type", { length: 1 }).notNull().default("1"),
    randomNumber: char("random_number", { length: 4 }).notNull(),
    printMark: char("print_mark", { length: 1 }).notNull(),
    /**
     * 載具／捐贈碼快照（0029，B5 尾款）：開立當下落地，事後查得到、篩得了——
     * 只存在 XML 裡的欄位等於不存在。NULL＝0029 前的舊發票（值只在 XML）。
     * carrier_id 存 MIG 的 CarrierId1（本系統開立時 Id1＝Id2，存一份即可）。
     */
    carrierType: text("carrier_type"),
    carrierId: text("carrier_id"),
    donateMark: char("donate_mark", { length: 1 }),
    npoban: text("npoban"),
    status: invoiceStatus("status").notNull().default("issued"),
    cancelReason: text("cancel_reason"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    xml: text("xml").notNull(),
    cancelXml: text("cancel_xml"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_invoices_sale_issued").on(t.saleId).where(sql`status = 'issued'`),
    uniqueIndex("uq_invoices_asset_issued").on(t.assetId).where(sql`status = 'issued'`),
  ],
);

export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /**
   * 停用（離職）＝不再出現在報銷／業務負責人等新單據的選項，歷史單據照樣查得到名字。
   * 0022 之前這個欄位沒有任何寫成 false 的入口，下游的把關全是死碼——現在走 PATCH /employees/:id。
   */
  active: boolean("active").notNull().default(true),
  // ── 0022 補齊（B3／3.3）。部門欄刻意不加：整套系統沒有部門維度，見 migration 註解 ──
  title: text("title"),
  phone: text("phone"),
  email: text("email"),
  hireDate: date("hire_date"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // ── 0039 HR 出勤地基（0022「不加部門欄」的決定翻案，理由見 migration 檔頭）──
  departmentId: integer("department_id"),
  /** 直屬主管（可與部門主管不同）；簽核鏈的取數來源之一 */
  managerEmployeeId: integer("manager_employee_id"),
  /** fulltime／parttime（text 不用 enum，同 contracts.kind 的理由） */
  employmentType: text("employment_type").notNull().default("fulltime"),
  /** 免打卡（老闆／部分主管）：不產生出勤異常，打卡頁仍可自願打 */
  punchExempt: boolean("punch_exempt").notNull().default(false),
});

export const expenseClaims = pgTable("expense_claims", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  claimDate: date("claim_date").notNull(),
  status: claimStatus("status").notNull().default("submitted"),
  memo: text("memo").notNull().default(""),
  total: integer("total").notNull(),
  rejectReason: text("reject_reason"),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  paidJournalEntryId: integer("paid_journal_entry_id").references(() => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // ── 0036：核准留痕（誰核的、何時核的——單據上查得到，不必去翻只有 admin 看得到的 audit_logs）
  approvedByUserId: integer("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  // 'employee'＝員工代墊（核准貸 2201，之後付款）；'company'＝公司支付（核准直接貸付款科目、進 paid）
  paidBy: text("paid_by").notNull().default("employee"),
  // ── 0036 作廢層（形狀照 0025）：401 與彙總以 voided_at 排除；status 保持原值
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
  paidReversalEntryId: integer("paid_reversal_entry_id").references(() => journalEntries.id),
});

export const expenseItems = pgTable("expense_items", {
  id: serial("id").primaryKey(),
  claimId: integer("claim_id").notNull().references(() => expenseClaims.id),
  accountCode: text("account_code").notNull(),
  description: text("description").notNull().default(""),
  docType: expenseDocType("doc_type").notNull(),
  amount: integer("amount").notNull(),
  tax: integer("tax").notNull().default(0),
  deductible: boolean("deductible").notNull().default(false),
  invoiceNumber: char("invoice_number", { length: 10 }),
  invoiceDate: date("invoice_date"),
  sellerTaxId: char("seller_tax_id", { length: 8 }),
  image: text("image"),
  /**
   * 掃到的電子發票 QR 左碼原文（0048）。稅額若來自憑證，這串就是它唯一的出處——
   * 銷售額刻意不另存一份欄位（從這裡解得出來，存兩份會漂移）。
   */
  qrPayload: text("qr_payload"),
  /** 兩個稅額來源不一致時使用者選了哪一個（'voucher'／'rate'）；重送時沿用，不無聲換回費率回推 */
  taxSource: text("tax_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contracts = pgTable("contracts", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").references(() => partners.id),
  counterparty: text("counterparty").notNull(),
  title: text("title").notNull(),
  amount: integer("amount"),
  signDate: date("sign_date"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  status: contractStatus("status").notNull().default("active"),
  memo: text("memo").notNull().default(""),
  fileName: text("file_name"),
  fileData: text("file_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** 合約類型（0037）：project／retainer／maintenance／other。text 不是 enum——使用者可自訂 */
  kind: text("kind").notNull().default("other"),
  /** 方向（0046）：'sale'＝我方請款（銷貨側）；'purchase'＝我方付款（進貨側）。與 kind 正交 */
  direction: text("direction").notNull().default("sale"),
  /** 續約提醒提前天數；NULL＝系統預設 45 天 */
  renewNoticeDays: integer("renew_notice_days"),
  /** 續約鏈：這份合約從哪一份續來（0037 紀律：續約＝開新約成鏈，不是改舊約日期） */
  renewedFromId: integer("renewed_from_id"),
});

/**
 * 合約的分期請款計畫（0037）。計畫不是單據：未請款的列可改可刪；
 * sale_id 非 NULL 即鎖住（要改先作廢那張銷貨單，作廢後視同未請款可重開）。
 */
export const contractInstallments = pgTable("contract_installments", {
  id: serial("id").primaryKey(),
  contractId: integer("contract_id").notNull().references(() => contracts.id),
  seq: integer("seq").notNull(),
  dueDate: date("due_date").notNull(),
  amount: integer("amount").notNull(), // 未稅整數元
  description: text("description").notNull().default(""),
  saleId: integer("sale_id").references(() => sales.id),
  /** 進貨側（0046）：勾對到哪張進貨單。與 sale_id 互斥（CHECK）；作廢後視同未勾對 */
  purchaseId: integer("purchase_id").references(() => purchases.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cashDocs = pgTable("cash_docs", {
  id: serial("id").primaryKey(),
  kind: cashDocKind("kind").notNull(),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  docDate: date("doc_date").notNull(),
  amount: integer("amount").notNull(),
  accountId: integer("account_id").notNull().references(() => accounts.id),
  memo: text("memo").notNull().default(""),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  // ── 0027（B9）溢收溢付：建單當下超過「該對象未沖餘額合計」的部分——收款掛 2231 預收款項、
  // 付款掛 1212 預付貨款，不沖應收/應付（應收不為負）。這張單剩餘可沖用的預收/預付
  // ＝本欄 −（本單 from_prepaid 沖銷列的合計）
  unappliedAmount: integer("unapplied_amount").notNull().default(0),
  // ── 0025（B4）作廢層：反向傳票沖現金與應收/應付；立沖紀錄保留原列，彙總一律排除已作廢單
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inventoryMovements = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  direction: movementDirection("direction").notNull(),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 14, scale: 4 }).notNull(),
  amount: integer("amount").notNull(),
  sourceType: docSource("source_type").notNull(),
  sourceId: integer("source_id").notNull(),
  /**
   * 單據日期（0035，R9）：明細帳按「業務發生日」歸期用。寫入點一律帶來源單據的 doc_date
   * （作廢回沖帶原單日期，與反向傳票同日；庫存開帳帶開帳日）——created_at 是寫入時刻，
   * 補登上個月的單會歸錯月。0035 前的舊資料已按來源單據回填（規則見 migration 檔頭）
   */
  docDate: date("doc_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── 庫存調整單（migration 0026，B8）：盤盈／盤虧／報廢共用一種單 ──
// reason 記「為什麼調」：count＝盤點差異、scrap＝報廢（破損）、expiry＝過期報廢。
// 方向不在單頭而在明細（direction）：一次盤點常常有的商品盤盈、有的盤虧，拆兩張單
// 會讓「這次盤點」在系統裡變成兩筆不相干的紀錄。
export const adjustmentReason = pgEnum("adjustment_reason", ["count", "scrap", "expiry"]);

export const inventoryAdjustments = pgTable("inventory_adjustments", {
  id: serial("id").primaryKey(),
  docDate: date("doc_date").notNull(),
  reason: adjustmentReason("reason").notNull(),
  memo: text("memo").notNull().default(""),
  /** 盤盈合計（借 1301 的金額）；totalOut＝盤虧報廢合計（貸 1301）。落地讓清單頁不必回頭加總明細 */
  totalIn: integer("total_in").notNull().default(0),
  totalOut: integer("total_out").notNull().default(0),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // 作廢層（與 0025 六種單據同一形狀）：反向傳票沖總帳、庫存以原成本反向回補，原單永不刪除
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
});

export const inventoryAdjustmentLines = pgTable("inventory_adjustment_lines", {
  id: serial("id").primaryKey(),
  adjustmentId: integer("adjustment_id").notNull().references(() => inventoryAdjustments.id),
  productId: integer("product_id").notNull().references(() => products.id),
  direction: movementDirection("direction").notNull(),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  /** 調整當下的移動平均成本快照：事後查「這筆報廢為什麼是這個金額」不必重算歷史 */
  unitCost: numeric("unit_cost", { precision: 14, scale: 4 }).notNull(),
  amount: integer("amount").notNull(),
  /** 盤點入口才有（手動調整為 NULL）：帳面量與實盤量都落地，差異怎麼算出來的一目了然 */
  bookQty: numeric("book_qty", { precision: 12, scale: 3 }),
  countedQty: numeric("counted_qty", { precision: 12, scale: 3 }),
});

// ── 0039 HR 出勤地基（設計紀律見 migration 檔頭：打卡 append-only、部門只服務 HR）──

export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  parentId: integer("parent_id"),
  managerEmployeeId: integer("manager_employee_id").references(() => employees.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shifts = pgTable("shifts", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#0071e3"),
  startTime: text("start_time").notNull(), // time 欄位以 "HH:MM[:SS]" 字串進出（drizzle time 型別）
  endTime: text("end_time").notNull(), // 小於 startTime＝跨日班
  /** 休息時間多段：[{start:"12:00",end:"13:00"}] */
  breaks: jsonb("breaks").notNull().default([]),
  /** 打卡歸屬日切點：這個時刻（含）之前的打卡歸前一天 */
  dayCutoff: text("day_cutoff").notNull().default("04:00"),
  active: boolean("active").notNull().default(true),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 排班是計畫不是單據：一天一班、可改可刪；落地後逐日一列（改某天不影響其他天） */
export const schedules = pgTable(
  "schedules",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull().references(() => employees.id),
    workDate: date("work_date").notNull(),
    shiftId: integer("shift_id").notNull().references(() => shifts.id),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("schedules_employee_date_idx").on(t.employeeId, t.workDate)],
);

/** 打卡紀錄 append-only：打錯不改原列，補卡走申請（下一批）產生更正列 */
export const punches = pgTable("punches", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  punchedAt: timestamp("punched_at", { withTimezone: true }).notNull().defaultNow(),
  direction: text("direction").notNull(), // 'in' | 'out'
  /** 出勤日：依班別 day_cutoff 換算後落地（不即時推導——班別事後改了歷史不能漂） */
  workDate: date("work_date").notNull(),
  sourceIp: text("source_ip").notNull().default(""),
  method: text("method").notNull().default("web"), // web／correction／import
  memo: text("memo").notNull().default(""),
});

/** 出勤設定（單列，同 agentSettings 模式） */
export const attendanceSettings = pgTable("attendance_settings", {
  id: integer("id").primaryKey().default(1),
  ipAllowlist: text("ip_allowlist").notNull().default(""),
  flexMinutes: integer("flex_minutes").notNull().default(0),
  /** 遲到早退計法（0045）：'schedule'＝與表定起訖比（預設）；'shortfall'＝補時制，當日工時不足表定的分鐘數記早退 */
  lateEarlyMode: text("late_early_mode").notNull().default("schedule"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer("updated_by").references(() => users.id),
});

// ── 0040 假別／額度帳／申請簽核／行事曆（設計紀律見 migration 檔頭）──

export const leaveTypes = pgTable("leave_types", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // 建立後不可改（額度帳與申請對著它）
  name: text("name").notNull(),
  /** 內建法定假別：只能停用不能刪（名稱是結構不是數字，數字一律使用者自填） */
  isSystem: boolean("is_system").notNull().default(false),
  active: boolean("active").notNull().default(true),
  /** 給薪比率（%）：NULL＝未查證填入，算薪時明講不算——系統不預填任何比率 */
  payRatioPercent: integer("pay_ratio_percent"),
  sourceNote: text("source_note").notNull().default(""),
  minUnitMinutes: integer("min_unit_minutes").notNull().default(30),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 額度帳只存「給了多少」；已用一律由核准的請假單推導（單一事實來源在事實那邊） */
export const leaveBalances = pgTable(
  "leave_balances",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull().references(() => employees.id),
    leaveTypeId: integer("leave_type_id").notNull().references(() => leaveTypes.id),
    year: integer("year").notNull(),
    grantedMinutes: integer("granted_minutes").notNull(),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [uniqueIndex("leave_balances_emp_type_year_idx").on(t.employeeId, t.leaveTypeId, t.year)],
);

/** 三種申請單同一張表（kind: leave/overtime/punch_correction）；專屬欄位可 NULL，服務層按 kind 驗形狀 */
export const hrRequests = pgTable("hr_requests", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | canceled
  reason: text("reason").notNull().default(""),
  leaveTypeId: integer("leave_type_id").references(() => leaveTypes.id),
  startAt: timestamp("start_at", { withTimezone: true }),
  endAt: timestamp("end_at", { withTimezone: true }),
  /** 請假／加班時數（分）：起訖是憑據，扣額度與算薪都看這欄 */
  minutes: integer("minutes"),
  /** 加班日型（workday/restday/regular_off/holiday）：存申請人選的值，系統不判斷「這天是什麼日」 */
  dayType: text("day_type"),
  workDate: date("work_date"),
  direction: text("direction"),
  claimedTime: text("claimed_time"), // 'HH:MM'（台北時間）
  /** 忘打卡核准後回填：這張單產生了哪筆更正卡 */
  correctionPunchId: integer("correction_punch_id").references(() => punches.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

/** 簽核鏈（提交時快照）：之後改組織圖不影響在途單——與費率快照同一個教訓 */
export const hrRequestSteps = pgTable(
  "hr_request_steps",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id").notNull().references(() => hrRequests.id),
    stepNo: integer("step_no").notNull(),
    approverEmployeeId: integer("approver_employee_id").notNull().references(() => employees.id),
    status: text("status").notNull().default("waiting"), // waiting | pending | approved | rejected | skipped
    comment: text("comment").notNull().default(""),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: integer("decided_by_user_id").references(() => users.id),
  },
  (t) => [uniqueIndex("hr_request_steps_req_step_idx").on(t.requestId, t.stepNo)],
);

/** 行事曆：國定假日／補班日。系統不內建任何年度——人事行政局每年公告，使用者自填或批次貼上 */
export const calendarDays = pgTable("calendar_days", {
  day: date("day").primaryKey(),
  kind: text("kind").notNull(), // 'holiday' | 'makeup_workday'
  name: text("name").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── 0041 薪資（錢的參數全使用者自填；設計紀律見 migration 檔頭）──

/** 員工薪資檔＝歷次紀錄：調薪新增一列，舊列不動（重算過去月份要找得到當月那一列） */
export const employeeSalaries = pgTable(
  "employee_salaries",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull().references(() => employees.id),
    validFrom: date("valid_from").notNull(),
    payType: text("pay_type").notNull(), // 'monthly' | 'hourly'
    baseAmount: integer("base_amount").notNull(),
    /** 月薪→時薪除數：NULL＝未設定，算加班費／請假扣款時明講不算（系統不替使用者選算法） */
    hourlyDivisor: integer("hourly_divisor"),
    /** 伙食津貼（0044）：每月固定加項，金額使用者自填；免稅額度不內建（長尾另站） */
    mealAllowance: integer("meal_allowance").notNull().default(0),
    /** 時薪基底要不要含伙食津貼——公司政策使用者自選，預設 false＝只除本薪 */
    mealAllowanceInBase: boolean("meal_allowance_in_base").notNull().default(false),
    laborInsEmployee: integer("labor_ins_employee").notNull().default(0),
    laborInsEmployer: integer("labor_ins_employer").notNull().default(0),
    healthInsEmployee: integer("health_ins_employee").notNull().default(0),
    healthInsEmployer: integer("health_ins_employer").notNull().default(0),
    pensionEmployer: integer("pension_employer").notNull().default(0),
    sourceNote: text("source_note").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("employee_salaries_emp_from_idx").on(t.employeeId, t.validFrom)],
);

/** 加班費率：某日型加班第 N 分鐘起用多少倍率（萬分位）——倍率使用者自填附依據 */
export const overtimeRates = pgTable(
  "overtime_rates",
  {
    id: serial("id").primaryKey(),
    dayType: text("day_type").notNull(),
    fromMinutes: integer("from_minutes").notNull(),
    multiplierBp: integer("multiplier_bp").notNull(), // 13400＝1.34 倍
    /** 「以固定時數計」（0042）：非 NULL＝這一級不看實際分鐘，一律以此分鐘數計酬（例假日做 6 給 8） */
    fixedMinutes: integer("fixed_minutes"),
    sourceNote: text("source_note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("overtime_rates_type_from_idx").on(t.dayType, t.fromMinutes)],
);

export const payrollRuns = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  month: text("month").notNull().unique(), // 'YYYY-MM'
  status: text("status").notNull().default("draft"), // draft | finalized
  note: text("note").notNull().default(""),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  finalizedBy: integer("finalized_by").references(() => users.id),
});

/** 計算結果整包快照進 detail：定案後改參數不回頭改已定案的薪資單 */
export const payrollItems = pgTable(
  "payroll_items",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").notNull().references(() => payrollRuns.id),
    employeeId: integer("employee_id").notNull().references(() => employees.id),
    basePay: integer("base_pay").notNull().default(0),
    mealAllowance: integer("meal_allowance").notNull().default(0),
    overtimePay: integer("overtime_pay").notNull().default(0),
    leaveDeduction: integer("leave_deduction").notNull().default(0),
    lateEarlyDeduction: integer("late_early_deduction").notNull().default(0),
    absenceDeduction: integer("absence_deduction").notNull().default(0),
    otherEarning: integer("other_earning").notNull().default(0),
    otherDeduction: integer("other_deduction").notNull().default(0),
    laborInsEmployee: integer("labor_ins_employee").notNull().default(0),
    healthInsEmployee: integer("health_ins_employee").notNull().default(0),
    laborInsEmployer: integer("labor_ins_employer").notNull().default(0),
    healthInsEmployer: integer("health_ins_employer").notNull().default(0),
    pensionEmployer: integer("pension_employer").notNull().default(0),
    netPay: integer("net_pay").notNull().default(0),
    memo: text("memo").notNull().default(""),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [uniqueIndex("payroll_items_run_emp_idx").on(t.runId, t.employeeId)],
);

/** 內建 agent 的公司記憶（0043，OKF 形狀）：agent 提議、人核准才生效；設計紀律見 migration 檔頭 */
/**
 * 週期性支出（0047）：每月/每季/每年固定要付出去的錢（房租、訂閱、保費、稅款繳庫）。
 * **這是計畫不是負債**——不產傳票、不進應付帳款。為什麼不用 contracts：見 migration 檔頭。
 */
export const recurringPayables = pgTable("recurring_payables", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  partnerId: integer("partner_id").references(() => partners.id),
  defaultAccountCode: text("default_account_code"),
  /** 使用者自己查到的依據（服務層擋空字串）——零斷言紀律的落點 */
  basis: text("basis").notNull(),
  intervalMonths: integer("interval_months").notNull(),
  dayOfMonth: integer("day_of_month").notNull(),
  defaultAmount: integer("default_amount").notNull().default(0),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  status: text("status").notNull().default("active"), // active | ended
  memo: text("memo").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id),
});

/** 每期。無 status/paid 欄——已付＝指向的報銷單或傳票存活且未作廢（同 contract_installments） */
export const recurringPayableItems = pgTable(
  "recurring_payable_items",
  {
    id: serial("id").primaryKey(),
    payableId: integer("payable_id").notNull().references(() => recurringPayables.id),
    seq: integer("seq").notNull(),
    dueDate: date("due_date").notNull(),
    amount: integer("amount").notNull(),
    description: text("description").notNull().default(""),
    /** 結清指標二選一（互斥 CHECK）：報銷單（公司支付）或自開的手工傳票 */
    expenseClaimId: integer("expense_claim_id").references(() => expenseClaims.id),
    journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("recurring_payable_items_payable_seq_idx").on(t.payableId, t.seq)],
);

export const agentMemories = pgTable("agent_memories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  type: text("type").notNull().default("fact"),
  tags: text("tags").notNull().default(""),
  status: text("status").notNull().default("proposed"), // proposed | active | archived
  source: text("source").notNull().default("user"), // user | agent
  staleAfter: date("stale_after"),
  proposedBy: integer("proposed_by").references(() => users.id),
  approvedBy: integer("approved_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRole = pgEnum("user_role", ["admin", "gm", "finance", "sales", "purchasing", "employee"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull(),
  employeeId: integer("employee_id").references(() => employees.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** 已生效的 TOTP 密鑰（加密儲存，見 migration 0019）。驗證通過前一個位元都不動 */
  totpSecret: text("totp_secret"),
  /** 設定中的密鑰（見 migration 0020）：與已生效的分開，中途放棄不會讓安全性靜默下降 */
  totpPendingSecret: text("totp_pending_secret"),
  /** NULL＝二階段驗證未生效 */
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
});

/**
 * Agent 的 API 金鑰（見 migration 0021）：依附在使用者身上，不自成一套權限。
 * 略過二階段驗證是刻意的——agent 前面本來就沒有人可以拿手機。
 */
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  userId: integer("user_id").notNull().references(() => users.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** LLM 供應商設定（單列）。系統自己不呼叫 LLM，這是給旁邊的 agent 的統一設定位置 */
export const agentSettings = pgTable("agent_settings", {
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("anthropic"),
  model: text("model").notNull().default(""),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer("updated_by").references(() => users.id),
});

/** 二階段驗證的備援碼：單次有效，用掉記時間但不刪除（「被用過」本身是稽核資訊） */
export const totpRecoveryCodes = pgTable("totp_recovery_codes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  codeHash: text("code_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 操作日誌：只增不刪、不記 body（設計紀律見 migration 0018）。
 * 與 loginFailures 分成兩張表是刻意的——一張為稽核而不刪，一張為計數而必須刪。
 */
export const auditLogs = pgTable("audit_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  userId: integer("user_id").references(() => users.id),
  username: text("username").notNull().default(""),
  role: userRole("role"),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: integer("status").notNull(),
  source: text("source").notNull().default(""),
  targetId: integer("target_id"),
  note: text("note").notNull().default(""),
});

/** 登入節流的計數表（滑動視窗，過期即刪）。長期稽核不看這張表，見 migration 0017 的說明 */
export const loginFailures = pgTable("login_failures", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  source: text("source").notNull().default(""),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const quoteStatus = pgEnum("quote_status", ["open", "won", "lost"]);
export const orderStatus = pgEnum("order_status", ["open", "partial", "closed", "canceled"]);

export const quotes = pgTable("quotes", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  quoteDate: date("quote_date").notNull(),
  status: quoteStatus("status").notNull().default("open"),
  memo: text("memo").notNull().default(""),
  subtotal: integer("subtotal").notNull(),
  tax: integer("tax").notNull(),
  total: integer("total").notNull(),
  orderId: integer("order_id"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  /** 建單當下解析到的營業稅率（bp）；NULL＝本欄位出現前的舊單 */
  vatRateBp: integer("vat_rate_bp"),
  /** 預計交期（0035，gap 3.5）：NULL＝未約定。轉訂單時原樣帶入 */
  expectedDate: date("expected_date"),
  // ── 0032：課稅別走訂單流程（與 sales 的 0028 三欄同形狀；轉訂單、出貨時一路傳遞）
  taxType: char("tax_type", { length: 1 }).notNull().default("1"),
  zeroTaxViaCustoms: boolean("zero_tax_via_customs"),
  zeroTaxCertNo: text("zero_tax_cert_no"),
  // ── 0025（B4）：未拋轉傳票，直接標作廢。與 lost（客戶沒成交）是兩件事——作廢是單子本身建錯
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const quoteLines = pgTable("quote_lines", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id").notNull().references(() => quotes.id),
  productId: integer("product_id").notNull().references(() => products.id),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  amount: integer("amount").notNull(),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  orderDate: date("order_date").notNull(),
  status: orderStatus("status").notNull().default("open"),
  memo: text("memo").notNull().default(""),
  subtotal: integer("subtotal").notNull(),
  tax: integer("tax").notNull(),
  total: integer("total").notNull(),
  quoteId: integer("quote_id").references(() => quotes.id),
  createdBy: integer("created_by").notNull().references(() => users.id),
  /** 建單當下解析到的營業稅率（bp）；NULL＝本欄位出現前的舊單 */
  vatRateBp: integer("vat_rate_bp"),
  /** 預計交期（0035，gap 3.5）：NULL＝未約定。清單頁「今天 > 交期且未結」標逾期（不做自動提醒） */
  expectedDate: date("expected_date"),
  // ── 0032：課稅別（與 sales 0028 同形狀）；shipOrder 開銷貨單時原樣帶入
  taxType: char("tax_type", { length: 1 }).notNull().default("1"),
  zeroTaxViaCustoms: boolean("zero_tax_via_customs"),
  zeroTaxCertNo: text("zero_tax_cert_no"),
  // ── 0032：短交結案三欄。三欄皆 NULL＝全數出清的自動結案；短交結案（close 端點）理由必填。
  // 結案≠取消：取消＝這張單從沒發生（僅限未出貨）；結案＝到此為止，已出貨的憑證全留、剩餘量不再期待
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: integer("closed_by").references(() => users.id),
  closeReason: text("close_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderLines = pgTable("order_lines", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  productId: integer("product_id").notNull().references(() => products.id),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  amount: integer("amount").notNull(),
  shippedQty: numeric("shipped_qty", { precision: 12, scale: 3 }).notNull().default("0"),
});

export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  orderDate: date("order_date").notNull(),
  status: orderStatus("status").notNull().default("open"),
  memo: text("memo").notNull().default(""),
  subtotal: integer("subtotal").notNull(),
  tax: integer("tax").notNull(),
  total: integer("total").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  /** 建單當下解析到的營業稅率（bp）；NULL＝本欄位出現前的舊單 */
  vatRateBp: integer("vat_rate_bp"),
  /** 預計到貨日（0035，gap 3.5）：NULL＝未約定。與 orders.expectedDate 同義（兩邊一起加） */
  expectedDate: date("expected_date"),
  // ── 0032：短交結案三欄（與 orders 同義；三欄皆 NULL＝全數收訖的自動結案）
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: integer("closed_by").references(() => users.id),
  closeReason: text("close_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: serial("id").primaryKey(),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
  productId: integer("product_id").notNull().references(() => products.id),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  amount: integer("amount").notNull(),
  receivedQty: numeric("received_qty", { precision: 12, scale: 3 }).notNull().default("0"),
});

export const assetStatus = pgEnum("asset_status", ["active", "disposed"]);

export const fixedAssets = pgTable("fixed_assets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  assetCode: text("asset_code").notNull(),
  accumCode: text("accum_code").notNull(),
  cost: integer("cost").notNull(),
  salvage: integer("salvage").notNull(),
  usefulYears: integer("useful_years").notNull(),
  startDate: date("start_date").notNull(),
  memo: text("memo").notNull().default(""),
  status: assetStatus("status").notNull().default("active"),
  disposedAt: date("disposed_at"),
  disposalEntryId: integer("disposal_entry_id").references(() => journalEntries.id),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // ── 0031（B14）──登錄作廢（登錄不拋轉傳票，作廢與報價單同型：直接標記、無反向傳票）
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  // 處分明細與處分作廢：價款拆「未稅＋銷項稅額」的軌跡、處分反向傳票與作廢三欄
  disposalProceeds: integer("disposal_proceeds"),
  disposalTax: integer("disposal_tax"),
  disposalReversalEntryId: integer("disposal_reversal_entry_id").references(() => journalEntries.id),
  disposalVoidedAt: timestamp("disposal_voided_at", { withTimezone: true }),
  disposalVoidedBy: integer("disposal_voided_by").references(() => users.id),
  disposalVoidReason: text("disposal_void_reason"),
  /**
   * 處分當時解析到的營業稅率快照（bp，0034）：處分發票可能晚於處分才開，
   * 開票時依處分日重新解析會被事後新增的參數改掉，而 disposal_tax 早已落地。
   * NULL＝0034 前舊處分或未計稅處分，開票時退回依處分日解析並出聲。
   */
  disposalVatRateBp: integer("disposal_vat_rate_bp"),
});

export const assetDepreciations = pgTable(
  "asset_depreciations",
  {
    id: serial("id").primaryKey(),
    assetId: integer("asset_id").notNull().references(() => fixedAssets.id),
    period: char("period", { length: 7 }).notNull(),
    amount: integer("amount").notNull(),
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntries.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_asset_depreciations").on(t.assetId, t.period)],
);

export const periodCloses = pgTable("period_closes", {
  id: serial("id").primaryKey(),
  period: char("period", { length: 7 }).notNull().unique(),
  closedBy: integer("closed_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const returnKind = pgEnum("return_kind", ["return", "allowance"]);

/**
 * 銷貨退回／折讓（migration 0014）。原銷貨單維持存在且金額不變——
 * 不設 sales.reversal_entry_id，那個旗標的語意是「整張單當作沒發生」，部分退回沿用它
 * 會讓整筆交易從報表憑空消失。報表改以「原單金額 − 累計 ar_offset」取數。
 */
export const salesReturns = pgTable("sales_returns", {
  id: serial("id").primaryKey(),
  saleId: integer("sale_id").notNull().references(() => sales.id),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  kind: returnKind("kind").notNull(),
  docDate: date("doc_date").notNull(), // 帳務／庫存日
  certDate: date("cert_date"), // 證明單日期（401 減項將來依它歸期；本批尚未接 401）
  certNo: text("cert_no"),
  memo: text("memo").notNull().default(""),
  subtotal: integer("subtotal").notNull(),
  tax: integer("tax").notNull(),
  total: integer("total").notNull(),
  cogs: integer("cogs").notNull().default(0),
  arOffset: integer("ar_offset").notNull().default(0), // 沖回 1144 的金額
  payableAmount: integer("payable_amount").notNull().default(0), // 掛 2201 其他應付款（應退客戶）
  cashAccountId: integer("cash_account_id").references(() => accounts.id),
  cashAmount: integer("cash_amount").notNull().default(0),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  // ── 0030 作廢層：作廢後 returnable 餘量回復、401 減項與彙總排除；
  // 折讓單（有 cert_no）作廢改產 G0501 作廢折讓證明單訊息
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const saleReturnLines = pgTable("sale_return_lines", {
  id: serial("id").primaryKey(),
  returnId: integer("return_id").notNull().references(() => salesReturns.id),
  saleLineId: integer("sale_line_id").notNull().references(() => saleLines.id),
  productId: integer("product_id").notNull().references(() => products.id),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull().default("0"), // 折讓為 0
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  amount: integer("amount").notNull(),
  cost: integer("cost").notNull().default(0),
});

/** 進貨退出／折讓（migration 0014），與銷貨端對稱 */
export const purchaseReturns = pgTable("purchase_returns", {
  id: serial("id").primaryKey(),
  purchaseId: integer("purchase_id").notNull().references(() => purchases.id),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  kind: returnKind("kind").notNull(),
  docDate: date("doc_date").notNull(),
  certDate: date("cert_date"),
  certNo: text("cert_no"),
  memo: text("memo").notNull().default(""),
  subtotal: integer("subtotal").notNull(),
  tax: integer("tax").notNull(),
  total: integer("total").notNull(),
  // 實際沖減的存貨帳面金額：退出＝當下均價 × 數量、折讓＝折讓額 × 在庫比例
  invCredit: integer("inv_credit").notNull().default(0),
  // 退款額 − invCredit，走 5101；**可為負數**（退還便宜批次時沖存貨的成本大於退款額）
  costDiff: integer("cost_diff").notNull().default(0),
  apOffset: integer("ap_offset").notNull().default(0),
  receivableAmount: integer("receivable_amount").notNull().default(0), // 掛 1148 其他應收款
  cashAccountId: integer("cash_account_id").references(() => accounts.id),
  cashAmount: integer("cash_amount").notNull().default(0),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  // ── 0030 作廢層（與銷貨端對稱）
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseReturnLines = pgTable("purchase_return_lines", {
  id: serial("id").primaryKey(),
  returnId: integer("return_id").notNull().references(() => purchaseReturns.id),
  purchaseLineId: integer("purchase_line_id").notNull().references(() => purchaseLines.id),
  productId: integer("product_id").notNull().references(() => products.id),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull().default("0"),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  amount: integer("amount").notNull(),
  invCredit: integer("inv_credit").notNull().default(0),
});

/**
 * 扣繳類別（migration 0015）：使用者自訂的「白話標籤 → 費用科目 → 費率」設定。
 *
 * 費率一律由使用者填寫並自行註明依據來源；系統**不預填任何費率**。
 * taxRateBp / supplementRateBp 為 basis point（萬分之一，10% = 1000），
 * **NULL＝尚未設定**，與 0（查過、不用扣）語意不同，因此刻意不給 DEFAULT 0。
 */
export const withholdingCategories = pgTable("withholding_categories", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  expenseAccountCode: text("expense_account_code").notNull(),
  taxRateBp: integer("tax_rate_bp"),
  supplementRateBp: integer("supplement_rate_bp"),
  sourceNote: text("source_note"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 扣繳支出單（migration 0015）：一張單同時記「認列多少費用／代扣多少／實付多少」。
 * netAmount 落地（DB CHECK 保證 = gross − tax − supplement 且非負），
 * 因為它就是實際付出去的錢，現金流與對帳直接取它。
 * partnerId 必須指向 isIndividual 的對象——跨表條件在服務層檢查（DB 只能靠 trigger，
 * 而 trigger 是另一份沒人記得的商業邏輯，也給不出脫困指示）。
 */
export const withholdingPayments = pgTable("withholding_payments", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  categoryId: integer("category_id").notNull().references(() => withholdingCategories.id),
  payDate: date("pay_date").notNull(),
  grossAmount: integer("gross_amount").notNull(),
  taxWithheld: integer("tax_withheld").notNull().default(0),
  supplementWithheld: integer("supplement_withheld").notNull().default(0),
  cashAccountId: integer("cash_account_id").notNull().references(() => accounts.id),
  netAmount: integer("net_amount").notNull(),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  memo: text("memo").notNull().default(""),
  /** 建單當下的費率快照（null＝當時尚未設定）：讓年度彙總分得出「漏設費率的 0」與「查過不用扣的 0」 */
  taxRateBpAtEntry: integer("tax_rate_bp_at_entry"),
  supplementRateBpAtEntry: integer("supplement_rate_bp_at_entry"),
  // ── 0025（B4）作廢層：年度彙總（憑單取數來源）以 voided_at 排除——
  // 打錯的單作廢重開後，受領人不會再被掛上不存在的所得
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 級距的 JSON 形狀。**單一事實來源是 `packages/core/src/tax-parameters.ts` 的 `TaxBracket`**，
 * 這裡只是把同一個結構重述一次，好讓 jsonb 欄位有型別可用。
 * 之所以不直接 import：`@tw-erp/db` 目前不依賴 `@tw-erp/core`（依賴方向一直是 api/web → db、core），
 * 為一個型別多拉一條 workspace 邊不划算；兩者結構相容，任何一邊改了另一邊會在 api 的 typecheck 立刻爆。
 */
export interface TaxBracketJson {
  from: number;
  to: number | null;
  mode: "exempt" | "rate_on_total" | "rate_of_excess";
  rateBp?: number | undefined;
}

/**
 * 稅法參數（migration 0016）：使用者自己查證、自己填、自己註明依據的稅法設定值，帶生效期間。
 *
 * ★ **append-only**：法規變了是新增一列並把舊列的 validTo 補上，永不覆寫、永不刪除。
 *   理由是舊年度必須算得回來（核定或更正可能兩三年後才來）。
 *   服務層只提供「新增」與「接續」（把前一列的 validTo 設為新列 validFrom 的前一天），
 *   接續是唯一允許改動舊列的情形，而且只動 validTo。
 *
 * brackets 與 boolValue **恰好一個非 null**（DB CHECK 保證）：
 *   brackets 是 `TaxBracket[]`（見 packages/core/src/tax-parameters.ts），boolValue 是布林型參數。
 *   單一費率（例如營業稅率）＝「只有一個涵蓋全區間的 rate_on_total 級距」，不另立欄位。
 *
 * validTo 為 null＝仍有效；解析規則見 core 的 `resolveParameter`。
 */
export const taxParameters = pgTable("tax_parameters", {
  id: serial("id").primaryKey(),
  /** 'vat' | 'income_tax' | 'undistributed_earnings' | 'input_tax_deductible' | 使用者自訂 */
  kind: text("kind").notNull(),
  /** 該 kind 需要細分時用（input_tax_deductible 用費用科目代號）；不需要時 null */
  scopeKey: text("scope_key"),
  label: text("label").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"),
  brackets: jsonb("brackets").$type<TaxBracketJson[]>(),
  boolValue: boolean("bool_value"),
  /** 使用者自己寫的依據（系統不驗證內容） */
  sourceNote: text("source_note"),
  enteredBy: integer("entered_by").references(() => users.id),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
});

export const openingBalanceKind = pgEnum("opening_balance_kind", ["receivable", "payable"]);

/**
 * 期初應收／應付單（migration 0023，B6）：既有公司導入時把每一筆未收未付的舊單建進子帳。
 * entry_date（開帳日）驅動傳票與鎖帳；doc_date（原單日期）與 due_date 驅動帳齡分桶。
 * 服務層自動拋轉傳票（應收＝借應收帳款、貸累積盈虧；應付反向）——與庫存開帳「不拋傳票」
 * 刻意不同，理由見 migration 檔頭。收付款沖銷用 cash_doc_allocations.target_type='opening'。
 */
export const openingBalances = pgTable("opening_balances", {
  id: serial("id").primaryKey(),
  kind: openingBalanceKind("kind").notNull(),
  partnerId: integer("partner_id").notNull().references(() => partners.id),
  entryDate: date("entry_date").notNull(),
  docDate: date("doc_date").notNull(),
  dueDate: date("due_date"),
  amount: integer("amount").notNull(),
  memo: text("memo").notNull().default(""),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  // ── 0030 作廢層：反向傳票沖 1144/3351（應收）或 3351/2144（應付）；
  // 已被有效收付款單沖銷的期初單不可作廢（懸空 409）
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
  reversalEntryId: integer("reversal_entry_id").references(() => journalEntries.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cashDocAllocations = pgTable("cash_doc_allocations", {
  id: serial("id").primaryKey(),
  cashDocId: integer("cash_doc_id").notNull().references(() => cashDocs.id),
  targetType: docSource("target_type").notNull(),
  targetId: integer("target_id").notNull(),
  amount: integer("amount").notNull(),
  // ── 0027（B9）事後沖用預收/預付：true＝「用這張收付款單的預收/預付餘額沖 target」，
  // 有自己的傳票（journal_entry_id：借 2231 貸 1144／借 2144 貸 1212）與沖用日
  // （alloc_date，受關帳鎖）。false（建立時立沖）＝金額已含在收付款單的原傳票，兩欄留空
  fromPrepaid: boolean("from_prepaid").notNull().default(false),
  allocDate: date("alloc_date"),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
});
