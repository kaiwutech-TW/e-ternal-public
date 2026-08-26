/**
 * 二階段驗證的逃生門：把某個帳號的 TOTP 關掉。
 *
 * 什麼時候會用到：**唯一的管理者**手機掉了、備援碼也找不到。
 * 其他所有情況都該走畫面——管理者可以在設定頁替同事關閉（PATCH /users/:id），
 * 那條路徑會被操作日誌記下來，這支腳本不會（它繞過整個 app）。
 *
 * 為什麼做成腳本而不是 API：需要主機與資料庫存取權才跑得動。
 * 做成 API 就等於在系統裡放一個「關掉二階段驗證」的端點，那正是攻擊者最想要的東西。
 *
 * 用法（在部署主機的 repo 根目錄）：
 *   docker compose exec app node --experimental-strip-types apps/api/scripts/disable-totp.ts <帳號>
 */
import { schema } from "@tw-erp/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { resolveDatabaseUrl } from "../src/db-url.ts";

const username = process.argv[2];
if (!username) {
  console.error("用法: disable-totp.ts <帳號>");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: resolveDatabaseUrl() });
const db = drizzle(pool);

const [user] = await db.select().from(schema.users).where(eq(schema.users.username, username));
if (!user) {
  console.error(`找不到帳號: ${username}`);
  await pool.end();
  process.exit(1);
}
if (!user.totpEnabledAt && !user.totpSecret && !user.totpPendingSecret) {
  console.log(`${username} 本來就沒有啟用二階段驗證，未做任何變更`);
  await pool.end();
  process.exit(0);
}

await db
  .update(schema.users)
  .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null })
  .where(eq(schema.users.id, user.id));
// 備援碼跟著一起作廢：留著等於留下一組沒有人記得存在哪裡的鑰匙
await db.delete(schema.totpRecoveryCodes).where(eq(schema.totpRecoveryCodes.userId, user.id));
// 既有 session 也一併切斷——會走到這支腳本，表示帳號的控制權有疑慮
await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));

await pool.end();
console.log(
  `已關閉 ${username} 的二階段驗證，並作廢其備援碼與所有登入中的 session。\n` +
    "請該使用者以密碼登入後，到設定頁重新啟用。",
);
