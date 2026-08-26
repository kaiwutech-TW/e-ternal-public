# review-codex — Codex 對 DeepSeek Harness 與 Claude 審閱的獨立查驗

> **角色**：三方交叉審閱中的 Codex。這份只做查驗與方案收斂，不修改程式碼，也不改
> DeepSeek Harness／Claude 的原稿。
> **方法**：先獨立讀設計與紅線，再核對程式碼；電子發票 QR 另核對財政部一級規格，
> 並以 repo 現有 `qrcode`＋`jsQR` 做一次不落檔的合成雙碼實驗。

---

## 0. 結論先講

我不會直接照 Claude 的優先序做。Claude 抓到幾個真問題，但也把三件事說得過頭：

1. `README.md:35-36` 的「工具集只有讀取與草稿」在語法上屬於**內建 AI 助理**那一個 bullet；
   內建側確實沒有核准／過帳工具。它需要補清楚與 MCP 的差異，但不能直接說這句全域為假。
   真正衝突的是較新的 `.flightwake/DECISIONS.md:9`、較舊的 `agent/soul.md:35-41`、MCP
   寫入工具三者沒有收斂。
2. Claude 提議用 `viaApiKey` 在 API 層擋敏感動作，**仍不能證明有人按過**：MCP 也支援帳密換
   session（`apps/mcp/src/client.ts:32-67`），內建 agent 更會沿用目前使用者的 cookie
   （`apps/api/src/app.ts:2543-2559`）。認證來源不是人類 presence。
3. 「確定性 sniffer 可做掉九成」與「多張批次很簡單」目前都沒有 golden sample／效能證據，
   方向合理，百分比與工作量判斷不能先當事實。

我認為此輪最重要的新發現反而是：

- 對帳兩份文件把 `1102` 寫成銀行存款；實際上 `1102 零用金`、`1103 銀行存款`，且自建
  銀行科目不一定是 `1103`。對帳必須取「本銀行帳戶綁定的 accountId」，不能寫死代號。
- 報銷頁的分類可扣抵提示按**今天**解析，真正送單按 `claimDate` 解析；補登舊單時 UI 與
  落地結果可能不同。分類 agent 上線前要先收掉這個日期漂移。
- C1 月結預檢與 C2 導入 wizard 都不是白紙：`checkPeriod()` 已有 5 項月結檢查，首頁已有
  6 步 GettingStarted；問題是覆蓋不足與兩份真相，不是缺一隻聊天 agent。

---

## 1. Claude 觀點查驗

| Claude 結論 | 我的判定 | 查驗結果 |
|---|---|---|
| MCP 刪工具關不了 REST API | **同意，但只講了一半** | 對可任意打 HTTP 的程式成立；對只能使用 MCP 暴露工具的模型，刪工具仍是有效的結構性縮面。兩個威脅模型要分開。 |
| `viaApiKey` default-deny 可把門關上 | **不同意** | MCP 可走帳密 session；內建 agent 也走 session。若要證明「人按過」，要的是綁定動作內容的人工確認流程，不是登入方式旗標。 |
| 一人公司沒有可用的受限角色 | **不同意事實敘述** | `finance` 與 `admin` 都拿到全部 `PAGE_KEYS`（`packages/core/src/roles.ts:66-69`）；finance 不是「什麼都做不了」。真問題是現有角色都太粗，沒有 read/propose-only 角色。 |
| README 安全宣稱是假的，應排第一 | **需補強** | 該句明確在「內建 AI 助理」項下，內建側的核准／過帳門確實不存在。應先釐清全域責任政策，再修 wording；不是單純改掉一句話就完成安全修復。 |
| QR 缺陷 A 是真缺陷 | **存在性已重現，頻率未證實** | `jsQR` API 只回一個 `QRCode|null`；本次用左右各可單獨解出的 V6 QR 合成雙碼影像，跨多組尺寸／間距均回 `null`。但實體相機照片的發生率仍需 golden image。 |
| QR 缺陷 B 會用稅率回推出錯 | **同意，而且處理方式可更直接** | 財政部 v1.9 規格明定左碼銷售額為未稅總額；買受人為營業人時應能分離。對能扣抵的 B2B QR，應保存 QR 銷售額並以 `總計額－銷售額` 取得憑證所載稅額；不必讓通用費率反過來覆蓋它。 |
| QR 值是權威值 | **不同意用詞** | parser 沒驗 24 碼加密驗證資訊，repo 自印 QR 目前還是 24 個 `0` 佔位。它是「憑證所載的結構化值」，不是已驗真的權威資料。 |
| 自架 Ollama/custom 可直接開 vision | **不同意** | provider 名稱不證明資料位置；`custom` 可填公網 URL，Ollama 也可能部署在遠端。必須以實際 endpoint＋管理者明示同意判定。 |
| 歷史賣方分類可取代 LLM | **部分同意** | 可當可解釋的候選，但同一賣方可能同時服務 `6112 員工伙食`、`6115 員工福利`、`6137 餐飲與交際`；不能因「過去最多」就自動選中。用途仍要由人回答。 |
| 批次上傳應排第一且很單純 | **同意價值，不同意低估工程風險** | 現在每張都以原尺寸 canvas 解碼，再存最長邊 1200px 的 base64；批次要有總張數／總大小護欄、有限併發、逐張進度與局部失敗，否則容易記憶體尖峰或整批 POST 過大。 |
| C1／C2 尚待展開 | **需改寫前提** | C1 已有 `/period-closes/check`；C2 已有 `GettingStarted`。應擴充／收斂既有確定性流程，不另做第二套 agent 邏輯。 |

### QR 的額外查驗

財政部《電子發票證明聯一維及二維條碼規格說明》v1.9 還確認了三件事：

- 左右兩個 QR 是正式規格，右碼以 `**` 起頭；
- 明細編碼參數不是只有 UTF-8：`0=Big5`、`1=UTF-8`、`2=Base64`；
- 每個 QR 周圍至少需保留 0.2 公分（±10%）空白。

目前 `QrImg` 用 `margin: 0`，左右只留 `gap: 2mm`（`print.tsx:111`、`styles.css:558`）。
這不足以讓中間兩側各自都有 2mm quiet zone。實體掃描驗收要把「列印碼可讀性」與
「jsQR 多碼能力」分開測，不能全算在同一個 bug 上。

一級來源：
[財政部電子發票證明聯一維及二維條碼規格說明 v1.9](https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/attachments/1575448081679_0.pdf)、
[jsQR 官方型別與回傳介面](https://github.com/cozmo/jsQR/blob/master/dist/index.d.ts)。

---

## 2. Q0：MCP 與內建側的責任紅線

### 結論

**產品政策要收齊，但不要把「MCP 工具面」「REST API 權限」「證明人按過」混成同一層。**

依較新的 `.flightwake/DECISIONS.md:9`，我建議三方先以這句為準：agent 可以準備，真正落地
由人確認。這會導出以下結果：

- `approve_expense_claim` 應從一般 agent 的 MCP 工具面移除；
- `ship_order` 會開銷貨單、扣庫存、拋傳票，也已經落地，不能像 Claude 建議那樣排除在
  人類確認清單外；
- `convert_quote` 會建立訂單，是對交易對象的承諾，也應走「提案 → 人確認」，不是模型直接 POST；
- `create_quote` 與 `create_hr_request` 雖落在 open／pending 狀態，但目前工具呼叫仍直接 POST，
  操作日誌記目前登入者；若要求「確認的那一下才是責任轉移」，它們也需要顯式 proposal／accept
  契約，而不是只靠 system prompt 判斷使用者是不是已經說可以。

### 建議的三層結構

1. **能力層**：所有 agent tool 標成 `read`／`propose`；一般 agent manifest 不暴露 `commit`。
2. **工作流層**：agent 只回傳不可直接入帳的 proposal，內容含 action、payload、來源與風險摘要；
   使用者在對應頁面看到完整覆述後按確認，伺服器才執行，audit 分別記 proposer 與 confirmer。
3. **認證層**：REST API 仍依角色 ACL，供受信任腳本整合；文件不得把「有角色權限」說成
   「有人確認」。若需求升級成防止任意 HTTP agent 冒充人，才需要 recent re-auth／WebAuthn
   user-presence 這類能證明人在場的機制。

短期先從 MCP 拿掉 final action 是有價值的縮面，但要誠實稱為「工具面護欄」，不能稱為 API
層的絕對安全邊界。`viaApiKey` 只能當額外收窄，不能當人類確認證明。

另外應先修文件衝突：`agent/soul.md:35-41` 目前仍寫成「覆述後 agent 可以核准／出貨」，
晚於它的 DECISION 則寫「agent 只產草稿、人按確認才生效」。Q0 未拍板前，任何一份工具清單
都沒有穩定規格可依。

---

## 3. Q1：紙本收據影像是否可送外部 LLM

### 結論

**預設關閉；提供管理者明示開關，但開關必須綁定實際 endpoint，而不是綁 provider 名稱。**

建議形狀：

- QR 解碼與手動輸入永遠可用，不因 vision 未開而壞掉；
- 每一組 `{provider, baseUrl, model}` 有獨立的「允許傳送收據影像」同意，預設 false；
- provider／baseUrl／model 任一變更時自動回到 false，避免原本同意內網端點，改成公網後沿用；
- 設定頁與每次上傳處都具名顯示影像將送到哪個 endpoint；`custom`／Ollama 不自動視為內網；
- 只送 OCR 所需的裁切／縮圖，不把原始影像、對話歷史或無關欄位一起送；供應商保存條款由
  管理者自行查證，系統不代為斷言。

所以 README 的兩個選項其實不是二選一：正確答案就是「**預設關閉＋管理者可明示開啟**」。

---

## 4. Q2：B1／B2／C1／C2 的展開與認領

| 條目 | 我的建議 | 原因 |
|---|---|---|
| B1 銷售 chain | 暫緩 | Q0 尚未收斂；出貨會扣庫存與拋傳票，不能先設計 agent 自動串單。 |
| B2 主動推播 | 展開，但先做站內 briefing | `/reports/dashboard` 已含 upcoming，缺的是通知狀態、去重、角色、時區、退訂與送達通道；「純讀」不等於低工程量。先做登入後今日摘要，再評估真正 push。Claude 已認領，可由 Claude 展開。 |
| C1 月結／401 預檢 | **展開，我願意認領** | `checkPeriod()` 已有依序關帳、折舊、庫存差額、待核報銷、待付報銷五項；應擴充同一份結構化檢查，agent 只負責白話解釋，不另算一次。 |
| C2 導入 wizard | **展開，我願意認領** | 首頁 6 步與 SOP 8 步已漂移。先把步驟與完成條件集中為單一資料結構，再讓首頁、SOP、agent 共用；這比新增聊天 wizard 更急。 |

Codex 若後續認領，C1 大綱是「盤點既有 check → 補可機械驗證項 → 掛銀行調節結果 → agent
只讀解說」；C2 大綱是「單一 onboarding state machine → 依公司情境標可略過 → 每步明確完成條件
與導頁」。本輪不先寫展開稿，等主導者選定範圍。

---

## 5. 報銷設計未決問題

### 5.1 品名來源：QR 明細優先，vision 只補無 QR

同意 QR 優先，但順序要改成：

1. 先把列印 quiet zone、完整雙碼辨識、左／右碼合併與實體 golden image 驗收做好；
2. parser 支援官方的 Big5／UTF-8／Base64 三種明細編碼；解析失敗就留白，不猜；
3. 保存 `salesAmount` 與 `totalAmount`，對有公司統編的 B2B 憑證使用 QR 所載差額作為稅額來源；
4. 無 QR 或 QR 真的讀不到，才在管理者已同意的 endpoint 下使用 vision OCR。

品名不等於用途，因此不能直接決定 `6112 員工伙食`、`6115 員工福利` 或
`6137 餐飲與交際`。較好的 MVP 是：

- 顯示「這家賣方過去常選的 1–3 個分類」作候選，不自動選中；
- 若候選有歧義，問一個用途問題讓人點；
- LLM 的價值是把缺的用途問清楚，不是在缺資訊時硬猜科目。

### 5.2 草稿停在哪：報銷頁內嵌，MVP 不做 agent tool

同意 Claude 對現況通道的判斷：`AgentChat` 只收到 `{reply, steps}`，無法把工具 payload 放進
另一頁 React state。MVP 應由報銷頁持有照片與 `DraftItem[]`，呼叫純建議端點後填表；端點不寫單。

若長期真的要「在對話裡起草後跳頁」，應先定一個通用 `UIProposal` 契約與 accept 流程，不能
把 `/expense-claims` 塞進 `TOOL_POST_PATH` 假裝是草稿。

### 5.3 description：可以填，但保留來源，不讓 LLM潤飾成新事實

- QR 有品名：填入 QR 原文，可讓人編輯；
- OCR：保留 OCR 原文與欄位來源／不確定狀態；
- 用途由人補充時，可組成「原品名｜用途」；
- 不讓 LLM 把「拿鐵」改寫成「客戶餐敘」之類不存在於憑證的事實。

### 5.4 Claude 漏掉的前置修正

`Expenses.tsx` 取得 `/expense-categories` 時沒有帶 `claimDate`，但伺服器真正送單時以
`claimDate` 解析可扣抵參數。任何分類建議與 DeductibleNote 都要先綁同一個單據日期，否則
agent 說得再漂亮，使用者看到的提示仍可能與落地稅額不同。

批次上傳值得做，但要一起設計：有限併發、逐張成功／失敗、重試、總 payload 護欄與同號防重；
不能只把 `readReceiptImage` 無限制跑 N 次。

---

## 6. 對帳設計未決問題

### 6.1 golden sample 到手前能不能動工

我的答案比 Claude 更保守地拆成三塊：

- **可以先做**：手動勾對第一等公民、調節表 domain model、比對候選引擎與 suggestion/confirm
  狀態邊界；這些不依賴銀行檔格式。
- **可以做 spike、不可宣稱完成**：CSV 編碼／欄位 shape profiler，以 synthetic fixtures 驗證框架。
- **等至少一份真實去識別化檔再定案**：匯入對應檔 schema、sniffer 規則、CSV/xlsx 支援範圍與
  驗收。spec 已把真實檔列為動工前提，不應在尚無證據時直接改成「只卡驗收」。

這樣不會乾等，也不會對著想像把最容易返工的匯入層寫死。

### 6.2 樣本去識別化預設

預設整個 profiling 在本機做，不送原始交易列。能確定性解析的項目（編碼、日期形狀、正負號、
收支雙欄、數值分布）不需要 LLM。真的有殘餘歧義時，先讓使用者在 mapping UI 選；只有管理者
明示同意後，才可送已遮罩的欄位摘要，而且沿用 Q1 的 endpoint-bound consent。

「只送表頭」確實不足，但答案不是送完整資料列，而是送本機算出的型別與形狀摘要。

### 6.3 confidence／anomaly

不加模型生成的 `confidence: 0.87`。但也不只放一個籠統 `anomaly`：引擎應回可驗證 evidence：

- 金額是否完全相等；
- 日期相差幾天；
- 候選數量（唯一／多筆同額）；
- 摘要／對象是否有可核對線索；
- 一對多組合明細；
- 哪條 deterministic rule 產生建議。

UI 可依 evidence 排序，但每一筆仍由人按「確認對上」。這比沒有定義的分數更可測，也比只標
異常更能讓人快速判斷。

### 6.4 journal 草稿／送出邊界

同報銷：放在對帳頁內的「補傳票」表單，不做會直接 POST 的 agent tool。日期、金額、摘要可由
銀行列帶入；另一側科目由人選。銀行側科目必須來自本次對帳帳戶綁定的 accountId，畫面顯示
實際代號與名稱，**絕不能照文件寫死 `1102`**。

目前科目事實是：`1102 零用金`、`1103 銀行存款`；使用者還能自建例如 `1104 銀行存款－玉山`。

---

## 7. 建議的收斂順序（尚未替主導者拍板）

1. **先收斂責任模型**：確認較新的 DECISION 是否正式覆蓋 soul 舊規則；列出 read／propose／commit
   動作，`ship_order` 也要按副作用正確歸類。
2. **修設計事實**：對帳 `1102`、README 適用範圍、報銷「QR 權威值」用詞、分類可扣抵日期來源。
3. **先做 QR 正確性驗收再做 agent**：quiet zone、完整雙碼、三種明細編碼、salesAmount 傳遞、
   本系統列印＋外部實體發票 golden images。
4. **報銷純 UX**：有限制的批次上傳；歷史分類只作候選＋用途快問；全部停在表單。
5. **擴充既有 C1／C2**：不要另長第二套 agent 規則。
6. **對帳先本體後敘事**：手動勾對／調節表／候選 evidence 先行；有真實檔後再定 import mapping。
7. **vision 最後**：Q1 的 endpoint-bound consent 與影像最小化完成後才上。

這個順序的核心不是「少用 AI」，而是把 AI 放在真正需要語意與追問的地方；格式辨識、日期規則、
比對證據與狀態轉移仍由可重現、可測試的系統負責。

---

*Codex ／ 2026-08-19 ／ 對應基線 commit `a6ed6fe`；審閱時工作區另有使用者提供的
`review-claude.md`，未修改。*
