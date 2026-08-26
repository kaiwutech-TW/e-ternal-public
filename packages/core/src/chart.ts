/**
 * 預設科目表種子。
 * 狀態（docs/specs/chart-of-accounts.md）：**自用已足**——科目代號是內部標籤，
 * 營業稅 401 的取數完全不經過會計科目，而型別分類已由 allowedTypesForCode 在寫入時強制。
 * **對外發布這份預設科目表前**仍需專業覆核：本專案是 MIT、目標最大化採用，
 * 種子表會成為其他採用者開機第一天的預設值，錯誤會擴散而對方多半不會回頭檢查。
 *
 * 註解體例：本檔各科目只寫「為什麼要獨立一個科目」的業務理由。
 * 不寫法條號碼、稅率、金額門檻與憑單格式代號——這些都是未經查證的內容，
 * 寫成肯定句會讓後人誤以為已核對過法規原文；全數以問句形式集中在
 * docs/specs/chart-of-accounts.md 的表 B2「稅法參數」（表 B1 是已拍板的內部命名決策）。
 *
 * 編碼內規（由既有種子歸納，不採外部標準表）：
 * 1 資產／2 負債／3 權益／4 營業收入／5 營業成本／6 營業費用／7 營業外收支／8 所得稅；
 * 末碼 9＝抵減項（累計折舊、銷貨退回折讓）、末碼 88＝稅額或雜項、借貸尾碼對稱（1144↔2144、1288↔2288）。
 */
import {
  ASSET_CATEGORIES,
  DEPRECIATION_EXPENSE_CODE,
  DISPOSAL_GAIN_CODE,
  DISPOSAL_LOSS_CODE,
} from "./assets.ts";

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
}

/** 首碼語意（供錯誤訊息用，讓使用者看得懂為什麼被擋） */
export const ACCOUNT_PREFIX_LABELS: Readonly<Record<string, string>> = {
  "1": "資產",
  "2": "負債",
  "3": "權益",
  "4": "營業收入",
  "5": "營業成本",
  "6": "營業費用",
  "7": "營業外收支",
  "8": "所得稅",
};

/**
 * 代號首碼允許的科目類別。
 * 之所以要交叉驗證：type 決定科目在報表的去向（損益表取 revenue/expense、年度結轉只結清這兩類），
 * 代號首碼卻是人看的分群——兩者不一致時不會有任何錯誤訊息，只會在幾個月後的報表上默默少一段
 * （實測 code=6127 配 type=asset：該科目的費用在損益表完全消失、年度結轉永遠不結清它）。
 *
 * 7 首碼是唯一允許兩種類別的：營業外「收支」本來就同時涵蓋收益與損失
 * （既有種子即為 7101 出售資產利益＝revenue、7501 出售資產損失＝expense）。
 */
const TYPES_BY_PREFIX: Readonly<Record<string, readonly AccountType[]>> = {
  "1": ["asset"],
  "2": ["liability"],
  "3": ["equity"],
  "4": ["revenue"],
  "5": ["expense"],
  "6": ["expense"],
  "7": ["revenue", "expense"],
  "8": ["expense"],
};

/** 該代號可用的類別；代號格式不合（非 1-8 開頭）時回空陣列，呼叫端須自行處理 */
export function allowedTypesForCode(code: string): AccountType[] {
  return [...(TYPES_BY_PREFIX[code.charAt(0)] ?? [])];
}

export const ACCOUNT = {
  CASH: "1101",
  BANK: "1103",
  ACCOUNTS_RECEIVABLE: "1144",
  // 進貨退出時，應付帳款已付清仍要向供應商拿回錢的部分掛這裡（退回單自動拆分，見 services/returns.ts）
  OTHER_RECEIVABLE: "1148",
  INVENTORY: "1301",
  INPUT_TAX: "1288",
  ACCOUNTS_PAYABLE: "2144",
  OTHER_PAYABLE: "2201",
  // 扣繳支出單直接指定這兩碼（services/withholding.ts），所以它們必須是系統科目：
  // 停用其中一個，之後每一張付給個人的支出單都會在服務層丟 500「科目未初始化」。
  // 2211 的餘額語意＝已扣未繳的稅款，2212＝已扣未繳的保費；兩者分列是因為繳款對象不同。
  WITHHOLDING_TAX_PAYABLE: "2211",
  WITHHOLDING_SUPPLEMENT_PAYABLE: "2212",
  OUTPUT_TAX: "2288",
  CAPITAL: "3101",
  RETAINED_EARNINGS: "3351", // 年度結轉的結清對象（services/period.ts）
  SALES_REVENUE: "4101",
  // 零稅率銷貨（0028，B12）：saleEntryLines 依課稅別直接指定它，所以必須是系統科目——
  // 停用它之後每一張零稅率銷貨單都會在服務層丟 500「科目未初始化」。
  // 與 4101 分列是申報的需要：401 的零稅率銷售額與應稅分欄，混在同一科目就取不出數
  SALES_REVENUE_ZERO: "4102",
  // 銷貨退回及折讓：退回單拋轉直接指定它，所以必須是系統科目——
  // 否則使用者在科目維護頁把它停用後，之後每一張退貨單都會在服務層丟 500「科目未初始化」
  SALES_RETURN: "4109",
  COGS: "5101",
  // 庫存調整單（migration 0026，B8）拋轉直接指定這兩碼，所以必須是系統科目：
  // 停用任何一個，之後每一張盤點／報廢單都會在服務層丟 500「科目未初始化」。
  // 與 5101 分開的理由：盤損報廢不是「賣掉的成本」——混進銷貨成本會讓毛利率被報廢吃掉，
  // 而毛利率是東西「賣得好不好」的指標，報廢是「管得好不好」的指標，混在一起兩個都看不見。
  INVENTORY_GAIN: "7121",
  INVENTORY_LOSS: "7521",
  // 收付款單的溢收／溢付（migration 0027，B9）拋轉直接指定這兩碼，所以必須是系統科目：
  // 停用任何一個，之後每一張溢收的收款單／溢付的付款單都會在服務層丟 500「科目未初始化」。
  // 與 1144/2144 分開的理由：溢收不是「客戶欠得更少」而是「我欠客戶貨或錢」——是負債；
  // 溢付不是「欠供應商更少」而是「供應商欠我貨」——是資產。資產負債表以總額表達，
  // 預收與應收、預付與應付都不得互抵成一個淨額。
  ADVANCE_RECEIPT: "2231",
  PREPAYMENT: "1212",
  // 薪資批（0041）的發薪定案拋轉直接指定這五碼（services/payroll.ts），所以必須是系統科目：
  // 停用任何一個，之後每一次發薪定案都會在服務層丟 500「科目未初始化」。
  // 2202 應付薪資＝實發（月底計提、次月發放）；2203 應付費用＝雇主的勞健保與勞退應繳；
  // 2212 代扣勞健保費（已在上面）＝員工負擔保費的代扣；6111/6113/6114 見 SEED_ACCOUNTS 各自的分列理由
  SALARY_PAYABLE: "2202",
  ACCRUED_EXPENSE: "2203",
  SALARY_EXPENSE: "6111",
  LABOR_HEALTH_INS_EXPENSE: "6113",
  PENSION_EXPENSE: "6114",
} as const;

export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  { code: ACCOUNT.CASH, name: "庫存現金", type: "asset" },
  { code: ACCOUNT.BANK, name: "銀行存款", type: "asset" },
  { code: ACCOUNT.ACCOUNTS_RECEIVABLE, name: "應收帳款", type: "asset" },
  { code: ACCOUNT.INVENTORY, name: "商品存貨", type: "asset" },
  { code: ACCOUNT.INPUT_TAX, name: "進項稅額", type: "asset" },
  { code: ACCOUNT.ACCOUNTS_PAYABLE, name: "應付帳款", type: "liability" },
  { code: ACCOUNT.OTHER_PAYABLE, name: "其他應付款", type: "liability" },
  { code: ACCOUNT.OUTPUT_TAX, name: "銷項稅額", type: "liability" },
  { code: ACCOUNT.CAPITAL, name: "股本", type: "equity" },
  { code: ACCOUNT.RETAINED_EARNINGS, name: "累積盈虧", type: "equity" },
  { code: ACCOUNT.SALES_REVENUE, name: "銷貨收入", type: "revenue" },
  { code: ACCOUNT.COGS, name: "銷貨成本", type: "expense" },
  // 固定資產（缺口第二層批次 A）：成本／累計折舊成對，折舊費用與處分損益
  { code: "1411", name: "機器設備", type: "asset" },
  { code: "1419", name: "累計折舊－機器設備", type: "asset" },
  { code: "1421", name: "辦公設備", type: "asset" },
  { code: "1429", name: "累計折舊－辦公設備", type: "asset" },
  { code: "1431", name: "運輸設備", type: "asset" },
  { code: "1439", name: "累計折舊－運輸設備", type: "asset" },
  { code: "1481", name: "什項設備", type: "asset" },
  { code: "1489", name: "累計折舊－什項設備", type: "asset" },
  { code: "6140", name: "折舊費用", type: "expense" },
  { code: "7101", name: "出售資產利益", type: "revenue" },
  { code: "7501", name: "出售資產損失", type: "expense" },
  { code: "6131", name: "旅費", type: "expense" },
  { code: "6132", name: "郵電費", type: "expense" },
  { code: "6133", name: "文具用品", type: "expense" },
  { code: "6135", name: "水電瓦斯費", type: "expense" },
  { code: "6136", name: "保險費", type: "expense" },
  { code: "6137", name: "交際費", type: "expense" },
  { code: "6138", name: "修繕費", type: "expense" },
  { code: "6139", name: "廣告費", type: "expense" },
  { code: "6188", name: "雜項費用", type: "expense" },

  // --- 以下為第二批補充科目，純新增、不動任何被程式硬引用的既有 code ---
  // （刻意不寫科目個數：清單還會再增補，寫死的數字每次都會忘了改，變成騙人的註解）
  // 資產：110x 現金群、114x 應收群、121x 預付款項、128x 稅務性資產、181x 存出保證金
  { code: "1102", name: "零用金", type: "asset" }, // 定額小額備用金，與庫存現金分開才盤得出來
  { code: "1141", name: "應收票據", type: "asset" }, // 客票到期日管理與帳款帳齡是兩回事
  { code: "1148", name: "其他應收款", type: "asset" }, // 代墊運費、員工預支：混入應收帳款會汙染帳齡表
  { code: "1211", name: "預付費用", type: "asset" }, // 租金、產險、年費一次付一年，須按月攤提
  // 給供應商的訂金，貨到前不是存貨也不是應付沖銷；付款單溢付的部分自動掛這裡（0027，B9）
  { code: ACCOUNT.PREPAYMENT, name: "預付貨款", type: "asset" },
  { code: "1285", name: "預付所得稅", type: "asset" }, // 暫繳與被扣繳稅款，結算時抵繳；記成費用會重複列報
  { code: "1287", name: "留抵稅額", type: "asset" }, // 留在 1288 會使當期進項與營業稅申報書對不起來
  { code: "1811", name: "存出保證金", type: "asset" }, // 租賃押金一擺數年；避開 14xx 是為了不與固定資產群混淆，
  // 現金流量表另以 INVESTING_ACCOUNT_CODES 明確把它列為投資活動
  // 負債：210x 借款、214x 票據、220x 計提性其他應付、221x 代扣代收、223x 預收、228x 應付稅捐、2301 長期借款
  { code: "2101", name: "短期借款", type: "liability" },
  { code: "2141", name: "應付票據", type: "liability" }, // 與 1141 應收票據尾碼對稱
  { code: ACCOUNT.SALARY_PAYABLE, name: "應付薪資", type: "liability" }, // 月底計提、次月發放，跨月費用歸屬靠這個科目
  { code: ACCOUNT.ACCRUED_EXPENSE, name: "應付費用", type: "liability" }, // 發票未到的水電、電信、利息估列：最常用的調整分錄科目
  { code: "2204", name: "股東往來", type: "liability" }, // 老闆代墊或臨時挹注，混入其他應付款就查不清楚
  // 餘額＝已扣未繳庫的扣繳稅款，繳庫後歸零（扣繳支出單自動貸記；繳納期限系統不提示，見 docs 表 B2）
  { code: ACCOUNT.WITHHOLDING_TAX_PAYABLE, name: "代扣所得稅", type: "liability" },
  // 與 2211 分列是因為繳款對象不同（勞保局／健保署）；扣繳支出單的補充保費欄自動貸記此科目
  { code: ACCOUNT.WITHHOLDING_SUPPLEMENT_PAYABLE, name: "代扣勞健保費", type: "liability" },
  // 收訂金當下沒有應收可沖，履約前不得認列收入；收款單溢收的部分自動掛這裡（0027，B9）
  { code: ACCOUNT.ADVANCE_RECEIPT, name: "預收款項", type: "liability" },
  { code: "2281", name: "應付營業稅", type: "liability" }, // 營業稅申報結出的應繳未繳；沒有它 2288 會一直帶混合餘額
  { code: "2285", name: "應付所得稅", type: "liability" }, // 與 1285 預付所得稅尾碼對稱
  { code: "2301", name: "長期借款", type: "liability" },
  // 權益
  // 盈餘分派時須先提存的公積，與 3351 累積盈虧分列才看得出實際可分配數。
  // 提存的時點、比例上限與適用公司類型未查證，系統不自動計算也不檢核（見 docs 表 B42）。
  { code: "3311", name: "法定盈餘公積", type: "equity" },
  // 收入與成本
  { code: ACCOUNT.SALES_REVENUE_ZERO, name: "銷貨收入－零稅率", type: "revenue" }, // 零稅率銷貨拋轉直接指定（0028）；申報的零稅率銷售額須與應稅分開取數
  { code: "4109", name: "銷貨退回及折讓", type: "revenue" }, // 登 revenue 靠借方餘額自然成減項（比照累計折舊登 asset）
  { code: "4201", name: "勞務收入", type: "revenue" }, // 與銷貨分列才算得出兩條產品線毛利
  { code: "5201", name: "勞務成本", type: "expense" },
  // 營業費用：611x 人事、612x 場地與外購服務（既有 613x／6140／6188 完全不動）
  { code: ACCOUNT.SALARY_EXPENSE, name: "薪資支出", type: "expense" }, // 年度薪資給付總額與扣繳作業都以此科目為基礎，混入其他人事給付就對不出憑單
  // 員工伙食補助在一定額度內與薪資分列處理，混在薪資裡會影響員工的所得計算。
  // 額度多少、依據為何未查證，系統不設限額也不檢核（見 docs 表 B34）。
  { code: "6112", name: "伙食費", type: "expense" },
  { code: ACCOUNT.LABOR_HEALTH_INS_EXPENSE, name: "勞健保費", type: "expense" }, // 公司負擔部分，與 6136 產險性質完全不同
  { code: ACCOUNT.PENSION_EXPENSE, name: "勞工退休金", type: "expense" }, // 雇主提繳的退休金，繳款對象與申報分類都與勞健保不同，分列才對得起繳款單
  // 福利性支出的稅上列報另有限制，混進雜項費用就查不出金額。
  // 限制的內容與依據未查證，系統不設限額也不提示超限（見 docs 表 B36）。
  { code: "6115", name: "職工福利", type: "expense" },
  { code: "6121", name: "租金支出", type: "expense" }, // 承租費用；付個人房東時另有扣繳與憑單作業，與付公司的處理流程不同
  { code: "6122", name: "運費", type: "expense" }, // 銷貨費用，不可混入進貨成本
  { code: "6123", name: "稅捐", type: "expense" }, // 印花稅、牌照稅、房屋稅等規費性支出；另承接不可扣抵而須轉列費用的營業稅
  { code: "6124", name: "專業服務費", type: "expense" }, // 記帳、法律、顧問等委外服務的受領者多為個人，涉扣繳與年度憑單，必須與一般費用分開
  { code: "6125", name: "手續費", type: "expense" }, // 匯款、刷卡、金流抽成：金額零碎但筆數最多
  { code: "6126", name: "資訊服務費", type: "expense" }, // SaaS 訂閱是現代小公司的固定月支出，傳統科目表沒有
  // 以下三個補買賣業第一個月就會撞到的費用（配號接續 612x 群，屬待確認：見 docs 表 B）
  { code: "6127", name: "進貨費用", type: "expense" }, // 進貨運費：6122 運費的定義是銷貨運費，不可混用；
  // 進貨拋轉直接借 1301 商品存貨（posting.ts），供應商另開的運費發票在此之前無處可放
  { code: "6128", name: "佣金支出", type: "expense" }, // 給介紹人／通路的抽成，個人受領者另涉扣繳
  { code: "6129", name: "油料及車輛維護費", type: "expense" }, // 有 1431 運輸設備就有加油單；
  // 之前只能塞 6131 旅費（語意錯：旅費是出差，加油是車輛持有成本）
  // 營業外收支與所得稅
  // 存款利息入帳時通常已被扣繳，不單獨追蹤就看不出已被扣走多少、可主張抵繳多少。
  // 扣繳率與可抵繳範圍未查證，系統不自動追蹤已扣繳稅款（見 docs 表 B41）。
  { code: "7111", name: "利息收入", type: "revenue" },
  // 存貨盤盈／盤損（migration 0026，B8）：庫存調整單的自動拋轉對象，7121↔7521 尾碼對稱。
  // 盤損一個科目涵蓋盤虧與報廢（單頭 reason 已區分原因，帳務結構相同；拆兩個科目
  // 只會讓使用者每次都要想「過期算哪個」）。7188 其他收入的註解原本把盤盈列在裡面，
  // 自動拋轉需要專屬碼——混在其他收入裡，月底想看「這個月盤盈多少」得逐筆翻傳票
  { code: ACCOUNT.INVENTORY_GAIN, name: "存貨盤盈", type: "revenue" },
  { code: ACCOUNT.INVENTORY_LOSS, name: "存貨盤損", type: "expense" },
  { code: "7188", name: "其他收入", type: "revenue" }, // 補助、回饋、廢料變賣（末碼 88＝其他）
  { code: "7511", name: "利息費用", type: "expense" }, // 屬營業外支出，不可列入營業費用
  { code: "8101", name: "所得稅費用", type: "expense" }, // 損益表最後一行；account_type 無所得稅類，暫登 expense
];

/**
 * 員工報銷分類：白話標籤＋範例對應到會計科目，員工不需懂科目。
 *
 * ★ 為什麼這份清單**留在程式常數裡**而沒有搬成使用者資料：
 *   它餵養 `SYSTEM_ACCOUNT_CODES`（見下），而那份清單決定「哪些科目停不掉、改不了碼」。
 *   一旦分類變成使用者資料，使用者刪掉一個分類，該科目下一次重啟就被 seed.ts 的反向校正
 *   設回 `is_system = false`、接著可以被停用，而已入帳的舊報銷單與 `approveClaim` 的 `need(code)`
 *   會在核准時丟 400／500。反過來，新增一個指向任意 6xxx 的分類會把那個科目**永久鎖成不可停用**，
 *   卻又不在 seed.ts 的校正範圍內（校正只涵蓋 SEED_ACCOUNTS），漂成「標了 is_system 卻不受保護」的中間態。
 *   所以**分類清單是結構，留在程式裡**。
 *
 * ★ 而 `inputTaxDeductible` 是**稅法參數，不是結構**，因此它在這裡的值只是「尚未經查證的預設」：
 *   實際判定時服務層會先查 tax_parameters（kind='input_tax_deductible'、scope_key＝費用科目代號、
 *   bool_value），查不到才用這裡的預設值。使用者可以在「稅法參數」頁覆寫任何一個科目的可扣抵性，
 *   並留下自己的依據來源與生效期間（docs/specs/tax-parameters.md）。
 *   這裡的每一個值都**尚未經記帳士確認**，程式裡也不作任何稅法推導：
 *   6137 交際費設為不可扣抵是沿用既有實作（相關待確認項見 docs 表 B40），
 *   6112 伙食費、6115 職工福利暫設為可扣抵（表 B30／B31）。
 *   ⚠️ 不論改這裡的預設值或在參數頁覆寫，**已入帳的報銷單稅額都不會回溯**——
 *   稅額在建單當下就落地到 expense_items.tax，補設參數只影響之後建立的單據。
 */
export interface ExpenseCategory {
  accountCode: string;
  label: string;
  hint: string;
  /** 尚未經查證的**預設值**；可在「稅法參數」頁以 kind='input_tax_deductible' 覆寫並留下依據 */
  inputTaxDeductible: boolean;
}

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  // 伙食費與職工福利是報銷單最常見的兩張單據，缺了就只能全部塞「其他」，事後會計得逐筆重分類
  { accountCode: "6112", label: "員工伙食", hint: "員工便當、誤餐費、加班餐費", inputTaxDeductible: true },
  { accountCode: "6115", label: "員工福利", hint: "部門聚餐、生日禮金、社團與慶生活動", inputTaxDeductible: true },
  { accountCode: "6131", label: "交通與差旅", hint: "計程車、高鐵、機票、住宿", inputTaxDeductible: true },
  { accountCode: "6132", label: "電話與網路", hint: "電信費、網路費、郵資", inputTaxDeductible: true },
  { accountCode: "6133", label: "文具與辦公用品", hint: "文具、紙張、辦公小物", inputTaxDeductible: true },
  { accountCode: "6135", label: "水電瓦斯", hint: "水費、電費、瓦斯費", inputTaxDeductible: true },
  { accountCode: "6136", label: "保險", hint: "產險、意外險", inputTaxDeductible: true },
  { accountCode: "6137", label: "餐飲與交際", hint: "請客戶吃飯、送禮（進項稅不可扣抵）", inputTaxDeductible: false },
  { accountCode: "6138", label: "修繕維護", hint: "設備維修、辦公室修繕", inputTaxDeductible: true },
  { accountCode: "6139", label: "廣告行銷", hint: "廣告投放、印刷品、活動", inputTaxDeductible: true },
  { accountCode: "6188", label: "其他", hint: "不確定分類時選這個，會計會調整", inputTaxDeductible: true },
];

/**
 * 系統科目：被自動拋轉邏輯以字面 code 硬引用的科目。
 * 之所以要有這份清單：這些 code 一旦被停用或改碼，進銷貨、收付款、折舊、報銷、年度結轉
 * 會在服務層直接丟 500「科目未初始化」——不是友善錯誤。因此科目維護必須擋下停用，
 * 而清單來源刻意集中在此一處（原本散落 chart/assets/period/reports 四個檔）。
 * 資料庫的 accounts.is_system 由 seedAccounts() 每次啟動依本常數校正（見 apps/api/src/services/seed.ts），
 * 不再有第二份手寫清單——原本 migration 0013 內的 32 碼清單已刪除，兩份清單必然漂移。
 */
export const SYSTEM_ACCOUNT_CODES: readonly string[] = [
  ...Object.values(ACCOUNT),
  ...ASSET_CATEGORIES.flatMap((c) => [c.assetCode, c.accumCode]),
  DEPRECIATION_EXPENSE_CODE,
  DISPOSAL_GAIN_CODE,
  DISPOSAL_LOSS_CODE,
  ...EXPENSE_CATEGORIES.map((c) => c.accountCode),
].filter((code, i, all) => all.indexOf(code) === i);

export function isSystemAccount(code: string): boolean {
  return SYSTEM_ACCOUNT_CODES.includes(code);
}

/**
 * 種子科目中屬於「現金」的科目：現金流量表與儀表板現金水位的取數依據。
 * 這份清單只用來校正種子科目的 accounts.is_cash（seedAccounts()），
 * 執行時期一律以資料庫的 is_cash 為準——因為使用者自建的銀行帳戶科目
 * （例如 1104「銀行存款－玉山」）也必須能算進現金，而那是使用者自己在科目維護頁勾的，
 * 不可能出現在這份常數裡。程式任何地方都不得再用這份清單直接查科目。
 *
 * 1102 零用金要算現金的理由：它就是公司帳上另一疊實體鈔票，
 * 漏掉它，現金流量表的期末現金會和資產負債表的現金數對不起來。
 */
export const CASH_ACCOUNT_CODES: readonly string[] = [
  ACCOUNT.CASH, // 1101 庫存現金
  "1102", // 零用金
  ACCOUNT.BANK, // 1103 銀行存款
];

/**
 * 現金流量表的籌資活動科目：借款本金收付與股東往來。
 * 之所以要逐碼列舉而不是用 2xxx 前綴：2144 應付帳款、2201 其他應付款這些是不折不扣的營業活動，
 * 一律當籌資會把「付貨款」算成還債。權益 3xxx 另由 classify() 以前綴處理（增資、減資、盈餘分配）。
 */
export const FINANCING_ACCOUNT_CODES: readonly string[] = [
  "2101", // 短期借款
  "2301", // 長期借款
  "2204", // 股東往來：老闆挹注／抽回，性質等同借款，不是營業收支
];

/**
 * 現金流量表的投資活動科目：固定資產的取得與處分，以及長期擺著不動的存出保證金。
 * 固定資產成本／累計折舊由 ASSET_CATEGORIES 推導，避免與資產模組漂移。
 */
export const INVESTING_ACCOUNT_CODES: readonly string[] = [
  ...ASSET_CATEGORIES.flatMap((c) => [c.assetCode, c.accumCode]),
  "1811", // 存出保證金：租賃押金一擺數年，收付都不是當期營業活動
].filter((code, i, all) => all.indexOf(code) === i);
