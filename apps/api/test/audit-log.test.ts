/**
 * 操作日誌驗收（步驟④＋公網部署前的安全批次③）。
 *
 * 這個檔案要守住的三件事，重要性由高到低：
 *  1. **日誌裡永遠不會有密碼或身分證號**——記 body 是最直覺也最容易變成災難的做法，
 *     而日誌是刻意不刪的，一旦流進去就永久留著。
 *  2. **被擋下的嘗試也要記**（401／403／422／429）——那才是安全上最該看的東西。
 *  3. 一般 GET 不記，否則真正的事件會被翻頁流量淹掉。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

interface AuditRow {
  id: number;
  userId: number | null;
  username: string;
  role: string | null;
  method: string;
  path: string;
  status: number;
  targetId: number | null;
  note: string;
}

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let sales: Record<string, string>;
let adminId: number;

async function api(path: string, headers: Record<string, string>, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const logs = async (query = ""): Promise<AuditRow[]> => (await api(`/audit-logs${query}`, admin)).json;

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);

  admin = await setupAdmin(app);
  adminId = (await api("/auth/me", admin)).json.id;
  await api("/users", admin, { username: "sal", displayName: "業務", password: "secret-test", role: "sales" });
  sales = await loginAs(app, "sal", "secret-test");
});

describe("記什麼、不記什麼", () => {
  it("寫入操作留下誰做的、對哪個路徑、狀態碼與新建資源的 id", async () => {
    const created = await api("/partners", admin, { name: "日誌測試客戶", isCustomer: true });
    expect(created.status).toBe(201);

    const [row] = await logs("?method=POST&path=/partners");
    expect(row).toMatchObject({
      userId: adminId,
      username: "admin",
      role: "admin",
      method: "POST",
      path: "/partners",
      status: 201,
      targetId: created.json.id, // 201 回應只取 id 這一個欄位（白名單，不是過濾）
    });
  });

  it("一般 GET 不記（日誌不是流量紀錄）", async () => {
    const before = (await logs()).length;
    await api("/partners", admin);
    await api("/accounts", admin);
    await api("/trial-balance", admin);
    expect((await logs()).length).toBe(before);
  });

  it("身分證號的單筆明文查詢是唯一被記錄的 GET（誰看過 PII 必須查得到）", async () => {
    const p = await api("/partners", admin, { name: "王房東", isIndividual: true, idNo: "TEST-ID-0001" });
    await api(`/partners/${p.json.id}/id-no`, admin);
    const [row] = await logs(`?path=/partners/${p.json.id}/id-no`);
    expect(row).toMatchObject({ method: "GET", status: 200, username: "admin" });
  });
});

describe("被擋下的嘗試", () => {
  it("權限守衛擋掉的 403 有記，而且記得出是誰在試", async () => {
    expect((await api("/purchases", sales, { partnerId: 1, purchaseDate: "2026-08-02", items: [] })).status).toBe(403);
    const [row] = await logs("?path=/purchases&failedOnly=1");
    expect(row).toMatchObject({ username: "sal", role: "sales", method: "POST", status: 403 });
  });

  it("未登入的寫入嘗試有記，user_id 為 null", async () => {
    expect((await api("/partners", {}, { name: "沒登入" })).status).toBe(401);
    const row = (await logs("?method=POST&path=/partners&failedOnly=1")).find((r) => r.status === 401);
    expect(row).toBeTruthy();
    expect(row!.userId).toBeNull();
  });

  it("服務層丟出的 AppError 照樣記到正確狀態碼（不是一律 500）", async () => {
    // 交易對象名稱重複以外的既有防呆：帳號重複 409
    expect((await api("/users", admin, { username: "sal", displayName: "重複", password: "secret-test", role: "sales" })).status).toBe(409);
    const [row] = await logs("?method=POST&path=/users&failedOnly=1");
    expect(row!.status).toBe(409);
  });

  it("登入失敗記得出試的是哪個帳號（user_id 為 null，靠 username 快照）", async () => {
    expect((await api("/auth/login", {}, { username: "ghost", password: "guessing" })).status).toBe(401);
    const [row] = await logs("?path=/auth/login&failedOnly=1");
    expect(row).toMatchObject({ userId: null, username: "ghost", status: 401 });
  });
});

describe("日誌本身不得成為外洩管道", () => {
  it("整張表裡找不到任何密碼或身分證號（body 一律不記）", async () => {
    await api("/auth/login", {}, { username: "admin", password: "PASSWORD-NEEDLE-9x" });
    await api("/users", admin, {
      username: "needle-user",
      displayName: "針",
      password: "PASSWORD-NEEDLE-9x",
      role: "employee",
    });
    await api("/partners", admin, { name: "李房東", isIndividual: true, idNo: "IDNO-NEEDLE-7z" });

    const dump = JSON.stringify(await logs("?limit=500"));
    expect(dump).not.toContain("PASSWORD-NEEDLE-9x");
    expect(dump).not.toContain("IDNO-NEEDLE-7z");
    // 對照組：確認上面那些請求真的有被記下來，否則這個測試會因為「什麼都沒記」而假綠
    expect(dump).toContain("/users");
    expect(dump).toContain("/partners");
  });

  it("只有 admin 讀得到操作日誌（財務也不行——日誌是對包含財務在內的所有人的問責紀錄）", async () => {
    await api("/users", admin, { username: "fin", displayName: "財務", password: "secret-test", role: "finance" });
    const fin = await loginAs(app, "fin", "secret-test");
    expect((await api("/audit-logs", fin)).status).toBe(403);
    expect((await api("/audit-logs", sales)).status).toBe(403);
    expect((await api("/audit-logs", admin)).status).toBe(200);
  });

  it("沒有任何清空或刪除日誌的路徑（能被關掉的稽核不是稽核）", async () => {
    // 直接發請求而不經過 api()：Hono 的 404 是純文字，JSON.parse 會炸
    const [row] = await logs();
    const del = (path: string) => app.request(path, { method: "DELETE", headers: admin });
    expect((await del(`/audit-logs/${row!.id}`)).status).toBe(404);
    expect((await del("/audit-logs")).status).toBe(404);
    // 連「試圖刪日誌」這件事本身也被記下來了（非 GET 一律記，含 404）
    expect((await logs("?method=DELETE&path=/audit-logs")).length).toBeGreaterThan(0);
  });
});
