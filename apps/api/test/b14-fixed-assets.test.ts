/**
 * B14 固定資產處分三重失準＋PATCH／作廢（第三批，migration 0031）驗收：
 * (a) 成本未入帳的資產不可處分（422 指路補取得傳票）——原本會把資產科目打成負數而無人知曉
 * (b) 處分價款拆「未稅＋銷項稅額」（taxable 預設 true；含稅／未稅皆可輸入），
 *     處分損益以未稅價款對帳面計；費率依處分日解析（0016 種子列 5%）
 * (c) 折舊截止＝處分當月：處分自動補提啟用月〜處分月漏提的期間（本月已提過則不重複）
 * PATCH：未提折舊可改基本資料；已提折舊改年限 422（只可改名稱與備註）
 * 作廢：未提折舊可作廢登錄；已提折舊 409 指路處分；處分作廢＝反向傳票沖回、資產回到使用中
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;

async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const res = await app.request(path, {
    method,
    headers: { ...admin, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function trialBalanceOf(code: string) {
  const tb = (await api("/trial-balance")).json;
  return tb.rows.find((r: { code: string }) => r.code === code) ?? { debit: 0, credit: 0 };
}

/** 登錄資產＋補取得傳票（借 資產科目／貸 1103），回傳資產 id */
async function registerAsset(input: Record<string, unknown>, assetCode = "1421") {
  const res = await api("/fixed-assets", input);
  expect(res.status).toBe(201);
  const entry = await api("/journal-entries", {
    entryDate: input["startDate"],
    memo: `購入 ${input["name"]}`,
    lines: [
      { accountCode: assetCode, debit: input["cost"], credit: 0 },
      { accountCode: "1103", debit: 0, credit: input["cost"] },
    ],
  });
  expect(entry.status).toBe(201);
  return res.json.id as number;
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
});

describe("B14(b) 處分損益：價款拆未稅＋銷項稅額（0016 種子費率 5%）", () => {
  it("賣價高於帳面（未稅輸入）：40,000 未稅、帳面 34,500 → 利益 5,500、銷項稅額 2,000", async () => {
    // 筆電 36,000／3 年 → 殘值 9,000、月折 750；2025-01 已提 750
    const id = await registerAsset({ name: "工作站", category: "computer", cost: 36000, startDate: "2025-01-10" });
    expect((await api("/depreciations/run", { period: "2025-01" })).json).toMatchObject({ count: 1, total: 750 });

    const res = await api(`/fixed-assets/${id}/dispose`, {
      date: "2025-02-15",
      proceeds: 40000,
      accountCode: "1103",
      proceedsIncludeTax: false, // 40,000 是未稅價款，稅外加
    });
    expect(res.status).toBe(200);
    // (c) 一併驗證：處分自動補提 2025-02（啟用月已提、處分月漏提）
    expect(res.json.catchUp).toMatchObject({ count: 1, total: 750, items: [{ period: "2025-02", amount: 750 }] });
    expect(res.json).toMatchObject({
      status: "disposed",
      accumulated: 1500,
      bookValue: 34500,
      netProceeds: 40000,
      tax: 2000,
      proceeds: 42000, // 實收含稅
      gain: 5500, // 未稅價款 − 補提後帳面
      disposalProceeds: 42000,
      disposalTax: 2000,
    });
    expect((await trialBalanceOf("7101")).credit).toBe(5500);
    expect((await trialBalanceOf("2288")).credit).toBe(2000);
    const tb = (await api("/trial-balance")).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);
    // 開發票的提醒必須大聲：401 銷項取自發票清單，這筆不會自動進 401
    expect(res.json.taxNotes.join("")).toContain("401");
  });

  it("賣價低於帳面（含稅輸入）：實收 10,500、帳面 23,001 → 損失 13,001、銷項稅額 500", async () => {
    // 辦公設備 24,000／5 年 → 殘值 4,000、月折 333；從未計提 → 處分補提 2025-01〜03 三期
    const id = await registerAsset({ name: "會議桌", category: "office", cost: 24000, startDate: "2025-01-01" });
    const res = await api(`/fixed-assets/${id}/dispose`, { date: "2025-03-10", proceeds: 10500, accountCode: "1103" });
    expect(res.status).toBe(200);
    expect(res.json.catchUp).toMatchObject({ count: 3, total: 999 });
    expect(res.json).toMatchObject({
      accumulated: 999,
      bookValue: 23001,
      netProceeds: 10000, // 10,500 ÷ 1.05
      tax: 500,
      proceeds: 10500,
      gain: -13001,
    });
    expect((await trialBalanceOf("7501")).debit).toBe(13001);
    const tb = (await api("/trial-balance")).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});

describe("B14(c) 當月處分的折舊邊界", () => {
  it("啟用當月即處分：恰補提處分當月 1 期（與「啟用日當月起提」對稱）", async () => {
    const id = await registerAsset({ name: "測試機", category: "computer", cost: 36000, startDate: "2025-05-05" });
    const res = await api(`/fixed-assets/${id}/dispose`, { date: "2025-05-20", proceeds: 0 });
    expect(res.status).toBe(200);
    expect(res.json.catchUp).toMatchObject({ count: 1, items: [{ period: "2025-05", amount: 750 }] });
    expect(res.json.gain).toBe(-(36000 - 750));
  });

  it("處分當月已跑過月折舊：不重複補提（catchUp 0）", async () => {
    const id = await registerAsset({ name: "備用機", category: "computer", cost: 36000, startDate: "2025-05-01" });
    expect((await api("/depreciations/run", { period: "2025-05" })).json).toMatchObject({ count: 1, total: 750 });
    const res = await api(`/fixed-assets/${id}/dispose`, { date: "2025-05-25", proceeds: 0 });
    expect(res.status).toBe(200);
    expect(res.json.catchUp.count).toBe(0);
    expect(res.json.accumulated).toBe(750);
  });
});

describe("處分試算（不落帳）", () => {
  it("試算與實際處分同一組數字；試算本身不寫任何帳", async () => {
    const id = await registerAsset({ name: "掃描器", category: "office", cost: 12000, startDate: "2025-06-01" });
    const preview = await api(`/fixed-assets/${id}/dispose-preview?date=2025-06-30&proceeds=2100`);
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({
      catchUp: { count: 1, total: 167 },
      bookValue: 11833,
      netProceeds: 2000,
      tax: 100,
      proceeds: 2100,
      gain: -9833,
    });
    // 沒落帳：資產仍未提任何折舊、仍為使用中
    const row = (await api("/fixed-assets")).json.find((a: { id: number }) => a.id === id);
    expect(row).toMatchObject({ status: "active", accumulated: 0, lastPeriod: null });

    const res = await api(`/fixed-assets/${id}/dispose`, { date: "2025-06-30", proceeds: 2100 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ bookValue: 11833, netProceeds: 2000, tax: 100, gain: -9833 });
  });

  it("試算參數打錯回 400（不是 internal error）", async () => {
    expect((await api("/fixed-assets/1/dispose-preview?date=abc")).status).toBe(400);
  });
});

describe("B14(a) 成本未入帳的資產不可處分＋PATCH／作廢登錄", () => {
  let unbookedId: number;

  it("成本從未入帳 → 422 指路補取得傳票", async () => {
    const res = await api("/fixed-assets", { name: "幽靈設備", category: "office", cost: 5000, startDate: "2025-06-01" });
    unbookedId = res.json.id;
    const blocked = await api(`/fixed-assets/${unbookedId}/dispose`, { date: "2025-06-30", proceeds: 1000 });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error).toContain("尚未入帳");
    expect(blocked.json.error).toContain("傳票");
  });

  it("未提折舊：可改名稱／類別／成本／殘值／年限／啟用日（成本少打一個零不再只能假處分）", async () => {
    const res = await api(`/fixed-assets/${unbookedId}`, {
      name: "CNC 銑床",
      category: "machine",
      cost: 50000,
      salvage: 6000,
      usefulYears: 8,
      startDate: "2025-07-01",
    }, "PATCH");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      name: "CNC 銑床",
      category: "machine",
      assetCode: "1411", // 類別改了，科目跟著換
      accumCode: "1419",
      cost: 50000,
      salvage: 6000,
      usefulYears: 8,
      startDate: "2025-07-01",
    });
    // 空 PATCH 是輸入錯誤（400），殘值 ≥ 成本擋下（422）
    expect((await api(`/fixed-assets/${unbookedId}`, {}, "PATCH")).status).toBe(400);
    expect((await api(`/fixed-assets/${unbookedId}`, { salvage: 50000 }, "PATCH")).status).toBe(422);
  });

  it("未提折舊可作廢登錄；作廢後不可處分／修改／再作廢，也不再長折舊", async () => {
    const res = await api(`/fixed-assets/${unbookedId}/void`, { reason: "登錄錯誤：這台是租的" });
    expect(res.status).toBe(200);
    expect(res.json.voidedAt).toBeTruthy();
    expect(res.json.voidReason).toContain("租的");

    expect((await api(`/fixed-assets/${unbookedId}/dispose`, { date: "2025-07-31" })).status).toBe(409);
    expect((await api(`/fixed-assets/${unbookedId}`, { name: "x" }, "PATCH")).status).toBe(409);
    expect((await api(`/fixed-assets/${unbookedId}/void`, { reason: "再廢一次" })).status).toBe(409);
  });
});

describe("已提折舊之後：PATCH 受限、登錄不可作廢、出路是處分", () => {
  let id: number;

  it("已提折舊改年限 → 422（只可改名稱與備註）；作廢登錄 → 409 指路處分", async () => {
    // 運輸設備 36,000／5 年 → 殘值 6,000、月折 500
    id = await registerAsset({ name: "貨車", category: "vehicle", cost: 36000, startDate: "2025-07-01" }, "1431");
    // 上一組把幽靈設備作廢了——本期計提只該有貨車一筆（作廢的登錄不再長折舊）
    expect((await api("/depreciations/run", { period: "2025-07" })).json).toMatchObject({ count: 1, total: 500 });

    const blocked = await api(`/fixed-assets/${id}`, { usefulYears: 8 }, "PATCH");
    expect(blocked.status).toBe(422);
    expect(blocked.json.error).toContain("耐用年限");
    expect(blocked.json.error).toContain("名稱");

    const ok = await api(`/fixed-assets/${id}`, { name: "貨車（3.5 噸）", memo: "車牌 ABC-1234" }, "PATCH");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ name: "貨車（3.5 噸）", memo: "車牌 ABC-1234", usefulYears: 5 });

    const voidRes = await api(`/fixed-assets/${id}/void`, { reason: "想廢掉" });
    expect(voidRes.status).toBe(409);
    expect(voidRes.json.error).toContain("處分");
  });

  it("處分作廢：反向傳票沖回處分損益／累折／銷項稅額，資產回到使用中且繼續提折舊", async () => {
    const before7501 = await trialBalanceOf("7501");
    const before2288 = await trialBalanceOf("2288");

    // 處分：實收 21,000（含稅）→ 未稅 20,000、稅 1,000；補提 2025-08（500）→ 帳面 35,000 → 損失 15,000
    const disposed = await api(`/fixed-assets/${id}/dispose`, { date: "2025-08-15", proceeds: 21000, accountCode: "1103" });
    expect(disposed.status).toBe(200);
    expect(disposed.json).toMatchObject({ bookValue: 35000, netProceeds: 20000, tax: 1000, gain: -15000 });

    // 已處分的資產不可作廢登錄（先作廢處分）
    const voidReg = await api(`/fixed-assets/${id}/void`, { reason: "登錄錯誤" });
    expect(voidReg.status).toBe(409);
    expect(voidReg.json.error).toContain("作廢處分");

    const res = await api(`/fixed-assets/${id}/dispose/void`, { reason: "買家反悔，車沒賣成" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "active" });
    expect(res.json.reversalEntryId).toBeTruthy();
    expect(res.json.disposalVoidReason).toContain("反悔");

    // 處分損益與銷項稅額被反向傳票沖回（淨額回到處分前）
    const after7501 = await trialBalanceOf("7501");
    const after2288 = await trialBalanceOf("2288");
    expect(after7501.debit - after7501.credit).toBe(before7501.debit - before7501.credit);
    expect(after2288.credit - after2288.debit).toBe(before2288.credit - before2288.debit);
    const tb = (await api("/trial-balance")).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);

    // 處分時補提的 2025-08 折舊留著（那是資產真實存在期間的折舊），之後照常續提
    const row = (await api("/fixed-assets")).json.find((a: { id: number }) => a.id === id);
    expect(row).toMatchObject({ status: "active", accumulated: 1000, lastPeriod: "2025-08" });
    expect((await api("/depreciations/run", { period: "2025-09" })).json).toMatchObject({ count: 1, total: 500 });
  });

  it("作廢處分後可再處分（作廢欄位歸零）；未處分的資產作廢處分 → 409", async () => {
    const again = await api(`/fixed-assets/${id}/dispose`, { date: "2025-09-30", proceeds: 0 });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: "disposed", disposalVoidedAt: null, disposalVoidReason: null });
    expect(again.json.catchUp.count).toBe(0); // 2025-09 已由月折舊提過

    const fresh = await registerAsset({ name: "新印表機", category: "office", cost: 6000, startDate: "2025-09-01" });
    const notDisposed = await api(`/fixed-assets/${fresh}/dispose/void`, { reason: "沒這回事" });
    expect(notDisposed.status).toBe(409);
    expect(notDisposed.json.error).toContain("不是已處分");
  });
});
