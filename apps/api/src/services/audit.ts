/**
 * 操作日誌的寫入與查詢（設計紀律見 packages/db/migrations/0018_audit_log.sql）。
 *
 * 一句話版本：**預設什麼都不記，只記結構性的事實**——誰、什麼時候、什麼方法打了哪個路徑、
 * 結果是幾號狀態碼。請求內容一律不進來，因為 body 裡有密碼與身分證號，
 * 而用關鍵字過濾敏感欄位是失敗開放的設計（新增一個 PII 欄位就自動外洩，且日誌刻意不刪）。
 */
import { schema } from "@tw-erp/db";
import type { Role } from "@tw-erp/core";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db.ts";

export interface AuditEntry {
  userId: number | null;
  username: string;
  role: Role | null;
  method: string;
  path: string;
  status: number;
  source: string;
  targetId: number | null;
  note: string;
}

/**
 * 寫一筆日誌。**永遠不讓寫日誌失敗變成使用者的錯誤**——
 * 日誌是旁觀者，它壞掉不該把一筆已經成功的進貨單變成 500。
 * 但也不能安靜吞掉：吞掉的下場是某天發現日誌空了三個月而沒有人知道，
 * 所以失敗一律印到 stderr（容器日誌看得到）。
 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(schema.auditLogs).values(entry);
  } catch (err) {
    console.error("[audit] 寫入操作日誌失敗（請求本身不受影響）:", err);
  }
}

/**
 * 哪些請求要記。
 *
 * - 所有非 GET：這是「改變了什麼」的全集。含 4xx／5xx——**被擋下的嘗試才是安全上最該看的**。
 * - GET 只記白名單：日誌不是流量紀錄，把每次翻頁都記下來只會把真正的事件淹掉。
 *   目前白名單只有一條：身分證號的單筆明文查詢（PII，誰看過必須查得到）。
 */
const AUDITED_GETS: RegExp[] = [/^\/partners\/\d+\/id-no$/];

export function shouldAudit(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return true;
  return method === "GET" && AUDITED_GETS.some((re) => re.test(path));
}

/**
 * 從回應取 target_id：**只認 201 建立成功、且 body 是一個帶數字 id 的物件**。
 * 只抓 id 這一個欄位是白名單而非過濾——回應 body 同樣可能含 PII
 * （/partners/:id/id-no 回的就是身分證號），整包存下來會把 0018 的紀律一整條作廢。
 */
export async function targetIdOf(res: Response): Promise<number | null> {
  if (res.status !== 201) return null;
  if (!res.headers.get("content-type")?.includes("application/json")) return null;
  try {
    const body: unknown = await res.clone().json();
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
  } catch {
    return null;
  }
}

export interface AuditQuery {
  limit: number;
  before?: number | undefined; // 游標：只取 id 小於它的（時間新到舊）
  userId?: number | undefined;
  method?: string | undefined;
  path?: string | undefined; // 前綴比對
  failedOnly?: boolean | undefined; // 只看被擋下的（>=400）
}

export async function listAudit(db: Db, q: AuditQuery) {
  const conds = [];
  if (q.before !== undefined) conds.push(lt(schema.auditLogs.id, q.before));
  if (q.userId !== undefined) conds.push(eq(schema.auditLogs.userId, q.userId));
  if (q.method) conds.push(eq(schema.auditLogs.method, q.method));
  // 前綴比對而非全文搜尋：路徑是有結構的，「/sales」要能一次撈出底下所有動作。
  // like 的萬用字元先跳脫，否則使用者輸入的 % 會變成「全部」
  if (q.path) conds.push(sql`${schema.auditLogs.path} LIKE ${`${q.path.replace(/[%_\\]/g, "\\$&")}%`}`);
  if (q.failedOnly) conds.push(gte(schema.auditLogs.status, 400));

  return db
    .select()
    .from(schema.auditLogs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.auditLogs.id))
    .limit(q.limit);
}
