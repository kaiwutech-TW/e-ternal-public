/**
 * 附件五：營業人進、銷項資料檔（81 Bytes 固定長度，ASCII）。
 * 法源：《營業稅電子資料申報繳稅作業要點》第 20 點（113-04-12 修正）。
 * 欄位版面（起-迄，1-indexed）：
 *   格式代號 1-2 ｜ 稅籍編號 3-11 ｜ 流水號 12-18 ｜ 民國年 19-21 ｜ 月 22-23
 *   買受人統編(銷項) 24-31 ｜ 銷售人統編(進項) 32-39 ｜ 字軌 40-41 ｜ 發票號碼 42-49
 *   銷售金額 50-61 ｜ 課稅別 62 ｜ 營業稅額 63-72 ｜ 扣抵代號 73 ｜ 空白 74-78
 *   特種稅率 79 ｜ 彙加/分攤註記 80 ｜ 通關方式註記 81
 */
import { encode9 } from "./overpunch.ts";

/** 一般稅額計算之格式代號（第 20 點(一)；本專案主用 25 進項電子發票、35 銷項電子發票、33 銷項退回折讓） */
export const FORMAT_CODES = {
  INPUT_TRIPLICATE: "21",
  INPUT_DUPLICATE_OTHER: "22",
  INPUT_RETURN_TRIPLICATE: "23",
  INPUT_RETURN_DUPLICATE: "24",
  INPUT_EINVOICE: "25",
  OUTPUT_TRIPLICATE: "31",
  OUTPUT_DUPLICATE: "32",
  OUTPUT_RETURN_TRIPLICATE: "33",
  OUTPUT_RETURN_DUPLICATE: "34",
  OUTPUT_EINVOICE: "35",
  OUTPUT_NO_INVOICE: "36",
} as const;

export type TaxType = "1" | "2" | "3" | "F" | "D"; // 應稅/零稅率/免稅/作廢/空白未使用
export type DeductionCode = "1" | "2" | "3" | "4" | " "; // 可扣抵進貨費用/可扣抵固資/不可扣抵進貨費用/不可扣抵固資/銷項空白

export interface MediaRecord {
  formatCode: string; // 2 碼
  taxRegistrationNo: string; // 稅籍編號 9 碼
  serial: number; // 流水號（依序，不重複）
  rocYear: number; // 民國年 3 碼
  month: number; // 1-12
  buyerTaxId?: string | undefined; // 銷項：買受人統編（無統編＝B2C 補空白）
  sellerTaxId?: string | undefined; // 進項：銷售人統編
  track: string; // 發票字軌 2 碼
  invoiceNo: string; // 發票號碼 8 碼
  salesAmount: number; // 銷售金額（元）
  taxType: TaxType;
  taxAmount: number; // 營業稅額（元）
  deductionCode: DeductionCode;
}

function fixed(value: string, width: number, name: string): string {
  if (!/^[\x20-\x7E]*$/.test(value)) throw new Error(`${name} 不可含非 ASCII 字元: ${value}`);
  if (value.length > width) throw new Error(`${name} 超長: "${value}" > ${width}`);
  return value.padEnd(width, " ");
}

export function buildMediaRecord(r: MediaRecord): string {
  if (!/^\d{2}$/.test(r.formatCode)) throw new Error(`格式代號須為 2 碼數字: ${r.formatCode}`);
  if (!/^[A-Z]{2}$/.test(r.track)) throw new Error(`發票字軌須為 2 碼大寫字母: ${r.track}`);
  if (!/^\d{8}$/.test(r.invoiceNo)) throw new Error(`發票號碼須為 8 碼數字: ${r.invoiceNo}`);

  // 課稅別 F/D：除格式代號、稅籍編號、流水號、年月、銷售人統編、字軌與起訖號碼外，餘依屬性以空白或零補足
  const voided = r.taxType === "F" || r.taxType === "D";
  const record =
    fixed(r.formatCode, 2, "格式代號") +
    fixed(r.taxRegistrationNo, 9, "稅籍編號") +
    encode9(r.serial, 7) +
    encode9(r.rocYear, 3) +
    encode9(r.month, 2) +
    fixed(voided ? "" : (r.buyerTaxId ?? ""), 8, "買受人統編") +
    fixed(r.sellerTaxId ?? "", 8, "銷售人統編") +
    fixed(r.track, 2, "發票字軌") +
    fixed(r.invoiceNo, 8, "發票號碼") +
    encode9(voided ? 0 : r.salesAmount, 12) +
    fixed(r.taxType, 1, "課稅別") +
    encode9(voided ? 0 : r.taxAmount, 10) +
    fixed(voided ? " " : r.deductionCode, 1, "扣抵代號") +
    " ".repeat(5) + // 空白 74-78
    " " + // 特種稅額稅率 79（一般稅額空白）
    " " + // 彙加/分攤註記 80（非彙加空白）
    " "; // 通關方式註記 81（非零稅率銷項空白）
  if (record.length !== 81) throw new Error(`附件五記錄長度必須為 81，得到 ${record.length}`);
  return record;
}

/** 產出媒體檔內容（CRLF 分隔） */
export function buildMediaFile(records: MediaRecord[]): string {
  return records.map(buildMediaRecord).join("\r\n") + (records.length ? "\r\n" : "");
}
