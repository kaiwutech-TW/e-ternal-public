/**
 * 採購前段：採購單 → 收貨（轉進貨單），鏡射銷售前段（services/orders.ts）。
 * - 狀態由收貨量推導：open → partial → closed；canceled 僅限未收貨
 * - 收貨即開進貨單：沿用 createPurchase（庫存入庫、拋轉傳票），purchases.purchase_order_id 回連
 * - 「未到貨追蹤」＝各明細 qty - received_qty
 */
import { calcTax, lineAmount } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, count, desc, eq, getTableColumns, gte, inArray, isNull, lte } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { assertNotFarFuture } from "./dates.ts";
import { createPurchase, type DocLineInput } from "./documents.ts";
import type { ListFilter } from "./list.ts";
import { resolveVatRate } from "./tax-parameters.ts";

export interface PurchaseOrderInput {
  partnerId: number;
  orderDate: string;
  memo?: string | undefined;
  /** 預計到貨日（0035）：未帶＝未約定（NULL）；清單頁「今天 > 到貨日且未結」標逾期 */
  expectedDate?: string | undefined;
  lines: DocLineInput[];
}

export async function createPurchaseOrder(db: Db, input: PurchaseOrderInput, createdBy: number) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來採購單當場擋下（過去日期不擋——補登歷史採購是正常作業）
    assertNotFarFuture(input.orderDate, "採購單日期");
    const [partner] = await tx.select().from(schema.partners).where(eq(schema.partners.id, input.partnerId));
    if (!partner) throw new AppError(404, `交易對象不存在: ${input.partnerId}`);
    if (!partner.isSupplier) throw new AppError(422, `非供應商: ${partner.name}`);

    // 採購單的稅額與報價單一樣是**估算**：真正入帳的是收貨當日由 createPurchase 重算的那一份。
    // 仍依開單日解析費率，否則向廠商確認的總額會與收貨時的帳不一致
    const vat = await resolveVatRate(tx, input.orderDate);
    const withAmounts = input.lines.map((l) => ({ ...l, amount: lineAmount(l.qty, l.unitPrice) }));
    const subtotal = withAmounts.reduce((s, l) => s + l.amount, 0);
    const tax = calcTax(subtotal, vat.rate);
    const [po] = await tx
      .insert(schema.purchaseOrders)
      .values({
        partnerId: input.partnerId,
        orderDate: input.orderDate,
        memo: input.memo ?? "",
        expectedDate: input.expectedDate ?? null,
        subtotal,
        tax,
        total: subtotal + tax,
        vatRateBp: vat.rateBp,
        createdBy,
      })
      .returning();
    await tx.insert(schema.purchaseOrderLines).values(
      withAmounts.map((l) => ({
        purchaseOrderId: po!.id,
        productId: l.productId,
        qty: String(l.qty),
        unitPrice: String(l.unitPrice),
        amount: l.amount,
      })),
    );
    return { ...po!, taxNotes: vat.notes };
  });
}

/**
 * R3＋N+1 修正（鏡射 orders.ts listOrders）：原本一次拉五張全表在記憶體配對，
 * 改為每個關聯各一次查詢、且只查頁內採購單的 id。回傳形狀不變。
 */
export async function listPurchaseOrders(db: Db, f: ListFilter) {
  const where = and(
    f.from ? gte(schema.purchaseOrders.orderDate, f.from) : undefined,
    f.to ? lte(schema.purchaseOrders.orderDate, f.to) : undefined,
    f.partnerId ? eq(schema.purchaseOrders.partnerId, f.partnerId) : undefined,
  );
  const [agg] = await db.select({ total: count() }).from(schema.purchaseOrders).where(where);
  const pos = await db
    .select()
    .from(schema.purchaseOrders)
    .where(where)
    .orderBy(desc(schema.purchaseOrders.id))
    .limit(f.limit)
    .offset(f.offset);
  const ids = pos.map((po) => po.id);
  const partnerIds = [...new Set(pos.map((po) => po.partnerId))];
  const partners = partnerIds.length
    ? await db
        .select({ id: schema.partners.id, name: schema.partners.name })
        .from(schema.partners)
        .where(inArray(schema.partners.id, partnerIds))
    : [];
  const nameOf = new Map(partners.map((p) => [p.id, p.name]));
  const lines = ids.length
    ? await db
        .select({ ...getTableColumns(schema.purchaseOrderLines), productName: schema.products.name })
        .from(schema.purchaseOrderLines)
        .leftJoin(schema.products, eq(schema.purchaseOrderLines.productId, schema.products.id))
        .where(inArray(schema.purchaseOrderLines.purchaseOrderId, ids))
    : [];
  // 已作廢的進貨單不列入關聯連結（收貨量已隨作廢退回，與 orders.ts saleIds 同一條規則）
  const purchases = ids.length
    ? await db
        .select({ id: schema.purchases.id, purchaseOrderId: schema.purchases.purchaseOrderId })
        .from(schema.purchases)
        .where(and(inArray(schema.purchases.purchaseOrderId, ids), isNull(schema.purchases.voidedAt)))
    : [];
  return {
    rows: pos.map((po) => ({
      ...po,
      partnerName: nameOf.get(po.partnerId) ?? `#${po.partnerId}`,
      lines: lines
        .filter((l) => l.purchaseOrderId === po.id)
        .map(({ productName, ...l }) => ({
          ...l,
          productName: productName ?? `#${l.productId}`,
          remainingQty: Number(l.qty) - Number(l.receivedQty),
        })),
      purchaseIds: purchases.filter((p) => p.purchaseOrderId === po.id).map((p) => p.id),
    })),
    total: agg!.total,
  };
}

export interface ReceiveLineInput {
  poLineId: number;
  qty: number;
  /**
   * 收貨單價覆寫（0032）：選填，未帶＝採購單價。到貨發票價與下單價不同（調價、匯率、議價）時，
   * 進貨單要照**實際應付的價**入帳——原本只能收單後再開折讓（僅能往下調），漲價根本無路可走。
   * 覆寫只進進貨單與傳票；採購單明細保留原下單價，兩者的差異即為覆核紀錄（回應也逐筆列出）。
   */
  unitPrice?: number | undefined;
}

/** 收貨：未指定明細＝剩餘全收。開進貨單（含庫存/傳票）、累計已收貨量、推導採購單狀態 */
export async function receivePurchaseOrder(
  db: Db,
  poId: number,
  input: { docDate: string; lines?: ReceiveLineInput[] | undefined },
) {
  return db.transaction(async (tx) => {
    const [po] = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    if (!po) throw new AppError(404, `採購單不存在: ${poId}`);
    if (po.status === "canceled" || po.status === "closed") {
      throw new AppError(
        409,
        po.status === "closed"
          ? `採購單 #${poId} 已結案（結案＝到此為止，剩餘量不再收貨），不可收貨。要繼續進貨請開一張新採購單`
          : `採購單 #${poId} 已取消（取消＝這張單從沒發生），不可收貨。要進貨請開一張新採購單`,
      );
    }
    const poLines = await tx
      .select()
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, poId));
    const byId = new Map(poLines.map((l) => [l.id, l]));

    const receiveLines: ReceiveLineInput[] =
      input.lines ??
      poLines
        .filter((l) => Number(l.qty) - Number(l.receivedQty) > 0)
        .map((l) => ({ poLineId: l.id, qty: Number(l.qty) - Number(l.receivedQty) }));
    if (!receiveLines.length) throw new AppError(422, "沒有可收貨的明細");

    for (const r of receiveLines) {
      const line = byId.get(r.poLineId);
      if (!line) throw new AppError(404, `採購單明細不存在: ${r.poLineId}`);
      const remaining = Number(line.qty) - Number(line.receivedQty);
      if (r.qty <= 0) throw new AppError(422, `收貨量必須大於 0（明細 ${r.poLineId}）`);
      if (r.qty > remaining) {
        throw new AppError(422, `收貨量超過剩餘量: 明細 ${r.poLineId} 剩 ${remaining}，欲收 ${r.qty}`);
      }
    }

    // 收貨價覆寫（0032）：進貨單以實際收貨價入帳；有覆寫的明細逐筆記下來，回應裡讓收貨的人看見差異
    const priceOverrides: { poLineId: number; productId: number; orderPrice: number; receivedPrice: number }[] = [];
    const purchase = await createPurchase(tx, {
      partnerId: po.partnerId,
      docDate: input.docDate,
      lines: receiveLines.map((r) => {
        const line = byId.get(r.poLineId)!;
        const orderPrice = Number(line.unitPrice);
        const unitPrice = r.unitPrice ?? orderPrice;
        if (r.unitPrice !== undefined && r.unitPrice !== orderPrice) {
          priceOverrides.push({ poLineId: r.poLineId, productId: line.productId, orderPrice, receivedPrice: r.unitPrice });
        }
        return { productId: line.productId, qty: r.qty, unitPrice };
      }),
    });
    await tx
      .update(schema.purchases)
      .set({ purchaseOrderId: poId })
      .where(eq(schema.purchases.id, purchase.id));

    for (const r of receiveLines) {
      const line = byId.get(r.poLineId)!;
      await tx
        .update(schema.purchaseOrderLines)
        .set({ receivedQty: String(Number(line.receivedQty) + r.qty) })
        .where(eq(schema.purchaseOrderLines.id, r.poLineId));
    }

    const after = await tx
      .select()
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, poId));
    const fullyReceived = after.every((l) => Number(l.receivedQty) >= Number(l.qty));
    const [updated] = await tx
      .update(schema.purchaseOrders)
      .set({ status: fullyReceived ? "closed" : "partial" })
      .where(eq(schema.purchaseOrders.id, poId))
      .returning();
    // createPurchase 已依收貨日重算稅額；費率警告要跟著浮上來，否則收貨這條路徑會靜默走回退值。
    // 收貨價覆寫的差異走同一條 taxNotes 通道浮上畫面（不另立欄位讓前端漏接）——
    // 收貨的人當場看得到「這一筆用了跟採購單不同的價」，覆核不必翻兩張單對
    const overrideNotes = priceOverrides.map(
      (o) =>
        `採購單明細 #${o.poLineId} 以收貨價 ${o.receivedPrice} 元入帳（原下單價 ${o.orderPrice} 元）——` +
        `進貨單與傳票以收貨價為準，採購單保留原價供比對`,
    );
    return {
      purchaseOrder: updated!,
      purchaseId: purchase.id,
      taxNotes: [...purchase.taxNotes, ...overrideNotes],
      priceOverrides,
    };
  });
}

export async function cancelPurchaseOrder(db: Db, poId: number) {
  return db.transaction(async (tx) => {
    const [po] = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    if (!po) throw new AppError(404, `採購單不存在: ${poId}`);
    if (po.status !== "open") {
      throw new AppError(
        409,
        `僅未收貨的採購單可取消（取消＝這張單從沒發生；目前 ${po.status}）。` +
          `已有收貨的採購單請改用「結案」（結案＝到此為止：已收貨的進貨單與憑證留著，剩餘量不再收）；` +
          `收錯的貨請先到進貨頁作廢該張進貨單`,
      );
    }
    const [updated] = await tx
      .update(schema.purchaseOrders)
      .set({ status: "canceled" })
      .where(eq(schema.purchaseOrders.id, poId))
      .returning();
    return updated!;
  });
}

/**
 * 短交結案（0032）：與 closeOrder 同義——取消＝從沒發生（僅限未收貨）；結案＝到此為止，
 * 已收貨的進貨單與憑證留著、剩餘量不再期待到貨。open 也可結案（廠商整單斷貨但想留紀錄）。
 * 不動已開出的單據、不拋轉傳票，所以不套關帳鎖；理由必填。
 */
export async function closePurchaseOrder(db: Db, poId: number, reason: string, closedBy: number) {
  return db.transaction(async (tx) => {
    const [po] = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    if (!po) throw new AppError(404, `採購單不存在: ${poId}`);
    if (po.status === "closed") {
      throw new AppError(
        409,
        po.closedAt
          ? `採購單 #${poId} 已於 ${po.closedAt.toISOString().slice(0, 10)} 短交結案（原因：${po.closeReason ?? "未記錄"}），不可再結案`
          : `採購單 #${poId} 已全數收訖、自動結案，不需再結案`,
      );
    }
    if (po.status === "canceled") {
      throw new AppError(409, `採購單 #${poId} 已取消（取消＝這張單從沒發生），沒有可結案的內容`);
    }
    const [updated] = await tx
      .update(schema.purchaseOrders)
      .set({ status: "closed", closedAt: new Date(), closedBy, closeReason: reason })
      .where(eq(schema.purchaseOrders.id, poId))
      .returning();
    return updated!;
  });
}
