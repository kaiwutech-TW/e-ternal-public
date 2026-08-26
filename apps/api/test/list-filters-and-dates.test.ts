/**
 * R3 清單篩選分頁＋R2 日期驗證（第四批）驗收：
 * - 九個清單端點收 from/to/partnerId/limit/offset；回應形狀不變（仍是陣列），
 *   總筆數在 X-Total-Count；無效參數 400 出聲（不再靜默回全表）
 * - listOrders/listPurchaseOrders N+1 修正的行為迴歸（partnerName/lines/saleIds 形狀不變）
 * - 未來日期超過今天＋1 年 → 422；補登過去日期照常 201
 * - 單據內日期先後矛盾 → 422，訊息點名兩個日期
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
let customerAId = 0;
let customerBId = 0;
let supplierId = 0;
let productId = 0;
let cashAccountId = 0;

/** 今天＋n 年的 YYYY-MM-DD（未來日期檢查的門檻是今天＋1 年，測試用今天＋2 年必超標） */
function yearsFromNow(n: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + n);
  return d.toISOString().slice(0, 10);
}

async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
): Promise<{ status: number; json: any; totalCount: string | null }> {
  const res = await app.request(path, {
    method,
    headers: { ...admin, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    totalCount: res.headers.get("x-total-count"),
  };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  customerAId = (await api("/partners", { name: "客戶Ａ", isCustomer: true })).json.id;
  customerBId = (await api("/partners", { name: "客戶Ｂ", isCustomer: true })).json.id;
  supplierId = (await api("/partners", { name: "供應商", isSupplier: true })).json.id;
  productId = (await api("/products", { sku: "LF-1", name: "篩選測試品" })).json.id;
  cashAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1103").id;
  // 備庫存
  await api("/purchases", {
    partnerId: supplierId,
    docDate: "2026-01-05",
    lines: [{ productId, qty: 500, unitPrice: 100 }],
  });
  // 三張銷貨單：兩個客戶、三個日期（R3 篩選組合的素材）
  for (const [partnerId, docDate] of [
    [customerAId, "2026-02-10"],
    [customerBId, "2026-03-15"],
    [customerAId, "2026-04-20"],
  ] as const) {
    const res = await api("/sales", { partnerId, docDate, lines: [{ productId, qty: 1, unitPrice: 200 }] });
    expect(res.status).toBe(201);
  }
});

describe("R3：/sales 篩選、分頁與 X-Total-Count", () => {
  it("無參數：回全部（陣列形狀不變），X-Total-Count=3，新到舊排序", async () => {
    const res = await api("/sales");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect(res.json).toHaveLength(3);
    expect(res.totalCount).toBe("3");
    // 新到舊：id 遞減（原本沒有 orderBy，作廢一張之後順序會漂移）
    const ids = res.json.map((r: { id: number }) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("from/to 日期範圍（含兩端）", async () => {
    const res = await api("/sales?from=2026-03-01&to=2026-03-31");
    expect(res.json).toHaveLength(1);
    expect(res.json[0].docDate).toBe("2026-03-15");
    expect(res.totalCount).toBe("1");
  });

  it("partnerId 篩選＋日期組合", async () => {
    const byPartner = await api(`/sales?partnerId=${customerAId}`);
    expect(byPartner.json).toHaveLength(2);
    const combo = await api(`/sales?partnerId=${customerAId}&from=2026-04-01`);
    expect(combo.json).toHaveLength(1);
    expect(combo.json[0].docDate).toBe("2026-04-20");
  });

  it("limit/offset 分頁：形狀仍是陣列，X-Total-Count 是全量筆數", async () => {
    const page = await api("/sales?limit=1&offset=1");
    expect(page.json).toHaveLength(1);
    expect(page.totalCount).toBe("3");
    const all = await api("/sales");
    expect(page.json[0].id).toBe(all.json[1].id); // offset=1 → 第二新的那張
  });

  it("不存在的 partnerId：回空陣列＋總數 0，不再靜默回全表", async () => {
    const res = await api("/sales?partnerId=999999");
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
    expect(res.totalCount).toBe("0");
  });

  it("無效參數 400 出聲：壞日期、範圍顛倒、非整數 partnerId、limit 超界", async () => {
    expect((await api("/sales?from=2026-13-45")).status).toBe(400);
    const flipped = await api("/sales?from=2026-05-01&to=2026-01-01");
    expect(flipped.status).toBe(400);
    expect(flipped.json.error).toContain("顛倒");
    expect((await api("/sales?partnerId=abc")).status).toBe(400);
    expect((await api("/sales?limit=0")).status).toBe(400);
    expect((await api("/sales?limit=9999")).status).toBe(400);
  });
});

describe("R3：其餘清單端點", () => {
  it("/purchases 與 /cash-docs 支援 partnerId＋X-Total-Count", async () => {
    const p = await api(`/purchases?partnerId=${supplierId}`);
    expect(p.json).toHaveLength(1);
    expect(p.totalCount).toBe("1");

    const receipt = await api("/cash-docs", {
      kind: "receipt", partnerId: customerAId, docDate: "2026-05-01", amount: 100, accountId: cashAccountId,
    });
    expect(receipt.status).toBe(201);
    const cd = await api(`/cash-docs?partnerId=${customerAId}&from=2026-05-01&to=2026-05-31`);
    expect(cd.json).toHaveLength(1);
    expect(cd.totalCount).toBe("1");
    expect((await api(`/cash-docs?partnerId=${customerBId}`)).json).toHaveLength(0);
  });

  it("/journal-entries：from/to＋limit，totalDebit 形狀不變；partnerId → 400 指路", async () => {
    const all = await api("/journal-entries");
    expect(all.status).toBe(200);
    expect(Number(all.totalCount)).toBeGreaterThanOrEqual(4);
    expect(all.json[0]).toHaveProperty("totalDebit");
    const page = await api("/journal-entries?limit=2");
    expect(page.json).toHaveLength(2);
    expect(Number(page.totalCount)).toBe(Number(all.totalCount));
    const bad = await api("/journal-entries?partnerId=1");
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("不支援 partnerId");
  });

  it("/invoices：X-Total-Count 存在；partnerId → 400 指路", async () => {
    const res = await api("/invoices");
    expect(res.status).toBe(200);
    expect(res.totalCount).toBe("0");
    expect((await api("/invoices?partnerId=1")).status).toBe(400);
  });

  it("/expense-claims：from/to 篩報銷單日期", async () => {
    const emp = await api("/employees", { name: "報銷員" });
    for (const claimDate of ["2026-02-01", "2026-06-01"]) {
      const res = await api("/expense-claims", {
        employeeId: emp.json.id, claimDate,
        items: [{ accountCode: "6132", docType: "receipt" as const, amount: 100 }],
      });
      expect(res.status).toBe(201);
    }
    const feb = await api("/expense-claims?from=2026-02-01&to=2026-02-28");
    expect(feb.json).toHaveLength(1);
    expect(feb.totalCount).toBe("1");
    expect((await api("/expense-claims")).totalCount).toBe("2");
  });
});

describe("R3＋N+1 迴歸：quotes/orders/purchase-orders 形狀不變", () => {
  let orderId = 0;
  let poId = 0;

  it("報價單：partnerName 與 lines 形狀不變、篩選生效", async () => {
    const q = await api("/quotes", {
      partnerId: customerAId, quoteDate: "2026-03-01",
      lines: [{ productId, qty: 2, unitPrice: 300 }],
    });
    expect(q.status).toBe(201);
    const list = await api(`/quotes?partnerId=${customerAId}`);
    expect(list.json).toHaveLength(1);
    expect(list.totalCount).toBe("1");
    expect(list.json[0].partnerName).toBe("客戶Ａ");
    expect(list.json[0].lines).toHaveLength(1);
    expect((await api(`/quotes?partnerId=${customerBId}`)).json).toHaveLength(0);
  });

  it("訂單：部分出貨後 partnerName/lines(productName,remainingQty)/saleIds 全在（N+1 改寫不變形）", async () => {
    const o = await api("/orders", {
      partnerId: customerBId, orderDate: "2026-03-05",
      lines: [{ productId, qty: 10, unitPrice: 250 }],
    });
    expect(o.status).toBe(201);
    orderId = o.json.id;
    const lineId = (await api("/orders")).json.find((r: { id: number }) => r.id === orderId).lines[0].id;
    const ship = await api(`/orders/${orderId}/ship`, {
      docDate: "2026-03-08",
      lines: [{ orderLineId: lineId, qty: 4 }],
    });
    expect(ship.status).toBe(201);

    const list = await api(`/orders?partnerId=${customerBId}&from=2026-03-01&to=2026-03-31`);
    expect(list.json).toHaveLength(1);
    const row = list.json[0];
    expect(row.partnerName).toBe("客戶Ｂ");
    expect(row.status).toBe("partial");
    expect(row.lines[0].productName).toBe("篩選測試品");
    expect(row.lines[0].remainingQty).toBe(6);
    expect(row.saleIds).toEqual([ship.json.saleId]);
  });

  it("採購單：收貨後 partnerName/lines/purchaseIds 全在、篩選生效", async () => {
    const po = await api("/purchase-orders", {
      partnerId: supplierId, orderDate: "2026-03-06",
      lines: [{ productId, qty: 8, unitPrice: 90 }],
    });
    expect(po.status).toBe(201);
    poId = po.json.id;
    const poLineId = (await api("/purchase-orders")).json.find((r: { id: number }) => r.id === poId).lines[0].id;
    const recv = await api(`/purchase-orders/${poId}/receive`, {
      docDate: "2026-03-09",
      lines: [{ poLineId, qty: 3 }],
    });
    expect(recv.status).toBe(201);

    const list = await api(`/purchase-orders?partnerId=${supplierId}&from=2026-03-01&to=2026-03-31`);
    expect(list.json).toHaveLength(1);
    const row = list.json[0];
    expect(row.partnerName).toBe("供應商");
    expect(row.lines[0].productName).toBe("篩選測試品");
    expect(row.lines[0].remainingQty).toBe(5);
    expect(row.purchaseIds).toEqual([recv.json.purchaseId]);
    expect(list.totalCount).toBe("1");
  });
});

describe("R2：未來日期超過今天＋1 年 → 422；補登過去日期照常", () => {
  const farFuture = yearsFromNow(2);

  it("銷貨／進貨／收付款／傳票／報價／訂單／採購單：未來日期 422，訊息講人話", async () => {
    const sale = await api("/sales", {
      partnerId: customerAId, docDate: farFuture, lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(sale.status).toBe(422);
    expect(sale.json.error).toContain("晚於今天");
    expect(sale.json.error).toContain(farFuture);

    expect((await api("/purchases", {
      partnerId: supplierId, docDate: farFuture, lines: [{ productId, qty: 1, unitPrice: 100 }],
    })).status).toBe(422);
    expect((await api("/cash-docs", {
      kind: "receipt", partnerId: customerAId, docDate: farFuture, amount: 100, accountId: cashAccountId,
    })).status).toBe(422);
    expect((await api("/journal-entries", {
      entryDate: farFuture, memo: "未來傳票",
      lines: [
        { accountCode: "1101", debit: 100, credit: 0 },
        { accountCode: "4101", debit: 0, credit: 100 },
      ],
    })).status).toBe(422);
    expect((await api("/quotes", {
      partnerId: customerAId, quoteDate: farFuture, lines: [{ productId, qty: 1, unitPrice: 100 }],
    })).status).toBe(422);
    expect((await api("/orders", {
      partnerId: customerAId, orderDate: farFuture, lines: [{ productId, qty: 1, unitPrice: 100 }],
    })).status).toBe(422);
    expect((await api("/purchase-orders", {
      partnerId: supplierId, orderDate: farFuture, lines: [{ productId, qty: 1, unitPrice: 100 }],
    })).status).toBe(422);
  });

  it("報銷單：claimDate 未來 422；補登過去日期照常 201", async () => {
    const emp = (await api("/employees")).json.find((e: { name: string }) => e.name === "報銷員");
    const future = await api("/expense-claims", {
      employeeId: emp.id, claimDate: farFuture,
      items: [{ accountCode: "6132", docType: "receipt" as const, amount: 100 }],
    });
    expect(future.status).toBe(422);
    expect(future.json.error).toContain("晚於今天");
    // 補登三年前的歷史報銷——過去日期一律放行
    const past = await api("/expense-claims", {
      employeeId: emp.id, claimDate: "2023-01-15",
      items: [{ accountCode: "6132", docType: "receipt" as const, amount: 100 }],
    });
    expect(past.status).toBe(201);
  });

  it("折舊：未來月份一個都不放行（跳過的期間永遠補不回）；過去月份照常", async () => {
    const asset = await api("/fixed-assets", {
      name: "折舊測試機", category: "computer", cost: 36000, startDate: "2025-01-10",
    });
    expect(asset.status).toBe(201);
    const past = await api("/depreciations/run", { period: "2025-01" });
    expect(past.status).toBe(201);
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const res = await api("/depreciations/run", { period: nextMonth.toISOString().slice(0, 7) });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("晚於本月");
    expect(res.json.error).toContain("補不回");
  });
});

describe("R2：單據內日期先後矛盾 → 422，訊息點名兩個日期", () => {
  it("合約：截止日早於生效日（POST 與單改 endDate 的 PATCH 都擋）", async () => {
    const bad = await api("/contracts", {
      counterparty: "測試對方", title: "倒著簽的合約",
      startDate: "2027-01-01", endDate: "2026-01-01",
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toContain("2026-01-01");
    expect(bad.json.error).toContain("2027-01-01");
    expect(bad.json.error).toContain("合約截止日");

    const ok = await api("/contracts", {
      counterparty: "測試對方", title: "正常合約",
      startDate: "2026-01-01", endDate: "2026-12-31",
    });
    expect(ok.status).toBe(201);
    // PATCH 只改 endDate 也要跟既有 startDate 比
    const patched = await api(`/contracts/${ok.json.id}`, { endDate: "2025-06-30" }, "PATCH");
    expect(patched.status).toBe(422);
    expect(patched.json.error).toContain("合約生效日");
  });

  it("期初應收付單：到期日早於原單日 → 422", async () => {
    const res = await api("/opening-balances", {
      kind: "receivable", partnerId: customerAId,
      entryDate: "2026-01-01", docDate: "2025-11-20", dueDate: "2025-10-01", amount: 5000,
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("2025-10-01");
    expect(res.json.error).toContain("2025-11-20");
  });

  it("收款單立沖：目標單據日期晚於收款日 → 422 點名兩個日期；不指定沖銷則掛預收", async () => {
    // 6/10 的銷貨；5/1 的收款要沖它 → 錢還沒到單先沖，422 並講清楚是哪兩個日期
    const sale = await api("/sales", {
      partnerId: customerBId, docDate: "2026-06-10", lines: [{ productId, qty: 1, unitPrice: 1000 }],
    });
    expect(sale.status).toBe(201);
    const alloc = await api("/cash-docs", {
      kind: "receipt", partnerId: customerBId, docDate: "2026-05-01", amount: 500, accountId: cashAccountId,
      allocations: [{ targetId: sale.json.id, amount: 500 }],
    });
    expect(alloc.status).toBe(422);
    expect(alloc.json.error).toContain("2026-06-10");
    expect(alloc.json.error).toContain("2026-05-01");
    // 不指定沖銷：同日期照樣收得了款，超過未沖單據的部分掛預收（0027 口徑）
    const plain = await api("/cash-docs", {
      kind: "receipt", partnerId: customerBId, docDate: "2026-05-01", amount: 500, accountId: cashAccountId,
    });
    expect(plain.status).toBe(201);
  });

  it("發票作廢日早於開立日 → 422（迴轉傳票不得落在原交易之前）", async () => {
    await api("/company-profile", {
      name: "篩選測試公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A",
    }, "PUT");
    await api("/invoice-tracks", { period: "202607", track: "LF", rangeStart: 10000000, rangeEnd: 10000099 });
    const sale = await api("/sales", {
      partnerId: customerAId, docDate: "2026-07-15", lines: [{ productId, qty: 1, unitPrice: 1000 }],
    });
    const inv = await api(`/sales/${sale.json.id}/invoice`, { mode: "B2C", randomNumber: "0042" });
    expect(inv.status).toBe(201);
    const cancel = await api(`/invoices/${inv.json.id}/cancel`, {
      reason: "測試日期矛盾", cancelDate: "2026-07-01",
    });
    expect(cancel.status).toBe(422);
    expect(cancel.json.error).toContain("2026-07-15");
    expect(cancel.json.error).toContain("2026-07-01");
    expect(cancel.json.error).toContain("作廢日期");
  });
});
