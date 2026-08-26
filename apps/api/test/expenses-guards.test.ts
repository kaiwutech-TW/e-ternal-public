/**
 * 報銷側四道防線（第四輪安全複核點名的四條 minor），每一條都對著一個具體的壞結果：
 *
 * ① **曆法檢核**：QR 左碼的民國日期 1150230 換算成 2026-02-30，形狀完全合格，
 *    一路通過 zod 與四欄交叉核對，最後炸在 expense_items.invoice_date 的 date 欄位 → 500。
 *    使用者拿到的是 internal error，沒有一個字說得出是哪一筆哪一欄。
 * ② **離譜未來的發票日期**：費用傳票以報銷單日期入帳，可扣抵明細卻以發票日期進 401。
 *    2062 年的發票日 → 1288 進項稅額借在總帳裡，卻永遠不落在任何一期 401 的取數區間。
 * ③ **公司基本檔沒填統編**：買方統編核對整條沒跑過，而畫面上這些可扣抵明細與核對過的
 *    長得一模一樣。要出聲，而且**建單回應與詳情頁兩條路都要**——按核准的人看的是詳情頁。
 * ④ **發票號碼查重的併發窗口**：assertInvoiceNotClaimed 是交易內的 read-then-write。
 *
 * ⚠️ ④ 的誠實話：PGlite 只有單一連線，測不出真正的併發（returns.ts 的 FOR UPDATE 同樣處境）。
 *    這裡驗的是「鎖有沒有取、取在查重之前、順序固定」——那是併發正確性的**前提**，不是併發本身。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { setupAdmin } from "./auth-helper.ts";

/** 一段真的送得出去的電子發票左碼（前 77 碼定長，日期是民國年） */
const leftQr = (o: { invoiceNumber: string; rocDate: string; sales: number; total: number; buyer?: string }) => {
  const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");
  return (
    o.invoiceNumber +
    o.rocDate +
    "1234" +
    hex8(o.sales) +
    hex8(o.total) +
    (o.buyer ?? "22099131") +
    "04541302" +
    "0".repeat(24)
  );
};

/** 每筆記錄一句真的送到 PGlite 的 SQL；inTx＝這句是在交易裡送的 */
type SqlCall = { sql: string; params: unknown[]; inTx: boolean };

/** PGlite 上我們要攔的兩支（交易裡的語句走的是 transaction 給的那個物件，攔 query 攔不到） */
type SqlSpy = {
  query: (sql: string, params?: unknown[], o?: unknown) => unknown;
  transaction: (cb: (tx: SqlSpy) => unknown, o?: unknown) => unknown;
};

/**
 * 一套獨立的資料庫＋app。taxId 傳 null＝公司基本檔不填統編（新裝的環境）。
 * record：把每一句 SQL 記下來（④ 要看的鎖在交易裡，走的是 client.transaction 給的那個物件，
 * 攔 client.query 攔不到）。
 */
async function mkApp(opts: { taxId?: string | null } = {}) {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  const app = buildApp(db);
  const auth = await setupAdmin(app);
  const call = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
    const res = await app.request(path, {
      method,
      headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const taxId = opts.taxId === undefined ? "22099131" : opts.taxId;
  if (taxId !== null) await call("/company-profile", { name: "測試公司", taxId }, "PUT");
  const employeeId = (await call("/employees", { name: "王小明" })).json.id as number;

  // 攔截只裝一次（每次 record() 重裝會把同一句 SQL 記兩遍）；record() 只是把記錄清空重數
  const calls: SqlCall[] = [];
  {
    const spy = client as unknown as SqlSpy;
    const origQuery = spy.query.bind(spy);
    spy.query = (sql, params, o) => {
      calls.push({ sql, params: params ?? [], inTx: false });
      return origQuery(sql, params, o);
    };
    const origTx = spy.transaction.bind(spy);
    spy.transaction = (cb, o) =>
      origTx(async (tx) => {
        const origTxQuery = tx.query.bind(tx);
        tx.query = (sql, params, oo) => {
          calls.push({ sql, params: params ?? [], inTx: true });
          return origTxQuery(sql, params, oo);
        };
        return cb(tx);
      }, o);
  }
  const record = () => {
    calls.length = 0;
    return calls;
  };
  return { call, employeeId, record };
}

/** 一筆可扣抵的統編電子發票明細（1050 → 稅 50） */
const item = (extra: Record<string, unknown> = {}) => ({
  accountCode: "6131",
  description: "高鐵",
  docType: "einvoice",
  amount: 1050,
  deductible: true,
  invoiceNumber: "AB10000001",
  invoiceDate: "2026-07-05",
  sellerTaxId: "04541302",
  ...extra,
});

/** 今天＋n 天的 YYYY-MM-DD（測「一年內的未來」不能寫死日期，寫死就是在挑會過的組態） */
const daysFromToday = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let main: Awaited<ReturnType<typeof mkApp>>;
beforeAll(async () => {
  main = await mkApp();
});

describe("① 日曆上不存在的日期：422 指得出哪一欄，不是 500", () => {
  const submit = (claimDate: string, extra: Record<string, unknown> = {}) =>
    main.call("/expense-claims", { employeeId: main.employeeId, claimDate, items: [item(extra)] });

  it("明細的發票日期（2026-02-29，該年沒有這一天）：422 指名第幾筆與哪一欄", async () => {
    const res = await submit("2026-07-10", { invoiceNumber: "AB10000101", invoiceDate: "2026-02-29" });
    expect(res.status).toBe(422); // 修之前是 500 internal error
    expect(res.json.error).toContain("第 1 筆明細的發票日期");
    expect(res.json.error).toContain("不是日曆上存在的日期");
  });

  it("報銷單日期（2025-02-30）：同一道檢核，claim_date 也是 date 欄位", async () => {
    // 刻意用過去的日期：未來日期那道檢核（assertNotFarFuture）不可能先擋，擋下來的只會是曆法檢核
    const res = await submit("2025-02-30", { invoiceNumber: "AB10000102" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("報銷單日期（2025-02-30）");
    expect(res.json.error).toContain("不是日曆上存在的日期");
  });

  it("QR 上的開立日期不存在（民國 1150230）而明細填的是合法日期：指的是憑證那一欄", async () => {
    const invoiceNumber = "AB10000103";
    const res = await submit("2026-07-10", {
      invoiceNumber,
      invoiceDate: "2026-03-01",
      amount: 1000,
      qrPayload: leftQr({ invoiceNumber, rocDate: "1150230", sales: 900, total: 1000 }),
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("掃到的 QR 上的開立日期（2026-02-30）");
    expect(res.json.error).toContain("不是日曆上存在的日期");
  });

  it("擋下來之後單沒建起來：那張發票號碼在系統裡不存在", async () => {
    const list = await main.call("/expense-claims");
    const numbers = (list.json as { items: { invoiceNumber: string }[] }[]).flatMap((c) =>
      c.items.map((i) => i.invoiceNumber),
    );
    expect(numbers).not.toContain("AB10000101");
    expect(numbers).not.toContain("AB10000103");
  });

  it("付款日期（2025-11-31）：付款那條路的 entry_date 也是 date 欄位", async () => {
    const created = await submit("2026-07-10", { invoiceNumber: "AB10000105" });
    expect(created.status).toBe(201);
    expect((await main.call(`/expense-claims/${created.json.id}/approve`, {})).status).toBe(200);
    const cash = (await main.call("/accounts")).json.find((a: { code: string }) => a.code === "1101");
    const res = await main.call(`/expense-claims/${created.json.id}/pay`, {
      accountId: cash.id,
      payDate: "2025-11-31",
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("付款日期（2025-11-31）");
    expect(res.json.error).toContain("不是日曆上存在的日期");
  });

  it("真的存在的閏日（2024-02-29）照樣放行：擋的是日曆，不是「2 月的大日子」", async () => {
    const res = await submit("2024-02-29", { invoiceNumber: "AB10000104", invoiceDate: "2024-02-29" });
    expect(res.status).toBe(201);
    const detail = await main.call(`/expense-claims/${res.json.id}`);
    expect(detail.json.items[0].invoiceDate).toBe("2024-02-29");
  });
});

describe("② 離譜未來的發票日期：總帳借了進項稅、401 卻永遠取不到那一期", () => {
  const submit = (extra: Record<string, unknown>) =>
    main.call("/expense-claims", { employeeId: main.employeeId, claimDate: "2026-07-10", items: [item(extra)] });

  it("報銷單日期正常、發票日期 2062：擋下並指名是第幾筆的哪一欄", async () => {
    const res = await submit({ invoiceNumber: "AB10000201", invoiceDate: "2062-07-05" });
    expect(res.status).toBe(422); // 修之前是 201，稅額落地、401 永遠取不到
    expect(res.json.error).toContain("第 1 筆明細的發票日期（2062-07-05）");
    expect(res.json.error).toContain("多半是年份打錯了");
  });

  it("第二筆才打錯：訊息指的是第 2 筆", async () => {
    const res = await main.call("/expense-claims", {
      employeeId: main.employeeId,
      claimDate: "2026-07-10",
      items: [
        item({ invoiceNumber: "AB10000202", invoiceDate: "2026-07-05" }),
        item({ invoiceNumber: "AB10000203", invoiceDate: "2062-07-05" }),
      ],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("第 2 筆明細的發票日期");
  });

  it("過去的發票日期不受影響：補報上季的費用是正常作業", async () => {
    const res = await submit({ invoiceNumber: "AB10000204", invoiceDate: "2024-06-30" });
    expect(res.status).toBe(201);
  });

  it("一年內的未來（今天＋30 天）照樣收：擋的是打錯年份，不是「未來」", async () => {
    const res = await submit({ invoiceNumber: "AB10000205", invoiceDate: daysFromToday(30) });
    expect(res.status).toBe(201);
    const detail = await main.call(`/expense-claims/${res.json.id}`);
    expect(detail.json.items[0].tax).toBeGreaterThan(0); // 真的落地成可扣抵，不是被默默收掉
  });
});

describe("③ 公司基本檔沒填統編：那道核對沒跑過，兩條路都要說", () => {
  const claimBody = (employeeId: number, extra: Record<string, unknown> = {}) => ({
    employeeId,
    claimDate: "2026-07-10",
    items: [item({ invoiceNumber: "AB10000301", ...extra })],
  });

  it("建單回應與詳情頁都出聲，而且說得出有幾筆、多少稅額", async () => {
    const noTaxId = await mkApp({ taxId: null });
    const res = await noTaxId.call("/expense-claims", claimBody(noTaxId.employeeId));
    expect(res.status).toBe(201);
    const said = (notes: string[]) =>
      notes.some((n) => n.includes("公司基本檔還沒填統編") && n.includes("1 筆明細以可扣抵落地") && n.includes("合計 50 元"));
    // 送單的人看得到
    expect(said(res.json.taxNotes)).toBe(true);
    // ★ 按下核准的人看的是詳情頁——他才是讓這筆進項稅進 401 的那一個
    const detail = await noTaxId.call(`/expense-claims/${res.json.id}`);
    expect(said(detail.json.taxNotes)).toBe(true);
    // 不硬擋：新環境仍然報得了銷，主張也沒有被系統改掉
    expect(detail.json.items[0]).toMatchObject({ deductible: true, tax: 50 });
  });

  it("沒有 QR 的明細一樣沒被核對過：照樣出聲（不是只有掃到 QR 才講）", async () => {
    const noTaxId = await mkApp({ taxId: null });
    const res = await noTaxId.call("/expense-claims", claimBody(noTaxId.employeeId, { qrPayload: null }));
    const detail = await noTaxId.call(`/expense-claims/${res.json.id}`);
    expect(detail.json.taxNotes.some((n: string) => n.includes("公司基本檔還沒填統編"))).toBe(true);
  });

  it("整張單沒有可扣抵明細：一句話都不多講（沒有稅額進 401，沒有東西要核對）", async () => {
    const noTaxId = await mkApp({ taxId: null });
    const res = await noTaxId.call("/expense-claims", {
      employeeId: noTaxId.employeeId,
      claimDate: "2026-07-10",
      items: [item({ invoiceNumber: "AB10000302", docType: "receipt", deductible: false })],
    });
    expect(res.json.taxNotes).toEqual([]);
    const detail = await noTaxId.call(`/expense-claims/${res.json.id}`);
    expect(detail.json.taxNotes).toEqual([]);
  });

  it("公司統編填了就不再出聲（那道核對真的跑過了）", async () => {
    const res = await main.call("/expense-claims", claimBody(main.employeeId, { invoiceNumber: "AB10000303" }));
    const detail = await main.call(`/expense-claims/${res.json.id}`);
    for (const notes of [res.json.taxNotes, detail.json.taxNotes]) {
      expect((notes as string[]).some((n) => n.includes("公司基本檔還沒填統編"))).toBe(false);
    }
  });
});

/**
 * ④ 查重是 read-then-write：兩個並行請求各自讀到「這張發票還沒人報」就都放行，
 *    同一張進項發票的稅額進 401 兩次。PGlite 測不出併發，能釘的是鎖的**取法**。
 */
describe("④ 發票號碼查重的序列化點", () => {
  const advisory = (calls: SqlCall[]) => calls.filter((c) => c.sql.includes("pg_advisory_xact_lock"));

  it("報銷建單：每個發票號碼各取一把鎖，而且取在查重的 SELECT 之前", async () => {
    const calls = main.record();
    const res = await main.call("/expense-claims", {
      employeeId: main.employeeId,
      claimDate: "2026-07-10",
      items: [item({ invoiceNumber: "AB10000401" }), item({ invoiceNumber: "AB10000402" })],
    });
    expect(res.status).toBe(201);
    expect(advisory(calls)).toHaveLength(2);
    // 鎖在交易裡（xact lock 出了交易就等於沒鎖）
    expect(advisory(calls).every((c) => c.inTx)).toBe(true);
    // 先鎖再查：查完才鎖等於沒鎖
    const lockIndexes = calls.map((c, i) => (c.sql.includes("pg_advisory_xact_lock") ? i : -1)).filter((i) => i >= 0);
    const lastLock = lockIndexes[lockIndexes.length - 1]!;
    const firstDupCheck = calls.findIndex((c) => c.sql.includes('from "expense_items"'));
    expect(firstDupCheck).toBeGreaterThan(lastLock);
  });

  it("同一張單只有一個號碼時只鎖一把；沒有號碼的明細不鎖", async () => {
    const calls = main.record();
    const res = await main.call("/expense-claims", {
      employeeId: main.employeeId,
      claimDate: "2026-07-10",
      items: [
        item({ invoiceNumber: "AB10000403" }),
        { accountCode: "6131", docType: "receipt", amount: 200 }, // 沒有發票號碼：沒有東西要序列化
      ],
    });
    expect(res.status).toBe(201);
    expect(advisory(calls)).toHaveLength(1);
  });

  it("取鎖順序與明細順序無關（兩個交易各持一半互等就是死鎖）", async () => {
    const numbers = ["AB10000405", "AB10000404"];
    const keysOf = async (order: string[]) => {
      const app = await mkApp();
      const calls = app.record();
      const res = await app.call("/expense-claims", {
        employeeId: app.employeeId,
        claimDate: "2026-07-10",
        items: order.map((invoiceNumber) => item({ invoiceNumber })),
      });
      expect(res.status).toBe(201);
      // 查重確實照明細順序跑（＝兩邊的明細順序真的不同，這個測試才有意義）
      const dupOrder = calls.filter((c) => c.sql.includes('from "expense_items"')).map((c) => c.params[0]);
      expect(dupOrder).toEqual(order);
      return advisory(calls).map((c) => c.params[1]);
    };
    expect(await keysOf(numbers)).toEqual(await keysOf([...numbers].reverse()));
  });

  it("進貨補登發票號碼：同一把鎖，而且整段在交易裡（原本連交易都沒有）", async () => {
    const supplier = await main.call("/partners", { name: "供應商", isSupplier: true, taxId: "12345675" });
    const product = await main.call("/products", { sku: "SKU-G1", name: "原子筆" });
    const purchase = await main.call("/purchases", {
      partnerId: supplier.json.id,
      docDate: "2026-07-02",
      lines: [{ productId: product.json.id, qty: 1, unitPrice: 1000 }],
    });
    const calls = main.record();
    const res = await main.call(
      `/purchases/${purchase.json.id}/supplier-invoice`,
      { track: "AB", no: "10000406" },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect(advisory(calls)).toHaveLength(1);
    expect(advisory(calls)[0]!.inTx).toBe(true);
    // 報銷側鎖同一張發票時算出來的鎖鍵要一模一樣，跨表的重號才真的被序列化
    const claimCalls = main.record();
    const claim = await main.call("/expense-claims", {
      employeeId: main.employeeId,
      claimDate: "2026-07-10",
      // 賣方統編與那家供應商相同，才是「同一張紙登兩次」（不同賣方的同號發票本來就放行）
      items: [item({ invoiceNumber: "AB10000406", sellerTaxId: "12345675" })],
    });
    expect(claim.status).toBe(422); // 已登在進貨單上（查重本身照舊）
    expect(advisory(claimCalls)[0]!.params).toEqual(advisory(calls)[0]!.params);
  });
});
