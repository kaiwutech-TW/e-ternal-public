/** 跨頁共用（按鈕、狀態詞、側欄）。頁面專屬的句子放同名檔：pages/Expenses.tsx → en/Expenses.ts */
import type { Dictionary } from "@tw-erp/core";

export const common: Dictionary = {
  // --- 通用 ---
  "語言": "Language",
  "語言：": "Language: ",
  "外觀：": "Theme: ",
  "淺色": "Light",
  "深色": "Dark",
  "跟隨系統": "System",
  "儲存": "Save",
  "取消": "Cancel",
  "刪除": "Delete",
  "編輯": "Edit",
  "搜尋": "Search",
  "登出": "Sign out",
  "載入中…": "Loading…",
  "{name} 須在 {min}–{max} 之間": "{name} must be between {min} and {max}",

  // --- ROLE_LABELS（@tw-erp/core roles.ts） ---
  "管理者": "Admin",
  "總經理": "General Manager",
  "財務": "Finance",
  "業務": "Sales",
  "採購": "Purchasing",
  "員工": "Employee",

  // --- PAGE_INFO labels（@tw-erp/core roles.ts） ---
  "首頁": "Home",
  "報價/訂單": "Quotes & Orders",
  "出勤打卡": "Attendance",
  "費用報銷": "Expense Claims",
  "客戶與商品": "Contacts & Products",
  "會計科目": "Chart of Accounts",
  "收付款": "Receipts & Payments",
  "固定資產": "Fixed Assets",
  "薪資": "Payroll",
  "財務報表": "Financial Reports",
  "401 申報": "VAT Return (401)",
  "扣繳": "Withholding Tax",
  "稅法參數": "Tax Parameters",
  "記帳士匯出": "Accountant Export",
  "週期性支出": "Recurring Payables",
  "人事管理": "HR",
  "設定": "Settings",

  // --- PAGE_INFO desc ---
  "一眼看懂公司現況；第一次使用照著「開始使用」清單走就緒。":
    "See how the business is doing at a glance. First time here? Follow the Getting Started checklist.",
  "接單三步：報價給客戶 → 成交轉訂單 → 到貨出貨，銷貨單與帳都由系統自動處理。":
    "Three steps from quote to cash: send a quote → convert to an order when won → receive and ship. Sales invoices and journal entries are created automatically.",
  "銷貨單與開發票；下方應收帳齡表告訴你該向誰催款。":
    "Sales invoices and e-invoice issuance. The AR aging table below shows who to chase for payment.",
  "叫貨先開採購單追蹤到貨，收貨自動轉進貨單入庫；收到廠商發票記得登錄才能抵稅。":
    "Raise a purchase order to track deliveries; receiving converts it to a purchase invoice and updates stock. Record supplier invoices to claim input VAT.",
  "上下班在這裡打卡；也看得到自己的班表。打錯方向補打一筆即可，更正走補卡申請。":
    "Clock in and out here and view your own schedule. Punched the wrong direction? Just punch again; corrections go through a punch-correction request.",
  "拍下發票照片送出就好，分類用白話選；會計核准後付款。":
    "Snap a photo of the receipt and submit. Categories are in plain language; accounting approves, then pays.",
  "合約收在這裡：附件、狀態、到期提醒。":
    "Contracts live here: attachments, status, and expiry reminders.",
  "先建好客戶、供應商、商品，其他頁面的下拉選單才有東西可選。":
    "Set up customers, suppliers, and products first so the dropdowns on other pages have something to pick.",
  "公司的科目表：新增自家需要的科目、把用不到的停用。標「系統」的科目被自動分錄指定，只能改名不能停用。":
    "Your chart of accounts: add the accounts you need and deactivate the ones you don't. Accounts marked System are used by automatic entries and can be renamed but not deactivated.",
  "記錄收到與付出的錢，可指定沖哪幾張單；系統自動沖應收/應付。":
    "Record money received and paid, and choose which documents to apply it to. AR/AP is settled automatically.",
  "電腦、設備登錄後每月一鍵提折舊；賣掉或報廢也在這裡處理。":
    "Register computers and equipment, then run monthly depreciation with one click. Sales and write-offs are handled here too.",
  "所有單據自動產生的會計分錄都在這；調整分錄與期初開帳用手工傳票。":
    "Every journal entry generated from documents lives here. Use manual vouchers for adjustments and opening balances.",
  "員工薪資檔、加班費率與每月發薪作業；定案自動過帳計提傳票。倍率、除數與勞健保金額都要你自己查證後填寫，系統不預設。":
    "Employee pay profiles, overtime rates, and the monthly pay run. Finalizing posts the accrual voucher automatically. Multipliers, divisors, and labor/health insurance amounts must be verified and entered by you; nothing is preset.",
  "損益表、資產負債表、現金流量表、明細分類帳；月底在這裡關帳。":
    "Income statement, balance sheet, cash flow statement, and general ledger. Close the month here.",
  "發票開立、作廢與重開；字軌設定在「設定」頁。":
    "Issue, void, and reissue e-invoices. Invoice tracks are configured on the Settings page.",
  "每兩個月的營業稅申報：系統從單據自動彙總，產出媒體檔與申報書。退回／折讓的減項要自己在申報軟體補填。":
    "Bimonthly VAT return: the system totals your documents and produces the e-filing media file and return form. Returns and allowances must be entered as deductions in the filing software yourself.",
  "付租金或委外費用給個人時：記費用、代扣稅款、實付金額一次完成；年度彙總是申報各類所得憑單的取數來源。費率與申報期限都要你自己查證後填寫，系統不預設。":
    "When paying rent or contractor fees to individuals: record the expense, withheld tax, and net payment in one step. The annual summary feeds the withholding statements. Rates and filing deadlines must be verified and entered by you; nothing is preset.",
  "你自己查到的稅率、級距與可扣抵性都記在這裡，附生效期間與依據來源。系統不內建任何稅率，也不計算營所稅與未分配盈餘稅——那兩種只是幫你把查到的規則記下來。這張表只增不改：舊年度必須算得回來。":
    "Record the tax rates, brackets, and deductibility rules you have verified, with effective dates and sources. No rates are built in, and corporate income tax and undistributed-earnings tax are not calculated; those entries only store the rules you found. This table is append-only so prior years can always be recomputed.",
  "把帳交給記帳士：三種 CSV 一鍵匯出。":
    "Hand the books to your accountant: three CSV exports in one click.",
  "每月／每季／每年固定要付出去的錢（房租、訂閱、保費、稅款繳庫）排成一張清單，到期會出現在首頁。頻率、金額、依據都由你自己填——系統不預設任何金額或頻率，也不判斷你該不該付、什麼時候該付。這裡只是計畫，不產生任何分錄；真的付了之後把報銷單或傳票對上去，那一期才算結清。":
    "A schedule of money that goes out every month, quarter, or year (rent, subscriptions, premiums, tax payments); due items appear on Home. Frequency, amount, and basis are all entered by you; the system presets no amounts or frequencies and does not decide whether or when you should pay. This is a plan only and creates no journal entries; once paid, link the expense claim or voucher to settle that period.",
  "部門、班別、排班、出勤設定與打卡紀錄；假別額度、行事曆、申請單簽核與月出勤彙總。":
    "Departments, shifts, rosters, attendance settings, and punch records; leave entitlements, calendar, request approvals, and monthly attendance summary.",
  "公司基本檔、發票字軌、同事帳號與權限。":
    "Company profile, invoice tracks, user accounts, and permissions.",
  // --- 跨頁統一詞（scripts/i18n-scan.mjs 衝突偵測後裁定；各頁字典不得再定義這些 key）---
  "、": ", ",
  "（逾期）": "(overdue)",
  "啟用": "Active",
  "使用中": "Active",
  "至少一筆有效明細": "At least one valid line is required",
  "新增": "Add",
  "預收": "Advance receipt",
  "已沖": "Applied",
  "沖銷": "Apply",
  "已核准": "Approved",
  "依據": "Basis",
  "帳面淨值": "Net book value",
  "載具／捐贈": "Carrier / donation",
  "貨到付款": "Cash on delivery",
  "關閉": "Close",
  "合約": "Contract",
  "停用": "Inactive",
  "內容": "Details",
  "不提示任何繳納或申報期限": "does not track any payment or filing deadlines",
  "電子發票": "E-invoice",
  "啟用日": "In-service date",
  "已停用": "Inactive",
  "進項發票": "Input invoice",
  "不會做": "Does not",
  "會做": "Does",
  "品名": "Item",
  "依據來源": "Source",
  "摘要": "Memo",
  "安全庫存": "Safety stock",
  "名稱": "Name",
  "未稅": "Excl. VAT",
  "未註明依據來源": "No source given",
  "單號": "No.",
  "編號": "No.",
  "期": "Period",
  "未約定": "Not set",
  "未到期": "Not due",
  "未填": "Not set",
  "備註": "Notes",
  "付款計畫": "Payment schedule",
  "付款": "Payment",
  "預計付款日": "Planned payment date",
  "進貨": "Purchases",
  "數量": "Qty",
  "退回": "Reject",
  "銷貨單": "Sales invoice",
  "銷貨": "Sales",
  "殘值": "Salvage value",
  "送出": "Submit",
  "生效日": "Effective from",
  "類別": "Type",
  "單價（未稅）": "Unit price (excl. VAT)",
  "耐用年數": "Useful life (yrs)",
  "稅額": "VAT",
  "傳票": "Voucher",
  "{n} 筆": "{n} records",
  "作廢理由：{reason}（沖轉傳票 #{entry}）": "Void reason: {reason} (reversing voucher #{entry})",
};
