import { describe, expect, it } from "vitest";
import { calcTax, lineAmount } from "./money.ts";
import { cogsFor, movingAvgUnitCost } from "./inventory.ts";
import {
  assertBalanced,
  purchaseEntryLines,
  purchaseReturnEntryLines,
  saleEntryLines,
  saleReturnEntryLines,
} from "./posting.ts";
import { allowanceInvCredit, prorateByQty } from "./returns.ts";

describe("營業稅與金額（docs/specs/posting-rules.md）", () => {
  it("稅額四捨五入至整數元（守的是進位方式，不是稅率）", () => {
    expect(calcTax(1000)).toBe(50);
    expect(calcTax(999)).toBe(50); // 49.95 → 50
    expect(calcTax(989)).toBe(49); // 49.45 → 49
    expect(calcTax(0)).toBe(0);
  });

  it("拒絕非整數或負數的未稅額", () => {
    expect(() => calcTax(100.5)).toThrow();
    expect(() => calcTax(-1)).toThrow();
  });

  it("明細金額 = 數量 × 單價，四捨五入至整數元", () => {
    expect(lineAmount(3, 33.33)).toBe(100); // 99.99 → 100
    expect(lineAmount(10, 100)).toBe(1000);
  });
});

describe("移動加權平均", () => {
  it("平均成本保留 4 位小數，銷貨成本取整數元", () => {
    expect(movingAvgUnitCost(3, 100)).toBe(33.3333);
    expect(cogsFor(2, 33.3333)).toBe(67); // 66.6666 → 67
  });

  it("庫存為零時拒絕計算", () => {
    expect(() => movingAvgUnitCost(0, 0)).toThrow();
  });
});

describe("自動拋轉傳票（借貸必平）", () => {
  it("進貨傳票：借 存貨+進項稅額 = 貸 應付帳款", () => {
    const lines = purchaseEntryLines({ subtotal: 1000, tax: 50, total: 1050 });
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(1050);
    expect(lines.reduce((s, l) => s + l.credit, 0)).toBe(1050);
  });

  it("銷貨傳票：含收入面與成本面共五筆明細", () => {
    const lines = saleEntryLines({ subtotal: 1200, tax: 60, total: 1260, cogs: 600 });
    expect(lines).toHaveLength(5);
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(1860);
    expect(lines.reduce((s, l) => s + l.credit, 0)).toBe(1860);
  });

  it("借貸不平即拋錯", () => {
    expect(() =>
      assertBalanced([
        { accountCode: "1101", debit: 100, credit: 0 },
        { accountCode: "2144", debit: 0, credit: 99 },
      ]),
    ).toThrow(/借貸不平/);
  });

  it("同一明細借貸皆有值即拋錯", () => {
    expect(() => assertBalanced([{ accountCode: "1101", debit: 100, credit: 100 }])).toThrow();
  });
});

describe("退回／折讓的攤分與傳票", () => {
  it("按數量比例攤，最後一個單位軋平（避免尾差永遠殘留）", () => {
    const step = (priorQty: number, priorAmount: number) =>
      prorateByQty({ originalAmount: 10, originalQty: 3, priorQty, priorAmount, returnQty: 1 });
    const a = step(0, 0);
    const b = step(1, a);
    const c = step(2, a + b);
    expect([a, b, c]).toEqual([3, 3, 4]); // 逐次 round 只會湊出 9，軋平後合計必為 10
    expect(a + b + c).toBe(10);
  });

  it("一次全退直接軋平為原額", () => {
    expect(prorateByQty({ originalAmount: 997, originalQty: 7, priorQty: 0, priorAmount: 0, returnQty: 7 })).toBe(997);
  });

  it("銷貨退回：借 4109＋2288、貸 應收/其他應付，成本面借 1301 貸 5101", () => {
    const lines = saleReturnEntryLines({
      subtotal: 1000, tax: 50, total: 1050, cogs: 400,
      arOffset: 800, payableAmount: 250, cashAmount: 0, restock: true,
    });
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(1450);
    expect(lines.reduce((s, l) => s + l.credit, 0)).toBe(1450);
    // 收入減項走 4109，不得出現在 4101（毛額要保得住，否則「賣了多少、退了多少」分不開）
    expect(lines.some((l) => l.accountCode === "4101")).toBe(false);
    expect(lines.find((l) => l.accountCode === "4109")).toMatchObject({ debit: 1000, credit: 0 });
  });

  it("銷貨折讓（restock=false）不產生存貨與成本兩行", () => {
    const lines = saleReturnEntryLines({
      subtotal: 100, tax: 5, total: 105, cogs: 0,
      arOffset: 105, payableAmount: 0, cashAmount: 0, restock: false,
    });
    expect(lines.map((l) => l.accountCode)).toEqual(["4109", "2288", "1144", "2201"]);
  });

  it("退現卻沒給現金科目即拋錯（不讓金額無聲落在錯的科目）", () => {
    expect(() =>
      saleReturnEntryLines({
        subtotal: 100, tax: 5, total: 105, cogs: 0,
        arOffset: 0, payableAmount: 0, cashAmount: 105, restock: false,
      }),
    ).toThrow(/現金科目/);
  });

  it("進貨退出：帳面不足的差額回沖 5101，借貸仍平", () => {
    const lines = purchaseReturnEntryLines({
      subtotal: 300, tax: 15, total: 315,
      apOffset: 315, receivableAmount: 0, cashAmount: 0,
      invCredit: 170, costDiff: 130,
    });
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(315);
    expect(lines.reduce((s, l) => s + l.credit, 0)).toBe(315);
    expect(lines.find((l) => l.accountCode === "5101")).toMatchObject({ debit: 0, credit: 130 });
  });

  it("進貨退出無差額時不產生 5101 那一行", () => {
    const lines = purchaseReturnEntryLines({
      subtotal: 300, tax: 15, total: 315,
      apOffset: 315, receivableAmount: 0, cashAmount: 0,
      invCredit: 300, costDiff: 0,
    });
    expect(lines.some((l) => l.accountCode === "5101")).toBe(false);
  });

  it("進貨退出的成本差異是雙向的：退款少於沖存貨的成本時借記 5101", () => {
    // 退還「便宜那批」100 個：退款 200，但帳上背的是均價 6 → 沖存貨 600、差額 −400
    const lines = purchaseReturnEntryLines({
      subtotal: 200, tax: 10, total: 210,
      apOffset: 210, receivableAmount: 0, cashAmount: 0,
      invCredit: 600, costDiff: -400,
    });
    expect(lines.find((l) => l.accountCode === "5101")).toMatchObject({ debit: 400, credit: 0 });
    expect(lines.find((l) => l.accountCode === "1301")).toMatchObject({ debit: 0, credit: 600 });
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(610);
    expect(lines.reduce((s, l) => s + l.credit, 0)).toBe(610);
  });
});

describe("進貨折讓的攤分（allowanceInvCredit：FIFO 消耗推定）", () => {
  it("賣掉一半後折讓：一半攤到存貨、一半回沖銷貨成本", () => {
    // 進 100 @ 10、這批進來後出庫 50 → 剩 50，比例 50/100
    expect(allowanceInvCredit({ allowance: 800, purchasedQty: 100, consumedSincePurchase: 50 })).toBe(400);
  });

  it("完全沒賣出去：全額攤到存貨（＝直接調降這批貨的成本）", () => {
    expect(allowanceInvCredit({ allowance: 800, purchasedQty: 100, consumedSincePurchase: 0 })).toBe(800);
  });

  it("已全數賣出：全額回沖銷貨成本，存貨不動", () => {
    expect(allowanceInvCredit({ allowance: 800, purchasedQty: 100, consumedSincePurchase: 100 })).toBe(0);
  });

  it("賣光之後又進了新貨也不受影響（分子看的是這批貨的消耗，不是商品當下在庫）", () => {
    // 2026-07-30 實測踩到的 bug：原本分子用「商品當下在庫數量」，
    // 「進 100 → 賣光 → 又進 100 → 對第一批折讓」會算成比例 1，
    // 折讓被攤到別批貨上再被帳面削平 → 均價變 0，之後每筆銷貨成本都是 0
    expect(allowanceInvCredit({ allowance: 800, purchasedQty: 100, consumedSincePurchase: 100 })).toBe(0);
    // 消耗超過原數量（後續批次也賣掉一些）仍是 0，不會變成負的
    expect(allowanceInvCredit({ allowance: 800, purchasedQty: 100, consumedSincePurchase: 250 })).toBe(0);
  });

  it("消耗量為負（不該發生）視為 0，比例封頂 1", () => {
    expect(allowanceInvCredit({ allowance: 500, purchasedQty: 100, consumedSincePurchase: -50 })).toBe(500);
  });

  it("四捨五入至整數元；原數量為 0 或負數即拋錯", () => {
    // 剩 1 / 原 3 → 100 × 0.3333 = 33.33 → 33
    expect(allowanceInvCredit({ allowance: 100, purchasedQty: 3, consumedSincePurchase: 2 })).toBe(33);
    expect(() => allowanceInvCredit({ allowance: 100, purchasedQty: 0, consumedSincePurchase: 0 })).toThrow();
  });
});
