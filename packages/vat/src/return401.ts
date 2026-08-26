/**
 * 附件六：營業人銷售額與稅額申報書檔（112 欄、「|」分隔、UTF-8 無 BOM、CRLF）。
 * 法源：《營業稅電子資料申報繳稅作業要點》第 21 點（113-04-12 修正）。
 * 本專案 Phase 3 範圍：資料別 1（401，一般稅額專營應稅）、總繳代號 0、按期申報、
 * 銷項與進項均為電子發票（申報書代號 5/6 與 32/33 34/35）。403/404 未實作。
 */
import { encode9, encodeS9 } from "./overpunch.ts";

export interface Return401Input {
  ban: string; // 營利事業統一編號 8 碼
  taxRegistrationNo: string; // 稅籍編號 9 碼
  rocPeriod: string; // 所屬年月 yyymm（按期申報＝迄月）
  cityCode: string; // 縣市別 1 碼（附件七代號）
  invoiceCount: number; // 使用發票份數（含作廢）
  einvoiceSales: number; // 電子發票應稅銷售額（代號 5）
  einvoiceSalesTax: number; // 電子發票應稅稅額（代號 6）
  einvoicePurchaseExpense: number; // 電子發票進項—進貨及費用金額（代號 32）
  einvoicePurchaseExpenseTax: number; // 稅額（代號 33）
  einvoicePurchaseFixedAsset?: number | undefined; // 固定資產金額（代號 34）
  einvoicePurchaseFixedAssetTax?: number | undefined; // 固定資產稅額（代號 35）
  // 統一發票扣抵聯（紙本三聯式 21／載有稅額之其他憑證 22）——代號 28-31。
  // 沒有這組欄位時，紙本進項會被灌進電子發票欄（32-35），與同時上傳的媒體檔自相矛盾（B10）
  paperPurchaseExpense?: number | undefined; // 進貨及費用金額（代號 28）
  paperPurchaseExpenseTax?: number | undefined; // 稅額（代號 29）
  paperPurchaseFixedAsset?: number | undefined; // 固定資產金額（代號 30）
  paperPurchaseFixedAssetTax?: number | undefined; // 固定資產稅額（代號 31）
  /**
   * 零稅率銷售額（0028，B12）：非經海關（代號 7→欄 22）／經海關（代號 15→欄 23）／
   * 退回折讓減項（代號 19→欄 24）；合計（代號 23→欄 25）＝ 7＋15−19，並計入銷售額總計（代號 25）。
   * 零稅率稅額恆 0，不影響銷項稅額合計（代號 101）。
   * ⚠️ 得退稅限額（代號 113）與應退稅額（114）維持 0：零稅率退稅限額的計算規則
   * 規格書（docs/specs/vat-401-403.md）未寫明，不得用猜的公式算——留抵全額承轉（代號 115），
   * 退稅請以官方申報軟體匯入後的計算為準。呼叫端（services/vat.ts）在有零稅率時出聲提醒。
   */
  zeroRateSales?: { nonCustoms: number; customs: number; returns: number } | undefined;
  // 退回及折讓減項（B11）：銷項（代號 17/18）、進項退出折讓（代號 40-43）。
  // 金額為正數，本函式負責從各合計欄減除
  salesReturns?: { amount: number; tax: number } | undefined;
  purchaseReturnsExpense?: { amount: number; tax: number } | undefined;
  purchaseReturnsFixedAsset?: { amount: number; tax: number } | undefined;
  prevCarryForward?: number | undefined; // 上期累積留抵稅額（代號 108）
  filer?:
    | {
        idNumber?: string | undefined; // 申報人身分證統一編號 X(10)
        name?: string | undefined; // C(12)
        areaCode?: string | undefined; // X(4)
        phone?: string | undefined; // X(11)
        ext?: string | undefined; // X(5)
      }
    | undefined;
  /**
   * 委託記帳士（代理申報人）登錄字號：有值＝第 98 欄「自行或委託申報」填 2（委託）、
   * 第 104 欄填此字號；空＝第 98 欄填 1（自行）。
   * 欄寬原文未逐字核對，這裡只做 ASCII 與寬鬆長度檢查——最終以官方申報軟體匯入驗收為準。
   */
  agentFilerNo?: string | undefined;
}

export interface Return401Result {
  fields: string[]; // 112 欄（依附件六序號）
  line: string; // 以「|」串接之單筆記錄
  file: string; // line + CRLF
  computed: {
    salesTotal: number; // 代號 25
    outputTaxTotal: number; // 代號 101
    deductibleInputTaxTotal: number; // 代號 107
    payable: number; // 代號 111 本期應實繳
    carryForward: number; // 代號 115 本期累積留抵
  };
}

const X = (value: string, width: number, name: string): string => {
  const v = value.trim();
  if (v.length > width) throw new Error(`${name} X(${width}) 超長: ${v}`);
  if (!/^[\x20-\x7E]*$/.test(v)) throw new Error(`${name} X(${width}) 不可含中文/全形: ${v}`);
  return v;
};
const C = (value: string, width: number, name: string): string => {
  const v = value.trim();
  if (v.length > width) throw new Error(`${name} C(${width}) 超長: ${v}`);
  return v;
};

export function build401(input: Return401Input): Return401Result {
  if (!/^\d{8}$/.test(input.ban)) throw new Error(`統一編號須為 8 碼: ${input.ban}`);
  if (!/^\d{9}$/.test(input.taxRegistrationNo)) throw new Error(`稅籍編號須為 9 碼: ${input.taxRegistrationNo}`);
  if (!/^\d{5}$/.test(input.rocPeriod)) throw new Error(`所屬年月須為 yyymm 5 碼: ${input.rocPeriod}`);

  const faAmount = input.einvoicePurchaseFixedAsset ?? 0;
  const faTax = input.einvoicePurchaseFixedAssetTax ?? 0;
  const paperExpense = input.paperPurchaseExpense ?? 0;
  const paperExpenseTax = input.paperPurchaseExpenseTax ?? 0;
  const paperFa = input.paperPurchaseFixedAsset ?? 0;
  const paperFaTax = input.paperPurchaseFixedAssetTax ?? 0;
  const salesRet = input.salesReturns ?? { amount: 0, tax: 0 };
  const purchRetExp = input.purchaseReturnsExpense ?? { amount: 0, tax: 0 };
  const purchRetFa = input.purchaseReturnsFixedAsset ?? { amount: 0, tax: 0 };
  const zero = input.zeroRateSales ?? { nonCustoms: 0, customs: 0, returns: 0 };
  const prev = input.prevCarryForward ?? 0;

  // 應稅銷項（本專案僅電子發票→代號 5/6；退回及折讓 17/18 為減項；合計 21/22＝5−17、6−18）
  const salesTotalTaxable = input.einvoiceSales - salesRet.amount;
  const outputTaxTotal = input.einvoiceSalesTax - salesRet.tax; // 代號 101＝應稅稅額合計（無特種/國外勞務）
  // 零稅率合計（代號 23）＝非經海關（7）＋經海關（15）−退回折讓（19）；稅額恆 0
  const zeroTotal = zero.nonCustoms + zero.customs - zero.returns;
  const salesTotal = salesTotalTaxable + zeroTotal; // 代號 25＝應稅合計＋零稅率合計（無免稅/土地）
  // 進項合計（代號 44/46 金額、45/47 稅額）＝統一發票扣抵聯＋電子發票−退出折讓
  const inputExpenseTotal = paperExpense + input.einvoicePurchaseExpense - purchRetExp.amount;
  const inputFaTotal = paperFa + faAmount - purchRetFa.amount;
  const inputExpenseTaxTotal = paperExpenseTax + input.einvoicePurchaseExpenseTax - purchRetExp.tax;
  const inputFaTaxTotal = paperFaTax + faTax - purchRetFa.tax;
  const deductibleInputTaxTotal = inputExpenseTaxTotal + inputFaTaxTotal; // 代號 107
  const sub106 = outputTaxTotal; // 代號 106＝101+103+104+105
  const sub110 = deductibleInputTaxTotal + prev; // 代號 110＝107+108+109
  const payable = Math.max(0, sub106 - sub110); // 代號 111
  const declaredCarry = Math.max(0, sub110 - sub106); // 代號 112
  // 代號 113/114 維持 0（含零稅率案件）：退稅限額的計算規則規格書未寫明，不得用猜的公式算。
  // 後果是零稅率產生的溢付稅額全額留抵承轉（代號 115）而不申請退稅——保守但不申報錯誤的數字；
  // 需退稅時以官方申報軟體匯入後的計算為準（services/vat.ts 於有零稅率銷售額時出聲提醒）
  const refund = 0; // 代號 114

  const carryForward = declaredCarry - refund; // 代號 115

  const filer = input.filer ?? {};
  const agentNo = (input.agentFilerNo ?? "").trim();
  const S12 = (n: number) => encodeS9(n, 12);
  const S10 = (n: number) => encodeS9(n, 10);
  const zeroS12 = S12(0);
  const zeroS10 = S10(0);

  // 依附件六序號 1-112 逐欄排列
  const fields: string[] = [
    /* 1 資料別 */ "1",
    /* 2 檔案編號 */ "00000000",
    /* 3 統一編號 */ input.ban,
    /* 4 所屬年月 */ input.rocPeriod,
    /* 5 申報代號 */ "1",
    /* 6 稅籍編號 */ input.taxRegistrationNo,
    /* 7 總繳代號 */ "0",
    /* 8 使用發票份數 */ encode9(input.invoiceCount, 10),
    /* 9 應稅銷售額-三聯式(1) */ zeroS12,
    /* 10 應稅銷售額-收銀機三聯及電子發票(5) */ S12(input.einvoiceSales),
    /* 11 二聯收銀機(9) */ zeroS12,
    /* 12 免用發票(13) */ zeroS12,
    /* 13 退回及折讓(17) */ S12(salesRet.amount),
    /* 14 合計(21) */ S12(salesTotalTaxable),
    /* 15 應稅稅額-三聯式(2) */ zeroS10,
    /* 16 收銀機三聯及電子發票(6) */ S10(input.einvoiceSalesTax),
    /* 17 二聯收銀機(10) */ zeroS10,
    /* 18 免用發票(14) */ zeroS10,
    /* 19 退回及折讓(18) */ S10(salesRet.tax),
    /* 20 合計(22) */ S10(outputTaxTotal),
    /* 21 免稅出口區…(82) */ zeroS12,
    /* 22 零稅率-非經海關(7) */ S12(zero.nonCustoms),
    /* 23 零稅率-經海關(15) */ S12(zero.customs),
    /* 24 零稅率-退回折讓(19) */ S12(zero.returns),
    /* 25 零稅率-合計(23) */ S12(zeroTotal),
    /* 26-31 免稅銷售額(4,8,12,16,20,24) */ zeroS12, zeroS12, zeroS12, zeroS12, zeroS12, zeroS12,
    /* 32-35 特種飲食(52,53,54,55) */ zeroS12, zeroS10, zeroS12, zeroS10,
    /* 36-39 銀行保險(56,57,58,59) */ zeroS12, zeroS10, zeroS12, zeroS10,
    /* 40-41 再保收入(60,61) */ zeroS12, zeroS10,
    /* 42 特種免稅(62) */ zeroS12,
    /* 43-44 特種退回折讓(63,64) */ zeroS12, zeroS10,
    /* 45-46 特種合計(65,66) */ zeroS12, zeroS10,
    /* 47 銷售額總計(25) */ S12(salesTotal),
    /* 48 土地(26) */ zeroS12,
    /* 49 其他固定資產(27) */ zeroS12,
    /* 50 統一發票扣抵聯-進貨費用(28) */ S12(paperExpense),
    /* 51 統一發票扣抵聯-固資(30) */ S12(paperFa),
    /* 52 三聯收銀機及電子發票-進貨費用(32) */ S12(input.einvoicePurchaseExpense),
    /* 53 三聯收銀機及電子發票-固資(34) */ S12(faAmount),
    /* 54 其他憑證-進貨費用(36) */ zeroS12,
    /* 55 其他憑證-固資(38) */ zeroS12,
    /* 56 退出折讓-進貨費用(40) */ S12(purchRetExp.amount),
    /* 57 退出折讓-固資(42) */ S12(purchRetFa.amount),
    /* 58 合計-進貨費用(44) */ S12(inputExpenseTotal),
    /* 59 合計-固資(46) */ S12(inputFaTotal),
    /* 60 統一發票扣抵聯稅額-進貨費用(29) */ S10(paperExpenseTax),
    /* 61 統一發票扣抵聯稅額-固資(31) */ S10(paperFaTax),
    /* 62 三聯收銀機及電子發票稅額-進貨費用(33) */ S10(input.einvoicePurchaseExpenseTax),
    /* 63 三聯收銀機及電子發票稅額-固資(35) */ S10(faTax),
    /* 64 其他憑證稅額-進貨費用(37) */ zeroS10,
    /* 65 其他憑證稅額-固資(39) */ zeroS10,
    /* 66 退出折讓稅額-進貨費用(41) */ S10(purchRetExp.tax),
    /* 67 退出折讓稅額-固資(43) */ S10(purchRetFa.tax),
    /* 68 合計稅額-進貨費用(45) */ S10(inputExpenseTaxTotal),
    /* 69 合計稅額-固資(47) */ S10(inputFaTaxTotal),
    /* 70 進項總金額-進貨費用(48) */ S12(inputExpenseTotal),
    /* 71 進項總金額-固資(49) */ S12(inputFaTotal),
    /* 72 不得扣抵比例(50) */ encode9(0, 3),
    /* 73 兼營得扣抵進項稅額(51) */ zeroS10,
    /* 74 海關繳納證-進貨費用金額(78) */ zeroS12,
    /* 75 海關繳納證-固資金額(80) */ zeroS12,
    /* 76 進口免稅貨物(73) */ zeroS12,
    /* 77 購買國外勞務給付額(74) */ zeroS12,
    /* 78 海關繳納證稅額-進貨費用(79) */ zeroS10,
    /* 79 海關繳納證稅額-固資(81) */ zeroS10,
    /* 80 營業稅額之購買國外勞務(75) */ zeroS10,
    /* 81 應納稅額之購買國外勞務(76) */ zeroS10,
    /* 82 本期銷項稅額合計(101) */ S10(outputTaxTotal),
    /* 83 購買國外勞務應納稅額(103) */ zeroS10,
    /* 84 特種稅額應納(104) */ zeroS10,
    /* 85 中途歇業補徵(105) */ zeroS10,
    /* 86 小計(106) */ S10(sub106),
    /* 87 得扣抵進項稅額合計(107) */ S10(deductibleInputTaxTotal),
    /* 88 上期累積留抵(108) */ S10(prev),
    /* 89 中途歇業應退(109) */ zeroS10,
    /* 90 小計(110) */ S10(sub110),
    /* 91 應實繳(111) */ S10(payable),
    /* 92 申報留抵(112) */ S10(declaredCarry),
    /* 93 得退稅限額(113) */ zeroS10,
    /* 94 應退稅額(114) */ S10(refund),
    /* 95 累積留抵(115) */ S10(carryForward),
    /* 96 申報種類 */ "1",
    /* 97 縣市別 */ X(input.cityCode, 1, "縣市別"),
    /* 98 自行或委託申報（1 自行／2 委託——有代理申報人登錄字號即為委託） */ agentNo ? "2" : "1",
    /* 99 申報人身分證 */ X(filer.idNumber ?? "", 10, "申報人身分證"),
    /* 100 申報人姓名 */ C(filer.name ?? "", 12, "申報人姓名"),
    /* 101 電話區碼 */ X(filer.areaCode ?? "", 4, "電話區碼"),
    /* 102 電話 */ X(filer.phone ?? "", 11, "電話"),
    /* 103 分機 */ X(filer.ext ?? "", 5, "分機"),
    /* 104 代理申報人登錄字號（欄寬未逐字核對，僅做 ASCII 與寬鬆長度檢查） */ X(agentNo, 20, "代理申報人登錄字號"),
    /* 105-107 國外勞務給付額(67,69,71) */ zeroS12, zeroS12, zeroS12,
    /* 108-110 國外勞務稅額(68,70,72) */ zeroS10, zeroS10, zeroS10,
    /* 111 銀行保險本業銷售額(84) */ zeroS12,
    /* 112 銀行保險本業稅額(85) */ zeroS10,
  ];
  if (fields.length !== 112) throw new Error(`附件六必須 112 欄，得到 ${fields.length}`);
  const line = fields.join("|");
  return {
    fields,
    line,
    file: line + "\r\n",
    computed: { salesTotal, outputTaxTotal, deductibleInputTaxTotal, payable, carryForward },
  };
}
