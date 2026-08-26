# tw-erp MCP server

讓 Claude 等 AI 助理直接操作 ERP：查庫存、開報價單、轉訂單、出貨、看帳齡、催款名單、
核准報銷、拉三大報表——全部透過 MCP 工具（apps/mcp）。

## 設定

1. 先在 tw-erp「設定」頁開一個**專用帳號**給 AI，指派最小必要角色
   （查詢＋接單給 `sales`；要核准報銷/看儀表板給 `finance`）。權限由伺服端 ACL 把關，
   AI 拿到什麼角色就只能做該角色的事。
2. 在「設定 → Agent 接入」替那個帳號**產生一把 API 金鑰**（明文只顯示一次）。
   ⚠️ 不要用帳號密碼：帳號一旦啟用二階段驗證，帳密登入就會被擋
   （機器沒有手機）。金鑰不受 2FA 影響，而且可以隨時撤銷、看得到最後使用時間。
3. Claude Code 註冊：

```sh
claude mcp add tw-erp \
  -e TWERP_URL=http://localhost:3000/api \
  -e TWERP_API_KEY=twerp_sk_… \
  -- node --experimental-strip-types /path/to/tw_erp/apps/mcp/src/server.ts
```

4. 讓 agent 先讀 `agent/soul.md`（身分與底線）與 `agent/skill.md`（能力與操作手冊）——
   特別是「絕不斷言稅率與申報期限」那一條。

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "tw-erp": {
      "command": "node",
      "args": ["--experimental-strip-types", "/path/to/tw_erp/apps/mcp/src/server.ts"],
      "env": {
        "TWERP_URL": "http://localhost:3000/api",
        "TWERP_API_KEY": "twerp_sk_…"
      }
    }
  }
}
```

## 工具一覽

| 工具 | 用途 |
|---|---|
| list_partners / list_products / inventory_status | 主檔與庫存查詢 |
| create_quote / list_quotes / convert_quote | 報價 → 成交轉訂單 |
| list_orders / ship_order | 訂單與出貨（開銷貨單＋拋轉庫存/傳票） |
| list_purchase_orders | 採購單到貨進度 |
| list_expense_claims / approve_expense_claim | 報銷查詢與核准 |
| dashboard / ar_aging | 經營數字與催款名單 |
| income_statement / balance_sheet / cash_flow | 三大財務報表 |

範例指令：「幫我看哪些客戶欠款超過 60 天」「客戶甲要 10 台路由器單價 800，開報價單」
「上個月毛利多少？」

## 注意

- 金鑰只放在本機 MCP 設定，不經過模型。仍支援帳密（會自動重登），但該帳號不能啟用 2FA。
- 金鑰的每一個動作都會進操作日誌，記在那個帳號名下——這讓 agent 可以被信任地放進真實帳務流程。
- 寫入類工具（出貨/核准）與人工操作走同一套伺服端驗證（庫存檢查、關帳鎖、狀態機）。
- API 全清單見 docs/api.md（自動生成）。
