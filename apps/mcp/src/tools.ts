/**
 * MCP 工具集：把 tw-erp API 包成給 AI 助理用的工具。
 * 權限跟隨登入帳號的角色（伺服端 ACL 把關）——業務帳號接 MCP 就只能做業務能做的事。
 * 工具回傳一律為 API 的 JSON 原文（字串化），由呼叫端模型自行解讀。
 */
import { z } from "zod";
import type { TwErpClient } from "./client.ts";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("日期 YYYY-MM-DD");
const lines = z
  .array(
    z.object({
      productId: z.number().int().positive(),
      qty: z.number().positive(),
      unitPrice: z.number().nonnegative().describe("未稅單價"),
    }),
  )
  .min(1)
  .describe("商品明細（金額為未稅整數元；稅額由系統依單據日期套用你在「稅法參數」頁設定的營業稅率計算）");

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export function defineTools(client: TwErpClient): ToolDef[] {
  const j = (v: unknown) => JSON.stringify(v, null, 1);
  return [
    {
      name: "list_partners",
      description: "列出交易對象（客戶/供應商）主檔",
      schema: {},
      handler: async () => j(await client.get("/partners")),
    },
    {
      name: "list_products",
      description: "列出商品主檔",
      schema: {},
      handler: async () => j(await client.get("/products")),
    },
    {
      name: "inventory_status",
      description: "各商品目前在庫量與移動平均成本",
      schema: {},
      handler: async () => j(await client.get("/inventory")),
    },
    {
      name: "create_quote",
      description: "建立報價單（客戶、報價日、商品明細；總額含稅由系統計算）",
      schema: {
        partnerId: z.number().int().positive().describe("客戶 id（list_partners 查）"),
        quoteDate: dateStr,
        memo: z.string().optional(),
        lines,
      },
      handler: async (a) => j(await client.post("/quotes", a)),
    },
    {
      name: "list_quotes",
      description: "列出報價單（含狀態：洽談中 open／已成交 won／未成交 lost）",
      schema: {},
      handler: async () => j(await client.get("/quotes")),
    },
    {
      name: "convert_quote",
      description: "報價成交轉訂單（一張報價只能轉一次）",
      schema: { quoteId: z.number().int().positive(), orderDate: dateStr },
      handler: async (a) => j(await client.post(`/quotes/${a["quoteId"]}/convert`, { orderDate: a["orderDate"] })),
    },
    {
      name: "list_orders",
      description: "列出銷售訂單（含出貨進度與狀態：未出貨/部分出貨/已結案/已取消）",
      schema: {},
      handler: async () => j(await client.get("/orders")),
    },
    {
      name: "ship_order",
      description: "訂單出貨：開銷貨單並拋轉庫存與傳票。不指定明細＝剩餘全出",
      schema: {
        orderId: z.number().int().positive(),
        docDate: dateStr,
        lines: z
          .array(z.object({ orderLineId: z.number().int().positive(), qty: z.number().positive() }))
          .optional()
          .describe("部分出貨時指定明細與數量；省略＝剩餘全出"),
      },
      handler: async (a) =>
        j(await client.post(`/orders/${a["orderId"]}/ship`, { docDate: a["docDate"], lines: a["lines"] })),
    },
    {
      name: "list_purchase_orders",
      description: "列出採購單（含到貨進度）",
      schema: {},
      handler: async () => j(await client.get("/purchase-orders")),
    },
    {
      name: "list_expense_claims",
      description: "列出費用報銷單（狀態：submitted 待核准／approved 待付款／rejected／paid）",
      schema: {},
      handler: async () => j(await client.get("/expense-claims")),
    },
    {
      name: "approve_expense_claim",
      description: "核准報銷單（拋轉費用傳票；需財務/管理者權限）",
      schema: { claimId: z.number().int().positive() },
      handler: async (a) => j(await client.post(`/expense-claims/${a["claimId"]}/approve`, {})),
    },
    {
      name: "dashboard",
      description: "經營儀表板：本月營收/毛利、現金水位、應收應付、在手訂單、未到貨採購、報銷待核、逾期應收（需總經理/財務權限）",
      schema: { asOf: dateStr },
      handler: async (a) => j(await client.get(`/reports/dashboard?asOf=${a["asOf"]}`)),
    },
    {
      name: "ar_aging",
      description: "應收帳齡表（催款用：各客戶未收金額按 30/60/90/90+ 天分桶）",
      schema: { asOf: dateStr },
      handler: async (a) => j(await client.get(`/reports/ar-aging?asOf=${a["asOf"]}`)),
    },
    {
      name: "income_statement",
      description: "綜合損益表（期間收入/費用/本期損益）",
      schema: { from: dateStr, to: dateStr },
      handler: async (a) => j(await client.get(`/reports/income-statement?from=${a["from"]}&to=${a["to"]}`)),
    },
    {
      name: "balance_sheet",
      description: "資產負債表（基準日累計）",
      schema: { asOf: dateStr },
      handler: async (a) => j(await client.get(`/reports/balance-sheet?asOf=${a["asOf"]}`)),
    },
    {
      name: "cash_flow",
      description: "現金流量表（直接法：營業/投資/籌資三大活動）",
      schema: { from: dateStr, to: dateStr },
      handler: async (a) => j(await client.get(`/reports/cash-flow?from=${a["from"]}&to=${a["to"]}`)),
    },
  ];
}
