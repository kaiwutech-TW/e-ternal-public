/**
 * 單埠部署組裝：API 掛在 /api 之下，其餘路徑 serve 前端靜態檔（apps/web/dist）＋ SPA fallback。
 * server.ts（正式，pg）與 scripts/dev-memory.ts（開發，PGlite）共用；
 * vite dev proxy 不剝 /api 前綴，開發與正式的路徑形狀一致。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { relative } from "node:path";
import { Hono } from "hono";
import { buildApp } from "./app.ts";
import type { Db } from "./db.ts";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

export function buildServerApp(db: Db): Hono {
  const root = new Hono();
  root.route("/api", buildApp(db));

  if (existsSync(join(WEB_DIST, "index.html"))) {
    // serveStatic 的 root 需相對於行程 cwd
    const staticRoot = relative(process.cwd(), WEB_DIST) || ".";
    root.use("/*", serveStatic({ root: staticRoot }));
    const indexHtml = readFileSync(join(WEB_DIST, "index.html"), "utf8");
    root.get("*", (c) => c.html(indexHtml)); // SPA fallback
  } else {
    root.get("/", (c) =>
      c.text("tw-erp API（前端未建置：請先 pnpm --filter @tw-erp/web build，或以 vite dev 開發）"),
    );
  }
  return root;
}
