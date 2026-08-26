/**
 * 對象餘額與收付款沖銷狀態的單一事實來源（R6，第四批）。
 *
 * 為什麼要有這個檔：同一個客戶的「還欠多少」曾經有四種算法——
 * - partner-balances（ledger.ts）：對象層級，收付款只沖「amount − unapplied」（0027 口徑）；
 * - ar-aging／ap-aging（orders.ts）：單據層級，未指定沖銷的收付款餘額 FIFO 沖最舊；
 * - open-documents（ledger.ts，修正前）：只認立沖紀錄，完全不看未指定沖銷的收付款——
 *   實測應收 470,400、收 200,000 未指定沖銷後，它仍顯示 470,400，另外兩處是 270,400，
 *   會計照它開下一張收款單就會再收一次；
 * - returns.ts 的沖應收付上限（修正前）：付款「全額」扣應付，把掛 1212 預付的溢付
 *   也當成沖應付——溢付存在時退出單的 apOffset 被壓低，餘額錯掛到其他應收。
 *
 * 收斂做法：對象層級餘額（partnerBalanceMaps）與收付款沖銷狀態（settlementMaps）
 * 都只在這裡算一次，partner-balances／帳齡／open-documents／退回折讓的沖應收付上限
 * 全部吃同一份。刻意保留的差異只剩「粒度與視角」，不是數字：
 * - partner-balances＝對象層級淨額（當下視角）；
 * - 帳齡＝單據層級、FIFO 沖最舊、asOf 視角（溢收溢付列 credit 欄）；
 * - open-documents＝與帳齡同一套單據層級口徑（remaining 已扣 FIFO），供立沖 UI 勾選。
 * 三者對同一組資料、同一基準日的合計必須相等（差異只在預收/預付的表達位置），
 * 這件事有測試釘住（test/balance-consistency.test.ts）。
 */
import { schema } from "@tw-erp/db";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../db.ts";

/**
 * 單據已被立沖的金額（sale/purchase/opening 各自加總）。
 * 排除已作廢收付款單的沖銷（0025，B4）：作廢＝那筆收付當作沒發生，
 * 它沖過的單據未沖餘額要自動回復——立沖紀錄本身保留（軌跡），只是不再計入。
 */
export async function allocatedByTarget(
  db: Db,
  targetType: "sale" | "purchase" | "opening",
): Promise<Map<number, number>> {
  const rows = await db
    .select({ targetId: schema.cashDocAllocations.targetId, amount: schema.cashDocAllocations.amount })
    .from(schema.cashDocAllocations)
    .innerJoin(schema.cashDocs, eq(schema.cashDocAllocations.cashDocId, schema.cashDocs.id))
    .where(and(eq(schema.cashDocAllocations.targetType, targetType), isNull(schema.cashDocs.voidedAt)));
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.targetId, (map.get(r.targetId) ?? 0) + r.amount);
  return map;
}

export interface SettlementMaps {
  /** 銷貨/進貨單已被立沖的金額（含事後預收/預付沖用；asOf 之後的沖用不計） */
  allocatedByDoc: Map<number, number>;
  /** 期初應收付單已被立沖的金額（opening 是獨立的 id 空間，必須分開放） */
  allocatedByOpening: Map<number, number>;
  /** 各對象「未指定沖銷、且已沖應收/應付」的收付款餘額——帳齡與 open-documents 的 FIFO pool */
  unallocatedByPartner: Map<number, number>;
  /** 各對象的預收/預付餘額（掛 2231/1212 的部分 − asOf 前已沖用合計） */
  prepaidByPartner: Map<number, number>;
}

/**
 * 收付款單的沖銷狀態（asOf 視角；不帶 asOf＝當下全貌）。
 *
 * 口徑（帳齡與 open-documents 共用，漏一處就是兩張表各說各話）：
 * - 已作廢收付款單（0025）整組排除——連同它的立沖一起消失，被沖過的單據餘額自動回復；
 * - 只計 docDate ≤ asOf 的收付款單；事後沖用預收/預付（0027，from_prepaid）另以
 *   alloc_date 篩——沖用日在 asOf 之後的不能回頭沖掉 asOf 當天還未沖的單據，
 *   否則帳齡與同日的資產負債表對不起來；
 * - FIFO pool ＝ amount − unapplied（溢收溢付掛 2231/1212，不是應收/應付的減項）
 *   − 建立時立沖的合計；沖用預收/預付花的是 2231/1212 的餘額，不佔 pool。
 */
export async function settlementMaps(
  db: Db,
  kind: "receipt" | "payment",
  asOf?: string,
  partnerId?: number,
): Promise<SettlementMaps> {
  const cashDocs = await db
    .select()
    .from(schema.cashDocs)
    .where(
      and(
        eq(schema.cashDocs.kind, kind),
        isNull(schema.cashDocs.voidedAt),
        asOf ? lte(schema.cashDocs.docDate, asOf) : undefined,
        partnerId ? eq(schema.cashDocs.partnerId, partnerId) : undefined,
      ),
    );
  const allocations = cashDocs.length
    ? await db
        .select()
        .from(schema.cashDocAllocations)
        .where(inArray(schema.cashDocAllocations.cashDocId, cashDocs.map((d) => d.id)))
    : [];

  const allocatedByDoc = new Map<number, number>();
  const allocatedByOpening = new Map<number, number>();
  const allocatedByCashDoc = new Map<number, number>(); // 各收付款單「建立時立沖」的合計（算 pool 用）
  const prepaidByPartner = new Map<number, number>();
  const partnerOfCashDoc = new Map(cashDocs.map((d) => [d.id, d.partnerId]));
  for (const d of cashDocs) {
    if (d.unappliedAmount > 0) {
      prepaidByPartner.set(d.partnerId, (prepaidByPartner.get(d.partnerId) ?? 0) + d.unappliedAmount);
    }
  }
  for (const a of allocations) {
    if (a.fromPrepaid && a.allocDate && asOf && a.allocDate > asOf) continue;
    const m = a.targetType === "opening" ? allocatedByOpening : allocatedByDoc;
    m.set(a.targetId, (m.get(a.targetId) ?? 0) + a.amount);
    if (a.fromPrepaid) {
      const owner = partnerOfCashDoc.get(a.cashDocId)!;
      prepaidByPartner.set(owner, (prepaidByPartner.get(owner) ?? 0) - a.amount);
    } else {
      allocatedByCashDoc.set(a.cashDocId, (allocatedByCashDoc.get(a.cashDocId) ?? 0) + a.amount);
    }
  }
  const unallocatedByPartner = new Map<number, number>();
  for (const d of cashDocs) {
    const unallocated = d.amount - d.unappliedAmount - (allocatedByCashDoc.get(d.id) ?? 0);
    if (unallocated > 0) {
      unallocatedByPartner.set(d.partnerId, (unallocatedByPartner.get(d.partnerId) ?? 0) + unallocated);
    }
  }
  return { allocatedByDoc, allocatedByOpening, unallocatedByPartner, prepaidByPartner };
}

export interface PartnerBalanceMaps {
  ar: Map<number, number>;
  ap: Map<number, number>;
  prepaidReceived: Map<number, number>;
  prepaidPaid: Map<number, number>;
}

/**
 * 各交易對象未收/未付餘額（單據面、當下視角）：
 * 銷貨/進貨總額 ＋ 期初應收付 − 退回沖銷（ar_offset/ap_offset）− 收付款（amount − unapplied）
 * − 事後預收/預付沖用；已沖銷銷貨與所有已作廢單據不計。
 * 退回只扣「實際沖回應收/應付」的部分——掛 2201 的退款與退現金已不在應收應付體系裡。
 * 收付款只沖「amount − unapplied」（0027，B9）：溢收溢付掛的是 2231/1212，
 * 不是應收/應付的減項；預收/預付分列（prepaidReceived/prepaidPaid），不以淨額互抵。
 *
 * partnerId 給了就只算那一個對象（退回折讓的沖應收付上限用；七個查詢都有過濾，
 * 不會把全站單據拉進交易）。
 */
export async function partnerBalanceMaps(db: Db, partnerId?: number): Promise<PartnerBalanceMaps> {
  const forPartner = (col: AnyPgColumn) => (partnerId ? eq(col, partnerId) : undefined);
  const sales = await db
    .select({ partnerId: schema.sales.partnerId, total: schema.sales.total })
    .from(schema.sales)
    .where(and(isNull(schema.sales.reversalEntryId), forPartner(schema.sales.partnerId)));
  // 已作廢的進貨單與收付款單（0025，B4）一律排除：作廢＝當作沒發生，餘額要自動回復
  const purchases = await db
    .select({ partnerId: schema.purchases.partnerId, total: schema.purchases.total })
    .from(schema.purchases)
    .where(and(isNull(schema.purchases.voidedAt), forPartner(schema.purchases.partnerId)));
  const docs = await db
    .select()
    .from(schema.cashDocs)
    .where(and(isNull(schema.cashDocs.voidedAt), forPartner(schema.cashDocs.partnerId)));
  // 已作廢退回折讓單（0030）不再抵減餘額：作廢＝當作沒退過
  const saleReturns = await db
    .select({ partnerId: schema.salesReturns.partnerId, arOffset: schema.salesReturns.arOffset })
    .from(schema.salesReturns)
    .where(and(isNull(schema.salesReturns.voidedAt), forPartner(schema.salesReturns.partnerId)));
  const purchaseReturns = await db
    .select({ partnerId: schema.purchaseReturns.partnerId, apOffset: schema.purchaseReturns.apOffset })
    .from(schema.purchaseReturns)
    .where(and(isNull(schema.purchaseReturns.voidedAt), forPartner(schema.purchaseReturns.partnerId)));
  // 期初應收付單（0023，B6）：與銷貨/進貨同向加入餘額，收付款照常扣——
  // 不加的話，既有公司導入後第一筆收款就會把餘額打成負數「預收」。已作廢者（0030）不計
  const openings = await db
    .select()
    .from(schema.openingBalances)
    .where(and(isNull(schema.openingBalances.voidedAt), forPartner(schema.openingBalances.partnerId)));

  const ar = new Map<number, number>();
  const ap = new Map<number, number>();
  for (const s of sales) ar.set(s.partnerId, (ar.get(s.partnerId) ?? 0) + s.total);
  for (const p of purchases) ap.set(p.partnerId, (ap.get(p.partnerId) ?? 0) + p.total);
  for (const o of openings) {
    const m = o.kind === "receivable" ? ar : ap;
    m.set(o.partnerId, (m.get(o.partnerId) ?? 0) + o.amount);
  }
  for (const r of saleReturns) ar.set(r.partnerId, (ar.get(r.partnerId) ?? 0) - r.arOffset);
  for (const r of purchaseReturns) ap.set(r.partnerId, (ap.get(r.partnerId) ?? 0) - r.apOffset);
  // 收付款只沖「金額 − 溢收溢付」（0027，B9）：溢收部分掛的是 2231/1212，不是應收/應付的減項
  const prepaidReceived = new Map<number, number>();
  const prepaidPaid = new Map<number, number>();
  for (const d of docs) {
    const m = d.kind === "receipt" ? ar : ap;
    m.set(d.partnerId, (m.get(d.partnerId) ?? 0) - (d.amount - d.unappliedAmount));
    if (d.unappliedAmount > 0) {
      const pm = d.kind === "receipt" ? prepaidReceived : prepaidPaid;
      pm.set(d.partnerId, (pm.get(d.partnerId) ?? 0) + d.unappliedAmount);
    }
  }
  // 事後沖用預收/預付：目標單據的應收/應付被沖掉、預收/預付餘額同額減少（已作廢收付款單的沖用不計）
  const applications = await db
    .select({
      amount: schema.cashDocAllocations.amount,
      partnerId: schema.cashDocs.partnerId,
      kind: schema.cashDocs.kind,
    })
    .from(schema.cashDocAllocations)
    .innerJoin(schema.cashDocs, eq(schema.cashDocAllocations.cashDocId, schema.cashDocs.id))
    .where(
      and(
        eq(schema.cashDocAllocations.fromPrepaid, true),
        isNull(schema.cashDocs.voidedAt),
        forPartner(schema.cashDocs.partnerId),
      ),
    );
  for (const a of applications) {
    const m = a.kind === "receipt" ? ar : ap;
    m.set(a.partnerId, (m.get(a.partnerId) ?? 0) - a.amount);
    const pm = a.kind === "receipt" ? prepaidReceived : prepaidPaid;
    pm.set(a.partnerId, (pm.get(a.partnerId) ?? 0) - a.amount);
  }
  return { ar, ap, prepaidReceived, prepaidPaid };
}
