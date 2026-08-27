/**
 * 銷貨折讓的 G0401 折讓證明單 XML（第二批，G0401/G0501 缺口）。
 *
 * 定位：0014 的折讓單（kind='allowance'）帳務面早已完成，這裡補「對外那張證明單」。
 * 電子發票的折讓證明單由開立方自行編號（官方範例的 ALW10000003），所以折讓單上登錄的
 * cert_no 就是 AllowanceNumber、cert_date 就是 AllowanceDate——使用者補登號碼＋日期後，
 * 系統即可產出能放進 Turnkey 上傳目錄的 G0401。退回單（kind='return'）與進貨端維持
 * 原狀（證明單仍以外部工具開立、這裡只登錄號碼）：官方範例只涵蓋折讓，不猜退回的表達方式。
 *
 * 刻意即時產生、不落地快照：折讓單的金額欄位建立後沒有任何更新路徑（證明單補登只動
 * cert_no/cert_date），XML 的數字面完全可重現；會漂移的只有商品名稱、公司抬頭這類描述欄位。
 * invoices.xml 落地是因為發票的 XML 生成在「配號」這個不可重播的事件裡，折讓沒有這種事件。
 *
 * G0501 接線（0030，第三批）：折讓單有作廢入口了（void.ts voidSaleReturn）。
 * 已登錄證明單號碼＋日期的折讓單被作廢時，saleAllowanceG0501 產出作廢折讓證明單訊息——
 * 與 G0401 同樣**即時產生、不落地快照**：作廢事件的全部欄位（voided_at／void_reason／
 * cert_no／cert_date）都在單頭上，訊息完全可重現（發票的 F0501 落地是因為作廢時間由
 * 使用者輸入、不落地就丟了；折讓作廢的時間戳是系統落的 voided_at）。
 * 歸期與關帳鎖在作廢入口把關（void.ts assertReturnPeriodsOpen：cert 生效日所屬期間已關
 * → 409，比照 updateReturnCertificate 的規則——作廢會把已申報期間的 401 減項抽走）；
 * 批次匯出以 cert_date 歸期，G0501 跟著原 G0401 同一期交（與 F0501 跟著原發票同理）。
 */
import { roundHalfUp } from "@tw-erp/core";
import { B2C_BUYER_ID, buildG0401, buildG0501, type G0401Item, type Party } from "@tw-erp/einvoice";
import { schema } from "@tw-erp/db";
import { and, asc, eq } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { tr } from "../i18n.ts";

/** 賣方開立折讓：官方範例檔名「B2B存證**賣方**開立折讓」對應 AllowanceType=2 */
const SELLER_ISSUED = "2";

function ymd(isoDate: string): string {
  return isoDate.replaceAll("-", "");
}

/**
 * 明細稅額分攤：G0401 的 Tax 是逐明細欄位，但 0014 只落地單頭稅額（tax 的計算與軋平
 * 邏輯都在單頭，見 services/returns.ts 的 returnTax）。按未稅金額比例分攤、尾差調整在
 * 最後一筆——與 F0401 B2C 含稅換算（toInclusiveItems）同一套習慣，合計必等於單頭稅額。
 */
function allocateTax(amounts: number[], totalTax: number): number[] {
  const subtotal = amounts.reduce((s, n) => s + n, 0);
  if (subtotal === 0) return amounts.map(() => 0);
  const taxes = amounts.map((a) => roundHalfUp((totalTax * a) / subtotal));
  taxes[taxes.length - 1]! += totalTax - taxes.reduce((s, n) => s + n, 0);
  return taxes;
}

/**
 * 產出一張折讓單的 G0401。丟 AppError 的每一條都是「為什麼產不出來＋下一步做什麼」，
 * 批次匯出把同樣的訊息轉成出聲清單（見 saleAllowanceXmlBatch）。
 */
export async function saleAllowanceG0401(db: Db, returnId: number): Promise<{ fileName: string; xml: string }> {
  const [doc] = await db.select().from(schema.salesReturns).where(eq(schema.salesReturns.id, returnId));
  if (!doc) throw new AppError(404, "銷貨退回／折讓單不存在: {id}", { id: returnId });
  if (doc.kind !== "allowance") {
    throw new AppError(
      422,
      "折讓單 #{id} 是退回單，不是折讓單。G0401 目前只支援折讓（官方範例僅涵蓋折讓的表達方式）；退回的證明單請以財政部軟體或加值中心平台開立後，回到銷貨頁補登號碼",
      { id: returnId },
    );
  }
  if (!doc.certNo || !doc.certDate) {
    throw new AppError(
      422,
      "折讓單 #{id} 還沒登錄證明單號碼{missing}，產不出 G0401。號碼由貴公司自行編定（即 XML 的 AllowanceNumber）、日期是折讓證明單的開立日；請到銷貨頁的「退貨／折讓紀錄」補登後再下載",
      { id: returnId, missing: doc.certNo ? "的日期" : "與日期" },
    );
  }
  // 號碼會進 XML 的 AllowanceNumber 與下載檔名（G0401-<號碼>.xml），限英數與 - _ ：
  // 空白、斜線或全形字元的號碼放進檔名與上傳訊息都會出事，這裡先擋並指路
  if (!/^[A-Za-z0-9_-]+$/.test(doc.certNo)) {
    throw new AppError(
      422,
      "折讓單 #{id} 的證明單號碼「{certNo}」含有英數、連字號、底線以外的字元，不能作為 G0401 的 AllowanceNumber 與檔名。請修改號碼後再下載",
      { id: returnId, certNo: doc.certNo },
    );
  }

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.saleId, doc.saleId), eq(schema.invoices.status, "issued")));
  if (!invoice) {
    throw new AppError(
      422,
      "折讓單 #{id} 的原銷貨單 #{saleId} 沒有已開立的電子發票，產不出 G0401（折讓證明單的明細必須指回原發票號碼）。原銷貨若是紙本或免開發票的交易，證明單請以財政部軟體開立；發票被作廢過的請先重新開立",
      { id: returnId, saleId: doc.saleId },
    );
  }

  const [company] = await db.select().from(schema.companyProfile);
  if (!company) throw new AppError(422, "公司基本檔未設定（PUT /company-profile）");
  const [partner] = await db.select().from(schema.partners).where(eq(schema.partners.id, doc.partnerId));

  const seller: Party = {
    identifier: company.taxId,
    name: company.name,
    address: company.address ?? undefined,
    personInCharge: company.personInCharge ?? undefined,
    telephoneNumber: company.telephone ?? undefined,
    emailAddress: company.email ?? undefined,
  };
  // 買方統編與名稱取**發票上的快照**（invoices.buyer_tax_id/buyer_name）而不是交易對象主檔：
  // 折讓證明單指回那張發票，兩份文件的買方必須一致；聯絡欄位（主檔）與 F0401 開立同一來源
  const buyer: Party = {
    identifier: invoice.mode === "B2B" ? invoice.buyerTaxId! : B2C_BUYER_ID,
    name: invoice.buyerName,
    address: partner?.address ?? undefined,
    emailAddress: partner?.email ?? undefined,
  };

  // 原發票明細序號：F0401 開立時 SequenceNumber 依明細查詢順序編 001、002…（insert 順序＝id 序），
  // 這裡以同一個順序還原各 sale_line 在原發票上的序號
  const saleLines = await db
    .select({ id: schema.saleLines.id })
    .from(schema.saleLines)
    .where(eq(schema.saleLines.saleId, doc.saleId))
    .orderBy(asc(schema.saleLines.id));
  const seqOf = new Map(saleLines.map((l, i) => [l.id, String(i + 1).padStart(3, "0")]));

  const lines = await db
    .select({
      saleLineId: schema.saleReturnLines.saleLineId,
      amount: schema.saleReturnLines.amount,
      productName: schema.products.name,
    })
    .from(schema.saleReturnLines)
    .innerJoin(schema.products, eq(schema.saleReturnLines.productId, schema.products.id))
    .where(eq(schema.saleReturnLines.returnId, returnId))
    .orderBy(asc(schema.saleReturnLines.id));
  const taxes = allocateTax(lines.map((l) => l.amount), doc.tax);

  const items: G0401Item[] = lines.map((l, i) => ({
    originalInvoiceDate: ymd(invoice.invoiceDate),
    originalInvoiceNumber: invoice.invoiceNumber,
    originalSequenceNumber: seqOf.get(l.saleLineId) ?? "001",
    originalDescription: l.productName,
    // 本系統的折讓是「金額折讓」（0014：qty 恆為 0、貨沒退）。官方兩份範例分別是
    // 單價折讓（100×2=200）與整筆折讓（1×20 對 Amount 19），可見不強制數量×單價=金額；
    // 這裡以「1 × 折讓額」表達一筆金額折讓，不虛構貨物數量。
    // 最終以驗測環境上傳驗證為準（與 F0401 零稅率同一個處理慣例）。
    quantity: 1,
    unitPrice: l.amount,
    amount: l.amount, // 未稅：0014 的折讓明細金額本來就是未稅，與 G0401 官方範例同口徑
    tax: taxes[i]!,
    // 課稅別取發票上的快照：零稅率（'2'）的折讓明細也要標 2、稅額為 0
    taxType: invoice.taxType,
  }));

  const xml = buildG0401({
    allowanceNumber: doc.certNo,
    allowanceDate: ymd(doc.certDate),
    seller,
    buyer,
    allowanceType: SELLER_ISSUED,
    items,
    amount: { taxAmount: doc.tax, totalAmount: doc.subtotal },
  });
  return { fileName: `G0401-${doc.certNo}.xml`, xml };
}

/**
 * 產出一張**已作廢**折讓單的 G0501 作廢折讓證明單（0030）。
 * 買賣方統編與 G0401 同一來源（發票快照＋公司基本檔）：兩份訊息指的是同一張證明單，
 * 統編對不上大平台會拒收。作廢時間取 voided_at 換算台北時區（台灣無日光節約，+8 固定），
 * 同一張單每次下載的訊息逐字元相同。
 */
export async function saleAllowanceG0501(db: Db, returnId: number): Promise<{ fileName: string; xml: string }> {
  const [doc] = await db.select().from(schema.salesReturns).where(eq(schema.salesReturns.id, returnId));
  if (!doc) throw new AppError(404, "銷貨退回／折讓單不存在: {id}", { id: returnId });
  if (doc.kind !== "allowance") {
    throw new AppError(
      422,
      "#{id} 是退回單，不是折讓單。G0501 只作廢本系統產出的 G0401 折讓證明單；退回的證明單是以外部工具開立的，其作廢也請在原開立工具處理",
      { id: returnId },
    );
  }
  if (!doc.voidedAt) {
    throw new AppError(
      422,
      "折讓單 #{id} 尚未作廢，沒有作廢訊息可產。G0501 是「作廢折讓證明單」的對外訊息，請先在銷貨頁作廢這張折讓單",
      { id: returnId },
    );
  }
  if (!doc.certNo || !doc.certDate) {
    throw new AppError(
      422,
      "折讓單 #{id} 作廢前沒有登錄過證明單號碼與日期，表示從未產出 G0401——沒有開立訊息就沒有要作廢的對外訊息，帳務面的作廢已經完成，不需要 G0501",
      { id: returnId },
    );
  }
  if (!doc.voidReason) {
    throw new AppError(422, "折讓單 #{id} 沒有記錄作廢理由（資料異常，請聯絡管理者）——G0501 的 CancelReason 必填", { id: returnId });
  }

  // 買方統編取原發票快照：G0401 開立時就是這個來源，作廢訊息必須指同一個買方。
  // 發票若在折讓作廢後才被作廢（僅作廢、不沖銷的路徑），快照仍在，優先取 issued、否則取最後一張
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.saleId, doc.saleId))
    .orderBy(asc(schema.invoices.id));
  const invoice = invoices.find((i) => i.status === "issued") ?? invoices[invoices.length - 1];
  if (!invoice) {
    throw new AppError(
      422,
      "折讓單 #{id} 的原銷貨單 #{saleId} 沒有任何電子發票紀錄，取不到買方統編，產不出 G0501（這張折讓的證明單若是以外部工具開立的，其作廢也請在原開立工具處理）",
      { id: returnId, saleId: doc.saleId },
    );
  }
  const [company] = await db.select().from(schema.companyProfile);
  if (!company) throw new AppError(422, "公司基本檔未設定（PUT /company-profile）");

  // 台北時區（UTC+8 固定）：作廢日期與時間都從 voided_at 推，訊息可重現
  const tw = new Date(doc.voidedAt.getTime() + 8 * 3_600_000);
  const xml = buildG0501({
    cancelAllowanceNumber: doc.certNo,
    allowanceType: SELLER_ISSUED,
    allowanceDate: ymd(doc.certDate),
    buyerId: invoice.mode === "B2B" ? invoice.buyerTaxId! : B2C_BUYER_ID,
    sellerId: company.taxId,
    cancelDate: ymd(tw.toISOString().slice(0, 10)),
    cancelTime: tw.toISOString().slice(11, 19),
    cancelReason: doc.voidReason,
  });
  return { fileName: `G0501-${doc.certNo}.xml`, xml };
}

/**
 * 批次匯出用：期間內銷貨折讓單的 G0401 ＋已作廢者的 G0501 ＋「該產卻產不出」的出聲清單。
 *
 * 歸期依**證明單日期**（cert_date）：401 的退回折讓減項就是以證明單日期歸期
 * （見 updateReturnCertificate），XML 要跟著同一期交。還沒登錄號碼／日期的折讓單
 * 沒有歸期可言，以折讓日（doc_date）落在期間內者出聲——這批單正是「申報時少一筆
 * 減項依據」的高風險名單，靜默跳過等於幫使用者漏交。
 *
 * 已作廢折讓單（0030）：G0401 照樣匯出（大平台要先收到開立訊息才收得了作廢訊息，
 * 與 F0401/F0501 同一條規則）並加上 G0501；作廢時的關帳鎖保證 cert 歸期尚未申報，
 * 兩份訊息會落在同一期的匯出包。沒登錄過證明單就作廢的折讓單，從未有過對外訊息，
 * 既不產出也不出聲（缺證明單的追討清單只追還活著的單）。
 */
export async function saleAllowanceXmlBatch(db: Db, from: string, to: string) {
  const docs = await db
    .select()
    .from(schema.salesReturns)
    .where(eq(schema.salesReturns.kind, "allowance"))
    .orderBy(asc(schema.salesReturns.certDate), asc(schema.salesReturns.id));
  const files: { name: string; content: string }[] = [];
  const notes: string[] = [];
  let allowanceCount = 0;
  let allowanceCancelCount = 0;
  for (const doc of docs) {
    if (doc.certNo && doc.certDate) {
      if (doc.certDate < from || doc.certDate > to) continue;
      try {
        const { fileName, xml } = await saleAllowanceG0401(db, doc.id);
        files.push({ name: fileName, content: xml });
        allowanceCount += 1;
      } catch (e) {
        // 單張產不出（原發票已作廢、號碼字元不合法…）不炸整批：訊息本身已含下一步
        if (!(e instanceof AppError)) throw e;
        notes.push(tr(e.key, e.params));
      }
      if (doc.voidedAt) {
        try {
          const { fileName, xml } = await saleAllowanceG0501(db, doc.id);
          files.push({ name: fileName, content: xml });
          allowanceCancelCount += 1;
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          notes.push(tr(e.key, e.params));
        }
      }
    } else if (!doc.voidedAt && doc.docDate >= from && doc.docDate <= to) {
      notes.push(
        tr("折讓單 #{id}（原銷貨單 #{saleId}、折讓日 {docDate}）還沒登錄證明單{what}，這次沒有產出 G0401。請到銷貨頁的「退貨／折讓紀錄」補登後重新匯出", {
          id: doc.id,
          saleId: doc.saleId,
          docDate: doc.docDate,
          what: doc.certNo ? tr("日期") : tr("號碼與日期"),
        }),
      );
    }
  }
  return { files, allowanceCount, allowanceCancelCount, notes };
}
