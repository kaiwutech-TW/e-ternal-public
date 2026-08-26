/**
 * 存貨計價：移動加權平均（DECISIONS 2026-07-21）。
 * 單位成本保留 4 位小數；銷貨成本四捨五入至整數元。
 */
import { roundHalfUp } from "./money.ts";

export function movingAvgUnitCost(onHandQty: number, onHandAmount: number): number {
  if (onHandQty <= 0) throw new Error(`庫存不足，無法計算平均成本: qty=${onHandQty}`);
  return Math.round((onHandAmount / onHandQty) * 10000) / 10000;
}

export function cogsFor(qty: number, unitCost: number): number {
  return roundHalfUp(qty * unitCost);
}
