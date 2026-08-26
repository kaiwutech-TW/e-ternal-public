# 法規規格書（specs）

本專案的法遵開發方法：**法規即規格**。每個法遵功能動工前，先在這裡寫一份規格書，把每條規則對照到法源出處與驗證方式。程式碼審查驗不出法遵正確性——規格書才是被審的對象。

## 規則

1. **一級來源優先**：財政部/大平台/全國法規資料庫的原文與官方格式文件。第三方文章只能當線索，不能當依據。
2. **開源專案只用來對答案**：規格書寫完後，對照 django-taiwan-einvoice、Dolibarr 台灣模組、Odoo l10n_tw 等實作；**不一致處＝回頭查法規的訊號**，不是誰對誰錯。GPL/LGPL 程式碼不得複製（見 DECISIONS 2026-07-21）。
3. **每條規則要能回答三件事**：法源在哪（條文/公告 URL）、程式在哪（檔案路徑）、怎麼驗（測試/官方環境/記帳士審）。

## 規格書狀態

| 狀態 | 意義 |
|---|---|
| `draft` | 已寫，未經專業審閱 |
| `cross-checked` | 已與開源實作交叉對照 |
| `reviewed` | 記帳士/會計師已審 |
| `verified` | 已在官方環境（測試環境/申報軟體）實測通過 |

## 現有規格書

| 規格書 | 狀態 | 對應實作 |
|---|---|---|
| [tax-id.md](tax-id.md) 統一編號檢查碼 | draft | `packages/core/src/tax-id.ts` |
| [posting-rules.md](posting-rules.md) 拋轉傳票與金額規則 | draft | `packages/core/src/{money,posting,inventory}.ts` |
| [tax-parameters.md](tax-parameters.md) 稅法參數（使用者自填的稅率／級距／可扣抵性，附生效期間與依據） | **done**（結構與接線完成；**數值一律由使用者填**，本專案不提供） | `packages/core/src/tax-parameters.ts`、`apps/api/src/services/tax-parameters.ts` |
| [einvoice-mig41.md](einvoice-mig41.md) 電子發票 MIG-4.1（含官方範例 XML 於 `sources/`） | draft | （Phase 2） |
| [vat-401-403.md](vat-401-403.md) 營業稅 401/403 申報 | draft | （Phase 3） |
| [chart-of-accounts.md](chart-of-accounts.md) 會計科目表 | draft（**自用已足**；對外發布預設科目表前需專業覆核） | `packages/core/src/chart.ts` |
| [bank-reconciliation.md](bank-reconciliation.md) 銀行對帳（資料取得管道與作業形狀） | draft（**動工前提：使用者提供往來銀行的實際匯出檔**） | （未動工） |
| [hr-attendance.md](hr-attendance.md) HR 出勤（勞基法數字全部使用者自填） | 實作中 | 0039-0042、0044-0045 |
| [withholding.md](withholding.md) 各類所得扣繳 | **partial**（帳務與年度取數已上線；憑單媒體檔格式規格未取得） | `packages/core/src/withholding.ts`、`apps/api/src/services/withholding.ts` |

註：`draft`／`partial` 之外的括號註記，是因為單一狀態值講不清「哪一段可以用、哪一段還不能」。
狀態值本身不新增——新增狀態只會讓這張表變成另一套要維護的詞彙。

**貫穿所有規格書的紀律（使用者 2026-07-30 拍板）**：
系統提供結構與算術，稅率／級距／門檻一律由使用者填寫並附自己查到的依據；
**系統絕不斷言任何稅率、免稅額度、繳納期限或憑單格式代號**。規格書自己也適用這一條。
連舉例都不能用實際稅率——例子裡的數字就是使用者最可能照抄的答案，
所以文件、程式註解、UI 文案、placeholder、錯誤訊息與測試資料的範例一律用中性數字（3.5%、10 萬）。

這條紀律的**落點**自 2026-08-01 起集中在兩處：扣繳類別的費率欄位（migration 0015），
以及 [tax-parameters.md](tax-parameters.md) 的稅法參數表（migration 0016，帶生效期間、append-only）。
營業稅率與報銷分類的可扣抵性已從程式常數搬進後者；
**系統仍不計算營所稅與未分配盈餘加徵的稅**——那兩種參數只被保管，不被使用。
