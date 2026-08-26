/**
 * 固定資產類別：白話類別 → 科目＋耐用年數（行政院「固定資產耐用年數表」常用項），
 * 與報銷分類同一設計思路——使用者選「這是電腦」，系統帶科目與年限。
 * 折舊採平均法（直線法）；殘值預設 成本÷(耐用年數+1)（所得稅法 54 條）。
 * 注意：年限對照與殘值公式列入記帳士審閱清單（chart-of-accounts.md 同批 draft）。
 */
import { roundHalfUp } from "./money.ts";

export interface AssetCategory {
  key: string;
  label: string;
  hint: string;
  years: number; // 耐用年數表常用值，登錄時可改
  assetCode: string; // 成本科目
  accumCode: string; // 累計折舊科目
}

export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  { key: "computer", label: "電腦設備", hint: "筆電、桌機、螢幕、伺服器", years: 3, assetCode: "1421", accumCode: "1429" },
  { key: "office", label: "辦公設備", hint: "傢俱、事務機、冷氣", years: 5, assetCode: "1421", accumCode: "1429" },
  { key: "machine", label: "機器設備", hint: "生產機台、工具機", years: 7, assetCode: "1411", accumCode: "1419" },
  { key: "vehicle", label: "運輸設備", hint: "公司車、機車、貨車", years: 5, assetCode: "1431", accumCode: "1439" },
  { key: "misc", label: "什項設備（含裝潢）", hint: "裝潢、租賃改良、其他設備", years: 5, assetCode: "1481", accumCode: "1489" },
] as const;

export const DEPRECIATION_EXPENSE_CODE = "6140"; // 折舊費用
export const DISPOSAL_GAIN_CODE = "7101"; // 出售資產利益
export const DISPOSAL_LOSS_CODE = "7501"; // 出售資產損失

/** 殘值預設：成本 ÷ (耐用年數 + 1)，所得稅法 54 條平均法 */
export function defaultSalvage(cost: number, years: number): number {
  return roundHalfUp(cost / (years + 1));
}

/** 每月折舊額（平均法）：(成本 − 殘值) ÷ (年數 × 12)；末期由呼叫端以剩餘可折金額收斂 */
export function monthlyDepreciation(cost: number, salvage: number, years: number): number {
  return roundHalfUp((cost - salvage) / (years * 12));
}
