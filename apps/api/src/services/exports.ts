/**
 * 記帳士匯出（Phase 4）：傳票明細、銷項發票、進項發票三種 CSV。
 * 格式：UTF-8 含 BOM＋CRLF 行尾（Excel 直開不亂碼）；金額整數元，零值留空。
 */
import { EXPENSE_CATEGORIES } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, asc, eq, gte, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../db.ts";
import { saleAllowanceXmlBatch } from "./allowance-xml.ts";
import { depreciationSchedule } from "./assets.ts";

type Cell = string | number | null;

function toCsv(header: string[], rows: Cell[][]): string {
  const escape = (c: Cell): string => {
    if (c === null || c === "") return "";
    const s = String(c);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [header, ...rows].map((r) => r.map(escape).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** 零值留空：記帳系統匯入與人工核對時借貸欄位較清晰 */
const amt = (n: number): Cell => (n === 0 ? "" : n);

export interface ExportFile {
  name: string;
  content: string;
  rows: number;
}

/** 傳票明細：一列＝一筆傳票分錄，含科目與來源單據 */
export async function journalExport(db: Db, from: string, to: string): Promise<ExportFile> {
  const lines = await db
    .select({
      entryId: schema.journalEntries.id,
      entryDate: schema.journalEntries.entryDate,
      memo: schema.journalEntries.memo,
      code: schema.accounts.code,
      accountName: schema.accounts.name,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalLines.entryId, schema.journalEntries.id))
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(and(gte(schema.journalEntries.entryDate, from), lte(schema.journalEntries.entryDate, to)))
    .orderBy(
      asc(schema.journalEntries.entryDate),
      asc(schema.journalEntries.id),
      asc(schema.journalLines.id),
    );
  const rows = lines.map((l) => [l.entryId, l.entryDate, l.memo, l.code, l.accountName, amt(l.debit), amt(l.credit)]);
  return {
    name: `傳票明細_${from}_${to}.csv`,
    content: toCsv(["傳票編號", "日期", "摘要", "科目代號", "科目名稱", "借方金額", "貸方金額"], rows),
    rows: rows.length,
  };
}

/** 銷項發票：本系統開立之電子發票（含作廢，金額照存證值：B2C 為含稅） */
export async function salesInvoicesExport(db: Db, from: string, to: string): Promise<ExportFile> {
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(and(gte(schema.invoices.invoiceDate, from), lte(schema.invoices.invoiceDate, to)))
    .orderBy(asc(schema.invoices.invoiceDate), asc(schema.invoices.invoiceNumber));
  const rows = invoices.map((i) => [
    i.invoiceNumber,
    i.invoiceDate,
    i.mode,
    i.status === "issued" ? "已開立" : "已作廢",
    i.buyerTaxId,
    i.buyerName,
    i.salesAmount,
    i.taxAmount,
    i.totalAmount,
    i.cancelReason,
  ]);
  return {
    name: `銷項發票_${from}_${to}.csv`,
    content: toCsv(
      ["發票號碼", "發票日期", "類型", "狀態", "買受人統編", "買受人", "銷售額", "稅額", "總計", "作廢原因"],
      rows,
    ),
    rows: rows.length,
  };
}

/**
 * 電子發票 XML 批次匯出（B5）：期間內全部發票的 F0401，加上其中已作廢者的 F0501。
 *
 * 形狀是 `{ files: [{name, content}] }` 由前端逐檔下載，**刻意不打包 zip**：
 * zip 要新增一個壓縮依賴，而 Turnkey 的上傳目錄本來就吃「一張訊息一個 XML 檔」，
 * 使用者拿到手還是得解開——多一道壓縮只是把逐檔下載換成逐檔解壓。
 * 檔名照 MIG 官方範例的慣例：`F0401-<發票號碼>.xml`／`F0501-<發票號碼>.xml`
 * （兩種訊息前綴不同，同一張作廢發票的兩個檔不會互撞）。
 *
 * 依 invoice_date 篩選（F0501 也是）：401 與媒體檔都依發票日期歸期，
 * 「7 月的發票、8 月作廢」的作廢訊息要跟著原發票那一期一起交，拆開會漏傳。
 * 作廢發票的 F0401 照樣匯出：大平台要先收到開立訊息才收得了作廢訊息。
 *
 * G0401（第二批）：銷貨折讓單登錄了證明單號碼＋日期的，一併帶折讓證明單訊息——
 * 歸期依**證明單日期**（401 減項的歸期），該產卻缺號碼/日期/原發票的以 notes 出聲，
 * 不靜默跳過（漏一張就是申報時少一筆減項依據）。細節見 services/allowance-xml.ts。
 * G0501（0030，第三批）：已作廢折讓單的作廢訊息，跟 G0401 同一期（cert_date 歸期）。
 */
export async function einvoiceXmlExport(db: Db, from: string, to: string) {
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(and(gte(schema.invoices.invoiceDate, from), lte(schema.invoices.invoiceDate, to)))
    .orderBy(asc(schema.invoices.invoiceDate), asc(schema.invoices.invoiceNumber));
  const files: { name: string; content: string }[] = [];
  let cancelCount = 0;
  for (const inv of invoices) {
    files.push({ name: `F0401-${inv.invoiceNumber}.xml`, content: inv.xml });
    if (inv.status === "canceled" && inv.cancelXml) {
      files.push({ name: `F0501-${inv.invoiceNumber}.xml`, content: inv.cancelXml });
      cancelCount += 1;
    }
  }
  const allowances = await saleAllowanceXmlBatch(db, from, to);
  files.push(...allowances.files);
  return {
    from,
    to,
    invoiceCount: invoices.length,
    cancelCount,
    allowanceCount: allowances.allowanceCount,
    allowanceCancelCount: allowances.allowanceCancelCount,
    notes: allowances.notes,
    files,
  };
}

/**
 * 折舊明細表 CSV（gap 3.7）：與 GET /reports/depreciation-schedule 同一份取數
 * （services/assets.ts depreciationSchedule），只是換成記帳士拿得走的格式。
 * 掛在 /reports 底下以 format=csv 取（不是 /exports）：看得到這張表的人（報表頁）
 * 就應該下載得了它，權限不因輸出格式而分家。
 */
export async function depreciationScheduleExport(db: Db, year: number): Promise<ExportFile> {
  const schedule = await depreciationSchedule(db, year);
  const rows = schedule.rows.map((r) => [
    r.assetId,
    r.name,
    r.categoryLabel,
    r.startDate,
    r.usefulYears,
    r.cost,
    r.salvage,
    amt(r.openingAccum),
    amt(r.yearDepreciation),
    amt(r.accumulated),
    r.bookValue,
    r.status === "disposed" ? `已處分 ${r.disposedAt ?? ""}` : "使用中",
  ]);
  return {
    name: `折舊明細表_${year}.csv`,
    content: toCsv(
      ["資產編號", "名稱", "類別", "啟用日", "耐用年數", "取得成本", "殘值", "期初累計折舊", "本年度折舊", "期末累計折舊", "帳面淨值", "狀態"],
      rows,
    ),
    rows: rows.length,
  };
}

/**
 * 費用報銷明細 CSV（R12）：一列＝一筆報銷明細，含發票號碼／賣方統編／可扣抵稅額。
 * 報銷是外部記帳士最常回頭要憑證的一塊（伙食、交際、差旅都是查核重點），
 * 原本只能丟傳票 CSV（看不到發票欄位）或一張一張右鍵存圖。
 * 期間依**報銷單日期**篩（總帳的核准傳票也記在這一天）；退回（rejected）的單不列
 * （沒有帳務足跡），已作廢（0036）的照列並標「已作廢」——對帳底稿要看得到
 * 「這張單曾經核准過、後來沖掉了」，直接消失反而對不起反向傳票。
 */
export async function expenseClaimsExport(db: Db, from: string, to: string): Promise<ExportFile> {
  const categoryLabel = new Map(EXPENSE_CATEGORIES.map((cat) => [cat.accountCode, cat.label]));
  const statusLabel: Record<string, string> = { submitted: "待核准", approved: "已核准", rejected: "已退回", paid: "已付款" };
  const docTypeLabel: Record<string, string> = { einvoice: "電子發票", receipt: "收據", other: "其他" };
  const rows = (
    await db
      .select({
        claimId: schema.expenseClaims.id,
        claimDate: schema.expenseClaims.claimDate,
        employeeName: schema.employees.name,
        paidBy: schema.expenseClaims.paidBy,
        status: schema.expenseClaims.status,
        voidedAt: schema.expenseClaims.voidedAt,
        journalEntryId: schema.expenseClaims.journalEntryId,
        paidJournalEntryId: schema.expenseClaims.paidJournalEntryId,
        accountCode: schema.expenseItems.accountCode,
        description: schema.expenseItems.description,
        docType: schema.expenseItems.docType,
        invoiceNumber: schema.expenseItems.invoiceNumber,
        invoiceDate: schema.expenseItems.invoiceDate,
        sellerTaxId: schema.expenseItems.sellerTaxId,
        amount: schema.expenseItems.amount,
        tax: schema.expenseItems.tax,
        itemId: schema.expenseItems.id,
      })
      .from(schema.expenseItems)
      .innerJoin(schema.expenseClaims, eq(schema.expenseItems.claimId, schema.expenseClaims.id))
      .innerJoin(schema.employees, eq(schema.expenseClaims.employeeId, schema.employees.id))
      .where(
        and(
          gte(schema.expenseClaims.claimDate, from),
          lte(schema.expenseClaims.claimDate, to),
          ne(schema.expenseClaims.status, "rejected"),
        ),
      )
      .orderBy(asc(schema.expenseClaims.claimDate), asc(schema.expenseClaims.id), asc(schema.expenseItems.id))
  ).map((r) => [
    r.claimId,
    r.claimDate,
    r.employeeName,
    r.paidBy === "company" ? "公司支付" : "員工代墊",
    `${r.accountCode} ${categoryLabel.get(r.accountCode) ?? ""}`.trim(),
    r.description,
    docTypeLabel[r.docType] ?? r.docType,
    r.invoiceNumber ?? "",
    r.invoiceDate ?? "",
    r.sellerTaxId ?? "",
    r.amount,
    amt(r.tax),
    r.voidedAt ? "已作廢" : (statusLabel[r.status] ?? r.status),
    r.journalEntryId,
    r.paidJournalEntryId,
  ]);
  return {
    name: `費用報銷_${from}_${to}.csv`,
    content: toCsv(
      ["報銷單號", "日期", "員工", "付款方式", "分類", "說明", "憑證別", "發票號碼", "發票日期", "賣方統編", "金額", "可扣抵稅額", "狀態", "核准傳票號", "付款傳票號"],
      rows,
    ),
    rows: rows.length,
  };
}

/**
 * 進項發票：全部進貨單（未登錄發票者發票欄留空，順便盤點缺漏）。
 *
 * 期間篩選吃 coalesce(inv_date, doc_date)（R20 之後與 401 進項歸期同一條規則）：
 * 這份 CSV 是申報扣抵的核對底稿，若仍按進貨單日期篩，「發票 6/30 開、貨 7/2 到」的單
 * 會出現在 7 月的底稿、卻進 5-6 月期的 401——兩份文件對不起來，核對就失去意義。
 * 沒登發票日期的舊單退回 doc_date，與 401 的 inputDateFallback 同一個退法。
 */
export async function purchasesExport(db: Db, from: string, to: string): Promise<ExportFile> {
  // 歸期＝憑證日（發票開立日）優先、退回帳務日：401 與媒體檔都是這個口徑（services/vat.ts）
  const effectiveDate = sql<string>`coalesce(${schema.purchases.invDate}, ${schema.purchases.docDate})`;
  const purchases = await db
    .select({
      id: schema.purchases.id,
      docDate: schema.purchases.docDate,
      invDate: schema.purchases.invDate,
      partnerName: schema.partners.name,
      partnerTaxId: schema.partners.taxId,
      invTrack: schema.purchases.invTrack,
      invNo: schema.purchases.invNo,
      invFormat: schema.purchases.invFormat,
      deductionCode: schema.purchases.deductionCode,
      subtotal: schema.purchases.subtotal,
      tax: schema.purchases.tax,
      total: schema.purchases.total,
    })
    .from(schema.purchases)
    .innerJoin(schema.partners, eq(schema.purchases.partnerId, schema.partners.id))
    // 已作廢進貨單（0025）不出現在進項發票盤點：這份 CSV 是申報扣抵的核對底稿，
    // 已沖掉的單列進來會被當成可扣抵憑證再登一次
    .where(and(gte(effectiveDate, from), lte(effectiveDate, to), isNull(schema.purchases.voidedAt)))
    .orderBy(asc(effectiveDate), asc(schema.purchases.id));
  const rows = purchases.map((p) => [
    p.id,
    p.docDate,
    p.partnerName,
    p.partnerTaxId,
    p.invTrack && p.invNo ? `${p.invTrack}${p.invNo}` : "",
    // 發票日期＝401 歸期依據；空白＝未登錄（歸期以進貨單日期代），核對底稿要看得出這個退回
    p.invDate ?? "",
    p.invTrack && p.invNo ? p.invFormat : "",
    p.invTrack && p.invNo ? p.deductionCode : "",
    p.subtotal,
    p.tax,
    p.total,
  ]);
  return {
    name: `進項發票_${from}_${to}.csv`,
    content: toCsv(
      ["進貨單號", "日期", "供應商", "供應商統編", "發票號碼", "發票日期", "格式代號", "扣抵代號", "未稅金額", "稅額", "總計"],
      rows,
    ),
    rows: rows.length,
  };
}
