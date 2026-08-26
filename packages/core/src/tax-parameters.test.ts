/**
 * 稅法參數的算術與解析。
 *
 * ⚠️ 本檔的每一個數字都是**中性的**：級距用 10 萬／30 萬，費率用 3.5%／20%／50%。
 *    刻意不用任何真實稅制的級距或稅率——這裡測的是算術，不是稅制；
 *    而測試資料是最容易被當成「系統認可的答案」抄走的地方
 *    （見 .flightwake/TRAPS.md 的 system-asserts-what-it-says-it-doesnt-know）。
 */
import { describe, expect, it } from "vitest";
import {
  computeByBrackets,
  dayBefore,
  findBracket,
  flatRateBp,
  resolveParameter,
  validateBrackets,
  type TaxBracket,
} from "./tax-parameters.ts";

/** 三段中性級距：0–10 萬不課、10 萬–30 萬超額 20%、30 萬以上超額 50% */
const TIERED: TaxBracket[] = [
  { from: 0, to: 100_000, mode: "exempt" },
  { from: 100_000, to: 300_000, mode: "rate_of_excess", rateBp: 2000 },
  { from: 300_000, to: null, mode: "rate_of_excess", rateBp: 5000 },
];

describe("computeByBrackets：三種 mode 的算術", () => {
  it("exempt 一律 0", () => {
    expect(computeByBrackets(0, TIERED)).toBe(0);
    expect(computeByBrackets(50_000, TIERED)).toBe(0);
  });

  it("rate_on_total：全額 × 費率", () => {
    const flat: TaxBracket[] = [{ from: 0, to: null, mode: "rate_on_total", rateBp: 350 }];
    expect(computeByBrackets(100_000, flat)).toBe(3_500); // 100000 × 3.5%
    expect(computeByBrackets(1_000, flat)).toBe(35);
  });

  it("rate_of_excess：只有超過起點的部分課", () => {
    expect(computeByBrackets(200_000, TIERED)).toBe(20_000); // (200000−100000) × 20%
    expect(computeByBrackets(500_000, TIERED)).toBe(100_000); // (500000−300000) × 50%
  });

  it("四捨五入至整數元（沿用全系統的金額慣例）", () => {
    const flat = (rateBp: number): TaxBracket[] => [{ from: 0, to: null, mode: "rate_on_total", rateBp }];
    expect(computeByBrackets(999, flat(350))).toBe(35); // 34.965 → 35
    expect(computeByBrackets(101, flat(350))).toBe(4); // 3.535 → 4
    expect(computeByBrackets(1, flat(350))).toBe(0); // 0.035 → 0
  });

  it("剛好等於級距起點：歸**較高**的那一級（與「超過 X 者適用下一級」一致）", () => {
    // 100000 同時落在 [0,100000] 與 [100000,300000]，取後者 → (100000−100000)×20% = 0
    expect(findBracket(100_000, TIERED)?.from).toBe(100_000);
    expect(computeByBrackets(100_000, TIERED)).toBe(0);
    // 300000 落在第三級 → (300000−300000)×50% = 0
    expect(findBracket(300_000, TIERED)?.from).toBe(300_000);
    expect(computeByBrackets(300_000, TIERED)).toBe(0);
    // 邊界再往上一元就開始課
    expect(computeByBrackets(100_001, TIERED)).toBe(0); // 1 × 20% = 0.2 → 0
    expect(computeByBrackets(100_010, TIERED)).toBe(2); // 10 × 20% = 2
  });

  it("剛好等於級距上限：仍在該級距內（上限含）", () => {
    const capped: TaxBracket[] = [{ from: 0, to: 100_000, mode: "rate_on_total", rateBp: 350 }];
    expect(computeByBrackets(100_000, capped)).toBe(3_500);
    // 超過上限就沒有級距涵蓋——不可以默默回 0
    expect(() => computeByBrackets(100_001, capped)).toThrow(/沒有落在任何一個級距/);
  });

  it("空級距與不連續級距一律丟錯，且訊息指得出脫困路徑（不可默默回 0）", () => {
    expect(() => computeByBrackets(1_000, [])).toThrow(/沒有任何級距/);
    const gapped: TaxBracket[] = [
      { from: 0, to: 100_000, mode: "rate_on_total", rateBp: 350 },
      { from: 300_000, to: null, mode: "rate_on_total", rateBp: 2000 },
    ];
    expect(computeByBrackets(100_000, gapped)).toBe(3_500);
    expect(computeByBrackets(300_000, gapped)).toBe(60_000);
    // 落在 10 萬與 30 萬之間的空隙：算不出來就要說算不出來
    expect(() => computeByBrackets(200_000, gapped)).toThrow(/補一個涵蓋 200000 的級距/);
  });

  it("課稅級距沒填費率也丟錯（不當成 0）", () => {
    const noRate: TaxBracket[] = [{ from: 0, to: null, mode: "rate_on_total" }];
    expect(() => computeByBrackets(1_000, noRate)).toThrow(/沒有填費率/);
  });

  it("課稅基礎須為非負整數元", () => {
    expect(() => computeByBrackets(100.5, TIERED)).toThrow();
    expect(() => computeByBrackets(-1, TIERED)).toThrow();
  });
});

describe("validateBrackets：只驗結構，不驗稅制內容", () => {
  it("合法的級距回空陣列", () => {
    expect(validateBrackets(TIERED)).toEqual([]);
    expect(validateBrackets([{ from: 0, to: null, mode: "rate_on_total", rateBp: 350 }])).toEqual([]);
  });

  it("空陣列、上限小於起點、重疊、費率超出 0–100% 都擋下", () => {
    expect(validateBrackets([])).toHaveLength(1);
    expect(validateBrackets([{ from: 100, to: 50, mode: "rate_on_total", rateBp: 350 }])[0]).toMatch(/上限/);
    const overlapping: TaxBracket[] = [
      { from: 0, to: 200_000, mode: "rate_on_total", rateBp: 350 },
      { from: 100_000, to: null, mode: "rate_on_total", rateBp: 2000 },
    ];
    expect(validateBrackets(overlapping).some((p) => /重疊/.test(p))).toBe(true);
    expect(
      validateBrackets([{ from: 0, to: null, mode: "rate_on_total", rateBp: 10_001 }])[0],
    ).toMatch(/0–100 的百分比/);
  });

  it("相鄰級距共用邊界值不算重疊（剛好等於的那一格歸較高一級）", () => {
    expect(validateBrackets(TIERED)).toEqual([]);
  });

  it("「無上限」的級距後面不可以再有級距", () => {
    const bad: TaxBracket[] = [
      { from: 0, to: null, mode: "rate_on_total", rateBp: 350 },
      { from: 100_000, to: null, mode: "rate_on_total", rateBp: 2000 },
    ];
    expect(validateBrackets(bad).some((p) => /無上限/.test(p))).toBe(true);
  });

  it("exempt 填了費率會被指出來（那個費率永遠不會被用到）", () => {
    expect(validateBrackets([{ from: 0, to: null, mode: "exempt", rateBp: 350 }])[0]).toMatch(/不會被使用/);
  });

  it("不驗證數值合理性：極端但結構正確的級距一律放行", () => {
    expect(validateBrackets([{ from: 0, to: null, mode: "rate_on_total", rateBp: 10_000 }])).toEqual([]);
    expect(validateBrackets([{ from: 0, to: null, mode: "rate_on_total", rateBp: 0 }])).toEqual([]);
  });
});

describe("flatRateBp：讀得出單一費率才給，讀不出就回 null", () => {
  it("單一 rate_on_total 級距＝單一費率", () => {
    expect(flatRateBp([{ from: 0, to: null, mode: "rate_on_total", rateBp: 350 }])).toBe(350);
  });

  it("單一 exempt 級距＝0", () => {
    expect(flatRateBp([{ from: 0, to: null, mode: "exempt" }])).toBe(0);
  });

  it("多段級距、超額累進、沒填費率一律 null（呼叫端要走回退並說明理由）", () => {
    expect(flatRateBp(TIERED)).toBeNull();
    expect(flatRateBp([{ from: 0, to: null, mode: "rate_of_excess", rateBp: 350 }])).toBeNull();
    expect(flatRateBp([{ from: 0, to: null, mode: "rate_on_total" }])).toBeNull();
    expect(flatRateBp([])).toBeNull();
  });
});

describe("resolveParameter：依日期挑出生效的那一列", () => {
  const rows = [
    { id: 1, kind: "vat", scopeKey: null, validFrom: "2024-01-01", validTo: "2025-12-31" },
    { id: 2, kind: "vat", scopeKey: null, validFrom: "2026-01-01", validTo: null },
    { id: 3, kind: "input_tax_deductible", scopeKey: "6137", validFrom: "2026-01-01", validTo: null },
    { id: 4, kind: "input_tax_deductible", scopeKey: "6112", validFrom: "2026-06-01", validTo: null },
  ];

  it("同一 kind 兩列不同期間，兩個日期各拿到對的那列", () => {
    expect(resolveParameter(rows, "vat", "2025-06-15")?.id).toBe(1);
    expect(resolveParameter(rows, "vat", "2026-06-15")?.id).toBe(2);
  });

  it("期間兩端都含", () => {
    expect(resolveParameter(rows, "vat", "2024-01-01")?.id).toBe(1);
    expect(resolveParameter(rows, "vat", "2025-12-31")?.id).toBe(1);
  });

  it("valid_to = NULL 代表仍有效，未來日期也涵蓋", () => {
    expect(resolveParameter(rows, "vat", "2099-12-31")?.id).toBe(2);
  });

  it("落在空窗期（兩列之間）回 null——呼叫端要走回退並出聲", () => {
    expect(resolveParameter(rows, "vat", "2023-12-31")).toBeNull();
  });

  it("scopeKey 必須完全相符，不做「找不到就退回 null scope」的 fallback", () => {
    expect(resolveParameter(rows, "input_tax_deductible", "2026-07-01", "6137")?.id).toBe(3);
    expect(resolveParameter(rows, "input_tax_deductible", "2026-07-01", "6112")?.id).toBe(4);
    // 6112 的設定要到 2026-06-01 才生效，之前應解析不到（不可掉到 6137 那一列上）
    expect(resolveParameter(rows, "input_tax_deductible", "2026-03-01", "6112")).toBeNull();
    // 沒有設定過的科目
    expect(resolveParameter(rows, "input_tax_deductible", "2026-07-01", "6133")).toBeNull();
    // 未給 scopeKey＝找 scopeKey 為 null 的列
    expect(resolveParameter(rows, "input_tax_deductible", "2026-07-01")).toBeNull();
  });

  it("萬一有兩列同時涵蓋（例如直接改資料庫），取 validFrom 最晚的那一列（結果必須是決定性的）", () => {
    const messy = [
      { id: 10, kind: "vat", scopeKey: null, validFrom: "2026-01-01", validTo: null },
      { id: 11, kind: "vat", scopeKey: null, validFrom: "2026-05-01", validTo: null },
    ];
    expect(resolveParameter(messy, "vat", "2026-07-01")?.id).toBe(11);
  });
});

describe("dayBefore（接續操作用）", () => {
  it("跨月、跨年、跨閏日", () => {
    expect(dayBefore("2026-07-01")).toBe("2026-06-30");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
    expect(dayBefore("2024-03-01")).toBe("2024-02-29"); // 2024 是閏年
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
  });

  it("格式錯誤丟錯", () => {
    expect(() => dayBefore("2026/07/01")).toThrow();
  });
});
