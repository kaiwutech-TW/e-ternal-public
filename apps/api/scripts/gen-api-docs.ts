/**
 * 產生 docs/api.md：從 Hono app.routes 列出全部端點，並以 authorize() 乾跑標註各角色可否存取。
 * 用法：node --experimental-strip-types apps/api/scripts/gen-api-docs.ts
 * 文件是生成物——改了路由或權限請重跑，不要手改 docs/api.md。
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { ROLES } from "@tw-erp/core";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { buildApp } from "../src/app.ts";
import { authorize } from "../src/services/auth.ts";

const client = new PGlite();
await applyMigrations((sql) => client.exec(sql));
const app = buildApp(drizzle(client));

const PUBLIC = new Set(["POST /auth/login", "POST /auth/setup", "GET /auth/setup-status"]);

const seen = new Set<string>();
const rows: { method: string; path: string; access: string }[] = [];
for (const r of app.routes) {
  if (r.method === "ALL" || r.path === "/*" || r.path === "*") continue; // 中介層
  const key = `${r.method} ${r.path}`;
  if (seen.has(key)) continue;
  seen.add(key);
  let access: string;
  if (PUBLIC.has(key)) access = "公開";
  else if (r.path.startsWith("/auth/")) access = "任何已登入";
  else {
    // 乾跑各角色（路徑參數以 1 代入）
    const probe = r.path.replace(/:[^/]+/g, "1");
    const allowed = ROLES.filter((role) => authorize(role, r.method, probe) === null);
    access =
      allowed.length === ROLES.length ? "任何已登入" : allowed.length === 0 ? "—" : allowed.join("、");
  }
  rows.push({ method: r.method, path: r.path, access });
}
rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const md = `# tw-erp API 參考

> 本檔由 \`apps/api/scripts/gen-api-docs.ts\` 產生——改了路由或權限請重跑，勿手改。

## 認證

- 單埠部署時所有端點皆掛在 \`/api\` 前綴之下（例：\`POST /api/auth/login\`）。
- 認證採 session cookie（HttpOnly＋SameSite=Lax，https 請求另帶 Secure）：\`POST /auth/login\`
  （帳密）→ 後續請求自動帶 cookie；程式化存取請保存 \`set-cookie\` 回傳的 \`sid\` 並附於 \`cookie\` 標頭。
- 首次啟動（無任何使用者）以 \`POST /auth/setup\` 建立第一個管理者。
- 未登入一律 401；權限不足 403。角色權限為頁面級（見 packages/core/src/roles.ts）。
- 登入有節流：同一帳號 5 次／同一來源 30 次失敗（滑動視窗 15 分鐘）後回 **429**，
  自動癒合、不需人工解鎖。程式化存取請把 429 當成「稍後再試」而非憑證錯誤。
- 所有非 GET 請求（含被擋下的）都會寫進操作日誌；請求內容一律不記錄。

## 端點總覽（${rows.length} 個）

| Method | Path | 可存取角色 |
|---|---|---|
${rows.map((r) => `| ${r.method} | \`${r.path}\` | ${r.access} |`).join("\n")}

## 慣例

- 金額一律整數新台幣元；日期 \`YYYY-MM-DD\`；期間 \`YYYY-MM\`。
- 寫入類端點會拋轉傳票者，於已關帳期間一律 409（月結關帳）。
- 錯誤格式：\`{ "error": "訊息" }\`，狀態碼 400/401/403/404/409/422。
- gm（總經理）角色對可見頁面一律唯讀（僅 GET）；報銷例外（可替自己送件）。
- 上表只反映**路徑層**的權限。唯一的 body 相依例外：\`POST /sales/:id/returns\` 與
  \`POST /purchases/:id/returns\` 帶 \`settlement: "cash"\` 時，另需「收付款（cash）」頁權限
  （退回單能直接貸／借記現金科目，否則等於繞過該頁的角色限制）；不帶則任何有原單頁權限的角色皆可。
`;

const out = fileURLToPath(new URL("../../../docs/api.md", import.meta.url));
writeFileSync(out, md);
console.log(`docs/api.md 產生完成（${rows.length} 端點）`);
