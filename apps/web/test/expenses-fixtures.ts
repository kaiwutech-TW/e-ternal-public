import type { SuggestionApiRow } from "../src/CategorySuggestions.tsx";
import type { ExpenseCategory } from "../src/types.ts";

/**
 * 歷史分類候選的 fixture——**只有這一份**（不是測試檔，vitest 的 include 只收 *.test.ts）。
 *
 * 為什麼要抽出來：上一輪伺服端把 `count` 改名成 `claimCount`（語意從「幾筆明細」改成
 * 「幾張單」），前端沒跟上，畫面上那個數字永遠是 undefined——而**兩邊的測試各自捏了自己
 * 那一半的欄位名**，所以誰都測不出來。每支測試各寫一份 fixture 的代價就是這個：
 * fixture 跟著被測的那一側一起改，於是兩側可以各自「全綠」地漂到對不起來。
 *
 * 這一份綁在前端**宣告的型別**上（回傳值標註 SuggestionApiRow），所以：
 *  - 前端改了欄位名而這裡沒改 ⇒ typecheck 紅；
 *  - 前端與**伺服端**漂開 ⇒ test/expenses-field-names.test.ts 去讀 apps/api 的原始碼比對，紅。
 */

/** 端點回的一筆（形狀由 api/src/services/expenses.ts 的 sellerCategorySuggestions 決定）。 */
export const suggestionApiRow = (accountCode: string, claimCount: number): SuggestionApiRow => ({
  accountCode,
  label: `分類${accountCode}`,
  claimCount,
});

/**
 * 分類清單裡的一項（`GET /expense-categories?onDate=…` 回的形狀）。
 *
 * 候選只列得出「下拉選單裡也有」的科目（見 src/CategorySuggestions.tsx），所以要驗候選那條路，
 * 一定要同時有一份分類清單——兩份 fixture 的 label 寫法在這裡對齊，畫面上的字才對得起來。
 * 可扣抵的預設值一律 true／default：這一份是給「候選與分類」那條路用的，
 * 不替可扣抵性那條路（DeductibleNote，另有自己的測試）預設任何結論。
 */
export const expenseCategoryFixture = (accountCode: string): ExpenseCategory => ({
  accountCode,
  label: `分類${accountCode}`,
  hint: "",
  inputTaxDeductible: true,
  defaultDeductible: true,
  deductibleSource: "default",
  deductibleParameterId: null,
  deductibleSourceNote: null,
  deductibleValidFrom: null,
  deductibleValidTo: null,
});
