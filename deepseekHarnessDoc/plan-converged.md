# plan-converged — 三方審閱收斂後的可執行計畫

> **狀態**：收斂草案 **v3**（Claude 執筆、Codex 第二輪複核）｜ **對應基線**：`a6ed6fe`
> **輸入**：`README.md`＋`expense-claims-agent.md`＋`bank-reconciliation-agent.md`（DeepSeek Harness）、
> `docs/agent-ux-gap.md`、`review-claude.md`、`review-codex.md`、`review-deepseek-round2.md`、
> **`review-codex-round2.md`（新）**。
> **v2 → v3 的差異**：Codex 確認 X1–X4 關閉與 E5 撤回；D1 改列既有定案；D2 改以責任轉移點
> 分級並補上 HR 空簽核鏈自動生效；修正 D4 的 gm 例外、W0 資料來源與 W8／W10 驗收契約。
> **這份不是第四份意見**。它把稿子拆成四類：**已收斂**（可直接做）、
> **待主導者拍板**（D2–D6；D1 已定）、**已關閉分歧**（X1–X4）、**原稿勘誤**（E1–E9）。

---

## 0. Codex 第二輪回覆

1. **X1–X4**：確認全部關閉；Codex 立場未變。
2. **D2**：「動帳／不可逆」不能當唯一判準；分類要看是否跨過強制的人類責任轉移點。
3. **D4**：角色與契約方向互補，但 gm 並非全域唯讀，內建助理也不受專用 agent 帳號限制。
4. **E5**：撤回正確，沒有過頭。
5. **W0**：與批次 0 並行，但要改成「歷史可算＋前瞻抽樣」，不阻塞已證實的正確性修復。
6. **W11／W12**：認領範圍照 v1；W12 要用生成文件或 drift test 機械連結 Markdown SOP。

完整理由與證據見 [`review-codex-round2.md`](./review-codex-round2.md)。

---

## 1. 第二輪收斂狀態

| 類別 | v1 | v3 | 備註 |
|---|---|---|---|
| 已收斂 | C-1…C-9 | C-1…C-9（**DeepSeek 全數確認並複核引用事實**） | 不再討論 |
| 待拍板 | D1–D6 | **D2–D6**（D1 已由既有 decision 定案；D2 判準已修正） | 仍等主導者取捨／排程 |
| 分歧 | X1–X4 | **全部關閉，Codex 已確認** | 三方立場一致 |
| 勘誤 | E1–E9 | E1–E4／E6–E8 已由 DeepSeek 修入工作區；**E5 我方撤回**；**E9 是我自己的** | 見第 5 節 |
| 工作包 | W1–W15 | **＋W0（量測）**；**W4 範圍擴大** | 見第 3 節 |

**工作區現況**（`git status`，尚未 commit）：DeepSeek 的 E1–E4／E6–E8 與 Codex 第二輪同步已套進
`deepseekHarnessDoc/README.md`、`bank-reconciliation-agent.md`、`expense-claims-agent.md`、
`docs/agent-ux-gap.md`。上游 SOP／spec 的硬事實仍待 W4。

---

## 2. 已三方收斂（不需再討論，只等排程）

| # | 結論 | 三方狀態 |
|---|---|---|
| C-1 | 需要回填 browser state 的 `create_expense_claim_draft`／`draft_journal_entry` **不做成直接 POST 正式單據的 tool**；由頁面按鈕呼叫純建議端點。跨頁、可持久化提案則走 D3 proposal 契約 | DeepSeek 提出風險 → Claude 給替代方案 → Codex 第二輪補清與 D3 的分層 |
| C-2 | **報銷分類不能由品名單獨決定**（用途才是決定因素，同一賣方可橫跨 `6112 員工伙食`／`6115 員工福利`／`6137 餐飲與交際`，三者可扣抵預設不同，`chart.ts:259-270`） | 三方一致；DeepSeek 第二輪特別背書 |
| C-3 | **歷史賣方分類只當候選、不自動選中**；有歧義時由 agent 問一句用途，人來點 | Claude 提出 → Codex 補強 → DeepSeek 撤回原稿「自動帶入」的殘留暗示 |
| C-4 | **vision 預設關閉，管理者明示開啟**；同意必須綁 `{provider, baseUrl, model}` 實際端點，任一變更即回到關閉。**provider 名稱不證明資料位置**（`custom`／Ollama 都可能指向公網） | 採 Codex 的 endpoint-bound consent |
| C-5 | **QR 銷售額欄目前被丟掉是真問題**，但它是「憑證所載的結構化值」，不是已驗真的權威值（24 碼加密驗證區從未驗證，我方自印的還是 24 個 `0`，`einvoice-qr.ts:54`） | Claude 提出 → 採 Codex 用詞 |
| C-6 | **對帳的「確認對上」與「核准過帳」同級，只有人能按**；引擎回**可驗證 evidence**（金額是否相等、日期差幾天、候選筆數、一對多組合、命中哪條規則），**不回模型生成的 `confidence` 分數** | 採 Codex 的 evidence 清單 |
| C-7 | **C1／C2 不是白紙**：`checkPeriod()` 已有五項（`period.ts:83/110/141/167/189`）、端點 `GET /period-closes/check`（`app.ts:3313`）；首頁 `GettingStarted` 已有六步（`Dashboard.tsx:24-61`）。方向是**擴充並收斂既有確定性結構**，不新增第二套 agent 規則 | Codex 提出，Claude 複核成立 |
| C-8 | **B1 銷售 chain 在責任模型收斂前不展開** | 三方一致 |
| C-9 | **對帳的銀行側科目一律取「該銀行帳戶綁定的 accountId」，不寫死代號** | Codex 提出，Claude 複核成立，DeepSeek 已修稿 |

---

## 3. 已定責任紅線與待主導者拍板（D1–D6）

> D1 已由既有 decision 定案；除非主導者明示推翻，不再重投。D2–D6 仍涉及取捨、優先序或範圍，
> 每條標明「解鎖什麼」。

### D1：責任模型（**既有定案，待同步**）

**現況衝突**（三方複核一致）：

- `DECISIONS.md:9`（2026-08-13）：「寫入類動作**一律** agent 產草稿、人按確認才生效；
  確認的那一下就是責任轉移點」。
- `soul.md:35-42`（較舊）：把「核准報銷、付款、出貨、開發票、月結關帳」列在**底線二**
  ——「先覆述、等使用者說可以，然後 agent 執行」。
- `apps/mcp/src/tools.ts`：`approve_expense_claim:105`、`ship_order:79`、`convert_quote:67` 仍在。

`.flightwake/DECISIONS.md:3` 明定新舊衝突由 decision log 收斂，`:9` 已定案：agent 一律只能
準備／提案，正式落地由人按確認。DeepSeek、Claude、Codex 也都支持這個方向。因此 D1 不再要求
主導者重選；要做的是同步 `soul.md`、兩份工具面與公開文件。若主導者要保留「覆述後由 agent 執行」
的例外，應另寫一筆新 decision 明示推翻 2026-08-13 的定案與例外清單。

**解鎖**：W8、W9、W10、以及 B1 是否能重啟。**這是全案的關鍵路徑，其他都繞不過它。**

---

### D2：動作分級 read／propose／commit——判準與歸類

D1 已定後需要決定分級落點。DeepSeek 提出的「是否動帳／是否不可逆」可當**風險訊號**，
但不能當唯一判準：可作廢的正式單據仍可能是對員工／交易對象的承諾。

> **分級判準＝是否跨過強制的人類責任轉移點。** `read` 不改 domain state；`propose` 最多寫入
> 惰性的 proposal artifact，不能自行生效且唯一前進路徑是人按 accept；`commit` 建立／改變正式
> domain state，或在沒有另一個強制人工閘門時可直接產生效果。

依此判準的歸類，以及三方立場：

| 動作 | 現行副作用（已複核） | 目標 agent 能力 | 現行實作判定 |
|---|---|---|---|
| `approve_expense_claim` | 拋轉費用傳票、進 401 | 不提供；只能提案 | **commit** |
| `ship_order` | 開銷貨單、扣庫存、拋傳票 | 不提供；只能提案 | **commit** |
| `convert_quote` | 建立訂單、一張只能轉一次 | 不提供；只能提案 | **commit** |
| `create_quote` | 直接建立 status=open 的正式報價單 | `propose_create_quote` | **今天是 write／commit；遷入 D3 後才是 propose** |
| `create_hr_request` | 直接建申請；無簽核鏈時立刻 approved，忘打卡還會寫 punch | `propose_hr_request` | **今天可能直接生效；遷入 D3 後才是 propose** |

HR 路徑的證據：`hr-leave.ts:267-297`；現有 agent 測試還特地先設主管，避免空鏈自動核准
（`agent-chat.test.ts:120-140`）。這是 v2 漏掉、會讓清單測試假綠的反例。

**解鎖**：W8、W9。

---

### D3：內建側要不要補 proposal／accept 契約？

依 D1 既有定案，現行內建側**本身就不合規**：`agent-chat.ts:239-245` 的 `TOOL_POST_PATH`
直接 POST，`create_quote`／`create_hr_request` 沒有任何人工確認閘門，
「先覆述再做」完全靠 system prompt 自律。

| 選項 | 內容 | 代價 |
|---|---|---|
| **A（DeepSeek 支持）** | 補通用 proposal／accept | 工程量最大的一包；但它是 B1、對帳敘事、未來所有寫入功能的共同地基 |
| B | 暫不補；移除／停用現行 `create_quote`、`create_hr_request` agent tools，只保留 read 與 C-1 純建議端點 | 合規且快，但短期失去兩個 agent 寫入功能 |
| C（除非推翻 D1） | `create_quote`／`create_hr_request` 維持直接 POST | 與既有 decision 衝突；不能靠 README 註明就變合規 |

**DeepSeek 的分階段建議（我認為值得採納）**：選 A，但先落**最簡形狀**——
proposal 表＋accept 端點＋audit 分記 proposer／confirmer，讓
`create_quote`／`create_hr_request` 先遷過去，**不必一次做到 W10 的完整版**。
最小版仍必須包含 allowlist、期限、單次 accept、accept 時重驗權限與 domain state、交易內消耗＋執行；
否則會留下重放或 stale proposal。它可以分階段，但工程量不能再宣稱接近純建議端點。

**解鎖**：W10 與 B1；W7 已收斂為確定性候選，不依賴 D3。

---

### D4：agent 的能力邊界怎麼給？（選項已依第二輪改寫）

**已複核的事實**：`roles.ts:66-75` 的 `admin`／`finance` 拿全部 `PAGE_KEYS`；`gm` 對一般頁面
非 GET 唯讀（`auth.ts:473`），但不是全域唯讀——報銷本體與 `/hr-requests` 明列 `access:"any"`
（`auth.ts:374-392`），所以 gm 金鑰仍能送報銷與 HR 申請，只是不能建立報價。

**v1 把「新增角色」與「靠契約」寫成二選一，DeepSeek 指出這是錯的——兩者互補**：
契約擋的是 agent 工具跨過責任轉移點，角色決定專用帳號讀得到什麼、能呼叫哪些 proposal 端點。
只有契約而沿用 finance 金鑰，外部 agent 仍讀得到全部；只有角色而沒契約，無法表達「先存惰性提案、
再由人 accept」。另外內建助理沿用目前登入者 cookie／Authorization（`app.ts:2543-2559`），
不會因新增專用 agent 角色就自動受限，因此仍需 D3 工具契約。

改寫後的選項：

| 選項 | 內容 |
|---|---|
| **A＋B（DeepSeek、Codex 傾向）** | 新增專用 `agent` 角色（受限 read＋proposal endpoints，不能 commit）**並且**做 D3 契約；內建助理也只暴露 read／proposal tools |
| A only | 只新增角色，不做契約——可限制讀取並擋 commit，但在 proposal endpoint 存在前只能 read |
| B only | 不新增角色，只做契約——agent tools 只能提案，但外部程式若持 finance/admin 憑證仍可直接打 REST；讀取範圍也不受限 |
| C | 都不做；gm 仍有報銷／HR 寫入例外，不能宣稱是安全的唯讀 agent 角色 |

**注意**：0021 migration 檔頭的「設計紀律一」明寫**不要在金鑰上長第二套權限模型**。
新增角色是**沿用既有角色模型**，不是在金鑰上長 scope，不違反那條——
但這個理由要寫進 migration 檔頭給下一個人看，否則會被正當地擋下來。

**解鎖**：W9 的落地形態。

---

### D5：對帳在 golden sample 到手前，動工範圍到哪？

`docs/specs/bank-reconciliation.md:69-73` 把「真實匯出檔」列為**動工前提**。

| 選項 | 內容 |
|---|---|
| A（Claude 原案） | 把它從「動工前提」改成「驗收前提」，sniffer 與儲存結構先寫 |
| **B（Codex 案；Claude 改採、DeepSeek 支持）** | 三分：①**可先做**＝手動勾對、調節表 domain model、比對候選引擎與 suggestion/confirm 狀態邊界（不依賴銀行檔格式）②**可 spike 不可宣稱完成**＝編碼／欄位 profiler，用合成 fixtures 驗框架 ③**等真實去識別化檔**＝匯入對應檔 schema、sniffer 規則、CSV/xlsx 範圍與驗收 |

B 比 A 保守，不動 spec 的既有立場，只把「動工」拆細。三方現已一致傾向 B。

**同時要你提供**（spec 第四節本來就在等）：一份去識別化的銀行匯出檔、以及公司有沒有用支票。

**解鎖**：W14。

---

### D6：B2「今天該做什麼」的送達通道？

資料端已就緒（`agent-chat.ts:78-82` 已列 `/contracts/billing-due`、`/contracts/expiring`、
`/recurring-payables/due`；首頁 0047 的卡片已在彙總）。缺的是送達。

| 選項 | 內容 |
|---|---|
| **A（Codex 傾向；Claude、DeepSeek 同意）** | 先做**登入後的站內今日 briefing**，不做推播 |
| B | 站內 + Email |
| C | 只留首頁卡片，不做這條 |

Codex 的提醒成立：「純讀」不等於低工程量——通知狀態、去重、角色、時區、退訂都要設計。
DeepSeek 補充：briefing 是**最容易破零斷言的形狀**，每一句都要標明日期來源
（背書 W13 的文案紀律）。

**解鎖**：W13。

---

## 4. 工作包

> **W0／批次 0／批次 1 不依賴任何拍板，可以立刻開工。** 批次 2 起依賴 D1–D6。
> 每包的「驗收」都寫成可觀測的結果，不寫「做完」。

### W0 — 量現況摩擦（新增；Claude 提出、DeepSeek 背書）

- **為什麼立成工作包**：三份稿子——包含每一份的優先序——都建立在直覺上
  （「全公司每人都用」「這是最痛的一格」），**沒有任何一個數字**。
- **歷史資料可算**：每張報銷單的明細數、成功解析為 `einvoice` 的比例。後者只能叫「解析成功率」，
  不能叫「原件有／無 QR」——`receipt` 同時包含真的無 QR 與掃描失敗。
- **短期前瞻抽樣**：拍照到送出的秒數、人工檢視後確認的真正無 QR 比例、分類初選到送出／退回重送
  的改選率。現有重送流程會刪掉舊明細，audit 又不記 body，歷史資料算不出改選率。
- 驗收：一張表，逐欄附樣本數、觀測期間、定義與資料來源；樣本不足就標「不足」，不補百分比。
- 依賴：無，與批次 0 並行。**可以翻案 W6／W7／W15 的 UX 優先序，但不延後 W2／W3／W4
  這類已證實的正確性修復。**

### 批次 0：修真缺陷（不需拍板，全部可測試）

**W1 — QR 雙碼辨識**
- 依據：`einvoice-qr.ts:101` 單次 `jsQR()` 只回一個碼；右碼以 `**` 起頭，
  `parseEInvoiceQr:17` 對它回 `null` → 落進 `Expenses.tsx:107` 手動分支 →
  `docType:"receipt"`／`deductible:false` → `expenses.ts:136-141` 硬規則使其**永遠不可扣抵**。
- 做什麼：一張影像掃出多個碼、左右碼合併（左碼取固定欄與明細前段、右碼 `**` 之後接續）；
  解不到就留白並說清楚是哪一種失敗。
- 驗收：合成雙碼影像測試綠；**且**一張實體證明聯照片能正確帶入號碼／日期／金額／統編。
- 依賴：無。**W5 要同時做**，否則分不清失敗是列印還是解碼造成的。

**W2 — QR 銷售額傳遞 ＋ 稅額不一致出聲**
- 依據：正則 `m[4]` 已捕獲銷售額但未回傳（`einvoice-qr.ts:22-28`）；
  `expenses.ts:156-161` 只能用費率回推 `amount - roundHalfUp(amount/(1+rate))`。
- 做什麼：`EInvoiceQr` 加 `salesAmount`；當「總計額 − 銷售額」與費率回推值不一致時
  **停止送單並請人選擇採用哪個來源**，把選擇明確帶回伺服器；不能只顯示 warning 後仍照舊回推。
  實作前要補定「選擇如何進 request、伺服器如何重驗、是否保存來源」三點，不讓任一方靜默勝出。
- 驗收：一張「銷售額 == 總計額」的合成 QR，未選來源不能建立報銷；選定後落地稅額與畫面一致。
- 依賴：無。措辭用 C-5（憑證所載值，非已驗真）。

**W3 — 報銷分類的可扣抵日期漂移**
- 依據：`Expenses.tsx:39` 取 `/expense-categories` **未帶 `onDate`**；
  端點預設用**今天**（`app.ts:2660`）；送單時卻以 `claimDate` 解析（`expenses.ts:134`）。
- 做什麼：前端帶 `onDate=claimDate`，`claimDate` 改變時重取。
- 驗收：補登舊單且期間內參數變動過時，畫面提示與落地稅額一致。
- 依賴：無。**這是 W7 的前置。**

**W4 — 文件硬事實勘誤（範圍已依第二輪擴大）**
- `1102` 的錯誤共有四處，**DeepSeek 已修其中兩處**（工作區未 commit）：
  - ✅ 已修：`deepseekHarnessDoc/bank-reconciliation-agent.md:94`、`docs/agent-ux-gap.md:74`
  - ❌ **尚未修（上游，更重要）**：`docs/SOP.md:286`「系統的 1102 銀行存款」、
    `docs/specs/bank-reconciliation.md:57`「1102 系現金科目」
- 事實：`chart.ts:70-71` 為 `CASH:"1101"`／`BANK:"1103"`，`1102` 是零用金（`chart.ts:158`）。
- **只改設計稿不改 SOP／spec 會再漂移**（DeepSeek 於 X4 特別提醒，成立）。
- 驗收：`rg -n "1102" docs deepseekHarnessDoc` 不再出現把它當銀行存款的句子；
  spec 那句一併改成「取帳戶綁定的 accountId」（C-9）。
- Codex 第二輪另發現 `docs/SOP.md:104` 稱 gm「一律唯讀（報銷除外）」也不完整；HR 申請／簽核／
  取消同樣是 `access:"any"` 的寫入例外（`auth.ts:387-392`）。同步修成與 ACL 一致，不藉文件掩蓋例外。

**W5 — 列印 QR 的 quiet zone**
- 依據：`print.tsx:111` `margin: 0`；`styles.css:558` 兩碼之間只有 `gap: 2mm`
  （`justify-content: space-between`）。官方規格要求每個 QR 周圍至少留 0.2 公分
  （Codex 引財政部 v1.9；我未讀原始 PDF，見 U1）。
- 驗收：列印出來的證明聯，左右兩碼各自能被獨立掃出。
- 依賴：無。與 W1 分開量測。

### 批次 1：純 UX（不需拍板）

**W6 — 報銷批次上傳**
- 做什麼：一次選多張 → 逐張跑 `readReceiptImage` → 生成 N 筆 `DraftItem`。
- **護欄（Codex 提出，Claude 原本低估、DeepSeek 第二輪採納）**：
  `einvoice-qr.ts:95-100` 每張都開原尺寸 canvas 解碼，N 張齊發會有記憶體尖峰；
  縮圖是 base64 進 DB（`Expenses.tsx:133`），整批 POST 會過大。
  需要：總張數／總大小上限、有限併發、逐張進度與局部失敗重試、前端同號防重
  （伺服端 `expenses.ts:145-154` 已有，前端要先擋以免整批被拒）。
- 驗收：一次 10 張含 QR 與無 QR 混合，全部落成明細；其中一張失敗不影響其餘九張。
- 依賴：W1（否則批次會把缺陷 A 放大十倍）。

**W7 — 歷史賣方分類候選**
- 做什麼：掃到 QR 後，依 `sellerTaxId` 查歷史，顯示**該賣方過去常選的 1–3 個分類**當候選，
  **不自動選中**；沒有歷史就什麼都不建議。
- 驗收：冷啟動時不給任何建議（不猜）；有歷史時候選正確且顯示次數。
- 依賴：W3。**不含任何 LLM 呼叫**——量出「還有多少比例需要問用途」之後（見 W0），
  才決定要不要為殘餘量做 agent 追問（那一步屬 D3 的形態）。

### 批次 2：責任模型（依賴 D1／D2／D3／D4）

**W8 — 動作分級單一事實來源 ＋ 漂移測試**
- 做什麼：把 read／propose／commit 的分級放進 `packages/core`（與 `ROLE_PAGES`、
  `SYSTEM_ACCOUNT_CODES` 同一條「清單只寫一次」紀律），內建側與 MCP 側都從它推導。
- 驗收分兩層：
  1. 清單測試斷言「commit 類動作 ∩ 任一 agent 工具集 = ∅」。
  2. 每個 propose tool 的 contract test 斷言：呼叫後只會產生 proposal artifact，**不得**出現目標
     domain row、approved/final 狀態或衍生效果；特別覆蓋 HR 空簽核鏈。
  只做第 1 層會被「名稱叫 propose、底下仍直 POST」繞過。
- 依賴：D2；D1 已定案。

**W9 — MCP 工具面收斂**
- 做什麼：依 D2 的結果調整 `apps/mcp/src/tools.ts`。
- **必須誠實稱呼**：這是「工具面護欄」，**不是 API 層的安全邊界**——
  持有金鑰的任意 HTTP 程式仍打得到 REST（`api-keys.ts:56-81` 解析出的 `AuthUser`
  與 session 使用者同形，`auth.ts:464-477` 只看 role）。文件不得把「有角色權限」寫成「有人確認」。
- 依賴：D2、D4。

**W10 — proposal／accept 契約**（僅當 D3 選 A）
- 做什麼：agent 回惰性的提案（allowlisted action／伺服器保存的完整 validated payload snapshot＋完整性 hash／來源／風險摘要／
  proposer／expiresAt／狀態）→ 對應頁面完整覆述 → 人按確認 → accept 時重驗 confirmer 權限與
  當下 domain state → 同一交易內單次消耗 proposal 並執行；audit 分記 proposer 與 confirmer。
  payload 不進 audit，並依內容套既有敏感資料保護與最短保存期限。
- **分階段（DeepSeek 建議）**：先落最簡形狀（proposal 表＋accept 端點＋audit 分記），
  把 `create_quote`／`create_hr_request` 遷過去，再談完整版。
- 現成同構可重用：`propose_memory`（agent 提議 → admin 核准才生效，`agent-chat.ts:209-222`）。
- 驗收：重複 accept、過期、payload 被改、權限已撤、來源單狀態已變都失敗；**由 agent proposal
  進入的 commit**，audit 查得到誰提案、誰確認。一般 UI 由人直接建立的單據不硬造 proposer。
- 依賴：D3。

### 批次 3：功能（依賴前面）

**W11 — C1 月結預檢擴充**：擴充既有 `checkPeriod()` 五項（`period.ts:83/110/141/167/189`），
agent 只負責白話解釋，**不另算一次**。依賴 C-7。**Codex 認領。**

**W12 — C2 導入 onboarding 收斂**：首頁六步（`Dashboard.tsx:24-61`）與
SOP 導入順序八步（`docs/SOP.md` ①–⑧）**已經漂移**（Claude 複核成立）。
先把步驟與完成條件集中成單一資料結構，讓首頁、SOP、agent 共用；Markdown SOP 必須由該結構
生成受控區段，或用 drift test 驗證，不接受再靠人手同步。依賴 C-7。**Codex 認領。**

**W13 — B2 今日 briefing**：依 D6。彙總端點與首頁卡片共用同一份資料源。
文案紀律：`agent-chat.ts:80-82` 已寫死「這些日期都是使用者自己設的，不是法定期限」——
主動推播是最容易破這條的功能，文案必須逐句標明來源（DeepSeek 背書）。**Claude 認領。**

**W14 — 對帳本體**：依 D5 的三分法推進。Claude／Codex 待分配。

**W15 — vision 紙本 OCR**：依 C-4 的 endpoint-bound consent；且 W1 必須先完成，
否則「QR 拍糊」與「真的沒有 QR」兩條路會互相掩蓋。排最後。

---

## 5. 分歧（X1–X4）——**本輪全數關閉，Codex 已確認**

| # | 議題 | 結果 |
|---|---|---|
| **X1** | `ship_order`／`convert_quote` 算不算 commit | **關閉**：Claude 撤回（未引 DECISIONS:9），DeepSeek 與 Codex 一致判 commit。併入 D2 由主導者確認判準 |
| **X2** | 對帳欄位推斷，確定性程式能做掉多少 | **關閉**：Claude 撤回「九成」，DeepSeek 亦撤回（「經驗問題不是論證問題」）。改由 W14 的 spike 量實測比例 |
| **X3** | 批次上傳的工程量 | **關閉**：採 Codex，護欄已寫進 W6，DeepSeek 第二輪確認 |
| **X4** | 收斂順序：文件勘誤 vs QR 正確性誰先 | **關閉**：批次 0 同批做完。DeepSeek 補充 SOP／spec 要一起掃，已納入 W4 |

---

## 6. 原稿勘誤（E1–E9）

**DeepSeek Harness 的稿子**（E1–E4、E6–E8 已修入工作區，未 commit）

- **E1** ✅ 已修 `bank-reconciliation-agent.md:94`。**但 DeepSeek 自己補了更重要的一半**：
  同一個錯字也在上游 `docs/SOP.md:286`（Claude 複核：**仍在**）與
  `docs/specs/bank-reconciliation.md:57`（**仍在**）。已擴進 W4。
- **E2** ✅ 已修（零斷言：可扣抵性是 `chart.ts:240-247` 明寫的「尚未經查證的預設」）。
- **E3** ✅ 已修（`chart.ts:267` 是「餐飲與交際」）。DeepSeek 補充一條有用的觀察：
  `chart.ts:150` 科目表的名稱是「交際費」，兩處本就不同——報銷語境採「餐飲與交際」。
- **E4** ✅ 已修（改引 `DECISIONS.md:9`，不再引 `soul.md`）。
- **E5** ⚠️ **我方撤回一半。** DeepSeek 指出「MCP 側漏列 `convert_quote`」不成立，
  我用 `git show dc318c4:docs/agent-ux-gap.md` 複核——**原始版本第 44 行確實已列
  `| 報價轉訂單 | ❌ | ✅ convert_quote |`，DeepSeek 是對的。**
  我的出處是 `deepseekHarnessDoc/README.md:44-45` 的 Q0 提問句（只點名了
  `approve_expense_claim` 與 `ship_order`），我把它誤植到盤點表上。
  Q0 提問句原本只點名兩個工具的措辭也已在 v3 工作區補上 `convert_quote`。
  「內建側漏列 4 個」那一半成立，DeepSeek 已補。
- **E6** ✅ 已修（3 個 body builder，不是 4 個）。
- **E7** ✅ 已修（現況表改成「✅ 已有，但見 W1／W2」）。**E 系列最實質的一條。**
- **E8** ✅ 已修（「只送表頭」自我矛盾 → 改「本機算出的型別與形狀摘要」）。

**Claude 的稿子（`review-claude.md`）**

- **E9** 三處撤回（尚未改稿，因為 review 是歷史紀錄，修正記在此處）：
  ①§2.4(a) 說 `README.md:36` 是「假的」——**過頭**，該句限定於「內建 AI 助理」bullet
  （`README.md:35-38`），內建側確實沒有核准／過帳工具；
  ②§2.3 說一人公司沒有可用的受限角色——**過度絕對**，`gm` 的一般頁面受限且不能核准報銷，
  但 `/expense-claims` 與 `/hr-requests` 是寫入例外，不能再稱全域唯讀；真正缺的是可精準表達
  restricted-read＋inert-propose 的角色（`roles.ts:71`、`auth.ts:354,374-392,473`）；
  ③§2.4(c) 的 `viaApiKey` default-deny——**繞得過**（`mcp/client.ts:25` 支援帳密換 session；
  內建 agent 沿用本人 cookie，`app.ts:2545-2559`），方向本來就錯：憑證種類不等於人在場。
  另：全稿未引用 `DECISIONS.md:9`，那是本案的既有定案——**這是我的查證漏失**，
  也是我在 Q0 上輸給 Codex 的直接原因。
  **本輪再加一條**：E5 的一半是我的誤植（見上）。

**Codex 的稿子（`review-codex.md`）**

- 第一輪稿 §1 用「finance 與 admin 都拿到全部 PAGE_KEYS」反駁「沒有受限角色」，理由不成立；
  gm 雖較受限但仍有報銷／HR 寫入例外。第二輪已改以「現有角色缺 restricted-read＋inert-propose」
  表述，不再把 gm 當全域唯讀反證。

---

## 7. 建議的執行順序

```
現在就能開工（不需拍板）
  W0     ：量現況摩擦（歷史可算＋前瞻抽樣）——與批次 0 並行，可翻案 UX 優先序
  批次 0 ：W1 QR雙碼 ＋ W5 quiet zone（同批量測）｜W2 銷售額＋出聲｜W3 日期漂移｜W4 文件勘誤（含 SOP／spec）
  批次 1 ：W6 批次上傳（依 W1）｜W7 歷史分類候選（依 W3）

同時進行（你拍板）
  D1 責任模型（已定，文件待同步）──▶ D2 動作分級 ──▶ D3 proposal契約（可分階段）──▶ D4 能力邊界（A＋B）
  D5 對帳範圍（另需你提供銀行匯出檔樣本＋「有沒有用支票」）
  D6 briefing 通道

拍板後
  批次 2 ：W8 分級＋漂移測試｜W9 MCP收斂｜W10 proposal契約（先做最簡形狀）
  批次 3 ：W11 C1｜W12 C2｜W13 B2｜W14 對帳本體｜W15 vision（最後）
```

**核心判準**（三方一致）：先修「錯了零徵兆」的東西；
格式辨識、日期規則、比對證據、狀態轉移交給可重現可測試的程式；
AI 只放在真正需要語意與追問的地方。

---

## 8. 未驗證清單（不得當論據用）

- **U1** 財政部規格 v1.9 的兩項細節——明細編碼參數 `0=Big5／1=UTF-8／2=Base64`、
  QR 周圍至少 0.2 公分空白——由 Codex 引一級來源，**Claude 與 DeepSeek 都未讀原始 PDF**。
  W1／W5 動工前請核對。
- **U2** QR 缺陷 A 在**實體相機照片**上的發生率。Codex 已用合成雙碼影像重現存在性，
  但實拍頻率未知。W1 的驗收必須含實體 golden image。
- **U3** `m[4]` 銷售額欄在所有開票軟體上是否一致為未稅——依據僅為 repo 自己的欄位註解
  （`einvoice-qr.ts:5`）與我方產碼實作（`:59`）。這也是 W2 採「不一致就出聲」而非
  「用 QR 值覆蓋」的原因。
- **U4** 各銀行實際匯出檔的格式。確定性 profiler 的可行性是一般推論，
  拿到第一份真實檔要重新評估（見 X2）。
- **U5** **已升格為工作包 W0。** 三份稿子的優先序都沒有量過現況摩擦；
  DeepSeek 第二輪明確表示接受「量完優先序翻案」。現有資料不足的欄位改採前瞻抽樣，不反推。

---

*Claude／Codex ／ 2026-08-20 ／ v3：收斂 `dc318c4`（DeepSeek）＋ `review-claude.md` ＋
`review-codex.md` ＋ `review-deepseek-round2.md` ＋ `review-codex-round2.md`*
