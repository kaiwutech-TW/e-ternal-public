/**
 * 登入節流驗收（公網部署前的安全批次）：帳號桶、來源桶、成功即歸零、停用不計入。
 *
 * 自己開一個資料庫而不是併進 auth.test.ts：節流是**跨請求累積的狀態**，
 * 在共用 app 的測試檔裡多打幾次密碼就會讓不相干的測試開始收 429，
 * 而且失敗訊息會指向錯的地方（「角色矩陣壞了」其實是「前一個 describe 把桶打滿了」）。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { setupAdmin } from "./auth-helper.ts";

// 每一題都要跑多次 scrypt（64MB 記憶體成本的密碼雜湊，這是刻意的安全設計），
// 全量跑時與其他測試檔搶 CPU，預設 5s 會偶發逾時（獨跑綠＝已知 flake）。
// 加大 timeout 而不是減少嘗試次數——斷言的就是「打滿門檻會被擋」，次數不能少
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;

async function tryLogin(username: string, password: string, headers: Record<string, string> = {}) {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  app = buildApp(drizzle(client));
  admin = await setupAdmin(app); // 順手建 admin（setup 不經過 login，不影響計數）
  expect(admin["cookie"]).toBeTruthy();
});

afterEach(() => {
  delete process.env["TRUST_PROXY"];
});

describe("帳號桶", () => {
  it("連續 5 次錯密碼後，第 6 次即使密碼正確也擋下（429）", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await tryLogin("admin", `wrong-${i}`)).status).toBe(401);
    }
    const blocked = await tryLogin("admin", "secret-test");
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toMatch(/分鐘後再試/);
  });

  it("節流是逐帳號的：別的帳號不受牽連", async () => {
    // 上一個 it 已把 admin 打到滿；另一個帳號照常收 401（不是 429）
    expect((await tryLogin("someone-else", "whatever")).status).toBe(401);
  });

  it("帳號不存在與密碼錯誤，被擋下時是同一句話（節流不得洩漏帳號是否存在）", async () => {
    for (let i = 0; i < 5; i++) await tryLogin("ghost-user", `wrong-${i}`);
    const ghost = await tryLogin("ghost-user", "whatever");
    const known = await tryLogin("admin", "secret-test");
    expect(ghost.status).toBe(429);
    expect(known.status).toBe(429);
    expect(ghost.json.error).toBe(known.json.error);
  });

  it("登入成功即清掉該帳號的失敗紀錄，下一輪重新從 0 算", async () => {
    const fresh = await app.request("/auth/setup-status", {}); // 只為確認 app 還活著
    expect(fresh.status).toBe(200);

    // 用一個乾淨帳號：4 次失敗（未達門檻）→ 成功 → 再 4 次失敗仍應是 401 而非 429
    await app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ username: "reset-me", displayName: "重置", password: "secret-test", role: "employee" }),
    });
    for (let i = 0; i < 4; i++) expect((await tryLogin("reset-me", `bad-${i}`)).status).toBe(401);
    expect((await tryLogin("reset-me", "secret-test")).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await tryLogin("reset-me", `bad-again-${i}`)).status).toBe(401);
  });
});

describe("來源桶", () => {
  it("同一來源掃過多個帳號：帳號桶各自未滿，來源桶仍會擋下", async () => {
    process.env["TRUST_PROXY"] = "1";
    const from = { "x-forwarded-for": "203.0.113.9" };
    // 6 個不存在的帳號 × 5 次 = 30 次，剛好打滿來源門檻（每個帳號桶都只到門檻，不多不少）
    for (let u = 0; u < 6; u++) {
      for (let i = 0; i < 5; i++) {
        expect((await tryLogin(`spray-${u}`, `p-${i}`, from)).status).toBe(401);
      }
    }
    // 第 31 次換一個全新帳號（帳號桶是空的）→ 只可能是來源桶擋的
    expect((await tryLogin("spray-fresh", "p", from)).status).toBe(429);
    // 換一個來源位址就不受影響（確認擋的真的是「來源」而不是全域計數）
    expect((await tryLogin("spray-fresh", "p", { "x-forwarded-for": "198.51.100.7" })).status).toBe(401);
  });

  it("沒設 TRUST_PROXY 時不採信 X-Forwarded-For（否則來源桶可以自己編一個位址繞過）", async () => {
    // 上一題已把 203.0.113.9 打滿。不設 TRUST_PROXY 時這個標頭應該被無視，
    // 來源改由 socket 位址決定（測試環境沒有 socket → 空字串 → 跳過來源桶）
    expect((await tryLogin("bypass-check", "p", { "x-forwarded-for": "203.0.113.9" })).status).toBe(401);
  });
});

describe("停用帳號", () => {
  it("密碼正確但帳號停用：403 且不計入節流（不該讓同事被連坐）", async () => {
    await app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ username: "gone", displayName: "已離職", password: "secret-test", role: "employee" }),
    });
    const list = await (await app.request("/users", { headers: admin })).json();
    const goneId = list.find((u: { username: string }) => u.username === "gone").id;
    await app.request(`/users/${goneId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ active: false }),
    });

    for (let i = 0; i < 6; i++) expect((await tryLogin("gone", "secret-test")).status).toBe(403);
  });
});
