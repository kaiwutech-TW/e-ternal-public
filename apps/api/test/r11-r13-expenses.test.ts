/**
 * 費用報銷三段補課（R11/R12/R13，migration 0036）＋R21 權限收緊驗收。
 * - R11：作廢（反向傳票＋401 排除＋發票號碼釋出）、退回重送、自我核准把關、
 *        users.employee_id 查重
 * - R12：憑證影像下載端點、報銷 CSV 匯出
 * - R13：待付彙總（公司欠員工）、paidBy 公司支付、dashboard 待付報銷
 * - R21：合約唯讀開放 sales/purchasing、員工主檔寫入限 finance/admin
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
let fin: Record<string, string>; // 財務，連結員工「張會計」
let fin2: Record<string, string>; // 第二個財務，未連結員工
let emp: Record<string, string>; // 員工角色，連結「王小明」
let sal: Record<string, string>; // 業務
let pur: Record<string, string>; // 採購
let empWang: number;
let empChang: number;
let cashAccountId: number;

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

/** 一筆可扣抵統編電子發票的報銷單（金額 1050 → 稅 50） */
function claimBody(invoiceNumber: string, extra: Record<string, unknown> = {}) {
  return {
    claimDate: "2026-07-10",
    items: [
      {
        accountCode: "6131",
        description: "高鐵",
        docType: "einvoice",
        amount: 1050,
        deductible: true,
        invoiceNumber,
        invoiceDate: "2026-07-05",
        sellerTaxId: "04541302",
      },
    ],
    ...extra,
  };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
  await app.request("/company-profile", {
    method: "PUT",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ name: "測試公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A" }),
  });
  empWang = (await api("/employees", admin, { name: "王小明" })).json.id;
  empChang = (await api("/employees", admin, { name: "張會計" })).json.id;
  const users = [
    { username: "fin", role: "finance", employeeId: empChang },
    { username: "fin2", role: "finance" },
    { username: "wang", role: "employee", employeeId: empWang },
    { username: "sal", role: "sales" },
    { username: "pur", role: "purchasing" },
  ];
  for (const u of users) {
    expect((await api("/users", admin, { ...u, displayName: u.username, password: "secret-test" })).status).toBe(201);
  }
  fin = await loginAs(app, "fin", "secret-test");
  fin2 = await loginAs(app, "fin2", "secret-test");
  emp = await loginAs(app, "wang", "secret-test");
  sal = await loginAs(app, "sal", "secret-test");
  pur = await loginAs(app, "pur", "secret-test");
  cashAccountId = (await api("/accounts", admin)).json.find((a: { code: string }) => a.code === "1101").id;
});

describe("R11① 作廢：反向傳票、401 排除、發票號碼釋出", () => {
  let claimId: number;

  it("submitted 不可作廢（指路退回）；核准後作廢產生反向傳票、2201 沖平", async () => {
    const created = await api("/expense-claims", fin, claimBody("AA10000001", { employeeId: empWang }));
    expect(created.status).toBe(201);
    claimId = created.json.id;
    expect((await api(`/expense-claims/${claimId}/void`, fin, { reason: "還沒核准" })).status).toBe(409);

    expect((await api(`/expense-claims/${claimId}/approve`, fin, {})).status).toBe(200);
    const voided = await api(`/expense-claims/${claimId}/void`, fin, { reason: "金額多打一個 0" });
    expect(voided.status).toBe(200);
    expect(voided.json.voidedAt).toBeTruthy();
    expect(voided.json.reversalEntryId).toBeTruthy();
    // status 保持原值（「它曾被核准」是事實），彙總以 voided_at 排除
    expect(voided.json.status).toBe("approved");

    const tb = await api("/trial-balance", fin);
    expect(tb.json.totalDebit).toBe(tb.json.totalCredit);
    const otherPayable = tb.json.rows.find((r: { code: string }) => r.code === "2201");
    expect(otherPayable.debit).toBe(otherPayable.credit); // 反向傳票沖平
  });

  it("作廢後 401 不再含該進項；已作廢不可付款、不可再作廢", async () => {
    const ret = await api("/vat-returns/401?period=202607", fin);
    expect(ret.json.summary.inputExpense).toBe(0);
    expect(ret.json.mediaFile.content).not.toContain("AA10000001");
    expect((await api(`/expense-claims/${claimId}/pay`, fin, { accountId: cashAccountId })).status).toBe(409);
    expect((await api(`/expense-claims/${claimId}/void`, fin, { reason: "再一次" })).status).toBe(409);
  });

  it("作廢後同號發票可重新列報（作廢重開是正常出路）", async () => {
    const again = await api("/expense-claims", fin, claimBody("AA10000001", { employeeId: empWang }));
    expect(again.status).toBe(201);
    // 收尾：退回這張，避免影響後面 401 斷言
    expect((await api(`/expense-claims/${again.json.id}/reject`, fin, { reason: "測試收尾" })).status).toBe(200);
  });

  it("已付款的單作廢：付款傳票一併沖回（現金也歸位）", async () => {
    const created = await api("/expense-claims", fin, claimBody("AA10000002", { employeeId: empWang, claimDate: "2026-07-11" }));
    const id = created.json.id;
    expect((await api(`/expense-claims/${id}/approve`, fin, {})).status).toBe(200);
    expect((await api(`/expense-claims/${id}/pay`, fin, { accountId: cashAccountId, payDate: "2026-07-15" })).status).toBe(200);
    const voided = await api(`/expense-claims/${id}/void`, fin, { reason: "整張登錯" });
    expect(voided.status).toBe(200);
    expect(voided.json.paidReversalEntryId).toBeTruthy();
    const tb = await api("/trial-balance", fin);
    const cash = tb.json.rows.find((r: { code: string }) => r.code === "1101");
    expect(cash.debit).toBe(cash.credit); // 付出去的現金沖回
  });

  it("作廢限財務/管理者：員工對自己的單也 403", async () => {
    const created = await api("/expense-claims", emp, claimBody("AA10000003", { claimDate: "2026-07-12" }));
    expect(created.status).toBe(201);
    expect((await api(`/expense-claims/${created.json.id}/void`, emp, { reason: "我要撤回" })).status).toBe(403);
  });
});

describe("R11② 自我核准把關＋核准留痕", () => {
  it("財務不能核准/退回自己送的單（409）；其他財務可核准並留 approved_by", async () => {
    const own = await api("/expense-claims", fin, claimBody("AB20000001", { claimDate: "2026-07-13" }));
    expect(own.status).toBe(201);
    expect(own.json.employeeId).toBe(empChang); // 未指定 employeeId＝本人
    const self = await api(`/expense-claims/${own.json.id}/approve`, fin, {});
    expect(self.status).toBe(409);
    expect(self.json.error).toMatch(/自己送的報銷單/);
    expect((await api(`/expense-claims/${own.json.id}/reject`, fin, { reason: "自己退" })).status).toBe(409);

    const approved = await api(`/expense-claims/${own.json.id}/approve`, fin2, {});
    expect(approved.status).toBe(200);
    expect(approved.json.approvedByUserId).toBeTruthy();
    expect(approved.json.approvedAt).toBeTruthy();
  });

  it("admin 例外放行（一人公司出路；audit 與 approved_by 都留痕）", async () => {
    // 把 admin 連上一個員工，親自送單再自己核准
    const empBoss = (await api("/employees", admin, { name: "老闆" })).json.id;
    const me = (await api("/auth/me", admin)).json;
    expect((await api(`/users/${me.id}`, admin, { employeeId: empBoss }, "PATCH")).status).toBe(200);
    const own = await api("/expense-claims", admin, claimBody("AB20000002", { claimDate: "2026-07-14" }));
    expect(own.json.employeeId).toBe(empBoss);
    expect((await api(`/expense-claims/${own.json.id}/approve`, admin, {})).status).toBe(200);
  });
});

describe("R11③ 退回重送", () => {
  it("rejected 可改明細重送：回 submitted、總額重算、原退回原因清掉；同單發票號不自撞", async () => {
    const created = await api("/expense-claims", emp, claimBody("AC30000001", { claimDate: "2026-07-16" }));
    const id = created.json.id;
    expect((await api(`/expense-claims/${id}/reject`, fin, { reason: "金額打錯" })).status).toBe(200);

    const resubmitted = await api(
      `/expense-claims/${id}`,
      emp,
      {
        claimDate: "2026-07-16",
        items: [
          {
            accountCode: "6131",
            description: "高鐵（改）",
            docType: "einvoice",
            amount: 2100,
            deductible: true,
            invoiceNumber: "AC30000001", // 沿用同號＝改自己的單，不該被 R5 擋
            invoiceDate: "2026-07-05",
            sellerTaxId: "04541302",
          },
        ],
      },
      "PATCH",
    );
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.json.status).toBe("submitted");
    expect(resubmitted.json.total).toBe(2100);
    expect(resubmitted.json.rejectReason).toBeNull();
    const detail = await api(`/expense-claims/${id}`, emp);
    expect(detail.json.items).toHaveLength(1);
    expect(detail.json.items[0].tax).toBe(100); // 2100 − round(2100/1.05)
  });

  it("submitted/approved 不可 PATCH（409）；別人的單 403", async () => {
    const mine = await api("/expense-claims", emp, {
      claimDate: "2026-07-17",
      items: [{ accountCode: "6132", docType: "receipt", amount: 80 }],
    });
    const patchBody = { claimDate: "2026-07-17", items: [{ accountCode: "6132", docType: "receipt" as const, amount: 90 }] };
    expect((await api(`/expense-claims/${mine.json.id}`, emp, patchBody, "PATCH")).status).toBe(409);
    // fin2 的單，wang 改不了（403 在所有權檢查，早於狀態檢查）
    const other = await api("/expense-claims", fin2, { ...patchBody, employeeId: empChang, items: patchBody.items });
    expect(other.status).toBe(201);
    expect((await api(`/expense-claims/${other.json.id}`, emp, patchBody, "PATCH")).status).toBe(403);
  });
});

describe("R11④ users.employee_id 查重", () => {
  it("POST：連結已被占用的員工 409（訊息講出是誰占的）", async () => {
    const res = await api("/users", admin, {
      username: "wang2",
      displayName: "第二個王",
      password: "secret-test",
      role: "employee",
      employeeId: empWang,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("wang");
  });

  it("PATCH：把既有使用者改連到已占用的員工也 409；改回自己原本的連結不受影響", async () => {
    const users = (await api("/users", admin)).json;
    const fin2Row = users.find((u: { username: string }) => u.username === "fin2");
    const wangRow = users.find((u: { username: string }) => u.username === "wang");
    expect((await api(`/users/${fin2Row.id}`, admin, { employeeId: empWang }, "PATCH")).status).toBe(409);
    // 自己 PATCH 自己已連的員工（excludeUserId）不誤擋
    expect((await api(`/users/${wangRow.id}`, admin, { employeeId: empWang }, "PATCH")).status).toBe(200);
  });
});

describe("R12 附件下載與 CSV 匯出", () => {
  let claimId: number;
  let itemId: number;

  beforeAll(async () => {
    const created = await api("/expense-claims", emp, {
      claimDate: "2026-07-18",
      items: [
        {
          accountCode: "6133",
          description: "文具",
          docType: "receipt",
          amount: 150,
          image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
        },
      ],
    });
    claimId = created.json.id;
    itemId = (await api(`/expense-claims/${claimId}`, emp)).json.items[0].id;
  });

  it("影像端點：本人與財務可取（回 data URI），其他員工 403，無影像 404", async () => {
    const own = await api(`/expense-claims/${claimId}/items/${itemId}/image`, emp);
    expect(own.status).toBe(200);
    expect(own.json.image).toMatch(/^data:image\/png;base64,/);
    expect(own.json.fileName).toContain(`報銷單${claimId}`);
    expect((await api(`/expense-claims/${claimId}/items/${itemId}/image`, fin)).status).toBe(200);

    // 另一個員工帳號看不到（403）：報銷影像是個人資料
    const empLi2 = (await api("/employees", admin, { name: "路人" })).json.id;
    await api("/users", admin, { username: "lilu", displayName: "路人", password: "secret-test", role: "employee", employeeId: empLi2 });
    const other = await loginAs(app, "lilu", "secret-test");
    expect((await api(`/expense-claims/${claimId}/items/${itemId}/image`, other)).status).toBe(403);

    // 無影像的明細 404
    const noImg = await api("/expense-claims", emp, {
      claimDate: "2026-07-18",
      items: [{ accountCode: "6132", docType: "receipt", amount: 60 }],
    });
    const noImgItem = (await api(`/expense-claims/${noImg.json.id}`, emp)).json.items[0].id;
    expect((await api(`/expense-claims/${noImg.json.id}/items/${noImgItem}/image`, emp)).status).toBe(404);
  });

  it("CSV 匯出：含發票欄位與傳票號；已作廢標注、退回不列；exports 權限（sales 403）", async () => {
    const res = await api("/exports/expense-claims?from=2026-07-01&to=2026-07-31", fin);
    expect(res.status).toBe(200);
    expect(res.json.name).toContain("費用報銷");
    const content: string = res.json.content;
    expect(content).toContain("發票號碼");
    expect(content).toContain("AA10000002"); // 已作廢的照列……
    expect(content).toContain("已作廢"); // ……並標注
    expect(content).toContain("AB20000001"); // fin 自送、fin2 核准的那張
    expect(content).not.toContain("測試收尾"); // rejected 不列（那張的退回理由）
    expect(content).toContain("6131 交通與差旅"); // 分類帶代號＋名稱
    expect((await api("/exports/expense-claims?from=2026-07-01&to=2026-07-31", sal)).status).toBe(403);
  });
});

describe("R13 代墊追蹤與公司支付", () => {
  it("payable-summary：approved 未付依員工彙總；作廢/已付/待核不計；employee 403", async () => {
    const summary = await api("/expense-claims/payable-summary", fin);
    expect(summary.status).toBe(200);
    // 目前 approved 未付：AB20000001（張會計 1050）＋AB20000002（老闆 1050）
    expect(summary.json.count).toBe(2);
    expect(summary.json.amount).toBe(2100);
    const chang = summary.json.byEmployee.find((r: { employeeName: string }) => r.employeeName === "張會計");
    expect(chang).toMatchObject({ count: 1, amount: 1050 });
    expect((await api("/expense-claims/payable-summary", emp)).status).toBe(403);
  });

  it("清單 status 篩選：approved 只回未作廢的已核准單", async () => {
    const rows = (await api("/expense-claims?status=approved", fin)).json;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.voidedAt).toBeNull();
    expect((await api("/expense-claims?status=nonsense", fin)).status).toBe(400);
  });

  it("公司支付：核准要指定付款科目（缺→422），核准即 paid、貸方是該科目", async () => {
    const created = await api("/expense-claims", emp, claimBody("AD40000001", { claimDate: "2026-07-19", paidBy: "company" }));
    expect(created.status).toBe(201);
    expect(created.json.paidBy).toBe("company");
    const id = created.json.id;
    expect((await api(`/expense-claims/${id}/approve`, fin, {})).status).toBe(422);

    // 建一個公司卡負債科目當付款科目（isCash 只准資產類，公司卡本來就該是負債）
    const card = await api("/accounts", admin, { code: "2205", name: "應付卡費（公司卡）", type: "liability" });
    expect(card.status).toBe(201);
    const approved = await api(`/expense-claims/${id}/approve`, fin, { accountId: card.json.id });
    expect(approved.status).toBe(200);
    expect(approved.json.status).toBe("paid"); // 不經過「其他應付款→付款」兩段
    expect(approved.json.paidJournalEntryId).toBe(approved.json.journalEntryId);

    const entry = await api(`/journal-entries/${approved.json.journalEntryId}`, fin);
    const cardLine = entry.json.lines.find((l: { code: string }) => l.code === "2205");
    expect(cardLine).toMatchObject({ credit: 1050 });
    // 進項稅照樣進 401（公司卡費用走報銷的意義所在）
    const ret = await api("/vat-returns/401?period=202607", fin);
    expect(ret.json.mediaFile.content).toContain("AD40000001");
  });

  it("公司支付的付款科目不能亂選（費用科目 422）；dashboard 有待付報銷", async () => {
    const created = await api("/expense-claims", emp, claimBody("AD40000002", { claimDate: "2026-07-20", paidBy: "company" }));
    const bad = await api(`/expense-claims/${created.json.id}/approve`, fin, {
      accountId: (await api("/accounts", fin)).json.find((a: { code: string }) => a.code === "6131").id,
    });
    expect(bad.status).toBe(422);

    const dash = await api(`/reports/dashboard?asOf=2026-07-31`, fin);
    expect(dash.json.approvedUnpaidClaims).toMatchObject({ count: 2, amount: 2100 });
  });
});

describe("R21 權限：合約唯讀開放、員工寫入收緊", () => {
  it("sales/purchasing 可讀合約（含附件端點）、不可寫", async () => {
    const created = await api("/contracts", fin, {
      counterparty: "房東", title: "辦公室租約", startDate: "2026-01-01", endDate: "2026-12-31",
      fileName: "lease.pdf", fileData: "data:application/pdf;base64,JVBERi0=",
    });
    expect(created.status).toBe(201);
    for (const who of [sal, pur]) {
      expect((await api("/contracts", who)).status).toBe(200);
      expect((await api(`/contracts/${created.json.id}/file`, who)).status).toBe(200);
      expect((await api("/contracts", who, { counterparty: "x", title: "y", startDate: "2026-01-01" })).status).toBe(403);
      expect((await api(`/contracts/${created.json.id}`, who, { amount: 999 }, "PATCH")).status).toBe(403);
    }
    // gm 在 ROLE_PAGES 本來就有 contracts：仍可讀
    // finance 寫入照舊（上面 201 已證）
  });

  it("sales/purchasing 讀得到員工名冊、寫不進去（403）；finance 可寫", async () => {
    for (const who of [sal, pur]) {
      expect((await api("/employees", who)).status).toBe(200);
      expect((await api("/employees", who, { name: "業務私建員工" })).status).toBe(403);
      expect((await api(`/employees/${empWang}`, who, { title: "亂改" }, "PATCH")).status).toBe(403);
    }
    expect((await api("/employees", fin, { name: "財務建的員工" })).status).toBe(201);
  });
});
