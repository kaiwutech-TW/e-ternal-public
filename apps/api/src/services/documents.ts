import {
  calcTax,
  cogsFor,
  lineAmount,
  movingAvgUnitCost,
  purchaseEntryLines,
  saleEntryLines,
  type EntryLine,
} from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { assertNotFarFuture } from "./dates.ts";
import { assertPeriodOpen } from "./period.ts";
import { resolveVatRate } from "./tax-parameters.ts";

export interface DocLineInput {
  productId: number;
  qty: number;
  unitPrice: number;
}

export interface DocInput {
  partnerId: number;
  docDate: string; // YYYY-MM-DD
  lines: DocLineInput[];
}

/** 課稅別三欄（0028 起 sales；0032 起 quotes/orders 同形狀）——形狀檢查統一走 assertZeroTaxShape */
export interface ZeroTaxFields {
  /**
   * 課稅別（0028，B12）：'1' 應稅（預設）／'2' 零稅率／'3' 免稅。
   * '3' 目前拒收——免稅銷售＝兼營，申報要用 403，本系統未支援（收單就是引導錯報）。
   */
  taxType?: "1" | "2" | "3" | undefined;
  /** 零稅率必填：true＝經海關出口（401 代號 15）；false＝非經海關（代號 7） */
  zeroTaxViaCustoms?: boolean | undefined;
  /** 零稅率證明文件號碼（經海關＝出口報單；非經海關＝外匯證明等）。可留空事後補登；系統不驗真偽 */
  zeroTaxCertNo?: string | undefined;
}

/** 銷貨另外多一個收款到期日（可覆寫；未帶＝由客戶付款條件推出，客戶也沒約定＝NULL） */
export interface SaleInput extends DocInput, ZeroTaxFields {
  dueDate?: string | undefined;
}

/** 進貨的付款到期日（0033）：與銷貨同一條規則——逐單覆寫 > 供應商付款條件 > NULL（未約定） */
export interface PurchaseInput extends DocInput {
  dueDate?: string | undefined;
}

/**
 * 課稅別的形狀檢查（0028 訂下、0032 起報價單/訂單/銷貨單三處共用——三處各寫一份，
 * 漏改一處就會出現「訂單收得下、出貨才爆」的斷層）。回傳正規化後的 taxType。
 * - '3'（免稅）拒收不是漏做——免稅銷售＝兼營，申報要用 403（含不得扣抵比例計算），
 *   本系統只支援 401；收下這張單等於引導使用者拿 401 錯報。訊息要指出正路，不是只說不行。
 * - '2'（零稅率）必須指明經海關與否：兩者在 401 申報書落不同欄位，系統無從替使用者決定。
 * - 非零稅率不得帶零稅率欄位：帶了等於兩個欄位各說各話，401 取數無從判斷。
 */
export function assertZeroTaxShape(input: ZeroTaxFields): "1" | "2" {
  const taxType = input.taxType ?? "1";
  if (taxType === "3") {
    throw new AppError(
      422,
      "免稅銷售目前開不了單：免稅（兼營）公司申報營業稅要用 403 申報書，本系統只支援 401（專營應稅）。" +
        "請以官方申報軟體或洽記帳士處理免稅銷售，勿以本系統的應稅／零稅率單據代替",
    );
  }
  if (taxType === "2" && input.zeroTaxViaCustoms === undefined) {
    throw new AppError(
      422,
      "零稅率單據必須指明「經海關出口」或「非經海關」——兩者在 401 申報書落在不同欄位" +
        "（經海關＝出口報單；非經海關＝外匯證明等），系統無從替你決定",
    );
  }
  if (taxType !== "2" && (input.zeroTaxViaCustoms !== undefined || input.zeroTaxCertNo !== undefined)) {
    throw new AppError(422, "非零稅率單據不可帶零稅率欄位（經海關註記／證明文件號碼）——請先把課稅別選為零稅率");
  }
  return taxType;
}

/** docDate + n 天（UTC 演算，避開時區換日）；n=0 ＝當天到期（貨到付款） */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function accountIdByCode(db: Db): Promise<Map<string, number>> {
  const rows = await db.select().from(schema.accounts);
  return new Map(rows.map((r) => [r.code, r.id]));
}

async function insertEntry(
  db: Db,
  entryDate: string,
  memo: string,
  sourceType: "purchase" | "sale",
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

async function requirePartner(db: Db, id: number, role: "supplier" | "customer") {
  const [partner] = await db.select().from(schema.partners).where(eq(schema.partners.id, id));
  if (!partner) throw new AppError(404, `交易對象不存在: ${id}`);
  if (role === "supplier" && !partner.isSupplier) throw new AppError(422, `非供應商: ${partner.name}`);
  if (role === "customer" && !partner.isCustomer) throw new AppError(422, `非客戶: ${partner.name}`);
  return partner;
}

/** 回傳 id → 商品列：呼叫端要用 is_service 決定該行走不走庫存 */
async function requireProducts(db: Db, ids: number[]) {
  const rows = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) if (!byId.has(id)) throw new AppError(404, `商品不存在: ${id}`);
  return byId;
}

/** 目前庫存狀態（數量與帳面金額），依移動加權平均供銷貨成本計算 */
export async function onHand(db: Db, productId: number): Promise<{ qty: number; amount: number }> {
  const moves = await db
    .select()
    .from(schema.inventoryMovements)
    .where(eq(schema.inventoryMovements.productId, productId));
  let qty = 0;
  let amount = 0;
  for (const m of moves) {
    const sign = m.direction === "in" ? 1 : -1;
    qty += sign * Number(m.qty);
    amount += sign * m.amount;
  }
  return { qty, amount };
}

/**
 * 對本次涉及的每個商品取得排他鎖（在讀 onHand 之前）。
 *
 * 鎖的層級必須對齊不變量：進貨退出要保護的是 onHand(productId) ≥ 0，那是**跨單據**的——
 * 對 purchases 那一列下 FOR UPDATE 只序列化了「同一張進貨單」的退出，兩張不同進貨單同時退出
 * 同一商品時各自讀到「在庫還夠」，兩邊都過關，庫存被打成負數。之後該商品的每一筆銷貨都會在
 * movingAvgUnitCost 直接 throw，而且炸在一張無關的銷貨單上，使用者無法歸因、也沒有修復入口。
 *
 * **每一條會動到庫存或插入帶 product_id 明細的路徑都必須呼叫它**：銷貨、進貨、銷貨退回、進貨退出。
 * 少一條就有兩個後果——①該路徑與其他路徑並行時仍可把 onHand 打成負數（原本只有進貨退出取鎖，
 * 並行的「銷貨」與「進貨退出」照樣超賣）②插入明細時外鍵會隱式對 products 取 FOR KEY SHARE，
 * 取鎖順序是明細順序而非排序後的順序，與這裡的 FOR UPDATE 反向交錯就是真死鎖（40P01）。
 * 統一由這裡先依 productId 排序取 FOR UPDATE，後續的外鍵鎖都落在自己已持有的列上，循環等待消失。
 *
 * 鎖 products 那一列（而不是 advisory lock）是因為它是這個不變量的天然錨點，交易結束即釋放，
 * 也不必額外維護一組鎖鍵空間。依 productId 由小到大取鎖：同一交易涉及多個商品時順序一致，
 * 兩個交易才不會各持一半互相等待成死鎖。
 */
export async function lockProducts(tx: Db, productIds: number[]): Promise<void> {
  for (const id of [...new Set(productIds)].sort((a, b) => a - b)) {
    const [row] = await tx
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .for("update");
    if (!row) throw new AppError(404, `商品不存在: ${id}`);
  }
}

/**
 * 費率一律由呼叫端傳入（由 resolveVatRate 依**單據日期**解析），不留預設值：
 * 留預設等於「忘了接線也不會壞」，而那種漏接不會有任何徵兆——
 * 只會在某一天費率變動後，某幾條路徑仍算著舊費率。
 */
function computeTotals(lines: DocLineInput[], rate: number) {
  const withAmounts = lines.map((l) => ({ ...l, amount: lineAmount(l.qty, l.unitPrice) }));
  const subtotal = withAmounts.reduce((s, l) => s + l.amount, 0);
  const tax = calcTax(subtotal, rate);
  return { withAmounts, subtotal, tax, total: subtotal + tax };
}

export async function createPurchase(db: Db, input: PurchaseInput) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來單據當場擋下（過去日期不擋——補登歷史進貨是正常作業）
    assertNotFarFuture(input.docDate, "單據日期");
    await assertPeriodOpen(tx, input.docDate);
    const partner = await requirePartner(tx, input.partnerId, "supplier");
    const products = await requireProducts(tx, input.lines.map((l) => l.productId));
    // 付款到期日（0033）：逐單覆寫 > 供應商付款條件（docDate＋天數）> NULL（未約定）。
    // 與銷貨同一條規則（0022）——應付帳齡按到期日分逾期桶，到期日早於單據日一定是打錯
    const dueDate =
      input.dueDate ?? (partner.paymentTermDays != null ? addDays(input.docDate, partner.paymentTermDays) : null);
    if (dueDate && dueDate < input.docDate) {
      throw new AppError(422, `付款到期日（${dueDate}）不可早於單據日期（${input.docDate}）。留空可依供應商付款條件自動推算`);
    }
    // 服務項目不收進貨單：進貨拋轉一律借記存貨科目（purchaseEntryLines），
    // 服務費記成存貨會讓資產負債表虛胖、庫存頁多出「運費 在庫 N 式」的殭屍列。
    // 訊息要指出正路，不是只說不行
    for (const l of input.lines) {
      const p = products.get(l.productId)!;
      if (p.isService) {
        throw new AppError(
          422,
          `「${p.name}」是服務項目，不入庫存，進貨單收不了它。` +
            `外包費用（運費、委外服務）請走「費用報銷」或「傳票」頁入帳；` +
            `付給個人的委外費用請用「扣繳」頁開支出單`,
        );
      }
    }
    // 進貨不讀 onHand，但仍要取鎖：插入明細時外鍵會隱式對 products 取 FOR KEY SHARE，
    // 順序是明細順序；與別的交易排序後的 FOR UPDATE 反向交錯就是死鎖。全路徑統一取鎖順序才安全
    await lockProducts(tx, input.lines.map((l) => l.productId));
    // 以單據日期解析營業稅率：補一張上個月的單就該用上個月的費率（見 services/tax-parameters.ts）
    const vat = await resolveVatRate(tx, input.docDate);
    const { withAmounts, subtotal, tax, total } = computeTotals(input.lines, vat.rate);

    const [doc] = await tx
      .insert(schema.purchases)
      .values({ partnerId: input.partnerId, docDate: input.docDate, dueDate, subtotal, tax, total, vatRateBp: vat.rateBp })
      .returning();
    await tx.insert(schema.purchaseLines).values(
      withAmounts.map((l) => ({
        purchaseId: doc!.id,
        productId: l.productId,
        qty: String(l.qty),
        unitPrice: String(l.unitPrice),
        amount: l.amount,
      })),
    );
    await tx.insert(schema.inventoryMovements).values(
      withAmounts.map((l) => ({
        productId: l.productId,
        direction: "in" as const,
        qty: String(l.qty),
        unitCost: (l.amount / l.qty).toFixed(4),
        amount: l.amount,
        sourceType: "purchase" as const,
        sourceId: doc!.id,
        docDate: input.docDate,
      })),
    );
    const entryId = await insertEntry(
      tx,
      input.docDate,
      `進貨單 #${doc!.id}`,
      "purchase",
      doc!.id,
      purchaseEntryLines({ subtotal, tax, total }),
    );
    await tx
      .update(schema.purchases)
      .set({ journalEntryId: entryId })
      .where(eq(schema.purchases.id, doc!.id));
    // taxNotes 一路回到畫面：走了回退費率而不說，等於系統替使用者做了一個他不知道的決定
    return { ...doc!, journalEntryId: entryId, taxNotes: vat.notes };
  });
}

export async function createSale(db: Db, input: SaleInput) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來單據當場擋下（過去日期不擋——補登歷史銷貨是正常作業）
    assertNotFarFuture(input.docDate, "單據日期");
    await assertPeriodOpen(tx, input.docDate);
    // 課稅別（0028，B12）：先驗形狀再算稅（檢查內容見 assertZeroTaxShape——與報價單/訂單共用）
    const taxType = assertZeroTaxShape(input);
    const partner = await requirePartner(tx, input.partnerId, "customer");
    const products = await requireProducts(tx, input.lines.map((l) => l.productId));
    // 收款到期日：逐單覆寫 > 客戶付款條件（docDate＋天數）> NULL（未約定）。
    // 到期日早於單據日一定是打錯（貨到付款＝同一天，不會更早），當場擋下比帳齡亂掉好查
    const dueDate =
      input.dueDate ?? (partner.paymentTermDays != null ? addDays(input.docDate, partner.paymentTermDays) : null);
    if (dueDate && dueDate < input.docDate) {
      throw new AppError(422, `收款到期日（${dueDate}）不可早於單據日期（${input.docDate}）。留空可依客戶付款條件自動推算`);
    }
    // 讀 onHand 之前先取商品鎖：不取的話並行的「銷貨」與「進貨退出」會各自讀到「在庫還夠」
    // 而一起把庫存打成負數，之後該商品每一筆銷貨都在 movingAvgUnitCost 炸在無關的單據上
    await lockProducts(tx, input.lines.map((l) => l.productId));
    // 零稅率（0028）：稅額 0、費率快照記 0——不解析稅法參數（零稅率的 0% 是課稅別的事實，
    // 不是參數表的費率），也就不會帶出「找不到營業稅率設定」的回退警告。
    // 缺證明文件號碼要出聲：401 申報零稅率銷售額需有證明文件為依據，號碼通常在
    // 報關／收匯後才拿得到，所以只提醒不擋單（系統不驗證文件真偽，只登錄號碼）
    const zeroRated = taxType === "2";
    const vat = zeroRated
      ? {
          rateBp: 0,
          rate: 0,
          parameterId: null,
          fallback: false,
          notes: input.zeroTaxCertNo?.trim()
            ? []
            : [
                "零稅率單據還沒登錄證明文件號碼（經海關出口＝出口報單號碼；非經海關＝取得外匯證明文件號碼等）。" +
                  "申報零稅率銷售額需以證明文件為依據——取得號碼後請到銷貨頁該單的「補登證明文件」填入。" +
                  "系統不驗證文件內容，只登錄號碼供申報時核對。",
              ],
        }
      : await resolveVatRate(tx, input.docDate);
    const { withAmounts, subtotal, tax, total } = computeTotals(input.lines, vat.rate);

    // 逐筆計算銷貨成本（移動加權平均）；同商品多筆明細時追蹤帳上餘額。
    // 服務項目（is_service）不入庫存：跳過在庫檢查、成本 0、不寫庫存異動——
    // 這是「運費／顧問費開不了單」（B2）的解法
    const running = new Map<number, { qty: number; amount: number }>();
    const costed = [];
    for (const l of withAmounts) {
      if (products.get(l.productId)!.isService) {
        costed.push({ ...l, unitCost: 0, cost: 0, isService: true });
        continue;
      }
      const state = running.get(l.productId) ?? (await onHand(tx, l.productId));
      if (state.qty < l.qty) {
        throw new AppError(409, `庫存不足: 商品 ${l.productId} 在庫 ${state.qty}，欲售 ${l.qty}`);
      }
      const unitCost = movingAvgUnitCost(state.qty, state.amount);
      const cost = cogsFor(l.qty, unitCost);
      running.set(l.productId, { qty: state.qty - l.qty, amount: state.amount - cost });
      costed.push({ ...l, unitCost, cost, isService: false });
    }
    const cogs = costed.reduce((s, l) => s + l.cost, 0);

    const [doc] = await tx
      .insert(schema.sales)
      .values({
        partnerId: input.partnerId,
        docDate: input.docDate,
        dueDate,
        subtotal,
        tax,
        total,
        cogs,
        vatRateBp: vat.rateBp,
        taxType,
        zeroTaxViaCustoms: zeroRated ? input.zeroTaxViaCustoms! : null,
        zeroTaxCertNo: zeroRated ? input.zeroTaxCertNo?.trim() || null : null,
      })
      .returning();
    await tx.insert(schema.saleLines).values(
      costed.map((l) => ({
        saleId: doc!.id,
        productId: l.productId,
        qty: String(l.qty),
        unitPrice: String(l.unitPrice),
        amount: l.amount,
        cost: l.cost,
      })),
    );
    const stockMoves = costed.filter((l) => !l.isService);
    if (stockMoves.length) {
      await tx.insert(schema.inventoryMovements).values(
        stockMoves.map((l) => ({
          productId: l.productId,
          direction: "out" as const,
          qty: String(l.qty),
          unitCost: l.unitCost.toFixed(4),
          amount: l.cost,
          sourceType: "sale" as const,
          sourceId: doc!.id,
          docDate: input.docDate,
        })),
      );
    }
    const entryId = await insertEntry(
      tx,
      input.docDate,
      `銷貨單 #${doc!.id}`,
      "sale",
      doc!.id,
      // 零稅率收入貸 4102（與 4101 分列，401 的零稅率銷售額才取得出數）
      saleEntryLines({ subtotal, tax, total, cogs, zeroRated }),
    );
    await tx.update(schema.sales).set({ journalEntryId: entryId }).where(eq(schema.sales.id, doc!.id));
    return { ...doc!, journalEntryId: entryId, taxNotes: vat.notes };
  });
}

/**
 * 銷貨單單筆（B5）：列印出貨單／銷貨單要用的完整資料——單頭＋明細（含品名）＋客戶抬頭。
 * `GET /sales` 清單刻意維持原形狀（不回明細，清單頁不需要），單筆才展開。
 * 客戶欄位用白名單挑（不整包回 partners）：這個回應會被列印視圖原樣呈現，
 * 排除法在 partners 之後新增敏感欄位時會失敗開放（id_no 的教訓）。
 */
export async function saleDetail(db: Db, id: number) {
  const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, id));
  if (!sale) throw new AppError(404, `銷貨單不存在: ${id}`);
  const [partner] = await db.select().from(schema.partners).where(eq(schema.partners.id, sale.partnerId));
  const lines = await db
    .select({
      id: schema.saleLines.id,
      productId: schema.saleLines.productId,
      productName: schema.products.name,
      sku: schema.products.sku,
      unit: schema.products.unit,
      qty: schema.saleLines.qty,
      unitPrice: schema.saleLines.unitPrice,
      amount: schema.saleLines.amount,
    })
    .from(schema.saleLines)
    .innerJoin(schema.products, eq(schema.saleLines.productId, schema.products.id))
    .where(eq(schema.saleLines.saleId, id))
    .orderBy(schema.saleLines.id);
  return {
    ...sale,
    partnerName: partner?.name ?? `#${sale.partnerId}`,
    partner: partner
      ? {
          name: partner.name,
          taxId: partner.taxId,
          contactPerson: partner.contactPerson,
          phone: partner.phone,
          address: partner.address,
          shipToAddress: partner.shipToAddress,
        }
      : null,
    lines,
  };
}

/**
 * 補登零稅率證明文件號碼（0028，B12）：出口報單／外匯證明幾乎一定在建單之後才拿得到，
 * 建單時那一欄注定常是空的——沒有這條路，「缺證明文件 N 筆」的提醒永遠歸不了零。
 * 只登錄號碼、不驗證文件真偽；不動金額與歸期（401 的零稅率銷售額依單據日歸期），
 * 所以不套關帳鎖——補號碼不改變任何已申報的數字。
 */
export async function updateSaleZeroTaxCert(db: Db, saleId: number, input: { certNo: string }) {
  const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, saleId));
  if (!sale) throw new AppError(404, `銷貨單不存在: ${saleId}`);
  if (sale.taxType !== "2") {
    throw new AppError(422, `銷貨單 ${saleId} 不是零稅率單據（課稅別 ${sale.taxType}），沒有證明文件欄可補登`);
  }
  if (sale.voidedAt || sale.reversalEntryId) {
    throw new AppError(409, `銷貨單 ${saleId} 已作廢／沖銷，不可補登證明文件——如仍有這筆外銷，請重開一張正確的單`);
  }
  const [updated] = await db
    .update(schema.sales)
    .set({ zeroTaxCertNo: input.certNo.trim() })
    .where(eq(schema.sales.id, saleId))
    .returning();
  return updated!;
}

/**
 * 各商品在庫數量與平均成本。服務項目不入庫存，不列（列了只會永遠掛著一行 0）。
 *
 * 一次 join＋聚合查完（原本逐商品呼叫 onHand ＝ 1＋N 條查詢，商品多了以後
 * 儀表板每次載入都是整包 inventory_movements 掃 N 遍）。left join 保留零異動的商品
 * （新建還沒進過貨的商品要列出 qty 0，跟原本逐商品算的行為一致）。
 */
export async function inventoryStatus(db: Db) {
  const dir = schema.inventoryMovements.direction;
  const rows = await db
    .select({
      productId: schema.products.id,
      sku: schema.products.sku,
      name: schema.products.name,
      minStock: schema.products.minStock,
      // sum(numeric)/sum(int) 皆可能超出 driver 的 number 映射，一律以字串收再 Number()
      qty: sql<string>`coalesce(sum(case when ${dir} = 'in' then ${schema.inventoryMovements.qty} else -${schema.inventoryMovements.qty} end), 0)`,
      amount: sql<string>`coalesce(sum(case when ${dir} = 'in' then ${schema.inventoryMovements.amount} else -${schema.inventoryMovements.amount} end), 0)`,
    })
    .from(schema.products)
    .leftJoin(schema.inventoryMovements, eq(schema.inventoryMovements.productId, schema.products.id))
    .where(eq(schema.products.isService, false))
    .groupBy(schema.products.id)
    .orderBy(asc(schema.products.id));
  return rows.map((r) => {
    const qty = Number(r.qty);
    const amount = Number(r.amount);
    return {
      productId: r.productId,
      sku: r.sku,
      name: r.name,
      qty,
      amount,
      avgUnitCost: qty > 0 ? Math.round((amount / qty) * 10000) / 10000 : null,
      minStock: r.minStock,
      belowMinStock: r.minStock != null && qty < r.minStock,
    };
  });
}

/** 明細帳的來源單據標籤：sourceType × direction 反推。正向以外的方向只在作廢回沖時出現 */
function movementSourceLabel(m: { sourceType: string; sourceId: number; direction: "in" | "out" }): string {
  switch (m.sourceType) {
    case "purchase":
      return m.direction === "in" ? `進貨單 #${m.sourceId}` : `進貨單 #${m.sourceId} 作廢回沖`;
    case "sale":
      return m.direction === "out" ? `銷貨單 #${m.sourceId}` : `銷貨單 #${m.sourceId} 作廢回補`;
    case "sale_return":
      return m.direction === "in" ? `銷貨退回單 #${m.sourceId}` : `銷貨退回單 #${m.sourceId} 作廢沖出`;
    case "purchase_return":
      return m.direction === "out" ? `進貨退出單 #${m.sourceId}` : `進貨退出/折讓單 #${m.sourceId} 作廢回補`;
    case "adjustment":
      // 盤盈與盤虧本來就雙向，方向無從判斷作廢與否——標籤只指路單據，展開調整單即可見作廢標記
      return `庫存調整單 #${m.sourceId}`;
    case "opening":
      return "期初開帳";
    default:
      return `${m.sourceType} #${m.sourceId}`;
  }
}

/**
 * 庫存異動明細帳（R9，0035）：單一商品的逐筆異動＋逐筆結存（數量與帳面金額），
 * 讓移動平均的每一次變動可追——「這個月進了幾次、出了幾次」「均價為什麼變了」從此查得到。
 * - 排序：doc_date（單據日期）→ id。期間篩選也吃 doc_date：補登上個月的單要歸上個月。
 * - opening＝from 之前全部異動的淨額；rows 逐筆累計；closing 與 /inventory 的在庫必然一致
 *   （同一份 movements、全量加總）。補登舊單會改寫「當時」的結存呈現，這與明細帳的意義一致。
 * - 作廢回沖的異動照列（append-only：帳就是這樣走的），標籤標明「作廢回補／回沖」。
 */
export async function inventoryMovementLedger(
  db: Db,
  productId: number,
  from?: string | undefined,
  to?: string | undefined,
) {
  const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
  if (!product) throw new AppError(404, `商品不存在: ${productId}`);
  if (product.isService) {
    throw new AppError(422, `「${product.name}」是服務項目，不入庫存，沒有異動明細帳`);
  }
  const moves = await db
    .select()
    .from(schema.inventoryMovements)
    .where(eq(schema.inventoryMovements.productId, productId))
    .orderBy(asc(schema.inventoryMovements.docDate), asc(schema.inventoryMovements.id));

  let qty = 0;
  let amount = 0;
  const rows = [];
  let openingQty = 0;
  let openingAmount = 0;
  for (const m of moves) {
    const sign = m.direction === "in" ? 1 : -1;
    qty += sign * Number(m.qty);
    amount += sign * m.amount;
    if (from && m.docDate < from) {
      // from 之前的異動只累計進期初，不逐筆列——結存從期初接著走，連續性不斷
      openingQty = qty;
      openingAmount = amount;
      continue;
    }
    if (to && m.docDate > to) break; // 已按 docDate 排序，之後的都在範圍外
    rows.push({
      id: m.id,
      docDate: m.docDate,
      direction: m.direction,
      qty: Number(m.qty),
      unitCost: Number(m.unitCost),
      amount: m.amount,
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      sourceLabel: movementSourceLabel(m),
      balanceQty: qty,
      balanceAmount: amount,
    });
  }
  const last = rows.at(-1);
  return {
    product: { id: product.id, sku: product.sku, name: product.name, unit: product.unit },
    from: from ?? null,
    to: to ?? null,
    opening: { qty: openingQty, amount: openingAmount },
    rows,
    closing: last
      ? { qty: last.balanceQty, amount: last.balanceAmount }
      : { qty: openingQty, amount: openingAmount },
  };
}

/** 試算表：各科目借貸合計（借貸總額必相等） */
export async function trialBalance(db: Db) {
  const lines = await db
    .select({
      code: schema.accounts.code,
      name: schema.accounts.name,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id));
  const byCode = new Map<string, { code: string; name: string; debit: number; credit: number }>();
  for (const l of lines) {
    const row = byCode.get(l.code) ?? { code: l.code, name: l.name, debit: 0, credit: 0 };
    row.debit += l.debit;
    row.credit += l.credit;
    byCode.set(l.code, row);
  }
  const rows = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  return {
    rows,
    totalDebit: rows.reduce((s, r) => s + r.debit, 0),
    totalCredit: rows.reduce((s, r) => s + r.credit, 0),
  };
}
