import { describe, expect, it } from "vitest";
import { decodeS9, encode9, encodeS9 } from "../src/overpunch.ts";
import { buildMediaRecord, type MediaRecord } from "../src/media.ts";
import { build401 } from "../src/return401.ts";
import { lastDayOfMonth, periodDateRange, previousPeriod, rocPeriodOf, splitB2CTotal } from "../src/period.ts";

describe("COBOL S9 overpunch（作業要點第 21 點(十八)）", () => {
  it("正數末位 0-9 → { A-I", () => {
    expect(encodeS9(1000, 12)).toBe("00000000100{");
    expect(encodeS9(50, 10)).toBe("000000005{");
    expect(encodeS9(129, 10)).toBe("000000012I");
    expect(encodeS9(0, 10)).toBe("000000000{");
  });

  it("負數末位 0-9 → } J-R", () => {
    expect(encodeS9(-50, 10)).toBe("000000005}");
    expect(encodeS9(-129, 10)).toBe("000000012R");
  });

  it("decode 為 encode 之反函數", () => {
    for (const n of [0, 5, 129, -7, -1000, 999999]) {
      expect(decodeS9(encodeS9(n, 12))).toBe(n);
    }
  });

  it("9() 左補零、溢位拋錯", () => {
    expect(encode9(42, 7)).toBe("0000042");
    expect(() => encode9(12345678901, 10)).toThrow(/溢位/);
  });
});

describe("附件五 進銷項資料檔（81 Bytes）", () => {
  const base: MediaRecord = {
    formatCode: "35",
    taxRegistrationNo: "123456789",
    serial: 1,
    rocYear: 115,
    month: 7,
    buyerTaxId: "04541302",
    track: "KZ",
    invoiceNo: "10000000",
    salesAmount: 1000,
    taxType: "1",
    taxAmount: 50,
    deductionCode: " ",
  };

  it("每筆記錄固定 81 bytes，欄位位置正確", () => {
    const r = buildMediaRecord(base);
    expect(r).toHaveLength(81);
    expect(r.slice(0, 2)).toBe("35"); // 格式代號 1-2
    expect(r.slice(2, 11)).toBe("123456789"); // 稅籍編號 3-11
    expect(r.slice(11, 18)).toBe("0000001"); // 流水號 12-18
    expect(r.slice(18, 23)).toBe("11507"); // 民國年月 19-23
    expect(r.slice(23, 31)).toBe("04541302"); // 買受人統編 24-31
    expect(r.slice(39, 41)).toBe("KZ"); // 字軌 40-41
    expect(r.slice(41, 49)).toBe("10000000"); // 發票號碼 42-49
    expect(r.slice(49, 61)).toBe("000000001000"); // 銷售金額 50-61
    expect(r[61]).toBe("1"); // 課稅別 62
    expect(r.slice(62, 72)).toBe("0000000050"); // 營業稅額 63-72
  });

  it("B2C（買受人無統編）統編欄補空白", () => {
    const r = buildMediaRecord({ ...base, buyerTaxId: undefined });
    expect(r.slice(23, 31)).toBe("        ");
  });

  it("作廢發票（課稅別 F）：金額歸零、買受人與扣抵代號空白", () => {
    const r = buildMediaRecord({ ...base, taxType: "F" });
    expect(r).toHaveLength(81);
    expect(r.slice(23, 31)).toBe("        ");
    expect(r.slice(49, 61)).toBe("000000000000");
    expect(r[61]).toBe("F");
    expect(r.slice(62, 72)).toBe("0000000000");
    expect(r[72]).toBe(" ");
  });

  it("進項（格式 25）：銷售人統編在 32-39", () => {
    const r = buildMediaRecord({
      ...base,
      formatCode: "25",
      buyerTaxId: undefined,
      sellerTaxId: "22099131",
      deductionCode: "1",
    });
    expect(r.slice(31, 39)).toBe("22099131");
    expect(r[72]).toBe("1"); // 扣抵代號 73
  });
});

describe("附件六 401 申報書檔（112 欄）", () => {
  const input = {
    ban: "22099131",
    taxRegistrationNo: "123456789",
    rocPeriod: "11508",
    cityCode: "A",
    invoiceCount: 3,
    einvoiceSales: 2199,
    einvoiceSalesTax: 110,
    einvoicePurchaseExpense: 1000,
    einvoicePurchaseExpenseTax: 50,
  };

  it("112 欄、111 個「|」、CRLF 結尾", () => {
    const r = build401(input);
    expect(r.fields).toHaveLength(112);
    expect(r.line.split("|")).toHaveLength(112);
    expect(r.file.endsWith("\r\n")).toBe(true);
  });

  it("關鍵欄位落位正確（附件六序號）", () => {
    const f = build401(input).fields;
    expect(f[0]).toBe("1"); // 資料別 401
    expect(f[2]).toBe("22099131"); // 統編
    expect(f[3]).toBe("11508"); // 所屬年月
    expect(f[7]).toBe("0000000003"); // 使用發票份數
    expect(f[9]).toBe("00000000219I"); // 序 10 電子發票應稅銷售額 2199（代號5）
    expect(f[15]).toBe("000000011{"); // 序 16 稅額 110（代號6）
    expect(f[46]).toBe("00000000219I"); // 序 47 銷售額總計（代號25）
    expect(f[51]).toBe("00000000100{"); // 序 52 進項電子發票進貨費用（代號32）
    expect(f[61]).toBe("000000005{"); // 序 62 稅額（代號33）
    expect(f[81]).toBe("000000011{"); // 序 82 銷項稅額合計（代號101）
    expect(f[96]).toBe("A"); // 序 97 縣市別
  });

  it("稅額計算：應實繳＝銷項－進項－上期留抵；不足則轉留抵", () => {
    const pay = build401(input).computed;
    expect(pay.payable).toBe(60); // 110 - 50
    expect(pay.carryForward).toBe(0);

    const carry = build401({ ...input, prevCarryForward: 200 }).computed;
    expect(carry.payable).toBe(0);
    expect(carry.carryForward).toBe(140); // (50+200) - 110
  });
});

describe("附件六 401：退回折讓減項、紙本進項欄、申報人與委託申報（B10/B11）", () => {
  const base = {
    ban: "22099131",
    taxRegistrationNo: "123456789",
    rocPeriod: "11508",
    cityCode: "A",
    invoiceCount: 1,
    einvoiceSales: 10000,
    einvoiceSalesTax: 500,
    einvoicePurchaseExpense: 1000,
    einvoicePurchaseExpenseTax: 50,
  };

  it("銷項退回及折讓落序 13/19，合計（序 14/20/47）與銷項稅額（序 82/86）為淨額", () => {
    const r = build401({ ...base, salesReturns: { amount: 2000, tax: 100 } });
    expect(r.fields[12]).toBe(encodeS9(2000, 12)); // 序13 退回及折讓(17)
    expect(r.fields[18]).toBe(encodeS9(100, 10)); // 序19 退回及折讓(18)
    expect(r.fields[13]).toBe(encodeS9(8000, 12)); // 序14 合計(21) = 10000-2000
    expect(r.fields[19]).toBe(encodeS9(400, 10)); // 序20 合計(22) = 500-100
    expect(r.fields[46]).toBe(encodeS9(8000, 12)); // 序47 銷售額總計(25)
    expect(r.fields[81]).toBe(encodeS9(400, 10)); // 序82 銷項稅額合計(101)
    expect(r.computed.payable).toBe(350); // 400 - 50
  });

  it("統一發票扣抵聯（紙本 21/22）落序 50/51/60/61，不與電子發票欄（52/53/62/63）混桶", () => {
    const r = build401({
      ...base,
      paperPurchaseExpense: 7000,
      paperPurchaseExpenseTax: 350,
      paperPurchaseFixedAsset: 3000,
      paperPurchaseFixedAssetTax: 150,
    });
    expect(r.fields[49]).toBe(encodeS9(7000, 12)); // 序50 統一發票扣抵聯-進貨費用(28)
    expect(r.fields[50]).toBe(encodeS9(3000, 12)); // 序51 統一發票扣抵聯-固資(30)
    expect(r.fields[51]).toBe(encodeS9(1000, 12)); // 序52 電子發票-進貨費用(32) 不含紙本
    expect(r.fields[59]).toBe(encodeS9(350, 10)); // 序60 稅額(29)
    expect(r.fields[60]).toBe(encodeS9(150, 10)); // 序61 稅額(31)
    expect(r.fields[57]).toBe(encodeS9(8000, 12)); // 序58 合計-進貨費用(44) = 7000+1000
    expect(r.fields[58]).toBe(encodeS9(3000, 12)); // 序59 合計-固資(46)
    expect(r.computed.deductibleInputTaxTotal).toBe(550); // 350+150+50
  });

  it("進項退出折讓落序 56/57/66/67，並自合計（序 58/59/68/69/70/71）扣除", () => {
    const r = build401({
      ...base,
      einvoicePurchaseFixedAsset: 5000,
      einvoicePurchaseFixedAssetTax: 250,
      purchaseReturnsExpense: { amount: 400, tax: 20 },
      purchaseReturnsFixedAsset: { amount: 1000, tax: 50 },
    });
    expect(r.fields[55]).toBe(encodeS9(400, 12)); // 序56 退出折讓-進貨費用(40)
    expect(r.fields[56]).toBe(encodeS9(1000, 12)); // 序57 退出折讓-固資(42)
    expect(r.fields[65]).toBe(encodeS9(20, 10)); // 序66 稅額(41)
    expect(r.fields[66]).toBe(encodeS9(50, 10)); // 序67 稅額(43)
    expect(r.fields[57]).toBe(encodeS9(600, 12)); // 序58 合計-進貨費用(44) = 1000-400
    expect(r.fields[58]).toBe(encodeS9(4000, 12)); // 序59 合計-固資(46) = 5000-1000
    expect(r.fields[67]).toBe(encodeS9(30, 10)); // 序68 合計稅額(45) = 50-20
    expect(r.fields[68]).toBe(encodeS9(200, 10)); // 序69 合計稅額(47) = 250-50
    expect(r.fields[69]).toBe(encodeS9(600, 12)); // 序70 進項總金額-進貨費用(48)
    expect(r.fields[70]).toBe(encodeS9(4000, 12)); // 序71 進項總金額-固資(49)
    expect(r.computed.deductibleInputTaxTotal).toBe(230); // (50-20)+(250-50)
  });

  it("申報人落序 99-103；自行申報：序 98=1、序 104 空白", () => {
    const r = build401({
      ...base,
      filer: { idNumber: "A123456789", name: "王申報", areaCode: "02", phone: "12345678", ext: "9" },
    });
    expect(r.fields[97]).toBe("1"); // 序98 自行申報
    expect(r.fields[98]).toBe("A123456789");
    expect(r.fields[99]).toBe("王申報");
    expect(r.fields[100]).toBe("02");
    expect(r.fields[101]).toBe("12345678");
    expect(r.fields[102]).toBe("9");
    expect(r.fields[103]).toBe(""); // 序104 代理申報人登錄字號
  });

  it("委託記帳士：序 98=2、序 104=登錄字號", () => {
    const r = build401({ ...base, agentFilerNo: "REG-12345" });
    expect(r.fields[97]).toBe("2");
    expect(r.fields[103]).toBe("REG-12345");
  });

  it("整體不變式：沒有新欄位輸入時輸出與既有行為完全相同（112 欄）", () => {
    const plain = build401(base);
    expect(plain.fields).toHaveLength(112);
    expect(plain.fields[12]).toBe(encodeS9(0, 12));
    expect(plain.fields[97]).toBe("1");
    expect(plain.fields[103]).toBe("");
  });

  // ── 零稅率（0028，B12）────────────────────────────────────────────
  it("零稅率銷售額落序 22-25（代號 7/15/19/23），並計入銷售額總計（序 47）", () => {
    const r = build401({
      ...base,
      zeroRateSales: { nonCustoms: 5000, customs: 10000, returns: 2000 },
    });
    expect(r.fields[21]).toBe(encodeS9(5000, 12)); // 序22 非經海關(7)
    expect(r.fields[22]).toBe(encodeS9(10000, 12)); // 序23 經海關(15)
    expect(r.fields[23]).toBe(encodeS9(2000, 12)); // 序24 退回折讓(19)
    expect(r.fields[24]).toBe(encodeS9(13000, 12)); // 序25 合計(23) = 5000+10000-2000
    expect(r.fields[46]).toBe(encodeS9(23000, 12)); // 序47 銷售額總計(25) = 10000+13000
    expect(r.computed.salesTotal).toBe(23000);
  });

  it("零稅率不影響銷項稅額（序 82）與應實繳；退稅欄（序 93/94）維持 0——退稅限額規則未查證，不得用猜的公式", () => {
    const r = build401({ ...base, zeroRateSales: { nonCustoms: 0, customs: 100000, returns: 0 } });
    expect(r.fields[81]).toBe(encodeS9(500, 10)); // 序82 銷項稅額合計＝應稅稅額，零稅率為 0
    expect(r.fields[92]).toBe(encodeS9(0, 10)); // 序93 得退稅限額(113)
    expect(r.fields[93]).toBe(encodeS9(0, 10)); // 序94 應退稅額(114)
    expect(r.computed.payable).toBe(450); // 500 - 50，與零稅率無關
  });
});

describe("期別與 B2C 拆算", () => {
  it("西元期別 → 民國迄月與兩個月份", () => {
    expect(rocPeriodOf("202607")).toEqual({ rocPeriod: "11508", months: ["2026-07", "2026-08"] });
    expect(() => rocPeriodOf("202608")).toThrow(/奇數月/);
  });

  it("上一期別：同年往前兩個月、一月期回到前一年 11 月（留抵承轉的鏈）", () => {
    expect(previousPeriod("202607")).toBe("202605");
    expect(previousPeriod("202603")).toBe("202601");
    expect(previousPeriod("202601")).toBe("202511");
    expect(() => previousPeriod("202608")).toThrow(/奇數月/);
  });

  it("B2C 內含稅拆算依作業要點公式（稅額先算、四捨五入）", () => {
    expect(splitB2CTotal(104)).toEqual({ salesAmount: 99, taxAmount: 5 }); // 104/1.05*0.05=4.95→5
    expect(splitB2CTotal(1050)).toEqual({ salesAmount: 1000, taxAmount: 50 });
    expect(splitB2CTotal(0)).toEqual({ salesAmount: 0, taxAmount: 0 });
  });
});

describe("申報期間的起訖日", () => {
  // 2026-07-29 實測發現的 live bug：迄日寫死 31，迄月為 2/4/6 月的三個期別會組出
  // 不存在的日期（例如 2026-02-31），Postgres 直接拒絕整個查詢 → 六個申報期壞掉三個。
  // 原測試只用 202607（迄月 8 月剛好 31 天）所以一路綠燈——這裡把六個期別全測。
  it("六個申報期的迄日都是該月實際的最後一天", () => {
    expect(periodDateRange("202601")).toEqual({ from: "2026-01-01", to: "2026-02-28" });
    expect(periodDateRange("202603")).toEqual({ from: "2026-03-01", to: "2026-04-30" });
    expect(periodDateRange("202605")).toEqual({ from: "2026-05-01", to: "2026-06-30" });
    expect(periodDateRange("202607")).toEqual({ from: "2026-07-01", to: "2026-08-31" });
    expect(periodDateRange("202609")).toEqual({ from: "2026-09-01", to: "2026-10-31" });
    expect(periodDateRange("202611")).toEqual({ from: "2026-11-01", to: "2026-12-31" });
  });

  it("閏年 2 月是 29 天", () => {
    expect(periodDateRange("202401")).toEqual({ from: "2024-01-01", to: "2024-02-29" });
    expect(periodDateRange("202001")).toEqual({ from: "2020-01-01", to: "2020-02-29" });
  });

  it("百年不閏、四百年再閏", () => {
    expect(lastDayOfMonth(1900, 2)).toBe(28);
    expect(lastDayOfMonth(2000, 2)).toBe(29);
    expect(lastDayOfMonth(2100, 2)).toBe(28);
  });

  it("產出的迄日都是合法日期（不會出現 2 月 31 日這種組合）", () => {
    for (const start of ["01", "03", "05", "07", "09", "11"]) {
      const { to } = periodDateRange(`2026${start}`);
      const [y, m, d] = to.split("-").map(Number);
      expect(new Date(Date.UTC(y!, m! - 1, d!)).getUTCDate()).toBe(d);
    }
  });
});
