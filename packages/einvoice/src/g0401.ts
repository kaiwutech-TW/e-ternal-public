/**
 * G0401 開立折讓證明單 XML 產生器。欄位順序依 MIG-4.1 官方範例
 * （G0401-ALW10000003 B2B／G0401-ALW10000013 B2C）；golden 測試逐位元組比對。
 *
 * 與 F0401 不同、且**直接讀自官方範例**（非推測）的兩件事：
 * - 明細記「原發票」座標（OriginalInvoiceDate/Number/SequenceNumber）＋折讓金額；
 *   金額口徑 B2B、B2C 一律未稅——B2C 範例的原發票含稅 20 元，折讓明細是 Amount 19＋Tax 1。
 * - Amount 段只有 TaxAmount 與 TotalAmount，TotalAmount＝明細未稅合計（兩份範例皆如此；
 *   注意這與 F0401 B2B 的 TotalAmount=含稅總額**不同**）。
 *
 * 範例也顯示 XSD 不強制 Quantity×UnitPrice=Amount（B2C 範例 1×20 對 Amount 19），
 * 所以這裡不加這道驗證——折讓的數量/單價本來就只是描述折讓的脈絡。
 *
 * AllowanceType：官方範例檔名「B2B存證**賣方**開立折讓」對應值 2。其餘代號的語意
 * 官方範例沒有涵蓋，本產生器不猜、不設預設值，由呼叫端決定。
 */
import { partyNode, type Party } from "./f0401.ts";
import { document, el, parent } from "./xml.ts";

export interface G0401Item {
  originalInvoiceDate: string; // 原發票開立日 YYYYMMDD
  originalInvoiceNumber: string; // 原發票號碼（2 大寫字母＋8 碼數字）
  originalSequenceNumber: string; // 原發票明細的序號（F0401 的 SequenceNumber）
  originalDescription: string;
  quantity: number;
  unitPrice: number;
  amount: number; // 未稅（B2B/B2C 同口徑，見檔頭）
  tax: number;
  allowanceSequenceNumber?: string | undefined; // 未給則依序 001、002…
  taxType?: string | undefined; // 1 應稅（預設）
}

export interface G0401Input {
  allowanceNumber: string; // 折讓證明單號碼（開立方自編，如官方範例的 ALW10000003）
  allowanceDate: string; // YYYYMMDD
  seller: Party;
  buyer: Party;
  allowanceType: string; // 2＝賣方開立（官方範例檔名）；不設預設值
  items: G0401Item[];
  amount: {
    taxAmount: number; // ＝明細 Tax 合計
    totalAmount: number; // ＝明細未稅 Amount 合計
  };
}

function validate(input: G0401Input): void {
  const fail = (msg: string) => {
    throw new Error(`G0401 驗證失敗: ${msg}`);
  };
  if (!input.allowanceNumber) fail("折讓證明單號碼（AllowanceNumber）必填");
  if (!/^\d{8}$/.test(input.allowanceDate)) fail(`折讓日期須為 YYYYMMDD: ${input.allowanceDate}`);
  if (!input.allowanceType) fail("AllowanceType 必填（賣方開立折讓為 2，見官方範例）");
  if (input.items.length === 0) fail("至少需要一筆折讓明細");
  for (const item of input.items) {
    if (!/^[A-Z]{2}\d{8}$/.test(item.originalInvoiceNumber)) {
      fail(`原發票號碼格式錯誤: ${item.originalInvoiceNumber}`);
    }
    if (!/^\d{8}$/.test(item.originalInvoiceDate)) {
      fail(`原發票日期須為 YYYYMMDD: ${item.originalInvoiceDate}`);
    }
  }
  const a = input.amount;
  const lineAmount = input.items.reduce((s, i) => s + i.amount, 0);
  const lineTax = input.items.reduce((s, i) => s + i.tax, 0);
  if (lineAmount !== a.totalAmount) {
    fail(`明細（未稅）合計 ${lineAmount} ≠ TotalAmount ${a.totalAmount}（G0401 的 TotalAmount 是未稅合計，見官方範例）`);
  }
  if (lineTax !== a.taxAmount) fail(`明細稅額合計 ${lineTax} ≠ TaxAmount ${a.taxAmount}`);
}

export function buildG0401(input: G0401Input): string {
  validate(input);
  return document("Allowance", "G0401:4.1", [
    parent("Main", [
      el("AllowanceNumber", input.allowanceNumber),
      el("AllowanceDate", input.allowanceDate),
      partyNode("Seller", input.seller),
      partyNode("Buyer", input.buyer),
      el("AllowanceType", input.allowanceType),
    ]),
    parent(
      "Details",
      input.items.map((item, i) =>
        parent("ProductItem", [
          el("OriginalInvoiceDate", item.originalInvoiceDate),
          el("OriginalInvoiceNumber", item.originalInvoiceNumber),
          el("OriginalSequenceNumber", item.originalSequenceNumber),
          el("OriginalDescription", item.originalDescription),
          el("Quantity", item.quantity),
          el("UnitPrice", item.unitPrice),
          el("Amount", item.amount),
          el("Tax", item.tax),
          el("AllowanceSequenceNumber", item.allowanceSequenceNumber ?? String(i + 1).padStart(3, "0")),
          el("TaxType", item.taxType ?? "1"),
        ]),
      ),
    ),
    parent("Amount", [el("TaxAmount", input.amount.taxAmount), el("TotalAmount", input.amount.totalAmount)]),
  ]);
}
