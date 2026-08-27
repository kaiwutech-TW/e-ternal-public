import { randomInt } from "node:crypto";
import { roundHalfUp } from "@tw-erp/core";
import {
  B2C_BUYER_ID,
  buildF0401,
  buildF0501,
  periodOf,
  type F0401Input,
  type F0401Item,
  type Party,
} from "@tw-erp/einvoice";
import { schema } from "@tw-erp/db";
import { and, asc, eq, lte } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { tr } from "../i18n.ts";
import { assertDateOrder, assertNotFarFuture } from "./dates.ts";
import { assertPeriodOpen, closedThrough } from "./period.ts";
import { rateFromSnapshot } from "./tax-parameters.ts";
import { voidAssetDisposalCore, voidSaleCore } from "./void.ts";

export interface IssueInput {
  mode: "B2B" | "B2C";
  invoiceTime?: string | undefined; // HH:mm:ss；未給則取現在時間
  randomNumber?: string | undefined; // 測試用注入；未給則亂數
  carrier?: { type: string; id1: string; id2: string } | undefined;
  donateMark?: "0" | "1" | undefined;
  npoban?: string | undefined;
  printMark?: "Y" | "N" | undefined;
}

function nowTime(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Taipei" });
}

function ymd(isoDate: string): string {
  return isoDate.replaceAll("-", "");
}

async function requireCompany(db: Db) {
  const [company] = await db.select().from(schema.companyProfile);
  if (!company) throw new AppError(422, "公司基本檔未設定（PUT /company-profile）");
  return company;
}

/** 剩餘門檻（B7）：本期可開張數低於此數就在回應出聲，別讓使用者撞到 409 才知道要補區間 */
const TRACK_LOW_THRESHOLD = 20;

/** 從該期別的字軌區間取下一個號碼（交易內執行），並回報配號後全期還剩幾張可開 */
async function allocateNumber(tx: Db, period: string): Promise<{ invoiceNumber: string; remaining: number }> {
  const [track] = await tx
    .select()
    .from(schema.invoiceTracks)
    .where(and(eq(schema.invoiceTracks.period, period), lte(schema.invoiceTracks.nextNo, schema.invoiceTracks.rangeEnd)))
    .orderBy(asc(schema.invoiceTracks.id))
    .limit(1);
  if (!track) {
    throw new AppError(
      409,
      "期別 {period} 沒有可用的發票號碼（字軌尚未建立或已用完）。請至「設定」頁的「電子發票字軌區間」新增本期核准的區間後再開立",
      { period },
    );
  }
  await tx
    .update(schema.invoiceTracks)
    .set({ nextNo: track.nextNo + 1 })
    .where(eq(schema.invoiceTracks.id, track.id));
  // 剩餘算的是**整個期別**（可能有多組區間），不是這一組——警告要在最後一組快用完時才響
  const rows = await tx.select().from(schema.invoiceTracks).where(eq(schema.invoiceTracks.period, period));
  const remaining = rows.reduce((s, t) => s + Math.max(0, t.rangeEnd - t.nextNo + 1), 0);
  return { invoiceNumber: `${track.track}${String(track.nextNo).padStart(8, "0")}`, remaining };
}

/**
 * B2C 存證金額內含稅：明細以含稅金額表達。
 * 各明細含稅額 = 未稅額 ×（1＋費率）四捨五入；與發票總額的尾差調整在最後一筆
 * （見 posting-rules/einvoice 規格書未決問題）。
 *
 * 費率由呼叫端依**銷貨單日期**解析後傳入，不留預設值：這條路徑的產物是一份會送出去的 XML，
 * 用錯費率的後果不是帳上差幾塊錢，是一張已經開給客戶的發票。
 */
function toInclusiveItems(
  lines: { description: string; qty: number; unitPrice: number; amount: number }[],
  total: number,
  rate: number,
): F0401Item[] {
  const incl = lines.map((l) => roundHalfUp(l.amount * (1 + rate)));
  const drift = total - incl.reduce((s, n) => s + n, 0);
  incl[incl.length - 1]! += drift;
  return lines.map((l, i) => ({
    description: l.description,
    quantity: l.qty,
    unitPrice: Math.round((incl[i]! / l.qty) * 100) / 100,
    amount: incl[i]!,
  }));
}

/**
 * 捐贈欄位的形狀檢查（0029）：NPOBAN 的定義就是捐贈對象代碼——
 * 帶了捐贈碼卻沒標捐贈（或反過來）是兩個欄位各說各話，寫進 XML 上傳也會被大平台退。
 * 回傳正規化後的 donateMark。
 */
function assertDonateShape(input: IssueInput): "0" | "1" {
  const donateMark = input.donateMark ?? "0";
  if (donateMark === "1" && !input.npoban) {
    throw new AppError(422, "捐贈發票（donateMark=1）必須帶捐贈碼 npoban——受贈機構的愛心碼，向對方或財政部愛心碼查詢平台取得");
  }
  if (donateMark === "0" && input.npoban) {
    throw new AppError(422, "帶了捐贈碼 npoban 但 donateMark 不是 1——要捐贈請同時帶 donateMark:\"1\"，不捐贈請拿掉 npoban");
  }
  return donateMark;
}

export async function issueInvoice(db: Db, saleId: number, input: IssueInput) {
  return db.transaction(async (tx) => {
    const [sale] = await tx.select().from(schema.sales).where(eq(schema.sales.id, saleId));
    if (!sale) throw new AppError(404, "銷貨單不存在: {saleId}", { saleId });
    if (sale.reversalEntryId) throw new AppError(422, "銷貨單 {saleId} 已沖銷，不可開立發票", { saleId });
    // 僅擋 issued：作廢後可重開（同銷貨單多張 canceled ＋ 至多一張 issued）
    const [existing] = await tx
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.saleId, saleId), eq(schema.invoices.status, "issued")));
    if (existing) throw new AppError(409, "銷貨單 {saleId} 已開立發票 {invoiceNumber}", { saleId, invoiceNumber: existing.invoiceNumber });

    // 捐贈／載具的形狀檢查（0029）放在配號之前：讓 buildF0401 去炸的話是 500，
    // 而且 rollback 前已消耗一個字軌號碼
    const donateMark = assertDonateShape(input);

    // B13：作廢與開立必須是同一條規則的兩面——原本作廢有擋、開立沒擋，
    // 等於已關帳（可能已申報）期間的銷項還是能被無聲加項：401 依 invoice_date 歸期、每次即時重算，
    // 這裡一開下去，該期的銷項與稅額就變了，而申報書早已送出。
    // 發票日期寫死用銷貨單日期（下方 invoiceDate: sale.docDate），所以檢查的就是 sale.docDate。
    // 放在配號之前：被擋下的開立不該消耗字軌號碼。
    const through = await closedThrough(tx);
    if (through && sale.docDate.slice(0, 7) <= through) {
      throw new AppError(
        409,
        "銷貨單 {saleId} 的日期 {docDate} 屬於已關帳期間（帳務關至 {through}），開立發票會改掉該期間（可能已申報）的銷項數字。請改以當期日期另開一張銷貨單再開立發票，或先重開該期間並同步處理已申報的 401",
        { saleId, docDate: sale.docDate, through },
      );
    }

    const company = await requireCompany(tx);
    const [partner] = await tx.select().from(schema.partners).where(eq(schema.partners.id, sale.partnerId));
    if (!partner) throw new AppError(404, "交易對象不存在: {partnerId}", { partnerId: sale.partnerId });
    if (input.mode === "B2B" && !partner.taxId) throw new AppError(422, "B2B 發票需要買方統編: {name}", { name: partner.name });

    const rawLines = await tx
      .select({
        description: schema.products.name,
        qty: schema.saleLines.qty,
        unitPrice: schema.saleLines.unitPrice,
        amount: schema.saleLines.amount,
      })
      .from(schema.saleLines)
      .innerJoin(schema.products, eq(schema.saleLines.productId, schema.products.id))
      .where(eq(schema.saleLines.saleId, saleId));
    const lines = rawLines.map((l) => ({
      description: l.description,
      qty: Number(l.qty),
      unitPrice: Number(l.unitPrice),
      amount: l.amount,
    }));

    // 發票的費率必須是**那張銷貨單當初用的**：發票上的稅額就是 sale.tax，
    // 兩者用不同費率會讓 XML 的 taxRate 與 taxAmount 自相矛盾。
    // 原本這裡是「依銷貨單日期重新解析」——註解講對了要求，做法卻留了一條後門：
    // 參數在開單與開票之間被新增或接續過，重新解析就會拿到另一個費率，
    // 而 sale.tax 早已落地不會跟著變。改用銷貨單自己的費率快照，兩者必然一致。
    const vat = await rateFromSnapshot(tx, sale.vatRateBp, sale.docDate);
    const period = periodOf(sale.docDate);
    const { invoiceNumber, remaining } = await allocateNumber(tx, period);
    const randomNumber = input.randomNumber ?? String(randomInt(0, 10000)).padStart(4, "0");
    const printMark = input.printMark ?? (input.mode === "B2B" ? "Y" : "N");
    const seller: Party = {
      identifier: company.taxId,
      name: company.name,
      address: company.address ?? undefined,
      personInCharge: company.personInCharge ?? undefined,
      telephoneNumber: company.telephone ?? undefined,
      emailAddress: company.email ?? undefined,
    };

    const isB2B = input.mode === "B2B";
    // 課稅別（0028，B12）：'2' 零稅率——稅額 0、金額走 ZeroTaxSalesAmount（XML 語意見 f0401.ts）。
    // '3' 在 createSale 就被拒收，這裡不會遇到
    const zeroRated = sale.taxType === "2";
    // 買方的地址與 Email 從交易對象主檔帶（0022 起主檔有這些欄位）：
    // MIG F0401 的買方 Party 允許 Address／EmailAddress，之前開不出來只是因為主檔沒資料
    const buyerContact = {
      address: partner.address ?? undefined,
      emailAddress: partner.email ?? undefined,
    };
    const buyer: Party = isB2B
      ? { identifier: partner.taxId!, name: partner.name, ...buyerContact }
      : { identifier: B2C_BUYER_ID, name: partner.name, ...buyerContact };
    // 零稅率：SalesAmount（應稅銷售額）0、金額整包在 ZeroTaxSalesAmount（tax=0 時未稅＝含稅，
    // B2B/B2C 同值）；應稅維持既有的 B2B 未稅／B2C 含稅慣例
    const salesAmount = zeroRated ? 0 : isB2B ? sale.subtotal : sale.total;
    const taxAmount = isB2B && !zeroRated ? sale.tax : 0;

    const f0401: F0401Input = {
      invoiceNumber,
      invoiceDate: ymd(sale.docDate),
      invoiceTime: input.invoiceTime ?? nowTime(),
      seller,
      buyer,
      donateMark,
      ...(input.carrier ? { carrier: input.carrier } : {}),
      printMark,
      ...(input.npoban ? { npoban: input.npoban } : {}),
      randomNumber,
      // 明細的課稅別要跟單頭一致：零稅率單的每一行都標 2（零稅率的 rate=0，
      // toInclusiveItems 對 B2C 也算得出正確含稅額＝未稅額）
      items: (isB2B
        ? lines.map((l) => ({ description: l.description, quantity: l.qty, unitPrice: l.unitPrice, amount: l.amount }))
        : toInclusiveItems(lines, sale.total, vat.rate)
      ).map((item) => ({ ...item, taxType: sale.taxType })),
      amount: {
        salesAmount,
        freeTaxSalesAmount: 0,
        zeroTaxSalesAmount: zeroRated ? sale.total : 0,
        taxType: sale.taxType,
        taxRate: zeroRated ? 0 : vat.rate,
        taxAmount,
        totalAmount: sale.total,
      },
    };
    const xml = buildF0401(f0401);

    const [invoice] = await tx
      .insert(schema.invoices)
      .values({
        saleId,
        invoiceNumber,
        invoiceDate: sale.docDate,
        mode: input.mode,
        buyerTaxId: isB2B ? partner.taxId : null,
        buyerName: partner.name,
        salesAmount,
        taxAmount,
        totalAmount: sale.total,
        // B2C 的 salesAmount 依 MIG 慣例存的是含稅總額，401 得把它拆回未稅＋稅額。
        // 存下開立當時的費率，那個拆算才不會被日後新增的參數追溯改掉（實測過：50 → 175）
        vatRateBp: vat.rateBp,
        // 課稅別快照（0028）：401 媒體檔的課稅別必須是開立當時這張單的，不能事後跟著 sales 改
        taxType: sale.taxType,
        randomNumber,
        printMark,
        // 載具／捐贈碼落地（0029）：只存在 XML 裡的欄位事後查不到、篩不了。
        // carrier_id 存 CarrierId1（本系統開立時 Id1＝Id2）
        carrierType: input.carrier?.type ?? null,
        carrierId: input.carrier?.id1 ?? null,
        donateMark,
        npoban: donateMark === "1" ? input.npoban! : null,
        xml,
      })
      .returning();
    // 快用完不可靜默（B7）：搭 taxNotes 的既有出聲管道，前端九條路徑都畫得出來。
    // 撞到 409 才發現要補區間的代價是「當下這張發票開不出去」，而補區間要先拿到核准函
    const trackNotes =
      remaining < TRACK_LOW_THRESHOLD
        ? [
            tr("本期（{period}）發票號碼只剩 {remaining} 張可開，用完後將無法開立發票。請儘早至「設定」頁的「電子發票字軌區間」新增區間", { period, remaining }),
          ]
        : [];
    // 零稅率單缺證明文件號碼：開發票這條路徑也要出聲（0028）——發票開得出來，
    // 但 401 申報零稅率銷售額仍需證明文件為依據
    const zeroNotes =
      zeroRated && !sale.zeroTaxCertNo
        ? [
            tr("這張發票的銷貨單 #{saleId} 是零稅率、但還沒登錄證明文件號碼（經海關＝出口報單號碼；非經海關＝外匯證明文件號碼等）。取得後請到銷貨頁補登，申報零稅率銷售額需以證明文件為依據。", { saleId }),
          ]
        : [];
    return { ...invoice!, trackRemaining: remaining, taxNotes: [...vat.notes, ...trackNotes, ...zeroNotes] };
  });
}

export interface DisposalIssueInput extends IssueInput {
  /** 買受人（交易對象主檔）：固定資產處分的買方不在處分單上，開票時指定 */
  partnerId: number;
}

/**
 * 對固定資產處分開立發票（0034，B14(b) 尾款）。
 * 為什麼要有這條路：401 的銷項取數來源是發票清單（vat.ts），處分認列的 2288 銷項稅額
 * 不開發票就進不了 401——原本只有 taxNotes 出聲提醒，人一忘就是漏報銷項。
 *
 * 金額紀律：發票金額＝處分價款（disposal_proceeds）、稅額＝處分稅額（disposal_tax），
 * **一律取處分當時落地的數字，不重算**——重算會在費率參數變動時與已入帳的 2288 對不上。
 * 費率快照同理：優先用 disposal_vat_rate_bp（處分當時解析的），舊處分（0034 前）無快照
 * 才退回依處分日解析並出聲。發票日期＝處分日（銷項歸期跟著處分那一期）。
 *
 * 兩個入口共用（與 voidSaleCore 同一模式）：處分時勾選「開立發票」（assets.ts disposeAsset，
 * 同一交易）與事後補開／作廢重開（POST /fixed-assets/:id/invoice）。
 */
export async function issueDisposalInvoiceCore(tx: Db, assetId: number, input: DisposalIssueInput) {
  const [asset] = await tx.select().from(schema.fixedAssets).where(eq(schema.fixedAssets.id, assetId));
  if (!asset) throw new AppError(404, "資產不存在: {assetId}", { assetId });
  if (asset.voidedAt) throw new AppError(409, "資產 #{assetId}（{name}）已作廢登錄，沒有可開立發票的處分", { assetId, name: asset.name });
  if (asset.status !== "disposed" || !asset.disposedAt) {
    throw new AppError(
      422,
      "資產 #{assetId}（{name}）目前不是已處分狀態——處分發票開的是「處分」這筆銷售，請先執行處分（處分表單可同時勾選開立發票）",
      { assetId, name: asset.name },
    );
  }
  const proceeds = asset.disposalProceeds ?? 0;
  const tax = asset.disposalTax ?? 0;
  if (proceeds <= 0) {
    throw new AppError(422, "資產 #{assetId}（{name}）的處分價款為 0（報廢），沒有銷售額，不需開立發票", { assetId, name: asset.name });
  }
  if (tax <= 0) {
    throw new AppError(
      422,
      "資產 #{assetId}（{name}）的處分未計銷項稅額（處分時選了不計稅）。本系統發票模組僅支援應稅發票——確屬應稅請先作廢處分、以計稅重新處分後再開立；免稅等其他情形請以外部方式開立並自行併入申報",
      { assetId, name: asset.name },
    );
  }
  // 僅擋 issued：作廢後可重開（同一筆處分多張 canceled ＋ 至多一張 issued，DB 有 partial unique index）
  const [existing] = await tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.assetId, assetId), eq(schema.invoices.status, "issued")));
  if (existing) throw new AppError(409, "資產 #{assetId} 的處分已開立發票 {invoiceNumber}", { assetId, invoiceNumber: existing.invoiceNumber });

  const donateMark = assertDonateShape(input);

  // B13 同銷貨發票：發票日期＝處分日，落在已關帳（可能已申報）期間的開立會無聲改掉該期銷項
  const through = await closedThrough(tx);
  if (through && asset.disposedAt.slice(0, 7) <= through) {
    throw new AppError(
      409,
      "資產 #{assetId} 的處分日 {disposedAt} 屬於已關帳期間（帳務關至 {through}），開立發票會改掉該期間（可能已申報）的銷項數字。請先重開該期間並同步處理已申報的 401",
      { assetId, disposedAt: asset.disposedAt, through },
    );
  }

  const company = await requireCompany(tx);
  const [partner] = await tx.select().from(schema.partners).where(eq(schema.partners.id, input.partnerId));
  if (!partner) throw new AppError(404, "交易對象不存在: {partnerId}", { partnerId: input.partnerId });
  if (input.mode === "B2B" && !partner.taxId) throw new AppError(422, "B2B 發票需要買方統編: {name}", { name: partner.name });

  // 費率快照：處分當時解析到的（0034 落地）；舊處分無快照才退回依處分日解析並出聲
  const vat = await rateFromSnapshot(tx, asset.disposalVatRateBp, asset.disposedAt);
  const net = proceeds - tax;
  const period = periodOf(asset.disposedAt);
  const { invoiceNumber, remaining } = await allocateNumber(tx, period);
  const randomNumber = input.randomNumber ?? String(randomInt(0, 10000)).padStart(4, "0");
  const printMark = input.printMark ?? (input.mode === "B2B" ? "Y" : "N");
  const isB2B = input.mode === "B2B";
  const seller: Party = {
    identifier: company.taxId,
    name: company.name,
    address: company.address ?? undefined,
    personInCharge: company.personInCharge ?? undefined,
    telephoneNumber: company.telephone ?? undefined,
    emailAddress: company.email ?? undefined,
  };
  const buyerContact = { address: partner.address ?? undefined, emailAddress: partner.email ?? undefined };
  const buyer: Party = isB2B
    ? { identifier: partner.taxId!, name: partner.name, ...buyerContact }
    : { identifier: B2C_BUYER_ID, name: partner.name, ...buyerContact };

  // 金額慣例與銷貨發票一致：B2B 未稅＋稅額分離；B2C 明細與 SalesAmount 皆為含稅總額
  const f0401: F0401Input = {
    invoiceNumber,
    invoiceDate: ymd(asset.disposedAt),
    invoiceTime: input.invoiceTime ?? nowTime(),
    seller,
    buyer,
    donateMark,
    ...(input.carrier ? { carrier: input.carrier } : {}),
    printMark,
    ...(input.npoban ? { npoban: input.npoban } : {}),
    randomNumber,
    items: [
      {
        description: `處分固定資產：${asset.name}`,
        quantity: 1,
        unitPrice: isB2B ? net : proceeds,
        amount: isB2B ? net : proceeds,
        taxType: "1",
      },
    ],
    amount: {
      salesAmount: isB2B ? net : proceeds,
      freeTaxSalesAmount: 0,
      zeroTaxSalesAmount: 0,
      taxType: "1",
      taxRate: vat.rate,
      taxAmount: isB2B ? tax : 0,
      totalAmount: proceeds,
    },
  };
  const xml = buildF0401(f0401);

  const [invoice] = await tx
    .insert(schema.invoices)
    .values({
      assetId,
      invoiceNumber,
      invoiceDate: asset.disposedAt,
      mode: input.mode,
      buyerTaxId: isB2B ? partner.taxId : null,
      buyerName: partner.name,
      salesAmount: isB2B ? net : proceeds,
      taxAmount: isB2B ? tax : 0,
      totalAmount: proceeds,
      vatRateBp: vat.rateBp,
      taxType: "1",
      randomNumber,
      printMark,
      carrierType: input.carrier?.type ?? null,
      carrierId: input.carrier?.id1 ?? null,
      donateMark,
      npoban: donateMark === "1" ? input.npoban! : null,
      xml,
    })
    .returning();
  const trackNotes =
    remaining < TRACK_LOW_THRESHOLD
      ? [
          tr("本期（{period}）發票號碼只剩 {remaining} 張可開，用完後將無法開立發票。請儘早至「設定」頁的「電子發票字軌區間」新增區間", { period, remaining }),
        ]
      : [];
  return { ...invoice!, trackRemaining: remaining, taxNotes: [...vat.notes, ...trackNotes] };
}

/** 事後補開（處分時沒勾）／作廢重開的入口：POST /fixed-assets/:id/invoice */
export async function issueDisposalInvoice(db: Db, assetId: number, input: DisposalIssueInput) {
  return db.transaction(async (tx) => issueDisposalInvoiceCore(tx, assetId, input));
}

export async function cancelInvoice(
  db: Db,
  invoiceId: number,
  input: {
    reason: string;
    cancelDate?: string | undefined;
    cancelTime?: string | undefined;
    reverseSale?: boolean | undefined;
    /** 處分發票限定（0034）：作廢時連動沖回資產處分（反向傳票、資產回到使用中） */
    reverseDisposal?: boolean | undefined;
  },
  userId?: number,
) {
  return db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!invoice) throw new AppError(404, "發票不存在: {invoiceId}", { invoiceId });
    if (invoice.status === "canceled") throw new AppError(409, "發票已作廢: {invoiceNumber}", { invoiceNumber: invoice.invoiceNumber });
    const company = await requireCompany(tx);

    const cancelDate = input.cancelDate ?? new Date().toISOString().slice(0, 10);
    // R2：作廢日早於開立日，F0501 會帶著 CancelDate < InvoiceDate 上傳，reverseSale 的
    // 迴轉傳票更會落在原交易發生前——純 UI 操作就可能踩到（銷貨單可開在未來、作廢預設今天）
    assertDateOrder(
      { date: invoice.invoiceDate, label: tr("發票開立日期") },
      { date: cancelDate, label: tr("作廢日期") },
    );
    assertNotFarFuture(cancelDate, "作廢日期");
    // 「僅作廢」路徑原本完全沒有鎖帳檢查：作廢是就地改 invoices.status，而 401 依 invoice_date 歸期、
    // 讀的是當下 status——等於能無聲改掉已關帳（可能已申報）期間的銷項數字。
    //
    // 關鍵是**檢查發票日期所屬期間**：作廢改動的是原發票那一期的銷項數字，只檢查作廢日
    // 等於讓「7 月的發票、8 月作廢」在 7 月已關帳的情況下照樣過關——那正是要防的情境，
    // 而 UI 文案已經向使用者保證「不會無聲改掉已關帳期間的銷項數字」。
    // 兩個日期都檢查：作廢日決定 F0501 與媒體檔的作廢記錄落在哪一期。
    const through = await closedThrough(tx);
    if (through && invoice.invoiceDate.slice(0, 7) <= through) {
      // 出路依來源不同：銷貨發票有「退回／折讓以當期認列」這條路，處分發票沒有下一層單據
      const params = { invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, through };
      throw new AppError(
        409,
        invoice.saleId
          ? "發票 {invoiceNumber} 的發票日期 {invoiceDate} 屬於已關帳期間（帳務關至 {through}），作廢會改掉該期間（可能已申報）的銷項數字。若貨已退回或雙方議價，請改開「退貨／折讓」單以當期認列；確定要作廢請先重開該期間，並同步處理已申報的 401"
          : "發票 {invoiceNumber} 的發票日期 {invoiceDate} 屬於已關帳期間（帳務關至 {through}），作廢會改掉該期間（可能已申報）的銷項數字。確定要作廢請先重開該期間，並同步處理已申報的 401",
        params,
      );
    }
    await assertPeriodOpen(tx, cancelDate);
    const cancelXml = buildF0501({
      cancelInvoiceNumber: invoice.invoiceNumber,
      invoiceDate: ymd(invoice.invoiceDate),
      buyerId: invoice.mode === "B2B" ? invoice.buyerTaxId! : B2C_BUYER_ID,
      sellerId: company.taxId,
      cancelDate: ymd(cancelDate),
      cancelTime: input.cancelTime ?? nowTime(),
      cancelReason: input.reason,
    });
    const [updated] = await tx
      .update(schema.invoices)
      .set({ status: "canceled", cancelReason: input.reason, canceledAt: new Date(), cancelXml })
      .where(eq(schema.invoices.id, invoiceId))
      .returning();

    // 連動沖銷來源單據（可選）：不沖銷則帳上銷項稅額與 401 申報不一致，需作廢重開對齊。
    // - 銷貨發票（reverseSale）走 0025 的共用核心（voidSaleCore）：反向傳票＋庫存以原出庫
    //   成本退回＋訂單出貨量退回＋voided_at/void_reason 軌跡。沖銷後不得再開立發票。
    // - 處分發票（reverseDisposal，0034）走 voidAssetDisposalCore：反向傳票沖回處分損益／
    //   累折／銷項稅額，資產回到使用中。旗標與來源對不上就 422——「沖回」動的是帳，
    //   不能靠猜（帶錯旗標時靜默不沖，使用者會以為帳已沖回）。
    let reversalEntryId: number | null = null;
    if (input.reverseSale) {
      if (!invoice.saleId) {
        throw new AppError(
          422,
          "發票 {invoiceNumber} 是處分發票（資產 #{assetId}），沒有銷貨單可沖銷——要連動沖回處分請帶 reverseDisposal",
          { invoiceNumber: invoice.invoiceNumber, assetId: invoice.assetId },
        );
      }
      await assertPeriodOpen(tx, cancelDate);
      reversalEntryId = await voidSaleCore(tx, invoice.saleId, {
        entryDate: cancelDate,
        reason: `發票 ${invoice.invoiceNumber} 作廢：${input.reason}`,
        userId: userId ?? null,
      });
    }
    if (input.reverseDisposal) {
      if (!invoice.assetId) {
        throw new AppError(
          422,
          "發票 {invoiceNumber} 是銷貨發票（銷貨單 #{saleId}），沒有資產處分可沖回——要連動沖銷銷貨單請帶 reverseSale",
          { invoiceNumber: invoice.invoiceNumber, saleId: invoice.saleId },
        );
      }
      // 發票已在本交易內標為 canceled，核心不再撞「先廢發票」的守門（那道守門在獨立作廢入口）
      const voided = await voidAssetDisposalCore(
        tx,
        invoice.assetId,
        { reason: `發票 ${invoice.invoiceNumber} 作廢：${input.reason}` },
        userId ?? null,
      );
      reversalEntryId = voided.reversalEntryId;
    }
    return { ...updated!, reversalEntryId };
  });
}
