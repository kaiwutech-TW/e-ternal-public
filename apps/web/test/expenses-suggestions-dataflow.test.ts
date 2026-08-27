import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 【資料流】歷史分類候選（W7）：候選資料只有一個來源，而那個來源只有一支模組碰得到。
 *
 * 這是這一批工作裡**唯一**留下來的讀原始碼斷言，理由要講清楚——同一批剛剛才刪掉三條
 * 讀原始碼的裝飾品（取個別名、把 `=== 1` 寫成 `< 2` 就穿過去的那種）。
 *
 * 這一條不一樣的地方在於它掃的**不是某一種寫法**，而是**取得資料的唯一入口**：
 * 候選資料在前端只有一個來源，就是這個端點路徑。報銷表單那一層（Expenses.tsx，握著 setItem、
 * 知道有幾列、改得動任何欄位的那一層）已經 import 不到任何算得出候選的東西——
 * src/CategorySuggestions.tsx 只匯出元件本身（實測：`import { loadSellerSuggestions }` 編譯不過）。
 * 於是它要重新看見候選清單，只剩「自己再打一次這個端點」這條路，而那條路會在這裡現形。
 *
 * ★ 射程，誠實寫：把路徑拆成字串相接（`"/expense-categories/" + "suggestions"`）就掃不到。
 *   這條擋不住蓄意繞路的人。它擋的是「順手在別的地方也去問一次」——
 *   把一個寫得順手的迴歸，變成一個必須刻意混淆才寫得出來的東西。
 *   真正的保證是資料流本身（見 src/CategorySuggestions.tsx 的檔頭）與那支元件的行為矩陣
 *   （test/expenses-category-suggestions.dom.test.tsx）。
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const sourceFiles = readdirSync(SRC, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
  .map((e) => join(e.parentPath, e.name));

describe("候選端點的呼叫點只有一個", () => {
  it("apps/web/src 底下提到 /expense-categories/suggestions 的檔案只有 CategorySuggestions.tsx", () => {
    const hits = sourceFiles.filter((f) => readFileSync(f, "utf8").includes("/expense-categories/suggestions"));
    expect(hits.map((f) => relative(SRC, f))).toEqual(["CategorySuggestions.tsx"]);
  });

  /** 掃描本身壞掉（路徑錯了、副檔名規則變了）要在這裡紅，而不是靜靜地掃到零個檔案然後全綠 */
  it("掃得到的檔案數合理", () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
    expect(sourceFiles.some((f) => f.endsWith("pages/Expenses.tsx"))).toBe(true);
  });
});
