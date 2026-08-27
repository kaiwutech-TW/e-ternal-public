/**
 * 內建 agent 執行層 Phase 1（DECISIONS 2026-08-13）：聊天 → tool-use 迴圈 → 打自己的 REST API。
 *
 * ★ 責任紅線（不是自律，是結構）：工具集只有**讀取**與**產生草稿/待簽核**的動作——
 *   核准、過帳、出貨、發薪定案這類「落地」端點根本不在工具清單裡，agent 想繞也沒有門。
 *   草稿建好後由該負責的人在原本的頁面按原本的核准鈕；操作日誌記的是按的人。
 *
 * ★ 權限與稽核零新增：工具執行＝以**目前登入者**的身分對本 app 內部發請求
 *   （帶原 cookie／Authorization 走完整 middleware）——ACL default-deny 與
 *   「所有非 GET 進操作日誌」原樣生效。agent 查不到的東西就是那個人查不到的東西。
 *
 * ★ LLM 供應商：anthropic 走 Messages API；openai／azure-openai／ollama／custom 走
 *   OpenAI 相容 chat/completions（後三者需自填 baseUrl）。金鑰取自 agent_settings
 *   （settings 頁管理，永不下發前端）。系統不預設型號——與 agent-settings 同一紀律。
 */
import type { Locale } from "@tw-erp/core";
import { AppError, type Db } from "../db.ts";
import { getAgentApiKey, getAgentSettings } from "./agent-settings.ts";

// ── 對話與工具的內部表示（以 Anthropic content-block 形狀為準，OpenAI 端轉換）──

interface TextBlock {
  type: "text";
  text: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Gemini 思考模型的 thought_signature：回應帶來、重播歷史時必須原樣帶回去
   *（缺了會 400「missing a thought_signature」）。其他供應商忽略此欄 */
  signature?: string | undefined;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
interface Turn {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema（手寫——工具少，抽象層比清單本身還長就虧了）
}

export interface LlmResult {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown>; signature?: string | undefined }[];
}

/** LLM 一輪呼叫。抽成型別是為了測試可換成腳本（不打真供應商） */
export type LlmCall = (req: { system: string; turns: Turn[]; tools: AgentToolDef[] }) => Promise<LlmResult>;

/** 工具執行端：由路由注入「以目前登入者身分打內部 API」的函式 */
export type ApiFetch = (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; text: string }>;

export interface AgentStep {
  tool: string;
  summary: string;
  ok: boolean;
}

// ── 工具清單（紅線的實體：只有這些門）──

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: "api_get",
    description:
      "以目前使用者的身分讀取 ERP API（僅 GET）。權限由登入角色決定：403 代表這個帳號本來就看不到，照實告訴使用者即可。常用端點：" +
      "/partners 交易對象、/products 商品、/inventory 庫存、/quotes 報價、/orders 訂單、/purchase-orders 採購、" +
      "/sales 銷貨、/purchases 進貨、/expense-claims 報銷、/contracts 合約、" +
      "/contracts/billing-due?within=30 合約待請款與待付款、/contracts/expiring 快到期的合約、" +
      "/recurring-payables 固定支出（房租、訂閱、保費等使用者自建的週期性支出）、" +
      "/recurring-payables/due?within=30 接近付款日的固定支出（**這些日期都是使用者自己設的，" +
      "不是法定期限；系統不知道也不得推測任何申報或繳費時間**）、" +
      "/reports/dashboard?asOf=YYYY-MM-DD 經營儀表板（本月營收/毛利/現金）、/reports/income-statement?from=&to= 損益表、" +
      "/reports/balance-sheet?asOf= 資產負債表、/reports/cash-flow?from=&to= 現金流量、/reports/ar-aging?asOf= 應收帳齡、" +
      "/attendance/my 我的出勤、/attendance/my-balances?year= 我的假別額度、/attendance/summary?month=YYYY-MM 全員月出勤彙總、" +
      "/leave-types 假別、/leave-balances?year= 全員額度、/hr-requests/my 我的申請、/hr-requests?status= 申請單總覽、" +
      "/employee-salaries 薪資檔、/payroll-runs 發薪作業、/journal-entries 傳票、/trial-balance 試算表",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "以 / 開頭的 API 路徑，可帶查詢字串" } },
      required: ["path"],
    },
  },
  {
    name: "create_quote",
    description:
      "建立報價單（草稿）。這不是成交——成交轉訂單、出貨、開發票都由業務自己在系統操作。金額為未稅整數元，稅由系統依日期套用使用者設定的稅率。",
    inputSchema: {
      type: "object",
      properties: {
        partnerId: { type: "integer", description: "客戶 id（先用 api_get /partners 查）" },
        quoteDate: { type: "string", description: "報價日 YYYY-MM-DD" },
        memo: { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              productId: { type: "integer" },
              qty: { type: "number" },
              unitPrice: { type: "number", description: "未稅單價" },
            },
            required: ["productId", "qty", "unitPrice"],
          },
          minItems: 1,
        },
      },
      required: ["partnerId", "quoteDate", "lines"],
    },
  },
  {
    name: "create_hr_request",
    description:
      "替目前使用者送出請假／加班／忘打卡申請（進簽核鏈，主管核准才生效）。請假需 leaveTypeId（api_get /leave-types 查）＋startAt/endAt（ISO 含時區）＋minutes；" +
      "加班需 workDate＋dayType（workday 平日/restday 休息日/regular_off 例假日/holiday 國定假日——問使用者那天是哪種，不要自己判斷）＋minutes；" +
      "忘打卡需 workDate＋direction（in/out）＋claimedTime（HH:MM）。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["leave", "overtime", "punch_correction"] },
        reason: { type: "string" },
        leaveTypeId: { type: "integer" },
        startAt: { type: "string" },
        endAt: { type: "string" },
        minutes: { type: "integer" },
        dayType: { type: "string", enum: ["workday", "restday", "regular_off", "holiday"] },
        workDate: { type: "string" },
        direction: { type: "string", enum: ["in", "out"] },
        claimedTime: { type: "string" },
      },
      required: ["kind"],
    },
  },
  {
    name: "read_memory",
    description: "讀一條公司記憶的全文。system prompt 裡的「公司記憶索引」列出所有可讀的 name。",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "search_memories",
    description: "用關鍵字搜尋公司記憶（索引裡找不到、但覺得公司可能教過相關事情時用）。",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "propose_memory",
    description:
      "把使用者教你的公司事實**提議**成一條新記憶（例：「我們週六是休息日」）。提議不會立即生效——" +
      "管理者在設定頁核准後才會進入之後對話的索引；提議完要告訴使用者「已提議，等管理者核准」。" +
      "name 用 kebab-case 英數；title 是一行摘要（索引只顯示它）；只記公司層級、之後對話用得上的事實，不記一次性數字。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case 代號，如 saturday-is-restday" },
        title: { type: "string", description: "一行摘要" },
        body: { type: "string", description: "完整內容（markdown 可）" },
        tags: { type: "string", description: "逗號分隔" },
        staleAfter: { type: "string", description: "YYYY-MM-DD，會過期的事實才填（如年度行事曆）" },
      },
      required: ["name", "title", "body"],
    },
  },
  {
    name: "read_guide",
    description: "讀一份系統操作指南全文（流程怎麼串、哪個動作產生哪張傳票）。索引見 system prompt 的「操作指南索引」。",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

/** 記憶與指南的執行端（由路由注入——服務直呼，不走 per-user ACL：公司記憶本來就是全員 agent 共用） */
export interface KnowledgeOps {
  readMemory: (name: string) => Promise<string | null>;
  searchMemories: (query: string) => Promise<{ name: string; title: string; snippet: string }[]>;
  proposeMemory: (input: { name: string; title: string; body: string; tags?: string | undefined; staleAfter?: string | undefined }) => Promise<string>;
  readGuide: (name: string) => string | null;
}

const TOOL_POST_PATH: Record<string, string> = {
  create_quote: "/quotes",
  create_hr_request: "/hr-requests",
};

async function executeTool(
  api: ApiFetch,
  ops: KnowledgeOps,
  name: string,
  input: Record<string, unknown>,
): Promise<{ result: string; ok: boolean; summary: string }> {
  if (name === "read_memory") {
    const key = String(input["name"] ?? "");
    const body = await ops.readMemory(key);
    return body
      ? { result: body, ok: true, summary: `讀取記憶 ${key}` }
      : { result: `沒有叫 ${key} 的生效記憶（索引見 system prompt；或用 search_memories 找）`, ok: false, summary: `讀取記憶 ${key}` };
  }
  if (name === "search_memories") {
    const q = String(input["query"] ?? "");
    const hits = await ops.searchMemories(q);
    return { result: hits.length ? JSON.stringify(hits, null, 1) : "沒有找到相關記憶", ok: true, summary: `搜尋記憶「${q}」` };
  }
  if (name === "propose_memory") {
    try {
      const msg = await ops.proposeMemory({
        name: String(input["name"] ?? ""),
        title: String(input["title"] ?? ""),
        body: String(input["body"] ?? ""),
        tags: input["tags"] !== undefined ? String(input["tags"]) : undefined,
        staleAfter: input["staleAfter"] !== undefined ? String(input["staleAfter"]) : undefined,
      });
      return { result: msg, ok: true, summary: `提議記憶 ${String(input["name"])}（待核准）` };
    } catch (e) {
      return { result: (e as Error).message, ok: false, summary: `提議記憶 ${String(input["name"])}` };
    }
  }
  if (name === "read_guide") {
    const key = String(input["name"] ?? "");
    const body = ops.readGuide(key);
    return body
      ? { result: body, ok: true, summary: `讀取指南 ${key}` }
      : { result: `沒有叫 ${key} 的指南（索引見 system prompt）`, ok: false, summary: `讀取指南 ${key}` };
  }
  if (name === "api_get") {
    const path = String(input["path"] ?? "");
    // 只放行站內相對路徑：擋協定/主機（SSRF）與路徑跳脫
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
      return { result: "path 必須是以 / 開頭的站內 API 路徑", ok: false, summary: `api_get ${path}` };
    }
    const res = await api(path);
    return { result: res.text.slice(0, 30_000), ok: res.status < 400, summary: `讀取 ${path}` };
  }
  const postPath = TOOL_POST_PATH[name];
  if (postPath) {
    const body: Record<string, unknown> = { ...input };
    const res = await api(postPath, { method: "POST", body: JSON.stringify(body) });
    const label = name === "create_quote" ? "建立報價草稿" : "送出申請單";
    return { result: res.text.slice(0, 10_000), ok: res.status < 400, summary: label };
  }
  return { result: `未知的工具: ${name}`, ok: false, summary: name };
}

// ── LLM 供應商轉接 ──

function anthropicCall(apiKey: string, model: string, baseUrl: string | null): LlmCall {
  return async ({ system, turns, tools }) => {
    const res = await fetch(`${baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system,
        messages: turns,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      }),
    });
    const data = (await res.json()) as {
      content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new AppError(502, `LLM 供應商回應錯誤（${res.status}）：${data.error?.message ?? "未知錯誤"}。請到「設定 → Agent 接入」檢查型號與金鑰`);
    }
    const blocks = data.content ?? [];
    return {
      text: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      toolCalls: blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} })),
    };
  };
}

/** OpenAI 相容 chat/completions：openai／google（Gemini API key）／azure-openai／ollama／custom。
 *  endpoint 收完整 URL——Gemini 的相容端點路徑不是 /v1/chat/completions，硬拼會 404 */
function openaiCall(apiKey: string | null, model: string, endpoint: string): LlmCall {
  return async ({ system, turns, tools }) => {
    // 內部 content-block 轉 OpenAI 訊息形狀
    const messages: Record<string, unknown>[] = [{ role: "system", content: system }];
    for (const t of turns) {
      if (t.role === "assistant") {
        const text = t.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
        const calls = t.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        messages.push({
          role: "assistant",
          content: text || null,
          ...(calls.length
            ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
            : {}),
        });
      } else {
        const results = t.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
        if (results.length) {
          for (const r of results) messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
        } else {
          messages.push({ role: "user", content: t.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("") });
        }
      }
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      }),
    });
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new AppError(502, `LLM 供應商回應錯誤（${res.status}）：${data.error?.message ?? "未知錯誤"}。請到「設定 → Agent 接入」檢查型號與金鑰`);
    }
    const msg = data.choices?.[0]?.message;
    return {
      text: msg?.content ?? "",
      toolCalls: (msg?.tool_calls ?? []).map((c) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          /* 供應商偶爾回壞 JSON——當空參數，工具端會回可讀錯誤 */
        }
        return { id: c.id, name: c.function.name, input };
      }),
    };
  };
}

// ── Gemini 原生 generateContent（google＝Gemini API key；vertex-ai＝Vertex express mode API key）──

/** 內部 turns → Gemini request body（抽成純函式讓轉換邏輯可測：functionCall 沒有 id，
 *  functionResponse 要靠「上一輪 assistant 的 tool_use id→name 對照」補回名字） */
export function toGeminiBody(system: string, turns: Turn[], tools: AgentToolDef[]): Record<string, unknown> {
  const idToName = new Map<string, string>();
  for (const t of turns) {
    for (const b of t.content) if (b.type === "tool_use") idToName.set(b.id, b.name);
  }
  const contents = turns.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: t.content.map((b) => {
      if (b.type === "text") return { text: b.text };
      if (b.type === "tool_use") {
        return { functionCall: { name: b.name, args: b.input }, ...(b.signature ? { thoughtSignature: b.signature } : {}) };
      }
      return {
        functionResponse: {
          name: idToName.get(b.tool_use_id) ?? "unknown",
          // response 必須是物件——工具回的是字串，包一層
          response: { result: b.content, ...(b.is_error ? { isError: true } : {}) },
        },
      };
    }),
  }));
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }],
  };
}

function geminiCall(apiKey: string, model: string, endpoint: string): LlmCall {
  return async ({ system, turns, tools }) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(toGeminiBody(system, turns, tools)),
    });
    const data = (await res.json()) as {
      candidates?: {
        content?: {
          parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }[];
        };
      }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new AppError(502, `LLM 供應商回應錯誤（${res.status}）：${data.error?.message ?? "未知錯誤"}。請到「設定 → Agent 接入」檢查型號與金鑰`);
    }
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    let seq = 0;
    return {
      text: parts.filter((p) => p.text).map((p) => p.text).join(""),
      // Gemini 的 functionCall 沒有 id——自造一個穩定序號讓迴圈的 tool_result 對得回來
      toolCalls: parts
        .filter((p) => p.functionCall)
        .map((p) => ({
          id: `g${++seq}-${p.functionCall!.name}`,
          name: p.functionCall!.name,
          input: p.functionCall!.args ?? {},
          signature: p.thoughtSignature,
        })),
    };
  };
}

export async function resolveLlm(db: Db): Promise<LlmCall> {
  const settings = await getAgentSettings(db);
  if (!settings.enabled) {
    throw new AppError(422, "內建助理尚未啟用。請管理者到「設定 → Agent 接入」選供應商、填型號與金鑰並啟用");
  }
  const apiKey = await getAgentApiKey(db);
  if (settings.provider === "anthropic") {
    if (!apiKey) throw new AppError(422, "anthropic 需要 API 金鑰（設定 → Agent 接入）");
    return anthropicCall(apiKey, settings.model, settings.baseUrl);
  }
  if (settings.provider === "google") {
    // Gemini API key（AI Studio 金鑰）：原生 generateContent
    if (!apiKey) throw new AppError(422, "google（Gemini API key）需要 API 金鑰（設定 → Agent 接入）");
    const base = (settings.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    return geminiCall(apiKey, settings.model, `${base}/v1beta/models/${settings.model}:generateContent`);
  }
  if (settings.provider === "vertex-ai") {
    // Vertex AI **express mode API key**（靜態金鑰）：同 generateContent 形狀、不同主機。
    // 使用者選 Vertex 通常是為了企業資料隱私條款——本系統不斷言條款內容，請自行確認合約。
    // 服務帳戶換 OAuth token 的模式不支援（短期 token 與「存一把金鑰」的形狀不符）
    if (!apiKey) throw new AppError(422, "vertex-ai 需要 Vertex AI express mode 的 API 金鑰（設定 → Agent 接入）。服務帳戶 OAuth 認證不支援");
    const base = (settings.baseUrl ?? "https://aiplatform.googleapis.com").replace(/\/$/, "");
    return geminiCall(apiKey, settings.model, `${base}/v1beta1/publishers/google/models/${settings.model}:generateContent`);
  }
  const baseUrl = settings.provider === "openai" ? (settings.baseUrl ?? "https://api.openai.com") : settings.baseUrl;
  if (!baseUrl) {
    throw new AppError(422, `${settings.provider} 需要在「設定 → Agent 接入」填 Base URL（OpenAI 相容端點）`);
  }
  return openaiCall(apiKey, settings.model, `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`);
}

// ── 主迴圈 ──

const MAX_ROUNDS = 8;

export interface ChatInputMessage {
  role: "user" | "assistant";
  content: string;
}

export async function runAgentChat(input: {
  llm: LlmCall;
  /** 回覆語言（路由端從 Accept-Language 判定）；缺＝繁體中文 */
  locale?: Locale;
  api: ApiFetch;
  ops: KnowledgeOps;
  /** 依角色與資料庫現況組出的上下文（路由端組裝，服務端不碰 db） */
  context: { featureMap: string; memoryIndex: string; guideIndex: string };
  messages: ChatInputMessage[]; // 歷史（純文字）＋最新一句在最後
  user: { displayName: string; role: string };
}): Promise<{ reply: string; steps: AgentStep[] }> {
  const today = new Date().toISOString().slice(0, 10);
  const system =
    `你是 E-ternal ERP 的內建助理。今天是 ${today}。目前使用者：${input.user.displayName}（角色 ${input.user.role}）。\n` +
    `- 數字一律用工具查，查不到或 403 就照實說，絕不編造。\n` +
    `- 你只能建立「草稿／待簽核」的東西（報價單、請假/加班/補卡申請）。核准、過帳、出貨、關帳、發薪定案一律由人在系統裡自己操作——這是本系統的責任紅線：agent 不能負人類世界的責任。使用者要求你核准或過帳時，指引他去對應頁面按，不要嘗試代做。\n` +
    `- 涉及稅務或勞動法規的數字（稅率、倍率、額度天數），本系統與你都不斷言——引導使用者自行查證後填入對應設定頁。\n` +
    `- 使用者教你公司層級的事實時，用 propose_memory 提議記下來（生效要管理者核准）。\n` +
    (input.locale === "en"
      ? `- Reply in English (the user's interface language). Be concise and direct; format amounts with thousands separators. Tool results and guides are in Traditional Chinese—translate what the user needs, keep document numbers and account codes verbatim.\n\n`
      : `- 回覆用繁體中文，精簡直接，金額加千分位。\n\n`) +
    `## 這位使用者看得到的功能（角色地圖）\n${input.context.featureMap}\n\n` +
    `## 操作指南索引（詳情用 read_guide 讀）\n${input.context.guideIndex}` +
    (input.context.memoryIndex ? `\n\n## 公司記憶索引（詳情用 read_memory 讀）\n${input.context.memoryIndex}` : "");
  const turns: Turn[] = input.messages.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] }));
  const steps: AgentStep[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await input.llm({ system, turns, tools: AGENT_TOOLS });
    const assistantBlocks: ContentBlock[] = [
      ...(res.text ? [{ type: "text", text: res.text } as TextBlock] : []),
      ...res.toolCalls.map((c): ToolUseBlock => ({ type: "tool_use", id: c.id, name: c.name, input: c.input, signature: c.signature })),
    ];
    turns.push({ role: "assistant", content: assistantBlocks });
    if (res.toolCalls.length === 0) {
      return { reply: res.text || "（助理沒有回覆內容）", steps };
    }
    const resultBlocks: ToolResultBlock[] = [];
    for (const call of res.toolCalls) {
      const { result, ok, summary } = await executeTool(input.api, input.ops, call.name, call.input);
      steps.push({ tool: call.name, summary, ok });
      resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: result, is_error: !ok });
    }
    turns.push({ role: "user", content: resultBlocks });
  }
  return {
    reply: "工具呼叫次數達到單輪上限，先停在這裡。目前查到/做到的內容如上；請把問題拆小一點再問我。",
    steps,
  };
}
