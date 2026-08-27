import {
  FORMAT_CODES,
  build401,
  buildMediaFile,
  periodDateRange,
  previousPeriod,
  rocPeriodOf,
  splitB2CTotal,
  type MediaRecord,
} from "@tw-erp/vat";
import { schema } from "@tw-erp/db";
import { and, desc, eq, gt, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { decryptPii } from "./pii.ts";
import { rateFromSnapshot } from "./tax-parameters.ts";

/**
 * 產出一期（雙月）401 申報：附件五進銷項媒體檔＋附件六申報書檔。
 * 範圍（docs/specs/vat-401-403.md）：銷項＝本系統開立之電子發票（格式 35，作廢＝課稅別 F）；
 * 進項＝已登錄供應商發票資訊之進貨單（格式 21/22/25、扣抵代號 1-4）。403/404 未實作。
 *
 * B10／B11 之後的取數規則：
 * - 扣抵代號 3/4（不可扣抵）只寫媒體檔明細，不進 401 的任何可扣抵合計——
 *   排除清單放在回應的 nonDeductible，畫面看得到哪些單被排除、為什麼。
 * - 格式 21/22（統一發票扣抵聯）落申報書代號 28-31，格式 25 落 32-35——
 *   媒體檔與申報書從此說同一件事。
 * - 退回折讓「已登錄證明單號碼」的才列入減項（歸期依證明單日期，未填則依退回日）；
 *   沒有證明單就沒有列報依據，這些單留在 returnsNotReflected 的警示裡等補登。
 *   媒體檔的退回折讓明細記錄仍未產出（格式代號未經原文核對，見規格書未決問題），回應會出聲。
 * - 上期累積留抵（代號 108）自動承轉自上一期的申報紀錄（vat_returns），可用參數覆寫；
 *   第一次申報沒有紀錄時以 0 帶入並在 carryover.notes 出聲。
 */
export async function generate401(
  db: Db,
  period: string,
  opts?: { prevCarryForward?: number | undefined },
) {
  const { rocPeriod, months } = rocPeriodOf(period);
  // 迄日由 periodDateRange 算出該月實際天數——寫死 31 會讓迄月為 2/4/6 月的三個期別
  // 組出不存在的日期而整支查詢 500（六個申報期壞掉三個）
  const { from, to } = periodDateRange(period);

  const [company] = await db.select().from(schema.companyProfile);
  if (!company) throw new AppError(422, "公司基本檔未設定");
  if (!company.taxRegistrationNo || !company.cityCode) {
    throw new AppError(422, "公司稅籍編號或縣市別未設定（PUT /company-profile）");
  }
  // 兼營擋下（0028，B12）：兼營免稅／特種稅額的公司要用 403 申報（含不得扣抵比例計算），
  // 本系統只支援 401（專營應稅）。標記後仍產出 401 就是一份「看起來完全正常、實則報錯
  // 申報書類別」的檔案——這比報錯數字更難被發現，所以擋下並指路，不靜默產出
  if (company.vatMixedBusiness) {
    throw new AppError(
      422,
      "公司基本檔標記為「兼營免稅／特種稅額」：兼營的營業稅申報要用 403 申報書（含不得扣抵比例計算），本系統目前只支援 401（專營應稅），不產出 401 以免錯用申報書類別。請以財政部申報軟體或洽記帳士辦理 403 申報；若貴公司實為專營應稅，請到「設定」頁取消該標記",
    );
  }

  const rocYearOf = (isoDate: string) => Number(isoDate.slice(0, 4)) - 1911;
  const monthOf = (isoDate: string) => Number(isoDate.slice(5, 7));

  // 銷項：本期開立之電子發票（含作廢）
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(and(gte(schema.invoices.invoiceDate, from), lte(schema.invoices.invoiceDate, to)));

  const records: MediaRecord[] = [];
  const parameterNotes = new Set<string>();
  let serial = 0;
  let outputSales = 0;
  let outputTax = 0;

  for (const inv of invoices) {
    serial += 1;
    const common = {
      taxRegistrationNo: company.taxRegistrationNo,
      serial,
      rocYear: rocYearOf(inv.invoiceDate),
      month: monthOf(inv.invoiceDate),
      track: inv.invoiceNumber.slice(0, 2),
      invoiceNo: inv.invoiceNumber.slice(2),
    };
    if (inv.status === "canceled") {
      records.push({
        ...common,
        formatCode: FORMAT_CODES.OUTPUT_EINVOICE,
        salesAmount: 0,
        taxType: "F",
        taxAmount: 0,
        deductionCode: " ",
      });
      continue;
    }
    // 零稅率發票（0028，B12）：媒體檔課稅別 2、銷售額＝發票總額（稅 0，未稅＝含稅）、稅額 0。
    // 不進應稅欄（outputSales/outputTax）——零稅率銷售額另由 sales 取數進申報書代號 7/15
    // （經海關出口免開統一發票，只看發票會漏掉那部分）。
    // ⚠️ 第 81 碼「通關方式註記」未填：其代號值未經作業要點原文核對（規格書未決問題），
    // 用猜的代號比不填更糟——回應的 zeroRate.notes 會出聲提醒在官方軟體補正。
    if (inv.taxType === "2") {
      records.push({
        ...common,
        formatCode: FORMAT_CODES.OUTPUT_EINVOICE,
        buyerTaxId: inv.buyerTaxId ?? undefined,
        salesAmount: inv.totalAmount,
        taxType: "2",
        taxAmount: 0,
        deductionCode: " ",
      });
      continue;
    }
    // B2B：發票上已稅額分離；B2C：內含稅，依作業要點公式拆算。
    // ⚠️ B2C 的拆算是**讀取時再推導**（不是建單時落地的欄位），所以它必須用
    // 該張發票**自己那一天**的費率，而不是今天的：用今天的費率拆一張三個月前的發票，
    // 產出的申報數字會與當初開立的 XML 不一致，而畫面上沒有任何徵兆
    let split: { salesAmount: number; taxAmount: number };
    if (inv.mode === "B2B") {
      split = { salesAmount: inv.salesAmount, taxAmount: inv.taxAmount };
    } else {
      const vat = await rateFromSnapshot(db, inv.vatRateBp, inv.invoiceDate);
      for (const n of vat.notes) parameterNotes.add(n);
      split = splitB2CTotal(inv.totalAmount, vat.rate);
    }
    const { salesAmount, taxAmount } = split;
    outputSales += salesAmount;
    outputTax += taxAmount;
    records.push({
      ...common,
      formatCode: FORMAT_CODES.OUTPUT_EINVOICE,
      buyerTaxId: inv.buyerTaxId ?? undefined,
      salesAmount,
      taxType: "1",
      taxAmount,
      deductionCode: " ",
    });
  }

  // ---------------------------------------------------------------- 零稅率銷售額（0028，B12）
  // 取數自 sales（課稅別 2、未沖銷、依單據日歸期）而不是 invoices：經海關出口免開統一發票，
  // 只看發票會漏掉那部分零稅率銷售額。經海關（申報書代號 15）與非經海關（代號 7）分欄，
  // 依單頭的 zero_tax_via_customs 落位。缺證明文件號碼的仍列入（銷售額是事實），但要出聲。
  const zeroSalesRows = await db
    .select({
      id: schema.sales.id,
      docDate: schema.sales.docDate,
      subtotal: schema.sales.subtotal,
      viaCustoms: schema.sales.zeroTaxViaCustoms,
      certNo: schema.sales.zeroTaxCertNo,
    })
    .from(schema.sales)
    .where(
      and(
        eq(schema.sales.taxType, "2"),
        gte(schema.sales.docDate, from),
        lte(schema.sales.docDate, to),
        isNull(schema.sales.reversalEntryId),
      ),
    );
  const zeroCustoms = zeroSalesRows.filter((s) => s.viaCustoms).reduce((s, r) => s + r.subtotal, 0);
  const zeroNonCustoms = zeroSalesRows.filter((s) => !s.viaCustoms).reduce((s, r) => s + r.subtotal, 0);
  const zeroMissingCertItems = zeroSalesRows
    .filter((s) => !s.certNo)
    .map((s) => ({ saleId: s.id, docDate: s.docDate, subtotal: s.subtotal, viaCustoms: !!s.viaCustoms }));

  // 進項：本期已登錄供應商發票的進貨單。
  // 歸期（0029，R20）優先吃**供應商發票日期**（憑證日）——賣方依發票日期申報銷項，
  // 買方用進貨單日期（帳務日）歸期會讓 6/30 開票、7/2 入帳的發票兩邊落在不同期，申報勾稽不符。
  // inv_date 為 NULL（0029 前的舊單）退回 doc_date，並在回應出聲——兩種歸期混用不可靜默
  const purchaseEffDate = sql<string>`coalesce(${schema.purchases.invDate}, ${schema.purchases.docDate})`;
  const purchaseRows = await db
    .select({
      id: schema.purchases.id,
      docDate: schema.purchases.docDate,
      invDate: schema.purchases.invDate,
      subtotal: schema.purchases.subtotal,
      tax: schema.purchases.tax,
      invTrack: schema.purchases.invTrack,
      invNo: schema.purchases.invNo,
      invFormat: schema.purchases.invFormat,
      deductionCode: schema.purchases.deductionCode,
      sellerTaxId: schema.partners.taxId,
    })
    .from(schema.purchases)
    .innerJoin(schema.partners, eq(schema.purchases.partnerId, schema.partners.id))
    .where(
      and(
        gte(purchaseEffDate, from),
        lte(purchaseEffDate, to),
        isNotNull(schema.purchases.invTrack),
        // 已作廢進貨單（0025，B4）：整筆沖掉的進項不得再申報扣抵——
        // 服務層擋了「作廢日期落在已關帳期間的進貨」，所以這裡排除的都還沒申報過
        isNull(schema.purchases.voidedAt),
      ),
    );

  // 進項（報銷）：已核准/已付款報銷單中可扣抵的統編電子發票，依發票日期歸期。
  // 已作廢報銷單（0036）排除：作廢的整套意義就在這裡——手工反向傳票救得了總帳、
  // 救不了這條 join，多報的進項稅會照樣進媒體檔（服務層擋了「發票日期落在已關帳期間」
  // 的報銷作廢，所以這裡排除的都還沒申報過）
  const expenseRows = await db
    .select({
      invoiceNumber: schema.expenseItems.invoiceNumber,
      invoiceDate: schema.expenseItems.invoiceDate,
      sellerTaxId: schema.expenseItems.sellerTaxId,
      amount: schema.expenseItems.amount,
      tax: schema.expenseItems.tax,
      status: schema.expenseClaims.status,
    })
    .from(schema.expenseItems)
    .innerJoin(schema.expenseClaims, eq(schema.expenseItems.claimId, schema.expenseClaims.id))
    .where(
      and(
        eq(schema.expenseItems.deductible, true),
        gte(schema.expenseItems.invoiceDate, from),
        lte(schema.expenseItems.invoiceDate, to),
        isNull(schema.expenseClaims.voidedAt),
      ),
    );

  // 可扣抵進項分四桶：格式（25 電子發票／21、22 統一發票扣抵聯）× 用途（進貨費用／固資）。
  // 分桶錯了申報書與媒體檔會自相矛盾——那正是 B10 實測抓到的現象
  let inputExpense = 0; // 電子發票 進貨費用（代號 32/33）
  let inputExpenseTax = 0;
  let inputFixedAsset = 0; // 電子發票 固資（代號 34/35）
  let inputFixedAssetTax = 0;
  let paperExpense = 0; // 統一發票扣抵聯 進貨費用（代號 28/29）
  let paperExpenseTax = 0;
  let paperFixedAsset = 0; // 統一發票扣抵聯 固資（代號 30/31）
  let paperFixedAssetTax = 0;
  // 扣抵代號 3/4：不可扣抵。只寫媒體檔明細；金額稅額**不進任何可扣抵合計**（進了就是少繳稅）
  const nonDeductibleItems: {
    purchaseId: number;
    docDate: string;
    invoice: string;
    deductionCode: string;
    amount: number;
    tax: number;
  }[] = [];

  // 沒登發票日期而退回進貨單日期歸期的單：金額照列（退回歸期是刻意的相容行為），
  // 但要讓會計看得到哪幾張——補登發票日期後重新產出，歸期就會跟著憑證走
  const invDateFallbackItems: { purchaseId: number; docDate: string; invoice: string }[] = [];

  for (const p of purchaseRows) {
    if (!p.sellerTaxId) throw new AppError(422, "進項發票之供應商缺少統一編號");
    serial += 1;
    // 媒體檔的年月＝歸期依據的那個日期（憑證日；無值退回帳務日）——篩選與產檔要說同一件事
    const periodBasisDate = p.invDate ?? p.docDate;
    if (!p.invDate) {
      invDateFallbackItems.push({
        purchaseId: p.id,
        docDate: p.docDate,
        invoice: `${p.invTrack}${p.invNo}`,
      });
    }
    records.push({
      formatCode: p.invFormat,
      taxRegistrationNo: company.taxRegistrationNo,
      serial,
      rocYear: rocYearOf(periodBasisDate),
      month: monthOf(periodBasisDate),
      sellerTaxId: p.sellerTaxId,
      track: p.invTrack!,
      invoiceNo: p.invNo!,
      salesAmount: p.subtotal,
      taxType: "1",
      taxAmount: p.tax,
      deductionCode: p.deductionCode as MediaRecord["deductionCode"],
    });
    if (p.deductionCode === "3" || p.deductionCode === "4") {
      nonDeductibleItems.push({
        purchaseId: p.id,
        docDate: p.docDate,
        invoice: `${p.invTrack}${p.invNo}`,
        deductionCode: p.deductionCode,
        amount: p.subtotal,
        tax: p.tax,
      });
      continue;
    }
    const isFixedAsset = p.deductionCode === "2";
    const isPaper = p.invFormat !== "25"; // 21/22 → 統一發票扣抵聯欄（代號 28-31）
    if (isFixedAsset && isPaper) {
      paperFixedAsset += p.subtotal;
      paperFixedAssetTax += p.tax;
    } else if (isFixedAsset) {
      inputFixedAsset += p.subtotal;
      inputFixedAssetTax += p.tax;
    } else if (isPaper) {
      paperExpense += p.subtotal;
      paperExpenseTax += p.tax;
    } else {
      inputExpense += p.subtotal;
      inputExpenseTax += p.tax;
    }
  }

  for (const e of expenseRows) {
    if (e.status !== "approved" && e.status !== "paid") continue; // 未核准不申報
    serial += 1;
    const net = e.amount - e.tax;
    inputExpense += net;
    inputExpenseTax += e.tax;
    records.push({
      formatCode: FORMAT_CODES.INPUT_EINVOICE,
      taxRegistrationNo: company.taxRegistrationNo,
      serial,
      rocYear: rocYearOf(e.invoiceDate!),
      month: monthOf(e.invoiceDate!),
      sellerTaxId: e.sellerTaxId!,
      track: e.invoiceNumber!.slice(0, 2),
      invoiceNo: e.invoiceNumber!.slice(2),
      salesAmount: net,
      taxType: "1",
      taxAmount: e.tax,
      deductionCode: "1",
    });
  }

  // ---------------------------------------------------------------- 退回折讓
  // 減項取數（B11）：**已登錄證明單號碼**的退回折讓才列入——證明單是列報減項的依據，
  // 沒有它就沒有可申報的東西。歸期依證明單日期（證明單常在下個月才開/寄到），未填日期以退回日代。
  // 只算「原單有進到申報範圍」的退回：銷項的申報基礎是已開立的電子發票，
  // 沒開發票的銷貨單退回不影響申報數字，算進來會讓減項過大而少繳稅；
  // 進項同理——原進貨單要已登錄供應商發票，且扣抵代號 3/4 的原進項根本沒申報扣抵，
  // 它的退出也就沒有可減的東西。
  const effDate = (r: { certDate: string | null; docDate: string }) => r.certDate ?? r.docDate;
  const inPeriod = (r: { certDate: string | null; docDate: string }) => {
    const d = effDate(r);
    return d >= from && d <= to;
  };

  // 銷項退回的「原單在申報範圍」判準分兩種（0028 起）：應稅＝原銷貨單有已開立的電子發票；
  // 零稅率＝原銷貨單本身（經海關出口免開發票，申報基礎是銷貨單而不是發票）。
  // leftJoin 限定 status='issued'（同一銷貨單至多一張 issued，不會重列）
  const certifiedSaleReturnRows = (
    await db
      .select({
        subtotal: schema.salesReturns.subtotal,
        tax: schema.salesReturns.tax,
        certDate: schema.salesReturns.certDate,
        docDate: schema.salesReturns.docDate,
        taxType: schema.sales.taxType,
        invoiceId: schema.invoices.id,
      })
      .from(schema.salesReturns)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.salesReturns.saleId))
      .leftJoin(
        schema.invoices,
        and(eq(schema.invoices.saleId, schema.salesReturns.saleId), eq(schema.invoices.status, "issued")),
      )
      // 已作廢退回折讓單（0030）不列減項：迴轉效果已被反向傳票收回，列進來會少繳稅
      .where(and(isNotNull(schema.salesReturns.certNo), isNull(schema.salesReturns.voidedAt)))
  ).filter((r) => inPeriod(r) && (r.taxType === "2" || r.invoiceId !== null));
  // 應稅退回進代號 17/18（欄 13/19）；零稅率退回進代號 19（欄 24），兩邊不可混——
  // 零稅率退回混進應稅減項會把應稅銷售額與銷項稅額扣錯欄
  const certifiedSaleReturns = certifiedSaleReturnRows.filter((r) => r.taxType !== "2");
  const certifiedZeroReturns = certifiedSaleReturnRows.filter((r) => r.taxType === "2");
  const zeroReturnsAmount = certifiedZeroReturns.reduce((s, r) => s + r.subtotal, 0);

  const certifiedPurchaseReturns = (
    await db
      .select({
        subtotal: schema.purchaseReturns.subtotal,
        tax: schema.purchaseReturns.tax,
        certDate: schema.purchaseReturns.certDate,
        docDate: schema.purchaseReturns.docDate,
        deductionCode: schema.purchases.deductionCode,
      })
      .from(schema.purchaseReturns)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseReturns.purchaseId))
      .where(
        and(
          isNotNull(schema.purchaseReturns.certNo),
          isNotNull(schema.purchases.invTrack),
          isNull(schema.purchaseReturns.voidedAt),
        ),
      )
  ).filter((r) => inPeriod(r) && (r.deductionCode === "1" || r.deductionCode === "2"));

  const sumRet = (rows: { subtotal: number; tax: number }[]) => ({
    count: rows.length,
    amount: rows.reduce((s, r) => s + r.subtotal, 0),
    tax: rows.reduce((s, r) => s + r.tax, 0),
  });
  const salesReturnsDeducted = sumRet(certifiedSaleReturns);
  const purchaseReturnsExpense = sumRet(certifiedPurchaseReturns.filter((r) => r.deductionCode === "1"));
  const purchaseReturnsFixedAsset = sumRet(certifiedPurchaseReturns.filter((r) => r.deductionCode === "2"));
  const deductedCount =
    salesReturnsDeducted.count + purchaseReturnsExpense.count + purchaseReturnsFixedAsset.count;
  const returnsInFiling = {
    sales: salesReturnsDeducted,
    purchases: { expense: purchaseReturnsExpense, fixedAsset: purchaseReturnsFixedAsset },
    ...(deductedCount > 0
      ? {
          note:
            "上列退回／折讓已列入申報書的減項欄位（歸期依證明單日期）。" +
            "但媒體檔的退回折讓明細記錄尚未產出（其格式代號未經作業要點原文核對，" +
            "見 docs/specs/vat-401-403.md 未決問題）——匯入財政部申報軟體後，請依證明單逐筆補登明細。",
        }
      : {}),
  };

  // 沒登錄證明單的退回折讓（依退回日歸期、原單在申報範圍內）：**未列入減項**，要擺在使用者眼前。
  // 補登路徑：銷貨／進貨頁退回紀錄的「補登證明單」；補登後重新產出本期即列入。
  const uncertifiedSaleReturns = (
    await db
      .select({
        subtotal: schema.salesReturns.subtotal,
        tax: schema.salesReturns.tax,
        taxType: schema.sales.taxType,
        invoiceId: schema.invoices.id,
      })
      .from(schema.salesReturns)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.salesReturns.saleId))
      .leftJoin(
        schema.invoices,
        and(eq(schema.invoices.saleId, schema.salesReturns.saleId), eq(schema.invoices.status, "issued")),
      )
      .where(
        and(
          gte(schema.salesReturns.docDate, from),
          lte(schema.salesReturns.docDate, to),
          isNull(schema.salesReturns.certNo),
          // 已作廢的單不需要證明單，出聲清單不追它
          isNull(schema.salesReturns.voidedAt),
        ),
      )
  ).filter((r) => r.taxType === "2" || r.invoiceId !== null);
  const uncertifiedPurchaseReturns = await db
    .select({ subtotal: schema.purchaseReturns.subtotal, tax: schema.purchaseReturns.tax })
    .from(schema.purchaseReturns)
    .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseReturns.purchaseId))
    .where(
      and(
        gte(schema.purchaseReturns.docDate, from),
        lte(schema.purchaseReturns.docDate, to),
        isNull(schema.purchaseReturns.certNo),
        isNull(schema.purchaseReturns.voidedAt),
        isNotNull(schema.purchases.invTrack),
      ),
    );
  const sum = (rows: { subtotal: number; tax: number }[]) => ({
    count: rows.length,
    subtotal: rows.reduce((s, r) => s + r.subtotal, 0),
    tax: rows.reduce((s, r) => s + r.tax, 0),
  });
  const salesReturns = sum(uncertifiedSaleReturns);
  const purchaseReturns = sum(uncertifiedPurchaseReturns);
  // note 只在真的有缺證明單的退回時才出現：count 全為 0 還帶著警語是製造雜訊，
  // 常態下天天看到警告，真的出事那天就沒人看了
  const returnsNotReflected = {
    sales: salesReturns,
    purchases: purchaseReturns,
    ...(salesReturns.count + purchaseReturns.count > 0
      ? {
          note:
            "本期有已入帳的退回／折讓還沒登錄證明單號碼，未列入本申報檔的減項：" +
            "銷項仍是毛額（多繳）、進項也未扣減（少繳的方向不會發生，但進貨端補登後才退得到）。" +
            "證明單需另行以財政部軟體或加值中心平台開立，開好後到「銷貨」「進貨」頁的退回紀錄" +
            "按「補登證明單」，再回來重新產出本期申報檔即會列入。",
        }
      : {}),
  };

  // ---------------------------------------------------------------- 上期累積留抵（代號 108）
  // 留抵是跨期的鏈：本期的 108＝上期申報的 115。取數順序：人工覆寫 > 上期申報紀錄 > 0（出聲）。
  const prevPeriod = previousPeriod(period);
  const [prevRecord] = await db
    .select()
    .from(schema.vatReturns)
    .where(eq(schema.vatReturns.period, prevPeriod));
  const carryoverNotes: string[] = [];
  let prevCarryForward: number;
  let carryoverSource: "manual" | "filed" | "none";
  if (opts?.prevCarryForward !== undefined) {
    prevCarryForward = opts.prevCarryForward;
    carryoverSource = "manual";
    if (prevRecord && prevRecord.carryForward !== prevCarryForward) {
      carryoverNotes.push(
        `手動輸入的上期留抵 ${prevCarryForward} 元與上期（${prevPeriod}）申報紀錄的期末留抵 ` +
          `${prevRecord.carryForward} 元不一致——請確認以哪一個為準（申報紀錄在「營業稅申報」頁下方）。`,
      );
    }
  } else if (prevRecord) {
    prevCarryForward = prevRecord.carryForward;
    carryoverSource = "filed";
  } else {
    prevCarryForward = 0;
    carryoverSource = "none";
    const [anyRecord] = await db.select().from(schema.vatReturns).limit(1);
    carryoverNotes.push(
      anyRecord
        ? `找不到上期（${prevPeriod}）的申報紀錄，上期累積留抵以 0 帶入——但系統裡有其他期別的` +
            `申報紀錄，留抵承轉在這裡斷了鏈。請確認上期是否漏存，或在畫面手動輸入正確的上期留抵。`
        : `找不到上期（${prevPeriod}）的申報紀錄，上期累積留抵（申報書代號 108）以 0 帶入。` +
            `第一次用本系統申報屬正常；若上期實際有留抵，請在畫面輸入金額後重新產出。` +
            `本期申報完成後按「存為申報紀錄」，下期即可自動承轉。`,
    );
  }

  // ---------------------------------------------------------------- 申報人（第 98-104 欄）
  const filerIdNo = decryptPii(company.filerIdNo);
  if (filerIdNo && !/^[\x20-\x7E]{1,10}$/.test(filerIdNo)) {
    throw new AppError(422, "申報人身分證統一編號超過 10 碼或含全形字元，請到「設定」頁公司基本檔更正");
  }
  const agentNo = (company.declarationAgentNo ?? "").trim();
  const filerNotes: string[] = [];
  if (!company.filerName || !filerIdNo) {
    filerNotes.push(
      "申報人姓名或身分證統一編號未設定，申報書第 99-103 欄將是空白——請到「設定」頁的" +
        "公司基本檔填寫申報人資料（委託記帳士申報則另填代理申報人登錄字號）。",
    );
  }

  const ret = build401({
    ban: company.taxId,
    taxRegistrationNo: company.taxRegistrationNo,
    rocPeriod,
    cityCode: company.cityCode,
    invoiceCount: invoices.length,
    einvoiceSales: outputSales,
    einvoiceSalesTax: outputTax,
    einvoicePurchaseExpense: inputExpense,
    einvoicePurchaseExpenseTax: inputExpenseTax,
    einvoicePurchaseFixedAsset: inputFixedAsset,
    einvoicePurchaseFixedAssetTax: inputFixedAssetTax,
    paperPurchaseExpense: paperExpense,
    paperPurchaseExpenseTax: paperExpenseTax,
    paperPurchaseFixedAsset: paperFixedAsset,
    paperPurchaseFixedAssetTax: paperFixedAssetTax,
    zeroRateSales: { nonCustoms: zeroNonCustoms, customs: zeroCustoms, returns: zeroReturnsAmount },
    salesReturns: { amount: salesReturnsDeducted.amount, tax: salesReturnsDeducted.tax },
    purchaseReturnsExpense: { amount: purchaseReturnsExpense.amount, tax: purchaseReturnsExpense.tax },
    purchaseReturnsFixedAsset: {
      amount: purchaseReturnsFixedAsset.amount,
      tax: purchaseReturnsFixedAsset.tax,
    },
    prevCarryForward,
    filer: {
      idNumber: filerIdNo ?? undefined,
      name: company.filerName ?? undefined,
      areaCode: company.filerAreaCode ?? undefined,
      phone: company.filerPhone ?? undefined,
      ext: company.filerExt ?? undefined,
    },
    agentFilerNo: agentNo || undefined,
  });

  const nonDeductible = {
    count: nonDeductibleItems.length,
    amount: nonDeductibleItems.reduce((s, i) => s + i.amount, 0),
    tax: nonDeductibleItems.reduce((s, i) => s + i.tax, 0),
    items: nonDeductibleItems,
  };

  // ---------------------------------------------------------------- 進項歸期退回（0029，R20）
  // note 只在真的有退回時出現（同 returnsNotReflected 的理由：常態警語＝沒人看的警語）
  const inputDateFallback = {
    count: invDateFallbackItems.length,
    items: invDateFallbackItems,
    notes:
      invDateFallbackItems.length > 0
        ? [
            `本期有 ${invDateFallbackItems.length} 張進貨單（#${invDateFallbackItems
              .map((i) => i.purchaseId)
              .join("、#")}）沒登錄供應商發票日期，進項歸期以進貨單日期代替。` +
              `發票開立月份與進貨月份不同時，會與賣方申報的期別勾稽不符——` +
              `請到「進貨」頁按「改發票資訊」補上發票日期後重新產出本期申報檔。`,
          ]
        : [],
  };

  // ---------------------------------------------------------------- 零稅率的出聲提醒（0028）
  // 三件事都不可靜默：①缺證明文件的零稅率銷售額仍列入了申報書（申報需檢附文件）；
  // ②退稅欄（代號 113/114）不計算、溢付全額留抵；③媒體檔零稅率明細的通關方式註記未填。
  const zeroTotal = zeroNonCustoms + zeroCustoms - zeroReturnsAmount;
  const zeroNotes: string[] = [];
  if (zeroMissingCertItems.length > 0) {
    const missingSum = zeroMissingCertItems.reduce((s, i) => s + i.subtotal, 0);
    zeroNotes.push(
      `本期有 ${zeroMissingCertItems.length} 筆零稅率銷貨（合計 ${missingSum} 元）還沒登錄證明文件號碼` +
        `（經海關＝出口報單號碼；非經海關＝外匯證明文件號碼等）。金額已列入申報書的零稅率銷售額，` +
        `但申報零稅率需檢附證明文件——請到「銷貨」頁補登號碼，或確認該單是否真為零稅率。`,
    );
  }
  if (zeroNonCustoms + zeroCustoms > 0) {
    zeroNotes.push(
      "零稅率銷售額已列入申報書（代號 7／15／19／23）。得退稅限額與應退稅額（代號 113／114）" +
        "本系統不計算（其計算規則未經規格書查證），一律填 0＝溢付稅額全額留抵到下期；" +
        "若要申請退稅，請以財政部申報軟體匯入後的計算為準。",
    );
  }
  if (records.some((r) => r.taxType === "2")) {
    zeroNotes.push(
      "媒體檔中零稅率銷項明細的「通關方式註記」（第 81 碼）未填——該欄的代號值未經作業要點原文核對" +
        "（見 docs/specs/vat-401-403.md 未決問題），匯入財政部申報軟體後請依實際通關方式補正。",
    );
  }

  return {
    period,
    rocPeriod,
    months,
    summary: {
      invoiceCount: invoices.length,
      outputSales,
      outputTax,
      // 可扣抵進項（含統一發票扣抵聯與電子發票、未扣退出折讓）；不可扣抵的在 nonDeductible
      inputExpense: inputExpense + paperExpense,
      inputExpenseTax: inputExpenseTax + paperExpenseTax,
      inputFixedAsset: inputFixedAsset + paperFixedAsset,
      inputFixedAssetTax: inputFixedAssetTax + paperFixedAssetTax,
      ...ret.computed,
    },
    /** 已列入減項的退回折讓（有證明單）；media 明細未產出的提醒在 note */
    returnsInFiling,
    /** 缺證明單而未列入減項的退回折讓：紅色警示的取數 */
    returnsNotReflected,
    /** 不可扣抵進項（扣抵代號 3/4）的排除清單：只進媒體檔明細，不進可扣抵合計 */
    nonDeductible,
    /** 進項歸期退回（0029，R20）：沒登發票日期、以進貨單日期歸期的單——補登後重新產出即改吃憑證日 */
    inputDateFallback,
    /** 零稅率（0028，B12）：分欄金額、缺證明文件清單與提醒；沒有零稅率時各值為 0／空 */
    zeroRate: {
      nonCustoms: zeroNonCustoms,
      customs: zeroCustoms,
      returns: zeroReturnsAmount,
      total: zeroTotal,
      missingCert: { count: zeroMissingCertItems.length, items: zeroMissingCertItems },
      notes: zeroNotes,
    },
    /** 留抵承轉：來源（manual 手動輸入／filed 上期申報紀錄／none 無紀錄預設 0）與提醒 */
    carryover: {
      prevPeriod,
      prevCarryForward,
      source: carryoverSource,
      notes: carryoverNotes,
    },
    /** 申報人（白名單：不含身分證明文，明文只進申報書檔本身） */
    filer: {
      name: company.filerName,
      hasIdNo: !!filerIdNo,
      areaCode: company.filerAreaCode,
      phone: company.filerPhone,
      ext: company.filerExt,
      agentNo: agentNo || null,
      selfFiled: !agentNo,
      notes: filerNotes,
    },
    // 稅法參數的警告（走了回退費率）一路帶到申報畫面：這份檔案是拿去繳稅的
    parameterNotes: [...parameterNotes],
    mediaFile: { name: `${company.taxId}.txt`, content: buildMediaFile(records), records: records.length },
    returnFile: { name: `${company.taxId}-401.txt`, content: ret.file },
  };
}

/**
 * 存申報紀錄（一期一列）：存的是「當時申報的數字」，之後單據若被改動，兩者的差異正是要被看見的。
 * 只能往後接著存（不可回頭補早於既有紀錄的期別）——中間插一列會讓其後每期的留抵基礎失去來歷。
 */
export async function fileReturn401(
  db: Db,
  period: string,
  userId: number,
  opts?: { prevCarryForward?: number | undefined },
) {
  const [existing] = await db.select().from(schema.vatReturns).where(eq(schema.vatReturns.period, period));
  if (existing) {
    throw new AppError(
      409,
      "期別 {period} 已有申報紀錄（#{id}）。更正申報請先刪除該期紀錄（只能刪最新一期）再重新存檔——刪除後其後期別的留抵承轉會跟著改變，請依期別順序重存",
      { period, id: existing.id },
    );
  }
  const [later] = await db
    .select({ period: schema.vatReturns.period })
    .from(schema.vatReturns)
    .where(gt(schema.vatReturns.period, period))
    .limit(1);
  if (later) {
    throw new AppError(
      409,
      "已存在較晚期別（{later}）的申報紀錄，不可回頭補存 {period}——較晚期別的上期留抵已經定案，往回插一期會讓它失去來歷。若順序真的錯了，請從最新一期開始逐期刪除後依序重存",
      { later: later.period, period },
    );
  }
  const result = await generate401(db, period, opts);
  const [row] = await db
    .insert(schema.vatReturns)
    .values({
      period,
      rocPeriod: result.rocPeriod,
      outputSales: result.summary.salesTotal,
      outputTax: result.summary.outputTaxTotal,
      deductibleInputTax: result.summary.deductibleInputTaxTotal,
      prevCarryForward: result.carryover.prevCarryForward,
      payable: result.summary.payable,
      carryForward: result.summary.carryForward,
      createdBy: userId,
    })
    .returning();
  return row!;
}

export async function listReturn401Filings(db: Db) {
  return db.select().from(schema.vatReturns).orderBy(desc(schema.vatReturns.period));
}

/** 只能刪最新一期：中間抽掉一列會讓其後每期存檔的留抵基礎失去來歷 */
export async function deleteReturn401Filing(db: Db, period: string) {
  const [target] = await db.select().from(schema.vatReturns).where(eq(schema.vatReturns.period, period));
  if (!target) throw new AppError(404, "期別 {period} 沒有申報紀錄", { period });
  const [later] = await db
    .select({ period: schema.vatReturns.period })
    .from(schema.vatReturns)
    .where(gt(schema.vatReturns.period, period))
    .limit(1);
  if (later) {
    throw new AppError(
      409,
      "期別 {later} 的申報紀錄以 {period} 的期末留抵為基礎，不可先刪除 {period}。請從最新一期開始逐期刪除",
      { later: later.period, period },
    );
  }
  await db.delete(schema.vatReturns).where(eq(schema.vatReturns.period, period));
  return { ok: true, period };
}
