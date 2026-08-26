# E-ternal — 台灣中小企業開源 ERP

> **E直在線**（Always On-Line ERP）——指的是**系統**永續在線，不是你。
>
> 「現在要阻止台灣人玩諧音梗，已經 Taiwan（太晚）了。」

目標：一套真正做完台灣法遵整合的開源 ERP——電子發票（MIG-4.1 / Turnkey）、
營業稅 401/403 申報、台灣會計科目、出勤與薪資。API-first，AI Agent 原生接入
（內建聊天助理＋MCP server＋公司記憶）。

授權：**LGPL-3.0-or-later**（見 [`LICENSE`](./LICENSE)；LGPL 是 GPL 之上的額外許可，
因此一併附上 [`COPYING`](./COPYING)）。自架、修改、把專有模組掛上來都可以；
把修改後的**本體**散布出去時，要把那部分的原始碼一起給。
第三方元件的授權見 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

## 為什麼

2026 年的調查結論：沒有任何開源 ERP 開箱即用地滿足台灣中小企業的法遵需求。
積木散落各處（發票 SDK、科目表），但沒人把它組裝成一套完整、開放、可自主部署的系統。

## 這套系統真的有什麼

不開玩笑的部分（每一項都有測試與文件背書，833 項測試、43 個 migration）：

- **進銷存**：報價 → 訂單 → 出貨、採購 → 收貨，移動平均成本、盤點／盤虧／報廢
- **會計**：科目維護、自動拋轉傳票、手工傳票（含行摘要與鍵盤流）、月結關帳、
  三大報表、明細分類帳、應收應付帳齡、預收預付、期初導入
- **合約請款**（顧問／軟體開發業）：分期請款計畫、月費排程一鍵展開、待請款清單、續約成鏈
- **稅務**：電子發票開立／作廢／折讓證明單 XML（golden 測試對官方範例）、
  401 申報媒體檔、零稅率、扣繳追蹤與年度憑單取數、**稅法參數由使用者自填**
  （系統絕不斷言任何稅率與申報期限——這是全專案最硬的一條紀律）
- **更正＝作廢＋重開**：所有單據作廢產反向傳票、原單留痕永不刪
- **HR 出勤**：部門樹、班別（跨日歸屬日切點）、排班、Web 打卡（IP 白名單）、
  假別＋額度帳、請假/加班/補卡申請＋部門主管簽核鏈（提交時快照）、行事曆、月出勤彙總
- **薪資**：薪資檔歷次紀錄、加班費率按日按日型分段（含「做 6 給 8」固定時數計）、
  發薪作業草稿→定案自動過帳計提傳票；倍率/除數/勞健保金額全使用者自填——
  已拿真實公司整月薪資單逐筆對數字驗證（12/12 全解釋）
- **內建 AI 助理**：聊天側欄查資料、起草單據（報價/請假/加班/補卡）；
  **責任紅線是結構不是自律**——工具集只有讀取與草稿，核准過帳的門不存在；
  公司記憶（agent 提議、人核准才生效、到期自動汰舊）、角色功能地圖、
  四家供應商（Anthropic/OpenAI/Gemini/Vertex AI express key）
- **安全**：登入節流、二階段驗證、操作日誌（不記 body）、身分證號欄位加密、備份加密、
  介面深淺色（Light/Dark/System）
- **Agent 接入**：API 金鑰（同一套 ACL 與操作日誌）、MCP server、[soul.md](agent/soul.md)／[skill.md](agent/skill.md)

已知缺口誠實列在 [docs/gap-analysis-2608.md](docs/gap-analysis-2608.md)（含「刻意不做的事」20 條）。

## 開始使用

第一次用先看 [**開始使用前：先備齊這些資料**](docs/before-you-start.md)——
多數人卡住不是不會操作，是坐下來才發現稅率沒查、字軌還沒申請、期初餘額要回頭問記帳士。
資料齊了之後照 [SOP 第一部分](docs/SOP.md) 的順序走。

## 快速啟動

真的可以跑的指令（完整四種部署形狀與逐步完成條件見 [docs/INSTALL.md](docs/INSTALL.md)）：

```bash
# 試用（3 分鐘，免資料庫，重啟即清空）
pnpm install && pnpm --filter @tw-erp/web build && pnpm --filter @tw-erp/api dev:memory

# 正式（Docker，資料保留）
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env && chmod 600 .env
docker compose up -d --build
```

裝好之後照 [docs/SOP.md](docs/SOP.md) 的導入順序走（公司基本檔 → 科目 → 稅法參數 →
字軌 → 主檔 → 期初 → 帳號），不會卡在看不懂的錯誤上。

## 專案結構

```
docs/INSTALL.md    安裝流程（試用／內網／雲端／開發機四種，附完成條件）
docs/SOP.md        作業 SOP：導入順序＋日常/每月/每年該做什麼
docs/gap-analysis-2608.md  缺口盤點（以假公司實跑十條流程；修復狀態逐條標注）
agent/soul.md      內建助理的身分與底線
agent/skill.md     內建助理的能力清單與操作手冊
docs/ROADMAP.md    分階段路線圖（Phase 0–6）
docs/specs/        法規規格書（法規即規格：欄位 ↔ 條文 ↔ 測試）
packages/core      核心領域邏輯（純 TS：統編、稅額、拋轉、存貨計價）
packages/einvoice  電子發票 MIG-4.1（F0401/F0501 發票＋G0401/G0501 折讓證明單產生器，golden 測試對官方範例）
packages/vat       營業稅 401 申報（附件五 81B 媒體檔、附件六 112 欄、S9 overpunch）
packages/db        drizzle schema＋手寫 SQL migrations
apps/api           Hono API（進銷存＋會計＋發票＋申報＋HR/薪資＋內建助理；測試用 PGlite）
apps/web           React 操作介面（Vite，深淺色）
apps/mcp           MCP server（stdio）：Claude 等 AI 助理直接操作 ERP
.flightwake/       工作框架（STATE / DECISIONS / TRAPS / records）
```

> **品牌名與技術代號**：產品叫 **E-ternal**，程式裡的技術代號仍是 `tw-erp`
> （`@tw-erp/*` 套件、`TWERP_*` 環境變數、`twerp_sk_` 金鑰前綴、資料庫名 `twerp`）。
> 這是刻意的——改代號是全面破壞性變更（既有 API 金鑰全數失效、部署設定全要動），
> 品牌歸品牌、代號歸代號。

## 開發

```bash
pnpm install
pnpm typecheck
pnpm test

# 本機把整套跑起來（免裝 Postgres，記憶體資料庫，重啟即清空）
pnpm --filter @tw-erp/api dev:memory     # API :3000
pnpm --filter @tw-erp/web dev            # 介面 :5173（proxy /api → :3000）

# 正式（需 PostgreSQL）
DATABASE_URL=postgres://... node --experimental-strip-types apps/api/scripts/migrate.ts
DATABASE_URL=postgres://... pnpm --filter @tw-erp/api dev
```

前端測試預設跑在 node 環境（純函式測試在那裡快又穩）。要 render React 元件的測試，
在**檔案第一行**加 `// @vitest-environment jsdom`，並從 `apps/web/test/dom.ts` 取用
render／screen／userEvent（那支負責每則測試後的 cleanup）；檔名慣例 `*.dom.test.tsx`。
理由與射程寫在 `apps/web/vite.config.ts` 的 `test` 區塊——jsdom 沒有 canvas，
影像解碼與 QR 掃描那條路測不到，只能靠實機。

## 法遵紅線

- 每家使用企業以**自己的憑證**透過 Turnkey 或加值中心傳輸發票；本專案**不做集中代傳**。
- 法規原文是一級規格；參考其他開源專案只用於交叉對照，**不得把別人的程式碼複製進本專案**。
  （本專案自己是 LGPL-3.0-or-later，但那不代表可以抄 GPL/AGPL 的程式碼——授權相容是單向的，
  抄進來就會把對方的條款一起帶進來，包括我們履行不了的那些。）
- 系統不斷言任何稅率、免稅額度、申報期限——那些由使用者查證後自填（附依據來源），
  程式只提供結構與算術。

## 貢獻指南

歡迎所有台灣的開發者一起加入。

- 發現 Bug 請開 Issue——覺得 **E言難盡** 的話，附上重現步驟會讓它變得一言可盡。
- Pull Request 請帶測試：本專案的紀律是「宣稱的規則必須真的實作」，README 也不例外
  （所以上面沒有任何一條假指令）。
- 送出 Pull Request 前請先讀 [`CONTRIBUTING.md`](./CONTRIBUTING.md)：
  裡面有貢獻者授權同意（CLA）的條款，第一次送 PR 需要同意。

## 命名由來

**E-ternal ＝ E直在線**：系統永續不中斷（System Eternal）。至於「員工也一直在線」
的那個讀法——本專案的立場是把報銷、對帳、申報的重複勞動自動化掉，
讓你**不必**一直在線。
