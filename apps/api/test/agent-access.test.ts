/**
 * Agent 接入層驗收（API 金鑰＋LLM 供應商設定）。
 *
 * 要守住的四件事：
 *  1. 金鑰能取代帳密登入，**而且在啟用二階段驗證的帳號上照樣能用**（這是它存在的直接原因）
 *  2. 金鑰不是新的權限模型——它就是那個使用者，該 403 的照樣 403
 *  3. 明文金鑰只出現一次；撤銷立即生效且不刪除紀錄
 *  4. LLM 金鑰不回明文、加密儲存、啟用前必須填齊
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, schema } from "@tw-erp/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { totpCodeAt } from "../src/services/totp.ts";
import { setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof drizzle>;
let admin: Record<string, string>;
let salesUserId: number;

async function api(path: string, headers: Record<string, string>, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const asKey = (key: string) => ({ authorization: `Bearer ${key}` });

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
  salesUserId = (await api("/users", admin, {
    username: "ai-sales",
    displayName: "AI 助理（業務）",
    password: "secret-test",
    role: "sales",
  })).json.id;
});

describe("API 金鑰＝新的登入方式，不是新的權限模型", () => {
  let key: string;

  it("建立時回傳明文金鑰，且帶得出可辨識的前綴", async () => {
    const res = await api("/api-keys", admin, { name: "Claude Desktop（業務助理）", userId: salesUserId });
    expect(res.status).toBe(201);
    key = res.json.key;
    expect(key).toMatch(/^twerp_sk_/); // 貼錯地方時搜尋得到
    const list = (await api("/api-keys", admin)).json;
    expect(list[0].prefix).toBe(key.slice("twerp_sk_".length, "twerp_sk_".length + 8));
    expect(JSON.stringify(list)).not.toContain(key); // 明文只出現在建立那一次
  });

  it("拿金鑰就能呼叫 API，不必登入", async () => {
    expect((await api("/auth/me", asKey(key))).json.username).toBe("ai-sales");
    expect((await api("/partners", asKey(key))).status).toBe(200);
  });

  it("權限完全跟著那個使用者：業務進不了進貨頁、碰不到使用者管理", async () => {
    expect((await api("/purchases", asKey(key))).status).toBe(403);
    expect((await api("/users", asKey(key))).status).toBe(403);
    expect((await api("/api-keys", asKey(key))).status).toBe(403); // 金鑰不能自己發金鑰
  });

  it("動作照樣進操作日誌，而且記得出是誰", async () => {
    await api("/partners", asKey(key), { name: "AI 開的客戶", isCustomer: true });
    const [row] = (await api("/audit-logs?method=POST&path=/partners", admin)).json;
    expect(row).toMatchObject({ username: "ai-sales", role: "sales", status: 201 });
  });

  it("last_used_at 會更新（用來判斷哪些金鑰已經沒在用、可以撤掉）", async () => {
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, salesUserId));
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it("亂編的金鑰、格式對但不存在的金鑰，一律 401", async () => {
    expect((await api("/partners", asKey("twerp_sk_totally-made-up"))).status).toBe(401);
    expect((await api("/partners", { authorization: "Bearer not-even-close" })).status).toBe(401);
    expect((await api("/partners", { authorization: key })).status).toBe(401); // 少了 Bearer
  });

  it("撤銷立即生效，但紀錄留著（出事時要查得出這把做過什麼）", async () => {
    const id = (await api("/api-keys", admin)).json[0].id;
    expect((await api(`/api-keys/${id}`, admin, undefined, "DELETE")).status).toBe(200);
    expect((await api("/partners", asKey(key))).status).toBe(401);
    const list = (await api("/api-keys", admin)).json;
    expect(list.find((k: { id: number }) => k.id === id).revokedAt).not.toBeNull();
    expect((await api(`/api-keys/${id}`, admin, undefined, "DELETE")).status).toBe(404); // 不能撤兩次
  });

  it("停用的帳號連帶讓金鑰失效（不必記得去撤銷）", async () => {
    const fresh = (await api("/api-keys", admin, { name: "會被停用的", userId: salesUserId })).json.key;
    expect((await api("/auth/me", asKey(fresh))).status).toBe(200);
    await api(`/users/${salesUserId}`, admin, { active: false }, "PATCH");
    expect((await api("/auth/me", asKey(fresh))).status).toBe(401);
    await api(`/users/${salesUserId}`, admin, { active: true }, "PATCH");
  });
});

describe("金鑰與二階段驗證", () => {
  it("帳號啟用 2FA 後帳密登入要驗證碼，但金鑰照常能用——這正是金鑰存在的原因", async () => {
    const s = (await api("/auth/totp/setup", admin, {})).json.secret;
    await api("/auth/totp/enable", admin, { code: totpCodeAt(s, Math.floor(Date.now() / 1000 / 30)) });

    const key = (await api("/api-keys", admin, { name: "管理者的自動化腳本", userId: 1 })).json.key;
    expect((await api("/auth/login", {}, { username: "admin", password: "secret-test" })).status).toBe(401);
    expect((await api("/auth/me", asKey(key))).status).toBe(200);
    // 以金鑰呼叫 logout 不該炸（沒有 session 可登出，是無操作）
    expect((await api("/auth/logout", asKey(key), {})).status).toBe(200);
  });
});

describe("LLM 供應商設定", () => {
  it("預設是關閉、沒有型號——刻意不預設型號（寫死的會過期，而過期的預設比空值更難發現）", async () => {
    const s = (await api("/agent-settings", admin)).json;
    expect(s).toMatchObject({ provider: "anthropic", model: "", enabled: false, hasApiKey: false });
  });

  it("金鑰永不回傳明文，只回「有沒有設定」與末四碼", async () => {
    const saved = (await api("/agent-settings", admin, { apiKey: "sk-ant-secret-XYZ9" }, "PUT")).json;
    expect(saved.hasApiKey).toBe(true);
    expect(saved.apiKeyHint).toBe("XYZ9");
    expect(JSON.stringify(saved)).not.toContain("sk-ant-secret");
    expect(JSON.stringify((await api("/agent-settings", admin)).json)).not.toContain("sk-ant-secret");
  });

  it("設了 PII_KEY 時資料庫裡是密文（它是一把會計費的憑證，與身分證號同級）", async () => {
    process.env["PII_KEY"] = "agent-settings-test-key";
    try {
      await api("/agent-settings", admin, { apiKey: "sk-ant-encrypted-ABCD" }, "PUT");
      const [row] = await db.select().from(schema.agentSettings).where(eq(schema.agentSettings.id, 1));
      expect(row!.apiKey).toMatch(/^pii1\$/);
      expect((await api("/agent-settings", admin)).json.apiKeyHint).toBe("ABCD");
    } finally {
      delete process.env["PII_KEY"];
    }
  });

  it("啟用前必須填齊：沒有型號不給啟用，沒有金鑰也不給（ollama／custom 除外）", async () => {
    const noModel = await api("/agent-settings", admin, { enabled: true }, "PUT");
    expect(noModel.status).toBe(422);
    expect(noModel.json.error).toContain("模型名稱");

    await api("/agent-settings", admin, { apiKey: null, model: "claude-opus-5" }, "PUT");
    const noKey = await api("/agent-settings", admin, { enabled: true }, "PUT");
    expect(noKey.status).toBe(422);
    expect(noKey.json.error).toContain("API 金鑰");

    // ollama 自架不需要金鑰
    const ok = await api("/agent-settings", admin, { provider: "ollama", baseUrl: "http://localhost:11434", enabled: true }, "PUT");
    expect(ok.status).toBe(200);
    expect(ok.json.enabled).toBe(true);
  });

  it("半套設定存得起來（工作中途狀態不該被擋），只有啟用時才把關", async () => {
    await api("/agent-settings", admin, { provider: "openai", enabled: false, model: "", apiKey: null }, "PUT");
    expect((await api("/agent-settings", admin)).json).toMatchObject({ provider: "openai", enabled: false });
  });

  it("非 admin 一律 403（能發金鑰就等於能發帳號）", async () => {
    const key = (await api("/api-keys", admin, { name: "業務金鑰", userId: salesUserId })).json.key;
    expect((await api("/agent-settings", asKey(key))).status).toBe(403);
    expect((await api("/agent-settings", asKey(key), { enabled: true }, "PUT")).status).toBe(403);
  });
});
