/**
 * LLM 供應商設定（單列表，見 migration 0021）。
 *
 * ⚠️ **本系統自己不呼叫任何 LLM。** 這張表存在的理由是「讓金鑰有一個統一的位置」——
 * 在此之前，跑在旁邊的 agent 要把供應商金鑰放在每個人自己的環境變數或設定檔裡，
 * 於是沒有人知道公司總共有幾把、放在哪、誰還留著。
 *
 * 因此這裡刻意**不驗證金鑰是否可用、不預設任何型號**：
 * - 驗證金鑰要打供應商的 API，那會讓「存個設定」變成一個會失敗、會計費、會超時的動作；
 * - 預設型號會過期，而過期的預設值比空值更難發現（空值會逼人去填，錯值不會）。
 * 系統提供的是保管與取用，不是判斷。這與稅率參數表是同一個紀律。
 */
import { schema } from "@tw-erp/db";
import { eq } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { decryptPii, encryptPii } from "./pii.ts";

/** 已知的供應商。custom 是逃生門——新供應商冒出來時不必等我們改程式。
 *  vertex-ai＝Vertex AI 的 express mode API key（靜態金鑰）；
 *  服務帳戶換 OAuth token 的模式刻意不支援——短期 token 與本表「存一把金鑰」的形狀不符 */
export const AGENT_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "vertex-ai",
  "azure-openai",
  "ollama",
  "custom",
] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface AgentSettingsView {
  provider: string;
  model: string;
  baseUrl: string | null;
  enabled: boolean;
  /** 金鑰**永不回傳明文**，只說有沒有設定；要換就整把重設 */
  hasApiKey: boolean;
  apiKeyHint: string | null; // 末四碼，讓人分得出換過沒
  updatedAt: Date | null;
}

function toView(row: typeof schema.agentSettings.$inferSelect): AgentSettingsView {
  // 解不開時不要讓整個設定頁 500——金鑰換過而舊值解不開，是「要重設」不是「壞掉」
  let hint: string | null = null;
  let hasKey = row.apiKey !== null && row.apiKey !== "";
  if (hasKey) {
    try {
      const plain = decryptPii(row.apiKey);
      hint = plain ? plain.slice(-4) : null;
    } catch {
      hint = null;
      hasKey = true;
    }
  }
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    hasApiKey: hasKey,
    apiKeyHint: hint,
    updatedAt: row.updatedAt,
  };
}

export async function getAgentSettings(db: Db): Promise<AgentSettingsView> {
  const [row] = await db.select().from(schema.agentSettings).where(eq(schema.agentSettings.id, 1));
  if (!row) throw new AppError(500, "agent_settings 沒有預設列（migration 0021 應已建立）");
  return toView(row);
}

/** 供 agent 執行期取用的明文金鑰。刻意獨立一支函式，呼叫點才數得出來 */
export async function getAgentApiKey(db: Db): Promise<string | null> {
  const [row] = await db.select().from(schema.agentSettings).where(eq(schema.agentSettings.id, 1));
  return row?.apiKey ? decryptPii(row.apiKey) : null;
}

export async function updateAgentSettings(
  db: Db,
  input: {
    provider?: string | undefined;
    model?: string | undefined;
    baseUrl?: string | null | undefined;
    apiKey?: string | null | undefined; // null＝清除；undefined＝不動
    enabled?: boolean | undefined;
  },
  updatedBy: number,
): Promise<AgentSettingsView> {
  const current = await getAgentSettings(db);
  const enabled = input.enabled ?? current.enabled;
  const model = input.model ?? current.model;
  const willHaveKey = input.apiKey === null ? false : input.apiKey ? true : current.hasApiKey;
  const provider = input.provider ?? current.provider;

  // 啟用時才擋。「存著還沒啟用的半套設定」是正常的工作中途狀態，不該被擋下來
  if (enabled) {
    if (!model.trim()) throw new AppError(422, "啟用前請填寫模型名稱（本系統不預設型號——寫死的型號會過期）");
    // ollama 與自架端點通常不需要金鑰
    if (!willHaveKey && provider !== "ollama" && provider !== "custom") {
      throw new AppError(422, `啟用前請填寫 ${provider} 的 API 金鑰`);
    }
  }

  const [row] = await db
    .update(schema.agentSettings)
    .set({
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.apiKey !== undefined
        ? { apiKey: input.apiKey === null ? null : (encryptPii(input.apiKey) ?? null) }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: new Date(),
      updatedBy,
    })
    .where(eq(schema.agentSettings.id, 1))
    .returning();
  return toView(row!);
}
