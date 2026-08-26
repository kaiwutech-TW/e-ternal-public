/**
 * 科目代號首碼 ↔ 類別的交叉驗證。
 * 為什麼要測到「種子全體一致」這種整體不變量：allowedTypesForCode 是給 API 擋使用者輸入用的，
 * 但如果連我們自己出貨的種子都違反這張對應表，那就是對應表錯了而不是資料錯了。
 */
import { describe, expect, it } from "vitest";
import {
  CASH_ACCOUNT_CODES,
  EXPENSE_CATEGORIES,
  FINANCING_ACCOUNT_CODES,
  INVESTING_ACCOUNT_CODES,
  SEED_ACCOUNTS,
  SYSTEM_ACCOUNT_CODES,
  allowedTypesForCode,
} from "./chart.ts";

describe("allowedTypesForCode", () => {
  it("1-6 與 8 首碼各只對應一種類別", () => {
    expect(allowedTypesForCode("1101")).toEqual(["asset"]);
    expect(allowedTypesForCode("2144")).toEqual(["liability"]);
    expect(allowedTypesForCode("3101")).toEqual(["equity"]);
    expect(allowedTypesForCode("4101")).toEqual(["revenue"]);
    expect(allowedTypesForCode("5101")).toEqual(["expense"]);
    expect(allowedTypesForCode("6127")).toEqual(["expense"]);
    expect(allowedTypesForCode("8101")).toEqual(["expense"]);
  });

  it("7 首碼（營業外收支）收益與損失兩種都允許", () => {
    expect(allowedTypesForCode("7101").sort()).toEqual(["expense", "revenue"]);
    expect(allowedTypesForCode("7501")).toContain("expense");
    expect(allowedTypesForCode("7111")).toContain("revenue");
  });

  it("首碼不在 1-8 或空字串回空陣列（呼叫端據此擋下）", () => {
    for (const code of ["9101", "0101", "", "abcd"]) {
      expect(allowedTypesForCode(code)).toEqual([]);
    }
  });

  it("回傳的是複本，呼叫端改它不會汙染對應表", () => {
    const first = allowedTypesForCode("7101");
    first.pop();
    expect(allowedTypesForCode("7101")).toHaveLength(2);
  });

  it("內建種子科目全數符合對應表（否則是對應表寫錯）", () => {
    const violations = SEED_ACCOUNTS.filter((a) => !allowedTypesForCode(a.code).includes(a.type));
    expect(violations).toEqual([]);
  });
});

describe("科目表整體不變量", () => {
  it("種子代號不重複", () => {
    const codes = SEED_ACCOUNTS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("報銷分類與現金流量活動別的每個代號都真的存在於種子中", () => {
    const codes = new Set(SEED_ACCOUNTS.map((a) => a.code));
    for (const c of EXPENSE_CATEGORIES) expect(codes.has(c.accountCode)).toBe(true);
    for (const c of [...FINANCING_ACCOUNT_CODES, ...INVESTING_ACCOUNT_CODES]) expect(codes.has(c)).toBe(true);
  });

  it("報銷分類的科目一律是系統科目（拋轉直接指定，不可被停用）", () => {
    for (const c of EXPENSE_CATEGORIES) expect(SYSTEM_ACCOUNT_CODES).toContain(c.accountCode);
  });

  it("現金科目都存在於種子、都是資產類，且含 1102 零用金", () => {
    const byCode = new Map(SEED_ACCOUNTS.map((a) => [a.code, a]));
    for (const code of CASH_ACCOUNT_CODES) {
      // 不在種子裡的代號永遠不會被 seedAccounts 校正到 is_cash，等於這條定義是死的
      expect(byCode.get(code)).toBeDefined();
      expect(byCode.get(code)!.type).toBe("asset");
    }
    // 零用金也是公司帳上的一疊鈔票：漏了它，現金流量表的期末現金會和資產負債表對不起來
    expect(CASH_ACCOUNT_CODES).toContain("1102");
  });

  it("籌資與投資科目互斥，且不含 2144 應付帳款這類營業科目", () => {
    for (const c of FINANCING_ACCOUNT_CODES) expect(INVESTING_ACCOUNT_CODES).not.toContain(c);
    expect(FINANCING_ACCOUNT_CODES).not.toContain("2144");
    expect(FINANCING_ACCOUNT_CODES).not.toContain("2201");
    expect(INVESTING_ACCOUNT_CODES).not.toContain("1144");
  });
});
