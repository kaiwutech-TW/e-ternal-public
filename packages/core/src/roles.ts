/**
 * 角色與頁面權限（薄權限層）：角色決定看得到哪些頁面。
 * API 路由守衛與前端導覽共用這份定義——單一事實來源。
 * 細粒度資料權限（如業務只能看自己的客戶）留待後續批次。
 */

export const ROLES = ["admin", "gm", "finance", "sales", "purchasing", "employee"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理者",
  gm: "總經理",
  finance: "財務",
  sales: "業務",
  purchasing: "採購",
  employee: "員工",
};

export const PAGE_KEYS = [
  "dashboard",
  "masters",
  "accounts",
  "purchases",
  "orders",
  "sales",
  "expenses",
  "contracts",
  "cash",
  "assets",
  "journal",
  "reports",
  "invoices",
  "vat",
  // 扣繳（付個人的租金／專業服務費）：獨立頁面而非塞在設定頁，因為它有作業本體
  // （建立扣繳支出單、追 2211／2212 餘額、年度憑單取數），不只是幾個參數。
  // 刻意不給 gm：這頁會看到受領人（自然人）的給付明細，屬個人資料，唯讀也不該全開。
  "withholding",
  // 稅法參數（使用者自己查證後填入的稅率／級距／可扣抵性，附生效期間與依據來源）：
  // 獨立頁面而非塞在設定頁，因為它是**帳務數字的來源**——填錯會讓每一張單的稅額跟著錯，
  // 而設定頁的其他內容（公司抬頭、字軌、帳號）都不會。
  // 刻意不給 gm：這頁的每一次新增都會改變之後所有單據的稅額，唯讀給總經理也沒有用途，
  // 而多一個角色看得到就多一份「以為系統會自動報稅」的誤解來源。
  "tax-parameters",
  "exports",
  // 週期性支出（0047）：每月／每季／每年固定要付出去的錢（房租、訂閱、保費、稅款繳庫）。
  // 刻意只給 admin/finance（整包 PAGE_KEYS 自動取得）——這頁看得到勞健保與稅款金額，
  // 業務與採購不該看到；gm 也不加：它是計畫不是帳，總經理要看數字有報表頁。
  "recurring",
  // 出勤打卡（0039 HR 第一批）：每個角色都要打卡，與報銷同屬「人人有份」的頁
  "attendance",
  // 人事管理（部門/班別/排班/出勤設定）：出勤資料含個資與薪資前置，
  // 與會計科目同層級（admin/finance 整包 PAGE_KEYS 自動取得）
  "hr",
  // 薪資（0041）：薪資檔＋發薪作業。與 hr 分頁是因為敏感度不同層——出勤誰都該看得到自己的，
  // 薪資連「別人的排班」層級的旁觀都不該有；admin/finance 整包取得，其他角色一律看不到
  "payroll",
  "settings",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

/**
 * gm 可看的頁面在 API 層強制唯讀（GET）；報銷例外——每個角色都能報銷自己的費用。
 * sales/purchasing 的 contracts（R21）在 API 層同樣唯讀：合約是業務談下來的、
 * 採購跟供應商簽的，到期提醒最該給他們看；寫入維持 admin/finance（auth.ts RULES 拆讀寫）。
 */
export const ROLE_PAGES: Record<Role, readonly PageKey[]> = {
  admin: PAGE_KEYS,
  finance: PAGE_KEYS,
  // attendance 人人有份（0040 補上——0039 只寫了註解沒發到各角色，導覽根本看不到打卡頁）；
  // 打卡與申請單是 POST，靠 auth.ts 的 "any" 規則放行，不受 gm 唯讀限制
  gm: ["dashboard", "orders", "sales", "purchases", "expenses", "contracts", "assets", "reports", "invoices", "vat", "attendance"],
  sales: ["dashboard", "masters", "orders", "sales", "expenses", "contracts", "attendance"],
  purchasing: ["dashboard", "masters", "purchases", "expenses", "contracts", "attendance"],
  employee: ["expenses", "attendance"],
};

export function canAccessPage(role: Role, page: PageKey): boolean {
  return ROLE_PAGES[role].includes(page);
}

/**
 * 頁面的名稱與一句話說明——**單一事實來源**：前端導覽（App.tsx）與內建 agent 的
 * 「角色功能地圖」（依 ROLE_PAGES 過濾後注入 system prompt）共用這一份。
 * 寫給使用者看的白話，也是 agent 認識這套系統的第一層知識；改文案兩邊同時生效。
 */
export const PAGE_INFO: Record<PageKey, { label: string; desc: string }> = {
  dashboard: { label: "首頁", desc: "一眼看懂公司現況；第一次使用照著「開始使用」清單走就緒。" },
  orders: { label: "報價/訂單", desc: "接單三步：報價給客戶 → 成交轉訂單 → 到貨出貨，銷貨單與帳都由系統自動處理。" },
  sales: { label: "銷貨", desc: "銷貨單與開發票；下方應收帳齡表告訴你該向誰催款。" },
  purchases: { label: "進貨", desc: "叫貨先開採購單追蹤到貨，收貨自動轉進貨單入庫；收到廠商發票記得登錄才能抵稅。" },
  attendance: { label: "出勤打卡", desc: "上下班在這裡打卡；也看得到自己的班表。打錯方向補打一筆即可，更正走補卡申請。" },
  expenses: { label: "費用報銷", desc: "拍下發票照片送出就好，分類用白話選；會計核准後付款。" },
  contracts: { label: "合約", desc: "合約收在這裡：附件、狀態、到期提醒。" },
  masters: { label: "客戶與商品", desc: "先建好客戶、供應商、商品，其他頁面的下拉選單才有東西可選。" },
  accounts: { label: "會計科目", desc: "公司的科目表：新增自家需要的科目、把用不到的停用。標「系統」的科目被自動分錄指定，只能改名不能停用。" },
  cash: { label: "收付款", desc: "記錄收到與付出的錢，可指定沖哪幾張單；系統自動沖應收/應付。" },
  assets: { label: "固定資產", desc: "電腦、設備登錄後每月一鍵提折舊；賣掉或報廢也在這裡處理。" },
  journal: { label: "傳票", desc: "所有單據自動產生的會計分錄都在這；調整分錄與期初開帳用手工傳票。" },
  payroll: { label: "薪資", desc: "員工薪資檔、加班費率與每月發薪作業；定案自動過帳計提傳票。倍率、除數與勞健保金額都要你自己查證後填寫，系統不預設。" },
  reports: { label: "財務報表", desc: "損益表、資產負債表、現金流量表、明細分類帳；月底在這裡關帳。" },
  invoices: { label: "電子發票", desc: "發票開立、作廢與重開；字軌設定在「設定」頁。" },
  vat: { label: "401 申報", desc: "每兩個月的營業稅申報：系統從單據自動彙總，產出媒體檔與申報書。退回／折讓的減項要自己在申報軟體補填。" },
  withholding: { label: "扣繳", desc: "付租金或委外費用給個人時：記費用、代扣稅款、實付金額一次完成；年度彙總是申報各類所得憑單的取數來源。費率與申報期限都要你自己查證後填寫，系統不預設。" },
  "tax-parameters": { label: "稅法參數", desc: "你自己查到的稅率、級距與可扣抵性都記在這裡，附生效期間與依據來源。系統不內建任何稅率，也不計算營所稅與未分配盈餘稅——那兩種只是幫你把查到的規則記下來。這張表只增不改：舊年度必須算得回來。" },
  exports: { label: "記帳士匯出", desc: "把帳交給記帳士：三種 CSV 一鍵匯出。" },
  recurring: {
    label: "週期性支出",
    desc:
      "每月／每季／每年固定要付出去的錢（房租、訂閱、保費、稅款繳庫）排成一張清單，到期會出現在首頁。" +
      "頻率、金額、依據都由你自己填——系統不預設任何金額或頻率，也不判斷你該不該付、什麼時候該付。" +
      "這裡只是計畫，不產生任何分錄；真的付了之後把報銷單或傳票對上去，那一期才算結清。",
  },
  hr: { label: "人事管理", desc: "部門、班別、排班、出勤設定與打卡紀錄；假別額度、行事曆、申請單簽核與月出勤彙總。" },
  settings: { label: "設定", desc: "公司基本檔、發票字軌、同事帳號與權限。" },
};

/** 角色功能地圖：該角色看得到的頁面＋一句話說明（agent system prompt 注入用） */
export function featureMapFor(role: Role): string {
  return ROLE_PAGES[role].map((key) => `- ${PAGE_INFO[key].label}（/${key}）：${PAGE_INFO[key].desc}`).join("\n");
}
