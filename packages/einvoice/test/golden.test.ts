/**
 * Golden-file 測試：以官方 MIG-4.1 範例檔（docs/specs/sources/mig41-samples/）為標準答案，
 * 重建相同輸入 → 產生 XML → 正規化後與官方檔逐字比對。欄位順序、命名空間、可省略欄位全部被驗證。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildF0401, type F0401Input, type Party } from "../src/f0401.ts";
import { buildF0501 } from "../src/f0501.ts";
import { buildG0401, type G0401Input } from "../src/g0401.ts";
import { buildG0501 } from "../src/g0501.ts";

const SAMPLES = "../../../docs/specs/sources/mig41-samples/MIGV4.1範例檔/存證發票/";

function official(name: string): string {
  return readFileSync(fileURLToPath(new URL(SAMPLES + name, import.meta.url)), "utf8");
}

function normalize(xml: string): string {
  return xml.replace(/^﻿/, "").replace(/>\s+</g, "><").trim();
}

const SELLER: Party = {
  identifier: "90000011",
  name: "測試公司",
  address: "台北市中華路1段123號",
  personInCharge: "王小明",
  telephoneNumber: "0212345678",
  facsimileNumber: "0212345678",
  emailAddress: "test1@test.com.tw",
  customerNumber: "A123456789",
  roleRemark: "defaultUser",
};

describe("F0401 產生器 vs 官方範例（golden files）", () => {
  it("B2C 存證開立（列印紙本）＝官方 KZ10000012", () => {
    const input: F0401Input = {
      invoiceNumber: "KZ10000012",
      invoiceDate: "20241201",
      invoiceTime: "09:00:00",
      seller: SELLER,
      buyer: { identifier: "0000000000", name: "測試買家", address: "台中市中正路888號" },
      donateMark: "0",
      printMark: "Y",
      randomNumber: "1234",
      items: [
        {
          description: "純喫茶紅茶",
          quantity: 1,
          unitPrice: 20,
          amount: 20,
          remark: "remark",
          relateNumber: "A123456789",
        },
      ],
      amount: {
        salesAmount: 20,
        freeTaxSalesAmount: 0,
        zeroTaxSalesAmount: 0,
        taxType: "1",
        taxRate: 0.05,
        taxAmount: 0,
        totalAmount: 20,
      },
    };
    expect(normalize(buildF0401(input))).toBe(normalize(official("F0401-KZ10000012(B2C存證開立 列印紙本).xml")));
  });

  it("B2B 存證開立（稅額分離、兩筆明細）＝官方 KZ10000002", () => {
    const input: F0401Input = {
      invoiceNumber: "KZ10000002",
      invoiceDate: "20241201",
      invoiceTime: "09:00:00",
      seller: SELLER,
      buyer: { ...SELLER, identifier: "90000099", name: "買方測試公司" },
      buyerRemark: "1",
      mainRemark: "備註資訊",
      donateMark: "0",
      printMark: "Y",
      randomNumber: "1234",
      items: [
        { description: "鉛筆", quantity: 100, unitPrice: 25, amount: 2500, remark: "remark", relateNumber: "A123456789" },
        { description: "鋼筆", quantity: 200, unitPrice: 75, amount: 15000, remark: "remark", relateNumber: "A123456789" },
      ],
      amount: {
        salesAmount: 17500,
        freeTaxSalesAmount: 0,
        zeroTaxSalesAmount: 0,
        taxType: "1",
        taxRate: 0.05,
        taxAmount: 875,
        totalAmount: 18375,
        discountAmount: 0,
        originalCurrencyAmount: 0,
        exchangeRate: 0,
        currency: "TWD",
      },
    };
    expect(normalize(buildF0401(input))).toBe(normalize(official("F0401-KZ10000002(B2B存證開立).xml")));
  });

  it("B2C 載具發票＝官方 KZ10000010", () => {
    const input: F0401Input = {
      invoiceNumber: "KZ10000010",
      invoiceDate: "20241201",
      invoiceTime: "09:00:00",
      seller: SELLER,
      buyer: { identifier: "0000000000", name: "王小明" },
      donateMark: "0",
      carrier: { type: "3J0002", id1: "/17MEWYP", id2: "/17MEWYP" },
      printMark: "N",
      randomNumber: "9457",
      items: [
        { description: "綠茶", quantity: 10, unitPrice: 25, amount: 250, remark: "remark", relateNumber: "A123456789" },
        { description: "拿鐵", quantity: 1, unitPrice: 75, amount: 75, remark: "remark", relateNumber: "A123456789" },
      ],
      amount: {
        salesAmount: 325,
        freeTaxSalesAmount: 0,
        zeroTaxSalesAmount: 0,
        taxType: "1",
        taxRate: 0.05,
        taxAmount: 0,
        totalAmount: 325,
        discountAmount: 0,
        originalCurrencyAmount: 0,
        exchangeRate: 0,
        currency: "TWD",
      },
    };
    expect(normalize(buildF0401(input))).toBe(normalize(official("F0401-KZ10000010(B2C存證開立 載具發票3J0002).xml")));
  });

  it("B2C 捐贈發票（NPOBAN 位於 PrintMark 之後）＝官方 KZ10000011", () => {
    const input: F0401Input = {
      invoiceNumber: "KZ10000011",
      invoiceDate: "20241201",
      invoiceTime: "09:00:00",
      seller: SELLER,
      buyer: { identifier: "0000000000", name: "王小明" },
      donateMark: "1",
      printMark: "N",
      npoban: "8999",
      randomNumber: "4328",
      items: [{ description: "鉛筆", quantity: 100, unitPrice: 25, amount: 2500, relateNumber: "A123456789" }],
      amount: {
        salesAmount: 2500,
        freeTaxSalesAmount: 0,
        zeroTaxSalesAmount: 0,
        taxType: "1",
        taxRate: 0.05,
        taxAmount: 0,
        totalAmount: 2500,
        discountAmount: 0,
        originalCurrencyAmount: 0,
        exchangeRate: 0,
        currency: "TWD",
      },
    };
    expect(normalize(buildF0401(input))).toBe(normalize(official("F0401-KZ10000011(B2C存證開立 捐贈發票).xml")));
  });
});

describe("F0501 作廢 vs 官方範例", () => {
  it("B2C 存證作廢＝官方 KZ10000010", () => {
    const xml = buildF0501({
      cancelInvoiceNumber: "KZ10000010",
      invoiceDate: "20241201",
      buyerId: "0000000000",
      sellerId: "90000011",
      cancelDate: "20241203",
      cancelTime: "14:34:16",
      cancelReason: "作廢發票",
      returnTaxDocumentNumber: "A0123456789",
      remark: "remark",
    });
    expect(normalize(xml)).toBe(normalize(official("F0501-KZ10000010(B2C存證作廢).xml")));
  });
});

describe("G0401 折讓開立 vs 官方範例（golden files）", () => {
  it("B2B 賣方開立折讓（未稅明細＋Tax、TotalAmount=未稅合計）＝官方 ALW10000003", () => {
    const input: G0401Input = {
      allowanceNumber: "ALW10000003",
      allowanceDate: "20241203",
      seller: SELLER,
      buyer: {
        identifier: "90000099",
        name: "買方測試公司",
        address: "台北市中華路1段1234號",
        personInCharge: "王小明",
        telephoneNumber: "0223456789",
        facsimileNumber: "0223456789",
        emailAddress: "test2@test.com.tw",
        customerNumber: "A123456789",
        roleRemark: "defaultUser",
      },
      allowanceType: "2",
      items: [
        {
          originalInvoiceDate: "20241201",
          originalInvoiceNumber: "KZ10000003",
          originalSequenceNumber: "001",
          originalDescription: "鉛筆",
          quantity: 100,
          unitPrice: 2,
          amount: 200,
          tax: 10,
        },
      ],
      amount: { taxAmount: 10, totalAmount: 200 },
    };
    expect(normalize(buildG0401(input))).toBe(normalize(official("G0401-ALW10000003(B2B存證賣方開立折讓).xml")));
  });

  it("B2C 開立折讓（原發票含稅 20 → 折讓 Amount 19＋Tax 1，未稅口徑）＝官方 ALW10000013", () => {
    const input: G0401Input = {
      allowanceNumber: "ALW10000013",
      allowanceDate: "20241203",
      seller: SELLER,
      buyer: { identifier: "0000000000", name: "王小明" },
      allowanceType: "2",
      items: [
        {
          originalInvoiceDate: "20241201",
          originalInvoiceNumber: "KZ10000013",
          originalSequenceNumber: "001",
          originalDescription: "純喫茶紅茶",
          quantity: 1,
          unitPrice: 20,
          amount: 19,
          tax: 1,
        },
      ],
      amount: { taxAmount: 1, totalAmount: 19 },
    };
    expect(normalize(buildG0401(input))).toBe(normalize(official("G0401-ALW10000013(B2C存證開立折讓).xml")));
  });
});

describe("G0501 折讓作廢 vs 官方範例（golden files）", () => {
  it("B2B 賣方作廢折讓（含 Remark）＝官方 ALW10000003", () => {
    const xml = buildG0501({
      cancelAllowanceNumber: "ALW10000003",
      allowanceType: "2",
      allowanceDate: "20241203",
      buyerId: "90000099",
      sellerId: "90000011",
      cancelDate: "20241203",
      cancelTime: "19:27:10",
      cancelReason: "作廢",
      remark: "remark",
    });
    expect(normalize(xml)).toBe(normalize(official("G0501-ALW10000003(B2B存證賣方作廢折讓).xml")));
  });

  it("B2C 作廢折讓（無 Remark 時省略該節點）＝官方 ALW10000013", () => {
    const xml = buildG0501({
      cancelAllowanceNumber: "ALW10000013",
      allowanceType: "2",
      allowanceDate: "20241203",
      buyerId: "0000000000",
      sellerId: "90000011",
      cancelDate: "20241204",
      cancelTime: "13:50:13",
      cancelReason: "作廢",
    });
    expect(normalize(xml)).toBe(normalize(official("G0501-ALW10000013(B2C存證作廢折讓).xml")));
  });
});

describe("G0401 驗證規則", () => {
  const base: G0401Input = {
    allowanceNumber: "ALW10000003",
    allowanceDate: "20241203",
    seller: SELLER,
    buyer: { identifier: "90000099", name: "買方公司" },
    allowanceType: "2",
    items: [
      {
        originalInvoiceDate: "20241201",
        originalInvoiceNumber: "KZ10000003",
        originalSequenceNumber: "001",
        originalDescription: "鉛筆",
        quantity: 1,
        unitPrice: 200,
        amount: 200,
        tax: 10,
      },
    ],
    amount: { taxAmount: 10, totalAmount: 200 },
  };

  it("明細未稅合計 ≠ TotalAmount 即拒絕（G0401 的 TotalAmount 是未稅口徑）", () => {
    expect(() => buildG0401({ ...base, amount: { taxAmount: 10, totalAmount: 210 } })).toThrow(/未稅.*合計/);
  });

  it("明細稅額合計 ≠ TaxAmount 即拒絕", () => {
    expect(() => buildG0401({ ...base, amount: { taxAmount: 11, totalAmount: 200 } })).toThrow(/稅額合計/);
  });

  it("原發票號碼格式錯誤即拒絕", () => {
    expect(() =>
      buildG0401({ ...base, items: [{ ...base.items[0]!, originalInvoiceNumber: "KZ123" }] }),
    ).toThrow(/原發票號碼/);
  });

  it("缺 AllowanceType 即拒絕（官方範例僅涵蓋賣方開立=2，不設預設值）", () => {
    expect(() => buildG0401({ ...base, allowanceType: "" })).toThrow(/AllowanceType/);
  });
});

describe("法遵驗證規則", () => {
  const base = {
    invoiceNumber: "KZ10000012",
    invoiceDate: "20241201",
    invoiceTime: "09:00:00",
    seller: SELLER,
    donateMark: "0" as const,
    printMark: "Y" as const,
    randomNumber: "1234",
    items: [{ description: "測試", quantity: 1, unitPrice: 100, amount: 100 }],
  };

  it("B2C 稅額非 0 即拒絕", () => {
    expect(() =>
      buildF0401({
        ...base,
        buyer: { identifier: "0000000000", name: "買家" },
        amount: { salesAmount: 100, freeTaxSalesAmount: 0, zeroTaxSalesAmount: 0, taxType: "1", taxRate: 0.05, taxAmount: 5, totalAmount: 105 },
      }),
    ).toThrow(/TaxAmount 須為 0/);
  });

  it("B2B 總額 ≠ 未稅+稅額即拒絕", () => {
    expect(() =>
      buildF0401({
        ...base,
        buyer: { identifier: "90000099", name: "買方公司" },
        amount: { salesAmount: 100, freeTaxSalesAmount: 0, zeroTaxSalesAmount: 0, taxType: "1", taxRate: 0.05, taxAmount: 5, totalAmount: 106 },
      }),
    ).toThrow(/SalesAmount\+TaxAmount/);
  });

  it("捐贈發票缺捐贈碼即拒絕", () => {
    expect(() =>
      buildF0401({
        ...base,
        donateMark: "1",
        buyer: { identifier: "0000000000", name: "買家" },
        amount: { salesAmount: 100, freeTaxSalesAmount: 0, zeroTaxSalesAmount: 0, taxType: "1", taxRate: 0.05, taxAmount: 0, totalAmount: 100 },
      }),
    ).toThrow(/NPOBAN/);
  });

  it("明細合計與總額不符即拒絕（B2B 未稅口徑）", () => {
    expect(() =>
      buildF0401({
        ...base,
        buyer: { identifier: "90000099", name: "買方公司" },
        amount: { salesAmount: 999, freeTaxSalesAmount: 0, zeroTaxSalesAmount: 0, taxType: "1", taxRate: 0.05, taxAmount: 50, totalAmount: 1049 },
      }),
    ).toThrow(/明細（未稅）合計/);
  });
});
