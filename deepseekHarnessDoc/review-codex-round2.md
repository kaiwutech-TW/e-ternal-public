# review-codex-round2 — Codex 對收斂計畫 v2 的複核

> **範圍**：只複核 `review-deepseek-round2.md` 與 `plan-converged.md` v2；不動程式碼。
> **結論**：X1–X4 可以關閉；E5 撤回正確。v2 仍有四個會改變實作的事實／邊界要修。

## 0. 對 v2 六個問題的直接回覆

1. **X1–X4**：確認全部關閉；我的立場未變。
2. **D2**：分類與實作可以分開談，但「動帳／不可逆」不能當 commit 的唯一判準。`create_quote`／
   `create_hr_request` 的**目標 agent 能力**可叫 propose；現行工具直接寫正式 domain row，則不是合規的
   propose 實作。尤其 HR 無簽核鏈時會直接 approved，不能再寫成「需主管核准」。
3. **D4**：角色與 proposal 契約確實互補；但 gm 並非全域唯讀，`/hr-requests` 與報銷本體是明列例外。
   另外 `agent` 角色只能限制專用帳號／API key，內建助理沿用目前登入者身分，仍需工具契約。
4. **E5**：撤回正確，沒有過頭。原始盤點表本來就列了 `convert_quote`；只剩 README Q0 沒點全名稱的
   措辭問題。
5. **W0**：與批次 0 並行，不作為已知正確性修復的阻塞前提；但四個數字要重寫資料來源，現有資料
   算不出「分類被改掉率」，也不能把 `receipt` 直接等同「原件無 QR」。
6. **W11／W12**：認領範圍照 v1 算數。W12 的「單一資料結構」要用生成文件或 drift test 讓 Markdown
   SOP 可被機械驗證，不能只靠人同步。

## 1. v2 必修

### R1 — D1 已由既有 decision 定案，不應再當待拍板

`.flightwake/DECISIONS.md:3` 明定新舊衝突由 decision log 決定，`:9` 已定案「寫入類動作一律
agent 產草稿、人按確認才生效」。除非主導者現在要**推翻** 2026-08-13 的決定，否則 D1 是文件與
工具面同步工作，不是再投一次票。

### R2 — D2 要按「是否跨過責任轉移點」分類

- `read`：不改 domain state。
- `propose`：最多寫入**惰性的 proposal artifact**；它不能自行生效，唯一前進路徑是人按 accept。
- `commit`：建立或改變已生效的 domain state，或在沒有另一個強制人工閘門時可直接產生效果。

「會不會動帳」「是否可逆」是風險訊號，不是唯一判準；可作廢的正式單仍是人對員工／交易對象的
承諾。依實際副作用看，今天的 `create_quote` 和 `create_hr_request` 都是直接 write；遷到 D3 後，
agent 工具才會變成真正的 propose。

### R3 — `create_hr_request` 有無人確認即生效路徑

`hr-leave.ts:267-297` 在 approval chain 為空時直接建立 `approved`，並呼叫 `applyApprovedEffects()`；
忘打卡會立刻寫入 punch。`agent-chat.test.ts:120-140` 為了測到 pending，特地先替測試員工設主管。
因此 v2 的「進簽核鏈，需主管核准」不是普遍事實，也證明 W8 不能只做工具名稱集合測試。

### R4 — W8／W10 要驗副作用與 accept 契約，不只驗清單

W8 除了斷言 agent 工具沒有 commit 類工具，還要對每個 propose 工具做 contract test：呼叫後不得
出現目標 domain row、approved/final 狀態或衍生效果。W10 的 minimum viable contract 至少包含：
allowlisted action、完整 payload snapshot/hash、proposer、期限、單次狀態轉移；accept 時重驗確認者權限
與當下 domain state，並在同一交易內消耗 proposal＋執行，防重放與 stale proposal。

### R5 — W0 的量測來源要拆成歷史可算與前瞻抽樣

既有資料能量「每單明細數」與「成功解析為 einvoice 的比例」。完成秒數、真正無 QR 比例、分類初選
到最後值的改選率都要用短期前瞻抽樣；退回重送會刪掉舊明細，audit 又刻意不存 body，不能從歷史表
反推。W0 可改變 UX 功能排序，但不應延後 W2／W3／W4 這類已證實的正確性修復。

### R6 — C-1 與 D3 要明確分層

C-1 的「頁面純建議端點」應限定於需要把結果填回 browser state 的報銷／傳票表單；D3 則是跨頁、
可持久化的 agent proposal。否則「agent 草稿不做 tool」與「create_quote 遷到 proposal tool」在同份
計畫裡互相衝突。

## 2. 建議但不阻塞本輪收斂

- W2 還要定義不一致時**哪個值落地**、人如何把選擇帶回伺服器，以及是否保存來源；只有警告文字
  不能防止送單後仍走舊回推。
- W10 的驗收應寫「agent-originated proposal 被接受時有 proposer／confirmer」，不是「任何 commit
  都要兩筆」；人從一般 UI 直接建立合法單據時，本來就沒有 proposer。
- D3 的最小版仍包含 migration、狀態機、權限、交易與 audit，不宜宣稱工程量接近純建議端點。

---

*Codex ／ 2026-08-20 ／ 複核 `plan-converged.md` v2*
