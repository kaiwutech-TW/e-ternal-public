/**
 * 費用報銷＋合約驗收：員工送出（統編發票可扣抵、交際費強制不可扣）→ 核准拋轉 → 401 納入 → 付款沖帳；
 * 合約登記/附件/狀態流轉。
 */
import { PGlite } from "@electric-sql/pglite";
import { VAT_RATE_FALLBACK, roundHalfUp } from "@tw-erp/core";
import { applyMigrations, schema } from "@tw-erp/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof drizzle>;
let auth: Record<string, string>;
let employeeId: number;
let claimId: number;
let cashAccountId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

/** 依規格拼一段電子發票證明聯左碼（前 77 碼定長）：金額是 8 碼 hex，日期是民國年 */
const leftQr = (o: {
  invoiceNumber?: string;
  rocDate?: string;
  sales?: number;
  total?: number;
  seller?: string;
  /** 買方統編；規格以全 0 表示未打統編。預設是本公司（下面的 company-profile 設的那個） */
  buyer?: string;
}) => {
  const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");
  return (
    (o.invoiceNumber ?? "AB12345678") +
    (o.rocDate ?? "1150718") + // ＝ 2026-07-18，下面每筆明細填的發票日期
    "1234" +
    hex8(o.sales ?? 0) +
    hex8(o.total ?? 0) +
    (o.buyer ?? "22099131") + // 買方統編（預設＝本公司）
    (o.seller ?? "04541302") +
    "0".repeat(24) + // 加密驗證區：本系統從未驗證它，測試也不假裝驗得了
    ":**********:1:1:1:測試品:1:1000"
  );
};

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);

  await app.request("/company-profile", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "測試公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A" }),
  });
  const emp = await api("/employees", { name: "王小明" });
  employeeId = emp.json.id;
  const accounts = await api("/accounts");
  cashAccountId = accounts.json.find((a: { code: string }) => a.code === "1101").id;
});

describe("費用報銷流程", () => {
  it("送出：統編電子發票計可扣抵稅額；交際費即使主張扣抵也強制不可", async () => {
    const res = await api("/expense-claims", {
      employeeId,
      claimDate: "2026-07-10",
      items: [
        {
          accountCode: "6131",
          description: "高鐵來回",
          docType: "einvoice",
          amount: 1050,
          deductible: true,
          invoiceNumber: "CD11223344",
          invoiceDate: "2026-07-05",
          sellerTaxId: "04541302",
        },
        {
          accountCode: "6137",
          description: "請客戶晚餐",
          docType: "einvoice",
          amount: 500,
          deductible: true, // 前端誤主張，伺服端須強制 false（依該分類目前的可扣抵性判定；預設值見 core 的 EXPENSE_CATEGORIES，可在稅法參數頁覆寫）
          invoiceNumber: "CD11223345",
          invoiceDate: "2026-07-06",
          sellerTaxId: "04541302",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.json.total).toBe(1550);
    expect(res.json.status).toBe("submitted");
    claimId = res.json.id;

    const detail = await api(`/expense-claims/${claimId}`);
    const travel = detail.json.items.find((i: { accountCode: string }) => i.accountCode === "6131");
    const dining = detail.json.items.find((i: { accountCode: string }) => i.accountCode === "6137");
    expect(travel).toMatchObject({ deductible: true, tax: 50 }); // 1050 − round(1050/1.05)=1000
    expect(dining).toMatchObject({ deductible: false, tax: 0 });
  });

  it("未核准前不進 401；核准後計入進項並產生費用傳票", async () => {
    const before = await api("/vat-returns/401?period=202607");
    expect(before.json.summary.inputExpense).toBe(0);

    const approved = await api(`/expense-claims/${claimId}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.json.journalEntryId).toBeTruthy();

    const entry = await api(`/journal-entries/${approved.json.journalEntryId}`);
    const line = (code: string) => entry.json.lines.find((l: { code: string }) => l.code === code);
    expect(line("6131")).toMatchObject({ debit: 1000 });
    expect(line("6137")).toMatchObject({ debit: 500 });
    expect(line("1288")).toMatchObject({ debit: 50 });
    expect(line("2201")).toMatchObject({ credit: 1550 });

    const after = await api("/vat-returns/401?period=202607");
    expect(after.json.summary.inputExpense).toBe(1000);
    expect(after.json.summary.inputExpenseTax).toBe(50);
    expect(after.json.mediaFile.content).toContain("CD11223344");
    expect(after.json.mediaFile.content).not.toContain("CD11223345"); // 交際費不可扣抵不申報
  });

  it("付款：沖其他應付款、試算表平衡；重複付款 409", async () => {
    const paid = await api(`/expense-claims/${claimId}/pay`, { accountId: cashAccountId, payDate: "2026-07-15" });
    expect(paid.status).toBe(200);
    expect(paid.json.status).toBe("paid");

    const tb = await api("/trial-balance");
    expect(tb.json.totalDebit).toBe(tb.json.totalCredit);
    const otherPayable = tb.json.rows.find((r: { code: string }) => r.code === "2201");
    expect(otherPayable.debit).toBe(otherPayable.credit); // 已沖平

    const again = await api(`/expense-claims/${claimId}/pay`, { accountId: cashAccountId });
    expect(again.status).toBe(409);
  });

  it("退回流程：submitted 才可退回", async () => {
    const claim = await api("/expense-claims", {
      employeeId,
      claimDate: "2026-07-11",
      items: [{ accountCode: "6188", docType: "receipt", amount: 80 }],
    });
    const rejected = await api(`/expense-claims/${claim.json.id}/reject`, { reason: "缺單據照片" });
    expect(rejected.status).toBe(200);
    expect(rejected.json.status).toBe("rejected");
    const approveAfter = await api(`/expense-claims/${claim.json.id}/approve`, {});
    expect(approveAfter.status).toBe(409);
  });

  it("核准時費用科目已停用要擋下（與手工傳票、收付款單、報銷付款同一條規則）", async () => {
    const claim = await api("/expense-claims", {
      employeeId,
      claimDate: "2026-07-12",
      items: [{ accountCode: "6188", docType: "receipt", amount: 120 }],
    });
    expect(claim.status).toBe(201);

    // 報銷單送出後、核准前，會計把這個費用科目停用（整理科目表的正常操作）。
    // 這裡直接改資料庫是因為 6188 是系統科目、PATCH 會擋停用——但升級上來的舊庫可能本來就是停用狀態，
    // 而核准這條路徑原本完全沒檢查，照樣把分錄寫進已停用的科目。
    await db.update(schema.accounts).set({ active: false }).where(eq(schema.accounts.code, "6188"));
    const blocked = await api(`/expense-claims/${claim.json.id}/approve`, {});
    expect(blocked.status).toBe(400);
    expect(blocked.json.error).toContain("已停用");
    expect(blocked.json.error).toContain("6188");

    // 沒有半筆漏進去，狀態也還停在 submitted（可退回或啟用科目後再核准）
    const still = await api(`/expense-claims/${claim.json.id}`);
    expect(still.json.status).toBe("submitted");
    expect(still.json.journalEntryId).toBeFalsy();

    await db.update(schema.accounts).set({ active: true }).where(eq(schema.accounts.code, "6188"));
    const ok = await api(`/expense-claims/${claim.json.id}/approve`, {});
    expect(ok.status).toBe(200);
  });

  it("核准：可扣抵發票日落在已關期間要擋——進項稅以發票日進 401，只鎖單據日等於無聲改已申報的期", async () => {
    // 收據累積兩個月才整理的真實情境：單據日 6 月（開放）、發票日 5 月（已關）
    const claim = await api("/expense-claims", {
      employeeId,
      claimDate: "2026-06-20",
      items: [
        {
          accountCode: "6131",
          description: "五月的雲端訂閱費",
          docType: "einvoice",
          amount: 1050,
          deductible: true,
          invoiceNumber: "XY99887766",
          invoiceDate: "2026-05-31",
          sellerTaxId: "22099131",
        },
      ],
    });
    expect(claim.status).toBe(201);
    expect((await api("/period-closes", { period: "2026-05" })).status).toBe(201);

    const blocked = await api(`/expense-claims/${claim.json.id}/approve`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("2026-05-31");
    expect(blocked.json.error).toContain("401");
    // 一個位元都沒進去
    expect((await api(`/expense-claims/${claim.json.id}`)).json.journalEntryId).toBeFalsy();

    // 重開該期間後可核准（脫困路徑是本功能的適用範圍，不是稅法判斷）
    expect((await api("/period-closes/latest", undefined, "DELETE")).status).toBe(200);
    expect((await api(`/expense-claims/${claim.json.id}/approve`, {})).status).toBe(200);
  });
});

describe("合約管理", () => {
  it("登記＋附件下載＋狀態流轉", async () => {
    const res = await api("/contracts", {
      counterparty: "房東",
      title: "辦公室租約",
      amount: 360000,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      fileName: "lease.pdf",
      fileData: "data:application/pdf;base64,JVBERi0xLjQ=",
    });
    expect(res.status).toBe(201);
    const id = res.json.id;

    const list = await api("/contracts");
    expect(list.json[0]).toMatchObject({ title: "辦公室租約", hasFile: true, status: "active" });
    expect(list.json[0].fileData).toBeUndefined(); // 清單不含附件內容

    const file = await api(`/contracts/${id}/file`);
    expect(file.json.fileName).toBe("lease.pdf");
    expect(file.json.fileData).toContain("base64");

    const ended = await api(`/contracts/${id}`, { status: "ended" }, "PATCH");
    expect(ended.json.status).toBe("ended");
  });
});
/**
 * 稅額的兩個來源（W2／B4）：電子發票 QR 左碼載了一個銷售額（未稅），總額減掉它就是**憑證所載的**稅額；
 * 系統另有一條路是拿使用者設定的營業稅率回推。兩個數字可能不一樣，而其中一個會進 401 的進項。
 *
 * ★ B4 之後，前端送上來的是 QR **原文**，銷售額由伺服端自己解析。所以這裡的每一個案例
 *   都從一段 QR 字串出發——測的是「伺服端從憑證導出來的數字」，而不是「前端說的數字」。
 *
 * 這裡的期望值一律**從系統實際會用到的費率算出來**（沒有設定參數時走的那個回退值），
 * 不在測試裡寫死任何費率數字——測的是「兩個來源怎麼被處理」，不是費率本身是多少。
 */
describe("報銷稅額：憑證所載的銷售額 vs 費率回推", () => {
  // 這個測試庫用的是 0016 種進去的那一列營業稅率（值＝系統既有的預設值），所以回推值與回退值相同
  const rateTaxOf = (amount: number) => amount - roundHalfUp(amount / (1 + VAT_RATE_FALLBACK));

  const claimWith = (invoiceNumber: string, extra: Record<string, unknown>) =>
    api("/expense-claims", {
      employeeId,
      claimDate: "2026-07-20",
      items: [
        {
          accountCode: "6131",
          description: "稅額來源測試",
          docType: "einvoice",
          deductible: true,
          invoiceNumber,
          invoiceDate: "2026-07-18",
          sellerTaxId: "04541302",
          ...extra,
        },
      ],
    });

  const taxOf = async (claimId: number) => {
    const detail = await api(`/expense-claims/${claimId}`);
    return detail.json.items[0].tax as number;
  };

  /**
   * ★ B4 的那個漏洞本身：前一版收前端傳來的 salesAmount，
   *   `{ amount: 10000, salesAmount: 0, taxSource: 'voucher' }` 就能讓 10000 元整筆變成進項稅額
   *   （核准後傳票是「費用 0／進項稅 10000」，然後進 401）。
   *   現在稅額只能從 QR 導出，而 QR 必須與這筆明細對得起來——貼一張別張發票的 QR 就擋在這裡。
   */
  it("拿一張對不起來的 QR 把整筆金額塞成進項稅：擋下，一毛都不落地", async () => {
    const res = await claimWith("WT10000010", {
      amount: 10000,
      // 這串 QR 自己是一致的（銷售額 0、總計額 10000），但它不是 WT10000010 那張發票
      qrPayload: leftQr({ invoiceNumber: "ZZ99999999", sales: 0, total: 10000 }),
      taxSource: "voucher",
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("發票號碼");
    expect(res.json.error).toContain("重新上傳");
    // 前端分岔靠結構化欄位（訊息會依語言翻譯，不可解析文字）
    expect(res.json.code).toBe("EXPENSE_CONFLICT");
    expect(res.json.details).toEqual([{ kind: "qr_mismatch", lineIndex: 0 }]);
    // 單沒建起來（整筆交易 rollback），10000 元的進項稅不存在於任何地方
    const list = await api("/expense-claims");
    const landed = list.json.some((c: { items: { invoiceNumber: string; tax: number }[] }) =>
      c.items.some((i) => i.invoiceNumber === "WT10000010"),
    );
    expect(landed).toBe(false);
  });

  // 四個交叉核對欄位各自不符都要擋：少擋一個，那個欄位就是下一條把金額安到別張憑證上的路
  it.each([
    ["發票日期", { rocDate: "1150719" }, "發票日期"],
    ["賣方統編", { seller: "53212539" }, "賣方統編"],
    ["總計額", { total: 999 }, "總計額"],
  ])("QR 的%s與明細不符：擋下並指出是哪一欄", async (_label, override, expected) => {
    const invoiceNumber = `WT1000001${expected === "發票日期" ? "1" : expected === "賣方統編" ? "2" : "3"}`;
    const res = await claimWith(invoiceNumber, {
      amount: 1000,
      qrPayload: leftQr({ invoiceNumber, sales: 900, total: 1000, ...override }),
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain(expected);
  });

  // 使用者可能拍到的根本不是電子發票證明聯（右碼、店家自己的付款 QR、糊掉的圖）——
  // 那不是錯誤，只是少了一個可比的來源，安靜走費率回推就好
  it.each([
    ["右碼", "**********:1:1:1:測試品:1:1000"],
    ["別的 QR", "https://example.test/pay/123"],
    ["亂碼", "not-a-qr"],
  ])("qrPayload 是%s：不報錯，安靜走費率回推", async (_label, payload) => {
    const invoiceNumber = payload.startsWith("**") ? "WT10000014" : payload.startsWith("http") ? "WT10000015" : "WT10000016";
    const res = await claimWith(invoiceNumber, { amount: 1050, qrPayload: payload });
    expect(res.status).toBe(201);
    expect(await taxOf(res.json.id)).toBe(rateTaxOf(1050));
    expect(res.json.taxNotes.some((n: string) => n.includes("兩個來源不一致"))).toBe(false);
  });

  it("憑證自己說銷售額＝總計額時：不再靜默算出一筆稅，而是擋下來要求確認", async () => {
    const amount = 1000;
    const res = await claimWith("WT10000001", {
      amount,
      qrPayload: leftQr({ invoiceNumber: "WT10000001", sales: amount, total: amount }),
    });
    expect(res.status).toBe(422);
    // 訊息要同時講出兩個數字與各自的來源，且不暗示哪一個才對
    expect(res.json.error).toContain("0 元"); // 憑證兩個欄位相減
    expect(res.json.error).toContain(`${rateTaxOf(amount)} 元`); // 費率回推
    expect(res.json.error).toContain("憑證所載的銷售額回推");
    expect(res.json.error).toContain("你設定的稅率回推");
    expect(res.json.error).toContain("是你的判斷");
    // 一張單都沒建起來（擋在 prepareItems，整筆交易 rollback）
    const list = await api("/expense-claims");
    expect(list.json.some((c: { items: { invoiceNumber: string }[] }) => c.items.some((i) => i.invoiceNumber === "WT10000001"))).toBe(false);
  });

  it("指定用憑證所載的銷售額回推：落地憑證自己的數字（這裡是 0）", async () => {
    const res = await claimWith("WT10000002", {
      amount: 1000,
      qrPayload: leftQr({ invoiceNumber: "WT10000002", sales: 1000, total: 1000 }),
      taxSource: "voucher",
    });
    expect(res.status).toBe(201);
    expect(await taxOf(res.json.id)).toBe(0);
    // 使用者做過的選擇要出聲：兩個數字與「用了哪一個」都留在 taxNotes 裡
    expect(res.json.taxNotes.some((n: string) => n.includes("已依你指定的「憑證所載的銷售額回推」落地 0 元"))).toBe(true);
    expect(res.json.taxNotes.some((n: string) => n.includes(`另一個（未採用）是 ${rateTaxOf(1000)} 元`))).toBe(true);
  });

  it("指定用稅率回推：落地回推值", async () => {
    const res = await claimWith("WT10000003", {
      amount: 1000,
      qrPayload: leftQr({ invoiceNumber: "WT10000003", sales: 1000, total: 1000 }),
      taxSource: "rate",
    });
    expect(res.status).toBe(201);
    expect(await taxOf(res.json.id)).toBe(rateTaxOf(1000));
    expect(res.json.taxNotes.some((n: string) => n.includes("已依你指定的「你設定的稅率回推」"))).toBe(true);
  });

  // 回歸：絕大多數憑證會落在這裡。兩個來源相等時行為必須與這個功能出現之前一模一樣——
  // 稅額同樣是回推值，而且**一句話都不多講**（多一句就是把噪音餵給每一個人）
  it("兩個來源相等：稅額不變，也不多出任何一句話", async () => {
    const amount = 1050;
    const salesAmount = roundHalfUp(amount / (1 + VAT_RATE_FALLBACK));
    const res = await claimWith("WT10000004", {
      amount,
      qrPayload: leftQr({ invoiceNumber: "WT10000004", sales: salesAmount, total: amount }),
    });
    expect(res.status).toBe(201);
    expect(await taxOf(res.json.id)).toBe(rateTaxOf(amount));
    expect(res.json.taxNotes.some((n: string) => n.includes("兩個來源不一致"))).toBe(false);
  });

  it("沒有 QR 的舊路徑（手動填、只拍到右碼）完全不受影響", async () => {
    const amount = 1050;
    const res = await claimWith("WT10000005", { amount });
    expect(res.status).toBe(201);
    expect(await taxOf(res.json.id)).toBe(rateTaxOf(amount));
    expect(res.json.taxNotes.some((n: string) => n.includes("兩個來源不一致"))).toBe(false);
  });

  // 不可扣抵的明細本來就沒有稅可落地，帶著 QR 也不該冒出一個要人回答的問題
  it("不可扣抵的明細帶著 QR 也不擋（沒有稅額要決定）", async () => {
    const res = await api("/expense-claims", {
      employeeId,
      claimDate: "2026-07-20",
      items: [
        {
          accountCode: "6188",
          docType: "receipt",
          amount: 800,
          qrPayload: leftQr({ invoiceNumber: "WT10000008", sales: 800, total: 800 }),
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(await taxOf(res.json.id)).toBe(0);
  });

  // QR 自己的兩個欄位就對不起來：放行的話會落地一筆負的進項稅，沒有任何畫面看得出來
  it("QR 上的銷售額大於總計額：擋下並要求重新上傳", async () => {
    const res = await claimWith("WT10000006", {
      amount: 900,
      qrPayload: leftQr({ invoiceNumber: "WT10000006", sales: 1000, total: 900 }),
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("大於");
    expect(res.json.error).toContain("900");
  });

  // 退回重送走的是同一支 prepareItems：這條路少一條檢查，同樣會有人在重送時無聲換掉稅額
  it("退回重送也一樣要求確認", async () => {
    const created = await claimWith("WT10000007", {
      amount: 1000,
      qrPayload: leftQr({ invoiceNumber: "WT10000007", sales: 1000, total: 1000 }),
      taxSource: "rate",
    });
    expect(created.status).toBe(201);
    expect((await api(`/expense-claims/${created.json.id}/reject`, { reason: "金額要再確認" })).status).toBe(200);
    // 重送時把稅額來源清掉（前端重打了一筆全新的明細）：既有的選擇不再適用，要重新問一次
    const resent = await api(
      `/expense-claims/${created.json.id}`,
      {
        claimDate: "2026-07-20",
        items: [
          {
            accountCode: "6131",
            docType: "einvoice",
            amount: 1000,
            // 換成另一張發票號碼＝沒有既有選擇可沿用，也就沒有答案可帶
            invoiceNumber: "WT10000009",
            invoiceDate: "2026-07-18",
            sellerTaxId: "04541302",
            deductible: true,
            qrPayload: leftQr({ invoiceNumber: "WT10000009", sales: 1000, total: 1000 }),
          },
        ],
      },
      "PATCH",
    );
    expect(resent.status).toBe(422);
    expect(resent.json.error).toContain("憑證所載的銷售額回推");
  });

  /**
   * ★ 複核點名的缺口：重送會把明細整批刪掉重建，使用者原本選的稅額來源若不跟著走，
   *   稅額會被無聲換回費率回推——上一次問過、也答過的問題，系統自己改掉了答案還不說。
   */
  it("退回重送：沿用原本選的稅額來源，稅額不會無聲改變", async () => {
    const created = await claimWith("WT10000020", {
      amount: 1000,
      qrPayload: leftQr({ invoiceNumber: "WT10000020", sales: 1000, total: 1000 }),
      taxSource: "voucher",
    });
    expect(created.status).toBe(201);
    expect(await taxOf(created.json.id)).toBe(0);
    // 詳情要看得到當初選了哪一個（畫面上「這個數字為什麼是這樣」要答得出來）
    const detail = await api(`/expense-claims/${created.json.id}`);
    expect(detail.json.items[0].taxSource).toBe("voucher");

    expect((await api(`/expense-claims/${created.json.id}/reject`, { reason: "描述請寫清楚" })).status).toBe(200);
    // 重送時**只改了描述**：沒有再帶 qrPayload 也沒有再帶 taxSource（前端不必記得這兩件事）
    const resent = await api(
      `/expense-claims/${created.json.id}`,
      {
        claimDate: "2026-07-20",
        items: [
          {
            accountCode: "6131",
            description: "客戶拜訪的高鐵票",
            docType: "einvoice",
            amount: 1000,
            invoiceNumber: "WT10000020",
            invoiceDate: "2026-07-18",
            sellerTaxId: "04541302",
            deductible: true,
          },
        ],
      },
      "PATCH",
    );
    expect(resent.status).toBe(200);
    // 沒有再被問一次，落地的也還是使用者當初選的那個數字（不是費率回推的 ${rateTaxOf(1000)}）
    expect(await taxOf(created.json.id)).toBe(0);
    expect(resent.json.taxNotes.some((n: string) => n.includes("已依你指定的「憑證所載的銷售額回推」落地 0 元"))).toBe(true);
    const after = await api(`/expense-claims/${created.json.id}`);
    expect(after.json.items[0].taxSource).toBe("voucher");
  });

  // 一張單有 N 筆要確認時逐筆 throw＝逼使用者按 N 次送出，每按一次只換到下一個問題
  it("多筆衝突：一次全部列出來，不必來回送", async () => {
    const item = (invoiceNumber: string, amount: number) => ({
      accountCode: "6131",
      docType: "einvoice",
      deductible: true,
      amount,
      invoiceNumber,
      invoiceDate: "2026-07-18",
      sellerTaxId: "04541302",
      qrPayload: leftQr({ invoiceNumber, sales: amount, total: amount }),
    });
    const res = await api("/expense-claims", {
      employeeId,
      claimDate: "2026-07-20",
      items: [item("WT10000031", 1000), item("WT10000032", 2000)],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("2 筆明細要你確認");
    expect(res.json.error).toContain("第 1 筆明細");
    expect(res.json.error).toContain("第 2 筆明細");
    expect(res.json.error).toContain("WT10000031");
    expect(res.json.error).toContain("WT10000032");
  });

  /**
   * ★ 安全複核第二次點名的繞法：交叉核對擋得住「貼別張發票的 QR」，擋不住
   *   「整張自己編、四欄與明細對得起來、銷售額填 0」的左碼——配 taxSource:'voucher'
   *   稅額就落地成全額（實測 amount 10000 → tax 10000，一般 employee 角色就做得到）。
   *
   *   關法是**單向上限**：voucherTax > rateTax 時不接受 voucher。
   *   下面同時測「繞法關掉了」與「原本要修的那個方向（voucherTax < rateTax）還在」——
   *   只測前者的話，把兩個方向一起擋死也會綠。
   */
  describe("憑證所載的稅額超過費率回推：不接受 voucher（單向上限）", () => {
    it("自製一段自洽的左碼、銷售額 0：稅額不落地成全額，總帳與 401 都只拿到費率回推值", async () => {
      const amount = 10000;
      const before = await api("/vat-returns/401?period=202607");
      const res = await claimWith("WX10000001", {
        amount,
        // 四個交叉核對欄位全部對得起來、買方也是本公司——上一輪的每一道檢查都過得了
        qrPayload: leftQr({ invoiceNumber: "WX10000001", sales: 0, total: amount }),
        taxSource: "voucher",
      });
      expect(res.status).toBe(201);
      // 落地的是費率回推值，不是憑證自己說的 10000
      expect(await taxOf(res.json.id)).toBe(rateTaxOf(amount));
      expect(res.json.taxNotes.some((n: string) => n.includes(`超過依你設定的營業稅率回推的 ${rateTaxOf(amount)} 元`))).toBe(true);
      // 稅額來源不記成使用者的選擇：他選的 voucher 沒有落地
      const detail = await api(`/expense-claims/${res.json.id}`);
      expect(detail.json.items[0].taxSource).toBe(null);

      // 核准後的兩個出口都要對：1288 進項稅額的分錄、以及 401 的進項稅額
      const approved = await api(`/expense-claims/${res.json.id}/approve`, {});
      expect(approved.status).toBe(200);
      const entry = await api(`/journal-entries/${approved.json.journalEntryId}`);
      const line = (code: string) => entry.json.lines.find((l: { code: string }) => l.code === code);
      expect(line("1288")).toMatchObject({ debit: rateTaxOf(amount) });
      expect(line("6131")).toMatchObject({ debit: amount - rateTaxOf(amount) });
      const after = await api("/vat-returns/401?period=202607");
      expect(after.json.summary.inputExpenseTax - before.json.summary.inputExpenseTax).toBe(rateTaxOf(amount));
    });

    // 這條路存在的理由（憑證自己說的稅比費率回推**少**）必須原封不動
    it("反方向仍然選得了 voucher：憑證所載的稅額比費率回推少時照樣落地", async () => {
      const amount = 1050;
      const res = await claimWith("WX10000002", {
        amount,
        // 銷售額比費率回推的未稅額多 1 元 ⇒ 憑證所載的稅額少 1 元
        qrPayload: leftQr({ invoiceNumber: "WX10000002", sales: amount - rateTaxOf(amount) + 1, total: amount }),
        taxSource: "voucher",
      });
      expect(res.status).toBe(201);
      expect(await taxOf(res.json.id)).toBe(rateTaxOf(amount) - 1);
    });

    // 銷售額＝總計額（憑證自己說沒有稅）也是「少」的方向：既有的那條路不能被上限順手擋掉
    it("憑證說整筆都是銷售額（稅 0）：仍然選得了 voucher", async () => {
      const res = await claimWith("WX10000003", {
        amount: 1000,
        qrPayload: leftQr({ invoiceNumber: "WX10000003", sales: 1000, total: 1000 }),
        taxSource: "voucher",
      });
      expect(res.status).toBe(201);
      expect(await taxOf(res.json.id)).toBe(0);
    });

    // 一般發票捨入向上就會差這 1 元：方向保守地落到 rateTax，但**不擋死流程**
    it("憑證所載的稅額只多 1 元（捨入殘差）：落到費率回推，不用回答任何問題", async () => {
      const amount = 1050;
      const res = await claimWith("WX10000004", {
        amount,
        qrPayload: leftQr({ invoiceNumber: "WX10000004", sales: amount - rateTaxOf(amount) - 1, total: amount }),
        // 刻意不給 taxSource：voucher 不是可選項時還問，是把人推進一條沒有出口的迴圈
      });
      expect(res.status).toBe(201);
      expect(await taxOf(res.json.id)).toBe(rateTaxOf(amount));
      expect(res.json.taxNotes.some((n: string) => n.includes("超過依你設定的營業稅率回推的"))).toBe(true);
    });

    it("上限的訊息只講結構事實：不說稅率應該是多少、不評價這張憑證", async () => {
      const res = await claimWith("WX10000005", {
        amount: 10000,
        qrPayload: leftQr({ invoiceNumber: "WX10000005", sales: 0, total: 10000 }),
        taxSource: "voucher",
      });
      const note = (res.json.taxNotes as string[]).find((n) => n.includes("超過依你設定的營業稅率回推的"))!;
      expect(note).toContain("憑證所載稅額 10000 元");
      expect(note).toContain(`這筆以 ${rateTaxOf(10000)} 元落地`);
      expect(note).toContain("請先檢查「稅法參數」頁的營業稅率設定");
      for (const forbidden of ["應該是", "不合法", "偽造", "違法"]) expect(note).not.toContain(forbidden);
    });
  });

  /**
   * ★ 可扣抵性至今 100% 由 client 說了算：QR 上明明寫著買方是誰，伺服端卻只比四欄、
   *   第五欄（買方統編）沒比。送 deductible:true 就照樣可扣抵。
   */
  describe("QR 上的買方統編：伺服端自己判定可扣抵性", () => {
    it.each([
      ["買方是別家公司", "53212539", "WX10000011"],
      ["未打統編（規格以全 0 表示）", "00000000", "WX10000012"],
    ])("%s 而 client 送 deductible:true：伺服端收成不可扣抵", async (_label, buyer, invoiceNumber) => {
      const amount = 1050;
      const res = await claimWith(invoiceNumber, {
        amount,
        deductible: true,
        qrPayload: leftQr({ invoiceNumber, sales: 1000, total: amount, buyer }),
      });
      expect(res.status).toBe(201);
      const detail = await api(`/expense-claims/${res.json.id}`);
      expect(detail.json.items[0]).toMatchObject({ deductible: false, tax: 0 });
      // 出聲說明理由（送單時與詳情頁同一句話）
      expect(res.json.taxNotes.some((n: string) => n.includes("與公司基本檔的統編不同"))).toBe(true);
      expect(detail.json.taxNotes.some((n: string) => n.includes("與公司基本檔的統編不同"))).toBe(true);
    });

    it("買方統編就是本公司：不受影響，照舊可扣抵", async () => {
      const amount = 1050;
      const res = await claimWith("WX10000013", {
        amount,
        qrPayload: leftQr({ invoiceNumber: "WX10000013", sales: amount - rateTaxOf(amount), total: amount }),
      });
      expect(res.status).toBe(201);
      const detail = await api(`/expense-claims/${res.json.id}`);
      expect(detail.json.items[0]).toMatchObject({ deductible: true, tax: rateTaxOf(amount) });
      expect(detail.json.taxNotes).toEqual([]);
    });

    it("不可扣抵的明細不會進 401 的進項", async () => {
      const before = await api("/vat-returns/401?period=202607");
      const res = await claimWith("WX10000014", {
        amount: 1050,
        deductible: true,
        qrPayload: leftQr({ invoiceNumber: "WX10000014", sales: 1000, total: 1050, buyer: "00000000" }),
      });
      expect((await api(`/expense-claims/${res.json.id}/approve`, {})).status).toBe(200);
      const after = await api("/vat-returns/401?period=202607");
      expect(after.json.summary.inputExpenseTax).toBe(before.json.summary.inputExpenseTax);
    });
  });

  /**
   * 核准的人才是決定這筆進項稅進不進 401 的人，而他看到的只有一個數字——
   * 建單時說過的那兩句只回給送單的人。詳情頁要從已落地的欄位重建同樣的事實。
   */
  describe("詳情頁的稅額說明：核准者看得到那兩個競爭的數字", () => {
    it("落地的是憑證那個數字：說得出它的出處", async () => {
      const res = await claimWith("WX10000021", {
        amount: 1000,
        qrPayload: leftQr({ invoiceNumber: "WX10000021", sales: 1000, total: 1000 }),
        taxSource: "voucher",
      });
      const detail = await api(`/expense-claims/${res.json.id}`);
      expect(detail.json.taxNotes.some((n: string) => n.includes("出自憑證所載的銷售額回推"))).toBe(true);
      expect(detail.json.taxNotes.some((n: string) => n.includes("憑證上的銷售額 1000"))).toBe(true);
    });

    it("落地的是費率回推：憑證自己載明的那個數字也要看得到", async () => {
      const amount = 10000;
      const res = await claimWith("WX10000022", {
        amount,
        qrPayload: leftQr({ invoiceNumber: "WX10000022", sales: 0, total: amount }),
        taxSource: "voucher", // 被上限擋下，落地的是費率回推
      });
      const detail = await api(`/expense-claims/${res.json.id}`);
      const note = (detail.json.taxNotes as string[]).find((n) => n.includes("WX10000022"))!;
      expect(note).toContain(`進項稅額 ${rateTaxOf(amount)} 元出自依營業稅率回推`);
      expect(note).toContain(`${amount} 元（未採用）`);
    });

    it("沒有第二個來源的一般明細：詳情頁一句話都不多講", async () => {
      const res = await claimWith("WX10000023", { amount: 1050 });
      const detail = await api(`/expense-claims/${res.json.id}`);
      expect(detail.json.taxNotes).toEqual([]);
    });
  });

  /**
   * ★ `item.taxSource ?? carried?.taxSource` 把「使用者明確清掉」與「前端沒送這個欄位」
   *   當成同一件事，於是選過 voucher 之後沒有任何收回的路徑。
   */
  describe("退回重送：稅額來源要收得回來、換得掉", () => {
    const rejectAndResend = async (invoiceNumber: string, itemOverride: Record<string, unknown>) => {
      const created = await claimWith(invoiceNumber, {
        amount: 1000,
        qrPayload: leftQr({ invoiceNumber, sales: 1000, total: 1000 }),
        taxSource: "voucher",
      });
      expect(created.status).toBe(201);
      expect(await taxOf(created.json.id)).toBe(0);
      expect((await api(`/expense-claims/${created.json.id}/reject`, { reason: "來源要再確認" })).status).toBe(200);
      const resent = await api(
        `/expense-claims/${created.json.id}`,
        {
          claimDate: "2026-07-20",
          items: [
            {
              accountCode: "6131",
              docType: "einvoice",
              amount: 1000,
              invoiceNumber,
              invoiceDate: "2026-07-18",
              sellerTaxId: "04541302",
              deductible: true,
              ...itemOverride,
            },
          ],
        },
        "PATCH",
      );
      return { claimId: created.json.id as number, resent };
    };

    it("改成費率回推：稅額換成回推值", async () => {
      const { claimId: id, resent } = await rejectAndResend("WX10000031", { taxSource: "rate" });
      expect(resent.status).toBe(200);
      expect(await taxOf(id)).toBe(rateTaxOf(1000));
      const detail = await api(`/expense-claims/${id}`);
      expect(detail.json.items[0].taxSource).toBe("rate");
    });

    it("明確清成 null：不再沿用上次的選擇，重新問一次", async () => {
      const { resent } = await rejectAndResend("WX10000032", { taxSource: null });
      expect(resent.status).toBe(422);
      expect(resent.json.error).toContain("請指定這筆明細要用哪一個來源");
      // 前端「用哪個數字」的按鈕靠 details 拿兩個稅額（訊息會依語言翻譯，不可解析文字）
      expect(resent.json.code).toBe("EXPENSE_CONFLICT");
      expect(resent.json.details).toHaveLength(1);
      expect(resent.json.details[0]).toMatchObject({ kind: "tax_source_conflict", lineIndex: 0, invoiceNumber: "WX10000032" });
      expect(typeof resent.json.details[0].voucherTax).toBe("number");
      expect(typeof resent.json.details[0].rateTax).toBe("number");
    });

    it("沒送這個欄位（只改了描述）：照舊沿用上次的選擇", async () => {
      const { claimId: id, resent } = await rejectAndResend("WX10000033", { description: "改了描述" });
      expect(resent.status).toBe(200);
      expect(await taxOf(id)).toBe(0);
    });

    it("把掃到的憑證也清掉（qrPayload: null）：回到沒有第二個來源的一般路徑", async () => {
      const { claimId: id, resent } = await rejectAndResend("WX10000034", { qrPayload: null });
      expect(resent.status).toBe(200);
      expect(await taxOf(id)).toBe(rateTaxOf(1000));
      const detail = await api(`/expense-claims/${id}`);
      expect(detail.json.items[0]).toMatchObject({ qrPayload: null, taxSource: null });
    });
  });
});

/**
 * 費率回退（vat.fallback）有**三種成因**，訊息卻一律講成「你還沒設定涵蓋 X 的營業稅率」——
 * 其中兩種的使用者其實設定過、而且涵蓋該日（那一列沒有級距內容／不是單一費率），
 * 於是螢幕上那句話是假的，還把人指向錯的修法（去新增一列，但問題在既有那一列的內容）。
 * 422 那條路尤其嚴重：resolveVatRate 本來就產出了指名第 #N 列的診斷，AppError 只帶一個字串就整個丟掉。
 *
 * 這個 describe 為每一種成因各開一個資料庫（上面那些案例用的是 0016 種的參數＝設定正常，測不到回退）。
 */
describe("費率回退的三種成因：訊息要指得出真正的原因", () => {
  /** 建一個乾淨的 app，並依 vatRow 決定「營業稅率那一列」長什麼樣（null＝一列都沒有） */
  const buildCase = async (vatRow: Partial<typeof schema.taxParameters.$inferInsert> | null) => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const caseDb = drizzle(client);
    await seedAccounts(caseDb);
    // 先把 0016 種的那一列拿掉，再依案例種回去
    await caseDb.delete(schema.taxParameters).where(eq(schema.taxParameters.kind, "vat"));
    if (vatRow) {
      await caseDb.insert(schema.taxParameters).values({
        kind: "vat",
        label: "營業稅率",
        validFrom: "2020-01-01",
        ...vatRow,
      } as typeof schema.taxParameters.$inferInsert);
    }
    const caseApp = buildApp(caseDb);
    const caseAuth = await setupAdmin(caseApp);
    const call = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
      const res = await caseApp.request(path, {
        method,
        headers: { ...caseAuth, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json() };
    };
    await call("/company-profile", { name: "測試公司", taxId: "22099131" }, "PUT");
    const emp = await call("/employees", { name: "李小華" });
    const submit = (invoiceNumber: string, extra: Record<string, unknown>) =>
      call("/expense-claims", {
        employeeId: emp.json.id,
        claimDate: "2026-07-20",
        items: [
          {
            accountCode: "6131",
            docType: "einvoice",
            deductible: true,
            amount: 1000,
            invoiceNumber,
            invoiceDate: "2026-07-18",
            sellerTaxId: "04541302",
            // 銷售額＝總計額的憑證：兩個來源必定不一致，才問得到「用哪一個」
            qrPayload: leftQr({ invoiceNumber, sales: 1000, total: 1000 }),
            ...extra,
          },
        ],
      });
    return { submit };
  };

  /**
   * 三種成因各自的**真正原因**要出現在訊息裡。
   * 這裡刻意不比對整句，只比對「指得出成因的那一段」——措辭由 resolveVatRate 定義，
   * 抄一份到測試裡只會多一份會漂移的文字。
   */
  const CASES: [string, Partial<typeof schema.taxParameters.$inferInsert> | null, string][] = [
    ["一列都沒設定", null, "找不到生效期間涵蓋 2026-07-18 的營業稅率設定"],
    [
      "設定過、但那一列沒有級距內容（是／否型參數放錯 kind）",
      { boolValue: true, brackets: null },
      "沒有級距內容",
    ],
    [
      "設定過、但那一列不是單一費率（多個級距）",
      {
        brackets: [
          // 中性數字：這裡測的是「多級距接不上進銷貨流程」，不是費率本身是多少
          { from: 0, to: 100_000, mode: "rate_on_total", rateBp: 100 },
          { from: 100_001, to: null, mode: "rate_on_total", rateBp: 200 },
        ],
      },
      "不是單一費率",
    ],
  ];

  it.each(CASES)("%s：422 要指名真正的原因", async (_label, vatRow, expected) => {
    const { submit } = await buildCase(vatRow);
    const res = await submit("WT10000041", {});
    expect(res.status).toBe(422);
    expect(res.json.error).toContain(expected);
    // 概括成「你還沒設定」的那句假話不能再出現（後兩種成因的使用者其實設定過）
    expect(res.json.error).not.toContain("你還沒設定涵蓋");
  });

  it.each(CASES)("%s：落地之後同一句話也要出現，不能只在 422 講", async (_label, vatRow, expected) => {
    const { submit } = await buildCase(vatRow);
    const res = await submit("WT10000042", { taxSource: "rate" });
    expect(res.status).toBe(201);
    expect(res.json.taxNotes.some((n: string) => n.includes(expected))).toBe(true);
  });

  it("設定過但那一列接不上時，422 要指得出是第幾列（使用者才知道回去改哪一列）", async () => {
    const { submit } = await buildCase({ boolValue: true, brackets: null });
    const res = await submit("WT10000043", {});
    expect(res.json.error).toMatch(/第 #\d+ 列/);
  });
});

/**
 * 公司基本檔還沒填統編時，QR 上的買方統編**無從核對**——那不是「不符」，
 * 不能因此把使用者的可扣抵主張收掉，但也不能假裝核對過了。
 */
describe("公司基本檔沒有統編：無從核對買方統編", () => {
  it("不改動可扣抵的主張，但要出聲說沒核對", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const noCompanyDb = drizzle(client);
    await seedAccounts(noCompanyDb);
    const noCompanyApp = buildApp(noCompanyDb);
    const noCompanyAuth = await setupAdmin(noCompanyApp);
    const call = async (path: string, body?: unknown) => {
      const res = await noCompanyApp.request(path, {
        method: body ? "POST" : "GET",
        headers: { ...noCompanyAuth, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json() };
    };
    const emp = await call("/employees", { name: "陳小美" });
    const amount = 1050;
    const res = await call("/expense-claims", {
      employeeId: emp.json.id,
      claimDate: "2026-07-20",
      items: [
        {
          accountCode: "6131",
          docType: "einvoice",
          deductible: true,
          amount,
          invoiceNumber: "WX10000041",
          invoiceDate: "2026-07-18",
          sellerTaxId: "04541302",
          qrPayload: leftQr({ invoiceNumber: "WX10000041", sales: 1000, total: amount, buyer: "53212539" }),
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.json.taxNotes.some((n: string) => n.includes("公司基本檔還沒填統編"))).toBe(true);
    const detail = await call(`/expense-claims/${res.json.id}`);
    expect(detail.json.items[0].deductible).toBe(true); // 主張照舊，系統沒有替他判定
  });
});
