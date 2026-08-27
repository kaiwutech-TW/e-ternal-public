/**
 * WebMCP（navigator.modelContext）薄封裝：feature detection ＋ 以名稱為鍵的同步註冊。
 *
 * 規格是 W3C WebML CG 草案（https://github.com/webmachinelearning/webmcp）——
 * ChatGPT 內建瀏覽器原生支援；Chrome 146+ 藏在 flag 後面。瀏覽器沒有這個 API 時
 * 一律靜默略過，網站行為不受任何影響（漸進增強）。
 *
 * 這裡刻意不 re-export 任何 UI 概念：本檔只認識「工具」，
 * 活動紀錄與草稿狀態在 bus.ts，React 掛載在 WebMcp.tsx。
 */

export interface WebMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
}

export interface WebMcpTool {
  name: string;
  /** 給 agent 讀的說明——一律英文（評審與模型都是英語圈） */
  description: string;
  /** 標準 JSON Schema；省略＝無參數 */
  inputSchema?: Record<string, unknown>;
  /** readOnlyHint: true ＝ 不改狀態，agent 可免確認自由呼叫 */
  annotations?: { readOnlyHint?: boolean };
  execute(args: Record<string, unknown>): Promise<WebMcpToolResult>;
}

interface ModelContextLike {
  registerTool(tool: WebMcpTool): unknown;
  unregisterTool?(name: string): void;
  provideContext?(ctx: { tools: WebMcpTool[] }): void;
}

declare global {
  interface Navigator {
    modelContext?: ModelContextLike;
  }
}

export const hasWebMcp = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.modelContext;

/** 目前已註冊的工具名（unregisterTool 需要逐名移除時用） */
let registered = new Map<string, WebMcpTool>();

/**
 * 把「目前應該存在的工具集」整組同步給瀏覽器。
 * 動態註冊的核心：登入/登出、換頁、角色不同 → 呼叫端重算工具清單、丟進來即可。
 * 有 provideContext（原子替換）就用它；否則退回逐名 diff（先移除、再新增）。
 */
export function syncTools(tools: WebMcpTool[]): void {
  const mc = typeof navigator !== "undefined" ? navigator.modelContext : undefined;
  const next = new Map(tools.map((t) => [t.name, t]));
  if (!mc) {
    // 不支援 WebMCP：仍維護 registered，讓 window.webmcp 測試台可用
    registered = next;
    return;
  }

  if (typeof mc.provideContext === "function") {
    mc.provideContext({ tools });
    registered = next;
    return;
  }

  for (const name of registered.keys()) {
    if (!next.has(name)) {
      try {
        mc.unregisterTool?.(name);
      } catch {
        /* 已不存在就算了 */
      }
    }
  }
  for (const [name, tool] of next) {
    if (!registered.has(name)) {
      try {
        mc.registerTool(tool);
      } catch {
        /* 重複註冊等錯誤不擋網站本體 */
      }
    }
  }
  registered = next;
}

export function clearTools(): void {
  syncTools([]);
}

/**
 * Console 測試台：瀏覽器不支援 WebMCP 時也能手動驗證工具
 * （`webmcp.list()`／`await webmcp.execute("draft_quote", {...})`）。
 * 同源 console 本來就有頁面完整權限，這不放寬任何邊界。
 */
declare global {
  interface Window {
    webmcp?: {
      list(): Array<{ name: string; description: string; readOnly: boolean }>;
      execute(name: string, args?: Record<string, unknown>): Promise<string>;
    };
  }
}

if (typeof window !== "undefined") {
  window.webmcp = {
    list: () =>
      [...registered.values()].map((t) => ({
        name: t.name,
        description: t.description,
        readOnly: t.annotations?.readOnlyHint === true,
      })),
    execute: async (name, args = {}) => {
      const tool = registered.get(name);
      if (!tool) throw new Error(`No tool "${name}" — registered: ${[...registered.keys()].join(", ")}`);
      const out = await tool.execute(args);
      return out.content.map((c) => c.text).join("\n");
    },
  };
}

/** 工具回傳統一走這裡：物件 → 縮排 JSON 文字（agent 端模型自行解讀） */
export function textResult(value: unknown): WebMcpToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: "text", text }] };
}
