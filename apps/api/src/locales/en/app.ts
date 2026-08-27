/** app.ts（路由層）的 AppError 訊息。服務層的句子放同名檔：services/ledger.ts → en/ledger.ts */
import type { Dictionary } from "@tw-erp/core";

export const app: Dictionary = {
  "sellerTaxId 須為 8 位數字（收到「{value}」）": "sellerTaxId must be 8 digits (got \"{value}\")",
  "網址中的 {name} 必須是正整數（收到「{raw}」）": "{name} in the URL must be a positive integer (got \"{raw}\")",
  "網址中的 {name} 超出範圍（收到「{raw}」）": "{name} in the URL is out of range (got \"{raw}\")",
  "{name} 須為真實存在的日期（YYYY-MM-DD，收到「{v}」）": "{name} must be a real date (YYYY-MM-DD, got \"{v}\")",
  "{name} 須為非負整數（收到「{v}」）": "{name} must be a non-negative integer (got \"{v}\")",
  "{name} 須在 {min}–{max} 之間（收到 {n}）": "{name} must be between {min} and {max} (got {n})",

  // ── 共用參數檢查 ──
  "日期範圍顛倒：from（{from}）晚於 to（{to}），請對調": "Date range is reversed: from ({from}) is later than to ({to}). Please swap them",
  "partnerId 須為正整數（收到「{rawPartner}」）": "partnerId must be a positive integer (got \"{rawPartner}\")",
  "{name} 須為 YYYY-MM-DD（收到「{v}」）": "{name} must be in YYYY-MM-DD format (got \"{v}\")",
  "日期格式須為 YYYY-MM-DD（收到「{day}」）": "Date must be in YYYY-MM-DD format (got \"{day}\")",
  "onDate 須為 YYYY-MM-DD（收到「{raw}」）": "onDate must be in YYYY-MM-DD format (got \"{raw}\")",
  "asOf 須為 YYYY-MM-DD（收到「{raw}」）": "asOf must be in YYYY-MM-DD format (got \"{raw}\")",
  "status 須為 submitted/approved/rejected/paid（收到「{rawStatus}」）": "status must be one of submitted/approved/rejected/paid (got \"{rawStatus}\")",
  "缺少 productId 參數（正整數）——明細帳一次查一個商品": "Missing productId parameter (positive integer). The stock ledger shows one product at a time",
  "缺少 period 參數（YYYYMM，奇數月）": "Missing period parameter (YYYYMM, odd month)",
  "缺少 period 參數（YYYY-MM）": "Missing period parameter (YYYY-MM)",
  "期別格式須為 YYYYMM: {period}": "Period must be in YYYYMM format: {period}",
  "缺少 partnerId / kind（receipt|payment）參數": "Missing partnerId / kind (receipt|payment) parameter",
  "缺少 asOf 參數（YYYY-MM-DD）": "Missing asOf parameter (YYYY-MM-DD)",
  "缺少 from/to 參數（YYYY-MM-DD）": "Missing from/to parameters (YYYY-MM-DD)",
  "缺少 month 參數（YYYY-MM）": "Missing month parameter (YYYY-MM)",
  "缺少或無效的 year 參數（西元年，例如 2026）": "Missing or invalid year parameter (calendar year, e.g. 2026)",
  "無效的 year 參數（西元年，例如 2026）": "Invalid year parameter (calendar year, e.g. 2026)",
  "缺少 year 參數（四位數西元年，收到「{raw}」）": "Missing year parameter (4-digit calendar year, got \"{raw}\")",
  "缺少 accountCode/from/to 參數": "Missing accountCode/from/to parameters",
  "試算參數有誤：{issues}": "Invalid calculation parameters: {issues}",
  "未提供要修改的欄位": "No fields to update were provided",

  // ── 科目 ──
  "代號 {prefix}xxx 是{label}，類別應為 {allowedLabels}，不是 {typeLabel}。請改類別，或改用{label}以外的代號首碼":
    "Code {prefix}xxx belongs to {label}; its type should be {allowedLabels}, not {typeLabel}. Change the type, or use a code prefix outside {label}",
  "{code} 是{typeLabel}科目，不可設為現金科目：現金流量表與現金水位只取資產類的現金/銀行科目":
    "{code} is a {typeLabel} account and cannot be flagged as cash: the cash flow statement and cash position only use asset-type cash/bank accounts",
  "科目代號已存在: {code}": "Account code already exists: {code}",
  "科目代號不可修改：已入帳的分錄會對不起來。請停用舊科目後新增正確的科目":
    "Account code cannot be changed: posted journal entries would no longer reconcile. Deactivate the old account and create a new one with the correct code",
  "科目不存在: {id}": "Account not found: {id}",
  "未提供要修改的欄位（可修改：name、active、type、isCash）": "No fields to update were provided (editable: name, active, type, isCash)",
  "{code} {name} 是系統科目，進銷貨/收付款/折舊/報銷/結轉的自動分錄直接指定它，停用會讓這些單據無法過帳":
    "{code} {name} is a system account referenced directly by automatic entries for sales/purchases, receipts & payments, depreciation, expense claims and closing. Deactivating it would block posting of those documents",
  "{code} {name} 是系統科目，自動分錄依它的類別決定借貸方向與報表歸屬，不可改類別":
    "{code} {name} is a system account; automatic entries rely on its type for debit/credit direction and report placement, so the type cannot be changed",
  "{code} {name} 已有 {count} 筆分錄，不可改類別（改了會讓既有分錄整批換一張報表，歷史帳與已申報數字對不起來）。請停用後另建正確代號的科目":
    "{code} {name} already has {count} journal entries, so its type cannot be changed (existing entries would move to a different report and historical books would no longer match filed figures). Deactivate it and create a new account with the correct code",
  "傳票不存在: {id}": "Journal voucher not found: {id}",
  "傳票清單不支援 partnerId 篩選（傳票沒有交易對象欄位）；請改用 from/to 或明細分類帳":
    "The journal voucher list does not support filtering by partnerId (vouchers have no contact field). Use from/to or the general ledger instead",

  // ── 交易對象 ──
  "勾選「個人」的交易對象不能有統一編號：統編是營利事業的識別碼。個人房東／個人接案者請把統編欄清空，改填身分證統一編號（年度憑單申報要用）；若對方其實是公司，請取消「個人」的勾選":
    "A contact marked as \"Individual\" cannot have a Tax ID: the Tax ID identifies a registered business. For individual landlords or freelancers, clear the Tax ID and enter the National ID instead (required for annual withholding statements). If the contact is actually a company, untick \"Individual\"",
  "只有勾選「個人」的交易對象才需要身分證統一編號。若這筆是個人，請勾選「個人」並清空統一編號；若是公司，請把身分證號欄清空、改填統一編號":
    "Only contacts marked as \"Individual\" need a National ID. If this contact is an individual, tick \"Individual\" and clear the Tax ID; if it is a company, clear the National ID and enter the Tax ID instead",
  "統一編號 {taxId} 已登記在「{name}」（#{id}）。同一家公司請直接用既有的那筆；若既有那筆建錯了，請先修改或清空它的統編":
    "Tax ID {taxId} is already registered to \"{name}\" (#{id}). Use the existing contact for the same company; if that record is wrong, edit or clear its Tax ID first",
  "交易對象不存在: {id}": "Contact not found: {id}",
  "未提供要修改的欄位（可改：name、taxId、idNo、isCustomer、isSupplier、isIndividual、contactPerson、phone、email、address、shipToAddress、paymentTermDays、creditLimit、salesOwnerEmployeeId、note）":
    "No fields to update were provided (editable: name, taxId, idNo, isCustomer, isSupplier, isIndividual, contactPerson, phone, email, address, shipToAddress, paymentTermDays, creditLimit, salesOwnerEmployeeId, note)",
  "員工不存在: {employeeId}（業務負責人請先在「客戶與商品」頁的員工區建立）":
    "Employee not found: {employeeId} (create the sales owner first in the Employees section of the Contacts & Products page)",
  "員工「{name}」已停用，不可指派為業務負責人。請改指派在職員工，或先把他復職":
    "Employee \"{name}\" is inactive and cannot be assigned as sales owner. Assign an active employee, or reactivate this one first",

  // ── 商品 ──
  "SKU {sku} 已存在（「{name}」#{id}）。同一項商品請直接用既有的那筆，或改用別的 SKU":
    "SKU {sku} already exists (\"{name}\" #{id}). Use the existing product for the same item, or choose a different SKU",
  "SKU 不可修改：歷史單據與倉庫標籤都對著它。打錯 SKU 請另建正確的商品，舊的那筆不再選用":
    "SKU cannot be changed: historical documents and warehouse labels reference it. If the SKU is wrong, create a new product with the correct SKU and stop using the old one",
  "商品不存在: {id}": "Product not found: {id}",
  "未提供要修改的欄位（可改：name、unit、listPrice、category、isService、minStock、note）":
    "No fields to update were provided (editable: name, unit, listPrice, category, isService, minStock, note)",
  "「{name}」目前在庫 {qty} {unit}，不可改成服務項目（改了之後這批庫存再也無法出貨）。請先把在庫量出清或以退出處理，再改設定":
    "\"{name}\" currently has {qty} {unit} in stock and cannot be converted to a service item (the stock could never be shipped afterwards). Clear or return the stock first, then change the setting",

  // ── 退回單 ──
  "「當場退現」會直接動到現金／銀行科目，需要「收付款」頁的權限，您的角色沒有。請取消勾選「當場退現」再送出：系統會自動沖掉對方還欠的貨款，沖不掉的部分掛在其他應付款／其他應收款，之後由財務開一張付款單退款——退回單本身照樣開得成立。":
    "\"Refund in cash now\" posts directly to cash/bank accounts and requires access to the Receipts & Payments page, which your role does not have. Untick \"Refund in cash now\" and submit again: the system will offset the amount the contact still owes, book any remainder to other payables/other receivables, and Finance can issue a payment later. The return itself is still created.",

  // ── 帳號 ──
  "該員工已連結帳號「{username}」——一個員工只能連一個帳號（報銷紀錄是個人資料）。要換帳號請先把「{username}」的連結解除":
    "This employee is already linked to account \"{username}\". An employee can only be linked to one account (expense claims are personal data). To switch accounts, unlink \"{username}\" first",
  "帳號已存在: {username}": "Username already exists: {username}",
  "不能變更自己的角色或停用自己": "You cannot change your own role or deactivate yourself",
  "使用者不存在: {id}": "User not found: {id}",

  // ── 發票字軌 ──
  "期別 {period} 不是有效的發票期別：發票字軌以兩個月為一期、從奇數月起算，月份只能是 01、03、05、07、09、11（例如 202607 代表 7-8 月）。請改用該區間所屬期別的起始奇數月":
    "Period {period} is not a valid invoice period: invoice tracks run in two-month periods starting on odd months, so the month must be 01, 03, 05, 07, 09 or 11 (e.g. 202607 covers July–August). Use the starting odd month of the period this range belongs to",
  "迄號 {rangeEnd} 超過 8 位數：發票號碼固定 8 碼，起訖號須在 0 到 99999999 之間，請核對核准函上的號碼區間":
    "End number {rangeEnd} exceeds 8 digits: invoice numbers are always 8 digits, so start and end must be between 0 and 99999999. Please check the number range on the approval letter",
  "起號 {rangeStart} 大於迄號 {rangeEnd}，請核對後對調或修正": "Start number {rangeStart} is greater than end number {rangeEnd}. Please check and swap or correct them",
  "期別 {period} 字軌 {track} 起號 {rangeStart} 的區間已存在（#{id}）。若剛才按過一次「新增區間」，代表已建立成功，直接使用即可；要接續號碼請用新的起號":
    "A range for period {period}, track {track}, starting at {rangeStart} already exists (#{id}). If you just clicked \"Add range\", it was created successfully and is ready to use; to continue numbering, use a new start number",
  "期別 {period} 字軌 {track} 的新區間 {rangeStart}-{rangeEnd} 與既有區間 #{id}（{oStart}-{oEnd}）重疊——同一個號碼不會被核准兩次，請核對核准函上的號碼區間。要接續號碼請從 {next} 起":
    "The new range {rangeStart}-{rangeEnd} for period {period}, track {track} overlaps existing range #{id} ({oStart}-{oEnd}). The same number is never approved twice; please check the number range on the approval letter. To continue numbering, start from {next}",
  "字軌區間不存在: {id}": "Invoice track range not found: {id}",
  "期別 {period} 字軌 {track} 這組區間已配出 {used} 個號碼，不可刪除（區間是已開發票號碼的來歷紀錄）。開錯的發票請到「電子發票」頁逐張作廢；剩下的號碼不再使用即可":
    "Range for period {period}, track {track} has already issued {used} numbers and cannot be deleted (the range is the record of where issued invoice numbers came from). Void incorrect invoices one by one on the E-invoice page; unused numbers can simply be left unused",

  // ── 電子發票 ──
  "發票清單不支援 partnerId 篩選（發票記的是買受人統編，不是交易對象編號）；請改用 from/to 或由來源銷貨單查":
    "The invoice list does not support filtering by partnerId (invoices record the buyer's Tax ID, not a contact ID). Use from/to or look up via the source sales invoice",
  "發票不存在": "Invoice not found",
  "發票 {invoiceNumber} 未作廢，沒有 F0501 作廢訊息（作廢請在電子發票頁操作）":
    "Invoice {invoiceNumber} has not been voided, so there is no F0501 void message (void it on the E-invoice page)",

  // ── 進貨 ──
  "進貨單不存在: {id}": "Purchase invoice not found: {id}",
  "這家供應商的發票 {track}{no} 已登錄在進貨單 #{id}——同一張發票登兩次會讓進項稅重複列報（少繳稅）。請核對號碼；若 #{id} 才是登錯的那張，先去修正或作廢它":
    "Invoice {track}{no} from this supplier is already recorded on purchase invoice #{id}. Recording the same invoice twice would claim input VAT twice (underpaying tax). Check the number; if #{id} is the incorrect one, correct or void it first",
  "發票 {invoiceNumber} 已列報在報銷單 #{claimId}——同一張發票再登進貨會讓進項稅重複列報（少繳稅）。請核對號碼；若 #{claimId} 才是登錯的那張，請先退回它。確為不同賣方的同號發票，報銷明細補上賣方統編即可放行":
    "Invoice {invoiceNumber} is already claimed on expense claim #{claimId}. Recording it again as a purchase would claim input VAT twice (underpaying tax). Check the number; if #{claimId} is the incorrect one, reject it first. If it really is a same-numbered invoice from a different seller, add the seller's Tax ID to the expense claim line to allow it",

  // ── 營業稅申報 ──
  "上期累積留抵須為非負整數元，收到「{raw}」——留抵不可能是負數或小數":
    "Prior-period accumulated VAT credit must be a non-negative whole NT dollar amount (got \"{raw}\"). A credit balance can never be negative or fractional",

  // ── HR ──
  "部門不能是自己的上級": "A department cannot be its own parent",
  "部門不存在: {id}": "Department not found: {id}",
  "班別代碼已存在: {code}": "Shift code already exists: {code}",
  "未提供要修改的欄位（班別代碼不可改）": "No fields to update were provided (shift code cannot be changed)",
  "班別不存在: {id}": "Shift not found: {id}",
  "這一天沒有排班": "No shift is scheduled on this day",
  "你的帳號沒有連結員工主檔，無法打卡。請管理者在「設定 → 使用者管理」連結員工":
    "Your account is not linked to an employee record, so you cannot clock in or out. Ask an Admin to link it under Settings → User management",
  "未提供要修改的欄位（假別代碼不可改）": "No fields to update were provided (leave type code cannot be changed)",
  "你的帳號沒有連結員工主檔，無法送出申請。請管理者在「設定 → 使用者管理」連結員工":
    "Your account is not linked to an employee record, so you cannot submit a request. Ask an Admin to link it under Settings → User management",
  "未提供要修改的欄位（記憶代號不可改）": "No fields to update were provided (mnemonic code cannot be changed)",
  "員工不存在: {id}": "Employee not found: {id}",
  "未提供要修改的欄位（可改：name、title、phone、email、hireDate、note、active、departmentId、managerEmployeeId、employmentType、punchExempt）":
    "No fields to update were provided (editable: name, title, phone, email, hireDate, note, active, departmentId, managerEmployeeId, employmentType, punchExempt)",
  "直屬主管不能是自己": "An employee cannot be their own manager",

  // ── 報銷 ──
  "帳號未連結員工主檔，請管理者在設定頁連結後再報銷":
    "Your account is not linked to an employee record. Ask an Admin to link it on the Settings page before submitting expense claims",
  "報銷清單不支援 partnerId 篩選（報銷掛的是員工，不是交易對象）；請改用 from/to":
    "The expense claim list does not support filtering by partnerId (claims belong to employees, not contacts). Use from/to instead",
  "此彙總需要財務、總經理或管理者權限": "This summary requires the Finance, General Manager or Admin role",
  "只能查看自己的報銷單": "You can only view your own expense claims",
  "只能修改自己的報銷單": "You can only edit your own expense claims",

  // ── 合約 ──
  "合約不存在": "Contract not found",
  "合約無附件": "This contract has no attachment",
  "未提供要修改的欄位（可改：title、counterparty、partnerId、amount、signDate、startDate、endDate、status、memo、kind、direction、fileName、fileData）":
    "No fields to update were provided (editable: title, counterparty, partnerId, amount, signDate, startDate, endDate, status, memo, kind, direction, fileName, fileData)",
  "合約不存在: {id}": "Contract not found: {id}",
  "這份合約已有 {n} 期對上單據，不能改方向。請先作廢銷貨單／解除勾對後再改":
    "This contract already has {n} installments matched to documents, so its direction cannot be changed. Void the sales invoices or unmatch them first",
};
