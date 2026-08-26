/**
 * 固定資產驗收：登錄（類別帶科目年限、殘值 成本/(n+1)）→ 每月計提（傳票平衡、冪等、
 * 末期收斂到成本−殘值）→ 處分（沖成本累折、認列損益）；權限（員工 403、gm 唯讀）。
 * 場景：筆電 36,000、3 年 → 殘值 9,000、月折舊 (36000-9000)/36 = 750。
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
let assetId: number;

async function api(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function trialBalanceOf(code: string) {
  const tb = (await api("/trial-balance", admin)).json;
  return tb.rows.find((r: { code: string }) => r.code === code) ?? { debit: 0, credit: 0 };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
});

describe("資產登錄", () => {
  it("類別帶科目與年限；殘值自動算 成本/(年數+1)", async () => {
    const res = await api("/fixed-assets", admin, {
      name: "MacBook Pro",
      category: "computer",
      cost: 36000,
      startDate: "2022-07-15",
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      assetCode: "1421",
      accumCode: "1429",
      usefulYears: 3,
      salvage: 9000, // 36000 / 4
      status: "active",
    });
    assetId = res.json.id;

    // 設計：登錄不拋轉取得傳票——取得入帳自行走手工傳票（借 設備／貸 銀行）
    await api("/journal-entries", admin, {
      entryDate: "2022-07-15",
      memo: "購入筆電",
      lines: [
        { accountCode: "1421", debit: 36000, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 36000 },
      ],
    });

    expect((await api("/fixed-assets", admin, { name: "x", category: "nope", cost: 100, startDate: "2022-07-01" })).status).toBe(422);
  });
});

describe("每月計提", () => {
  it("2022-07 計提 750（借 6140／貸 1429，傳票日=月底）；重跑同期間不重複", async () => {
    const run = await api("/depreciations/run", admin, { period: "2022-07" });
    expect(run.status).toBe(201);
    expect(run.json).toMatchObject({ period: "2022-07", count: 1, total: 750 });

    const dep = await trialBalanceOf("6140");
    const accum = await trialBalanceOf("1429");
    expect(dep.debit).toBe(750);
    expect(accum.credit).toBe(750);

    const again = await api("/depreciations/run", admin, { period: "2022-07" });
    expect(again.json.count).toBe(0); // 冪等
    expect((await trialBalanceOf("6140")).debit).toBe(750);
  });

  it("啟用月前不提；期中新資產由重跑補提", async () => {
    const early = await api("/depreciations/run", admin, { period: "2022-06" });
    expect(early.json.count).toBe(0);

    await api("/fixed-assets", admin, {
      name: "辦公桌", category: "office", cost: 12000, startDate: "2022-07-01",
    }); // 5 年 → 殘值 2000、月折 (12000-2000)/60 = 167
    await api("/journal-entries", admin, {
      entryDate: "2022-07-01",
      memo: "購入辦公桌",
      lines: [
        { accountCode: "1421", debit: 12000, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 12000 },
      ],
    });
    const rerun = await api("/depreciations/run", admin, { period: "2022-07" });
    expect(rerun.json).toMatchObject({ count: 1, total: 167 }); // 只補新資產
  });

  it("末期收斂：連提 36 期後總折舊＝成本−殘值，之後不再提", async () => {
    // 筆電已提 2022-07（750）。續提 2022-08 起 35 期 → 共 36 期
    for (let i = 0; i < 35; i++) {
      const d = new Date(Date.UTC(2022, 7 + i, 1)); // 2022-08 起
      const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      await api("/depreciations/run", admin, { period });
    }
    const assets = (await api("/fixed-assets", admin)).json;
    const laptop = assets.find((a: { id: number }) => a.id === assetId);
    // 750×36 = 27000 = 36000 - 9000 整除，無尾差；帳面=殘值
    expect(laptop.accumulated).toBe(27000);
    expect(laptop.bookValue).toBe(9000);
    expect(laptop.remainingDepreciable).toBe(0);

    const extra = await api("/depreciations/run", admin, { period: "2025-08" });
    expect(extra.json.items.find((i: { assetId: number }) => i.assetId === assetId)).toBeUndefined();
  });
});

describe("處分", () => {
  it("提足後以 10,000 出售（帳面 9,000、不計稅）→ 利益 1,000；傳票平衡；不可重複處分", async () => {
    // taxable:false 走不計稅路徑（價款即未稅）；預設計稅的拆稅與 2288 驗證在 b14-fixed-assets.test.ts
    const res = await api(`/fixed-assets/${assetId}/dispose`, admin, {
      date: "2025-09-01",
      proceeds: 10000,
      accountCode: "1103",
      taxable: false,
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "disposed", bookValue: 9000, gain: 1000 });
    expect(res.json.catchUp.count).toBe(0); // 已提足，處分前沒有漏提可補

    const gain = await trialBalanceOf("7101");
    expect(gain.credit).toBe(1000);
    const tb = (await api("/trial-balance", admin)).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);
    // 筆電成本已沖：1421 只剩辦公桌的 12000
    const cost = await trialBalanceOf("1421");
    expect(cost.debit - cost.credit).toBe(12000);

    expect((await api(`/fixed-assets/${assetId}/dispose`, admin, { date: "2025-09-02" })).status).toBe(409);
  });

  it("報廢（價款 0、帳面 > 0）補提到處分當月後，認列損失＝補提後帳面淨值", async () => {
    // 辦公桌提到 2025-06，另外上一格的「2025-08 重跑」也提了它——
    // 2025-09-01 報廢自動補提漏掉的 2025-07 與 2025-09 兩期（B14(c)，已提過的期間不重複）
    const desk = (await api("/fixed-assets", admin)).json.find((a: { name: string }) => a.name === "辦公桌");
    expect(desk.bookValue).toBeGreaterThan(0);
    const res = await api(`/fixed-assets/${desk.id}/dispose`, admin, { date: "2025-09-01" });
    expect(res.status).toBe(200);
    expect(res.json.catchUp).toMatchObject({
      count: 2,
      total: 2 * desk.monthly,
      items: [{ period: "2025-07" }, { period: "2025-09" }],
    });
    expect(res.json.bookValue).toBe(desk.bookValue - 2 * desk.monthly); // 補提後的帳面才是損益基礎
    expect(res.json.gain).toBe(-res.json.bookValue); // 價款 0 → 全額損失
    const loss = await trialBalanceOf("7501");
    expect(loss.debit).toBe(res.json.bookValue);
    const tb = (await api("/trial-balance", admin)).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it("處分價款可收進零用金或使用者自建的銀行科目；非現金科目被擋（422）", async () => {
    const esun = await api("/accounts", admin, {
      code: "1105", name: "銀行存款－玉山", type: "asset", isCash: true,
    });
    expect(esun.status).toBe(201);
    const printer = await api("/fixed-assets", admin, {
      name: "印表機", category: "office", cost: 8000, startDate: "2025-09-01",
    });
    expect(printer.status).toBe(201);
    // 取得入帳（B14(a)：成本未入帳的資產處分會被 422 擋下，走文件寫的手工傳票路）
    await api("/journal-entries", admin, {
      entryDate: "2025-09-01",
      memo: "購入印表機",
      lines: [
        { accountCode: "1421", debit: 8000, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 8000 },
      ],
    });

    // 非現金科目（存貨）：擋下並講清楚可用的科目
    const bad = await api(`/fixed-assets/${printer.json.id}/dispose`, admin, {
      date: "2025-10-01", proceeds: 5000, accountCode: "1301",
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toContain("現金科目");

    // 自建的銀行帳戶收得了款（舊版寫死 z.enum(["1101","1103"]) 時這裡是 400，使用者無路可走）
    const ok = await api(`/fixed-assets/${printer.json.id}/dispose`, admin, {
      date: "2025-10-01", proceeds: 5000, accountCode: "1105",
    });
    expect(ok.status).toBe(200);
    const bank = await trialBalanceOf("1105");
    expect(bank.debit - bank.credit).toBe(5000);
    // 這筆現金流入也必須出現在現金流量表（處分＝投資活動）
    const cf = (await api("/reports/cash-flow?from=2025-10-01&to=2025-10-31", admin)).json;
    expect(cf.investing).toBe(5000);
  });

  it("處分價款收進零用金（1102）也可以", async () => {
    const chair = await api("/fixed-assets", admin, {
      name: "辦公椅", category: "office", cost: 3000, startDate: "2025-09-01",
    });
    await api("/journal-entries", admin, {
      entryDate: "2025-09-01",
      memo: "購入辦公椅",
      lines: [
        { accountCode: "1421", debit: 3000, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 3000 },
      ],
    });
    const ok = await api(`/fixed-assets/${chair.json.id}/dispose`, admin, {
      date: "2025-11-01", proceeds: 500, accountCode: "1102",
    });
    expect(ok.status).toBe(200);
    const petty = await trialBalanceOf("1102");
    expect(petty.debit - petty.credit).toBe(500);
  });
});

describe("權限", () => {
  it("員工 403；總經理可看不可計提", async () => {
    const emp = await api("/employees", admin, { name: "王小明" });
    await api("/users", admin, {
      username: "wang", displayName: "王小明", password: "secret-test", role: "employee", employeeId: emp.json.id,
    });
    const w = await loginAs(app, "wang", "secret-test");
    expect((await api("/fixed-assets", w)).status).toBe(403);

    await api("/users", admin, { username: "boss", displayName: "總經理", password: "secret-test", role: "gm" });
    const g = await loginAs(app, "boss", "secret-test");
    expect((await api("/fixed-assets", g)).status).toBe(200);
    expect((await api("/depreciations/run", g, { period: "2022-09" })).status).toBe(403);
  });
});
