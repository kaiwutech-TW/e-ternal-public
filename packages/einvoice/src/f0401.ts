/**
 * F0401 開立發票（B2C/B2B 存證）XML 產生器。規格書：docs/specs/einvoice-mig41.md
 * 欄位順序依 MIG-4.1 官方範例（XSD 驗欄位序）；golden 測試逐一比對官方範例檔。
 *
 * 法遵關鍵規則：
 * - B2C（買方統編為 0000000000）：金額內含稅 → TaxAmount=0 且 TotalAmount=SalesAmount，明細金額含稅
 * - B2B：稅額分離 → TotalAmount=SalesAmount+TaxAmount，明細金額未稅
 */
import { document, el, parent, type Node } from "./xml.ts";

export const B2C_BUYER_ID = "0000000000";

export interface Party {
  identifier: string;
  name: string;
  address?: string | undefined;
  personInCharge?: string | undefined;
  telephoneNumber?: string | undefined;
  facsimileNumber?: string | undefined;
  emailAddress?: string | undefined;
  customerNumber?: string | undefined;
  roleRemark?: string | undefined;
}

export interface F0401Item {
  description: string;
  quantity: number;
  unitPrice: number;
  taxType?: string | undefined; // 1 應稅（預設）
  amount: number;
  sequenceNumber?: string | undefined; // 未給則依序 001、002…
  remark?: string | undefined;
  relateNumber?: string | undefined;
}

export interface F0401Input {
  invoiceNumber: string; // 2 大寫字母 + 8 碼數字
  invoiceDate: string; // YYYYMMDD
  invoiceTime: string; // HH:mm:ss
  seller: Party;
  buyer: Party;
  buyerRemark?: string | undefined;
  mainRemark?: string | undefined;
  invoiceType?: string | undefined; // 07 一般稅額（預設）
  donateMark: "0" | "1";
  carrier?: { type: string; id1: string; id2: string } | undefined;
  printMark: "Y" | "N";
  npoban?: string | undefined; // 捐贈碼；donateMark=1 時必填
  randomNumber: string; // 4 碼
  items: F0401Item[];
  amount: {
    salesAmount: number;
    freeTaxSalesAmount: number;
    zeroTaxSalesAmount: number;
    taxType: string;
    taxRate: number;
    taxAmount: number;
    totalAmount: number;
    discountAmount?: number | undefined;
    originalCurrencyAmount?: number | undefined;
    exchangeRate?: number | undefined;
    currency?: string | undefined;
  };
}

export function isB2C(input: Pick<F0401Input, "buyer">): boolean {
  return input.buyer.identifier === B2C_BUYER_ID;
}

function validate(input: F0401Input): void {
  const fail = (msg: string) => {
    throw new Error(`F0401 驗證失敗: ${msg}`);
  };
  if (!/^[A-Z]{2}\d{8}$/.test(input.invoiceNumber)) fail(`發票號碼格式錯誤: ${input.invoiceNumber}`);
  if (!/^\d{8}$/.test(input.invoiceDate)) fail(`日期須為 YYYYMMDD: ${input.invoiceDate}`);
  if (!/^\d{2}:\d{2}:\d{2}$/.test(input.invoiceTime)) fail(`時間須為 HH:mm:ss: ${input.invoiceTime}`);
  if (!/^\d{4}$/.test(input.randomNumber)) fail(`隨機碼須為 4 碼數字: ${input.randomNumber}`);
  if (input.donateMark === "1" && !input.npoban) fail("捐贈發票（DonateMark=1）必須有捐贈碼 NPOBAN");
  if (input.items.length === 0) fail("至少需要一筆明細");

  const a = input.amount;
  const lineSum = input.items.reduce((s, i) => s + i.amount, 0);
  // 零稅率（TaxType=2，0028／B12）：金額走 ZeroTaxSalesAmount，SalesAmount（應稅銷售額）為 0、
  // TaxAmount 為 0。⚠️ 官方範例檔（MIGV4.1範例檔）沒有零稅率案例可做 golden——
  // 此處依 MIG 欄位語意（Sales/FreeTax/ZeroTax 分欄＋總額恆等式）實作，
  // 最終以財政部驗測環境上傳驗證為準（docs/specs/einvoice-mig41.md 未決問題）。
  if (a.taxType === "2") {
    if (a.taxAmount !== 0) fail(`零稅率發票 TaxAmount 須為 0: ${a.taxAmount}`);
    if (a.salesAmount !== 0) fail(`零稅率發票 SalesAmount（應稅銷售額）須為 0，金額請放 ZeroTaxSalesAmount: ${a.salesAmount}`);
    if (a.totalAmount !== a.zeroTaxSalesAmount) {
      fail(`零稅率發票 TotalAmount 須等於 ZeroTaxSalesAmount: ${a.totalAmount} ≠ ${a.zeroTaxSalesAmount}`);
    }
    if (lineSum !== a.zeroTaxSalesAmount) fail(`零稅率明細合計 ${lineSum} ≠ ZeroTaxSalesAmount ${a.zeroTaxSalesAmount}`);
    if (!isB2C(input) && !/^\d{8}$/.test(input.buyer.identifier)) fail(`B2B 買方統編格式錯誤: ${input.buyer.identifier}`);
    return;
  }
  if (isB2C(input)) {
    if (a.taxAmount !== 0) fail(`B2C 存證金額內含稅，TaxAmount 須為 0: ${a.taxAmount}`);
    if (a.totalAmount !== a.salesAmount) fail(`B2C 存證 TotalAmount 須等於 SalesAmount: ${a.totalAmount} ≠ ${a.salesAmount}`);
    if (a.taxType === "1" && lineSum !== a.totalAmount) fail(`B2C 明細（含稅）合計 ${lineSum} ≠ TotalAmount ${a.totalAmount}`);
  } else {
    if (!/^\d{8}$/.test(input.buyer.identifier)) fail(`B2B 買方統編格式錯誤: ${input.buyer.identifier}`);
    if (a.totalAmount !== a.salesAmount + a.taxAmount) {
      fail(`B2B TotalAmount 須等於 SalesAmount+TaxAmount: ${a.totalAmount} ≠ ${a.salesAmount}+${a.taxAmount}`);
    }
    if (a.taxType === "1" && lineSum !== a.salesAmount) fail(`B2B 明細（未稅）合計 ${lineSum} ≠ SalesAmount ${a.salesAmount}`);
  }
}

/** Seller/Buyer 共用的 Party 節點（G0401 折讓的買賣方欄位序與 F0401 相同，一起用這份） */
export function partyNode(tag: string, p: Party): Node {
  return parent(tag, [
    el("Identifier", p.identifier),
    el("Name", p.name),
    el("Address", p.address),
    el("PersonInCharge", p.personInCharge),
    el("TelephoneNumber", p.telephoneNumber),
    el("FacsimileNumber", p.facsimileNumber),
    el("EmailAddress", p.emailAddress),
    el("CustomerNumber", p.customerNumber),
    el("RoleRemark", p.roleRemark),
  ]);
}

export function buildF0401(input: F0401Input): string {
  validate(input);
  const a = input.amount;
  return document("Invoice", "F0401:4.1", [
    parent("Main", [
      el("InvoiceNumber", input.invoiceNumber),
      el("InvoiceDate", input.invoiceDate),
      el("InvoiceTime", input.invoiceTime),
      partyNode("Seller", input.seller),
      partyNode("Buyer", input.buyer),
      el("BuyerRemark", input.buyerRemark),
      el("MainRemark", input.mainRemark),
      el("InvoiceType", input.invoiceType ?? "07"),
      el("DonateMark", input.donateMark),
      el("CarrierType", input.carrier?.type),
      el("CarrierId1", input.carrier?.id1),
      el("CarrierId2", input.carrier?.id2),
      el("PrintMark", input.printMark),
      el("NPOBAN", input.npoban),
      el("RandomNumber", input.randomNumber),
    ]),
    parent(
      "Details",
      input.items.map((item, i) =>
        parent("ProductItem", [
          el("Description", item.description),
          el("Quantity", item.quantity),
          el("UnitPrice", item.unitPrice),
          el("TaxType", item.taxType ?? "1"),
          el("Amount", item.amount),
          el("SequenceNumber", item.sequenceNumber ?? String(i + 1).padStart(3, "0")),
          el("Remark", item.remark),
          el("RelateNumber", item.relateNumber),
        ]),
      ),
    ),
    parent("Amount", [
      el("SalesAmount", a.salesAmount),
      el("FreeTaxSalesAmount", a.freeTaxSalesAmount),
      el("ZeroTaxSalesAmount", a.zeroTaxSalesAmount),
      el("TaxType", a.taxType),
      el("TaxRate", a.taxRate),
      el("TaxAmount", a.taxAmount),
      el("TotalAmount", a.totalAmount),
      el("DiscountAmount", a.discountAmount),
      el("OriginalCurrencyAmount", a.originalCurrencyAmount),
      el("ExchangeRate", a.exchangeRate),
      el("Currency", a.currency),
    ]),
  ]);
}
