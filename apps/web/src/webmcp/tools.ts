/**
 * WebMCP 工具集：把 E-ternal 的頁面能力開給「站在使用者旁邊」的瀏覽器 agent。
 *
 * 設計紀律（與 agent/soul.md 同一條紅線，但這裡是結構不是自律）：
 * - 查詢類全部 readOnlyHint: true——agent 可自由呼叫
 * - 寫入只到「草稿」：draft_quote / update_draft_field 只動畫面上那張草稿卡
 * - 唯一的送出通道是 submit_draft，而它必經 requestApproval（人按了才過）
 * - 過帳、核准、作廢：工具「不存在」。沒有註冊的門，jailbreak 也開不了。
 *
 * 工具依角色與登入狀態動態註冊（WebMcp.tsx 的 effect 負責重算＋syncTools）。
 * description 一律英文——那是給 agent 模型讀的。
 */
import { PAGE_INFO, canAccessPage, type PageKey, type Role } from "@tw-erp/core";
import { api } from "../api.ts";
import {
  draftSubtotal,
  editDraft,
  getApproval,
  getDraft,
  logActivity,
  newDraftId,
  recentSubmission,
  recordSubmission,
  requestApproval,
  resolveActivity,
  setDraft,
  type QuoteDraft,
} from "./bus.ts";
import { textResult, type WebMcpTool, type WebMcpToolResult } from "./model-context.ts";
import { fenceUntrusted } from "./quarantine.ts";
import { validateArgs } from "./validate.ts";
import type { Partner, Product } from "../types.ts";

export interface ToolDeps {
  role: Role;
  /** 目前頁面 key（get_current_view 用） */
  getPage: () => string;
  /** 導航（NavContext 的 setPage；由 WebMcp.tsx 掛進來） */
  navigate: (page: PageKey) => void;
  /** 開著的草稿行數（null＝沒有草稿）：update_draft_field 的 lineIndex 上限是「活的」 */
  draftLines: number | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * 拒絕（policy refusal）與錯誤（malformed input）是兩件事，但對 agent 的回應同一種形狀：
 * `{ok:false, error:{code,message}, hint}`——hint 永遠告訴 agent「下一步合法的動作是什麼」，
 * 讓它自我修正，而不是瞎重試。
 */
class ToolRefusal extends Error {
  constructor(
    public code: string,
    message: string,
    public hint: string,
  ) {
    super(message);
  }
}
const refuse = (code: string, message: string, hint: string): never => {
  throw new ToolRefusal(code, message, hint);
};

/**
 * 輸出預算：Chrome 的指引是 ~1500 字，但財務報表 JSON 天生比較胖；
 * 取 4000——仍然有界（agent 的 context 不會被灌爆），截尾必留標注（不無聲吞掉）。
 */
const OUTPUT_BUDGET = 4000;

/**
 * 每個工具都包一層（工具無法退出這一層——這正是重點）：
 * 1. 進門先驗參數——瀏覽器**不會**拿 inputSchema 驗過才呼叫，宣告只是廣告，驗證在這裡
 * 2. 進出都寫活動紀錄（人看得到 agent 在做什麼）
 * 3. untrustedContentHint 的輸出整段過隔離圍欄（quarantine.ts）
 * 4. 輸出超預算截尾標注；錯誤轉成結構化 envelope 回給 agent（不炸頁面）
 */
function withLog(tool: WebMcpTool): WebMcpTool {
  // OpenAI 文件的慣例：inputSchema 收斂（additionalProperties: false），agent 不會塞沒定義的參數
  const inputSchema =
    tool.inputSchema && tool.inputSchema["type"] === "object" && !("additionalProperties" in tool.inputSchema)
      ? { ...tool.inputSchema, additionalProperties: false }
      : tool.inputSchema;
  return {
    ...tool,
    ...(inputSchema ? { inputSchema } : {}),
    async execute(args): Promise<WebMcpToolResult> {
      const id = logActivity({
        actor: "agent",
        tool: tool.name,
        summary: summarizeArgs(args),
        status: "pending",
      });
      const fail = (code: string, message: string, hint: string): WebMcpToolResult => {
        resolveActivity(id, "error", `${code}: ${message}`);
        return textResult({ ok: false, error: { code, message }, hint });
      };
      const problems = validateArgs(inputSchema, args);
      if (problems.length) {
        return fail(
          "invalid_input",
          problems.map((p) => `${p.path} ${p.message}`).join("; "),
          "Correct the arguments to match the declared inputSchema and call the tool again.",
        );
      }
      try {
        const out = await tool.execute(args);
        resolveActivity(id, "ok");
        let text = out.content.map((c) => c.text).join("\n");
        if (text.length > OUTPUT_BUDGET)
          text = `${text.slice(0, OUTPUT_BUDGET)}\n[trimmed ${text.length - OUTPUT_BUDGET} chars to fit the tool-output budget — ask a narrower question]`;
        if (tool.annotations?.untrustedContentHint) text = fenceUntrusted(text);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        if (e instanceof ToolRefusal) return fail(e.code, e.message, e.hint);
        const msg = (e as Error).message || String(e);
        return fail("tool_failed", msg, "The message above states what was wrong — fix that and retry once; if it persists, tell the user.");
      }
    },
  };
}

const summarizeArgs = (args: Record<string, unknown>): string => {
  const s = JSON.stringify(args ?? {});
  return s === "{}" ? "" : s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

/** 名稱/編號 → 主檔列：全字匹配優先，其次包含；多筆歧義時把候選丟回去讓 agent 追問 */
function resolveByName<T extends { id: number; name: string }>(
  rows: T[],
  query: string,
  kind: string,
): T {
  const q = query.trim().toLowerCase();
  if (/^\d+$/.test(q)) {
    const byId = rows.find((r) => r.id === Number(q));
    if (byId) return byId;
  }
  const exact = rows.filter((r) => r.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) throw new Error(`No ${kind} matches "${query}". Use the search tool first.`);
  throw new Error(
    `Ambiguous ${kind} "${query}" — candidates: ${partial
      .slice(0, 8)
      .map((r) => `#${r.id} ${r.name}`)
      .join(", ")}. Ask the user or pass the id.`,
  );
}

const trim = <T>(rows: T[], max = 50): { rows: T[]; note?: string } =>
  rows.length > max ? { rows: rows.slice(0, max), note: `showing ${max} of ${rows.length}` } : { rows };

// ---------- 工具本體 ----------

export function buildTools(deps: ToolDeps): WebMcpTool[] {
  const { role } = deps;
  const tools: WebMcpTool[] = [];
  const can = (page: PageKey) => canAccessPage(role, page);

  // -- 常駐唯讀 --

  tools.push({
    name: "get_current_view",
    description:
      "Get what the user is currently looking at: the active page of this ERP, its purpose, and whether a co-edited quote draft is open. Call this first to share context with the user.",
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute() {
      const page = deps.getPage();
      const info = (PAGE_INFO as Record<string, { label: string; desc: string }>)[page];
      const d = getDraft();
      return textResult({
        page,
        label: info?.label ?? page,
        purpose: info?.desc ?? "",
        url: window.location.pathname,
        quoteDraftOpen: !!d,
        ...(d ? { draft: { partner: d.partnerName, lines: d.lines.length, subtotalUntaxed: draftSubtotal(d) } } : {}),
      });
    },
  });

  tools.push({
    name: "navigate_to",
    description:
      "Navigate the user's screen to a page of this ERP so you can look at it together. Pages available to this user's role only.",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          enum: (Object.keys(PAGE_INFO) as PageKey[]).filter((k) => can(k)),
          description: "Page key to open",
        },
      },
      required: ["page"],
    },
    async execute({ page }) {
      const key = page as PageKey;
      if (!can(key)) throw new Error(`This user's role cannot access "${String(page)}".`);
      deps.navigate(key);
      const info = (PAGE_INFO as Record<string, { label: string; desc: string }>)[key];
      return textResult(`Now showing "${info?.label ?? key}" — ${info?.desc ?? ""}`);
    },
  });

  if (can("masters")) {
    tools.push({
      name: "search_partners",
      description:
        "Search business partners (customers/suppliers) by name or tax ID substring. Returns id, name, taxId, roles. Use the id in draft_quote.",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Name or tax-ID substring; empty = list all" } },
      },
      async execute({ query }) {
        const all = await api.get<Partner[]>("/partners");
        const q = String(query ?? "").trim().toLowerCase();
        const hit = q
          ? all.filter((p) => p.name.toLowerCase().includes(q) || (p.taxId ?? "").includes(q))
          : all;
        const { rows, note } = trim(
          hit.map((p) => ({
            id: p.id,
            name: p.name,
            taxId: p.taxId,
            isCustomer: p.isCustomer,
            isSupplier: p.isSupplier,
          })),
        );
        return textResult({ partners: rows, ...(note ? { note } : {}) });
      },
    });

    tools.push({
      name: "search_products",
      description:
        "Search the product master by name/SKU substring. Returns id, sku, name, unit, listPrice (untaxed, null = unpriced), isService.",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Name or SKU substring; empty = list all" } },
      },
      async execute({ query }) {
        const all = await api.get<Product[]>("/products");
        const q = String(query ?? "").trim().toLowerCase();
        const hit = q
          ? all.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
          : all;
        const { rows, note } = trim(
          hit.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            unit: p.unit,
            listPrice: p.listPrice,
            isService: p.isService,
          })),
        );
        return textResult({ products: rows, ...(note ? { note } : {}) });
      },
    });
  }

  if (can("dashboard")) {
    tools.push({
      name: "get_dashboard_summary",
      description:
        "Business dashboard as of a date: monthly revenue/gross profit, cash position, AR/AP, open orders, pending approvals, overdue receivables. Requires manager/finance role (the server enforces ACL).",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: "object",
        properties: { asOf: { type: "string", description: "YYYY-MM-DD; default today" } },
      },
      async execute({ asOf }) {
        return textResult(await api.get(`/reports/dashboard?asOf=${String(asOf ?? today())}`));
      },
    });
  }

  if (can("reports")) {
    tools.push({
      name: "query_report",
      description:
        "Run a financial report. income_statement/cash_flow need from+to; balance_sheet/ar_aging need asOf. Amounts are in integer TWD.",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            enum: ["income_statement", "balance_sheet", "cash_flow", "ar_aging"],
          },
          from: { type: "string", description: "YYYY-MM-DD (period reports)" },
          to: { type: "string", description: "YYYY-MM-DD (period reports)" },
          asOf: { type: "string", description: "YYYY-MM-DD (point-in-time reports); default today" },
        },
        required: ["report"],
      },
      async execute({ report, from, to, asOf }) {
        const d = String(asOf ?? today());
        const paths: Record<string, string> = {
          income_statement: `/reports/income-statement?from=${String(from)}&to=${String(to)}`,
          cash_flow: `/reports/cash-flow?from=${String(from)}&to=${String(to)}`,
          balance_sheet: `/reports/balance-sheet?asOf=${d}`,
          ar_aging: `/reports/ar-aging?asOf=${d}`,
        };
        const path = paths[String(report)];
        if (!path) throw new Error(`Unknown report "${String(report)}"`);
        if ((report === "income_statement" || report === "cash_flow") && (!from || !to))
          throw new Error(`${String(report)} needs both "from" and "to" (YYYY-MM-DD).`);
        return textResult(await api.get(path));
      },
    });
  }

  if (can("orders")) {
    tools.push({
      name: "list_documents",
      description:
        "List sales documents: quotes (status open/won/lost) or orders (with shipping progress). Optionally filter by status.",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["quotes", "orders"] },
          status: { type: "string", description: "Optional status filter, e.g. open/won/lost" },
        },
        required: ["type"],
      },
      async execute({ type, status }) {
        const rows = await api.get<Array<Record<string, unknown>>>(
          type === "quotes" ? "/quotes" : "/orders",
        );
        const hit = status ? rows.filter((r) => r["status"] === status) : rows;
        const { rows: out, note } = trim(hit, 30);
        return textResult({ [String(type)]: out, ...(note ? { note } : {}) });
      },
    });

    // -- 草稿共編（寫入紅線的「草稿側」） --

    tools.push({
      name: "draft_quote",
      annotations: { untrustedContentHint: true },
      description:
        "Start a sales-quote DRAFT that you and the user edit together on screen. Fills a visible draft card field by field; does NOT create anything in the ERP. Resolve customer/products via search tools first if unsure. Prices are untaxed integer TWD; tax is computed by the system at submission per the company's tax parameters. After drafting, ask the user to review, then call submit_draft.",
      inputSchema: {
        type: "object",
        properties: {
          customer: { type: "string", description: "Customer name or id (must be an existing partner)" },
          quoteDate: { type: "string", description: "YYYY-MM-DD; default today" },
          expectedDate: { type: "string", description: "Expected delivery date YYYY-MM-DD (optional)" },
          memo: { type: "string" },
          lines: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                product: { type: "string", description: "Product name, SKU or id" },
                qty: { type: "number", exclusiveMinimum: 0 },
                unitPrice: {
                  type: "number",
                  minimum: 0,
                  description: "Untaxed unit price; omit to use the product's list price",
                },
              },
              required: ["product", "qty"],
            },
          },
        },
        required: ["customer", "lines"],
      },
      async execute(a) {
        const [partners, products] = await Promise.all([
          api.get<Partner[]>("/partners"),
          api.get<Product[]>("/products"),
        ]);
        const customers = partners.filter((p) => p.isCustomer);
        const partner = resolveByName(customers, String(a["customer"]), "customer");
        const lines = (a["lines"] as Array<{ product: string; qty: number; unitPrice?: number }>).map(
          (l) => {
            const prod = resolveByName(products, String(l.product), "product");
            const unitPrice = l.unitPrice ?? prod.listPrice;
            if (unitPrice === null || unitPrice === undefined)
              throw new Error(`"${prod.name}" has no list price — pass unitPrice explicitly.`);
            return {
              productId: prod.id,
              productName: prod.name,
              unit: prod.unit,
              qty: l.qty,
              unitPrice,
            };
          },
        );
        const draft: QuoteDraft = {
          id: newDraftId(),
          partnerId: partner.id,
          partnerName: partner.name,
          quoteDate: String(a["quoteDate"] ?? today()),
          ...(a["expectedDate"] ? { expectedDate: String(a["expectedDate"]) } : {}),
          ...(a["memo"] ? { memo: String(a["memo"]) } : {}),
          lines,
          lastEdit: { key: "all", actor: "agent", at: Date.now() },
        };
        setDraft(draft);
        deps.navigate("orders");
        return textResult({
          draft: {
            customer: partner.name,
            quoteDate: draft.quoteDate,
            lines: lines.map((l) => `${l.productName} × ${l.qty} @ ${l.unitPrice}`),
            subtotalUntaxed: draftSubtotal(draft),
          },
          next: "The draft card is now visible. Ask the user to review; adjust with update_draft_field; call submit_draft only when the user says go.",
        });
      },
    });

    // lineIndex 的上限是「活的」：草稿行數變 → schema 變 → 契約指紋變 → 只有這顆工具重新註冊。
    // 越界的行號因此在 schema 層就是不合法——agent 連「刪掉第 7 行」都說不出口，而不是說了被拒。
    const lineMax = deps.draftLines !== null && deps.draftLines > 0 ? deps.draftLines - 1 : undefined;
    tools.push({
      name: "update_draft_field",
      description:
        `Edit one field of the open quote draft (the user sees the change highlighted live, and may also edit fields themselves). Ops: set_date/set_expected_date/set_memo take value; set_line_qty/set_line_price take lineIndex(0-based)+qty|unitPrice; add_line takes product+qty(+unitPrice); remove_line takes lineIndex.` +
        (deps.draftLines === null
          ? " No draft is open right now — call draft_quote first."
          : ` The open draft currently has ${deps.draftLines} line(s).`),
      inputSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: [
              "set_date",
              "set_expected_date",
              "set_memo",
              "set_line_qty",
              "set_line_price",
              "add_line",
              "remove_line",
            ],
          },
          value: { type: "string" },
          lineIndex: { type: "integer", minimum: 0, ...(lineMax !== undefined ? { maximum: lineMax } : {}) },
          product: { type: "string" },
          qty: { type: "number", exclusiveMinimum: 0 },
          unitPrice: { type: "number", minimum: 0 },
        },
        required: ["op"],
      },
      async execute(a) {
        const d = getDraft();
        if (!d) throw new Error("No open draft. Call draft_quote first.");
        const op = String(a["op"]);
        const idx = a["lineIndex"] as number | undefined;
        const line = (need: boolean) => {
          if (!need) return null;
          if (idx === undefined || idx < 0 || idx >= d.lines.length)
            throw new Error(`lineIndex must be 0..${d.lines.length - 1}`);
          return idx;
        };
        switch (op) {
          case "set_date":
            editDraft("quoteDate", "agent", (x) => { x.quoteDate = String(a["value"]); });
            break;
          case "set_expected_date":
            editDraft("expectedDate", "agent", (x) => { x.expectedDate = String(a["value"]); });
            break;
          case "set_memo":
            editDraft("memo", "agent", (x) => { x.memo = String(a["value"]); });
            break;
          case "set_line_qty": {
            const i = line(true)!;
            editDraft(`line.${i}.qty`, "agent", (x) => { x.lines[i]!.qty = Number(a["qty"]); });
            break;
          }
          case "set_line_price": {
            const i = line(true)!;
            editDraft(`line.${i}.unitPrice`, "agent", (x) => { x.lines[i]!.unitPrice = Number(a["unitPrice"]); });
            break;
          }
          case "add_line": {
            const products = await api.get<Product[]>("/products");
            const prod = resolveByName(products, String(a["product"]), "product");
            const unitPrice = (a["unitPrice"] as number | undefined) ?? prod.listPrice;
            if (unitPrice === null || unitPrice === undefined)
              throw new Error(`"${prod.name}" has no list price — pass unitPrice explicitly.`);
            editDraft(`line.${d.lines.length}.qty`, "agent", (x) => {
              x.lines.push({
                productId: prod.id,
                productName: prod.name,
                unit: prod.unit,
                qty: Number(a["qty"]),
                unitPrice,
              });
            });
            break;
          }
          case "remove_line": {
            const i = line(true)!;
            editDraft("lines", "agent", (x) => { x.lines.splice(i, 1); });
            break;
          }
          default:
            throw new Error(`Unknown op "${op}"`);
        }
        const now = getDraft()!;
        return textResult({ ok: true, subtotalUntaxed: draftSubtotal(now), lines: now.lines.length });
      },
    });

    tools.push({
      name: "submit_draft",
      description:
        "Ask the user to approve the open quote draft. This is the ONLY way any draft reaches the ERP: an approval card pops up and the human decides. If approved, the quote is created and the draft closes; if declined, the draft stays open for further edits. Safe to retry after a timeout — a submission that already succeeded is replayed, not repeated. There are deliberately no tools for posting, approving or voiding documents.",
      annotations: { idempotentHint: true },
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const d = getDraft();
        if (!d) {
          // 冪等回放：agent 因 timeout 重試、但那次其實已經成功（草稿因此關了）——
          // 回放結果而不是叫它重新起草（那條路的終點是重複的報價單）
          const done = recentSubmission();
          if (done)
            return textResult({
              ok: true,
              alreadyCreated: done.created,
              note: "That draft was ALREADY submitted and approved moments ago — this is the result. Do not draft it again.",
            });
          refuse("no_draft", "No open draft.", "Call draft_quote first to start one.");
        }
        if (!d!.lines.length) refuse("empty_draft", "Draft has no lines.", "Add at least one line with update_draft_field (op add_line).");
        if (getApproval())
          refuse(
            "approval_pending",
            "An approval card is already on screen waiting for the human.",
            "Do not resubmit. Wait for the user's decision, then check the draft state with get_current_view.",
          );
        const draft = d!;
        // key 用中文原句：ApprovalCard 端會過 t()，中英文介面各自正確
        const approved = await requestApproval("要建立這張報價單嗎？", [
          ["客戶", draft.partnerName],
          ["報價日", draft.quoteDate],
          ["明細筆數", String(draft.lines.length)],
          ["未稅合計", `${draftSubtotal(draft).toLocaleString()} TWD`],
          ["稅額", "由系統於建立時計算"],
        ]);
        if (!approved) {
          logActivity({ actor: "human", tool: "submit_draft", summary: "declined", status: "error" });
          return textResult("The user DECLINED. The draft remains open — ask what to change.");
        }
        const created = await api.post("/quotes", {
          partnerId: draft.partnerId,
          quoteDate: draft.quoteDate,
          ...(draft.expectedDate ? { expectedDate: draft.expectedDate } : {}),
          ...(draft.memo ? { memo: draft.memo } : {}),
          lines: draft.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice })),
        });
        recordSubmission(draft.id, created);
        setDraft(null);
        logActivity({ actor: "human", tool: "submit_draft", summary: "approved ✓", status: "ok" });
        return textResult({ created, note: "Quote created after human approval." });
      },
    });

    tools.push({
      name: "discard_draft",
      description: "Close the open quote draft without creating anything.",
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: { type: "object", properties: {} },
      async execute() {
        if (!getDraft()) return textResult("No open draft.");
        setDraft(null);
        return textResult("Draft discarded.");
      },
    });
  }

  return tools.map(withLog);
}
