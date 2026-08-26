/**
 * 總經理儀表板：一支 API 彙總「一眼看懂公司現況」的數字。
 * asOf 決定視角（本月＝asOf 所在月份）；金額整數元。
 * - 本月營收/毛利：未沖銷銷貨單的 subtotal 與 subtotal-cogs，扣除本月退回／折讓（當期認列）
 * - 現金水位：所有現金科目（accounts.is_cash，含自建的銀行帳戶科目）的傳票餘額
 * - 應收/應付：對象層級餘額加總（與收付款頁同口徑）
 * - 在手訂單/未到貨採購：open+partial 單的剩餘量×單價（未稅）
 * - 報銷待核：submitted 狀態的件數與金額；待付報銷：approved 未付（未作廢）的件數與金額
 * - 逾期應收：帳齡表中「收款到期日已過」的未收合計（無到期日的舊單以單據日估算、前 30 天不計）
 */
import { schema } from "@tw-erp/db";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import type { Db } from "../db.ts";
import { billingDue, expiringContracts } from "./contracts.ts";
import { partnerBalances } from "./ledger.ts";
import { arAging } from "./orders.ts";
import { dueList } from "./recurring-payables.ts";

function monthRange(asOf: string): { from: string; to: string } {
  const [y, m] = [Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7))];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // 該月最後一天
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

export async function dashboard(db: Db, asOf: string) {
  const { from, to } = monthRange(asOf);

  const monthSales = await db
    .select()
    .from(schema.sales)
    .where(and(isNull(schema.sales.reversalEntryId), gte(schema.sales.docDate, from), lte(schema.sales.docDate, to)));
  // 退回／折讓一律當期認列（原銷貨單不回頭改），所以這裡看的是「退回單的日期落在本月」，
  // 不是「原銷貨單在本月」——6 月賣、7 月退，減的是 7 月的營收與毛利，與損益表口徑一致
  const monthReturns = await db
    .select()
    .from(schema.salesReturns)
    // 已作廢退回折讓單（0030）不再抵減本月營收與毛利
    .where(
      and(
        gte(schema.salesReturns.docDate, from),
        lte(schema.salesReturns.docDate, to),
        isNull(schema.salesReturns.voidedAt),
      ),
    );
  const returnedNet = monthReturns.reduce((s, r) => s + r.subtotal, 0);
  const returnedCost = monthReturns.reduce((s, r) => s + r.cogs, 0);
  const revenue = monthSales.reduce((s, r) => s + r.subtotal, 0) - returnedNet;
  const grossProfit =
    monthSales.reduce((s, r) => s + (r.subtotal - r.cogs), 0) - (returnedNet - returnedCost);

  // 現金水位：現金科目的借貸餘額（傳票為單一事實來源）。
  // 科目以 accounts.is_cash 判定而非寫死代號——使用者自建的銀行帳戶科目也是現金，
  // 寫死會讓儀表板的現金水位比現金流量表與資產負債表都少一截
  const cashLines = await db
    .select({ debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.accounts.isCash, true));
  const cash = cashLines.reduce((s, l) => s + l.debit - l.credit, 0);

  const balances = await partnerBalances(db);
  const ar = balances.reduce((s, b) => s + Math.max(0, b.ar), 0);
  const ap = balances.reduce((s, b) => s + Math.max(0, b.ap), 0);

  const backlog = await openBacklog(db, "sales");
  const inbound = await openBacklog(db, "purchase");

  const claims = await db.select().from(schema.expenseClaims).where(eq(schema.expenseClaims.status, "submitted"));
  // R13：已核准未付＝「公司現在欠員工多少」。已作廢（0036）排除；
  // 公司支付的單核准即 paid，天然不在這裡（欠的是公司卡帳單，不是員工）
  const approvedClaims = await db
    .select()
    .from(schema.expenseClaims)
    .where(and(eq(schema.expenseClaims.status, "approved"), isNull(schema.expenseClaims.voidedAt)));
  const aging = await arAging(db, asOf);

  return {
    asOf,
    month: asOf.slice(0, 7),
    revenue: { subtotal: revenue, grossProfit, count: monthSales.length },
    cash,
    ar,
    ap,
    backlog, // 在手訂單（未出貨部分，未稅）
    inbound, // 未到貨採購（未收部分，未稅）
    pendingClaims: { count: claims.length, amount: claims.reduce((s, c) => s + c.total, 0) },
    // 待付報銷（R13）：員工代墊已核准、還沒還錢的
    approvedUnpaidClaims: { count: approvedClaims.length, amount: approvedClaims.reduce((s, c) => s + c.total, 0) },
    // 帳齡表算好的「到期未收」。之前是 total - d0_30（把「月結 30 天」硬編碼成全公司常數）：
    // 月結 60 天的客戶第 45 天（未到期）被標逾期、貨到付款的第 20 天（早逾期了）反而顯示安全
    overdueAr: aging.totals.overdue,
    // 「還沒做完的事」（0047）：三個來源合成一份，全部是**使用者自己設定的日期**——
    // 系統不知道也不提示任何法定期限。放假一週回來會有人替你打開那一頁，那個人是首頁
    upcoming: await upcoming(db, asOf),
  };
}

export interface UpcomingRow {
  kind: "billing" | "payable" | "contract";
  label: string;
  detail: string;
  date: string;
  amount: number | null;
  overdue: boolean;
  /** 前往哪一頁（PAGE_KEY，前端導覽直接吃） */
  page: "contracts" | "recurring";
}

/**
 * 首頁的「還沒做完的事」：合約待請款／待付款、週期性支出到期、合約快到期。
 * 一張卡多個來源——首頁已經有「開始使用」清單與字軌提醒在搶版面，各家各加一張會變成公佈欄。
 * **文案主詞一律是使用者的設定與日期**：不得出現期限／日前／應於／逾期未申報。
 */
async function upcoming(db: Db, asOf: string): Promise<UpcomingRow[]> {
  const [due, payables, expiring] = await Promise.all([
    billingDue(db, asOf, 30),
    dueList(db, asOf, 30),
    expiringContracts(db, asOf),
  ]);
  const rows: UpcomingRow[] = [
    ...due.map((d) => ({
      kind: (d.direction === "purchase" ? "payable" : "billing") as "billing" | "payable",
      label: d.direction === "purchase" ? "合約待付款" : "合約待請款",
      detail: `${d.contractTitle}（${d.counterparty}）第 ${d.seq} 期${d.description ? `：${d.description}` : ""}`,
      date: d.dueDate,
      amount: d.amount,
      overdue: d.overdue,
      page: "contracts" as const,
    })),
    ...payables.map((p) => ({
      kind: "payable" as const,
      label: "固定支出",
      detail: `${p.payableName} 第 ${p.seq} 期${p.partnerName ? `（${p.partnerName}）` : ""}`,
      date: p.dueDate,
      amount: p.amount,
      overdue: p.overdue,
      page: "recurring" as const,
    })),
    ...expiring.map((c) => ({
      kind: "contract" as const,
      label: "合約快到期",
      detail: `${c.title}（${c.counterparty}）——你設定的提前提醒 ${c.noticeDays} 天`,
      date: c.endDate,
      amount: null,
      overdue: c.endDate < asOf,
      page: "contracts" as const,
    })),
  ];
  return rows.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.date.localeCompare(b.date));
}

/** open/partial 單的剩餘量×單價（未稅整數元）與件數 */
async function openBacklog(db: Db, kind: "sales" | "purchase") {
  const [orders, lines] =
    kind === "sales"
      ? [await db.select().from(schema.orders), await db.select().from(schema.orderLines)]
      : [await db.select().from(schema.purchaseOrders), await db.select().from(schema.purchaseOrderLines)];
  const openIds = new Set(orders.filter((o) => o.status === "open" || o.status === "partial").map((o) => o.id));
  let amount = 0;
  for (const l of lines) {
    const parentId = "orderId" in l ? l.orderId : l.purchaseOrderId;
    if (!openIds.has(parentId)) continue;
    const remaining = Number(l.qty) - Number("shippedQty" in l ? l.shippedQty : l.receivedQty);
    if (remaining > 0) amount += Math.round(remaining * Number(l.unitPrice));
  }
  return { count: openIds.size, amount };
}
