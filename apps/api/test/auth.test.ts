/**
 * 認證＋角色權限驗收：首次 setup（僅一次）→ 登入/登出 → 角色矩陣
 * （員工只能報銷、業務進不了進貨、總經理唯讀、admin 才能管使用者）→ 停用即斷線。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let empWang: number; // 員工主檔：王小明
let empLi: number; // 員工主檔：李小華

async function api(path: string, headers: Record<string, string>, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
});

describe("首次啟動 setup", () => {
  it("users 為空時 needsSetup=true，未登入其他 API 一律 401", async () => {
    const status = await api("/auth/setup-status", {});
    expect(status.json).toEqual({ needsSetup: true });
    const denied = await api("/partners", {});
    expect(denied.status).toBe(401);
  });

  it("setup 建立 admin 並自動登入；第二次 setup 被拒", async () => {
    admin = await setupAdmin(app);
    const me = await api("/auth/me", admin);
    expect(me.json.role).toBe("admin");
    expect((await api("/auth/setup-status", {})).json).toEqual({ needsSetup: false });
    const again = await app.request("/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "hacker", displayName: "x", password: "123456" }),
    });
    expect(again.status).toBe(409);
  });
});

describe("登入/登出", () => {
  it("錯誤密碼 401；正確登入後 /auth/me 可用；登出後失效", async () => {
    const bad = await api("/auth/login", {}, { username: "admin", password: "wrong-pass" });
    expect(bad.status).toBe(401);
    const session = await loginAs(app, "admin", "secret-test");
    expect((await api("/auth/me", session)).json.username).toBe("admin");
    await api("/auth/logout", session, {});
    expect((await api("/auth/me", session)).status).toBe(401);
  });
});

describe("角色矩陣", () => {
  const cookies: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    empWang = (await api("/employees", admin, { name: "王小明" })).json.id;
    empLi = (await api("/employees", admin, { name: "李小華" })).json.id;
    const defs = [
      { username: "fin", role: "finance" },
      { username: "sal", role: "sales" },
      { username: "pur", role: "purchasing" },
      { username: "boss", role: "gm" },
      { username: "wang", role: "employee", employeeId: empWang },
      { username: "li", role: "employee", employeeId: empLi },
      { username: "nolink", role: "employee" },
    ];
    for (const d of defs) {
      const res = await api("/users", admin, { ...d, displayName: d.username, password: "secret-test" });
      expect(res.status).toBe(201);
      cookies[d.username] = await loginAs(app, d.username, "secret-test");
    }
  });

  it("員工：只能報銷——參考資料可讀、傳票/銷貨/使用者管理 403", async () => {
    const w = cookies["wang"]!;
    expect((await api("/expense-categories", w)).status).toBe(200);
    expect((await api("/journal-entries", w)).status).toBe(403);
    expect((await api("/sales", w)).status).toBe(403);
    expect((await api("/users", w)).status).toBe(403);
  });

  it("員工報銷強制本人：即使送別人的 employeeId 也記在自己名下；未連結員工主檔則 422", async () => {
    const claim = await api("/expense-claims", cookies["wang"]!, {
      employeeId: empLi, // 惡意指定他人 → 伺服端覆蓋為本人
      claimDate: "2026-07-25",
      items: [{ accountCode: "6132", docType: "receipt", amount: 200, description: "郵資" }],
    });
    expect(claim.status).toBe(201);
    expect(claim.json.employeeId).toBe(empWang);

    const nolink = await api("/expense-claims", cookies["nolink"]!, {
      claimDate: "2026-07-25",
      items: [{ accountCode: "6132", docType: "receipt", amount: 100 }],
    });
    expect(nolink.status).toBe(422);
  });

  it("員工清單只見自己的報銷單；看他人單據 403；財務看得到全部", async () => {
    await api("/expense-claims", cookies["li"]!, {
      claimDate: "2026-07-25",
      items: [{ accountCode: "6132", docType: "receipt", amount: 300 }],
    });
    const wangList = (await api("/expense-claims", cookies["wang"]!)).json;
    expect(wangList).toHaveLength(1);
    expect(wangList[0].employeeId).toBe(empWang);

    const liClaimId = (await api("/expense-claims", cookies["li"]!)).json[0].id;
    expect((await api(`/expense-claims/${liClaimId}`, cookies["wang"]!)).status).toBe(403);
    expect((await api("/expense-claims", cookies["fin"]!)).json.length).toBeGreaterThanOrEqual(2);
  });

  it("業務：可建主檔與銷貨頁、進不了進貨頁、不能核准報銷", async () => {
    const s = cookies["sal"]!;
    expect((await api("/partners", s, { name: "業務開的客戶", isCustomer: true })).status).toBe(201);
    expect((await api("/sales", s)).status).toBe(200);
    expect((await api("/purchases", s)).status).toBe(403);
    const claimId = (await api("/expense-claims", cookies["fin"]!)).json[0].id;
    expect((await api(`/expense-claims/${claimId}/approve`, s, {})).status).toBe(403);
  });

  it("採購：進貨頁可用、銷貨頁 403", async () => {
    const p = cookies["pur"]!;
    expect((await api("/purchases", p)).status).toBe(200);
    expect((await api("/sales", p)).status).toBe(403);
  });

  it("總經理：報表/銷貨/進貨可讀，但一律唯讀；傳票頁無權限", async () => {
    const g = cookies["boss"]!;
    expect((await api("/reports/balance-sheet?asOf=2026-07-25", g)).status).toBe(200);
    expect((await api("/sales", g)).status).toBe(200);
    expect((await api("/partners", g, { name: "gm 想開客戶", isCustomer: true })).status).toBe(403);
    expect((await api("/journal-entries", g)).status).toBe(403);
  });

  it("財務：可核准報銷、可產 401、不能管使用者", async () => {
    const f = cookies["fin"]!;
    const claimId = (await api("/expense-claims", f)).json[0].id;
    expect((await api(`/expense-claims/${claimId}/approve`, f, {})).status).toBe(200);
    expect((await api("/users", f)).status).toBe(403);
  });
});

describe("session cookie 的 Secure 屬性", () => {
  /** 直接打 login 拿整串 Set-Cookie（loginAs 只留 name=value） */
  async function loginSetCookie(headers: Record<string, string> = {}): Promise<string> {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ username: "admin", password: "secret-test" }),
    });
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie")!;
  }

  it("http 請求不帶 Secure（內網部署加了會直接登不進來），https 反代則帶", async () => {
    expect(await loginSetCookie()).not.toMatch(/Secure/i);
    expect(await loginSetCookie({ "x-forwarded-proto": "https" })).toMatch(/Secure/i);
    // 反代串接時標頭可能是 "https, http"，取第一段
    expect(await loginSetCookie({ "x-forwarded-proto": "https, http" })).toMatch(/Secure/i);
  });

  it("SESSION_COOKIE_SECURE 可明確覆寫自動判斷（兩個方向都要）", async () => {
    process.env["SESSION_COOKIE_SECURE"] = "1";
    expect(await loginSetCookie()).toMatch(/Secure/i);
    process.env["SESSION_COOKIE_SECURE"] = "0";
    expect(await loginSetCookie({ "x-forwarded-proto": "https" })).not.toMatch(/Secure/i);
    delete process.env["SESSION_COOKIE_SECURE"];
  });

  it("HttpOnly 與 SameSite 一直都在", async () => {
    const cookie = await loginSetCookie();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });
});

describe("使用者管理防呆", () => {
  it("重複帳號 409；admin 不能停用自己", async () => {
    const dup = await api("/users", admin, {
      username: "wang",
      displayName: "重複",
      password: "secret-test",
      role: "employee",
    });
    expect(dup.status).toBe(409);
    const meId = (await api("/auth/me", admin)).json.id;
    expect((await api(`/users/${meId}`, admin, { active: false }, "PATCH")).status).toBe(400);
  });

  it("停用使用者後其 session 立即失效；重新啟用後可再登入", async () => {
    const session = await loginAs(app, "pur", "secret-test");
    const purId = (await api("/users", admin)).json.find((u: { username: string }) => u.username === "pur").id;
    await api(`/users/${purId}`, admin, { active: false }, "PATCH");
    expect((await api("/auth/me", session)).status).toBe(401);
    expect((await api("/auth/login", {}, { username: "pur", password: "secret-test" })).status).toBe(403);
    await api(`/users/${purId}`, admin, { active: true }, "PATCH");
    expect((await loginAs(app, "pur", "secret-test")).cookie).toBeTruthy();
  });
});
