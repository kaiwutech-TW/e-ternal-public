/**
 * 銷貨退回／折讓、進貨退出／折讓（帳務面）。規格書：docs/specs/posting-rules.md
 *
 * 設計要點（完整理由見 migration 0014 與 packages/core/src/posting.ts 的註解）：
 * - 獨立正數單據，明細必須指向原單明細；原單金額不變、不設 reversal_entry_id。
 * - 成本一律以「原單成本按數量比例攤」為基準：銷貨退回回補原銷貨成本，進貨退出沖回原進貨成本。
 *   退回＝撤銷原單的一部分，不追溯改寫另一端已完成的交易。唯一例外是進貨退出把庫存退光時，
 *   殘值必須清掉（否則留下「0 個卻有帳面金額」汙染下一次進貨的均價）。理由見 core/src/returns.ts。
 * - 上限分兩個池子：退回受「累計退回數量 ≤ 原數量」約束，折讓受「累計折讓 ≤ 原金額 − 已退回金額」
 *   約束。共用一個池子會讓「先退部分貨、再給折讓」之後剩下的貨永久退不回來（庫存從此錯到底）。
 * - 對方科目自動拆分（沖應收／掛其他應付／退現金），使用者不必在會計科目上做選擇題。
 * - 一律以退貨當期記帳：assertPeriodOpen 看的是退貨日，6 月已關帳就記 7 月，原單永不回頭修改。
 *
 * 本批不做（誠實記錄，見 docs/specs/vat-401-403.md「退回折讓的已知落差」）：
 * 401 申報書的退回折讓減項欄位、媒體檔的證明單明細記錄、G0401/G0501 電子折讓證明單 XML 與傳輸。
 */
import {
  allowanceInvCredit,
  calcTax,
  cogsFor,
  movingAvgUnitCost,
  prorateByQty,
  purchaseReturnEntryLines,
  saleReturnEntryLines,
  type EntryLine,
} from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { allocatedByTarget, partnerBalanceMaps } from "./balances.ts";
import { assertNotFarFuture } from "./dates.ts";
import { lockProducts, onHand } from "./documents.ts";
import { assertPeriodOpen } from "./period.ts";
import { rateFromSnapshot } from "./tax-parameters.ts";

/**
 * 某商品在「某張進貨單的入庫異動」之後出庫了多少數量（FIFO 消耗推定）。
 *
 * 移動平均法下帳上不追蹤批次，沒有欄位能回答「這張進貨明細的貨還剩幾個」。
 * inventory_movements.id 是遞增序號，所以「該筆入庫之後的所有出庫」就是可得的最佳近似：
 * 進貨折讓要據此判斷折讓該攤給存貨還是已售成本（見 core 的 allowanceInvCredit）。
 * 同一張進貨單同商品有多筆明細時取最小的入庫 id，寧可算多一點消耗（折讓偏向回沖銷貨成本），
 * 也不要把折讓攤到早就賣掉的貨上讓均價變 0。
 */
async function consumedSince(db: Db, productId: number, purchaseId: number): Promise<number> {
  const inbound = await db
    .select({ id: schema.inventoryMovements.id })
    .from(schema.inventoryMovements)
    .where(
      and(
        eq(schema.inventoryMovements.productId, productId),
        eq(schema.inventoryMovements.sourceType, "purchase"),
        eq(schema.inventoryMovements.sourceId, purchaseId),
        eq(schema.inventoryMovements.direction, "in"),
      ),
    )
    .orderBy(asc(schema.inventoryMovements.id))
    .limit(1);
  if (!inbound.length) return 0; // 找不到入庫異動（理論上不會）→ 當成完全未消耗，折讓全攤存貨
  const outs = await db
    .select({ qty: schema.inventoryMovements.qty })
    .from(schema.inventoryMovements)
    .where(
      and(
        eq(schema.inventoryMovements.productId, productId),
        eq(schema.inventoryMovements.direction, "out"),
        gt(schema.inventoryMovements.id, inbound[0]!.id),
      ),
    );
  return outs.reduce((s, m) => s + Number(m.qty), 0);
}

export interface ReturnLineInput {
  /** 原銷貨／進貨明細 id：單價、成本與累計上限全部以它為基準 */
  sourceLineId: number;
  /** 退回數量（kind='return' 必填且為正） */
  qty?: number | undefined;
  /** 折讓金額（kind='allowance' 必填且為正；未稅） */
  amount?: number | undefined;
}

export interface ReturnInput {
  kind: "return" | "allowance";
  docDate: string;
  certDate?: string | undefined;
  certNo?: string | undefined;
  memo?: string | undefined;
  /** 'cash' = 當場退現（需 cashAccountId）；未指定時未沖到應收的餘額掛其他應付／其他應收 */
  settlement?: "auto" | "cash" | undefined;
  cashAccountId?: number | undefined;
  lines: ReturnLineInput[];
}

async function accountIdByCode(db: Db): Promise<Map<string, number>> {
  const rows = await db.select().from(schema.accounts);
  return new Map(rows.map((r) => [r.code, r.id]));
}

async function insertEntry(
  db: Db,
  entryDate: string,
  memo: string,
  sourceType: "sale_return" | "purchase_return",
  sourceId: number,
  lines: EntryLine[],
): Promise<number> {
  const codeToId = await accountIdByCode(db);
  const [entry] = await db
    .insert(schema.journalEntries)
    .values({ entryDate, memo, sourceType, sourceId })
    .returning();
  await db.insert(schema.journalLines).values(
    lines.map((l) => {
      const accountId = codeToId.get(l.accountCode);
      if (!accountId) throw new AppError(500, `科目未初始化: ${l.accountCode}`);
      return { entryId: entry!.id, accountId, debit: l.debit, credit: l.credit };
    }),
  );
  return entry!.id;
}

/**
 * 退現用的現金科目：與收付款單同一條規則。
 * 必須是 is_cash 的科目而不只是資產類——記到非現金資產會讓這筆錢出現在資產負債表，
 * 卻從現金流量表與儀表板現金水位整筆消失，兩張表對不起來且毫無徵兆。
 */
async function requireCashAccount(db: Db, accountId: number) {
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
  if (!account) throw new AppError(404, `科目不存在: ${accountId}`);
  if (!account.isCash) {
    throw new AppError(
      422,
      `${account.code} ${account.name} 不是現金科目，不能當退款科目` +
        `（若這是銀行帳戶，請到「會計科目」頁把它勾選為現金科目）`,
    );
  }
  if (!account.active) throw new AppError(400, `科目已停用，不可再過帳: ${account.code} ${account.name}`);
  return account;
}

/**
 * 明細層的累計已退。退回與折讓分開記兩個池子（blocker：原本合併成一個 amount 池）：
 * 「10 個 1000 元、先退 5 個（攤 500）、再折讓 400」之後合併池只剩 100，剩下那 5 個貨真的
 * 退回來時會被 422 永久擋死——貨已經在倉庫裡了，庫存與銷貨成本從此錯到底，而且 returnable
 * 一邊說「還可退 5 個」一邊拒收，使用者無法歸因也無路可走。
 * 退回的上限是數量（≤ 原數量），折讓的上限是金額（≤ 原金額 − 已退回金額）。
 */
interface PriorLine {
  qty: number; // 累計退回數量
  returnAmount: number; // 退回單按比例攤到的金額
  allowanceAmount: number; // 折讓金額
  cost: number; // 累計退回成本（僅銷貨端）
}

function emptyPrior(): PriorLine {
  return { qty: 0, returnAmount: 0, allowanceAmount: 0, cost: 0 };
}

/**
 * 各原銷貨明細的累計已退量／已退額／已折讓額／已退成本。
 * 已作廢的退回折讓單（0030）不計：它的迴轉效果已被反向傳票收回，
 * 額度池要跟著回復——否則作廢後那批貨永遠退不回來、折讓額度也永遠回不來。
 */
async function priorSaleReturns(db: Db, saleId: number) {
  const rows = await db
    .select({
      saleLineId: schema.saleReturnLines.saleLineId,
      kind: schema.salesReturns.kind,
      qty: schema.saleReturnLines.qty,
      amount: schema.saleReturnLines.amount,
      cost: schema.saleReturnLines.cost,
    })
    .from(schema.saleReturnLines)
    .innerJoin(schema.salesReturns, eq(schema.saleReturnLines.returnId, schema.salesReturns.id))
    .where(and(eq(schema.salesReturns.saleId, saleId), isNull(schema.salesReturns.voidedAt)));

  const byLine = new Map<number, PriorLine>();
  let net = 0;
  for (const r of rows) {
    const prev = byLine.get(r.saleLineId) ?? emptyPrior();
    prev.qty += Number(r.qty);
    if (r.kind === "allowance") prev.allowanceAmount += r.amount;
    else prev.returnAmount += r.amount;
    prev.cost += r.cost;
    byLine.set(r.saleLineId, prev);
    net += r.amount;
  }
  // 單頭欄位（稅、沖應收）不能跟著明細列加總，會依明細筆數重複計算
  const heads = await db
    .select({ tax: schema.salesReturns.tax, arOffset: schema.salesReturns.arOffset })
    .from(schema.salesReturns)
    .where(and(eq(schema.salesReturns.saleId, saleId), isNull(schema.salesReturns.voidedAt)));
  return {
    byLine,
    net,
    tax: heads.reduce((s, h) => s + h.tax, 0),
    arOffset: heads.reduce((s, h) => s + h.arOffset, 0),
  };
}

async function priorPurchaseReturns(db: Db, purchaseId: number) {
  const rows = await db
    .select({
      purchaseLineId: schema.purchaseReturnLines.purchaseLineId,
      kind: schema.purchaseReturns.kind,
      qty: schema.purchaseReturnLines.qty,
      amount: schema.purchaseReturnLines.amount,
    })
    .from(schema.purchaseReturnLines)
    .innerJoin(schema.purchaseReturns, eq(schema.purchaseReturnLines.returnId, schema.purchaseReturns.id))
    .where(and(eq(schema.purchaseReturns.purchaseId, purchaseId), isNull(schema.purchaseReturns.voidedAt)));

  const byLine = new Map<number, PriorLine>();
  let net = 0;
  for (const r of rows) {
    const prev = byLine.get(r.purchaseLineId) ?? emptyPrior();
    prev.qty += Number(r.qty);
    if (r.kind === "allowance") prev.allowanceAmount += r.amount;
    else prev.returnAmount += r.amount;
    byLine.set(r.purchaseLineId, prev);
    net += r.amount;
  }
  const heads = await db
    .select({ tax: schema.purchaseReturns.tax, apOffset: schema.purchaseReturns.apOffset })
    .from(schema.purchaseReturns)
    .where(and(eq(schema.purchaseReturns.purchaseId, purchaseId), isNull(schema.purchaseReturns.voidedAt)));
  return {
    byLine,
    net,
    tax: heads.reduce((s, h) => s + h.tax, 0),
    apOffset: heads.reduce((s, h) => s + h.apOffset, 0),
  };
}

/**
 * 各銷貨單的累計沖應收金額（報表取數：原單金額 − 已退淨額）。
 *
 * asOf：只計入該日（含）之前的退回單。有基準日的報表（應收帳齡）一定要傳——
 * 不傳的話一張 8/15 的退貨會回頭改掉 7/31 的帳齡，跟同一天的資產負債表 1144 對不起來，
 * 而帳齡卡片有基準日選擇器，使用者一定會查月底。語意上該用「當下」的呼叫端（未沖單據、
 * 對象餘額）則不傳。
 */
export async function arOffsetBySale(db: Db, asOf?: string): Promise<Map<number, number>> {
  // 已作廢退回單（0030）不再沖應收：原銷貨單的未沖餘額隨作廢自動回復
  const rows = await db
    .select({ saleId: schema.salesReturns.saleId, arOffset: schema.salesReturns.arOffset })
    .from(schema.salesReturns)
    .where(
      asOf
        ? and(lte(schema.salesReturns.docDate, asOf), isNull(schema.salesReturns.voidedAt))
        : isNull(schema.salesReturns.voidedAt),
    );
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.saleId, (map.get(r.saleId) ?? 0) + r.arOffset);
  return map;
}

export async function apOffsetByPurchase(db: Db, asOf?: string): Promise<Map<number, number>> {
  const rows = await db
    .select({ purchaseId: schema.purchaseReturns.purchaseId, apOffset: schema.purchaseReturns.apOffset })
    .from(schema.purchaseReturns)
    .where(
      asOf
        ? and(lte(schema.purchaseReturns.docDate, asOf), isNull(schema.purchaseReturns.voidedAt))
        : isNull(schema.purchaseReturns.voidedAt),
    );
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.purchaseId, (map.get(r.purchaseId) ?? 0) + r.apOffset);
  return map;
}


/**
 * 該對象當下的應收餘額（單據面）：balances.ts 的 partnerBalanceMaps，與 partner-balances
 * 逐字同一份（R6 單一事實來源）。拆分沖應收上限時要壓這一道，是因為只看單張銷貨單的
 * 立沖餘額不可靠——allocations 是選填的，客戶付了錢卻沒做立沖時，那張單看起來還欠著全額。
 *
 * 修正前這裡自算一套：收付款以「全額」扣（把掛 2231/1212 的溢收溢付也當成沖應收付），
 * 也漏了期初應收付單與事後預收/預付沖用——溢付存在時退出單的 apOffset 被壓低，
 * 該沖應付的錢錯掛到其他應收（實測第三批 misc 站發現）。
 */
async function customerArBalance(db: Db, partnerId: number): Promise<number> {
  return (await partnerBalanceMaps(db, partnerId)).ar.get(partnerId) ?? 0;
}

async function supplierApBalance(db: Db, partnerId: number): Promise<number> {
  return (await partnerBalanceMaps(db, partnerId)).ap.get(partnerId) ?? 0;
}

/**
 * 單張單據已被立沖的金額。走 balances.ts 的 allocatedByTarget：已作廢收付款單的
 * 立沖不計（修正前這裡不排除作廢單，docRemaining 被已作廢的收款壓低，
 * 與 openDocuments 的 remaining 對不起來——同一種「口徑各自為政」的病）。
 */
async function allocatedTo(db: Db, targetType: "sale" | "purchase", targetId: number): Promise<number> {
  return (await allocatedByTarget(db, targetType)).get(targetId) ?? 0;
}

/**
 * 退回單本身的稅額：一般取 calcTax(未稅, 費率)，該張原單全數退畢時軋平為「原稅額 − 已退稅額」。
 *
 * ⚠️ `rate` 必須以**原單日期**解析，不是退回日。
 * 這個函式整套邏輯（`origTax - priorTax` 的上限與軋平）都在還原**原單**的稅額，
 * 用退回日的費率算，跨費率期間的退貨就會把原單稅額沖不平：
 * 原單以舊費率入帳 50，退回時以新費率算出 40，帳上永遠留著 10 元沖不掉的銷項稅
 * ——而它會混在 2288 的餘額裡，直到申報時才發現對不起來，那時已經找不出是哪一張單。
 * （帳務歸期仍以退回日為準——assertPeriodOpen 看的是 input.docDate，那是兩件事。）
 */
function returnTax(
  net: number,
  priorNet: number,
  priorTax: number,
  origSubtotal: number,
  origTax: number,
  rate: number,
): number {
  if (priorNet + net >= origSubtotal) return Math.max(0, origTax - priorTax);
  // 未全退時也不得超過剩餘稅額：subtotal=10/tax=1 這種小額單，逐筆 calcTax 會湊不回原稅額，
  // 但也絕不能反過來沖出比原本更多的銷項／進項稅
  return Math.max(0, Math.min(calcTax(net, rate), origTax - priorTax));
}

// ---------------------------------------------------------------- 銷貨退回／折讓

/**
 * 證明單欄位的合理性。本系統不產生證明單，這兩欄只是登錄外部開立的那一張。
 *
 * 只擋一件事：填了日期卻沒填號碼——那等於沒登錄到，之後追「哪些退回還缺證明單」會漏掉它。
 * 刻意**不**檢查「證明單日期不得早於退回日」：先議定折讓、貨後來才退是可能的時序，
 * 而證明單的日期規則本身尚未查證（見 docs/specs/vat-401-403.md 待確認表）。
 * 用自己編的假設去擋使用者，比不擋更糟。
 */
function assertCertFields(input: ReturnInput): void {
  if (input.certDate && !input.certNo) {
    throw new AppError(422, "填了證明單日期就要一併填號碼，否則之後查不到是哪一張");
  }
}

export async function createSaleReturn(db: Db, saleId: number, input: ReturnInput, createdBy: number) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來退回單當場擋下（早於原銷貨日的另一頭已有檢查）
    assertNotFarFuture(input.docDate, "退回／折讓日期");
    await assertPeriodOpen(tx, input.docDate);
    assertCertFields(input);
    if (input.certDate) await assertPeriodOpen(tx, input.certDate);

    // FOR UPDATE 當序列化點：PGlite 測試是單執行緒看不出併發，正式 Postgres 上兩個並行請求
    // 各自讀到「已退 0」就會退超量，而超退會造成存貨與 4109 的永久錯誤（沒有沖銷退貨單的入口）。
    // 銷貨退回的不變量（累計退回量 ≤ 原銷貨量、累計折讓 ≤ 原金額）全部落在「同一張銷貨單」上，
    // 所以鎖這一列的層級是對的；它不讀 onHand（貨是進來，不會打負庫存）。
    // 但明細仍帶 product_id，插入時外鍵會隱式對 products 取鎖——為了讓全站的取鎖順序一致
    // （避免與別條路徑的 FOR UPDATE 反向交錯成死鎖），下面驗證完明細後仍會呼叫 lockProducts。
    const [sale] = await tx.select().from(schema.sales).where(eq(schema.sales.id, saleId)).for("update");
    if (!sale) throw new AppError(404, `銷貨單不存在: ${saleId}`);
    if (sale.reversalEntryId) {
      throw new AppError(409, `銷貨單 ${saleId} 已整單沖銷（傳票 #${sale.reversalEntryId}），不可再退回`);
    }
    // 與 reverseSale 對稱的一道擋：那條路遇到已開退回單會 409（避免雙重沖銷），這條路遇到
    // 「發票已作廢且沒有重開」也必須 409——作廢已經把這張銷貨的銷項從 401 抽掉了（generate401
    // 依 invoice_date 歸期、讀當下 status），再開退回單會把同一筆銷項稅減第二次。
    const invoices = await tx
      .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber, status: schema.invoices.status })
      .from(schema.invoices)
      .where(eq(schema.invoices.saleId, saleId));
    if (invoices.length > 0 && !invoices.some((i) => i.status === "issued")) {
      const last = invoices[invoices.length - 1]!;
      throw new AppError(
        409,
        `原發票 ${last.invoiceNumber} 已作廢，這張銷貨的銷項稅已經被作廢抽掉，再開退回／折讓單會重複減一次` +
          `（若貨真的退回來了：請先對這張銷貨單重新開立發票再開退回單；若整筆交易本來就要取消，` +
          `作廢已經達到目的，不必再開退回單）`,
      );
    }
    if (input.docDate < sale.docDate) {
      throw new AppError(422, `退回日 ${input.docDate} 早於原銷貨日 ${sale.docDate}`);
    }
    if (!input.lines.length) throw new AppError(422, "至少要有一筆退回明細");

    const saleLines = await tx.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, saleId));
    const lineById = new Map(saleLines.map((l) => [l.id, l]));
    // 明細先驗證屬於本單，再依 productId 排序取商品鎖（與銷貨／進貨／進貨退出同一個順序）
    for (const l of input.lines) {
      if (!lineById.has(l.sourceLineId)) {
        throw new AppError(422, `明細 ${l.sourceLineId} 不屬於銷貨單 #${saleId}`);
      }
    }
    await lockProducts(tx, input.lines.map((l) => lineById.get(l.sourceLineId)!.productId));
    const prior = await priorSaleReturns(tx, saleId);
    // 同一張退回單重複指向同一原明細時，第二筆要看得到第一筆的效果
    const running = new Map<number, PriorLine>();
    const priorOf = (id: number) => running.get(id) ?? prior.byLine.get(id) ?? emptyPrior();

    const costed: { line: typeof saleLines[number]; qty: number; amount: number; cost: number }[] = [];
    for (const input_ of input.lines) {
      const line = lineById.get(input_.sourceLineId);
      if (!line) throw new AppError(422, `明細 ${input_.sourceLineId} 不屬於銷貨單 #${saleId}`);
      const p = priorOf(line.id);
      const origQty = Number(line.qty);

      let qty = 0;
      let amount: number;
      let cost = 0;
      if (input.kind === "return") {
        qty = input_.qty ?? 0;
        if (qty <= 0) throw new AppError(422, `退回數量須大於 0（明細 ${line.id}）`);
        if (p.qty + qty > origQty) {
          throw new AppError(
            422,
            `退回量超過原銷貨量：明細 ${line.id} 原售 ${origQty}、已退 ${p.qty}、可退 ${origQty - p.qty}，欲退 ${qty}`,
          );
        }
        // 攤的基準是「退回池」而不是退回＋折讓：折讓沒有拿走任何數量，把它算進已退金額會讓
        // 剩下的貨退回時金額被吃掉，而軋平（退到最後一個單位補足原額）也會失準
        amount = prorateByQty({
          originalAmount: line.amount,
          originalQty: origQty,
          priorQty: p.qty,
          priorAmount: p.returnAmount,
          returnQty: qty,
        });
        cost = prorateByQty({
          originalAmount: line.cost,
          originalQty: origQty,
          priorQty: p.qty,
          priorAmount: p.cost,
          returnQty: qty,
        });
        // 退款金額的總上限：退回＋折讓合計不得超過原明細金額。
        // 拆成兩個額度池是為了讓「先退部分貨、再折讓」之後剩下的貨還退得回來，
        // 但只拆池不設總上限就變成另一個 bug：先折讓 400 再把貨全退，退款會是 400 + 1000，
        // 同一筆金額被沖第二次，損益表出現負營收（銷貨端）或憑空淨利（進貨端）。
        // 額度被折讓吃光時退款為 0，但**貨還是要能退回來**——貨在倉庫裡是事實，
        // 而供應商／客戶那邊的錢已經在折讓時結清了。成本回沖走 cost 池，不受這個上限影響。
        amount = Math.min(amount, Math.max(0, line.amount - p.returnAmount - p.allowanceAmount));
      } else {
        amount = input_.amount ?? 0;
        if (!Number.isInteger(amount) || amount <= 0) {
          throw new AppError(422, `折讓金額須為正整數元（明細 ${line.id}）`);
        }
        // 折讓的上限是「原金額 − 已退回金額 − 已折讓金額」：貨已經退掉的部分不能再折讓一次，
        // 但貨退回來不受折讓額度的限制（數量歸數量、金額歸金額，兩個池子）
        const allowable = line.amount - p.returnAmount - p.allowanceAmount;
        if (amount > allowable) {
          throw new AppError(
            422,
            `折讓金額超過可折讓額度：明細 ${line.id} 原額 ${line.amount}、已退回 ${p.returnAmount}、` +
              `已折讓 ${p.allowanceAmount}，可折讓 ${Math.max(0, allowable)}，欲折讓 ${amount}`,
          );
        }
      }
      running.set(line.id, {
        qty: p.qty + qty,
        returnAmount: p.returnAmount + (input.kind === "return" ? amount : 0),
        allowanceAmount: p.allowanceAmount + (input.kind === "allowance" ? amount : 0),
        cost: p.cost + cost,
      });
      costed.push({ line, qty, amount, cost });
    }

    const subtotal = costed.reduce((s, l) => s + l.amount, 0);
    const cogs = costed.reduce((s, l) => s + l.cost, 0);
    // 費率以**原銷貨單的日期**解析（理由見 returnTax 的註解）：軋平的對象是原單的稅額
    // 用原單自己的費率快照：原單以舊費率入帳，退回時若用「今天解析到的」費率算，
    // 部分退回會沖不平，2288 留下沖不掉的殘額直到申報才發現（實測 400 只沖掉 20）
    const vat = await rateFromSnapshot(tx, sale.vatRateBp, sale.docDate);
    const tax = returnTax(subtotal, prior.net, prior.tax, sale.subtotal, sale.tax, vat.rate);
    const total = subtotal + tax;

    // 對方科目自動拆分：先沖客戶還欠的（1144），沖不掉的才是「該退給客戶的錢」
    const docRemaining = Math.max(0, sale.total - prior.arOffset - (await allocatedTo(tx, "sale", saleId)));
    const partnerAr = Math.max(0, await customerArBalance(tx, sale.partnerId));
    const arOffset = Math.min(total, docRemaining, partnerAr);
    const rest = total - arOffset;
    const cashOut = input.settlement === "cash";
    if (cashOut && !input.cashAccountId) throw new AppError(422, "當場退現需指定退款的現金科目");
    const cashAccount = cashOut && rest > 0 ? await requireCashAccount(tx, input.cashAccountId!) : null;
    const cashAmount = cashAccount ? rest : 0;
    const payableAmount = rest - cashAmount;

    const [doc] = await tx
      .insert(schema.salesReturns)
      .values({
        saleId,
        partnerId: sale.partnerId,
        kind: input.kind,
        docDate: input.docDate,
        certDate: input.certDate ?? null,
        certNo: input.certNo ?? null,
        memo: input.memo ?? "",
        subtotal,
        tax,
        total,
        cogs,
        arOffset,
        payableAmount,
        cashAccountId: cashAccount?.id ?? null,
        cashAmount,
        createdBy,
      })
      .returning();

    await tx.insert(schema.saleReturnLines).values(
      costed.map((l) => ({
        returnId: doc!.id,
        saleLineId: l.line.id,
        productId: l.line.productId,
        qty: String(l.qty),
        unitPrice: l.line.unitPrice,
        amount: l.amount,
        cost: l.cost,
      })),
    );

    // 退回才回補庫存；折讓是「貨沒退、只是少收錢」，寫 qty=0 的異動只會在庫存明細帳製造噪音列。
    // 回補用原出庫的單位成本與成本金額，等價於「那次出庫從未發生」（見 core/returns.ts）。
    // 服務項目（is_service）當初出貨就沒寫庫存異動，退回也不寫——寫了會憑空長出「運費 在庫 1 式」
    if (input.kind === "return") {
      const productRows = await tx
        .select({ id: schema.products.id, isService: schema.products.isService })
        .from(schema.products)
        .where(inArray(schema.products.id, costed.map((l) => l.line.productId)));
      const serviceIds = new Set(productRows.filter((p) => p.isService).map((p) => p.id));
      const moves = costed.filter((l) => l.qty > 0 && !serviceIds.has(l.line.productId));
      if (moves.length) {
        await tx.insert(schema.inventoryMovements).values(
          moves.map((l) => ({
            productId: l.line.productId,
            direction: "in" as const,
            qty: String(l.qty),
            unitCost: (l.qty > 0 ? l.cost / l.qty : 0).toFixed(4),
            amount: l.cost,
            sourceType: "sale_return" as const,
            sourceId: doc!.id,
            docDate: input.docDate,
          })),
        );
      }
    }

    const label = input.kind === "return" ? "銷貨退回" : "銷貨折讓";
    const entryId = await insertEntry(
      tx,
      input.docDate,
      `${label} #${doc!.id}（原銷貨單 #${saleId}）`,
      "sale_return",
      doc!.id,
      saleReturnEntryLines({
        subtotal,
        tax,
        total,
        cogs,
        arOffset,
        payableAmount,
        cashAmount,
        ...(cashAccount ? { cashAccountCode: cashAccount.code } : {}),
        restock: input.kind === "return",
      }),
    );
    await tx.update(schema.salesReturns).set({ journalEntryId: entryId }).where(eq(schema.salesReturns.id, doc!.id));
    return { ...doc!, journalEntryId: entryId, lines: costed.length, taxNotes: vat.notes };
  });
}

// ---------------------------------------------------------------- 進貨退出／折讓

export async function createPurchaseReturn(db: Db, purchaseId: number, input: ReturnInput, createdBy: number) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來退出單當場擋下（早於原進貨日的另一頭已有檢查）
    assertNotFarFuture(input.docDate, "退出／折讓日期");
    await assertPeriodOpen(tx, input.docDate);
    assertCertFields(input);
    if (input.certDate) await assertPeriodOpen(tx, input.certDate);

    const [purchase] = await tx
      .select()
      .from(schema.purchases)
      .where(eq(schema.purchases.id, purchaseId))
      .for("update");
    if (!purchase) throw new AppError(404, `進貨單不存在: ${purchaseId}`);
    // 已作廢的進貨單（0025）＝當作沒進過貨，沒有可退的東西；再退就是雙重沖銷
    if (purchase.voidedAt) {
      throw new AppError(
        409,
        `進貨單 ${purchaseId} 已作廢（理由：${purchase.voidReason ?? "未記錄"}），不可再開退出／折讓單。` +
          `作廢已經把這張進貨整筆沖掉了；若貨其實還在，請重開一張正確的進貨單`,
      );
    }
    if (input.docDate < purchase.docDate) {
      throw new AppError(422, `退出日 ${input.docDate} 早於原進貨日 ${purchase.docDate}`);
    }
    if (!input.lines.length) throw new AppError(422, "至少要有一筆退出明細");

    const purchaseLines = await tx
      .select()
      .from(schema.purchaseLines)
      .where(eq(schema.purchaseLines.purchaseId, purchaseId));
    const lineById = new Map(purchaseLines.map((l) => [l.id, l]));
    const prior = await priorPurchaseReturns(tx, purchaseId);
    const running = new Map<number, PriorLine>();
    const priorOf = (id: number) => running.get(id) ?? prior.byLine.get(id) ?? emptyPrior();

    // 先鎖商品、再讀在庫：庫存不足與均價成本兩件事都建立在 onHand 上，
    // 而 onHand 是跨單據的（見 lockProducts 的註解）。輸入明細先驗證屬於本單再取鎖，
    // 免得用別張單的明細 id 就能鎖住任意商品
    const productIds: number[] = [];
    for (const input_ of input.lines) {
      const line = lineById.get(input_.sourceLineId);
      if (!line) throw new AppError(422, `明細 ${input_.sourceLineId} 不屬於進貨單 #${purchaseId}`);
      productIds.push(line.productId);
    }
    await lockProducts(tx, productIds);

    // 在庫狀態逐商品追蹤：同一張退出單多筆同商品明細時，第二筆要看得到第一筆扣掉的量與金額
    const stock = new Map<number, { qty: number; amount: number }>();
    const stockOf = async (productId: number) => {
      const cached = stock.get(productId);
      if (cached) return cached;
      const fresh = await onHand(tx, productId);
      stock.set(productId, fresh);
      return fresh;
    };

    const costed: { line: typeof purchaseLines[number]; qty: number; amount: number; invCredit: number }[] = [];
    for (const input_ of input.lines) {
      const line = lineById.get(input_.sourceLineId);
      if (!line) throw new AppError(422, `明細 ${input_.sourceLineId} 不屬於進貨單 #${purchaseId}`);
      const p = priorOf(line.id);
      const origQty = Number(line.qty);

      let qty = 0;
      let amount: number;
      if (input.kind === "return") {
        qty = input_.qty ?? 0;
        if (qty <= 0) throw new AppError(422, `退出數量須大於 0（明細 ${line.id}）`);
        if (p.qty + qty > origQty) {
          throw new AppError(
            422,
            `退出量超過原進貨量：明細 ${line.id} 原進 ${origQty}、已退 ${p.qty}、可退 ${origQty - p.qty}，欲退 ${qty}`,
          );
        }
        amount = prorateByQty({
          originalAmount: line.amount,
          originalQty: origQty,
          priorQty: p.qty,
          priorAmount: p.returnAmount,
          returnQty: qty,
        });
        // 退款金額的總上限（與銷貨端同一條規則，理由見那裡）：退出＋折讓合計不得超過原明細金額。
        // 額度被折讓吃光時退款為 0，但貨仍然要能退出去。
        amount = Math.min(amount, Math.max(0, line.amount - p.returnAmount - p.allowanceAmount));
      } else {
        amount = input_.amount ?? 0;
        if (!Number.isInteger(amount) || amount <= 0) {
          throw new AppError(422, `折讓金額須為正整數元（明細 ${line.id}）`);
        }
        const allowable = line.amount - p.returnAmount - p.allowanceAmount;
        if (amount > allowable) {
          throw new AppError(
            422,
            `折讓金額超過可折讓額度：明細 ${line.id} 原額 ${line.amount}、已退出 ${p.returnAmount}、` +
              `已折讓 ${p.allowanceAmount}，可折讓 ${Math.max(0, allowable)}，欲折讓 ${amount}`,
          );
        }
      }

      const state = await stockOf(line.productId);
      // 數量面硬擋：讓庫存變負數之後，該商品的每一筆銷貨都會在 movingAvgUnitCost 直接 throw，
      // 而且是在一張無關的銷貨單上炸，使用者無法歸因。這道擋的脫困路徑很自然——退少一點
      if (qty > state.qty) {
        throw new AppError(409, `庫存不足: 商品 ${line.productId} 在庫 ${state.qty}，欲退出 ${qty}`);
      }
      let invCredit: number;
      if (input.kind === "return") {
        // 進貨退出＝「撤銷一部分進貨」，所以沖的是本次攤回的**原進貨成本**（＝amount），
        // 不是當下移動平均。曾經改用均價，結果是零銷貨時憑空長出損益：
        // 進 50@10 ＋ 50@2（均價 6）一件沒賣就退貴那批 50 個（退款 500），
        // 用均價沖 300、差額 200 進 5101 → 零營收卻有 200 元淨利，存貨還留著 300（實際只值 100）。
        // 差額進 5101 的前提是「那是已售商品的成本更正」——沒賣過的話這個前提就是假的。
        // 退貨不該追溯改寫已完成銷貨的成本。
        //
        // 唯一的例外是退光庫存：此時沒有存貨可以承載差額，殘值必須清掉，
        // 否則留下「0 個卻有帳面金額」——下一次進貨的均價會被它汙染到離譜
        // （實測：退光後殘 400 元，再進 10 個 @1 均價變成 41）。
        // 「退光」不能用 === 判斷：state.qty 是把 numeric 字串逐列 Number() 相加來的，
        // 公斤／米這種小數計量商品幾乎必然帶浮點誤差（0.1 + 0.2 !== 0.3），
        // 嚴格等值會讓這道專門用來擋「0 個卻有帳面金額」的保險對它們永不生效。
        // 數量的資料型別是 numeric(12,3)，所以 0.0005 的容差遠小於一個最小計量單位。
        const clearsStock = Math.abs(qty - state.qty) < 0.0005;
        const raw = clearsStock ? state.amount : amount;
        invCredit = Math.max(0, Math.min(raw, state.amount));
      } else {
        // 折讓貨不動，按「這批貨還剩幾個沒賣」的比例攤到存貨與銷貨成本
        // （FIFO 消耗推定，理由見 core 的 allowanceInvCredit）；
        // 上限壓在當下帳面金額，1301 不得為負（負的帳面會讓均價變成負數）
        invCredit = Math.min(
          allowanceInvCredit({
            allowance: amount,
            purchasedQty: origQty,
            consumedSincePurchase: await consumedSince(tx, line.productId, purchaseId),
          }),
          Math.max(0, state.amount),
        );
      }
      stock.set(line.productId, { qty: state.qty - qty, amount: state.amount - invCredit });
      running.set(line.id, {
        qty: p.qty + qty,
        returnAmount: p.returnAmount + (input.kind === "return" ? amount : 0),
        allowanceAmount: p.allowanceAmount + (input.kind === "allowance" ? amount : 0),
        cost: 0,
      });
      costed.push({ line, qty, amount, invCredit });
    }

    const subtotal = costed.reduce((s, l) => s + l.amount, 0);
    const invCredit = costed.reduce((s, l) => s + l.invCredit, 0);
    const costDiff = subtotal - invCredit;
    const vat = await rateFromSnapshot(tx, purchase.vatRateBp, purchase.docDate);
    const tax = returnTax(subtotal, prior.net, prior.tax, purchase.subtotal, purchase.tax, vat.rate);
    const total = subtotal + tax;

    const docRemaining = Math.max(
      0,
      purchase.total - prior.apOffset - (await allocatedTo(tx, "purchase", purchaseId)),
    );
    const partnerAp = Math.max(0, await supplierApBalance(tx, purchase.partnerId));
    const apOffset = Math.min(total, docRemaining, partnerAp);
    const rest = total - apOffset;
    const cashIn = input.settlement === "cash";
    if (cashIn && !input.cashAccountId) throw new AppError(422, "當場收現需指定收款的現金科目");
    const cashAccount = cashIn && rest > 0 ? await requireCashAccount(tx, input.cashAccountId!) : null;
    const cashAmount = cashAccount ? rest : 0;
    const receivableAmount = rest - cashAmount;

    const [doc] = await tx
      .insert(schema.purchaseReturns)
      .values({
        purchaseId,
        partnerId: purchase.partnerId,
        kind: input.kind,
        docDate: input.docDate,
        certDate: input.certDate ?? null,
        certNo: input.certNo ?? null,
        memo: input.memo ?? "",
        subtotal,
        tax,
        total,
        invCredit,
        costDiff,
        apOffset,
        receivableAmount,
        cashAccountId: cashAccount?.id ?? null,
        cashAmount,
        createdBy,
      })
      .returning();

    await tx.insert(schema.purchaseReturnLines).values(
      costed.map((l) => ({
        returnId: doc!.id,
        purchaseLineId: l.line.id,
        productId: l.line.productId,
        qty: String(l.qty),
        unitPrice: l.line.unitPrice,
        amount: l.amount,
        invCredit: l.invCredit,
      })),
    );

    // 進貨端的折讓也要寫庫存異動（qty=0、僅減金額）：分錄貸了 1301 而庫存明細帳沒減，
    // 總帳與存貨明細會靜默對不起來，之後每一筆銷貨成本都偏高。
    // unit_cost 記的是「實際沖掉的成本」而不是供應商原價——庫存明細帳的單位成本 × 數量必須等於
    // amount，寫原價會讓明細帳自己對不起來（折讓的 qty=0，單位成本無意義，記 0）
    const moves = costed.filter((l) => l.qty > 0 || l.invCredit > 0);
    if (moves.length) {
      await tx.insert(schema.inventoryMovements).values(
        moves.map((l) => ({
          productId: l.line.productId,
          direction: "out" as const,
          qty: String(l.qty),
          unitCost: (l.qty > 0 ? l.invCredit / l.qty : 0).toFixed(4),
          amount: l.invCredit,
          sourceType: "purchase_return" as const,
          sourceId: doc!.id,
          docDate: input.docDate,
        })),
      );
    }

    const label = input.kind === "return" ? "進貨退出" : "進貨折讓";
    const entryId = await insertEntry(
      tx,
      input.docDate,
      `${label} #${doc!.id}（原進貨單 #${purchaseId}）`,
      "purchase_return",
      doc!.id,
      purchaseReturnEntryLines({
        subtotal,
        tax,
        total,
        apOffset,
        receivableAmount,
        cashAmount,
        ...(cashAccount ? { cashAccountCode: cashAccount.code } : {}),
        invCredit,
        costDiff,
      }),
    );
    await tx
      .update(schema.purchaseReturns)
      .set({ journalEntryId: entryId })
      .where(eq(schema.purchaseReturns.id, doc!.id));
    return { ...doc!, journalEntryId: entryId, lines: costed.length, taxNotes: vat.notes };
  });
}

// ---------------------------------------------------------------- 證明單補登

/**
 * 事後補登／修改退回折讓證明單（B11b）。
 * 證明單一定是退貨入帳之後才在外面開（供應商那張更常是下個月才寄到），
 * 建單當下就要求填齊等於逼使用者留白——留白的單永遠進不了 401 減項，所以這條路必須存在。
 *
 * 關帳鎖：證明單決定 401 減項的歸期（歸期＝證明單日期，未填以退回日代）。
 * 兩個歸期都要檢查——新歸期落在已關帳月份＝往已申報期間塞減項；
 * 原本已有證明單、其舊歸期已關帳＝把已申報期間的減項抽走。兩個方向都是無聲改掉申報數字。
 */
export async function updateReturnCertificate(
  db: Db,
  side: "sale" | "purchase",
  id: number,
  input: { certNo: string; certDate?: string | undefined },
) {
  const label = side === "sale" ? "銷貨退回／折讓單" : "進貨退出／折讓單";
  const [row] =
    side === "sale"
      ? await db
          .select({
            certNo: schema.salesReturns.certNo,
            certDate: schema.salesReturns.certDate,
            docDate: schema.salesReturns.docDate,
            voidedAt: schema.salesReturns.voidedAt,
            voidReason: schema.salesReturns.voidReason,
          })
          .from(schema.salesReturns)
          .where(eq(schema.salesReturns.id, id))
      : await db
          .select({
            certNo: schema.purchaseReturns.certNo,
            certDate: schema.purchaseReturns.certDate,
            docDate: schema.purchaseReturns.docDate,
            voidedAt: schema.purchaseReturns.voidedAt,
            voidReason: schema.purchaseReturns.voidReason,
          })
          .from(schema.purchaseReturns)
          .where(eq(schema.purchaseReturns.id, id));
  if (!row) throw new AppError(404, `${label}不存在: ${id}`);
  // 已作廢的單（0030）不可再補登／修改證明單：這張單已從 401 減項與 G0401 批次排除，
  // 改它的證明單欄位不會有任何申報效果，卻會讓 G0501 作廢訊息指向一個改過的號碼
  if (row.voidedAt) {
    throw new AppError(
      409,
      `${label} #${id} 已於 ${row.voidedAt.toISOString().slice(0, 10)} 作廢` +
        `（理由：${row.voidReason ?? "未記錄"}），不可再補登或修改證明單。` +
        `這筆退回／折讓若其實有效，請重開一張新單再登錄證明單`,
    );
  }

  // 刻意不擋「證明單日期早於退回日」：與建單路徑同一條規則——先議定折讓、貨後來才退
  // 是可能的時序，證明單的日期規則本身尚未查證，用自編假設擋使用者比不擋更糟
  const newEffective = input.certDate ?? row.docDate;
  await assertPeriodOpen(db, newEffective);
  if (row.certNo) {
    const oldEffective = row.certDate ?? row.docDate;
    if (oldEffective !== newEffective) await assertPeriodOpen(db, oldEffective);
  }
  const patch = { certNo: input.certNo, certDate: input.certDate ?? null };
  const [updated] =
    side === "sale"
      ? await db.update(schema.salesReturns).set(patch).where(eq(schema.salesReturns.id, id)).returning()
      : await db.update(schema.purchaseReturns).set(patch).where(eq(schema.purchaseReturns.id, id)).returning();
  return updated!;
}

// ---------------------------------------------------------------- 查詢

/** 退回單清單（新到舊，含明細與對象名稱），供銷貨／進貨頁的「已退」欄與退回紀錄區塊 */
export async function listSaleReturns(db: Db) {
  const docs = await db.select().from(schema.salesReturns);
  const lines = await db.select().from(schema.saleReturnLines);
  const partners = await db.select().from(schema.partners);
  const nameOf = new Map(partners.map((p) => [p.id, p.name]));
  return docs
    .map((d) => ({
      ...d,
      partnerName: nameOf.get(d.partnerId) ?? `#${d.partnerId}`,
      lines: lines.filter((l) => l.returnId === d.id),
    }))
    .sort((a, b) => b.id - a.id);
}

export async function listPurchaseReturns(db: Db) {
  const docs = await db.select().from(schema.purchaseReturns);
  const lines = await db.select().from(schema.purchaseReturnLines);
  const partners = await db.select().from(schema.partners);
  const nameOf = new Map(partners.map((p) => [p.id, p.name]));
  return docs
    .map((d) => ({
      ...d,
      partnerName: nameOf.get(d.partnerId) ?? `#${d.partnerId}`,
      lines: lines.filter((l) => l.returnId === d.id),
    }))
    .sort((a, b) => b.id - a.id);
}

/**
 * 開退回單前的可退資訊：原單明細、已退量／已退額／已折讓額、還可退幾個、還可折讓多少錢。
 * 由伺服器算而不是前端自己減：累計上限的把關本來就在服務層，前端拿同一份數字才不會出現
 * 「畫面說可退 3 個、送出被 422」這種前後不一致。
 *
 * 數量與金額分兩個欄位表達（remainingQty / remainingAllowance），因為它們受不同的上限約束——
 * 合成一個「還可退多少」必然自相矛盾：折讓完之後金額額度用光了，但貨還是可以退回來。
 */
export async function saleReturnable(db: Db, saleId: number) {
  const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, saleId));
  if (!sale) throw new AppError(404, `銷貨單不存在: ${saleId}`);
  const lines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, saleId));
  const products = lines.length
    ? await db.select().from(schema.products).where(inArray(schema.products.id, lines.map((l) => l.productId)))
    : [];
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  const prior = await priorSaleReturns(db, saleId);
  return {
    saleId,
    docDate: sale.docDate,
    partnerId: sale.partnerId,
    subtotal: sale.subtotal,
    tax: sale.tax,
    total: sale.total,
    reversed: sale.reversalEntryId !== null,
    returnedNet: prior.net,
    lines: lines.map((l) => {
      const p = prior.byLine.get(l.id) ?? emptyPrior();
      return {
        id: l.id,
        productId: l.productId,
        productName: nameOf.get(l.productId) ?? `#${l.productId}`,
        qty: Number(l.qty),
        unitPrice: Number(l.unitPrice),
        amount: l.amount,
        returnedQty: p.qty,
        returnedAmount: p.returnAmount,
        allowanceAmount: p.allowanceAmount,
        remainingQty: Number(l.qty) - p.qty,
        remainingAllowance: Math.max(0, l.amount - p.returnAmount - p.allowanceAmount),
      };
    }),
  };
}

export async function purchaseReturnable(db: Db, purchaseId: number) {
  const [purchase] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  if (!purchase) throw new AppError(404, `進貨單不存在: ${purchaseId}`);
  const lines = await db
    .select()
    .from(schema.purchaseLines)
    .where(eq(schema.purchaseLines.purchaseId, purchaseId));
  const products = lines.length
    ? await db.select().from(schema.products).where(inArray(schema.products.id, lines.map((l) => l.productId)))
    : [];
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  const prior = await priorPurchaseReturns(db, purchaseId);
  const result = [];
  for (const l of lines) {
    const p = prior.byLine.get(l.id) ?? emptyPrior();
    const stock = await onHand(db, l.productId);
    result.push({
      id: l.id,
      productId: l.productId,
      productName: nameOf.get(l.productId) ?? `#${l.productId}`,
      qty: Number(l.qty),
      unitPrice: Number(l.unitPrice),
      amount: l.amount,
      returnedQty: p.qty,
      returnedAmount: p.returnAmount,
      allowanceAmount: p.allowanceAmount,
      // 可退量同時受「原進貨量 − 已退量」與「當下在庫量」兩道限制
      remainingQty: Math.max(0, Math.min(Number(l.qty) - p.qty, stock.qty)),
      remainingAllowance: Math.max(0, l.amount - p.returnAmount - p.allowanceAmount),
      onHandQty: stock.qty,
    });
  }
  return {
    purchaseId,
    docDate: purchase.docDate,
    partnerId: purchase.partnerId,
    subtotal: purchase.subtotal,
    tax: purchase.tax,
    total: purchase.total,
    // 已作廢（0025）：與 saleReturnable 的 reversed 同義——這張單已整筆沖掉，不可再退
    voided: purchase.voidedAt !== null,
    returnedNet: prior.net,
    lines: result,
  };
}
