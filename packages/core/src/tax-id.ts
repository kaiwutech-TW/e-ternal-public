/**
 * 營利事業統一編號（統編）檢查碼驗證。
 * 規格書：docs/specs/tax-id.md（法源與測試對照見該文件）
 *
 * 演算法：8 位數字逐位乘以權重 [1,2,1,2,1,2,4,1]，各乘積取十位數＋個位數相加後總和；
 * 總和可被 5 整除即有效（財政部 2023-04 起的新版邏輯，舊制為可被 10 整除）。
 * 特例：第 7 位為 7 時（乘積 28 → 位數和 10），該位得以 1 計，兩種算法任一成立即有效。
 */

const WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1] as const;

export function isValidTaxId(taxId: string): boolean {
  if (!/^\d{8}$/.test(taxId)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const product = Number(taxId[i]) * WEIGHTS[i]!;
    sum += Math.floor(product / 10) + (product % 10);
  }
  if (sum % 5 === 0) return true;
  return taxId[6] === "7" && (sum - 9) % 5 === 0;
}
