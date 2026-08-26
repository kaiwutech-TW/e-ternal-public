/**
 * 身分證號的欄位級加密驗收（公網部署前的安全批次④）。
 *
 * 這個檔案的假號碼一律用 TEST- 開頭的不合法字串，不用任何看起來像真的身分證號——
 * partners.id_no 的處理紀律第一條（見 migration 0015）：本 repo 可能公開。
 *
 * 要守住的四件事：
 *  1. 資料庫裡看不到明文（這才是「備份被複製出去」時真正保護到的東西）
 *  2. 加密上線前寫入的舊明文列照樣讀得出來，不需要資料搬遷
 *  3. 金鑰不對時**大聲失敗**——「金鑰換了」與「這個人沒填」在畫面上長得一樣，處置卻完全相反
 *  4. 沒設金鑰時行為與加密上線前完全相同（內網部署升級不該變成一次故障）
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, schema } from "@tw-erp/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { setupAdmin } from "./auth-helper.ts";

const KEY_A = "test-key-alpha-do-not-use-in-prod";
const KEY_B = "test-key-bravo-do-not-use-in-prod";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof drizzle>;
let admin: Record<string, string>;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...admin, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const storedIdNo = async (id: number): Promise<string | null> => {
  const [row] = await db.select().from(schema.partners).where(eq(schema.partners.id, id));
  return row!.idNo;
};

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  app = buildApp(db);
  admin = await setupAdmin(app);
});

afterEach(() => {
  delete process.env["PII_KEY"];
});

describe("設了 PII_KEY", () => {
  it("資料庫裡是密文，API 讀回來是明文", async () => {
    process.env["PII_KEY"] = KEY_A;
    const p = await api("/partners", { name: "加密房東", isIndividual: true, idNo: "TEST-ENC-0001" });
    expect(p.status).toBe(201);
    expect(p.json.hasIdNo).toBe(true); // 密文也是「有填」
    expect(p.json.idNo).toBeUndefined(); // 清單形狀一律不帶明文

    const raw = await storedIdNo(p.json.id);
    expect(raw).not.toContain("TEST-ENC-0001");
    expect(raw).toMatch(/^pii1\$/);

    expect((await api(`/partners/${p.json.id}/id-no`)).json.idNo).toBe("TEST-ENC-0001");
  });

  it("同一個號碼加密兩次得到不同密文（IV 每次都換，否則可以比對出誰跟誰是同一人）", async () => {
    process.env["PII_KEY"] = KEY_A;
    const a = await api("/partners", { name: "甲", isIndividual: true, idNo: "TEST-SAME-9" });
    const b = await api("/partners", { name: "乙", isIndividual: true, idNo: "TEST-SAME-9" });
    expect(await storedIdNo(a.json.id)).not.toBe(await storedIdNo(b.json.id));
  });

  it("PATCH 動別的欄位時不會把密文再加密一層", async () => {
    process.env["PII_KEY"] = KEY_A;
    const p = await api("/partners", { name: "改名前", isIndividual: true, idNo: "TEST-PATCH-2" });
    const before = await storedIdNo(p.json.id);
    await api(`/partners/${p.json.id}`, { name: "改名後" }, "PATCH");
    expect(await storedIdNo(p.json.id)).toBe(before);
    expect((await api(`/partners/${p.json.id}/id-no`)).json.idNo).toBe("TEST-PATCH-2");
  });

  it("清除身分證號後就是 null，不是一段解不開的密文", async () => {
    process.env["PII_KEY"] = KEY_A;
    const p = await api("/partners", { name: "要刪的", isIndividual: true, idNo: "TEST-DEL-3" });
    await api(`/partners/${p.json.id}/id-no`, undefined, "DELETE");
    expect(await storedIdNo(p.json.id)).toBeNull();
    expect((await api(`/partners/${p.json.id}/id-no`)).json.idNo).toBeNull();
  });
});

describe("金鑰不對或不見了", () => {
  let encryptedId: number;

  beforeAll(async () => {
    process.env["PII_KEY"] = KEY_A;
    encryptedId = (await api("/partners", { name: "金鑰測試", isIndividual: true, idNo: "TEST-KEY-4" })).json.id;
    delete process.env["PII_KEY"];
  });

  it("換了另一把金鑰：丟出說得出原因的錯誤，不是靜默回 null", async () => {
    process.env["PII_KEY"] = KEY_B;
    const res = await api(`/partners/${encryptedId}/id-no`);
    expect(res.status).toBe(500);
    expect(res.json.error).toContain("不是同一把金鑰");
  });

  it("金鑰整個不見了：訊息要講出「這筆是加密的」而不是「沒有資料」", async () => {
    const res = await api(`/partners/${encryptedId}/id-no`);
    expect(res.status).toBe(500);
    expect(res.json.error).toContain("PII_KEY 未設定");
  });
});

describe("沒設 PII_KEY（內網部署的現行形狀）", () => {
  it("行為與加密上線前完全相同：存明文、讀得到", async () => {
    const p = await api("/partners", { name: "內網房東", isIndividual: true, idNo: "TEST-PLAIN-5" });
    expect(await storedIdNo(p.json.id)).toBe("TEST-PLAIN-5");
    expect((await api(`/partners/${p.json.id}/id-no`)).json.idNo).toBe("TEST-PLAIN-5");
  });

  it("加密上線後，舊的明文列照樣讀得出來（升級不需要資料搬遷）", async () => {
    const p = await api("/partners", { name: "升級前建的", isIndividual: true, idNo: "TEST-LEGACY-6" });
    process.env["PII_KEY"] = KEY_A; // 之後才啟用加密
    expect((await api(`/partners/${p.json.id}/id-no`)).json.idNo).toBe("TEST-LEGACY-6");
    // 而且下次寫入時會自然變成密文，不需要另外跑搬遷程式
    await api(`/partners/${p.json.id}`, { idNo: "TEST-LEGACY-6" }, "PATCH");
    expect(await storedIdNo(p.json.id)).toMatch(/^pii1\$/);
  });
});
