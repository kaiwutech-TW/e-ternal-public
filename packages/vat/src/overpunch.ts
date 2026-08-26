/**
 * COBOL S9 overpunch 編碼：正負號不佔位，表示在最後一位數字上。
 * 法源：《營業稅電子資料申報繳稅作業要點》第 21 點(十八)：
 *   正數末位 0-9 → { A B C D E F G H I
 *   負數末位 0-9 → } J K L M N O P Q R
 * 見 TRAPS `vat-s9-overpunch`。
 */

const POSITIVE = ["{", "A", "B", "C", "D", "E", "F", "G", "H", "I"] as const;
const NEGATIVE = ["}", "J", "K", "L", "M", "N", "O", "P", "Q", "R"] as const;

/** 編碼整數（元）為 S9(width) 欄位：絕對值左補零至 width，末位換 overpunch 字元 */
export function encodeS9(value: number, width: number): string {
  if (!Number.isInteger(value)) throw new Error(`S9 欄位須為整數: ${value}`);
  const abs = Math.abs(value).toString();
  if (abs.length > width) throw new Error(`S9(${width}) 溢位: ${value}`);
  const padded = abs.padStart(width, "0");
  const lastDigit = Number(padded[width - 1]!);
  const table = value < 0 ? NEGATIVE : POSITIVE;
  return padded.slice(0, width - 1) + table[lastDigit]!;
}

/** 解碼（測試用） */
export function decodeS9(field: string): number {
  const last = field[field.length - 1]!;
  const body = field.slice(0, -1);
  const pos = POSITIVE.indexOf(last as (typeof POSITIVE)[number]);
  if (pos >= 0) return Number(body + String(pos));
  const neg = NEGATIVE.indexOf(last as (typeof NEGATIVE)[number]);
  if (neg >= 0) return -Number(body + String(neg));
  throw new Error(`非 overpunch 欄位: ${field}`);
}

/** 9(width)：無號數字左補零 */
export function encode9(value: number, width: number): string {
  if (!Number.isInteger(value) || value < 0) throw new Error(`9(${width}) 須為非負整數: ${value}`);
  const s = value.toString();
  if (s.length > width) throw new Error(`9(${width}) 溢位: ${value}`);
  return s.padStart(width, "0");
}
