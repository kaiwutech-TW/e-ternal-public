/**
 * 庫存調整單（migration 0026，B8）：盤盈／盤虧／報廢的入口。
 *
 * 在此之前，除了「賣掉」與「退給廠商」沒有任何一條路能把庫存扣掉——過期報廢只能開
 * 手工傳票（總帳動了、庫存子帳一件未動，之後每張銷貨繼續用虛高的均價算成本）。
 *
 * 設計三原則：
 * 1. 調整量一律以**當下移動平均成本**計價：盤虧報廢按均價出庫、盤盈按均價入庫，
 *    調整後均價不變，之後的銷貨成本不受這次調整影響。唯一例外是「全數出清」——
 *    以帳面殘額出帳（不是 均價×數量 的四捨五入值），否則 0 量會掛著幾塊錢的殭屍餘額，
 *    下次進貨的均價會被它汙染。
 * 2. 自動拋轉傳票：盤盈借 1301 貸 7121 存貨盤盈；盤虧報廢借 7521 存貨盤損貸 1301。
 *    兩碼是系統科目（chart.ts ACCOUNT），這裡不另寫代號清單。
 * 3. 盤點差異由**系統**算（stocktake 收實盤量、自己對帳面量），不是使用者算——
 *    讓使用者自己算差異，算錯的方向永遠是「帳配合人」，盤點就失去了對帳的意義。
 */
import { ACCOUNT, cogsFor, movingAvgUnitCost } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { desc, eq, inArray } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { lockProducts, onHand } from "./documents.ts";
import { assertPeriodOpen } from "./period.ts";

export const REASON_LABEL: Record<"count" | "scrap" | "expiry", string> = {
  count: "盤點差異",
  scrap: "報廢",
  expiry: "過期報廢",
};

export interface AdjustmentLineInput {
  productId: number;
  /** 正數＝盤盈（帳上加）、負數＝盤虧／報廢（帳上減）；0 不收 */
  qtyDiff: number;
}

export interface AdjustmentInput {
  docDate: string; // YYYY-MM-DD
  reason: "count" | "scrap" | "expiry";
  memo?: string | undefined;
  lines: AdjustmentLineInput[];
}

interface ResolvedLine {
  productId: number;
  direction: "in" | "out";
  qty: number;
  unitCost: number;
  amount: number;
  bookQty?: number;
  countedQty?: number;
}

/**
 * 共用核心：呼叫端已開好交易並 assertPeriodOpen。
 * 這裡負責取商品鎖 → 逐品讀 onHand → 以當下均價計價 → 落地單頭／明細／庫存異動／傳票。
 */
async function createAdjustmentCore(
  tx: Db,
  input: {
    docDate: string;
    reason: "count" | "scrap" | "expiry";
    memo: string;
    userId: number;
    lines: (AdjustmentLineInput & { bookQty?: number; countedQty?: number })[];
  },
) {
  const productIds = input.lines.map((l) => l.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw new AppError(422, "同一商品在一張調整單裡只能出現一次（請把差異併成一筆）");
  }
  const products = await tx.select().from(schema.products).where(inArray(schema.products.id, productIds));
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const l of input.lines) {
    const p = byId.get(l.productId);
    if (!p) throw new AppError(404, "商品不存在: {id}", { id: l.productId });
    if (p.isService) {
      throw new AppError(422, "「{name}」是服務項目，不入庫存，沒有可盤點或報廢的數量", { name: p.name });
    }
    if (l.qtyDiff === 0) throw new AppError(422, "「{name}」的調整量為 0——沒有差異的商品請直接不列", { name: p.name });
    // 報廢／過期是「東西沒了」，只會讓庫存變少；多出來的貨是盤盈，請用盤點（count）
    if (l.qtyDiff > 0 && input.reason !== "count") {
      throw new AppError(
        422,
        "「{name}」的調整量為正數（+{qty}），但原因是{reason}——" +
          "報廢只會讓庫存變少。多出來的貨請把原因改成「盤點差異」",
        { name: p.name, qty: l.qtyDiff, reason: REASON_LABEL[input.reason] },
      );
    }
  }

  // 讀 onHand 之前先取商品鎖（全站統一取鎖順序，理由見 documents.ts 的 lockProducts）
  await lockProducts(tx, productIds);

  const resolved: ResolvedLine[] = [];
  for (const l of input.lines) {
    const p = byId.get(l.productId)!;
    const state = await onHand(tx, l.productId);
    const qty = Math.abs(l.qtyDiff);
    if (l.qtyDiff < 0) {
      if (state.qty < qty) {
        throw new AppError(
          409,
          "「{name}」在庫 {onHand}，欲調減 {qty}——帳上沒有那麼多可以扣。" +
            "若實際數量就是比帳上少，請用盤點（實盤量填實際數字），系統會算出正確的差異",
          { name: p.name, onHand: state.qty, qty },
        );
      }
      const unitCost = movingAvgUnitCost(state.qty, state.amount);
      // 全數出清＝把帳面殘額整筆出掉：均價×數量的四捨五入殘差不能留在 0 量的商品上
      const amount = state.qty === qty ? state.amount : cogsFor(qty, unitCost);
      resolved.push({ productId: l.productId, direction: "out", qty, unitCost, amount, ...pickCount(l) });
    } else {
      if (state.qty <= 0) {
        throw new AppError(
          422,
          "「{name}」帳上在庫為 {onHand}，沒有移動平均成本可以給盤盈計價。" +
            "帳上不存在的貨請先建立成本基礎：導入期用「設定」頁的庫存開帳，日常請補登進貨單",
          { name: p.name, onHand: state.qty },
        );
      }
      const unitCost = movingAvgUnitCost(state.qty, state.amount);
      const amount = cogsFor(qty, unitCost);
      resolved.push({ productId: l.productId, direction: "in", qty, unitCost, amount, ...pickCount(l) });
    }
  }

  const totalIn = resolved.filter((l) => l.direction === "in").reduce((s, l) => s + l.amount, 0);
  const totalOut = resolved.filter((l) => l.direction === "out").reduce((s, l) => s + l.amount, 0);

  const [doc] = await tx
    .insert(schema.inventoryAdjustments)
    .values({
      docDate: input.docDate,
      reason: input.reason,
      memo: input.memo,
      totalIn,
      totalOut,
      createdBy: input.userId,
    })
    .returning();
  await tx.insert(schema.inventoryAdjustmentLines).values(
    resolved.map((l) => ({
      adjustmentId: doc!.id,
      productId: l.productId,
      direction: l.direction,
      qty: String(l.qty),
      unitCost: l.unitCost.toFixed(4),
      amount: l.amount,
      bookQty: l.bookQty !== undefined ? String(l.bookQty) : null,
      countedQty: l.countedQty !== undefined ? String(l.countedQty) : null,
    })),
  );
  await tx.insert(schema.inventoryMovements).values(
    resolved.map((l) => ({
      productId: l.productId,
      direction: l.direction,
      qty: String(l.qty),
      unitCost: l.unitCost.toFixed(4),
      amount: l.amount,
      sourceType: "adjustment" as const,
      sourceId: doc!.id,
      docDate: input.docDate,
    })),
  );

  // 拋轉：盤盈借 1301 貸 7121、盤虧報廢借 7521 貸 1301。混合單（盤點有盈有虧）四行都出，
  // 刻意不軋差——盈與虧是兩群商品的事實，軋成一個淨額，月底就看不出「盤盈 3 千、盤虧 5 千」
  const accounts = await tx.select().from(schema.accounts);
  const codeToId = new Map(accounts.map((a) => [a.code, a.id]));
  const need = (code: string): number => {
    const id = codeToId.get(code);
    if (!id) throw new AppError(500, "科目未初始化: {code}", { code });
    return id;
  };
  const memo = `庫存調整單 #${doc!.id}（${REASON_LABEL[input.reason]}）${input.memo ? `：${input.memo}` : ""}`;
  const [entry] = await tx
    .insert(schema.journalEntries)
    .values({ entryDate: input.docDate, memo, sourceType: "adjustment", sourceId: doc!.id })
    .returning();
  const journalLines = [
    ...(totalIn > 0
      ? [
          { entryId: entry!.id, accountId: need(ACCOUNT.INVENTORY), debit: totalIn, credit: 0 },
          { entryId: entry!.id, accountId: need(ACCOUNT.INVENTORY_GAIN), debit: 0, credit: totalIn },
        ]
      : []),
    ...(totalOut > 0
      ? [
          { entryId: entry!.id, accountId: need(ACCOUNT.INVENTORY_LOSS), debit: totalOut, credit: 0 },
          { entryId: entry!.id, accountId: need(ACCOUNT.INVENTORY), debit: 0, credit: totalOut },
        ]
      : []),
  ];
  // totalIn 與 totalOut 可能同時為 0（例如盤盈 0.001 件四捨五入成 0 元）：0 元傳票沒有意義，
  // 但單據與庫存異動仍要留（數量確實動了）
  if (journalLines.length > 0) {
    await tx.insert(schema.journalLines).values(journalLines);
  }
  await tx
    .update(schema.inventoryAdjustments)
    .set({ journalEntryId: entry!.id })
    .where(eq(schema.inventoryAdjustments.id, doc!.id));
  return { ...doc!, journalEntryId: entry!.id, lines: resolved };
}

function pickCount(l: { bookQty?: number; countedQty?: number }) {
  return {
    ...(l.bookQty !== undefined ? { bookQty: l.bookQty } : {}),
    ...(l.countedQty !== undefined ? { countedQty: l.countedQty } : {}),
  };
}

/** 手動調整入口（報廢／過期／已知差異）：呼叫端直接給正負調整量 */
export async function createInventoryAdjustment(db: Db, input: AdjustmentInput, userId: number) {
  return db.transaction(async (tx) => {
    await assertPeriodOpen(tx, input.docDate);
    return createAdjustmentCore(tx, {
      docDate: input.docDate,
      reason: input.reason,
      memo: input.memo?.trim() ?? "",
      userId,
      lines: input.lines,
    });
  });
}

/**
 * 盤點底稿：現有品項＋帳面量（服務項目不入庫存，不列）。
 * 使用者印出來清點，空欄填實盤量後整批送 createStocktake——差異由系統算。
 */
export async function stocktakeSheet(db: Db) {
  const products = await db.select().from(schema.products).orderBy(schema.products.id);
  const rows = [];
  for (const p of products) {
    if (p.isService) continue;
    const { qty } = await onHand(db, p.id);
    rows.push({ productId: p.id, sku: p.sku, name: p.name, unit: p.unit, bookQty: qty });
  }
  return rows;
}

export interface StocktakeInput {
  docDate: string;
  memo?: string | undefined;
  lines: { productId: number; countedQty: number }[]; // 實盤量（≥0），差異由系統算
}

/**
 * 以實盤量整批建調整單：鎖商品後重讀帳面量（底稿列印到送單之間可能又出了貨），
 * 差異＝實盤−帳面；全部為 0 就不建單（盤點結果一致不是錯誤）。reason 固定 count。
 */
export async function createStocktake(db: Db, input: StocktakeInput, userId: number) {
  return db.transaction(async (tx) => {
    await assertPeriodOpen(tx, input.docDate);
    const productIds = input.lines.map((l) => l.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new AppError(422, "同一商品在盤點清單裡出現多次——每個商品只填一個實盤量");
    }
    // 差異必須在「與建單同一把鎖」之下計算：底稿上的帳面量只是參考，
    // 從列印到送單之間出過的貨，都要以送單當下的帳面量重新對
    await lockProducts(tx, productIds);
    const diffs: (AdjustmentLineInput & { bookQty: number; countedQty: number })[] = [];
    for (const l of input.lines) {
      if (l.countedQty < 0) throw new AppError(422, "實盤量不可為負數（商品 {id}）——最少就是 0", { id: l.productId });
      const { qty: bookQty } = await onHand(tx, l.productId);
      const diff = l.countedQty - bookQty;
      if (diff !== 0) {
        diffs.push({ productId: l.productId, qtyDiff: diff, bookQty, countedQty: l.countedQty });
      }
    }
    if (diffs.length === 0) {
      return { adjustment: null, message: "實盤量與帳面量完全一致，未建立調整單" };
    }
    const adjustment = await createAdjustmentCore(tx, {
      docDate: input.docDate,
      reason: "count",
      memo: input.memo?.trim() ?? "",
      userId,
      lines: diffs,
    });
    return { adjustment, message: null };
  });
}

/** 調整單清單（含明細與品名），新到舊——庫存頁的「調整歷史」直接取數 */
export async function listInventoryAdjustments(db: Db) {
  const docs = await db
    .select()
    .from(schema.inventoryAdjustments)
    .orderBy(desc(schema.inventoryAdjustments.id));
  const lines = await db
    .select({
      id: schema.inventoryAdjustmentLines.id,
      adjustmentId: schema.inventoryAdjustmentLines.adjustmentId,
      productId: schema.inventoryAdjustmentLines.productId,
      productName: schema.products.name,
      sku: schema.products.sku,
      direction: schema.inventoryAdjustmentLines.direction,
      qty: schema.inventoryAdjustmentLines.qty,
      unitCost: schema.inventoryAdjustmentLines.unitCost,
      amount: schema.inventoryAdjustmentLines.amount,
      bookQty: schema.inventoryAdjustmentLines.bookQty,
      countedQty: schema.inventoryAdjustmentLines.countedQty,
    })
    .from(schema.inventoryAdjustmentLines)
    .innerJoin(schema.products, eq(schema.inventoryAdjustmentLines.productId, schema.products.id))
    .orderBy(schema.inventoryAdjustmentLines.id);
  const byDoc = new Map<number, typeof lines>();
  for (const l of lines) {
    const arr = byDoc.get(l.adjustmentId) ?? [];
    arr.push(l);
    byDoc.set(l.adjustmentId, arr);
  }
  return docs.map((d) => ({ ...d, lines: byDoc.get(d.id) ?? [] }));
}
