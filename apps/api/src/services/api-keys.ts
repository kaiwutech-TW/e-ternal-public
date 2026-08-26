/**
 * API 金鑰：讓 agent／腳本以機器身分呼叫 API（設計紀律見 migration 0021）。
 *
 * 一句話版本：**金鑰不是新的權限模型，是新的登入方式**。
 * 解析成功後回傳的就是一般的 AuthUser，之後走完全相同的 ACL 與操作日誌——
 * 要限制 agent 能做什麼，做法是給它一個角色受限的專用帳號，不是在金鑰上長出 scope。
 */
import { randomBytes } from "node:crypto";
import { schema } from "@tw-erp/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { hashPassword, verifyPassword, type AuthUser } from "./auth.ts";

/** 前綴讓人一眼看出這是什麼東西——貼錯地方（commit、Slack）時搜尋得到 */
const KEY_PREFIX = "twerp_sk_";
const PREFIX_LEN = 8;

export interface NewKeyResult {
  id: number;
  name: string;
  /** 明文金鑰。**只在這一次回傳**，資料庫只有雜湊 */
  key: string;
}

export async function createApiKey(
  db: Db,
  input: { name: string; userId: number; createdBy: number },
): Promise<NewKeyResult> {
  const [target] = await db.select().from(schema.users).where(eq(schema.users.id, input.userId));
  if (!target) throw new AppError(404, `使用者不存在: ${input.userId}`);
  if (!target.active) throw new AppError(422, "不能為已停用的帳號建立金鑰");

  const secret = randomBytes(24).toString("base64url");
  const key = `${KEY_PREFIX}${secret}`;
  const [row] = await db
    .insert(schema.apiKeys)
    .values({
      name: input.name,
      prefix: secret.slice(0, PREFIX_LEN),
      keyHash: hashPassword(key),
      userId: input.userId,
      createdBy: input.createdBy,
    })
    .returning();
  return { id: row!.id, name: row!.name, key };
}

/**
 * 從 Authorization 標頭解析出使用者。認不出來一律回 null（呼叫端轉 401）——
 * 不區分「格式不對」「查無此鑰」「已撤銷」，那些差別只對攻擊者有價值。
 *
 * 效能備忘：每把未撤銷的金鑰各跑一次 scrypt。金鑰數量是「幾把」的量級（不是幾千），
 * 而 scrypt 的成本正是防暴力猜測的來源，所以不做「先查前綴再驗」的優化——
 * 那會把比對從常數時間變成可用前綴枚舉的形狀。
 */
export async function userFromApiKey(db: Db, header: string | undefined): Promise<AuthUser | null> {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!token || !token.startsWith(KEY_PREFIX)) return null;

  const rows = await db
    .select({ key: schema.apiKeys, user: schema.users })
    .from(schema.apiKeys)
    .innerJoin(schema.users, eq(schema.apiKeys.userId, schema.users.id))
    .where(and(isNull(schema.apiKeys.revokedAt), eq(schema.users.active, true)));

  for (const row of rows) {
    if (!verifyPassword(token, row.key.keyHash)) continue;
    // last_used_at 是「這把金鑰還活著嗎」的唯一線索，撤銷舊金鑰時要靠它判斷
    await db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.key.id));
    return {
      id: row.user.id,
      username: row.user.username,
      displayName: row.user.displayName,
      role: row.user.role,
      employeeId: row.user.employeeId,
      totpEnabled: row.user.totpEnabledAt !== null,
    };
  }
  return null;
}

/** 列表刻意不含 key_hash：那是雜湊，但沒有任何畫面需要它 */
export async function listApiKeys(db: Db) {
  return db
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      prefix: schema.apiKeys.prefix,
      userId: schema.apiKeys.userId,
      createdAt: schema.apiKeys.createdAt,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      revokedAt: schema.apiKeys.revokedAt,
    })
    .from(schema.apiKeys)
    .orderBy(desc(schema.apiKeys.id));
}

/** 撤銷不刪除：刪掉就查不出「這把金鑰做過什麼」，而那正是出事時唯一要問的問題 */
export async function revokeApiKey(db: Db, id: number): Promise<void> {
  const [row] = await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)))
    .returning();
  if (!row) throw new AppError(404, `金鑰不存在或已撤銷: ${id}`);
}
