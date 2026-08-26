#!/usr/bin/env node --experimental-strip-types
/**
 * tw-erp MCP server（stdio）：讓 Claude 等 AI 助理直接操作 ERP。
 * 環境變數：TWERP_URL（例 http://localhost:3000/api）＋ TWERP_API_KEY（建議），
 * 或退回 TWERP_USERNAME／TWERP_PASSWORD（該帳號一旦啟用二階段驗證就會失效）。
 * 權限跟隨該帳號角色；建議開一個專用帳號給 AI，用最小必要角色。
 * 設定範例見 docs/mcp.md。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TwErpClient } from "./client.ts";
import { defineTools } from "./tools.ts";

const baseUrl = process.env["TWERP_URL"];
const apiKey = process.env["TWERP_API_KEY"];
const username = process.env["TWERP_USERNAME"];
const password = process.env["TWERP_PASSWORD"];
if (!baseUrl || !(apiKey || (username && password))) {
  console.error(
    "請設定 TWERP_URL，以及 TWERP_API_KEY（建議）或 TWERP_USERNAME＋TWERP_PASSWORD（見 docs/mcp.md）",
  );
  process.exit(1);
}

const client = new TwErpClient({ baseUrl, apiKey, username, password });
const server = new McpServer({ name: "tw-erp", version: "0.1.0" });

for (const tool of defineTools(client)) {
  server.tool(tool.name, tool.description, tool.schema, async (args: Record<string, unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: await tool.handler(args) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `錯誤：${(e as Error).message}` }], isError: true };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error("tw-erp MCP server ready（stdio）");
