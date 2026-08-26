/**
 * 示範公司資料（demo data）：把一個「只有會計科目表」的空系統，灌成一家跑了半年的小公司。
 *
 * 為什麼需要它：`scripts/migrate.ts` 只跑 `seedAccounts()`，新使用者裝好之後面對的是
 * 21 個頁面全空的畫面——沒有交易對象就開不了單、沒有商品就進不了貨、沒有期初就對不出報表，
 * 而「要先做哪一件」這件事系統沒有任何地方講。示範資料的用途是讓人**先看到系統長什麼樣**，
 * 再回頭決定自己的公司要怎麼建。
 *
 * ⚠️ 三件必須先講清楚的事
 * ────────────────────────────────────────────────────────────────────
 * ① 這裡的每一個數字都是**捏造的**，包含統一編號、身分證號、稅率、扣繳費率與地址。
 *    統編只保證通過檢查碼（`isValidTaxId`），**不保證沒有撞到真實存在的公司**——
 *    檢查碼只有 8 位數的 1/5 空間，任何一組合法統編都可能屬於某家真的公司。
 *    示範用的統編一律以 `0` 開頭並集中在本檔頂端的 `DEMO_TAX_IDS`，方便日後整批抽換。
 * ② 稅法參數與扣繳費率的 `sourceNote` 一律明寫「示範資料，非查證結果」。
 *    這是 migration 0016 訂下的紀律：**系統絕不斷言任何稅率**。示範資料是最容易被照抄的地方，
 *    所以它必須是全系統最大聲說「這個數字不是我查的」的那一份。
 * ③ 灌完之後**不要拿這個資料庫當正式帳**。示範帳號的密碼是共用的、寫在程式裡的。
 *
 * 用法
 * ────────────────────────────────────────────────────────────────────
 * 程式內（測試、`scripts/dev-memory.ts`）：
 *   await applyMigrations(...); await seedAccounts(db); await seedDemoCompany(db);
 *
 * CLI（灌進一個已跑過 migrate 的正式庫）：
 *   DATABASE_URL=postgres://... node --experimental-strip-types apps/api/scripts/demo-data.ts
 *   加 --force 才會在已有交易對象的資料庫上繼續（預設拒絕，避免灌到真的帳上）。
 */
import { pathToFileURL } from "node:url";
import { ACCOUNT, isValidTaxId } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { periodOf } from "@tw-erp/einvoice";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db.ts";
import { createAsset, runDepreciation } from "../src/services/assets.ts";
import { hashPassword } from "../src/services/auth.ts";
import { createPurchase, createSale } from "../src/services/documents.ts";
import { approveClaim, createClaim, payClaim } from "../src/services/expenses.ts";
import { issueInvoice } from "../src/services/invoices.ts";
import { createCashDoc, createManualEntry, inventoryOpening } from "../src/services/ledger.ts";
import { convertQuote, createQuote, shipOrder } from "../src/services/orders.ts";
import { encryptPii } from "../src/services/pii.ts";
import { createPurchaseOrder, receivePurchaseOrder } from "../src/services/purchase-orders.ts";
import { createParameter } from "../src/services/tax-parameters.ts";
import { createCategory, createPayment, updateCategory } from "../src/services/withholding.ts";

// ── 示範用統一編號 ────────────────────────────────────────────────────
// 全部以 0 開頭並集中在此，理由見檔頭 ①。每一組都在 seedDemoCompany() 開頭被
// isValidTaxId() 再驗一次——不是防呆，是防「有人手改了一碼卻只在 422 時才發現」。
const DEMO_TAX_IDS = {
  company: "03882371", // 禾昇食品貿易有限公司（本公司）
  supermarket: "05004058",
  restaurant: "04639890",
  frozen: "03342218",
  oilMill: "08484350",
  logistics: "07237997",
  both: "07426776",
} as const;

/** 示範帳號的預設密碼（可由 opts.password 覆寫）；長度須 ≥ 6，與 POST /users 的規則一致 */
const DEFAULT_PASSWORD = "demo-1234";

export interface SeedDemoOptions {
  /** 所有示範帳號共用的密碼（預設 demo-1234） */
  password?: string;
  /** 「今天」；所有日期都由它推算，測試傳固定值即可得到可重現的結果 */
  today?: string;
  /** 已有交易對象時仍繼續（預設 false＝拒絕，避免灌到真的帳上） */
  force?: boolean;
  /** 只灌主檔與期初，不灌任何交易單據（預設 false） */
  mastersOnly?: boolean;
}

export interface SeedDemoResult {
  company: { name: string; taxId: string };
  /** 示範帳號（密碼相同）：印給使用者看的登入資訊 */
  logins: { username: string; role: string; displayName: string }[];
  password: string;
  counts: Record<string, number>;
  /** 期初開帳的科目餘額，供呼叫端核對 */
  opening: { cash: number; bank: number; inventory: number; capital: number; retainedEarnings: number };
  /** 灌製過程中系統回報的提示（例如稅率解析的 taxNotes），原樣帶出來不吞掉 */
  notes: string[];
}

// ── 日期：一律由「今天」往回推 ────────────────────────────────────────
// 為什麼不寫死 2026-01-01：示範資料若停在某個過去年度，儀表板、應收帳齡、
// 本期損益全都會是空的——那正是使用者最想看的幾張畫面。
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysBefore(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}
/**
 * 期初開帳日：**今天所在年度的 1/1**，但上半年（1–6 月）執行時退回前一年的 1/1。
 * 理由：下面的交易單據最遠推到 150 天前，若在 2 月執行而期初訂在當年 1/1，
 * 那些單據會落在期初之前——庫存會在開帳前就被賣掉（createSale 直接 409 庫存不足）。
 */
function openingDateFor(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return `${month >= 7 ? year : year - 1}-01-01`;
}
/** 期別 YYYYMM（奇數月）往後推 n 期，用來建下一期的字軌 */
function nextPeriod(period: string, steps = 1): string {
  let year = Number(period.slice(0, 4));
  let month = Number(period.slice(4, 6)) + steps * 2;
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  return `${year}${String(month).padStart(2, "0")}`;
}

// ── 商品目錄 ──────────────────────────────────────────────────────────
// 0022 之後 price（→ list_price 標準售價）與 category 都真的存進主檔了；
// cost 仍是腳本自己的資料——**標準成本刻意不存**（移動加權平均是本系統成本的事實來源），
// 這裡只拿它當期初庫存的單位成本。minStock 挑幾項常銷品設定，讓庫存頁的安全庫存提示有東西可看。
interface DemoProduct {
  sku: string;
  name: string;
  unit: string;
  category: string;
  price: number; // 標準售價（未稅）→ products.list_price
  cost: number; // 期初庫存單位成本（未稅）；不存主檔（見上）
  openingQty: number;
  minStock?: number;
}

const DEMO_PRODUCTS: readonly DemoProduct[] = [
  { sku: "DRY-1001", name: "特級長糯米 5kg", unit: "包", category: "乾貨", price: 420, cost: 305, openingQty: 300, minStock: 100 },
  { sku: "DRY-1002", name: "有機黑豆 3kg", unit: "包", category: "乾貨", price: 380, cost: 268, openingQty: 200 },
  { sku: "CAN-2001", name: "蕃茄鯖魚罐頭 425g×24", unit: "箱", category: "罐頭", price: 1080, cost: 812, openingQty: 80, minStock: 40 },
  { sku: "CAN-2002", name: "玉米粒罐頭 340g×24", unit: "箱", category: "罐頭", price: 720, cost: 528, openingQty: 120 },
  { sku: "FRZ-3001", name: "冷凍薯條 2.5kg", unit: "箱", category: "冷凍", price: 260, cost: 185, openingQty: 150 },
  { sku: "FRZ-3002", name: "冷凍雞胸肉 5kg", unit: "箱", category: "冷凍", price: 720, cost: 545, openingQty: 90 },
  { sku: "SAU-4001", name: "純釀黑豆醬油 1.8L", unit: "瓶", category: "調味", price: 165, cost: 108, openingQty: 600 },
  { sku: "SAU-4002", name: "白胡椒粉 500g", unit: "罐", category: "調味", price: 210, cost: 142, openingQty: 400 },
  { sku: "OIL-5001", name: "冷壓芝麻油 600ml", unit: "瓶", category: "油品", price: 320, cost: 236, openingQty: 250 },
  { sku: "PKG-6001", name: "食品級真空袋 20×30cm（100入）", unit: "包", category: "包材", price: 95, cost: 58, openingQty: 800 },
  { sku: "SNK-7001", name: "綜合堅果禮盒 800g", unit: "盒", category: "零食", price: 560, cost: 398, openingQty: 150 },
  { sku: "BEV-8001", name: "高山烏龍茶包 2g×50", unit: "盒", category: "飲品", price: 480, cost: 322, openingQty: 200 },
];

// 服務項目（0022 的 is_service）：不入庫存、不開期初，所以另立一組。
// 冷鏈配送幾乎每張單都有運費行——這一項的存在本身就是 demo 的重點（B2 修掉的正是「運費開不了單」）
const DEMO_SERVICES = [
  { sku: "SVC-9001", name: "冷藏配送運費", unit: "式", category: "服務", price: 350 },
  { sku: "SVC-9002", name: "代客分裝服務費", unit: "式", category: "服務", price: 1200 },
] as const;

// ── 交易對象 ──────────────────────────────────────────────────────────
// ⚠️ idNo 是 PII。這裡填的是**刻意編造、格式看得出是假的**號碼（第二碼起全同一個數字），
//    schema 註解要求「不得出現在任何文件與 fixture 的真實值中」——示範資料同樣適用。
//    系統本身不驗 idNo 格式（居留證／護照號碼格式各異，驗錯會把合法對象擋在門外）。
interface DemoPartner {
  key: string;
  name: string;
  taxId?: string;
  idNo?: string;
  isCustomer: boolean;
  isSupplier: boolean;
  isIndividual: boolean;
  // ── 0022 之後這些都真的存進主檔（電話、地址一律是編造的示範值）──
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  shipToAddress?: string;
  /** 付款條件（天）：undefined＝未約定；0＝貨到付款。銷貨單的收款到期日由它推算 */
  paymentTermDays?: number;
  creditLimit?: number;
  /** 業務負責人（DEMO_STAFF 的 username）；建檔時換成員工 id */
  salesOwnerUsername?: string;
  note: string;
}

const DEMO_PARTNERS: readonly DemoPartner[] = [
  {
    key: "supermarket",
    name: "家常屋連鎖超市股份有限公司",
    taxId: DEMO_TAX_IDS.supermarket,
    isCustomer: true,
    isSupplier: false,
    isIndividual: false,
    contactPerson: "採購部 周文彬",
    phone: "02-2733-1122",
    email: "purchasing@homekitchen.example",
    address: "臺北市信義區信義路五段 7 號 12 樓",
    shipToAddress: "桃園市龜山區文化一路 259 號（物流中心收貨課）",
    paymentTermDays: 30,
    creditLimit: 800_000,
    salesOwnerUsername: "huang.zhiwei",
    note: "最大的通路客戶，每季檢討品項與價格",
  },
  {
    key: "restaurant",
    name: "晴光餐飲管理顧問有限公司",
    taxId: DEMO_TAX_IDS.restaurant,
    isCustomer: true,
    isSupplier: false,
    isIndividual: false,
    contactPerson: "林采潔",
    phone: "02-2597-8834",
    email: "central-buy@sunlight-fnb.example",
    address: "臺北市中山區農安街 77 號 3 樓",
    paymentTermDays: 60,
    creditLimit: 500_000,
    salesOwnerUsername: "huang.zhiwei",
    note: "連鎖餐廳的中央採購，月結 60 天",
  },
  {
    key: "retailCustomer",
    name: "陳美玲",
    isCustomer: true,
    isSupplier: false,
    isIndividual: true,
    phone: "0933-000-111",
    paymentTermDays: 0,
    note: "個人客戶（散客）：貨到付款，開 B2C 發票，沒有統編",
  },
  {
    key: "foreign",
    name: "Pacific Gourmet Trading Pte. Ltd.",
    isCustomer: true,
    isSupplier: false,
    isIndividual: false,
    contactPerson: "Daniel Koh",
    email: "orders@pacificgourmet.example.sg",
    address: "10 Anson Road, Singapore（示範地址）",
    note: "外國客戶（新加坡）：出口銷售，零稅率情境。無統編、非個人",
  },
  {
    key: "frozen",
    name: "日昇冷凍食品股份有限公司",
    taxId: DEMO_TAX_IDS.frozen,
    isCustomer: false,
    isSupplier: true,
    isIndividual: false,
    contactPerson: "業務課 吳大維",
    phone: "03-322-5566",
    address: "桃園市蘆竹區南工路二段 500 號",
    note: "供應商：冷凍與罐頭品項的主力供應商",
  },
  {
    key: "oilMill",
    name: "豐原製油工業有限公司",
    taxId: DEMO_TAX_IDS.oilMill,
    isCustomer: false,
    isSupplier: true,
    isIndividual: false,
    phone: "04-2515-7788",
    address: "臺中市豐原區工業區一路 21 號",
    note: "供應商：油品與調味料",
  },
  {
    key: "logistics",
    name: "宏遠物流股份有限公司",
    taxId: DEMO_TAX_IDS.logistics,
    isCustomer: false,
    isSupplier: true,
    isIndividual: false,
    phone: "02-2299-0001",
    note: "供應商：配送外包（費用型，不進庫存）",
  },
  {
    key: "both",
    name: "巧食坊食品行",
    taxId: DEMO_TAX_IDS.both,
    isCustomer: true,
    isSupplier: true,
    isIndividual: false,
    contactPerson: "戴老闆",
    phone: "02-2882-3344",
    address: "新北市三重區重新路四段 12 號",
    paymentTermDays: 15,
    creditLimit: 200_000,
    salesOwnerUsername: "huang.zhiwei",
    note: "既是客戶也是供應商：向我們批貨，同時代工自有品牌堅果禮盒",
  },
  {
    key: "landlord",
    name: "王素珍",
    idNo: "A188888888",
    isCustomer: false,
    isSupplier: true,
    isIndividual: true,
    phone: "0910-222-333",
    address: "臺北市中山區民生東路三段 128 號 7 樓（示範地址，扣繳憑單的受領人地址）",
    note: "個人房東：辦公室兼倉庫的出租人，付租金時需代扣（扣繳支出單）",
  },
  {
    key: "designer",
    name: "李明哲",
    idNo: "F299999999",
    isCustomer: false,
    isSupplier: true,
    isIndividual: true,
    phone: "0987-444-555",
    email: "mingche.design@example.tw",
    note: "個人接案設計師：包裝設計委外，付款時需代扣（扣繳支出單）",
  },
];

// ── 員工與使用者 ──────────────────────────────────────────────────────
// employee 角色**一定**要連結員工主檔：POST /expense-claims 需要 employeeId，
// 而使用者自己送報銷時前端是拿 me.employeeId 去帶的——沒連結就 422，
// 且錯誤發生在報銷頁而不是使用者管理頁（見回報）。所以這裡五個人全部連結。
const DEMO_STAFF = [
  { username: "lin.junhong", displayName: "林俊宏", role: "admin" as const, title: "負責人" },
  { username: "chang.yating", displayName: "張雅婷", role: "finance" as const, title: "會計" },
  { username: "huang.zhiwei", displayName: "黃志偉", role: "sales" as const, title: "業務主任" },
  { username: "wu.jianliang", displayName: "吳建良", role: "purchasing" as const, title: "採購專員" },
  { username: "tsai.peishan", displayName: "蔡佩珊", role: "employee" as const, title: "倉管" },
];

/** 灌資料前先擋：這支腳本會建立使用者與傳票，跑在有資料的庫上是災難 */
async function assertEmpty(db: Db, force: boolean): Promise<void> {
  const partners = await db.select({ id: schema.partners.id }).from(schema.partners);
  const users = await db.select({ id: schema.users.id }).from(schema.users);
  if ((partners.length || users.length) && !force) {
    throw new Error(
      `資料庫已有 ${partners.length} 筆交易對象與 ${users.length} 個使用者，拒絕灌入示範資料。` +
        `示範資料只該灌進全新的資料庫（migrate + seedAccounts 之後、任何人建檔之前）。` +
        `若你確定要在這個庫上繼續，請帶 --force / { force: true }。`,
    );
  }
  const accounts = await db.select({ id: schema.accounts.id }).from(schema.accounts);
  if (accounts.length === 0) {
    throw new Error("會計科目表是空的：請先執行 scripts/migrate.ts（或呼叫 seedAccounts(db)）再灌示範資料。");
  }
}

export async function seedDemoCompany(db: Db, opts: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const today = opts.today ?? iso(new Date());
  const password = opts.password ?? DEFAULT_PASSWORD;
  const notes: string[] = [];

  // 統編在這裡先驗一次：等到 POST /partners 才被 422 擋下的話，
  // 訊息只會說「檢查碼錯誤」，而不會說「是 demo-data.ts 裡那組寫錯了」
  for (const [key, id] of Object.entries(DEMO_TAX_IDS)) {
    if (!isValidTaxId(id)) throw new Error(`DEMO_TAX_IDS.${key} = ${id} 通不過統一編號檢查碼`);
  }
  await assertEmpty(db, opts.force ?? false);

  const openingDate = openingDateFor(today);
  const D = {
    opening: openingDate,
    // 交易日期一律由今天往回推（見 openingDateFor 的說明）
    po1: daysBefore(today, 150),
    purchase1: daysBefore(today, 143),
    purchase2: daysBefore(today, 121),
    sale1: daysBefore(today, 118),
    quoteWon: daysBefore(today, 96),
    order1: daysBefore(today, 90),
    ship1: daysBefore(today, 84),
    assetBuy: daysBefore(today, 80),
    sale2: daysBefore(today, 62),
    purchase3: daysBefore(today, 55),
    claim1: daysBefore(today, 48),
    rent1: daysBefore(today, 40),
    receipt1: daysBefore(today, 35),
    design: daysBefore(today, 28),
    payment1: daysBefore(today, 24),
    quoteOpen: daysBefore(today, 18),
    exportSale: daysBefore(today, 14),
    poOpen: daysBefore(today, 12),
    // 當期（今天所在的 401 期別）也要有一張進貨單，否則 401 的進項欄整排是 0——
    // 那正是使用者第一次打開申報頁最想看的那一格
    purchase4: daysBefore(today, 8),
    sale3: daysBefore(today, 9),
    sale4: daysBefore(today, 6),
    claim2: daysBefore(today, 4),
  };

  // ── ① 公司基本檔 ────────────────────────────────────────────────────
  // 稅籍編號、縣市別代號都要填：401 媒體檔的檔頭直接取這兩欄，缺了就報不出去。
  const [company] = await db
    .insert(schema.companyProfile)
    .values({
      id: 1,
      name: "禾昇食品貿易有限公司",
      taxId: DEMO_TAX_IDS.company,
      address: "臺北市中山區民生東路三段 128 號 5 樓之 3",
      personInCharge: "林俊宏",
      telephone: "02-2545-6789",
      email: "service@hesheng-foods.example",
      taxRegistrationNo: "103882371", // 稅籍編號 9 碼（示範值）
      cityCode: "A", // 縣市別代號：A＝臺北市（示範值）
    })
    .onConflictDoUpdate({ target: schema.companyProfile.id, set: { name: "禾昇食品貿易有限公司" } })
    .returning();

  // ── ② 員工與使用者 ─────────────────────────────────────────────────
  // 順序：員工先建，使用者才連得上（users.employee_id 是 FK）。
  const employeeIds = new Map<string, number>();
  for (const s of DEMO_STAFF) {
    const [row] = await db
      .insert(schema.employees)
      .values({ name: s.displayName, title: s.title })
      .returning();
    employeeIds.set(s.username, row!.id);
  }
  const userIds = new Map<string, number>();
  for (const s of DEMO_STAFF) {
    const [row] = await db
      .insert(schema.users)
      .values({
        username: s.username,
        displayName: `${s.displayName}（${s.title}）`,
        passwordHash: hashPassword(password),
        role: s.role,
        employeeId: employeeIds.get(s.username)!,
      })
      .returning();
    userIds.set(s.username, row!.id);
  }
  const adminId = userIds.get("lin.junhong")!;
  const financeId = userIds.get("chang.yating")!;
  const salesId = userIds.get("huang.zhiwei")!;
  const purchasingId = userIds.get("wu.jianliang")!;

  // ── ③ 交易對象 ─────────────────────────────────────────────────────
  const partnerIds = new Map<string, number>();
  for (const p of DEMO_PARTNERS) {
    const [row] = await db
      .insert(schema.partners)
      .values({
        name: p.name,
        taxId: p.taxId ?? null,
        idNo: encryptPii(p.idNo) ?? null,
        isCustomer: p.isCustomer,
        isSupplier: p.isSupplier,
        isIndividual: p.isIndividual,
        contactPerson: p.contactPerson ?? null,
        phone: p.phone ?? null,
        email: p.email ?? null,
        address: p.address ?? null,
        shipToAddress: p.shipToAddress ?? null,
        paymentTermDays: p.paymentTermDays ?? null,
        creditLimit: p.creditLimit ?? null,
        salesOwnerEmployeeId: p.salesOwnerUsername ? (employeeIds.get(p.salesOwnerUsername) ?? null) : null,
        note: p.note,
      })
      .returning();
    partnerIds.set(p.key, row!.id);
  }
  const P = (key: string): number => {
    const id = partnerIds.get(key);
    if (!id) throw new Error(`示範資料內部錯誤：交易對象 ${key} 不存在`);
    return id;
  };

  // ── ④ 商品 ─────────────────────────────────────────────────────────
  const productIds = new Map<string, number>();
  for (const p of DEMO_PRODUCTS) {
    const [row] = await db
      .insert(schema.products)
      .values({
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        listPrice: p.price,
        category: p.category,
        minStock: p.minStock ?? null,
      })
      .returning();
    productIds.set(p.sku, row!.id);
  }
  // 服務項目（is_service）：不入庫存、不開期初——運費行能不能開單，是 B2 修好與否的活證據
  for (const p of DEMO_SERVICES) {
    const [row] = await db
      .insert(schema.products)
      .values({ sku: p.sku, name: p.name, unit: p.unit, listPrice: p.price, category: p.category, isService: true })
      .returning();
    productIds.set(p.sku, row!.id);
  }
  const PR = (sku: string): number => {
    const id = productIds.get(sku);
    if (!id) throw new Error(`示範資料內部錯誤：商品 ${sku} 不存在`);
    return id;
  };

  // ── ⑤ 發票字軌 ─────────────────────────────────────────────────────
  // 涵蓋「當期」與「下一期」：只建當期的話，今天是期末最後一天時明天就開不出發票。
  const currentPeriod = periodOf(today);
  // 每一期一組**互不重複**的字軌與號碼區間：字軌＋號碼組成的發票號碼是 UNIQUE，
  // 兩期共用同一組區間會在第二期開第一張發票時撞號（而錯誤訊息只會說「重複鍵值」）
  const trackLetters = ["MZ", "NB", "KX", "LP", "QT", "RV", "SC", "TD"];
  const periodsNeeded = [
    currentPeriod,
    nextPeriod(currentPeriod),
    // 示範單據橫跨半年，舊期別的銷貨單也要開得出發票
    ...[D.sale1, D.ship1, D.sale2, D.exportSale, D.sale3, D.sale4, D.purchase1].map(periodOf),
  ];
  const tracks: { period: string; track: string; rangeStart: number; rangeEnd: number }[] = [];
  for (const period of periodsNeeded) {
    if (tracks.some((t) => t.period === period)) continue;
    const i = tracks.length;
    const letters = trackLetters[i % trackLetters.length]!;
    tracks.push({
      period,
      track: letters,
      rangeStart: 40000000 + i * 1_000_000,
      rangeEnd: 40000000 + i * 1_000_000 + 149,
    });
  }
  for (const t of tracks) {
    await db.insert(schema.invoiceTracks).values({ ...t, nextNo: t.rangeStart });
  }

  // ── ⑥ 稅法參數 ─────────────────────────────────────────────────────
  // migration 0016 已種了一列 vat（1900-01-01 起、無迄日、5%，明寫是「既有行為的遷移」）。
  // 這裡示範**接續**：新增一列從期初日起生效，並把舊列的迄日設成前一天。
  // 值刻意與舊列相同（500 bp）——示範的是「怎麼留紀錄」，不是「稅率該是多少」。
  await createParameter(
    db,
    {
      kind: "vat",
      scopeKey: null,
      label: "營業稅率（示範資料）",
      validFrom: D.opening,
      validTo: null,
      brackets: [{ from: 0, to: null, mode: "rate_on_total", rateBp: 500 }],
      sourceNote:
        "⚠️ 示範資料，不是查證結果：本列由 apps/api/scripts/demo-data.ts 灌入，" +
        "數值沿用 migration 0016 的遷移值。正式使用前請自行向財政部查證現行費率，" +
        "並以「接續前一列」新增你自己的版本，在此欄寫明查詢來源與查詢日期。",
      supersedePrevious: true,
    },
    adminId,
  );
  // 布林型參數示範：交際費的進項稅可否扣抵（core 的預設值是 false，這裡把它落成一筆有依據欄的紀錄）
  await createParameter(
    db,
    {
      kind: "input_tax_deductible",
      scopeKey: "6137",
      label: "6137 交際費：進項稅可否扣抵（示範資料）",
      validFrom: D.opening,
      validTo: null,
      boolValue: false,
      sourceNote:
        "⚠️ 示範資料，不是查證結果：由 demo-data.ts 灌入，僅為了讓「稅法參數」頁看得到一筆布林型設定。" +
        "請自行查證後新增一列接續，並寫明你的依據。",
    },
    adminId,
  );
  // 級距型參數示範（income_tax 屬 RECORD_ONLY_KINDS：系統只保管、不計算）
  await createParameter(
    db,
    {
      kind: "income_tax",
      scopeKey: null,
      label: "營利事業所得稅級距（示範資料，系統不計算）",
      validFrom: D.opening,
      validTo: null,
      brackets: [
        { from: 0, to: 100_000, mode: "exempt" },
        { from: 100_000, to: 500_000, mode: "rate_of_excess", rateBp: 1000 },
        { from: 500_000, to: null, mode: "rate_on_total", rateBp: 1500 },
      ],
      sourceNote:
        "⚠️ 示範資料，數字全為虛構（中性數字，刻意不使用任何真實稅率）：" +
        "本 kind 系統只保管、不計算。請以你自己查到的級距新增一列接續並註明依據。",
    },
    adminId,
  );

  // ── ⑦ 扣繳類別 ─────────────────────────────────────────────────────
  // migration 0015 已種了兩筆（租金／專業服務費），但費率是 NULL＝「尚未設定」。
  // 示範資料把費率補上，讓扣繳支出單有預設值可試算；sourceNote 明寫這是示範值。
  const DEMO_RATE_NOTE =
    "⚠️ 示範資料，不是查證結果：本費率由 demo-data.ts 灌入，僅為了讓扣繳支出單有預設值可試算。" +
    "正式使用前請向國稅局／勞保局查證現行費率後覆蓋本欄，並寫明你的依據來源與查詢日期。";
  const seededCategories = await db
    .select()
    .from(schema.withholdingCategories)
    .orderBy(schema.withholdingCategories.id);
  const rentCategory = seededCategories.find((c) => c.expenseAccountCode === "6121");
  const serviceCategory = seededCategories.find((c) => c.expenseAccountCode === "6124");
  if (rentCategory) {
    await updateCategory(db, rentCategory.id, {
      taxRateBp: 1000,
      supplementRateBp: 211,
      sourceNote: DEMO_RATE_NOTE,
    });
  }
  if (serviceCategory) {
    await updateCategory(db, serviceCategory.id, {
      taxRateBp: 1000,
      supplementRateBp: 211,
      sourceNote: DEMO_RATE_NOTE,
    });
  }
  // 第三種類別：給個人的介紹佣金（6128）。示範「使用者自己新增一種類別」長什麼樣
  await createCategory(db, {
    label: "付給個人的介紹佣金",
    expenseAccountCode: "6128",
    taxRateBp: 1000,
    supplementRateBp: null,
    sourceNote: DEMO_RATE_NOTE,
  });

  // ── ⑧ 期初：庫存開帳 ＋ 一張手工傳票 ───────────────────────────────
  // 兩件事刻意分開（與市售系統相同）：庫存開帳只建立數量與平均成本基礎、不拋傳票，
  // 存貨科目的金額要自己併進期初傳票。demo 這裡把兩邊軋成同一個數字。
  await inventoryOpening(db, {
    docDate: D.opening,
    lines: DEMO_PRODUCTS.map((p) => ({ productId: PR(p.sku), qty: p.openingQty, unitCost: p.cost })),
  });
  const openingInventory = DEMO_PRODUCTS.reduce((s, p) => s + Math.round(p.openingQty * p.cost), 0);
  const openingCash = 80_000;
  const openingBank = 1_650_000;
  const openingCapital = 2_000_000;
  // 累積盈虧是**軋平項**：改上面任何一個數字，這一筆自動吸收差額，試算表永遠是平的。
  // 寫死它才是坑——改了庫存數量卻忘了改權益，借貸差額會直接讓 createManualEntry 400。
  const openingRetained = openingCash + openingBank + openingInventory - openingCapital;
  await createManualEntry(db, {
    entryDate: D.opening,
    memo: `期初開帳（示範資料）：${D.opening}`,
    lines: [
      { accountCode: ACCOUNT.CASH, debit: openingCash, credit: 0 },
      { accountCode: ACCOUNT.BANK, debit: openingBank, credit: 0 },
      { accountCode: ACCOUNT.INVENTORY, debit: openingInventory, credit: 0 },
      { accountCode: ACCOUNT.CAPITAL, debit: 0, credit: openingCapital },
      openingRetained >= 0
        ? { accountCode: ACCOUNT.RETAINED_EARNINGS, debit: 0, credit: openingRetained }
        : { accountCode: ACCOUNT.RETAINED_EARNINGS, debit: -openingRetained, credit: 0 },
    ],
  });

  // ── ⑨ 合約 ─────────────────────────────────────────────────────────
  // 四種狀態都要有，到期日也要分散（已到期／半年內到期／長期／無迄日），
  // 否則合約頁的「即將到期」提醒在示範資料上永遠是空的。
  const contracts = [
    {
      partnerId: P("landlord"),
      counterparty: "王素珍",
      title: "民生東路辦公室暨倉庫租賃契約",
      direction: "purchase" as const,
      amount: 456_000,
      signDate: daysBefore(D.opening, 20),
      startDate: D.opening,
      endDate: `${Number(D.opening.slice(0, 4)) + 1}-12-31`,
      status: "active" as const,
      memo: "月租 38,000 元（未稅），押金二個月。付款時需開扣繳支出單（個人房東）。",
    },
    {
      partnerId: P("supermarket"),
      counterparty: "家常屋連鎖超市股份有限公司",
      title: "年度供貨合約（乾貨、罐頭、調味料）",
      amount: 3_600_000,
      signDate: daysBefore(today, 200),
      startDate: daysBefore(today, 180),
      endDate: daysBefore(today, -185),
      status: "active" as const,
      memo: "月結 30 天，年度目標金額 360 萬。每季檢討品項與價格。",
    },
    {
      partnerId: P("designer"),
      counterparty: "李明哲",
      title: "自有品牌包裝設計委任契約",
      direction: "purchase" as const,
      amount: 180_000,
      signDate: daysBefore(today, 40),
      startDate: daysBefore(today, 35),
      endDate: daysBefore(today, -60),
      status: "active" as const,
      memo: "分三期給付，個人受領需代扣（扣繳支出單）。",
    },
    {
      partnerId: P("frozen"),
      counterparty: "日昇冷凍食品股份有限公司",
      title: "冷凍品年度採購框架合約",
      direction: "purchase" as const,
      amount: 2_400_000,
      signDate: daysBefore(today, 420),
      startDate: daysBefore(today, 400),
      endDate: daysBefore(today, 35),
      status: "ended" as const,
      memo: "已到期，續約條件洽談中。",
    },
    {
      partnerId: P("logistics"),
      counterparty: "宏遠物流股份有限公司",
      title: "北區配送服務合約",
      direction: "purchase" as const,
      amount: 720_000,
      signDate: daysBefore(today, 390),
      startDate: daysBefore(today, 380),
      endDate: daysBefore(today, -120),
      status: "terminated" as const,
      memo: "因配送延誤率過高，依約提前終止，改由第二家供應商承接。",
    },
    {
      partnerId: P("restaurant"),
      counterparty: "晴光餐飲管理顧問有限公司",
      title: "中央廚房通路經銷合約（草稿）",
      amount: 1_200_000,
      signDate: null,
      startDate: daysBefore(today, -30),
      endDate: null,
      status: "draft" as const,
      memo: "條款協商中，尚未用印。價格附件待業務確認。",
    },
  ];
  for (const c of contracts) {
    await db.insert(schema.contracts).values(c);
  }

  // 0037：一份帶請款計畫的顧問月費約——展示「待請款」與一鍵開單（顧問／軟體開發業的形狀）。
  // 三期：35 天前與 5 天前（逾期未請，「待請款」會標紅）、25 天後（30 天窗內待請）；金額未稅
  const [retainer] = await db
    .insert(schema.contracts)
    .values({
      partnerId: P("restaurant"),
      counterparty: "晴光餐飲管理顧問有限公司",
      title: "門市數位化顧問服務（月費）",
      kind: "retainer",
      amount: 540_000,
      signDate: daysBefore(today, 75),
      startDate: daysBefore(today, 60),
      endDate: daysBefore(today, -305),
      status: "active" as const,
      memo: "每月第 5 個工作天前請款；範圍含 POS 導入輔導與月報。",
    })
    .returning();
  await db.insert(schema.contractInstallments).values(
    [-35, -5, 25].map((offset, i) => ({
      contractId: retainer!.id,
      seq: i + 1,
      dueDate: daysBefore(today, -offset), // daysBefore 的負數＝未來
      amount: 45_000,
      description: `顧問月費 第 ${i + 1} 期`,
    })),
  );

  const counts: Record<string, number> = {};
  if (opts.mastersOnly) {
    return buildResult();
  }

  // ── ⑩ 交易單據 ─────────────────────────────────────────────────────
  // 泛型（不是 `(r: { taxNotes?: string[] })`）：後者會把回傳型別收窄成只有 taxNotes，
  // 之後 sale.id / purchase.total 全部取不到
  const collect = <T extends { taxNotes?: string[] | undefined }>(r: T): T => {
    for (const n of r.taxNotes ?? []) if (!notes.includes(n)) notes.push(n);
    return r;
  };

  // 採購單 → 收貨（進貨單）：走完整流程，讓採購頁看得到「已收貨結案」的單
  const po1 = await createPurchaseOrder(
    db,
    {
      partnerId: P("frozen"),
      orderDate: D.po1,
      memo: "Q1 冷凍與罐頭備貨",
      lines: [
        { productId: PR("FRZ-3001"), qty: 120, unitPrice: 185 },
        { productId: PR("FRZ-3002"), qty: 60, unitPrice: 545 },
        { productId: PR("CAN-2001"), qty: 50, unitPrice: 812 },
      ],
    },
    purchasingId,
  );
  // 收貨會產生一張進貨單（含拋轉與庫存），採購單隨之結案
  await receivePurchaseOrder(db, po1.id, { docDate: D.purchase1 });

  // 直接開的進貨單（沒有採購單的日常補貨）
  const purchase2 = collect(
    await createPurchase(db, {
      partnerId: P("oilMill"),
      docDate: D.purchase2,
      lines: [
        { productId: PR("OIL-5001"), qty: 200, unitPrice: 236 },
        { productId: PR("SAU-4001"), qty: 400, unitPrice: 108 },
        { productId: PR("SAU-4002"), qty: 200, unitPrice: 142 },
      ],
    }),
  );
  const purchase3 = collect(
    await createPurchase(db, {
      partnerId: P("both"),
      docDate: D.purchase3,
      lines: [{ productId: PR("SNK-7001"), qty: 200, unitPrice: 398 }],
    }),
  );
  const purchase4 = collect(
    await createPurchase(db, {
      partnerId: P("frozen"),
      docDate: D.purchase4,
      lines: [
        { productId: PR("CAN-2002"), qty: 80, unitPrice: 528 },
        { productId: PR("DRY-1001"), qty: 100, unitPrice: 305 },
      ],
    }),
  );
  /**
   * 供應商發票號碼：401 的進項來源。
   * ⚠️ 這是**唯一**沒有專用建單欄位的必填資料——createPurchase 不收字軌／號碼，
   *    只能事後 PATCH /purchases/:id/supplier-invoice 補。不補的話 401 的進項欄全是 0，
   *    而畫面上沒有任何地方提示「這張進貨單還沒登記發票號碼」。
   *    示範資料直接寫 DB（與那支 PATCH 寫的是同幾個欄位）。
   */
  for (const [id, invNo, invDate] of [
    [purchase2.id, "31200417", D.purchase2],
    [purchase3.id, "31200988", D.purchase3],
    [purchase4.id, "31201655", D.purchase4],
  ] as const) {
    await db
      .update(schema.purchases)
      // inv_date（0029，R20）＝供應商發票開立日期：401 進項歸期用它。示範資料與進貨同日
      .set({ invTrack: "SR", invNo, invDate, invFormat: "25", deductionCode: "1" })
      .where(eq(schema.purchases.id, id));
  }

  // 銷貨（直接開單）
  const sale1 = collect(
    await createSale(db, {
      partnerId: P("supermarket"),
      docDate: D.sale1,
      lines: [
        { productId: PR("DRY-1001"), qty: 60, unitPrice: 420 },
        { productId: PR("CAN-2002"), qty: 30, unitPrice: 720 },
        { productId: PR("SAU-4001"), qty: 150, unitPrice: 165 },
      ],
    }),
  );

  // 報價 → 訂單 → 出貨（銷售前段的完整鏈）
  const wonQuote = collect(
    await createQuote(
      db,
      {
        partnerId: P("restaurant"),
        quoteDate: D.quoteWon,
        memo: "中央廚房 Q2 用量報價",
        lines: [
          { productId: PR("FRZ-3002"), qty: 40, unitPrice: 720 },
          { productId: PR("SAU-4002"), qty: 80, unitPrice: 210 },
        ],
      },
      salesId,
    ),
  );
  const order1 = await convertQuote(db, wonQuote.id, D.order1, salesId);
  // 只出一部分：讓訂單停在 partial，示範「還有尾數沒出」的狀態
  const order1Lines = await db
    .select()
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, order1.id));
  collect(
    await shipOrder(db, order1.id, {
      docDate: D.ship1,
      lines: order1Lines.map((l, i) => ({ orderLineId: l.id, qty: i === 0 ? 25 : Number(l.qty) })),
    }),
  );

  const sale2 = collect(
    await createSale(db, {
      partnerId: P("both"),
      docDate: D.sale2,
      lines: [
        { productId: PR("PKG-6001"), qty: 200, unitPrice: 95 },
        { productId: PR("DRY-1002"), qty: 40, unitPrice: 380 },
      ],
    }),
  );
  const sale3 = collect(
    await createSale(db, {
      partnerId: P("supermarket"),
      docDate: D.sale3,
      lines: [
        { productId: PR("BEV-8001"), qty: 50, unitPrice: 480 },
        { productId: PR("SNK-7001"), qty: 60, unitPrice: 560 },
        // 運費行（服務項目）：冷鏈配送幾乎每張單都有——0022 之前這一行會被庫存檢查 409 擋掉
        { productId: PR("SVC-9001"), qty: 1, unitPrice: 350 },
      ],
    }),
  );
  const sale4 = collect(
    await createSale(db, {
      partnerId: P("retailCustomer"),
      docDate: D.sale4,
      lines: [
        { productId: PR("OIL-5001"), qty: 3, unitPrice: 320 },
        { productId: PR("SNK-7001"), qty: 2, unitPrice: 560 },
      ],
    }),
  );

  /**
   * 外銷（零稅率，0028／B12 之後走正式入口）：對新加坡客戶開零稅率銷貨單——
   * 稅額 0、收入自動記 4102「銷貨收入－零稅率」、庫存真的出貨（移動平均成本照算）。
   * 經海關出口案例：填出口報單號碼（編造的示範值；系統不驗證文件內容），
   * 不開統一發票（經海關出口的零稅率銷售額在 401 依銷貨單取數，申報書代號 15）。
   * 0028 之前這裡只能用手工傳票繞路，那段「系統做不到」的註記已功成身退。
   */
  const exportSale = collect(
    await createSale(db, {
      partnerId: P("foreign"),
      docDate: D.exportSale,
      taxType: "2",
      zeroTaxViaCustoms: true,
      zeroTaxCertNo: "AA00-DEMO-0001（示範值）",
      lines: [
        { productId: PR("DRY-1001"), qty: 200, unitPrice: 400 },
        { productId: PR("SAU-4001"), qty: 300, unitPrice: 160 },
      ],
    }),
  );
  if (exportSale.tax !== 0) throw new Error(`零稅率銷貨單稅額應為 0，得到 ${exportSale.tax}`);
  notes.push(
    "外銷零稅率：新加坡客戶那一單走正式的零稅率銷貨單（稅額 0、收入記 4102、經海關出口＋示範用出口報單號碼）。",
  );

  // 開立發票：B2B（有統編）與 B2C（個人客戶）各一張
  await issueInvoice(db, sale3.id, { mode: "B2B", invoiceTime: "14:20:00", randomNumber: "4271" });
  await issueInvoice(db, sale4.id, { mode: "B2C", invoiceTime: "11:05:00", randomNumber: "8836" });

  // 收付款：收客戶的錢（立沖指定單據）、付供應商的錢
  await createCashDoc(db, {
    kind: "receipt",
    partnerId: P("supermarket"),
    docDate: D.receipt1,
    amount: sale1.total,
    accountId: (await accountIdOf(db, ACCOUNT.BANK))!,
    memo: `收 ${D.sale1} 貨款（家常屋月結）`,
    allocations: [{ targetId: sale1.id, amount: sale1.total }],
  });
  await createCashDoc(db, {
    kind: "payment",
    partnerId: P("oilMill"),
    docDate: D.payment1,
    amount: purchase2.total,
    accountId: (await accountIdOf(db, ACCOUNT.BANK))!,
    memo: "付豐原製油貨款",
    allocations: [{ targetId: purchase2.id, amount: purchase2.total }],
  });

  // 開著的採購單與報價單：讓「待處理」的畫面不是空的。
  // 採購單帶「已過期的預計到貨日」（0035）：清單頁的逾期標色要有一列真的在紅
  await createPurchaseOrder(
    db,
    {
      partnerId: P("frozen"),
      orderDate: D.poOpen,
      expectedDate: daysBefore(today, 2),
      memo: "中秋檔期備貨（尚未收貨）",
      lines: [
        { productId: PR("CAN-2001"), qty: 60, unitPrice: 812 },
        { productId: PR("FRZ-3001"), qty: 100, unitPrice: 185 },
      ],
    },
    purchasingId,
  );
  collect(
    await createQuote(
      db,
      {
        partnerId: P("supermarket"),
        quoteDate: D.quoteOpen,
        // 未來的預計交期（0035）：報價單清單與列印視圖都要看得到這一欄
        expectedDate: daysBefore(today, -21),
        memo: "中秋禮盒專案報價（洽談中）",
        lines: [
          { productId: PR("SNK-7001"), qty: 300, unitPrice: 545 },
          { productId: PR("BEV-8001"), qty: 200, unitPrice: 465 },
        ],
      },
      salesId,
    ),
  );

  // ── ⑪ 固定資產 ─────────────────────────────────────────────────────
  // ⚠️ createAsset **不拋轉取得傳票**（服務層檔頭已寫明「取得入帳走進貨/手工傳票」）。
  //    所以每一台資產都要自己補一張手工傳票，否則資產負債表上只會有累計折舊（貸方），
  //    資產成本那一格是空的——淨額變負數而且沒有任何提示。
  const coldCase = await createAsset(
    db,
    {
      name: "冷藏展示櫃（倉庫揀貨區）",
      category: "machine",
      cost: 168_000,
      startDate: D.assetBuy,
      memo: "示範資料",
    },
    adminId,
  );
  const van = await createAsset(
    db,
    {
      name: "配送小貨車 1.75 噸",
      category: "vehicle",
      cost: 620_000,
      startDate: D.assetBuy,
      memo: "示範資料",
    },
    adminId,
  );
  await createManualEntry(db, {
    entryDate: D.assetBuy,
    memo: "購置冷藏展示櫃與配送小貨車（資產取得傳票，createAsset 不自動拋轉）",
    lines: [
      { accountCode: "1411", debit: coldCase.cost, credit: 0 },
      { accountCode: "1431", debit: van.cost, credit: 0 },
      { accountCode: ACCOUNT.BANK, debit: 0, credit: coldCase.cost + van.cost },
    ],
  });
  // 折舊：從啟用月起提到上個月為止（本月還沒結，先不提）
  for (const period of monthsBetween(D.assetBuy.slice(0, 7), previousMonth(today.slice(0, 7)))) {
    await runDepreciation(db, period);
  }

  // ── ⑫ 員工報銷 ─────────────────────────────────────────────────────
  // 一張走完（送出→核准→付款）、一張停在待審，讓報銷頁兩種狀態都看得到
  const claim1 = await createClaim(db, {
    employeeId: employeeIds.get("tsai.peishan")!,
    claimDate: D.claim1,
    memo: "倉庫用品與加班餐費",
    items: [
      {
        accountCode: "6133",
        description: "棧板膜、標籤紙、簽字筆",
        docType: "einvoice",
        amount: 2_180,
        deductible: true,
        invoiceNumber: "AB12345678",
        invoiceDate: D.claim1,
        sellerTaxId: DEMO_TAX_IDS.logistics,
      },
      {
        accountCode: "6112",
        description: "盤點日加班便當 12 份",
        docType: "receipt",
        amount: 1_320,
        deductible: false,
      },
    ],
  });
  // 0036 起 approveClaim 要核准人（自我核准把關＋approved_by 留痕）：財務核倉管的單
  await approveClaim(db, claim1.id, {
    id: financeId,
    username: "chang.yating",
    displayName: "張雅婷（會計）",
    role: "finance",
    employeeId: employeeIds.get("chang.yating") ?? null,
    totpEnabled: false,
  });
  await payClaim(db, claim1.id, (await accountIdOf(db, ACCOUNT.CASH))!, D.claim1);
  await createClaim(db, {
    employeeId: employeeIds.get("huang.zhiwei")!,
    claimDate: D.claim2,
    memo: "客戶拜訪計程車資（待審）",
    items: [
      {
        accountCode: "6131",
        description: "拜訪家常屋總部往返計程車",
        docType: "receipt",
        amount: 860,
        deductible: false,
      },
    ],
  });

  // ── ⑬ 扣繳支出單（付個人）─────────────────────────────────────────
  const cashAccountId = (await accountIdOf(db, ACCOUNT.BANK))!;
  const rentPayment = rentCategory
    ? await createPayment(
        db,
        {
          partnerId: P("landlord"),
          categoryId: rentCategory.id,
          payDate: D.rent1,
          grossAmount: 38_000,
          cashAccountId,
          memo: "民生東路辦公室租金（示範資料）",
        },
        financeId,
      )
    : null;
  const designPayment = serviceCategory
    ? await createPayment(
        db,
        {
          partnerId: P("designer"),
          categoryId: serviceCategory.id,
          payDate: D.design,
          grossAmount: 60_000,
          cashAccountId,
          memo: "自有品牌包裝設計第一期款（示範資料）",
        },
        financeId,
      )
    : null;
  for (const p of [rentPayment, designPayment]) {
    for (const n of p?.notes ?? []) if (!notes.includes(n)) notes.push(n);
  }

  // ── ⑨ HR 出勤示範（0039/0040）─────────────────────────────────────
  // 部門樹＋直屬主管（簽核鏈）、班別、這兩週的排班、特休額度、一張簽核中的請假單。
  // 行事曆刻意不灌：國定假日是使用者該自己查抄人事行政局公告的內容，
  // 示範資料預填等於替使用者斷言「今年哪天放假」——與稅法參數同一條紀律。
  const [mgmtDept] = await db
    .insert(schema.departments)
    .values({ name: "管理部", managerEmployeeId: employeeIds.get("lin.junhong")! })
    .returning();
  const [bizDept] = await db
    .insert(schema.departments)
    .values({ name: "業務部", parentId: mgmtDept!.id, managerEmployeeId: employeeIds.get("huang.zhiwei")! })
    .returning();
  const deptOf: Record<string, number> = {
    "lin.junhong": mgmtDept!.id,
    "chang.yating": mgmtDept!.id,
    "huang.zhiwei": bizDept!.id,
    "wu.jianliang": bizDept!.id,
    "tsai.peishan": bizDept!.id,
  };
  for (const [username, deptId] of Object.entries(deptOf)) {
    await db
      .update(schema.employees)
      .set({
        departmentId: deptId,
        // 老闆沒有主管（申請自動核准的示範）；其他人直屬各自的部門主管
        managerEmployeeId:
          username === "lin.junhong"
            ? null
            : username === "chang.yating" || username === "huang.zhiwei"
              ? employeeIds.get("lin.junhong")!
              : employeeIds.get("huang.zhiwei")!,
        punchExempt: username === "lin.junhong", // 負責人免打卡
      })
      .where(eq(schema.employees.id, employeeIds.get(username)!));
  }
  const [dayShift] = await db
    .insert(schema.shifts)
    .values({ code: "D001", name: "日班", startTime: "09:00", endTime: "18:00", breaks: [{ start: "12:00", end: "13:00" }] })
    .returning();
  await db
    .insert(schema.shifts)
    .values({ code: "N001", name: "晚班", color: "#7c3aed", startTime: "15:00", endTime: "00:00", dayCutoff: "04:00" });
  // 這兩週的平日排班（週一至週五）——用既有的 daysBefore 往回排 10 個工作天
  for (const username of ["chang.yating", "wu.jianliang", "tsai.peishan"]) {
    for (let i = 0; i < 14; i++) {
      const d = daysBefore(today, i);
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      await db.insert(schema.schedules).values({ employeeId: employeeIds.get(username)!, workDate: d, shiftId: dayShift!.id });
    }
  }
  // 特休額度（示範值：時數是捏造的，不是任何年資的法定天數）
  const [annualType] = await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.code, "annual"));
  const demoYear = Number(today.slice(0, 4));
  for (const username of ["chang.yating", "huang.zhiwei", "wu.jianliang", "tsai.peishan"]) {
    await db.insert(schema.leaveBalances).values({
      employeeId: employeeIds.get(username)!,
      leaveTypeId: annualType!.id,
      year: demoYear,
      grantedMinutes: 80 * 60,
      note: "示範額度（時數捏造，請依實際年資自查對照表）",
      updatedBy: adminId,
    });
  }
  // 一張簽核中的請假單：蔡佩珊請特休 → 待黃志偉（直屬主管）簽 → 林俊宏（上級部門主管）
  const [demoLeave] = await db
    .insert(schema.hrRequests)
    .values({
      kind: "leave",
      employeeId: employeeIds.get("tsai.peishan")!,
      status: "pending",
      reason: "家中有事（示範資料）",
      leaveTypeId: annualType!.id,
      startAt: new Date(`${daysBefore(today, -3)}T09:00:00+08:00`),
      endAt: new Date(`${daysBefore(today, -3)}T18:00:00+08:00`),
      minutes: 480,
    })
    .returning();
  await db.insert(schema.hrRequestSteps).values([
    { requestId: demoLeave!.id, stepNo: 1, approverEmployeeId: employeeIds.get("huang.zhiwei")!, status: "pending" },
    { requestId: demoLeave!.id, stepNo: 2, approverEmployeeId: employeeIds.get("lin.junhong")!, status: "waiting" },
  ]);
  notes.push("HR 示範：黃志偉登入後「出勤打卡」頁有一張待簽的請假單；薪資頁刻意留白（倍率與勞健保金額請自填）。");

  return buildResult();

  function buildResult(): SeedDemoResult {
    Object.assign(counts, {
      partners: DEMO_PARTNERS.length,
      products: DEMO_PRODUCTS.length + DEMO_SERVICES.length,
      employees: DEMO_STAFF.length,
      users: DEMO_STAFF.length,
      contracts: contracts.length,
      invoiceTracks: tracks.length,
      withholdingCategories: seededCategories.length + 1,
      taxParameters: 3,
      departments: 2,
      shifts: 2,
      leaveBalances: 4,
      hrRequests: 1,
    });
    return {
      company: { name: company!.name, taxId: company!.taxId },
      logins: DEMO_STAFF.map((s) => ({ username: s.username, role: s.role, displayName: s.displayName })),
      password,
      counts,
      opening: {
        cash: openingCash,
        bank: openingBank,
        inventory: openingInventory,
        capital: openingCapital,
        retainedEarnings: openingRetained,
      },
      notes,
    };
  }
}

async function accountIdOf(db: Db, code: string): Promise<number | undefined> {
  const [row] = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.code, code));
  return row?.id;
}

/** YYYY-MM 的上一個月 */
function previousMonth(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** [from, to] 之間的每一個 YYYY-MM（含兩端）；from > to 時回空陣列 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  while (`${year}-${String(month).padStart(2, "0")}` <= to) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

// ── CLI 進入點 ────────────────────────────────────────────────────────
// 以檔案路徑比對而不是 import.meta.main：後者要 Node 24+，而本專案的 engines 是 >=22。
// pathToFileURL 而不是字串拼 `file://`：路徑含空白或中文時手拼會生出一個對不上的 URL，
// 症狀是「直接執行卻什麼都沒發生」——沒有錯誤、沒有輸出，最難查的那種。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pgModule = await import("pg");
  const { resolveDatabaseUrl } = await import("../src/db-url.ts");
  const { warnIfPiiUnprotected } = await import("../src/services/pii.ts");

  warnIfPiiUnprotected();
  const pool = new pgModule.default.Pool({ connectionString: resolveDatabaseUrl() });
  const db = drizzle(pool);
  try {
    const result = await seedDemoCompany(db, { force: process.argv.includes("--force") });
    console.log(`示範資料已灌入：${result.company.name}（統編 ${result.company.taxId}）`);
    console.log(
      `  ${Object.entries(result.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}`,
    );
    console.log(`  期初：現金 ${result.opening.cash}／銀行 ${result.opening.bank}／存貨 ${result.opening.inventory}`);
    console.log(`  登入密碼（全部帳號共用）：${result.password}`);
    for (const l of result.logins) console.log(`    ${l.username.padEnd(16)} ${l.role.padEnd(11)} ${l.displayName}`);
    if (result.notes.length) {
      console.log("  系統提示：");
      for (const n of result.notes) console.log(`    - ${n}`);
    }
    console.log("⚠️ 示範資料的每一個數字（含統編、身分證號、稅率、扣繳費率）都是捏造的，不得當正式帳使用。");
  } finally {
    await pool.end();
  }
}
