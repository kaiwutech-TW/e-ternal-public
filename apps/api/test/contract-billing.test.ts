/**
 * 合約請款計畫與續約驗收（0037，顧問／軟體開發業的營收形狀）。
 *
 * 要守住的四件事：
 *  1. 計畫是計畫、單據是單據——未請款可改可刪，開了單就鎖住，銷貨單作廢後自動回到未請款
 *  2. 開單走既有 createSale：稅額、到期日（客戶付款條件）、關帳鎖全部沿用
 *  3. 續約＝開新約成鏈（前身自動 ended），不是改舊約日期
 *  4. 待請款只列 active 合約的未請款期，逾期在前
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
let partnerId: number;
let serviceId: number;
let contractId: number;

const TODAY = new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

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
  admin = await setupAdmin(app);

  partnerId = (await api("/partners", admin, {
    name: "藍圖診所管理顧問案客戶",
    isCustomer: true,
    paymentTermDays: 30, // 開單後到期日要被推 30 天——驗「沿用既有 createSale」
  })).json.id;
  serviceId = (await api("/products", admin, {
    sku: "SVC-CONSULT",
    name: "顧問服務費",
    unit: "式",
    isService: true,
  })).json.id;
  contractId = (await api("/contracts", admin, {
    partnerId,
    counterparty: "藍圖診所管理顧問案客戶",
    title: "官網改版專案",
    kind: "project",
    amount: 300000,
    startDate: TODAY,
  })).json.id;
});

describe("請款計畫的生命週期", () => {
  let firstId: number;

  it("排三期：簽約金／期中款／驗收尾款，期次自動編", async () => {
    const res = await api(`/contracts/${contractId}/installments`, admin, {
      items: [
        { dueDate: TODAY, amount: 90000, description: "簽約金 30%" },
        { dueDate: daysFromNow(30), amount: 120000, description: "期中款 40%" },
        { dueDate: daysFromNow(60), amount: 90000, description: "驗收尾款 30%" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.json.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3]);
    expect(res.json.every((i: { billed: boolean }) => !i.billed)).toBe(true);
    firstId = res.json[0].id;
  });

  it("未請款的期可以改、可以刪（計畫不是單據）", async () => {
    const upd = await api(`/contracts/${contractId}/installments/${firstId}`, admin, { amount: 95000 }, "PATCH");
    expect(upd.status).toBe(200);
    expect(upd.json[0].amount).toBe(95000);

    const extra = await api(`/contracts/${contractId}/installments`, admin, {
      items: [{ dueDate: daysFromNow(90), amount: 1000, description: "多排的" }],
    });
    const extraId = extra.json.at(-1).id;
    expect((await api(`/contracts/${contractId}/installments/${extraId}`, admin, undefined, "DELETE")).status).toBe(200);
    expect((await api(`/contracts/${contractId}/installments`, admin)).json).toHaveLength(3);
  });

  it("開單＝一張真的銷貨單：稅額照算、到期日吃客戶付款條件、合約側標成已請款", async () => {
    const res = await api(`/contracts/${contractId}/installments/${firstId}/bill`, admin, {
      productId: serviceId,
      docDate: TODAY,
    });
    expect(res.status).toBe(201);
    expect(res.json.subtotal).toBe(95000);
    expect(res.json.tax).toBeGreaterThan(0); // 稅由參數表算，不斷言費率
    expect(res.json.dueDate).toBe(daysFromNow(30)); // 月結 30 天

    const list = (await api(`/contracts/${contractId}/installments`, admin)).json;
    expect(list[0]).toMatchObject({ billed: true, saleId: res.json.id });
  });

  it("已請款的期：不能再開、不能改、不能刪——訊息都指路「先作廢那張銷貨單」", async () => {
    const again = await api(`/contracts/${contractId}/installments/${firstId}/bill`, admin, {
      productId: serviceId,
      docDate: TODAY,
    });
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("已開過銷貨單");
    expect((await api(`/contracts/${contractId}/installments/${firstId}`, admin, { amount: 1 }, "PATCH")).status).toBe(409);
    expect((await api(`/contracts/${contractId}/installments/${firstId}`, admin, undefined, "DELETE")).status).toBe(409);
  });

  it("銷貨單作廢後，該期自動回到未請款、可重開（單一事實來源是銷貨單）", async () => {
    const saleId = (await api(`/contracts/${contractId}/installments`, admin)).json[0].saleId;
    expect((await api(`/sales/${saleId}/void`, admin, { reason: "金額談錯重開" })).status).toBe(200);

    const list = (await api(`/contracts/${contractId}/installments`, admin)).json;
    expect(list[0].billed).toBe(false);

    const rebill = await api(`/contracts/${contractId}/installments/${firstId}/bill`, admin, {
      productId: serviceId,
      docDate: TODAY,
    });
    expect(rebill.status).toBe(201);
    expect(rebill.json.id).not.toBe(saleId);
  });

  it("沒連結交易對象的合約開不了單，422 指路", async () => {
    const cid = (await api("/contracts", admin, {
      counterparty: "口頭客戶（未建檔）",
      title: "未連結對象的約",
      startDate: TODAY,
    })).json.id;
    const inst = (await api(`/contracts/${cid}/installments`, admin, {
      items: [{ dueDate: TODAY, amount: 1000 }],
    })).json[0];
    const res = await api(`/contracts/${cid}/installments/${inst.id}/bill`, admin, {
      productId: serviceId,
      docDate: TODAY,
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("沒有連結交易對象");
  });
});

describe("月費排程產生器", () => {
  let retainerId: number;

  beforeAll(async () => {
    retainerId = (await api("/contracts", admin, {
      partnerId,
      counterparty: "藍圖診所管理顧問案客戶",
      title: "行銷顧問月費約",
      kind: "retainer",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    })).json.id;
  });

  it("一年月費一鍵展開 12 期；大小月取月底（31 號約在 2 月＝2/28）", async () => {
    const res = await api(`/contracts/${retainerId}/installments/generate`, admin, {
      monthlyAmount: 50000,
      dayOfMonth: 31,
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(res.status).toBe(201);
    expect(res.json).toHaveLength(12);
    expect(res.json[0].dueDate).toBe("2026-01-31");
    expect(res.json[1].dueDate).toBe("2026-02-28");
    expect(res.json[3].dueDate).toBe("2026-04-30");
  });

  it("起迄年份打錯（一次生出上百期）要擋下，訊息講出會產生幾期", async () => {
    const res = await api(`/contracts/${retainerId}/installments/generate`, admin, {
      monthlyAmount: 50000,
      dayOfMonth: 1,
      from: "2026-01-01",
      to: "2036-12-31",
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("132 期");
  });
});

describe("待請款（billing-due）", () => {
  it("逾期在前、只列時間窗內的未請款期；已請款與非 active 合約不出現", async () => {
    // 造一個逾期的期（昨天）＋一個遠期的期（超出 30 天窗）
    const cid = (await api("/contracts", admin, {
      partnerId,
      counterparty: "藍圖診所管理顧問案客戶",
      title: "維護約",
      kind: "maintenance",
      startDate: "2026-01-01",
    })).json.id;
    await api(`/contracts/${cid}/installments`, admin, {
      items: [
        { dueDate: daysFromNow(-1), amount: 8000, description: "上月維護費（逾期）" },
        { dueDate: daysFromNow(90), amount: 8000, description: "遠期" },
      ],
    });
    const due = (await api("/contracts/billing-due?within=30", admin)).json;
    const mine = due.filter((d: { contractId: number }) => d.contractId === cid);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ description: "上月維護費（逾期）", overdue: true });
    // 排序：逾期（日期最早）在前
    expect(due[0].dueDate <= due.at(-1).dueDate).toBe(true);

    // 終止合約後就不再出現在待請款
    await api(`/contracts/${cid}`, admin, { status: "terminated" }, "PATCH");
    const after = (await api("/contracts/billing-due?within=30", admin)).json;
    expect(after.filter((d: { contractId: number }) => d.contractId === cid)).toHaveLength(0);
  });
});

describe("續約成鏈", () => {
  it("續約建立新約、指回前身、前身自動 ended；已終止的合約不能續", async () => {
    const oldId = (await api("/contracts", admin, {
      partnerId,
      counterparty: "藍圖診所管理顧問案客戶",
      title: "年度維護合約",
      kind: "maintenance",
      amount: 96000,
      startDate: "2025-08-01",
      endDate: "2026-07-31",
    })).json.id;

    const renewed = await api(`/contracts/${oldId}/renew`, admin, {
      startDate: "2026-08-01",
      endDate: "2027-07-31",
      amount: 108000, // 調價
    });
    expect(renewed.status).toBe(201);
    expect(renewed.json).toMatchObject({ renewedFromId: oldId, amount: 108000, kind: "maintenance", status: "active" });

    const contracts = (await api("/contracts", admin)).json;
    expect(contracts.find((x: { id: number }) => x.id === oldId).status).toBe("ended");

    // 已終止的不能續約（終止是雙方合意的結束）
    const dead = (await api("/contracts", admin, {
      counterparty: "某某", title: "被終止的", startDate: "2026-01-01", status: "terminated",
    })).json.id;
    expect((await api(`/contracts/${dead}/renew`, admin, { startDate: TODAY })).status).toBe(409);
  });
});

describe("進貨合約（0046：方向欄＋勾對付款——鏡像但不對稱）", () => {
  let supplierId: number;
  let otherSupplierId: number;
  let itemId: number;
  let pcId: number; // 進貨合約
  let inst1: number;
  let inst2: number;
  let purchaseA: number;
  let purchaseOther: number;

  it("登記進貨合約＋排付款計畫；開請款單被擋並指路勾對", async () => {
    supplierId = (await api("/partners", admin, { name: "雲端軟體授權供應商", isSupplier: true })).json.id;
    otherSupplierId = (await api("/partners", admin, { name: "別家供應商", isSupplier: true })).json.id;
    itemId = (await api("/products", admin, { sku: "LIC-SAAS", name: "軟體授權", unit: "式" })).json.id;
    const res = await api("/contracts", admin, {
      partnerId: supplierId,
      counterparty: "雲端軟體授權供應商",
      title: "年度軟體授權（對方賣我）",
      direction: "purchase",
      kind: "maintenance",
      amount: 240000,
      startDate: TODAY,
    });
    expect(res.status).toBe(201);
    expect(res.json.direction).toBe("purchase");
    pcId = res.json.id;
    const insts = (await api(`/contracts/${pcId}/installments`, admin, {
      items: [
        { dueDate: TODAY, amount: 120000, description: "上半年授權費" },
        { dueDate: daysFromNow(10), amount: 120000, description: "下半年授權費" },
      ],
    })).json;
    inst1 = insts[0].id;
    inst2 = insts[1].id;
    const bill = await api(`/contracts/${pcId}/installments/${inst1}/bill`, admin, { productId: itemId, docDate: TODAY });
    expect(bill.status).toBe(409);
    expect(bill.json.error).toContain("勾對");
  });

  it("勾對：供應商不符 422；成功後鎖住（不能改/刪/重勾）；一張單只能勾一期", async () => {
    purchaseA = (await api("/purchases", admin, {
      partnerId: supplierId, docDate: TODAY, lines: [{ productId: itemId, qty: 1, unitPrice: 120000 }],
    })).json.id;
    purchaseOther = (await api("/purchases", admin, {
      partnerId: otherSupplierId, docDate: TODAY, lines: [{ productId: itemId, qty: 1, unitPrice: 99 }],
    })).json.id;

    const wrong = await api(`/contracts/${pcId}/installments/${inst1}/match`, admin, { purchaseId: purchaseOther });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error).toContain("供應商");

    const ok = await api(`/contracts/${pcId}/installments/${inst1}/match`, admin, { purchaseId: purchaseA });
    expect(ok.status).toBe(200);
    const row1 = ok.json.find((i: { id: number }) => i.id === inst1);
    expect(row1).toMatchObject({ purchaseId: purchaseA, billed: true, saleId: null });

    // 同一張進貨單不能再勾另一期（重複認列付款義務）
    const dup = await api(`/contracts/${pcId}/installments/${inst2}/match`, admin, { purchaseId: purchaseA });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toContain("只能勾一期");
    // 已勾對的期：不能改、不能刪、不能重勾
    expect((await api(`/contracts/${pcId}/installments/${inst1}`, admin, { amount: 1 }, "PATCH")).status).toBe(409);
    expect((await api(`/contracts/${pcId}/installments/${inst1}`, admin, undefined, "DELETE")).status).toBe(409);
    expect((await api(`/contracts/${pcId}/installments/${inst1}/match`, admin, { purchaseId: purchaseOther })).status).toBe(409);
  });

  it("解除勾對回到未對上（勾對是指標不是單據）；銷貨合約沒有勾對", async () => {
    const un = await api(`/contracts/${pcId}/installments/${inst1}/unmatch`, admin, {});
    expect(un.status).toBe(200);
    expect(un.json.find((i: { id: number }) => i.id === inst1)).toMatchObject({ purchaseId: null, billed: false });
    // 銷貨合約（beforeAll 那份）的期別走 bill 不走 match
    const saleInsts = (await api(`/contracts/${contractId}/installments`, admin)).json;
    const anyInst = saleInsts[0].id;
    expect((await api(`/contracts/${contractId}/installments/${anyInst}/match`, admin, { purchaseId: purchaseA })).status).toBe(409);
  });

  it("待付款清單：direction=purchase；進貨單作廢後該期自動回列", async () => {
    const due0 = (await api("/contracts/billing-due?within=30", admin)).json
      .filter((d: { contractId: number }) => d.contractId === pcId);
    expect(due0).toHaveLength(2); // 兩期都未對上
    expect(due0.every((d: { direction: string }) => d.direction === "purchase")).toBe(true);

    await api(`/contracts/${pcId}/installments/${inst1}/match`, admin, { purchaseId: purchaseA });
    const due1 = (await api("/contracts/billing-due?within=30", admin)).json
      .filter((d: { contractId: number }) => d.contractId === pcId);
    expect(due1).toHaveLength(1);

    const voided = await api(`/purchases/${purchaseA}/void`, admin, { reason: "供應商重開發票" });
    expect(voided.status).toBe(200);
    const due2 = (await api("/contracts/billing-due?within=30", admin)).json
      .filter((d: { contractId: number }) => d.contractId === pcId);
    expect(due2).toHaveLength(2); // 作廢＝視同未對上，回到待付款
  });

  it("已對上過單據（含指向已作廢單）的合約不能翻方向；乾淨的可以", async () => {
    const flip = await api(`/contracts/${pcId}`, admin, { direction: "sale" }, "PATCH");
    expect(flip.status).toBe(409);
    const cleanId = (await api("/contracts", admin, {
      counterparty: "登記錯方向的", title: "方向可修", startDate: TODAY,
    })).json.id;
    const fixed = await api(`/contracts/${cleanId}`, admin, { direction: "purchase" }, "PATCH");
    expect(fixed.status).toBe(200);
    expect(fixed.json.direction).toBe("purchase");
  });

  it("續約帶方向：進貨合約續出來還是進貨合約", async () => {
    const renewed = await api(`/contracts/${pcId}/renew`, admin, { startDate: daysFromNow(365) });
    expect(renewed.status).toBe(201);
    expect(renewed.json.direction).toBe("purchase");
  });
});

describe("權限", () => {
  it("業務看得到合約與待請款（唯讀），但排計畫與開單 403", async () => {
    await api("/users", admin, { username: "sal", displayName: "業務", password: "secret-test", role: "sales" });
    const sal = await loginAs(app, "sal", "secret-test");
    expect((await api("/contracts", sal)).status).toBe(200);
    expect((await api("/contracts/billing-due", sal)).status).toBe(200);
    expect((await api(`/contracts/${contractId}/installments`, sal)).status).toBe(200);
    expect(
      (await api(`/contracts/${contractId}/installments`, sal, { items: [{ dueDate: TODAY, amount: 1 }] })).status,
    ).toBe(403);
    expect((await api(`/contracts/${contractId}/renew`, sal, { startDate: TODAY })).status).toBe(403);
  });
});
