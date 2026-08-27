import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { suggestionApiRow } from "./expenses-fixtures.ts";

/**
 * 【③】跨賽道的欄位名。
 *
 * 這條測試存在的原因是一個**在真實環境壞掉、而兩側測試都全綠**的缺陷：
 * 伺服端把候選的 `count` 改名成 `claimCount`（語意從「幾筆明細」改成「幾張單」——
 * 一張單＝一次被公司接受的歸類決定），前端還在讀 `count`，於是畫面上那個括號永遠是空的。
 * 兩邊的測試各自捏了自己那一半的欄位名，所以誰都沒有看見。
 *
 * 所以這裡**不憑記憶、也不再捏一份**：直接去讀 apps/api 的原始碼，把
 * sellerCategorySuggestions 真正回出來的鍵拿出來，跟前端 fixture（綁在前端宣告的型別上）比。
 * 任何一側單方面改名，這裡就紅。
 *
 * ★ 為什麼不 import apps/api：@tw-erp/web 沒有相依它（也不該有——那會把 drizzle 與整個
 *   資料層拖進前端的型別檢查與建置圖）。跨 workspace 只剩「讀原始碼」這條路。
 * ★ 抓不到那段程式碼時**丟錯**（不是靜靜跳過）：伺服端改寫法時要在這裡大聲失敗，
 *   而不是讓這條測試退化成一個永遠會過的空斷言。
 */

const API_SOURCE = readFileSync(new URL("../../api/src/services/expenses.ts", import.meta.url), "utf8");

/** sellerCategorySuggestions 那一支函式的原始碼（從 export 起到它自己的收尾大括號）。 */
function suggestionsFunctionSource(): string {
  const from = API_SOURCE.indexOf("export async function sellerCategorySuggestions(");
  if (from < 0) {
    throw new Error("在 apps/api 找不到 sellerCategorySuggestions——它被改名或搬走了，這條測試要跟著改");
  }
  const to = API_SOURCE.indexOf("\n}\n", from);
  if (to < 0) throw new Error("sellerCategorySuggestions 的函式主體找不到結尾");
  return API_SOURCE.slice(from, to);
}

/** 伺服端**宣告**回什麼鍵（`Promise<{ … }[]>` 那一段）。 */
function declaredKeys(fn: string): string[] {
  const m = /Promise<\{([^}]+)\}\[\]>/.exec(fn);
  if (!m) throw new Error("讀不到 sellerCategorySuggestions 的回傳型別標註");
  return [...m[1]!.matchAll(/(\w+)\s*:/g)].map((k) => k[1]!).sort();
}

/** 伺服端**實際**回什麼鍵（最後那個 `return rows.map((r) => ({ … }))`）。 */
function returnedKeys(fn: string): string[] {
  const m = /return rows\.map\(\(r\) => \(\{([^}]+)\}\)\);/.exec(fn);
  if (!m) throw new Error("讀不到 sellerCategorySuggestions 的回傳物件——它的寫法變了");
  return [...m[1]!.matchAll(/^\s*(\w+):/gm)].map((k) => k[1]!).sort();
}

describe("【③】歷史分類候選：前端讀的欄位名 == 伺服端回的欄位名", () => {
  const fn = suggestionsFunctionSource();

  it("伺服端宣告的鍵與它實際回的鍵一致（型別標註對、物件卻少一個鍵的話這裡先紅）", () => {
    expect(returnedKeys(fn)).toEqual(declaredKeys(fn));
  });

  it("前端 fixture 的鍵就是伺服端回的鍵（任何一側單方面改名，這裡紅）", () => {
    expect(Object.keys(suggestionApiRow("6133", 12)).sort()).toEqual(returnedKeys(fn));
  });

  /**
   * 名字之外還有語意：claimCount 是 count(distinct claim_id)。
   * 若哪天有人把它改回逐筆計數而名字沒動，上面兩條都還是綠的——這一條盯的是那件事。
   */
  it("那個數字是「幾張單」：伺服端算的是不同單據數，不是明細筆數", () => {
    expect(fn).toContain("claimCount: countDistinct(schema.expenseItems.claimId)");
  });
});
