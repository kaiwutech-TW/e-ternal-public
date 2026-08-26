/**
 * 扣繳的算術。這裡刻意「只」測算術——沒有任何一格測「某類所得應該扣幾 %」，
 * 因為費率不是程式的知識，是使用者填的資料（見 withholding.ts 檔頭）。
 * 若有人日後在本檔加入具體稅率的期望值，那就是本批設計紀律被推翻的訊號。
 */
import { describe, expect, it } from "vitest";
import { ACCOUNT, SEED_ACCOUNTS, SYSTEM_ACCOUNT_CODES } from "./chart.ts";
import { BP_PER_UNIT, bpToPercentText, percentToBp, withheldByRate } from "./withholding.ts";

describe("withheldByRate", () => {
  it("費率為 null／undefined 時回 null，不是 0（「還沒查」與「不用扣」必須分得開）", () => {
    expect(withheldByRate(30_000, null)).toBeNull();
    expect(withheldByRate(30_000, undefined)).toBeNull();
    // 0 是使用者查過之後填的「不用扣」，要照著算出 0
    expect(withheldByRate(30_000, 0)).toBe(0);
  });

  it("basis point 乘算，四捨五入至整數元", () => {
    expect(withheldByRate(30_000, 1_000)).toBe(3_000); // 10%
    expect(withheldByRate(30_000, 191)).toBe(573); // 1.91% —— 帶小數的費率，測的是 bp 的精度不是稅法
    expect(withheldByRate(1, 1)).toBe(0); // 0.01% × 1 元 = 0.0001 → 0
    expect(withheldByRate(12_345, 250)).toBe(309); // 308.625 → 309
    expect(withheldByRate(10_000, BP_PER_UNIT)).toBe(10_000); // 100%：淨額為 0，服務層允許
  });

  it("給付額須為正整數元、費率須在 0–10000 之間（打錯一個零要在這裡就炸）", () => {
    expect(() => withheldByRate(0, 1_000)).toThrow(/正整數/);
    expect(() => withheldByRate(-100, 1_000)).toThrow(/正整數/);
    expect(() => withheldByRate(100.5, 1_000)).toThrow(/正整數/);
    expect(() => withheldByRate(100, -1)).toThrow(/basis point/);
    expect(() => withheldByRate(100, 10_001)).toThrow(/basis point/);
    expect(() => withheldByRate(100, 10.5)).toThrow(/basis point/);
  });
});

describe("百分比與 basis point 的互換（UI 輸入輸出）", () => {
  it("來回轉換不失真", () => {
    for (const bp of [0, 1, 191, 500, 1_000, 2_100, 10_000]) {
      expect(percentToBp(Number(bpToPercentText(bp)))).toBe(bp);
    }
  });

  it("超出 0–100 或非數字回 null（由呼叫端擋下並顯示訊息）", () => {
    expect(percentToBp(-1)).toBeNull();
    expect(percentToBp(101)).toBeNull();
    expect(percentToBp(Number.NaN)).toBeNull();
    expect(percentToBp(1.91)).toBe(191); // 兩位小數的百分比不得因浮點而失真
  });
});

describe("代扣款科目", () => {
  it("2211／2212 是系統科目且存在於種子（扣繳支出單直接指定這兩碼，停用會讓單據過不了帳）", () => {
    const codes = new Set(SEED_ACCOUNTS.map((a) => a.code));
    for (const code of [ACCOUNT.WITHHOLDING_TAX_PAYABLE, ACCOUNT.WITHHOLDING_SUPPLEMENT_PAYABLE]) {
      expect(codes.has(code)).toBe(true);
      expect(SYSTEM_ACCOUNT_CODES).toContain(code);
      expect(SEED_ACCOUNTS.find((a) => a.code === code)!.type).toBe("liability");
    }
  });
});
