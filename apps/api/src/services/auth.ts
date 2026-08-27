/**
 * 登入認證＋薄權限層（角色化流程第一批）。
 * - 密碼：node:crypto scrypt（無外部依賴），格式 s2$<salt b64url>$<hash b64url>
 * - session：隨機 token 存 DB，cookie HttpOnly；30 天到期，查詢時順手清過期
 * - 權限：角色 → 頁面（@tw-erp/core ROLE_PAGES 單一事實來源），API 路由對應到頁面後查表；
 *   gm 一律唯讀（GET）；報銷是例外——每個角色都能替自己報銷
 * - 首次啟動：users 為空時開放 /auth/setup 建第一個 admin，之後永久關閉
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { canAccessPage, type PageKey, type Role } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { decryptPii, encryptPii } from "./pii.ts";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp.ts";

const SESSION_DAYS = 30;

// --- 登入節流（滑動視窗；設計理由見 migrations/0017_login_throttle.sql）---
const THROTTLE_WINDOW_MIN = 15;
/** 同一帳號：盯著一個人猜密碼，門檻要緊 */
const MAX_FAILURES_PER_USER = 5;
/** 同一來源：拿常見密碼掃過所有帳號。門檻鬆是因為整間公司可能共用一個對外 IP */
const MAX_FAILURES_PER_SOURCE = 30;

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  employeeId: number | null;
  /** 前端據此決定設定頁顯示「啟用」還是「已啟用／關閉」 */
  totpEnabled: boolean;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `s2$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [tag, saltB64, hashB64] = stored.split("$");
  if (tag !== "s2" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

function toAuthUser(u: typeof schema.users.$inferSelect): AuthUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    employeeId: u.employeeId,
    totpEnabled: u.totpEnabledAt !== null,
  };
}

export async function needsSetup(db: Db): Promise<boolean> {
  const rows = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  return rows.length === 0;
}

export async function createSession(db: Db, userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.sessions).values({ token, userId, expiresAt });
  return token;
}

/**
 * 這個桶在視窗內失敗幾次、最舊的一次是什麼時候。
 * `column = value` 而不是 `IN`：兩個桶的索引形狀都是 (key, at)。
 */
async function bucketState(
  db: Db,
  column: typeof schema.loginFailures.username | typeof schema.loginFailures.source,
  value: string,
  since: Date,
): Promise<{ count: number; oldest: Date | null }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${schema.loginFailures.at})`,
    })
    .from(schema.loginFailures)
    .where(and(eq(column, value), gte(schema.loginFailures.at, since)));
  return { count: row?.count ?? 0, oldest: row?.oldest ? new Date(row.oldest) : null };
}

/**
 * 節流檢查。擋下時丟 429，訊息只講「太多次、等多久」——
 * 不論帳號存不存在都是同一句，否則節流本身會變成帳號列舉的管道。
 *
 * 「還要等多久」用視窗內**最舊**那一次算，所以是下限（失敗次數超過門檻很多時，
 * 最舊那次退出視窗後可能仍在門檻上）。訊息因此寫「約」，不寫死一個保證解鎖的時間點——
 * 給不到的保證不要給。
 */
async function assertNotThrottled(db: Db, username: string, source: string): Promise<void> {
  const now = Date.now();
  const since = new Date(now - THROTTLE_WINDOW_MIN * 60 * 1000);
  // 視窗外的列對計數與稽核都沒有用，查詢時順手刪（與 sessionUser 清過期 session 同一個做法）
  await db.delete(schema.loginFailures).where(lt(schema.loginFailures.at, since));

  const checks: Array<{ state: { count: number; oldest: Date | null }; max: number }> = [
    { state: await bucketState(db, schema.loginFailures.username, username, since), max: MAX_FAILURES_PER_USER },
  ];
  // 空字串＝來源不明。跳過而不是當成一個桶——把所有來源不明的請求算在一起，
  // 等於「有一個人被擋，其他所有來源不明的人一起被擋」
  if (source) {
    checks.push({
      state: await bucketState(db, schema.loginFailures.source, source, since),
      max: MAX_FAILURES_PER_SOURCE,
    });
  }

  for (const { state, max } of checks) {
    if (state.count < max || !state.oldest) continue;
    const waitMs = state.oldest.getTime() + THROTTLE_WINDOW_MIN * 60 * 1000 - now;
    const waitMin = Math.max(1, Math.ceil(waitMs / 60000));
    throw new AppError(429, `登入失敗次數過多，請約 ${waitMin} 分鐘後再試`);
  }
}

/**
 * 「密碼對了，但還需要驗證碼」。用一個帶旗標的錯誤而不是特殊的 200 回應，
 * 是為了讓前端與程式化存取都不必去分辨「這個 200 到底算不算登入成功」——
 * 沒拿到 session 就是沒登入，狀態碼應該一致地說這件事。
 */
export class TotpRequiredError extends AppError {
  readonly totpRequired = true;
  constructor(message: string) {
    super(401, message);
  }
}

export async function login(
  db: Db,
  username: string,
  password: string,
  source = "",
  totpCode?: string | undefined,
) {
  await assertNotThrottled(db, username, source);
  const fail = async (status: number, message: string): Promise<never> => {
    await db.insert(schema.loginFailures).values({ username, source });
    throw new AppError(status, message);
  };

  const [user] = await db.select().from(schema.users).where(eq(schema.users.username, username));
  // 帳號不存在時也跑一次雜湊，避免時間差洩漏帳號存在與否
  if (!user) {
    verifyPassword(password, hashPassword("dummy"));
    return fail(401, "帳號或密碼錯誤");
  }
  if (!verifyPassword(password, user.passwordHash)) return fail(401, "帳號或密碼錯誤");
  // 停用不計入節流：密碼是對的，這不是猜測。計進去只會讓被停用者的同事一起被拖累
  if (!user.active) throw new AppError(403, "帳號已停用");

  if (user.totpEnabledAt) {
    if (!totpCode) {
      // 這一步不計入節流：使用者只是還沒填驗證碼，不是在猜。計進去的話，
      // 每次正常登入都會先吃一次失敗，五次之後自己把自己鎖住
      throw new TotpRequiredError("請輸入驗證器 app 的 6 位數驗證碼（或一組備援碼）");
    }
    if (!(await consumeSecondFactor(db, user, totpCode))) {
      return fail(401, "驗證碼不正確或已過期");
    }
  }

  // 成功即清掉這個帳號的失敗紀錄。刻意**不清 source 桶**——攻擊者用自己的帳號登入一次
  // 就能歸零掃描計數的話，來源門檻等於不存在
  await db.delete(schema.loginFailures).where(eq(schema.loginFailures.username, username));
  const token = await createSession(db, user.id);
  return { token, user: toAuthUser(user) };
}

/**
 * 第二因子的比對：先試 TOTP，不過再試備援碼。
 * 備援碼比對後**立刻標記用掉**（單次有效）；用掉不刪除，留著才知道還剩幾組。
 */
async function consumeSecondFactor(
  db: Db,
  user: typeof schema.users.$inferSelect,
  input: string,
): Promise<boolean> {
  const secret = decryptPii(user.totpSecret);
  if (secret && verifyTotp(secret, input)) return true;

  const normalized = normalizeRecoveryCode(input);
  // 六位純數字不可能是備援碼（備援碼是 16 碼 base32），不必為打錯的 TOTP 去掃備援碼表
  if (/^\d{6}$/.test(normalized)) return false;

  const codes = await db
    .select()
    .from(schema.totpRecoveryCodes)
    .where(and(eq(schema.totpRecoveryCodes.userId, user.id), isNull(schema.totpRecoveryCodes.usedAt)));
  for (const row of codes) {
    if (!verifyPassword(normalized, row.codeHash)) continue;
    await db
      .update(schema.totpRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(eq(schema.totpRecoveryCodes.id, row.id));
    return true;
  }
  return false;
}

/** 還沒用掉的備援碼剩幾組（畫面要提醒使用者快用完了） */
export async function unusedRecoveryCount(db: Db, userId: number): Promise<number> {
  const rows = await db
    .select({ id: schema.totpRecoveryCodes.id })
    .from(schema.totpRecoveryCodes)
    .where(and(eq(schema.totpRecoveryCodes.userId, userId), isNull(schema.totpRecoveryCodes.usedAt)));
  return rows.length;
}

/**
 * 產生密鑰但**尚未啟用**——啟用要等使用者拿驗證器 app 算出一次正確的碼（enableTotp）。
 * 先驗證再啟用是必要的：不驗就啟用，等於讓「掃描失敗但沒發現」的人下次直接進不來。
 *
 * 新密鑰寫在 totpPendingSecret，**已生效的 totpSecret 一個位元都不動**（見 migration 0020）：
 * 換手機時按了重新設定卻中途放棄，原本會讓帳號靜默掉回單因子，而畫面零徵兆。
 *
 * 已經啟用的人要重新設定必須重新輸入密碼：重新設定的效果與「關閉再重開」完全相同，
 * 而關閉已經要求密碼了。不要求的話，拿到一個沒鎖螢幕的瀏覽器就能把第二因子換成自己的手機。
 */
export async function beginTotpSetup(
  db: Db,
  user: AuthUser,
  password?: string | undefined,
): Promise<{ secret: string; uri: string }> {
  if (user.totpEnabled) {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
    if (!password || !row || !verifyPassword(password, row.passwordHash)) {
      throw new AppError(401, "重新設定二階段驗證需要再輸入一次密碼");
    }
  }
  const secret = generateTotpSecret();
  await db
    .update(schema.users)
    .set({ totpPendingSecret: encryptPii(secret) ?? null })
    .where(eq(schema.users.id, user.id));
  return { secret, uri: otpauthUri(secret, user.username) };
}

/** 驗證一次驗證碼後正式啟用，並發一組備援碼（只在這一刻回傳明文，之後只存雜湊） */
export async function enableTotp(db: Db, userId: number, code: string): Promise<string[]> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const secret = decryptPii(row?.totpPendingSecret ?? null);
  if (!secret) throw new AppError(409, "尚未產生密鑰，請先重新開始設定");
  if (!verifyTotp(secret, code)) {
    throw new AppError(
      400,
      "驗證碼不正確。請確認手機時間是自動校時的——時鐘差超過一分鐘就會一直對不上",
    );
  }
  // 驗證通過的這一刻才換掉生效中的密鑰，並清掉設定中的狀態
  await db
    .update(schema.users)
    .set({ totpSecret: row!.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: new Date() })
    .where(eq(schema.users.id, userId));
  // 重新啟用時把舊的備援碼一併作廢：留著等於留下一組沒有人記得存在哪裡的鑰匙
  await db.delete(schema.totpRecoveryCodes).where(eq(schema.totpRecoveryCodes.userId, userId));
  const codes = generateRecoveryCodes();
  await db.insert(schema.totpRecoveryCodes).values(
    codes.map((c) => ({ userId, codeHash: hashPassword(normalizeRecoveryCode(c)) })),
  );
  return codes;
}

/**
 * 關閉二階段驗證。**要求重新輸入密碼**——關閉是降低安全性的動作，
 * 而它最可能發生在「有人拿到了一個沒鎖螢幕的瀏覽器」的時候。
 */
export async function disableTotp(db: Db, userId: number, password: string): Promise<void> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!row) throw new AppError(404, "使用者不存在");
  if (!verifyPassword(password, row.passwordHash)) throw new AppError(401, "密碼不正確");
  await db
    .update(schema.users)
    .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null })
    .where(eq(schema.users.id, userId));
  await db.delete(schema.totpRecoveryCodes).where(eq(schema.totpRecoveryCodes.userId, userId));
}

export async function setup(db: Db, input: { username: string; displayName: string; password: string }) {
  if (!(await needsSetup(db))) throw new AppError(409, "系統已完成初始設定");
  const [user] = await db
    .insert(schema.users)
    .values({
      username: input.username,
      displayName: input.displayName,
      passwordHash: hashPassword(input.password),
      role: "admin",
    })
    .returning();
  const token = await createSession(db, user!.id);
  return { token, user: toAuthUser(user!) };
}

export async function sessionUser(db: Db, token: string): Promise<AuthUser | null> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  const [row] = await db
    .select({ user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.token, token), eq(schema.users.active, true)));
  return row ? toAuthUser(row.user) : null;
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
}

export async function deleteUserSessions(db: Db, userId: number): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

// --- 路由 → 頁面對應（薄權限：進得了頁面就打得了該頁的 API）---

interface Rule {
  pattern: RegExp;
  methods?: string[]; // 未指定 = 全部
  access: "any" | { page: PageKey } | { roles: Role[] };
}

/** 依序比對，第一條命中生效 */
const RULES: Rule[] = [
  // 參考資料：各頁下拉選單都要，任何已登入者可讀
  {
    pattern: /^\/(partners|products|accounts|employees|expense-categories|company-profile)$/,
    methods: ["GET"],
    access: "any",
  },
  // 個人的身分證號是 PII，只有真正要填年度憑單的人需要看到：限財務／管理者。
  // 這條必須排在下面 /partners 的 masters 頁規則之前——masters 頁業務與採購也有，
  // 他們不該讀得到房東的身分證號（單筆專用端點，也刻意不進任何清單 API）。
  { pattern: /^\/partners\/\d+\/id-no$/, access: { roles: ["finance", "admin"] } },
  // 401 申報人的身分證號同一條紀律（0024）：GET /company-profile 是任何已登入者可讀的參考資料，
  // 明文只走這個單獨端點。必須排在最上面「參考資料」規則之後、settings 頁規則之前都可以——
  // 參考資料那條的 pattern 是完全比對（$ 結尾），不會吃到這個子路徑
  { pattern: /^\/company-profile\/filer-id-no$/, access: { roles: ["finance", "admin"] } },
  // 報銷審核動作：財務限定（void 是 0036 的作廢入口，與其他單據的作廢同層級——
  // 反向傳票直接動總帳與 401，不能讓「每個角色都能報銷」的通則順手放行）
  { pattern: /^\/expense-claims\/\d+\/(approve|reject|pay|void)$/, access: { roles: ["finance", "admin"] } },
  // 作廢（0025，B4；0030 補退回折讓單）：更正機制不是日常操作——反向傳票直接動總帳、
  // 彙總與 401 隨之改變，一律限財務／管理者。必須排在下面各單據的頁面規則之前，
  // 否則 sales/purchasing 角色會經頁面規則（看得到銷貨頁＝打得了銷貨 API）順手拿到作廢權。
  // 期初單的作廢隨 /opening-balances 整組規則（本來就限 finance/admin），不必列在這裡
  {
    pattern:
      /^\/(sales|sales-returns|purchases|purchase-returns|quotes|cash-docs|journal-entries|withholding-payments)\/\d+\/void$/,
    access: { roles: ["finance", "admin"] },
  },
  // 扣繳（付個人的租金／專業服務費）：類別設定與支出單同一頁權限（ROLE_PAGES 只開給 admin/finance）。
  // 不補這條會落到最後的 fallback「未列出的路由一律當管理頁看待」→ 財務會吃 403，而畫面上看得到這頁
  { pattern: /^\/withholding-(payments|categories)(\/|$)/, access: { page: "withholding" } },
  // 稅法參數：填錯會改變之後每一張單的稅額，所以與「會計科目」同一個層級——限 admin/finance
  // （ROLE_PAGES 裡只有這兩個角色拿到全部 PAGE_KEYS）。不補這條會落到最後的 fallback
  // 「未列出的路由一律當管理頁看待」→ 財務會吃 403，而畫面上看得到這頁
  { pattern: /^\/tax-parameters(\/|$)/, access: { page: "tax-parameters" } },
  // 期初應收付（0023，B6）：動的是導入期的帳務基礎（直接拋轉權益科目），
  // 與稅法參數同層級——限 admin/finance（畫面在設定頁，而設定頁本來就只有這兩個角色看得到）
  { pattern: /^\/opening-balances(\/|$)/, access: { roles: ["finance", "admin"] } },
  // 賣方統編 → 歷史分類候選（W7，唯讀）。與報銷本體同一條理由：每個角色都要替自己報銷，
  // 而這是報銷填單畫面上的輔助——不列在這裡會落到最後的 fallback「未列出的路由一律當管理頁」，
  // 財務與一般員工吃 403，而畫面上那個功能看得到。
  // 為什麼不比照 payable-summary 收緊到財務：那支回的是「公司欠誰多少錢」（人名＋金額），
  // 這支只回分類代號、標籤與次數——沒有金額、沒有報銷人、沒有單號，看得出來的只有
  // 「這家店大家通常記哪一類」，而那正是要給填單的人看的東西。
  // 限 GET：這個路徑之後若長出寫入動作，要自己重新爭取權限，不該搭這條的便車。
  { pattern: /^\/expense-categories\/suggestions$/, methods: ["GET"], access: "any" },
  // 報銷本體：所有角色（本人限定在路由層處理）
  { pattern: /^\/expense-claims(\/|$)/, access: "any" },
  // 出勤（0039）：打卡與「我的出勤」人人可用（本人限定在路由層——身分取自 session，
  // 不收 employeeId 參數）；設定與管理面走 hr 頁
  { pattern: /^\/attendance\/(punch|my|my-balances)$/, access: "any" },
  { pattern: /^\/attendance(\/|$)/, access: { page: "hr" } },
  // 部門與班別的讀取開放全員（打卡頁要顯示自己的班；報銷等頁的下拉未來也會用）；
  // 寫入限 hr 頁（admin/finance）
  { pattern: /^\/(departments|shifts)(\/|$)/, methods: ["GET"], access: "any" },
  { pattern: /^\/(departments|shifts|schedules)(\/|$)/, access: { page: "hr" } },
  // 假別與行事曆的讀取開放全員（申請單的下拉要用）；維護限 hr 頁
  { pattern: /^\/(leave-types|calendar-days)(\/|$)/, methods: ["GET"], access: "any" },
  { pattern: /^\/(leave-types|leave-balances|calendar-days)(\/|$)/, access: { page: "hr" } },
  // 申請單（0040）：自己的單與待我簽核人人可用；全公司總覽限 hr 頁。
  // 建立／簽核／取消是 POST 開放給所有角色（含 gm——"any" 不受總經理唯讀限制），
  // 「只能建自己的、只有當關簽核人能簽、只能取消自己的」在服務層驗
  { pattern: /^\/hr-requests\/(my|pending-approvals)$/, access: "any" },
  { pattern: /^\/hr-requests$/, methods: ["GET"], access: { page: "hr" } },
  { pattern: /^\/hr-requests(\/|$)/, access: "any" },
  // 薪資（0041）：薪資檔／加班費率／發薪作業，一律 payroll 頁（admin/finance）——
  // 不補這條會落到最後的 fallback「未列出的路由一律當管理頁」→ 財務吃 403 而畫面看得到這頁
  { pattern: /^\/(employee-salaries|overtime-rates|payroll-runs|payroll-items)(\/|$)/, access: { page: "payroll" } },
  // 內建助理：人人可聊（gm 也是——"any" 不受唯讀限制；工具執行時的每一個內部請求
  // 仍以本人身分走一次 ACL，看不到的照樣 403）。金鑰只在伺服端使用，永不下發
  { pattern: /^\/agent\/chat$/, access: "any" },
  // 使用者管理：admin 限定
  { pattern: /^\/users(\/|$)/, access: { roles: ["admin"] } },
  // 操作日誌：admin 限定，而且刻意**不**做成 PAGE_KEY——ROLE_PAGES 裡 admin 與 finance
  // 都是整包 PAGE_KEYS，新增一個 key 等於同時發給財務。而日誌是對包含財務在內的
  // 所有人的問責紀錄，看得到全公司每一個動作，權限層級應該與使用者管理相同。
  { pattern: /^\/audit-logs(\/|$)/, access: { roles: ["admin"] } },
  // Agent 接入：API 金鑰等於一個可以呼叫全系統的身分，LLM 設定裡有一把會計費的憑證。
  // 兩者都與使用者管理同一層級——能發金鑰就等於能發帳號。
  // agent-memories 同層級：記憶會注入**每個人**的 agent 對話，核准權＝對全員 agent 行為的管理權
  { pattern: /^\/(api-keys|agent-settings|agent-memories)(\/|$)/, access: { roles: ["admin"] } },
  // 退回／退出掛在來源單據的頁面權限下（退貨永遠源自某張原單，看得到原單才退得了它）。
  // 另立規則是因為 /purchase-returns、/sales-returns 的連字號不會被下面的 /purchases、/sales 規則命中
  { pattern: /^\/purchase-returns(\/|$)/, access: { page: "purchases" } },
  { pattern: /^\/sales-returns(\/|$)/, access: { page: "sales" } },
  { pattern: /^\/(purchases|purchase-orders)(\/|$)/, access: { page: "purchases" } },
  { pattern: /^\/(quotes|orders)(\/|$)/, access: { page: "orders" } },
  { pattern: /^\/reports\/ar-aging$/, access: { page: "sales" } }, // 業務要催款，掛銷貨頁而非報表頁
  { pattern: /^\/reports\/ap-aging$/, access: { page: "purchases" } }, // 排付款看的是進貨視角，與 ar-aging 對稱
  { pattern: /^\/reports\/dashboard$/, access: { roles: ["gm", "finance", "admin"] } }, // 經營數字（現金/毛利）不對業務採購開放
  { pattern: /^\/sales\/\d+\/invoice$/, access: { page: "invoices" } },
  { pattern: /^\/sales(\/|$)/, access: { page: "sales" } },
  { pattern: /^\/(invoices|invoice-tracks)(\/|$)/, access: { page: "invoices" } },
  { pattern: /^\/(inventory|trial-balance)$/, methods: ["GET"], access: { page: "dashboard" } },
  // 庫存異動明細帳（R9，0035）：唯讀，與 /inventory 同權限——看得到在庫量的人就查得了它怎麼來的
  { pattern: /^\/inventory\/movements$/, methods: ["GET"], access: { page: "dashboard" } },
  { pattern: /^\/inventory\/opening$/, access: { page: "journal" } },
  // 庫存調整（0026，B8）：盤盈盤虧報廢直接動存貨科目與損益（含作廢子路徑 /:id/void），
  // 與作廢層同一層級——限財務／管理者。盤點底稿（GET）也在這條下：底稿含帳面量與成本結構，
  // 而會實際送出調整的人本來就是這兩個角色
  { pattern: /^\/inventory\/(adjustments|stocktake)(\/|$)/, access: { roles: ["finance", "admin"] } },
  // 處分發票（0034）與銷貨開票同權限頁：開的是對外憑證，不是資產操作。
  // 要放在 fixed-assets 通則之前（先命中者贏）
  { pattern: /^\/fixed-assets\/\d+\/invoice$/, access: { page: "invoices" } },
  { pattern: /^\/(fixed-assets|asset-categories|depreciations)(\/|$)/, access: { page: "assets" } },
  { pattern: /^\/journal-entries(\/|$)/, access: { page: "journal" } },
  // 對象餘額（唯讀）：銷貨開單畫面要顯示「該客戶未收餘額 vs 信用額度」的提示，
  // 所以放寬到 sales 頁（業務看得到餘額才有提示的意義）；cash 頁的使用者（admin/finance）本來就有 sales 頁
  { pattern: /^\/partner-balances$/, methods: ["GET"], access: { page: "sales" } },
  // 含 GET /cash-docs/:id（R6 沖銷明細）與 /cash-docs/:id/apply-prepaid——子路徑都吃這條
  { pattern: /^\/(cash-docs|partner-balances|open-documents)(\/|$)/, access: { page: "cash" } },
  { pattern: /^\/reports(\/|$)/, access: { page: "reports" } },
  { pattern: /^\/(period-closes|year-closes)(\/|$)/, access: { page: "reports" } },
  { pattern: /^\/vat-returns(\/|$)/, access: { page: "vat" } },
  { pattern: /^\/exports(\/|$)/, access: { page: "exports" } },
  // 合約拆讀寫（R21）：合約是業務談下來的、採購跟供應商簽的，唯讀開放給他們
  // （ROLE_PAGES 的 sales/purchasing 已補 contracts 頁，到期橫幅才輪得到最該看到的人）；
  // 寫入維持 admin/finance——金額與狀態是財務數字的依據，簽核歸口不變
  { pattern: /^\/contracts(\/|$)/, methods: ["GET"], access: { page: "contracts" } },
  { pattern: /^\/contracts(\/|$)/, access: { roles: ["finance", "admin"] } },
  // 週期性支出（0047）：讀寫都限 recurring 頁（＝admin/finance）——這頁的金額含勞健保與稅款，
  // 不像合約有「該給談單的人看到期日」的理由，所以不拆讀寫
  { pattern: /^\/recurring-payables(\/|$)/, access: { page: "recurring" } },
  // 員工主檔寫入（R21）：從 masters 頁拆出來限 admin/finance——masters 開給 sales/purchasing
  // 是為了建客戶建商品，不該順手就能新增員工（建了之後同名可無限增生，還進報銷申請人名單）。
  // GET 不在此列：最上面的參考資料規則放行 /employees 清單（報銷與業務負責人下拉都要）
  { pattern: /^\/employees(\/|$)/, methods: ["POST", "PATCH", "PUT", "DELETE"], access: { roles: ["finance", "admin"] } },
  // 主檔寫入與公司設定
  { pattern: /^\/(partners|products|employees)(\/|$)/, access: { page: "masters" } },
  // 科目維護：GET 已被最上面的參考資料規則放行，這條只會攔到寫入（accounts 頁＝admin/finance）
  { pattern: /^\/accounts(\/|$)/, access: { page: "accounts" } },
  { pattern: /^\/company-profile$/, access: { page: "settings" } },
];

/** 回傳 null = 允許；否則為 403 訊息 */
export function authorize(role: Role, method: string, path: string): string | null {
  for (const rule of RULES) {
    if (!rule.pattern.test(path)) continue;
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (rule.access === "any") return null;
    if ("roles" in rule.access) {
      return rule.access.roles.includes(role) ? null : "此操作需要財務或管理者權限";
    }
    if (!canAccessPage(role, rule.access.page)) return "無此頁面的存取權限";
    // gm 全面唯讀（報銷例外已在前面的規則放行）
    if (role === "gm" && method !== "GET") return "總經理帳號為唯讀";
    return null;
  }
  // 未列出的路由一律當管理頁看待，避免新路由忘了設權限而全開
  return role === "admin" ? null : "無此頁面的存取權限";
}
