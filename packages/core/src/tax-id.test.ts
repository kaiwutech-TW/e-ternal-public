import { describe, expect, it } from "vitest";
import { isValidTaxId } from "./tax-id.ts";

describe("isValidTaxId（統編檢查碼，見 docs/specs/tax-id.md）", () => {
  it("接受真實有效統編（位數和可被 10 整除，新舊制皆有效）", () => {
    expect(isValidTaxId("22099131")).toBe(true); // 台積電
    expect(isValidTaxId("04541302")).toBe(true); // 鴻海精密
    expect(isValidTaxId("96979933")).toBe(true); // 中華電信
  });

  it("接受僅新制有效的統編（位數和 25，可被 5 但不可被 10 整除）", () => {
    expect(isValidTaxId("00099007")).toBe(true);
  });

  it("接受僅靠第 7 位為 7 特例才有效的統編（10 以 1 計）", () => {
    expect(isValidTaxId("40000070")).toBe(true); // 和為 14，特例後為 5
  });

  it("拒絕檢查碼錯誤的號碼", () => {
    expect(isValidTaxId("22099132")).toBe(false); // 和為 31
    expect(isValidTaxId("12345678")).toBe(false); // 和為 42，特例後 33 仍無效
  });

  it("拒絕格式錯誤的輸入", () => {
    expect(isValidTaxId("1234567")).toBe(false); // 7 位
    expect(isValidTaxId("123456789")).toBe(false); // 9 位
    expect(isValidTaxId("2209913a")).toBe(false); // 非數字
    expect(isValidTaxId("")).toBe(false);
  });
});
