/**
 * 字軌期別演算（B7 尾款）：periodOf（配號歸期）與 nextPeriod（「下期字軌還沒建」提醒）
 * 是同一條規則的兩半——雙月一期、奇數月起算。Dashboard 的提醒列與 API 配號都吃這兩個函式。
 */
import { describe, expect, it } from "vitest";
import { nextPeriod, periodOf } from "../src/period.ts";

describe("periodOf", () => {
  it("雙月一期、奇數月起算：奇數月與偶數月落同一期", () => {
    expect(periodOf("2026-07-01")).toBe("202607");
    expect(periodOf("2026-08-31")).toBe("202607");
    expect(periodOf("2026-01-15")).toBe("202601");
    expect(periodOf("2026-12-31")).toBe("202611");
  });

  it("非法日期直接拋錯，不猜", () => {
    expect(() => periodOf("2026/07/01")).toThrow("YYYY-MM-DD");
    expect(() => periodOf("2026-13-01")).toThrow("月份不合法");
  });
});

describe("nextPeriod", () => {
  it("年內：期別 +2 個月（202607 → 202609）", () => {
    expect(nextPeriod("202601")).toBe("202603");
    expect(nextPeriod("202607")).toBe("202609");
    expect(nextPeriod("202609")).toBe("202611");
  });

  it("跨年：202611 → 202701", () => {
    expect(nextPeriod("202611")).toBe("202701");
  });

  it("偶數月或格式不對直接拋錯（期別一定是奇數月起算，收下錯值等於算錯下一期）", () => {
    expect(() => nextPeriod("202608")).toThrow("奇數月");
    expect(() => nextPeriod("2026-07")).toThrow("YYYYMM");
  });
});
