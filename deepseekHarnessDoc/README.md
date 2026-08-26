# deepseekHarnessDoc — DeepSeek Harness 的設計貢獻

> 這份資料夾是 **DeepSeek Harness（本 session 的 agent）** 對「agent 該帶入哪些 ERP 流程」
> 的設計提案與三方審閱工作區。原始 review 保留各輪歷史；目前收斂結果以
> [`plan-converged.md`](./plan-converged.md) 為準。

## 為什麼有這份資料夾

主導者要做的是**三方交叉審閱**，讓 DeepSeek Harness、Claude、Codex 各自寫下自己那部分的
設計，再互相修正：

| 角色 | 貢獻 |
|---|---|
| DeepSeek Harness（本份） | 使用者視角的痛點地圖＋報銷／對帳兩份落地設計 |
| Claude | [`review-claude.md`](./review-claude.md)＋收斂計畫執筆 |
| Codex | [`review-codex.md`](./review-codex.md)＋[`review-codex-round2.md`](./review-codex-round2.md) |

`docs/agent-ux-gap.md` 是總覽（痛點地圖），這裡放**逐條展開的設計**。

## 內容索引

| 檔案 | 講什麼 | 狀態 |
|---|---|---|
| [`expense-claims-agent.md`](./expense-claims-agent.md) | 報銷：拍照→草稿→確認→送件，核准門在人手上 | 收斂草案 v0.2 |
| [`bank-reconciliation-agent.md`](./bank-reconciliation-agent.md) | 對帳：匯入對應／比對敘事／補傳票草稿，只建議不自動確認 | 收斂草案 v0.2 |
| [`plan-converged.md`](./plan-converged.md) | 三方已收斂、待拍板與工作包 | v3 |

## 與既有紅線／規格的關係（審閱前先知道這些已定案）

本設計**不推翻、只疊加**在既有紀律上。以下文件是「已定案」，審閱時若與之衝突，以它們為準：

- [`agent/soul.md`](../agent/soul.md) — agent 三條底線：不斷言稅率期限、動帳先覆述、個資只在必要時取用。
- [`.flightwake/DECISIONS.md`](../.flightwake/DECISIONS.md) — 較新的責任定案：寫入類動作一律
  agent 產草稿／提案，人按確認才生效；與 soul 衝突時以 decision log 為準。
- [`agent/skill.md`](../agent/skill.md) — agent 能力清單與操作手冊。
- [`docs/specs/bank-reconciliation.md`](../docs/specs/bank-reconciliation.md) — 對帳本體的三條邊界
  （每帳戶自設匯入對應檔、比對只建議不自動確認、手動勾對第一等公民）。
- [`docs/SOP.md`](../docs/SOP.md) — 作業順序（報銷、月結、401 的既有步驟）。
- 伺服端硬規則（`apps/api/src/services/expenses.ts`、`ledger.ts`）— 可扣抵、查重、溢收溢付、
  關帳鎖都是**結構**把關，agent 改不了。

## 審閱問題與目前結論

以下是原始跨文件問題；三方回覆已收斂到 plan v3：

- **Q0（安全紅線一致性）**：已定方向為內建／MCP 都只提供 read／proposal；工具面仍待實作同步。
  刪工具是有效縮面但不是 REST 安全邊界，人類確認要靠 proposal／accept 契約。
- **Q1（影像出外部 LLM）**：已收斂為預設關閉；管理者同意綁 `{provider, baseUrl, model}`，
  endpoint 任一變更即復位關閉。
- **Q2（範圍）**：B1 等責任模型完成；B2 先站內 briefing（Claude）；C1／C2 擴充並收斂既有
  `checkPeriod()`／GettingStarted（Codex）。

## 約定

- 金額一律整數元、日期 `YYYY-MM-DD`、期間 `YYYY-MM`、繁體中文、科目連代號一起講（soul.md）。
- 任何寫入設計一律遵守 `.flightwake/DECISIONS.md:9`：agent 只產草稿／提案，人按確認才生效；
  soul.md 的舊「覆述後由 agent 執行」措辭待同步。
