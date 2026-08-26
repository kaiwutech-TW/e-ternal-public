/**
 * 二階段驗證的登入流程驗收（公網部署前的安全批次，最後一項）。
 *
 * 演算法本身的正確性由 totp.test.ts 對 RFC 6238 官方向量把關；
 * 這個檔案管的是**流程**：先驗再啟用、備援碼單次有效、關閉要重新輸入密碼、
 * 密鑰不得離開資料庫，以及「等著輸入驗證碼」不可以把使用者自己鎖住。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, schema } from "@tw-erp/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { totpCodeAt } from "../src/services/totp.ts";
import { setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof drizzle>;
let admin: Record<string, string>;

async function api(path: string, headers: Record<string, string>, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, setCookie: res.headers.get("set-cookie") };
}

const tryLogin = (username: string, password: string, totpCode?: string) =>
  api("/auth/login", {}, { username, password, ...(totpCode ? { totpCode } : {}) });

/** 現在這一刻的正確驗證碼 */
const codeNow = (secret: string) => totpCodeAt(secret, Math.floor(Date.now() / 1000 / 30));

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  app = buildApp(db);
  admin = await setupAdmin(app);
});

describe("啟用流程", () => {
  let secret: string;

  it("產生密鑰後**還沒生效**——沒驗證通過之前，登入不該多要一道", async () => {
    const setup = await api("/auth/totp/setup", admin, {});
    expect(setup.status).toBe(200);
    secret = setup.json.secret;
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.json.uri).toContain("otpauth://totp/");
    expect((await tryLogin("admin", "secret-test")).status).toBe(200);
  });

  it("驗證碼錯誤時不啟用，訊息要指向真正的常見原因（手機沒自動校時）", async () => {
    const bad = await api("/auth/totp/enable", admin, { code: "000000" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("自動校時");
    expect((await tryLogin("admin", "secret-test")).status).toBe(200); // 仍未生效
  });

  it("驗證通過才啟用，並在**這一刻唯一一次**回傳十組備援碼", async () => {
    const ok = await api("/auth/totp/enable", admin, { code: codeNow(secret) });
    expect(ok.status).toBe(200);
    expect(ok.json.recoveryCodes).toHaveLength(10);
    expect((await api("/auth/totp", admin)).json).toEqual({ enabled: true, recoveryCodesLeft: 10 });
    // 再問一次也拿不到明文——資料庫只有雜湊
    expect(JSON.stringify((await api("/auth/totp", admin)).json)).not.toContain(ok.json.recoveryCodes[0]);
  });

  it("啟用後：只給密碼會被要求驗證碼，補上正確驗證碼才拿得到 session", async () => {
    const first = await tryLogin("admin", "secret-test");
    expect(first.status).toBe(401);
    expect(first.json.totpRequired).toBe(true); // 前端據此長出驗證碼欄位
    expect(first.setCookie).toBeNull();

    const wrong = await tryLogin("admin", "secret-test", "000000");
    expect(wrong.status).toBe(401);

    const good = await tryLogin("admin", "secret-test", codeNow(secret));
    expect(good.status).toBe(200);
    expect(good.setCookie).toContain("sid=");
  });

  it("密碼錯就是密碼錯，不會先問驗證碼（問了等於告訴對方密碼猜對沒）", async () => {
    const res = await tryLogin("admin", "wrong-password", codeNow(secret));
    expect(res.status).toBe(401);
    expect(res.json.totpRequired).toBeUndefined();
  });

  it("「還沒填驗證碼」不計入登入節流——否則每次正常登入都先吃一次失敗，五次就自己鎖死自己", async () => {
    for (let i = 0; i < 8; i++) expect((await tryLogin("admin", "secret-test")).status).toBe(401);
    // 節流若被觸發這裡會是 429
    expect((await tryLogin("admin", "secret-test", codeNow(secret))).status).toBe(200);
  });
});

/**
 * 對抗驗證抓到的實作缺陷（migration 0020 修的那一個）。留成測試是因為它
 * **在畫面上與登入流程裡都沒有任何徵兆**——不寫下來的話，重構時會再犯一次。
 */
describe("重新設定的中途狀態", () => {
  let active: string;

  beforeAll(async () => {
    // 上一個 describe 結束時 admin 已經是啟用狀態，所以這裡就得帶密碼（正是本節要測的規則）
    active = (await api("/auth/totp/setup", admin, { password: "secret-test" })).json.secret;
    await api("/auth/totp/enable", admin, { code: codeNow(active) });
  });

  it("已啟用時重新設定要重新輸入密碼（否則拿到沒鎖螢幕的瀏覽器就能換掉第二因子）", async () => {
    expect((await api("/auth/totp/setup", admin, {})).status).toBe(401);
    expect((await api("/auth/totp/setup", admin, { password: "wrong" })).status).toBe(401);
    expect((await api("/auth/totp/setup", admin, { password: "secret-test" })).status).toBe(200);
  });

  it("重新設定但沒驗證就放棄：二階段驗證仍然生效，而且**舊手機照樣能用**", async () => {
    await api("/auth/totp/setup", admin, { password: "secret-test" }); // 產生新密鑰後就此不管
    expect((await api("/auth/totp", admin)).json.enabled).toBe(true);
    expect((await tryLogin("admin", "secret-test")).status).toBe(401); // 仍然要驗證碼
    expect((await tryLogin("admin", "secret-test", codeNow(active))).status).toBe(200); // 舊密鑰仍有效
  });

  it("驗證通過的那一刻才換過去：新密鑰生效、舊密鑰失效", async () => {
    const next = (await api("/auth/totp/setup", admin, { password: "secret-test" })).json.secret;
    await api("/auth/totp/enable", admin, { code: codeNow(next) });
    expect((await tryLogin("admin", "secret-test", codeNow(next))).status).toBe(200);
    expect((await tryLogin("admin", "secret-test", codeNow(active))).status).toBe(401);
    active = next;
  });

  it("關閉後再重新啟用不需要密碼（此時已經沒有第二因子可以被換掉）", async () => {
    await api("/auth/totp/disable", admin, { password: "secret-test" });
    expect((await api("/auth/totp/setup", admin, {})).status).toBe(200);
  });
});

describe("備援碼", () => {
  let codes: string[];
  let secret: string;

  beforeAll(async () => {
    const setup = await api("/auth/totp/setup", admin, {});
    secret = setup.json.secret;
    codes = (await api("/auth/totp/enable", admin, { code: codeNow(secret) })).json.recoveryCodes;
  });

  it("一組備援碼可以代替驗證碼登入，用過即失效", async () => {
    const first = await tryLogin("admin", "secret-test", codes[0]!);
    expect(first.status).toBe(200);
    expect((await api("/auth/totp", admin)).json.recoveryCodesLeft).toBe(9);

    const reuse = await tryLogin("admin", "secret-test", codes[0]!);
    expect(reuse.status).toBe(401);
  });

  it("抄成小寫、去掉連字號都認得（要用到它的人正處在進不去系統的壓力下）", async () => {
    expect((await tryLogin("admin", "secret-test", codes[1]!.toLowerCase())).status).toBe(200);
    expect((await tryLogin("admin", "secret-test", codes[2]!.replace(/-/g, ""))).status).toBe(200);
  });

  it("重新設定會把舊的備援碼一起作廢（留著等於一組沒人記得放哪的鑰匙）", async () => {
    const fresh = await api("/auth/totp/setup", admin, { password: "secret-test" });
    const newCodes = (await api("/auth/totp/enable", admin, { code: codeNow(fresh.json.secret) })).json.recoveryCodes;
    expect((await tryLogin("admin", "secret-test", codes[3]!)).status).toBe(401);
    expect((await tryLogin("admin", "secret-test", newCodes[0]!)).status).toBe(200);
    secret = fresh.json.secret;
  });
});

describe("關閉與逃生門", () => {
  it("關閉要重新輸入密碼（最可能發生在有人拿到沒鎖螢幕的瀏覽器時）", async () => {
    const wrong = await api("/auth/totp/disable", admin, { password: "not-my-password" });
    expect(wrong.status).toBe(401);
    expect((await api("/auth/totp", admin)).json.enabled).toBe(true);

    expect((await api("/auth/totp/disable", admin, { password: "secret-test" })).status).toBe(200);
    expect((await api("/auth/totp", admin)).json.enabled).toBe(false);
    expect((await tryLogin("admin", "secret-test")).status).toBe(200); // 恢復單因子
  });

  it("管理者可以替同事關閉（手機掉了），但無法替人啟用——別人的密鑰只有他自己的手機掃得到", async () => {
    await api("/users", admin, { username: "bob", displayName: "巴布", password: "secret-test", role: "sales" });
    const bob = await api("/auth/login", {}, { username: "bob", password: "secret-test" });
    const bobCookie = { cookie: bob.setCookie!.split(";")[0]! };
    const s = (await api("/auth/totp/setup", bobCookie, {})).json.secret;
    await api("/auth/totp/enable", bobCookie, { code: codeNow(s) });
    expect((await api("/auth/login", {}, { username: "bob", password: "secret-test" })).status).toBe(401);

    const bobId = (await api("/users", admin)).json.find((u: { username: string }) => u.username === "bob").id;
    expect((await api(`/users/${bobId}`, admin, { totpEnabled: true }, "PATCH")).status).toBe(400);
    expect((await api(`/users/${bobId}`, admin, { totpEnabled: false }, "PATCH")).status).toBe(200);
    expect((await api("/auth/login", {}, { username: "bob", password: "secret-test" })).status).toBe(200);
  });
});

describe("密鑰不得離開資料庫", () => {
  it("使用者清單與 /auth/me 都不帶密鑰，只說有沒有啟用", async () => {
    const s = (await api("/auth/totp/setup", admin, {})).json.secret;
    await api("/auth/totp/enable", admin, { code: codeNow(s) });

    const dump = JSON.stringify((await api("/users", admin)).json) + JSON.stringify((await api("/auth/me", admin)).json);
    expect(dump).not.toContain(s);
    expect(dump).not.toContain("totpSecret");
    expect(dump).not.toContain("passwordHash");
    expect(dump).toContain("totpEnabled");
  });

  it("設了 PII_KEY 時，資料庫裡的密鑰是密文", async () => {
    process.env["PII_KEY"] = "totp-test-key-not-for-production";
    try {
      const s = (await api("/auth/totp/setup", admin, { password: "secret-test" })).json.secret;
      const pending = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
      expect(pending[0]!.totpPendingSecret).not.toBe(s);
      expect(pending[0]!.totpPendingSecret).toMatch(/^pii1\$/);

      // 而且還原得回來——啟用流程要走得完，且生效後的欄位同樣是密文
      expect((await api("/auth/totp/enable", admin, { code: codeNow(s) })).status).toBe(200);
      const active = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
      expect(active[0]!.totpSecret).toMatch(/^pii1\$/);
      expect(active[0]!.totpPendingSecret).toBeNull();
      expect((await tryLogin("admin", "secret-test", codeNow(s))).status).toBe(200);
    } finally {
      delete process.env["PII_KEY"];
    }
  });
});
