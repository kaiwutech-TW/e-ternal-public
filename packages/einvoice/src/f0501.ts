/** F0501 作廢發票 XML 產生器。欄位順序依 MIG-4.1 官方範例。 */
import { document, el } from "./xml.ts";

export interface F0501Input {
  cancelInvoiceNumber: string;
  invoiceDate: string; // 原發票開立日 YYYYMMDD
  buyerId: string;
  sellerId: string;
  cancelDate: string; // YYYYMMDD
  cancelTime: string; // HH:mm:ss
  cancelReason: string;
  returnTaxDocumentNumber?: string | undefined;
  remark?: string | undefined;
}

export function buildF0501(input: F0501Input): string {
  if (!/^[A-Z]{2}\d{8}$/.test(input.cancelInvoiceNumber)) {
    throw new Error(`F0501 驗證失敗: 發票號碼格式錯誤: ${input.cancelInvoiceNumber}`);
  }
  if (!input.cancelReason) throw new Error("F0501 驗證失敗: 作廢原因必填");
  return document("CancelInvoice", "F0501:4.1", [
    el("CancelInvoiceNumber", input.cancelInvoiceNumber),
    el("InvoiceDate", input.invoiceDate),
    el("BuyerId", input.buyerId),
    el("SellerId", input.sellerId),
    el("CancelDate", input.cancelDate),
    el("CancelTime", input.cancelTime),
    el("CancelReason", input.cancelReason),
    el("ReturnTaxDocumentNumber", input.returnTaxDocumentNumber),
    el("Remark", input.remark),
  ]);
}
