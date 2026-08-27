/**
 * 內建 agent 的公司記憶（0043）：OKF 形狀、propose→approve、索引注入＋按名讀取＋關鍵字搜尋。
 * 設計紀律見 migration 檔頭；成長迴圈與責任紅線同構——agent 提議，人核准才生效。
 */
import { schema } from "@tw-erp/db";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface MemoryInput {
  name: string;
  title: string;
  body: string;
  type?: string | undefined;
  tags?: string | undefined;
  staleAfter?: string | null | undefined;
}

function assertShape(input: MemoryInput): void {
  if (!SLUG.test(input.name)) {
    throw new AppError(422, "記憶代號須為 kebab-case 英數（2-64 字，如 saturday-is-restday），收到「{raw}」", { raw: input.name });
  }
  if (!input.title.trim()) throw new AppError(422, "記憶必須有一行摘要（title）——索引只放摘要，寫得好壞決定助理找不找得到");
  if (!input.body.trim()) throw new AppError(422, "記憶內容（body）不可為空");
  if (input.staleAfter != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.staleAfter)) {
    throw new AppError(422, "到期日格式須為 YYYY-MM-DD（收到「{raw}」）", { raw: input.staleAfter });
  }
}

/** admin 直接建（立即生效）或 agent 提議（等核准） */
export async function createMemory(
  db: Db,
  input: MemoryInput,
  userId: number,
  mode: "active" | "proposed",
  source: "user" | "agent",
) {
  assertShape(input);
  const [dup] = await db.select({ id: schema.agentMemories.id }).from(schema.agentMemories).where(eq(schema.agentMemories.name, input.name));
  if (dup) throw new AppError(409, "記憶代號已存在: {name}（要修改內容請編輯既有那一條）", { name: input.name });
  const [row] = await db
    .insert(schema.agentMemories)
    .values({
      name: input.name,
      title: input.title.trim(),
      body: input.body,
      type: input.type ?? "fact",
      tags: input.tags ?? "",
      status: mode,
      source,
      staleAfter: input.staleAfter ?? null,
      proposedBy: userId,
      ...(mode === "active" ? { approvedBy: userId } : {}),
    })
    .returning();
  return row!;
}

export async function listMemories(db: Db, status?: string) {
  const rows = await db
    .select()
    .from(schema.agentMemories)
    .where(status ? eq(schema.agentMemories.status, status) : undefined)
    .orderBy(asc(schema.agentMemories.status), asc(schema.agentMemories.name));
  const users = await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users);
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));
  const t = today();
  return rows.map((r) => ({
    ...r,
    proposedByName: r.proposedBy ? (nameOf.get(r.proposedBy) ?? null) : null,
    approvedByName: r.approvedBy ? (nameOf.get(r.approvedBy) ?? null) : null,
    /** 過期＝退出索引、管理頁標示待覆核（記憶不汰舊會爛掉） */
    expired: r.staleAfter !== null && r.staleAfter < t,
  }));
}

export async function updateMemory(
  db: Db,
  id: number,
  patch: { title?: string | undefined; body?: string | undefined; type?: string | undefined; tags?: string | undefined; staleAfter?: string | null | undefined },
) {
  const [row] = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.id, id));
  if (!row) throw new AppError(404, "記憶不存在: {id}", { id });
  if (patch.staleAfter != null && !/^\d{4}-\d{2}-\d{2}$/.test(patch.staleAfter)) {
    throw new AppError(422, "到期日格式須為 YYYY-MM-DD（收到「{raw}」）", { raw: patch.staleAfter });
  }
  const [updated] = await db
    .update(schema.agentMemories)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.staleAfter !== undefined ? { staleAfter: patch.staleAfter } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.agentMemories.id, id))
    .returning();
  return updated!;
}

export async function approveMemory(db: Db, id: number, userId: number) {
  const [row] = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.id, id));
  if (!row) throw new AppError(404, "記憶不存在: {id}", { id });
  if (row.status !== "proposed") throw new AppError(422, "只有「待核准」的記憶可以核准（目前狀態: {status}）", { status: row.status });
  const [updated] = await db
    .update(schema.agentMemories)
    .set({ status: "active", approvedBy: userId, updatedAt: new Date() })
    .where(eq(schema.agentMemories.id, id))
    .returning();
  return updated!;
}

/** 生效的記憶不刪列——封存（OKF 紀律：status 是歷史的一部分）。待核准的垃圾可直接刪 */
export async function archiveMemory(db: Db, id: number) {
  const [updated] = await db
    .update(schema.agentMemories)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(schema.agentMemories.id, id))
    .returning();
  if (!updated) throw new AppError(404, "記憶不存在: {id}", { id });
  return updated;
}

export async function deleteMemory(db: Db, id: number) {
  const [row] = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.id, id));
  if (!row) throw new AppError(404, "記憶不存在: {id}", { id });
  if (row.status !== "proposed") {
    throw new AppError(422, "只有「待核准」的記憶可以刪除；已生效的請用封存——狀態是歷史的一部分，不刪列");
  }
  await db.delete(schema.agentMemories).where(eq(schema.agentMemories.id, id));
  return { ok: true };
}

// ── agent 取用面（索引注入＋按名讀取＋關鍵字搜尋）──

/** 注入 system prompt 的索引：active 且未過期。一條一行，幾百條也才幾 KB */
export async function memoryIndex(db: Db): Promise<string> {
  const rows = await db
    .select({ name: schema.agentMemories.name, title: schema.agentMemories.title, staleAfter: schema.agentMemories.staleAfter })
    .from(schema.agentMemories)
    .where(eq(schema.agentMemories.status, "active"))
    .orderBy(asc(schema.agentMemories.name));
  const t = today();
  const fresh = rows.filter((r) => r.staleAfter === null || r.staleAfter >= t);
  if (!fresh.length) return "";
  return fresh.map((r) => `- ${r.name}：${r.title}`).join("\n");
}

export async function readMemory(db: Db, name: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(schema.agentMemories)
    .where(and(eq(schema.agentMemories.name, name), eq(schema.agentMemories.status, "active")));
  if (!row) return null;
  const t = today();
  const staleNote = row.staleAfter !== null && row.staleAfter < t ? `\n⚠️ 本條已過期（stale_after: ${row.staleAfter}），內容可能不再成立。` : "";
  return `# ${row.title}\ntype: ${row.type}${row.tags ? `\ntags: ${row.tags}` : ""}\n\n${row.body}${staleNote}`;
}

export async function searchMemories(db: Db, query: string) {
  const q = `%${query.trim()}%`;
  const rows = await db
    .select({ name: schema.agentMemories.name, title: schema.agentMemories.title, body: schema.agentMemories.body })
    .from(schema.agentMemories)
    .where(
      and(
        eq(schema.agentMemories.status, "active"),
        or(
          ilike(schema.agentMemories.name, q),
          ilike(schema.agentMemories.title, q),
          ilike(schema.agentMemories.tags, q),
          ilike(schema.agentMemories.body, q),
        ),
      ),
    )
    .orderBy(asc(schema.agentMemories.name))
    .limit(8);
  return rows.map((r) => ({ name: r.name, title: r.title, snippet: r.body.slice(0, 120) }));
}

/** 一次撈完管理頁要的統計＋過期待覆核清單（設定頁的紅點） */
export async function memoryStats(db: Db) {
  const rows = await db
    .select({ status: schema.agentMemories.status, staleAfter: schema.agentMemories.staleAfter })
    .from(schema.agentMemories)
    .where(inArray(schema.agentMemories.status, ["proposed", "active"]));
  const t = today();
  return {
    proposed: rows.filter((r) => r.status === "proposed").length,
    active: rows.filter((r) => r.status === "active").length,
    expired: rows.filter((r) => r.status === "active" && r.staleAfter !== null && r.staleAfter < t).length,
  };
}
