/**
 * 金額規則：一律整數新台幣元（台灣統一發票金額為整數）。
 * 稅額：`calcTax(未稅額, 費率)`，四捨五入至整數元。規格書：docs/specs/posting-rules.md
 *
 * ★ 本檔不斷言任何稅率。實際費率由服務層依**單據日期**到 tax_parameters 解析
 *   （使用者自己查證、自己填、自己註明依據；見 docs/specs/tax-parameters.md）。
 */

/**
 * 回退費率：**這不是「正確的營業稅率」，是本系統在 tax_parameters 出現之前一直在用的那個值**。
 *
 * 它存在的唯一理由是「別讓系統壞掉」：參數表是空的、或單據日期早於使用者設定的最早生效日時，
 * 建單不該直接失敗（那會讓一個沒設定過參數的新資料庫連第一張單都開不出來），
 * 但也**絕不可以靜默**——服務層走到這條路徑一定會在回應裡帶警告，
 * 明白告訴使用者「用的是既有預設值，不是你查證的結果，請去補一列參數」。
 *
 * 因此這個常數只准出現在 services/tax-parameters.ts 的回退路徑，
 * 不得再被任何建單邏輯直接引用（原本散落在 documents/orders/purchase-orders/returns/
 * expenses/invoices 六處的 0.05 與 1.05 都已改為解析後的費率）。
 */
export const VAT_RATE_FALLBACK = 0.05;

export function roundHalfUp(n: number): number {
  return Math.round(n);
}

/**
 * 稅額 = 未稅額 × 費率，四捨五入至整數元。
 *
 * ⚠️ `rate` 的預設值是回退值（見上），**服務層一律必須明確傳入解析後的費率**。
 * 之所以保留預設而不改成必填：它同時是 posting.test.ts 那三格「純算術」測試的入口
 * （`calcTax(1000)=50` / `999=50` / `989=49`），那三格守的是「四捨五入怎麼進位」，
 * 不是「稅率是多少」。把它改成必填只會逼那三格填一個同樣寫死的數字，什麼都沒改善。
 */
export function calcTax(net: number, rate: number = VAT_RATE_FALLBACK): number {
  if (!Number.isInteger(net) || net < 0) throw new Error(`net 必須為非負整數元: ${net}`);
  return roundHalfUp(net * rate);
}

/** 明細金額 = 數量 × 單價，四捨五入至整數元 */
export function lineAmount(qty: number, unitPrice: number): number {
  if (qty <= 0 || unitPrice < 0) throw new Error(`數量須為正、單價須非負: qty=${qty}, unitPrice=${unitPrice}`);
  return roundHalfUp(qty * unitPrice);
}
