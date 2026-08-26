/**
 * G0501 作廢折讓證明單 XML 產生器。欄位順序依 MIG-4.1 官方範例
 * （G0501-ALW10000003 B2B／G0501-ALW10000013 B2C）；與 F0501 同為扁平結構，
 * 差異：多 AllowanceType（緊接在 CancelAllowanceNumber 之後）、沒有 ReturnTaxDocumentNumber。
 */
import { document, el } from "./xml.ts";

export interface G0501Input {
  cancelAllowanceNumber: string; // 要作廢的折讓證明單號碼
  allowanceType: string; // 與原 G0401 一致（賣方開立為 2，見官方範例檔名）
  allowanceDate: string; // 原折讓證明單日期 YYYYMMDD
  buyerId: string;
  sellerId: string;
  cancelDate: string; // YYYYMMDD
  cancelTime: string; // HH:mm:ss
  cancelReason: string;
  remark?: string | undefined;
}

export function buildG0501(input: G0501Input): string {
  const fail = (msg: string) => {
    throw new Error(`G0501 驗證失敗: ${msg}`);
  };
  if (!input.cancelAllowanceNumber) fail("要作廢的折讓證明單號碼必填");
  if (!input.allowanceType) fail("AllowanceType 必填（與原 G0401 相同的值）");
  if (!/^\d{8}$/.test(input.allowanceDate)) fail(`原折讓日期須為 YYYYMMDD: ${input.allowanceDate}`);
  if (!/^\d{8}$/.test(input.cancelDate)) fail(`作廢日期須為 YYYYMMDD: ${input.cancelDate}`);
  if (!input.cancelReason) fail("作廢原因必填");
  return document("CancelAllowance", "G0501:4.1", [
    el("CancelAllowanceNumber", input.cancelAllowanceNumber),
    el("AllowanceType", input.allowanceType),
    el("AllowanceDate", input.allowanceDate),
    el("BuyerId", input.buyerId),
    el("SellerId", input.sellerId),
    el("CancelDate", input.cancelDate),
    el("CancelTime", input.cancelTime),
    el("CancelReason", input.cancelReason),
    el("Remark", input.remark),
  ]);
}
