import { describe, expect, it } from "vitest";
import { expenseCategoriesPath, isClaimDate } from "../src/pages/Expenses.tsx";

/**
 * 放在 src 外面的理由同 einvoice-qr.test.ts：apps/web 的 tsconfig 只收 src，
 * vitest 又不是這個 package 的相依，測試檔留在 src 裡會讓 `pnpm typecheck` 整包紅掉。
 *
 * 測的是「畫面問分類時帶不帶日期」這一件事。它看起來只是字串拼接，但拼錯的後果是
 * 端點改以「今天」解析可扣抵性，而伺服端建單是以報銷單日期解析——
 * 補登舊單、可扣抵參數又在中間變動過時，畫面提示與落地稅額會是兩個答案。
 */
describe("expenseCategoriesPath", () => {
  it("帶著報銷單日期去問，補登舊單才不會拿到今天的判定", () => {
    expect(expenseCategoriesPath("2026-01-31")).toBe("/expense-categories?onDate=2026-01-31");
  });

  it("日期不同＝path 不同，useFetch 才會跟著重取", () => {
    expect(expenseCategoriesPath("2026-01-31")).not.toBe(expenseCategoriesPath("2026-08-20"));
  });

  // 這裡是 W3 那條漂移的最後一個藏身處：回 "/expense-categories" 的話，端點沒收到 onDate
  // 就以「今天」解析可扣抵性——使用者打字打到一半，下拉就悄悄換成今天的判定而他不會知道。
  it("日期打到一半（空字串／半截）時回 null＝不發請求，**不是**退回不帶參數（那等於悄悄改用今天）", () => {
    for (const bad of ["", "2026", "2026-1-3", "2026-01-31T00:00:00", "今天"]) {
      expect(expenseCategoriesPath(bad)).toBeNull();
      expect(expenseCategoriesPath(bad)).not.toBe("/expense-categories");
      expect(isClaimDate(bad)).toBe(false);
    }
  });

  it("isClaimDate 與 expenseCategoriesPath 用同一條規則（畫面靠它決定要不要換掉上一個有效日期）", () => {
    for (const good of ["2026-01-31", "2026-08-20", "1999-12-31"]) {
      expect(isClaimDate(good)).toBe(true);
      expect(expenseCategoriesPath(good)).toBe(`/expense-categories?onDate=${good}`);
    }
  });

  it("帶出去的格式吃得下端點的 onDate 檢核（app.ts 用同一條 YYYY-MM-DD 規則擋）", () => {
    const q = new URL(`http://x${expenseCategoriesPath("2026-01-31")!}`).searchParams.get("onDate");
    expect(q).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
