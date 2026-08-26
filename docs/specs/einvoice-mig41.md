# 電子發票 MIG-4.1（開立/作廢/折讓/配號）

**狀態**：draft ｜ **最後更新**：2026-08-10 ｜ **對應實作**：`packages/einvoice`（F0401/F0501/G0401/G0501 產生器）＋ `apps/api/src/services/invoices.ts`（配號/開立/作廢）＋ `apps/api/src/services/allowance-xml.ts`（銷貨折讓 G0401 接線）

## 規則對照表

| # | 規則 | 依據 | 實作 | 驗證方式 |
|---|---|---|---|---|
| 1 | F0401/F0501 欄位順序與命名空間 `urn:GEINV:eInvoiceMessage:{訊息}:4.1` | MIG-4.1（官方範例檔） | `packages/einvoice/src/{f0401,f0501}.ts` | **golden 測試：與 5 個官方範例正規化後逐字一致** |
| 2 | B2C 存證（買方統編 0000000000）：金額**內含稅**，TaxAmount=0、TotalAmount=SalesAmount，明細亦含稅 | 官方範例 KZ10000010/11/12 | `buildF0401` 驗證 ＋ `toInclusiveItems` | golden＋E2E＋負向測試（稅額非 0 拒絕） |
| 3 | B2B 存證：稅額分離，TotalAmount=SalesAmount+TaxAmount，明細未稅 | 官方範例 KZ10000002 | 同上 | golden＋E2E＋負向測試 |
| 4 | 明細合計須等於 SalesAmount（B2B 未稅口徑）或 TotalAmount（B2C 含稅口徑） | MIG 金額一致性 | `validate` | 負向測試 |
| 5 | 捐贈發票 DonateMark=1 必附捐贈碼 NPOBAN（位於 PrintMark 之後） | 官方範例 KZ10000011 | `validate`＋欄位序 | golden＋負向測試 |
| 6 | 發票號碼＝字軌 2 大寫字母＋8 碼數字；由期別（雙月、奇數月起算）字軌區間依序配號，區間用罄拒開 | 字軌取號使用說明書 v1.1 | `invoice_tracks` 表＋`allocateNumber` | E2E（KZ10000000→01 遞增、用罄 409） |
| 7 | 同一銷貨單僅能開立一張發票；作廢產生 F0501 並記錄原因，不得重複作廢 | 營運規則＋MIG F0501 | `invoices.sale_id UNIQUE`＋狀態機 | E2E（409 案例） |
| 8 | B2C 明細含稅換算：各明細未稅×（1＋稅率）四捨五入，與總額尾差調整於最後一筆（稅率取自使用者設定的稅法參數） | 實務慣例（DECISIONS 2026-07-21，**待記帳士確認**） | `toInclusiveItems` | E2E（99→104 案例） |
| 9 | G0401 折讓：明細記原發票座標（號碼/開立日/明細序號）＋折讓金額，金額口徑 B2B/B2C 一律**未稅**、TotalAmount=未稅合計（與 F0401 B2B 的含稅總額不同）；賣方開立 AllowanceType=2 | 官方範例 ALW10000003/ALW10000013（B2C 範例原發票含稅 20 → 折讓 Amount 19＋Tax 1，兩份互證） | `packages/einvoice/src/g0401.ts`＋`services/allowance-xml.ts`（cert_no=AllowanceNumber、單頭稅按未稅比例攤到明細） | **golden：與兩份官方範例逐位元組一致**＋負向測試＋API 九條 |
| 10 | G0501 作廢折讓：扁平結構，較 F0501 多 AllowanceType、無 ReturnTaxDocumentNumber | 官方範例 G0501-ALW10000003/ALW10000013 | `packages/einvoice/src/g0501.ts`（**尚無服務層接線**：折讓單沒有作廢入口，0025 不含 sales_returns） | golden：兩份官方範例 |

## 一級來源（均為 einvoice.nat.gov.tw 官方，封面/版本經實際下載驗證）

| 文件 | 版本/日期 | URL |
|---|---|---|
| 電子發票資料交換標準訊息建置指引（MIG）V4.1 中文版 PDF，212 頁 | V4.1 初版 2024-12-13（2025-01-01 施行）；最新修訂 **2025-10-29** | https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/download/5340.pdf |
| MIG 4.1 技術轉換文件含範例 ZIP（28 檔：A/B 交換、F/G 存證、E 字軌範例 XML＋轉換對照說明 v1.1） | 2025-09 | https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/download/5300.zip |
| Turnkey v3.2.1 軟體（僅支援 MIG 4.1）Windows 64 位元 | v3.2.1 | https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/download/5400.zip |
| Turnkey v3.2.1 Linux 版 | v3.2.1 | https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/download/5420.zip |
| Turnkey 使用說明書 | Ver 3.9，2025-02-17 | https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/download/321.pdf |
| Turnkey 上線前自行檢測作業（適用 MIG 4.1） | Ver 4.8，2024-12-30 | https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/download/5440.pdf |
| 營業人導入電子發票資訊專區（含測試環境申請流程、字軌申請四步驟） | — | https://www.einvoice.nat.gov.tw/ptl007w/1692842481285 |
| 驗測環境入口 | — | https://wwwtest.einvoice.nat.gov.tw/ |
| 電子發票專用字軌號碼取號使用說明書 | v1.1，2015-10-29 | https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/attachments/1447140603002_0.pdf |
| 電子發票字軌號碼申請書（稅務入口網） | 現行 | https://www.etax.nat.gov.tw/etwmain/etw212w/detail/6304811861295645753 |

## 本 repo 內的一級素材

- `sources/mig41-samples/`：官方 5300.zip 解壓（Big5 檔名已轉 UTF-8）——23 個範例 XML＋MIG 轉換技術文件 v1.1 PDF。**這批就是 Phase 2 golden-file 測試的種子**。
- 訊息代號地圖：F0401 開立／F0501 作廢／F0701 註銷（B2C+B2B 存證，4.0 起整併）；G0401/G0501 折讓開立/作廢；A/B 系列為 B2B 交換；E0401/E0402 字軌、E0501 配號紀錄。

## 重要注意事項

- **官方不單獨提供 XSD 下載**：機器可讀的 .xsd 隨 Turnkey 安裝檔散布（安裝後取得）；MIG PDF 內以「XML Schema 語法標示」欄位敘述 schema（附錄 A 為資料類型表）。見 TRAPS `mig41-xsd-not-downloadable`。
- MIG 4.0（含）以前版本於 **115-01-01（2026-01-01）停止使用**——只做 4.1。
- 字軌作業節奏：向稽徵機關申請 → 平台取號；總機構配賦分支要傳配號檔、空白未用字軌要傳回。
  ⚠️ **這兩件事各自的期限未查證、刻意不寫**（舊版此處寫過具體天數，無出處已移除，不得視為已查證）——
  同節其他項目都有掛來源，這一項沒有就是還沒查。系統不提示任何期限。

## 未決問題（下一輪）

- **XSD 驗證尚未接上**（XSD 隨 Turnkey 散布，見 TRAPS）——目前以官方範例 golden 測試代位；取得 XSD 後加入 CI。
- ~~G0401/G0501 折讓~~ **已補（2026-08-10）**：兩個產生器＋四份官方範例 golden；
  銷貨折讓單（kind=allowance、有證明單號碼＋日期）可單張下載
  （`GET /sales-returns/:id/g0401-xml`）並隨 `GET /exports/einvoice-xml` 批次匯出
  （依證明單日期歸期）。仍待決：
  - 金額折讓明細以「Quantity=1 × 折讓額」表達（本系統折讓 qty 恆 0；官方範例顯示
    不強制數量×單價=金額）——待 wwwtest 上傳驗證，與 F0401 零稅率同一個慣例。
  - **G0501 沒有服務層接線**：折讓單沒有作廢入口（0025 的作廢層不含 sales_returns），
    接線點與關帳注意事項見 `services/allowance-xml.ts` 檔頭 TODO。
  - 退回單（kind=return）與進貨端折讓不產 XML：官方範例僅涵蓋（銷貨）折讓的表達方式，
    證明單仍以財政部軟體或加值中心平台開立後補登號碼。
- E0501 配號紀錄檔、F0701 註銷尚未實作。
- Turnkey adapter（將 XML 放入 Turnkey 收送目錄）與驗測環境實測，待使用者申請帳號。
- 隨機碼 RandomNumber 與載具/捐贈的營運流程（POS 端）超出目前範圍。

## 已知的架構約束（先於規格書成立）

- MIG-3.2.1 已於 2026-01-01 退場，一律以 **MIG-4.1** 為準。
- 每家使用企業以自己的憑證透過 Turnkey 或加值中心傳輸；**不做集中代傳**（DECISIONS 2026-07-21）。
- Adapter 兩條路：Turnkey adapter（自建）｜加值中心 adapter（綠界/Amego/藍新；抽象參考 paid-tw/einvoice，MIT）。
- Golden-file 測試：每種單據情境一份標準 XML，過官方 XSD 驗證後進 CI。

## 交叉對照候選

| 專案（授權） | 用途 |
|---|---|
| ho600-ltd/django-taiwan-einvoice（MIT） | 唯一完整 Turnkey 開源實作；流程與欄位對照 |
| Solo-man-IGG/taiwan-einvoice-dolibarr（GPL-3） | **只讀邏輯**：MIG 4.1 產出、字軌配號、57mm 證明聯 |
| paid-tw/einvoice（MIT） | 加值中心 adapter 抽象；可直接依賴 |
