# 缺口盤點（第二輪）：把系統拿給一家真公司用，會卡在哪裡（2026-08）

> **與 `gap-analysis-2607.md` 的關係**：上一份是「對照市售產品的功能清單」，回答的是
> 「我們缺哪些模組」——那份的答案大致是「模組都有了」。這一份換一個方法：以一家假想的
> 食品貿易公司（禾昇食品，10 人、有進出口、有月結客戶、有個人房東）為主體，
> 把十條業務流程從頭到尾**實跑一遍**，回答的是「模組有了，但一家公司真的拿去用會不會斷掉」。
>
> 方法：PGlite 記憶體庫 → `applyMigrations` → `seedAccounts` → `seedDemoCompany` →
> 以各角色的 cookie 用 `app.request` 實打 API，逐條記錄 HTTP 狀態碼與回應內容；
> 前端則逐行核對 `apps/web/src/pages/`。每一條發現都經過第二人複驗
> （refuted 的已剔除、partly 的已依複驗結果修正描述）。
>
> 上一份的結論仍然成立：模組覆蓋率是好的。這一份的結論是：**覆蓋率高、生命週期淺。**
> 幾乎每個模組都能「建立」，但「修正／作廢／交付／查詢」這四件事普遍缺席。

---

## TL;DR

> ✅ **狀態更新（2026-08-10）：已修完四批。**
> **第一批六項**——主檔欄位（B1/B2/B3，commit 7b96c48）、期初導入（B6，400a709）、
> 發票字軌（B7，1428f25）、401 三塊（B10/B11，a6e6d85）、關帳鎖（B13，7878024）、
> 對外文件最小集（B5，22a4e0e），另有覆核修正與對抗測試（9bec2f1）。
> **第二批六站**——單據作廢層（B4，732cfa4，migration 0025）、庫存調整單（B8，0f582b2，0026）、
> 預收預付（B9，e567ea5，0027）、外銷零稅率（B12，7861444，0028）、G0401/G0501 折讓證明單
> XML（5a1fd8e）、R 系列雜項五件（R5 進項防重複／R20 進項歸期／發票清單瘦身／字軌區間重疊
> ／載具捐贈碼，975813b，0029），另有覆核修正（12167ff）。
> **第三批五站**——作廢層加固（懸空檢查／voidDate 順序／關聯排除作廢單，8d92bb9）、
> 退回折讓與期初單作廢入口＋G0501 接線（5e339d7，migration 0030）、B14 固定資產處分三重失準
> ＋PATCH/作廢（d1f9e62，0031）、訂單短交結案＋課稅別走訂單流程＋收貨價覆寫（c14aeb5，0032）、
> 雜項五件（ap-aging／進項 CSV 發票日期歸期／inventory 一次查／報銷發票查重／B7 尾款，
> 9241d71，0033），另有覆核修正（02ced63：短交結案不隨出貨作廢翻回 open）。
> **第四批五站**——餘額口徑統一到 services/balances.ts＋收付款沖銷明細（R6，57a2ab7）、
> 處分發票登錄＋R5 進貨側反向查報銷（cb68196，migration 0034）、內容尾款四件
> （交期／訂單確認單列印／折舊明細表／R9 庫存異動明細帳，45b8c7b，0035）、
> R3 清單篩選分頁＋R2 日期驗證＋清單 N+1（d202745）、R11-R13 報銷三段補課
> ＋R21 權限收緊（98018c1，0036），另有覆核（f889be0：五條二階跨站組合鏈
> 對抗實測全數成立，探針轉正式迴歸）。
> 以下各節在標題下逐條標注修復狀態與尚缺部分；
> **原文一律保留**（歷史證據，描述的是修復前的狀態）——含這段 TL;DR 的五點。

1. **主檔只有名字。** 客戶沒有地址、電話、付款條件；商品沒有售價；員工只有姓名。
   建檔第一天就得另外開一份 Excel，ERP 的主檔從此不是唯一真相。
2. **建得起來，改不掉。** 報價、訂單、採購單、合約、收付款單、扣繳單、固定資產、
   手工傳票——建立後全都沒有更正或作廢路徑。金額打錯一個零，唯一出路是手工傳票或假處分，
   而那會在帳上留下一筆假交易。
3. **算得出來，交不出去。** 報價單印不出來給客戶簽、出貨單印不出來給司機、
   B2C 證明聯印不出來給消費者、電子發票 XML 沒有任何批次匯出或落地路徑、扣繳憑單印不出來給房東。
   系統內部算得再對，對外一律要重打一次。
4. **401 目前不能直接送。** 上期累積留抵恆為 0（每期溢繳）、扣抵代號 3/4 仍被算成可扣抵（少繳）、
   申報人與委託記帳士欄位全空、退回折讓不列減項、零稅率與兼營免稅整條鏈不存在。
   會計拿到檔案還是得在財政部軟體裡逐格補。
5. **期初導入只做了一半。** 庫存開帳不入總帳（這是設計），但沒有任何地方檢查你補了那張傳票沒有；
   期初應收應付則連導入路徑都沒有——手工傳票進得了總帳，進不了客戶明細與收款勾稽。
   任何不是今天成立的公司，第一天就會撞到。

---

## 一、Blocker — 上線就會撞到，且沒有可接受的替代做法

依「一家公司多快會撞到」排序。

### B1. 客戶／供應商主檔只有名稱與統編（建檔第一天）

> ✅ **已修（2026-08-10，commit 7b96c48）**：migration 0022 補齊聯絡人／電話／Email／地址／
> 送貨地址／付款條件天數／信用額度／業務負責人／備註，PATCH 放行；統編加 partial unique index
> （重複回 409 並講出撞到誰）；帳齡改吃到期日（未到期單獨列桶、無到期日退回單據日估算並標註）、
> dashboard 移除 30 天硬編碼；發票買方補 Address／EmailAddress；開單畫面顯示未收餘額 vs
> 信用額度（僅提示不阻擋）。**尚缺**：invoice_email 獨立欄位（先以單一 email 涵蓋）、
> active 停用旗標、預設載具／常用捐贈碼。

**現象**　`partners` 資料表實體只有 8 欄：`id, name, tax_id, is_customer, is_supplier,
is_individual, id_no, created_at`。聯絡人、電話、Email、地址、送貨地址、付款條件、
信用額度、業務負責人全部不存在。送進去的欄位被 zod 靜默丟棄，回 201 但什麼都沒存。

**實測**
```
POST /partners {name, taxId, contactPerson, phone, email, address, paymentTerms, creditLimit}
→ 201 {"id":1,"name":"…","taxId":"04595257","isCustomer":true,"isSupplier":false,
       "isIndividual":false,"createdAt":"…","hasIdNo":false}     ← 七個欄位全部消失，零警告
PATCH /partners/1 {"email":"…","phone":"…"}
→ 400 {"error":"未提供要修改的欄位（可改：name、taxId、idNo、isCustomer、isSupplier、isIndividual）"}
```
全庫 41 張表掃 `email|phone|address|contact|tel` 類欄位，只有 `company_profile` 有
`address / telephone / email`——自家公司有，客戶沒有。沒有 contacts／addresses 子表可承接。
前端 `apps/web/src/pages/Masters.tsx:105-128` 的新增表單同樣只有名稱／統編／客戶／供應商。

**影響（下游比表面更廣）**
- 出貨沒有送貨地址、催收沒有電話、寄電子發票沒有 Email、對帳找不到聯絡人。
- 電子發票 XML 的買方永遠殘缺：`apps/api/src/services/invoices.ts:126-137` 賣方帶足
  address／personInCharge／telephoneNumber／emailAddress（取自 company_profile），
  買方只有 `{identifier, name}`。MIG F0401 買方允許 address/email，這裡是因為主檔沒資料而開不出來。
- 扣繳憑單填不出來：各類所得憑單要受領人姓名＋身分證號＋**地址**。系統為了不必回頭翻紙本合約，
  特地冒 PII 風險存了 `id_no`（migration 0015 花 20 行說明），卻沒存地址，等於做了半套。
- **付款條件的缺席讓應收管理整體失準**：`sales` 表沒有 `dueDate`（送了被丟棄），
  帳齡分桶 `apps/api/src/services/orders.ts:296-302` 用的是「基準日 − 出貨日」而非到期日；
  更要命的是 `apps/api/src/services/dashboard.ts:73`
  `overdueAr: aging.totals.total - aging.totals.d0_30  // 超過 30 天未收`
  ——把「月結 30 天」硬編碼成全公司常數。實測：月結 60 天的客戶第 45 天（未到期）被標成逾期，
  貨到付款的客戶第 20 天（已逾期 20 天）反而顯示安全，兩者剛好相反。
- 賒銷無任何額度提示：同一客戶連開三張共 630,000 全部 201，開單畫面不帶入該客戶未收餘額
  （`partner-balances` 目前只有 `CashDocs.tsx:11` 一處在用）。

**建議補法**
1. `packages/db/src/schema.ts` partners 補 `contact_person / phone / email / invoice_email /
   address / ship_to_address / payment_term_days / credit_limit / sales_owner_employee_id`＋migration。
2. `apps/api/src/app.ts:151-160` 的 `partnerBase` 與 `partnerPatchInput` 一起放行；
   `Masters.tsx` 表單與清單同步補欄位。
3. `orders.ts` 的 `bucketOf` 改吃 `dueDate`（＝docDate + payment_term_days，可覆寫，
   舊資料 fallback docDate），桶標籤改為「未到期／逾期 1-30／31-60／60 天以上」；
   `dashboard.ts:73` 的 30 天硬編碼一併移除。
4. `invoices.ts` 的 buyer Party 補 address／emailAddress。

> 註：這不是刻意設計。`.flightwake/DECISIONS.md`、`docs/specs/` 全文查無任何關於
> partners 欄位取捨的記載；schema 的註解只解釋 `isIndividual` 與 `idNo` 的 PII 紀律。

---

### B2. 商品主檔只有 SKU／品名／單位；服務與運費項目根本開不了單（建檔第一天）

> ✅ **已修（2026-08-10，commit 7b96c48）**：products 補 list_price／category／is_service／
> min_stock／note；補 `PATCH /products/:id`（sku 不可改）、SKU 撞號回 409；服務項目銷貨
> 跳過庫存檢查（成本 0、不寫異動、退回同步跳過），進貨端拒收服務項目並指路；
> 前端開單自動帶入標準售價（可覆寫）、庫存頁安全庫存提示。**尚缺**：`GET /products/:id` 與
> DELETE（單筆查詢暫以清單替代）、active 停用旗標、條碼、課稅別（B12）、客戶專屬價／價目表。

**現象**　三件事同一張表：
- `products` 只有 `id, sku, name, unit, created_at`。沒有售價、分類、條碼、安全庫存、
  課稅別、`active`，也沒有「這是服務／不計庫存」的旗標。
- 沒有 `PATCH /products/:id`、沒有 `DELETE`、沒有 `GET /products/:id`（全 404）。
  品名打錯或規格改版就永久錯在那裡，停產品也清不掉，下拉選單只會越來越髒。
- 因為沒有非庫存旗標，`createSale` 對每一條明細一律檢查在庫量
  （`apps/api/src/services/documents.ts:195-198`），於是**運費、上架費、安裝費開不了單，
  純服務業（顧問／設計／維修）完全無法使用本系統**。

**實測**
```
POST /products {sku,name,unit,price,cost,category,safetyStock,isService,trackInventory}
→ 201，回應只有 {id, sku, name, unit, createdAt}          ← 其餘靜默丟棄
POST /products {sku:"T-001"} 第二次（撞號）→ 500 {"error":"internal error"}
PATCH / DELETE / GET /products/1 → 全部 404
POST /sales（顧問服務費 1 式 50,000）→ 409 {"error":"庫存不足: 商品 1 在庫 0，欲售 1"}
POST /orders/1/ship（報價含運費行）→ 409 {"error":"庫存不足: 商品 2 在庫 0，欲售 1"}
```
唯一繞路是先用 `POST /inventory/opening` 灌假庫存（`qty:9999, unitCost:0`）。它不拋轉傳票
所以不污染帳上金額，但：**業務角色打這支端點回 403**（掛在 journal 頁權限，
`apps/api/src/services/auth.ts:377`），每賣一次服務都要叫財務進系統補庫存；庫存頁從此列著
「運費 在庫 998 式」；且該期關帳後補量回 409。
另外，只出商品行、不出運費行的訂單會永遠停在 `partial`
（`orders.ts:254` 的結案判定要求每一行 shippedQty ≥ qty），未出貨追蹤會被殭屍單塞滿。

**影響**　食品貿易冷鏈配送幾乎每張單都有運費；顧問／設計／代辦這一整塊產業直接不可用。
沒有標準售價則每張單每一行都要翻價目表手打——打錯就是毛利跟著錯，
而且系統事後判斷不出「有沒有賣低於底價」（成本側是對的，`cogs` 有存，錯的只有售價側）。

**建議補法**
1. products 補 `is_stock`（或 `kind: goods|service`）、`list_price`、`category`、`barcode`、
   `safety_stock`、`active`；`app.ts:195-199` 的 `productInput` 放行。
2. `documents.ts` 的 `createSale`／`shipOrder` 對非庫存品項跳過 `onHand` 檢查與成本結轉
   （該行 cost=0、不寫 `inventory_movements`），收入可另走 4102/4201；
   `orders.ts:254` 的結案判定即自然通過。
3. 補 `PATCH /products/:id`（sku 不可改、其餘可改、支援 active 停用，比照 accounts 的
   「不用了＝停用」設計）；`POST` 攔 PG 23505 轉成 409（`app.ts:751` 的 accounts 已有正確範例）。
4. `DocForm.tsx:74`／`Orders.tsx:70` 選到商品時自動帶入 `list_price`（仍允許改）。

> 註：**不設標準成本是刻意的**（移動加權平均，見「刻意不做的事」）。缺的是**售價**側。

---

### B3. 員工主檔只有姓名，離職停不掉——`active` 的把關是死碼（第一週）

> ✅ **已修（2026-08-10，commit 7b96c48）**：employees 補 title／phone／email／hire_date／note；
> 補 `PATCH /employees/:id`（含 name 與 active——死碼復活：停用員工進不了新報銷單、
> 不可再被指派為業務負責人，歷史單據照樣查得到）。**尚缺**：emp_no（unique）／department／
> resign_date／銀行帳號；同名重複建立仍不擋。

**現象**　`POST /employees` 的 schema 是 `z.object({ name: z.string().min(1) })`
（`apps/api/src/app.ts:1096-1104`），沒有員工編號、部門、職稱、到職日、Email。
`PATCH / PUT / DELETE /employees/:id` 全部 404——**連改名都不行**。
`employees.active` 欄位存在，但整個 codebase 沒有任何一行會把它寫成 false。

**實測**
```
POST /employees {"name":"王小明","empNo":"E001","department":"業務部","active":false}
→ 201 {"id":1,"name":"王小明","active":true,…}      ← 連明示 active:false 都被丟棄
PATCH /employees/1 {"active":false} → 404 ；PATCH {"name":"改名"} → 404
同名可無限重複建立（無唯一鍵）
```
下游三段程式因此是**永遠跑不到的死碼**：
`apps/api/src/services/expenses.ts:48` `if (!employee.active) throw new AppError(422, "員工已停用")`、
`Expenses.tsx:151` 與 `Settings.tsx:81` 的 `.filter((emp) => emp.active)`。
`Masters.tsx:191-200` 表頭有「狀態」欄、會顯示「在職／停用」，整段沒有任何按鈕。
停用**使用者帳號**不能替代：實測停用帳號後 `GET /employees` 仍回 `active:true`，
finance/admin 代開報銷單仍 201。

**影響**　離職三年的同事還在報銷人下拉選單裡；姓名打錯字會永久寫進每一張傳票摘要
（`expenses.ts:143` 核准當下寫入快照）；同名同姓兩位同事在下拉選單裡完全無法分辨。

**建議補法**　補 `PATCH /employees/:id`（至少 `name` 與 `active`），`Masters.tsx:191-200`
每列加「改名／停用」。後端把關與前端過濾都已存在，接上去即刻生效。
順帶補 `emp_no`（unique）／`department`／`title`／`hire_date`／`resign_date`。

---

### B4. 建得起來，改不掉——單據普遍缺少「更正／作廢／結案」這一層（第一週）

> ✅ **大部分修復（2026-08-10，migration 0025）**：統一原則「更正＝作廢＋重開，不是就地改」。
> 六種單據補作廢入口（理由必填、限 admin/finance、原單永不刪除）：**收付款單**（反向傳票沖現金與
> 應收/應付、立沖釋放、餘額/帳齡回復）、**手工傳票**（反向傳票；系統傳票 422 指路作廢來源單據）、
> **扣繳支出單**（年度彙總排除——本節「最貴的一格」已補）、**銷貨單**（僅限無 issued 發票者，
> 發票已開要先作廢發票；庫存按原出庫成本回補、訂單出貨量退回並重推狀態；發票作廢連動沖銷改走
> 同一核心並補 voided_by/void_reason 軌跡）、**進貨單**（0004 只給銷貨的沖銷機制補上對稱面：
> 401 進項/進項發票 CSV 排除、在庫量與帳面金額不足 409 指路退出單、採購單收貨量退回）、
> **報價單**（直接標作廢，與 lost 語意分開；won 不可作廢）。關帳鎖兩種嚴格度：收付款/傳票/扣繳
> 可帶 voidDate 以開放期間日期沖轉；銷貨/進貨原單期間已關一律 409 指路退回單（申報數字不可回溯改動）。
> 合約 PATCH 改收 `contractInput.partial()`＋空 body 400（500 與靜默不改已修），前端補編輯列——
> 合約走**終止**不走作廢。彙總排除點逐一接上：partnerBalances／openDocuments／arAging／401／
> purchasesExport／withholding paymentSummary／returns 的餘額計算。驗收 test/void-layer.test.ts 18 條。
> **第三批加固（2026-08-10）**：①懸空檢查——銷貨/進貨單已被有效收付款單立沖或預收/預付沖用者
> 409 指路「先作廢收付款單 #N」（檢查在 voidSaleCore/voidPurchase 共用核心，發票作廢連動沖銷同擋；
> 作廢收付款單後解鎖）②voidDate 不得早於原單日期（422：反向傳票落在原單前，兩日期間的期間餘額
> 會暫時反向）③訂單/採購單頁關聯連結（saleIds/purchaseIds）排除作廢單。驗收 void-layer.test.ts 27 條。
> **第三批第 2 站（2026-08-10，migration 0030）**：作廢層蓋到**退回／折讓單**與**期初應收付單**。
> 退回單作廢＝庫存反向回沖（銷退作廢再扣庫存、在庫不足 409「退回來的貨已再賣出」；
> 進退作廢按原成本回補；進貨折讓的 qty=0 金額異動同樣反向，總帳與存貨明細帳不脫鉤），
> returnable 額度池回復、退回單全數作廢後原單可整單作廢；折讓單不動庫存。
> 關帳鎖與銷貨/進貨同嚴格度且多看一個歸期：cert 生效日（certDate ?? docDate）已關帳也 409
> （401 減項不可回溯抽走）；作廢後補登證明單 409。期初單作廢＝反向傳票沖 1144/3351，
> 已被收款沖銷者懸空 409 指路先作廢收付款單，比照收付款單收 voidDate。
> 彙總排除點：401 減項/出聲清單、partnerBalances、openDocuments、arAging、dashboard 月退回、
> returns 額度池與對象餘額、G0401 批次。驗收 test/void-returns-openings.test.ts 19 條。
> **尚缺（deferred）**：訂單/採購單的 partial → closed 短交結案端點與 openBacklog 排除；
> 收貨單價覆寫（receive 的 unitPrice）；固定資產修改；費用報銷 rejected 重送／範本重開；
> 報價單改單（仍是作廢重開）。
> **其中短交結案與收貨價覆寫已補（2026-08-10，migration 0032）**：
> `POST /orders/:id/close`／`/purchase-orders/:id/close`（open/partial 皆可，理由必填，
> closed_at/closed_by/close_reason 三欄 NULL＝全數出清自動結案），已開出的單據全數留存；
> cancel 的 409 訊息講明語意分工（取消＝從沒發生、結案＝到此為止）並指路結案。
> openBacklog 原本只認 open/partial，短交結案自然退場。receive 的 unitPrice 選填
> （預設採購單價），進貨單與傳票以收貨價入帳、採購單保留原下單價，覆寫差異逐筆
> 進回應（priceOverrides）並走 taxNotes 通道浮上畫面；前端收貨列補單價輸入框、
> 兩張清單補結案鈕。驗收 test/order-close-taxtype.test.ts 13 條。
> 覆核修正（02ced63）：短交結案（closed_at 非 NULL）的訂單／採購單，其出貨／收貨單
> 被作廢時**量照退、狀態維持 closed**（結案是明示決定，不因作廢無聲復活回 backlog）；
> 自動結案（closed_at NULL＝出清）作廢仍照量退回 partial/open。兩側對稱迴歸測試 13→15 條。

**現象**　這是全系統最一致的缺口。逐一實測結果：

| 單據 | 改 | 刪／作廢 | 實測 | 現況出路 |
|---|---|---|---|---|
| 報價單 | ✗ 404 | 失單 200（不可還原） | `PATCH/PUT/DELETE /quotes/:id` 全 404 | 重開一張，舊的標「未成交」→ 污染成交率 |
| 訂單 | ✗ 404 | open 可 cancel；**partial 永遠結不了案** | `POST /orders/2/cancel` → 409「僅未出貨的訂單可取消」；`/close` → 404 | 把客戶不要的貨「假出貨」再開退回單 |
| 採購單 | ✗ 404 | 同上，短交結不了案 | `POST /purchase-orders/1/cancel` → 409；`/close` → 404 | 假收貨＋進貨退出（憑空生兩張稅務憑證） |
| 收貨單價 | ✗ 靜默丟棄 | — | `POST /purchase-orders/1/receive {unitPrice:180}` → 201 但仍以 PO 價 100 入帳，`taxNotes:[]` | 只能走進貨折讓（僅能往下、不能往上補差額） |
| 合約 | ✗ | ✗ 無 DELETE | 單改 amount/endDate/title → **500**（`No values to set`）；`{amount, status}` 混合 → **200 但金額靜默不變** | 無 |
| 收付款單 | ✗ 404 | ✗ 404 | `DELETE/PATCH/POST :id/void|reverse` 全 404 | 手工傳票救總帳，但 `partner-balances`／帳齡完全不動（它們只讀單據表） |
| 手工傳票 | ✗ 404 | ✗ 404 | 無 reverse 端點；`journal_entries` 沒有 `reversal_of` 欄位 | 自己打反向傳票，兩張之間系統無關聯 |
| 固定資產 | ✗ 404 | ✗ 404 | `PATCH/DELETE /fixed-assets/:id` → 404 | 「假處分」→ 產生一張憑空的出售資產損失 |
| 費用報銷 | ✗ 404 | ✗ 404 | approved/paid 一律鎖死；rejected 是終點狀態 | 手工傳票救總帳，但**救不了 401**（進項直接 join expense_items） |
| **扣繳支出單** | ✗ 404 | ✗ 404 | 見下方 | 手工傳票沖帳，**但年度彙總永久虛增** |

**其中最貴的一格：扣繳單。**
```
POST /withholding-payments {grossAmount:380000}（打錯一個零）→ 201, taxWithheld 38000
PATCH / PUT / DELETE / POST :id/void|reverse|cancel|correct → 全部 404
POST /withholding-payments {grossAmount:-342000}（想開反向）→ 400 ZodError（必須為正整數）
→ 只能開手工傳票沖帳，之後：
   2211 帳上餘額 = 11,400（正確）
   GET /withholding-payments/summary?year=2026 → grossAmount 494,000 / taxWithheld 49,400
   （虛增 380,000，且該表就是系統自稱的「年度各類所得憑單取數來源」）
```
也就是說：帳沖乾淨了，但明年一月開給房東的憑單會把 494,000 元租金所得掛在他的身分證號下
（實際只付了 114,000）。受領人會被課到不存在的所得。
`paymentSummary`（`apps/api/src/services/withholding.ts:391-434`）只讀 `withholding_payments`
且該表沒有任何可供排除的欄位。

**建議補法**
- 通則：每一種單據補「作廢／沖銷」端點，寫反向傳票並在原單記 `reversal_entry_id`
  （`sales.reversalEntryId` 已有現成範式），已關帳期間則擋下。
- `POST /orders/:id/close` 與 `POST /purchase-orders/:id/close`（允許 partial → closed，
  記短交原因，不動已開出的單據），並讓 `openBacklog`（`dashboard.ts:78-89`）排除 closed。
  現行 `cancel` 的 409 是對的設計，不要放寬它。
- `receive` 的 zod 加選填 `unitPrice`，`purchase-orders.ts:128` 改用收貨價，
  差異記錄供覆核；`Purchases.tsx:130-141` 收貨列補單價輸入框（預設帶 PO 價）。
- 合約 `PATCH` 的 schema 改成 `contractInput.partial()`，並在 `.set()` 前判斷空物件回 400
  （比照 `app.ts:626-628` 的 partners）。
- 扣繳：`withholding_payments` 補 `voided_at / voided_by / void_reason`，
  `paymentSummary` 的 where 加 `isNull(voidedAt)`，新增 `POST /withholding-payments/:id/void`。
- 報銷：`rejected` 允許改明細後回到 `submitted`（或提供「以此單為範本重開」複製明細與附件）。

---

### B5. 算得出來，交不出去——沒有任何對外文件（第一週）

> ✅ **部分修復（2026-08-10，commit 22a4e0e）**：報價單（訂單頁）與出貨單（銷貨頁）A4 列印視圖
> （公司抬頭、對象、品項、簽收／簽回欄，`@media print`，不引 PDF 函式庫）；新增
> `GET /sales/:id`（客戶欄位白名單）；發票 XML 單張下載補 content-disposition（MIG 檔名）、
> 新增 `/invoices/:id/cancel-xml` 與批次 `GET /exports/einvoice-xml?from&to`（逐檔下載，
> 刻意不 zip；F0501 依原發票日期歸期）；B2C 證明聯 57mm 版面（Code39＋左右 QR，
> 左 QR 加密驗證區以 0 佔位——正式驗真值需大平台金鑰，畫面有標示）；扣繳年度彙總每列
> 可套印（標明非官方格式、格式代號留白）。**尚缺**：載具／捐贈碼的前端面板與 invoices 表欄位
> （仍是「API 做得到、畫面做不到」）、G0401/G0501 折讓證明單 XML、訂單確認單列印。
>
> ✅ **其中 G0401/G0501 已補（2026-08-10，commit 5a1fd8e）**：折讓證明單 XML 產生器
> （golden 對四份官方範例）＋銷貨折讓單的單張下載與批次匯出；G0501 接線待折讓單有作廢入口。
> ✅ **G0501 已接線（2026-08-10，migration 0030）**：折讓單有作廢入口後，
> `GET /sales-returns/:id/g0501-xml` 產作廢折讓證明單，批次匯出同期帶 G0401＋G0501。
>
> ✅ **其中載具／捐贈碼已補（2026-08-10，commit 975813b）**：Sales 頁開 B2C 改為展開面板
> （手機條碼／自然人憑證／自訂載具／捐贈），`invoices` 落地 carrier_type／carrier_id／
> donate_mark／npoban 快照，發票頁看得到；捐贈缺碼等形狀錯誤在**配號前** 422（不燒號碼）。
> 尚缺：訂單確認單列印、客戶主檔的預設載具／常用捐贈碼（見 3.1）。
>
> ✅ **訂單確認單列印已補（2026-08-10，第四批，commit 45b8c7b）**：訂單頁每列「列印」——
> 品項、金額、預計交期（0035 新欄）、付款條件（客戶主檔天數→白話）、客戶簽回欄，
> 照報價單列印的同一套 PrintOverlay。B5 尾款至此只剩客戶主檔的預設載具／常用捐贈碼。

**現象**　全 `apps/web/src` 搜 `window.print`／`@media print` **零命中**。
`downloadText()`（`api.ts:41-43`）只被 Exports／Vat／Contracts 三頁使用。逐項實測：

| 該交出去的東西 | 現況 |
|---|---|
| 報價單（給客戶簽回） | `GET /quotes/1`、`/quotes/1/pdf`、`/quotes/1/print` 全 404；`Orders.tsx:164/225` 表格無列印鈕 |
| 訂單確認／出貨單（給倉庫、司機） | 同上全 404。更糟：`GET /sales` 不回 `partnerName` 也不回 `lines`，`Sales.tsx:98` 表頭沒有客戶欄——連在系統裡查「這張出貨出了什麼給誰」都做不到 |
| 電子發票 XML（送 Turnkey／加值中心） | 只有逐張 `GET /invoices/:id/xml`（200，無 content-disposition，瀏覽器 inline 顯示）。`/exports/einvoice`、`/invoices/export`、`/turnkey/export` 全 404。`Invoices.tsx:47-53` 只把 XML 塞進 `<pre>`，**連下載鍵都沒有**（同一支 `downloadText` 就在隔壁檔案）。作廢用的 F0501（`cancelXml`）連逐張端點都沒有 |
| B2C 電子發票證明聯 | `GET /invoices/1/receipt|print|qrcode` 全 404。全 workspace 唯一 QR 相關依賴是 `apps/web/package.json:13` 的 `jsqr`（純**解碼**），沒有任何 QR encoder／Code39／57mm 版面 |
| 載具／捐贈碼 | **API 做得到、畫面做不到**：`{carrier:{type:"3J0002",…}}` → 201 且 XML 正確；但 `Sales.tsx:41` 只送 `{ mode }`，全 web 搜 `carrier|載具|捐贈|npoban` 零命中。且這三個欄位不在 `invoices` 表（只存整包 xml），事後查不到、篩不了 |
| 扣繳憑單（給房東／接案者） | `/exports/withholding` 404；`Withholding.tsx:405-469` 只是螢幕表格，無列印、無下載、無逐人明細 |
| 退回折讓證明單 | `packages/einvoice/src/` 只有 f0401／f0501，沒有 G0401/G0501。`Sales.tsx:17-19` 註解自陳「證明單要自己去外面開」 |

**影響**　銷售模組對外等於不存在——業務還是得用 Word 重打一份報價單，那份跟系統裡隨時會對不起來。
一個月幾百張發票，會計要一張一張複製 `<pre>` 裡的 XML 貼成檔案才能上傳大平台。
消費者沒帶載具時當場交不出證明聯，店頭／出貨現場直接卡死。

**建議補法**
1. 先補三支單張端點 `GET /quotes/:id`、`/orders/:id`、`/sales/:id`（單頭＋明細＋客戶＋公司抬頭；
   資料本來就都在，`listQuotes`／`listOrders` 已有 join，只有 sales 需要補），
   再做一個共用的 A4 列印版面（`@media print` + `window.print()`），
   `Orders.tsx`／`Sales.tsx` 每列掛「列印」。抬頭取 `GET /company-profile`。
2. `GET /exports/einvoice?from&to&status` 回一包 `{files:[{name,content}]}`（含 F0401 與 F0501，
   檔名依 MIG 慣例），發票頁接上既有的 `downloadText`；單張則直接開 `/invoices/:id/xml`。
3. `GET /invoices/:id/receipt` 回可列印 HTML（57mm 版面、發票號碼、隨機碼、
   Code39 一維條碼、左右兩個 QR）。`apps/web/src/einvoice-qr.ts:4-7` 已經寫死了左 QR 前 77 碼的
   欄位配置（解碼用），可直接反向使用。
4. `Sales.tsx` 的「開 B2C」改成展開小面板（載具類別＋號碼／捐贈碼／要不要印），
   帶進既有的 `issueInput`；`invoices` 表補 `carrier_type/carrier_id/donate_mark/npoban` 欄位。
5. 扣繳：`summary` 加 `detail=1` 回逐筆給付，彙總表每列加「明細／列印」，
   頁面標明「這不是財政部格式的憑單，僅供留存與交付對方核對」。

---

### B6. 期初導入只做了一半：應收應付沒有路徑，庫存開帳沒有護欄（導入第一天）

> ✅ **已修（2026-08-10，commit 400a709）**：migration 0023 `opening_balances` 期初應收付單
> （一筆＝一張原始欠款單），建立時**自動拋轉傳票**（應收＝借 1144 貸 3351 累積盈虧；應付反向）
> ——與庫存開帳「不拋傳票」刻意不同，理由是對方科目唯一；openDocuments／partnerBalances／
> arAging 三處接上（沖銷沿用 cash_doc_allocations），且不進 401。庫存開帳護欄：
> `/inventory/opening` 回 totalAmount、設定頁即時合計＋補傳票提示、Dashboard 庫存合計列、
> 月結檢查加第四項非阻斷檢查「庫存帳與存貨科目相符」；並擋掉服務項目進庫存開帳。
> 設定頁新增「期初應收付」卡片、收付款頁立沖清單含期初單。**尚缺**：期初單無修改／刪除入口
> （跨模組「修正／作廢缺席」主題，見 B4）；應付側帳齡表本來就不存在，期初應付只接
> partnerBalances 與付款沖銷。
> ✅ **期初單作廢入口已補（2026-08-10，migration 0030）**：`POST /opening-balances/:id/void`
> 反向傳票沖 1144/3351；已被收款沖銷者懸空 409（先作廢收付款單解鎖）；設定頁補作廢鈕與標記。

**現象**　兩件事：

**(a) 期初應收／應付根本沒有導入路徑。** 手工傳票進得了總帳，進不了子帳。
```
POST /journal-entries 借 1144 應收帳款 120,000 / 貸 3101 → 201
GET /partner-balances            → []
GET /open-documents?partnerId=1&kind=receipt → []      ← 收款畫面勾不到任何東西
GET /reports/ar-aging            → {"rows":[],"totals":{"total":0}}
硬記一張收款 50,000 之後：
GET /partner-balances            → [{"ar":-50000}]     ← 變成「客戶預付」
GET /reports/dashboard           → ar: 0（dashboard.ts:54 的 Math.max(0, ar) 夾成 0）
GET /reports/balance-sheet       → 1144 = 70,000       ← 兩張畫面同時開著，數字不一樣
```
根因：`partnerBalances`（`ledger.ts:229-250`）、`openDocuments`（`ledger.ts:95-131`）、
`arAging`（`orders.ts:294 起`）三者都只讀 sales／purchases／cash_docs，**完全不看 journal_lines**。
用假銷貨單灌子帳也不行：`/sales` 強制要庫存商品，且必然拋轉 4101 收入與 2288 銷項稅額
（應收被灌成含稅再加一次 5%，2025 損益表憑空長出營收）。
`/ar-opening`、`/opening/ar`、`/receivables/opening` 全 404。

**(b) 庫存開帳不入總帳（這是設計），但沒有任何地方檢查你補了那張傳票沒有。**
```
POST /inventory/opening {qty:100, unitCost:60} → 201 {"lines":1}
GET /trial-balance → {"rows":[],"totalDebit":0}        ← 完全沒傳票（設計如此）
（忘了補期初傳票，接著進貨 50@62、銷貨 20）
GET /inventory        → amount 7,887
GET /reports/balance-sheet → 1301 = 1,887              ← 差 6,000
balanced: true                                          ← 借貸還是平的
GET /period-closes/check → 三項全 ok；POST /period-closes → 201 照關不誤
```
`Settings.tsx:531` 只有一行灰字提醒；開帳表單（`Settings.tsx:500-535`）逐列輸入商品／數量／
單位成本卻**沒有小計或合計欄位**，金額要老闆自己拿計算機加；Dashboard 的庫存卡片
（`Dashboard.tsx:151-172`）逐品列出帳面金額也**沒有合計列**——事後想自己核對，
畫面上連「庫存總額」這個數字都讀不到。

**影響**　任何不是今天成立的公司，導入第一天就有一堆客戶欠款與應付貨款。
現在只能記總數進總帳，客戶明細帳、帳齡表、收款勾稽全部對不上，一收款就變成負數預收，
催收等於沒得用。而少補一張期初庫存傳票，資產負債表就永久少一整批存貨且沒有任何紅字，
會計要到報稅或年底盤點才發現，屆時已經有好幾期報表發出去了。

**建議補法**
1. 新增「期初應收／應付單」：可帶 partnerId、原單日期、原始欠款金額，
   進 sales/purchases（或新表）讓 `openDocuments`／`partnerBalances`／`arAging` 三處認得，
   但**不拋轉收入／銷項稅額／庫存成本**（總帳仍由那張期初手工傳票承擔）——
   與「庫存開帳只建 movement 不拋傳票」是同一個哲學，只是套到應收付單據面。
2. `checkPeriod`（`apps/api/src/services/period.ts:48-110`）加第四項非阻斷檢查
   「存貨明細與 1301 相符」，比對 `sum(inventory.amount)` 與 1301 期末餘額，不符時列出差額。
   同時 `POST /inventory/opening` 回傳 `totalAmount`，開帳表單即時顯示合計並提示
   「請至傳票頁以此金額借記 1301」，Dashboard 庫存卡片加合計列。
3. `inventory_movements` 沒有 `doc_date`（只有 `created_at`），補檢查時要一併處理期間篩選。

---

### B7. 發票字軌：隱形前置條件、建立後不可修正、用罄無預警（開第一張發票時）

> ✅ **已修（2026-08-10，commit 1428f25）**：期別驗證（偶數月／不存在的月份回 422 並講明
> 只能是 01/03/05/07/09/11）、迄號限 8 位數、起迄顛倒 422、重建同一區間 409（原 500）；
> 補 `DELETE /invoice-tracks/:id`（限尚未配出任何號碼，配過號的 409 並指路逐張作廢）；
> 配號後回報全期剩餘、低於 20 張時走 taxNotes 出聲並回 trackRemaining；用罄 409 訊息改指向
> 設定頁；Dashboard 開始清單插入「設定發票字軌」一步。
>
> ✅ **尾款已補（2026-08-10，第三批 9241d71）**：Settings 剩餘欄低於 20 轉紅（僅當期以後的區間，
> 過期期別不再開號、紅字只稀釋警示）；Dashboard 開始清單後補「下一期字軌尚未建立」提醒列
> （僅當期字軌存在而下期不存在時顯示；不斷言申報期限，只講「發票要連號使用，下期開始前要
> 先建好字軌」）。期別演算共用 einvoice 的 periodOf／nextPeriod，前端不再另抄一份規則。
>
> ✅ **區間重疊已補（2026-08-10，commit 975813b）**：同期別同字軌的號碼區間重疊
> （如 1-50 與 30-80）回 422 並給接續起號；完全相同的區間維持 409。

**現象**　四個症狀同一個根因——字軌是 append-only 且沒有任何驗證或提醒。

- **新手清單沒有這一步。** 從空庫照 `Dashboard.tsx:16-51` 的五步全部做完（公司檔→開帳號→
  客戶商品→進貨→報價轉訂單出貨），開第一張發票：
  `POST /sales/1/invoice` → **409**「期別 202607 已無可用字軌號碼（先建立字軌區間 POST /invoice-tracks）」。
  清單做完 `remaining===0` 就整塊消失，使用者從此不會再被提醒。
  （替代路徑是有的：`App.tsx:48/53` 的頁首與 `Settings.tsx:477` 的字軌卡片找得到，
  但銷貨頁——按鈕所在那一頁——完全沒提，而 409 訊息指向的是一個 HTTP 端點而不是「去設定頁」。）
- **期別完全不驗證。** `202608`（偶數月）、`202613`、`999999`、`000000` 全部 201 建檔成功
  （zod 只驗 `/^\d{6}$/`，`app.ts:219-224`）。但配號走 `periodOf(sale.docDate)`
  （`packages/einvoice/src/period.ts:8`，雙月期別以奇數月起算），永遠只產生奇數月期別
  ——這些區間是死資料，永遠配不出號，而使用者剛剛才建過，只會反覆懷疑系統壞了。
- **建錯了刪不掉。** 只有 `POST` 與 `GET /invoice-tracks`，沒有 PATCH／DELETE。
  死區間永久留在清單裡。最壞情況：`rangeStart: 999999999`（多打一位）→ 201 收下 →
  之後每一次開票都 500（`F0401 驗證失敗: 發票號碼格式錯誤`），而且失敗會 rollback、
  `nextNo` 不前進，所以那組壞字軌永遠是 id 最小又「有餘號」的那筆，**該期別從此開不出任何發票**；
  補建一組正確的也沒用（`allocateNumber` 依 `asc(id)` 挑）。
- **重建同一組區間回 500。** `uq_track_range UNIQUE (period, track, range_start)`
  （`migrations/0002_einvoice.sql:28`）沒被接住，畫面上就是「internal error」——
  使用者以為前一次沒存進去而重按，得到的正是這個。
- **快用完沒有任何預警。** 建 5 個號、連開 5 張，每張回應逐字元相同、`taxNotes` 一路 `[]`，
  第 6 張才 409。`GET /reports/dashboard` 的回應不含任何字軌欄位；
  `Settings.tsx:495` 的「剩餘」欄只是一個黑色數字，沒有門檻、沒有顏色。
  **跨期換字軌是同一個斷崖**：只建了 202607 的公司，9/1 的銷貨單照樣 201，一按開票就 409。
  （對照：同一支 `Settings.tsx:221` 對 TOTP 備援碼剩 2 組就會喊「快用完了」。）

**建議補法**
1. `trackInput` 的 period 加 refine：月份須為 01/03/05/07/09/11，否則 400 並提示
   「期別為雙月期別，起始月須為奇數月（如 202607 代表 7-8 月）」；
   `rangeStart/rangeEnd` 限 0-99999999；`uq_track_range` 衝突轉 409。
2. 補 `DELETE /invoice-tracks/:id`（限 `nextNo === rangeStart`，即尚未配出任何號碼）。
3. Dashboard 清單補一步「設定發票字軌」（done：存在涵蓋當期的區間），
   或把 409 訊息改成畫面語言＋一顆跳頁按鈕（`ui.tsx:8` 的零狀態元件已有現成 pattern）。
4. `issueInvoice` 回應帶 `remaining`，低於門檻時比照 `taxNotes` 呈現；
   `Settings.tsx:495` 剩餘欄低於門檻轉紅；Dashboard 加「下一期字軌尚未建立」提醒。

---

### B8. 庫存只能加不能減：盤點、盤虧、報廢完全沒有入口

> ✅ **已修（2026-08-10，migration 0026）**：庫存調整單（盤盈／盤虧／報廢共用一種單，
> reason＝count/scrap/expiry、方向在明細）。調整量以**當下移動平均成本**計價（調整後均價
> 不變；全數出清以帳面殘額出帳）；自動拋轉：盤盈借 1301 貸 7121 存貨盤盈、盤虧報廢借
> 7521 存貨盤損貸 1301（兩碼入 chart.ts ACCOUNT＝系統科目，刻意不進 5101——報廢吃掉
> 毛利率會讓「賣得好不好」與「管得好不好」兩個指標都看不見）。盤點輔助：GET
> `/inventory/stocktake` 底稿（品項＋帳面量）→ POST 實盤量整批建單，**差異由系統算**，
> 帳面量與實盤量落在明細留軌跡。作廢走 B4 同一套（反向傳票＋庫存以原成本回補；
> 盤盈的貨已賣掉 409；原單期間已關 409 不收 voidDate）。關帳鎖 assertPeriodOpen、
> 限 admin/finance、前端在儀表板庫存區塊下補盤點／報廢／調整歷史。
> 建議補法中的 `reason` 三值照抄；科目未沿用「借 5101」的備案，理由如上。
> 關帳檢查比對 1301 與庫存子帳既有（period.ts checkPeriod），本站未動。

**現象**　除了「賣掉」與「退給廠商」，沒有任何一條路能把庫存扣掉。
```
POST /inventory/opening {qty:-40} → 400 ZodError "Number must be greater than 0"
POST /purchases {qty:-40}         → 400 同上
GET/POST /stocktakes、/inventory/count、/inventory/adjustments、/inventory/adjust → 全部 404
改走手工傳票 借 5101 貸 1301 各 12,200 → 201
  → GET /trial-balance 的 1301 從 928,831 變 916,631
  → GET /inventory 總額仍是 928,831（差 12,200），商品數量一件未動
  → 緊接著賣 10 包，cogs 仍用未調整的均價 305
```
唯一「機械上可行」的繞路是開一張 **0 元銷貨單**（201，庫存正確扣、均價正確維持、
借 5101 貸 1301 也對），但那會掛在某個客戶頭上、出現在銷貨清單與應收帳齡、
沒有備註欄可寫「過期報廢」、無法區分報廢與盤虧、損失一律進 5101。
`GET /period-closes/check` 也沒有任何一項比對總帳 1301 與庫存子帳，兩邊分歧時關帳完全不出聲。

**影響**　食品貿易的冷凍品過期報廢、罐頭破損、月底盤點短少是每個月都會發生的事。
走傳票只動總帳不動庫存，之後每一張銷貨單都繼續用虛高的均價算成本，毛利長期失真且無人察覺。

**建議補法**　新增 `POST /inventory/adjustments`（`reason: count|scrap|expiry`，允許正負數量），
在 `apps/api/src/services/ledger.ts` 的 `inventoryOpening` 旁實作：寫 `inventory_movements`
（direction 依正負）＋同步拋轉傳票（盤虧借 5101 或新增「存貨盤損」科目、貸 1301；盤盈反向），
金額用當下移動平均成本。`doc_source` enum 需加 `adjustment`。前端新增獨立庫存頁承載此入口。

> 專案自己已登記過這個缺口：`docs/specs/posting-rules.md:154`「系統目前沒有報廢或庫存調整入口」。
> 但它被跟「多倉／調撥／盤點」綁在同一格延後（`gap-analysis-2607.md:54`）——
> 單倉食品貿易商的報廢與盤虧是每月的事，不該與多倉同級。

---

### B9. 預收／預付無處可去，溢收直接變成負數應收

> ✅ **已修（2026-08-10，migration 0027）**：收付款超過「該對象未沖總額」（含先前未指定
> 沖銷的對象層級收付）的部分，建單當下落地 `cash_docs.unapplied_amount` 並掛 2231 預收款項
> ／1212 預付貨款（兩碼入 chart.ts ACCOUNT＝系統科目），1144/2144 不再為負。
> 事後可用 `POST /cash-docs/:id/apply-prepaid` 沖後續單據（沖用列進既有 allocations 表、
> `from_prepaid=true`，生自己的傳票借 2231 貸 1144，沖用日受關帳鎖；不開新餘額表——
> 餘額可由 unapplied − 沖用合計推導，第二張表必然漂移）。partner-balances／open-documents
> ／帳齡 credit 欄／資產負債表分列預收預付，不淨額互抵；收付款單作廢時沖用傳票一併反向。
> 前端：收付款頁溢收預告＋餘額四欄分列＋「沖用預收／預付」面板。
> 刻意不做：`unappliedAccountCode` 參數（自選科目會讓餘額不可推導）；0027 前的舊單
> unapplied 一律 0（已負的應收走 B4 作廢重開，不代使用者改帳）。
>
> ✅ **ap-aging 端點已補（2026-08-10，commit 9241d71，migration 0033）**：`GET /reports/ap-aging`
> 與 ar-aging 同形狀、同一顆帳齡引擎（orders.ts `aging()` 參數化兩側，差異全收在 side 分歧）；
> purchases 補 `due_date`（供應商 payment_term_days 推算、可覆寫，邏輯照 sales）；
> credit 欄＝預付（1212）餘額。前端進貨頁下方掛應付帳齡卡（照銷貨頁的樣子），
> 權限掛進貨頁（採購排付款看得到、業務 403）。

**現象**　`createCashDoc`（`apps/api/src/services/ledger.ts:177-208`）把科目寫死：
收款一律「借 現金／貸 1144」、付款一律「借 2144／貸 現金」，完全不看該對象還欠多少。
```
客戶只欠 36,540，開一張 500,000 的收款單 → 201（零警告）
GET /partner-balances       → {"ar": -463460}
GET /reports/balance-sheet  → 1144 應收帳款 = -463,460     ← 負的應收資產
liabilities 裡 2231 預收款項 → 不存在
供應商側更糟：只欠 21,000 卻付 300,000 → 2144 應付帳款 = -279,000（負的負債），
且完全沒有 ap-aging 端點，連 ar-aging 的 credit 欄那種補救都沒有
```
**兩條路都只對一半**：走收款單，帳齡與逐單沖銷是對的（預收會自動 FIFO 沖後續銷貨），
但總帳分類錯；走 2231 手工傳票，總帳對了，但帳齡與 `/open-documents` 仍掛著那筆未收
（它們只讀單據表），催收清單會去要一筆已經收過的錢。實測恆等式在第二種做法下當場破掉。
`chart.ts:136` 的 1212 預付貨款在整個 `apps/` 零引用。

**影響**　食品貿易收訂金、客戶預付月結款、給供應商付訂金都是常態。
記帳士拿到「應收帳款 −463,460」的資產負債表會直接退件。

**建議補法**　`createCashDoc` 加 `unappliedAccountCode`（收款預設 2231、付款預設 1212）：
`amount` 減去 allocations 合計的餘額入該科目而非 AR/AP；新增一種 allocation targetType
讓後續銷貨能沖預收餘額；`partnerBalances` 與 `arAging` 的 credit 欄改由該科目取數，
兩邊才會永遠對得起來。前端在超收時給提示（`CashDocs.tsx:44-71` 目前只擋金額 ≤ 0）。

---

### B10. 進項憑證分類：格式代號與扣抵代號既填不了，填了也不生效（第一次申報）

> ✅ **已修（2026-08-10，commit a6e6d85）**：vat.ts 依 inv_format × deduction_code 四桶分流——
> 扣抵代號 3/4 只寫媒體檔明細、**不進任何可扣抵合計**（回應含 nonDeductible 排除清單，
> 畫面看得到）；格式 21/22 落申報書統一發票扣抵聯欄 28-31（代號 2 的固資桶位一併修正）；
> 進貨頁補憑證種類／用途白話下拉，已登錄的發票可重新編輯。

**現象**　三層都斷：
- **前端填不了**：`Purchases.tsx:70-83` 的 `registerInvoice` 只送 `{track, no}`，
  全 `apps/web` 搜 `invFormat|deductionCode` 零命中，連 `types.ts` 的 `DocRow` 都沒宣告這兩欄
  （雖然 `GET /purchases` 其實有回）。schema 預設 `inv_format='25'`、`deduction_code='1'`
  ——**每一張登錄的進項發票都預設「電子發票＋可扣抵」**。而且發票一登錄按鈕就消失
  （`Purchases.tsx:206` 的 `{!d.invTrack && …}`），連號碼打錯都沒有 UI 可改。
- **API 填得了，但彙總不看它**：`apps/api/src/services/vat.ts:145`
  `const isFixedAsset = p.deductionCode === "2"`，其餘一律進 else。
  實測把兩張進貨設成 `deductionCode:"3"`（不可扣抵）→ 媒體檔第 73 碼正確寫 3，
  但 401 的 `inputExpense 20,000 / inputExpenseTax 1,000 / deductibleInputTaxTotal 1,500`
  ——**不可扣抵的稅照樣算進代號 107，直接少繳稅**。代號 4（不可扣抵固資）連桶位都錯（歸進費用桶）。
- **紙本三聯式落錯欄**：`vat.ts:142-167` 完全不看 `p.invFormat`。format=21 的 7,000 元
  被填進第 52 欄「三聯收銀機及電子發票(32)」，第 50 欄「統一發票扣抵聯(28)」＝0
  （`packages/vat/src/return401.ts:127-129` 寫死 `zeroS12`），而媒體檔那一筆卻正確寫 21
  ——**申報書與同時上傳的媒體檔自相矛盾**。

**影響**　交際費、乘人小客車、員工福利這些明文不得扣抵的進項被算成可扣抵＝少繳稅，
是「被查到要補稅加罰」那一類。中小企業收到的紙本三聯式（小供應商、水電、房租）
大量存在，金額落錯欄位是財政部申報軟體匯入時的檢核項目。而**固定資產進項在純畫面操作下
永遠報不出來**（401 的 `inputFixedAsset` 恆為 0），等於買設備退不到稅。

**建議補法**
1. `vat.ts:142-167` 的迴圈改成依 `invFormat` × `deductionCode` 分流：
   21/22 → 紙本欄（代號 28-31）、25 → 電子發票欄（32-35）；
   代號 1 → 進貨費用、2 → 固資、3/4 → **只寫媒體檔明細，不計入任何可扣抵合計**。
   `Return401Input` 需增 `paperTriplicate*` 四個欄位，`return401.ts:127-129/137-138` 改吃它們。
2. `Purchases.tsx` 登錄發票列加兩個下拉（憑證種類／用途），送進既有的
   `PATCH /purchases/:id/supplier-invoice`（`app.ts:212-217` 的 zod 已支援），
   並讓已登錄的單可以重新編輯。
3. `summary` 加一組 `nonDeductible` 金額讓畫面看得到。

> 對照組：**報銷那條路做對了**（6137 餐飲與交際在 `chart.ts:233` 預設不可扣抵、
> 伺服端強制、可用稅法參數覆寫、完全不進 401）。不一致只發生在進貨單這條路。

---

### B11. 401 有三塊會直接算錯稅：留抵、退回折讓、申報人（第一次申報）

> ✅ **大致已修（2026-08-10，commit a6e6d85）**：
> (a) migration 0024 `vat_returns` 申報紀錄表（一期一列、只能刪最新一期）＋
> `POST /vat-returns/401/file`——generate401 自動讀上一期的期末留抵入代號 108，
> 可用 prevCarryForward 覆寫，第一次申報預設 0 並出聲。
> (b) 補 `PATCH /sales-returns/:id` 與 `/purchase-returns/:id`（證明單補登，新舊歸期都套
> assertPeriodOpen）；**有證明單號碼**的退回折讓列入申報書減項欄（序 13/19、56/57、66/67，
> 歸期依證明單日期），缺證明單者留紅色警示。
> (c) 申報人五欄與代理申報人登錄字號（設定頁），接上序 98-104；身分證號比照 partners.id_no
> 的 PII 紀律。**尚缺**：媒體檔（附件五）的退回折讓**明細**不產出（格式代號未經作業要點原文
> 核對，刻意不猜——回應與畫面提醒改在官方軟體補登）；委託申報代號（序 98 填 2）與序 104
> 欄寬係依欄名推定，待官方申報軟體匯入驗收；G0401/G0501 折讓證明單 XML 仍未做。
>
> ✅ **G0401 已補（2026-08-10，commit 5a1fd8e）**：銷貨折讓單（kind=allowance）補登
> 證明單號碼＋日期後，可單張下載（`GET /sales-returns/:id/g0401-xml`）或隨
> `GET /exports/einvoice-xml` 批次匯出（依證明單日期歸期＝401 減項歸期；缺號碼/日期者
> 逐條出聲）。golden 測試逐位元組比對 repo 內四份官方範例。G0501 產生器＋golden 已交，
> 接線待作廢層蓋到 sales_returns（0025 未含）；退回單與進貨端仍以外部工具開立證明單。
> ✅ **G0501 已接線（2026-08-10，migration 0030）**：作廢已登錄證明單的折讓單即產 G0501
> （`GET /sales-returns/:id/g0501-xml`＋批次同期帶 G0401 與 G0501；401 減項同步排除作廢折讓）。

三個不同根因，但都讓產出的檔案不能直接送。

**(a) 上期累積留抵（代號 108）永遠是 0，全系統沒有任何輸入通道。**
`prevCarryForward` 定義在 `packages/vat/src/return401.ts:21,65,165` 並有單元測試，
但 `apps/api/src/services/vat.ts:242-254` 呼叫 `build401` 時**根本沒傳這個參數**，
API 與前端也沒有欄位（`?prevCarryForward=4084` 被靜默忽略）。
```
202607 期算出 carryForward 450
202609 期第 88 欄（上期累積留抵）= 000000000{   ← 應為 450
    → payable 報 250 元；正解是應實繳 0、續留抵 200
```
**這家公司每一期都會溢繳，金額恰等於被丟掉的上期留抵。** 第 95 欄「累積留抵(115)」
因此也不是累積，只是本期淨額——納稅人真實的累積留抵在系統裡完全消失、無法從任一期還原。

**(b) 退回／折讓不列為減項，且證明單號碼事後補登不了。**
全額退回一張已開發票的銷貨單後，401 的 `returnFile.content` **逐字元不變**、
媒體檔筆數 3→3。這是專案已誠實揭露的落差（`returnsNotReflected` ＋ `Vat.tsx:57-110` 紅色警示，
見 `docs/specs/vat-401-403.md`），但複驗多找到一件事：
`app.ts:910/919` 只註冊了 `GET /sales-returns` 與 `GET /purchase-returns`，
**沒有任何 PATCH**——實測 `PATCH /sales-returns/1`、`/sales-returns/1/certificate` 全 404。
而 `Sales.tsx:170-176` 的文案明白叫使用者「開好之後回到這裡把號碼補登」。
證明單一定是退貨入帳之後才在外面開（供應商那張更常是下個月才寄到），
所以那個欄位在真實流程裡幾乎注定是空的，「缺證明單 N 筆」的計數器永遠歸不了零。

**(c) 申報人與委託記帳士欄位全空。**
第 98 欄「自行或委託申報」在 `return401.ts:175` 寫死 `"1"`（自行申報），
第 104 欄「代理申報人登錄字號」在 `:181` 寫死 `""`，兩者**連輸入通道都沒有**；
第 99-103 欄（身分證／姓名／電話）管線是通的，但 `generate401` 沒傳 `filer`，所以恆空。
更前面一層：`Settings.tsx:465-472` 的公司基本檔表單根本沒有負責人姓名與電話兩格
（API 收得到，畫面存不進去），連帶電子發票 XML 的賣方聯絡人也拿不到值。
台灣中小企業絕大多數委託記帳士申報，這份檔案只能宣稱自行申報。

**建議補法**
- (a) `generate401` 接受 `prevCarryForward`（先做成 query 參數＋前端輸入框、預設帶入上一期的
  `carryForward`），正解是建 `vat_returns` 表存每期申報結果讓下一期自動接續（見 R21）。
- (b) 補 `PATCH /sales-returns/:id` 與 `/purchase-returns/:id`（至少 certNo/certDate，
  且對已關帳期間比照現有 `assertPeriodOpen`）。401 減項與 G0401/G0501 XML 依附件六補齊
  ——repo 內已有四份官方範例可做 golden 測試，不需要憑證。
- (c) `company_profile` 或新的申報設定加：申報人姓名／身分證／電話、是否委託、代理人登錄字號；
  `generate401` 帶進 `build401`；`return401.ts:175/181` 改讀設定；
  `Settings.tsx` 公司基本檔補負責人與電話兩格。

---

### B12. 外銷零稅率與兼營免稅：課稅別在整條鏈上都不存在

> ✅ **零稅率已修（2026-08-10，migration 0028）**：sales／invoices 補課稅別（附件五代號
> '1'/'2'/'3'，'3' 服務層拒收指路 403）＋零稅率證明文件欄（經海關與否＋文件號碼，
> 系統不驗真偽、缺號碼出聲、可事後補登 `PATCH /sales/:id/zero-tax-cert`）。
> createSale 零稅率＝稅額 0、費率快照 0、收入記 4102；發票 XML TaxType 2、金額走
> ZeroTaxSalesAmount；401 零稅率銷售額**依銷貨單取數**（經海關出口免開發票，只看發票會漏）
> 落欄 22-25 並計入銷售額總計，媒體檔課稅別 2；零稅率退回（有證明單）落欄 24。
> demo-data 的外銷單改走正式入口（手工傳票權宜已移除）。
> **403 兼營維持不做但做實了擋下**：company_profile.vat_mixed_business 標記後
> generate401/fileReturn401 一律 422 指路。**刻意的邊界**（產出回應均出聲）：
> 退稅欄（代號 113/114）不計算（規則未查證，溢付全額留抵）；媒體檔第 81 碼通關方式
> 註記不填（代號值未經原文核對）；零稅率銷售額檔（83 Bytes 附件）未產出；
> 訂單出貨（shipOrder）尚無課稅別入口，出貨即開的銷貨單一律應稅。
> **其中訂單流程的課稅別入口已補（2026-08-10，migration 0032）**：quotes/orders 補
> 課稅別三欄（與 sales 0028 同形狀，含 CHECK 約束），形狀規則統一抽到
> `assertZeroTaxShape`（documents.ts）三處共用；報價/訂單的稅額尊重課稅別
> （零稅率稅 0、費率快照 0、不解析參數表也不出回退警告）；轉訂單三欄原樣搬、
> shipOrder 原樣帶入 createSale——外銷客戶終於能走報價→訂單→出貨的正規流程，
> 401 零稅率欄照收。前端報價/訂單表單補課稅別下拉（預設應稅；免稅不提供選項——
> 伺服端拒收，放一個按了必 422 的選項是誘導）。驗收 test/order-close-taxtype.test.ts。

**現象**　「這一單是零稅率／免稅」這件事在系統裡無處可表達。
- `sales` 表沒有課稅別欄位；`docInput`（`app.ts:236-248`）只有 partnerId/docDate/lines。
  實測送 `taxType:"zero"`、`zeroRated:true`、`vatRateBp:0`、`taxRate:0`、`exportSale:true`
  **五種寫法全部 201 但被靜默丟棄**，照課 5%。
- `resolveVatRate(db, onDate)`（`tax-parameters.ts:288`）只依日期解析、`scopeKey` 寫死 null，
  所以連「這家客戶零稅率」都表達不了。建一列 `scopeKey:"partner:1"` 的 0% 參數會收下 201，
  然後永遠解析不到——比沒有入口更像陷阱。
- `invoices.ts:154-161` 的 `taxType` 硬寫 `"1"`、`zeroTaxSalesAmount` 恆 0。
- `return401.ts:112-116` 零稅率四欄（代號 22-25）寫死 `zeroS12`；
  `vat.ts:90/163/185` 三處把媒體檔課稅別寫死 `"1"`（`media.ts:27` 定義的 `"2"`/`"3"` 零呼叫端）。
- 403（兼營免稅）：`return401.ts:92` 資料別寫死 `"1"`、第 72 欄不得扣抵比例寫死 `000`、
  第 73 欄兼營得扣抵進項稅額寫死 0；`GET /vat-returns/403` → 404。
  **而且系統不會告訴使用者「你不該用 401」**。

**實測後果**　對新加坡客戶（demo 資料自己就放了一家）的 40,000 元外銷：
2,000 元銷項稅進了傳票、401 的零稅率欄全 0、應稅銷售額被灌水。
B2B 開不了票（無統編 422），改 B2C 可以 201——但開出來的是一張 `<TaxType>1</TaxType>` 的應稅發票。
兼營的公司若把稅法參數設成 exempt，銷貨 tax=0 是對的，但 401 會把免稅銷售額
塞進第 10 欄「應稅銷售額（代號 5）」、免稅欄全 0、媒體檔課稅別仍是 1
——**用一份看起來完全正常的檔案報錯類別**。

**建議補法**
1. `sales`／`quotes`／`orders` 加單頭層級 `tax_category`（應稅／零稅率／免稅）
   ＋零稅率依據（經海關＝報單號碼、非經海關＝外匯證明），`docInput` 與 `DocForm.tsx` 放行。
2. `documents.ts` 的 `createSale` 依課稅別決定 `calcTax` 是否為 0。
3. `invoices.ts:154-161` 依課稅別填 `taxType`(1/2/3) 與 `zeroTaxSalesAmount`/`freeTaxSalesAmount`；
   `vat.ts` 三處媒體檔 `taxType` 同步；`media.ts:76` 的通關方式註記填第 81 碼。
4. `return401.ts` 的零稅率（22-25）與免稅（26-31）欄接上真實數字。
5. 403 短期先做**擋下**：偵測到有免稅銷售或使用者在設定頁勾「兼營」時，
   Vat 頁明白說明「本系統目前只支援 401 專營應稅」，不要靜默產出。

> 底層積木其實備好了：`f0401.ts:53-63` 的 `taxType` 是 string 且預留了 currency/exchangeRate，
> `media.ts:27` 的 `TaxType` 已含 `"2"`。缺的全是上層入口與取數。
> 專案也已自承：`demo-data.ts:783-800`「外銷（零稅率）：⚠️ **系統目前做不到**」、
> `docs/specs/chart-of-accounts.md:339`「已知的實作缺口 1：零稅率申報欄仍硬寫 0」。

---

### B13. 已關帳／已申報期間可被無聲改動

> ✅ **已修（2026-08-10，commit 7878024）**：issueInvoice 比照 cancelInvoice 檢查發票日期
> （＝銷貨單日期）落入已關帳期間即 409（檢查在字軌配號之前，不消耗號碼）；
> `PATCH /purchases/:id/supplier-invoice` 以進貨單日期補上 assertPeriodOpen（blind update 收掉）；
> 前端報銷付款列補付款日期輸入（預設今天）並帶 payDate。**尚缺**：issueInput 仍不可指定
> invoiceDate（發票日期寫死用銷貨單日期）——遇 409 的脫困路徑是「以當期日期另開一張單據」，
> 錯誤訊息已如此指引；payClaim 的 payDate 在 API 端仍是 optional。

**現象**　同一條規則只做了一半——**作廢擋、開立不擋**。
```
依序關帳至 2026-07（closedThrough = "2026-07"）
POST /sales/1/invoice（銷貨單日期 2026-04-13）→ 201，發票日 2026-04-13
  → 202603 期 401：invoiceCount 0→1、outputSales 0→71,550、outputTax 0→3,578
反向操作 POST /invoices/3/cancel
  → 409「發票日期 2026-04-13 屬於已關帳期間…作廢會改掉該期間（可能已申報）的銷項數字」
```
`cancelInvoice` 有 `closedThrough` 檢查（`invoices.ts:214-224`），`issueInvoice`（`:82`）
完全沒有。同一類漏洞還有兩處：
- `PATCH /purchases/:id/supplier-invoice`（`app.ts:975-990`）是一個沒有任何檢查的 blind update，
  **沒有 `assertPeriodOpen`**。實測：5-6 月期已申報並關帳到 8 月，9 月才登錄那張 6/20 的供應商發票
  → 200，202605 期的進項稅額從 0 變 500、媒體檔多出一行。同一支端點也讓
  **同一張發票號碼可重複登錄在兩張進貨單上**（兩次都 200，進項稅重複列報，見 R5）。
- `payClaim`（`expenses.ts:186,206`）用 `payDate ?? 今天`，而前端 `Expenses.tsx:257`
  **不送 payDate**。實測：7 月關帳後付一張 7/28 的單 → 200 成功，傳票落在 2026-08-09；
  明確送 `payDate:"2026-07-30"` 才會被 409 擋下。等於前端那條路徑天然繞過關帳鎖。

另外，發票日期是**寫死用銷貨單日期**（`invoices.ts:169`），所以使用者連「以當期日期補開一張發票」
這個實務上合法的做法都做不到——系統只給一條路，而那條路正好是錯的。

**影響**　公司 5 月報完 3-4 月期 401、6 月關帳，7 月才發現 4 月一張 7.5 萬的銷貨忘了開發票。
系統照收，401 的銷項憑空多 71,550、留抵從 5,940 變 2,362，申報書早就送出去了。
沒有任何警告，也沒有已申報快照可以比對（401 是每次即時重算）。等國稅局來函才知道。

**建議補法**
1. `issueInvoice` 比照 `cancelInvoice` 加 `closedThrough` 檢查，訊息指引
   「請改以當期日期另開單據，或先重開該期間並同步處理已申報的 401」；
   並讓 `issueInput` 可指定 `invoiceDate`（預設 sale.docDate、不得早於它、不得晚於今天）。
2. `PATCH /purchases/:id/supplier-invoice` 補 `assertPeriodOpen`。
3. `Expenses.tsx:249-258` 付款列補 `<input type="date">`（預設今天）並帶 `payDate`
   ——API 端已經支援（`app.ts:1191`），只差一個 input。

---

### B14. 固定資產的「處分」三重失準

> ✅ **已補（2026-08-10，commit d1f9e62，migration 0031）**：
> (a) 處分前檢查資產科目借餘 ≥ 成本，未入帳 422 指路補取得傳票（採建議 3 的「擋掉」版）；
> (b) dispose 收 `taxable`（預設 true）＋`proceedsIncludeTax`，價款拆未稅＋2288 銷項稅額
> （費率依處分日解析），並新增 `GET /fixed-assets/:id/dispose-preview` 試算——前端先顯示
> 補提折舊／帳面／稅額／預計損益再送出；
> ✅ **發票登錄也已接（2026-08-10，第四批，migration 0034）**：invoices 來源泛化
> （`asset_id` 欄＋`sale_id` 改 nullable，既有資料零搬遷），處分可勾「開立發票」同交易開立
> （金額＝處分價款、稅額＝處分稅額，取落地值不重算；費率快照 `disposal_vat_rate_bp`），
> 401 銷項自然涵蓋；事後補開／作廢重開走 `POST /fixed-assets/:id/invoice`。
> 作廢連動與銷貨發票同規則：處分已開票須先廢發票（409），廢發票可帶 `reverseDisposal`
> 連動沖回處分。不開發票的處分維持 taxNotes 出聲；
> (c) 處分自動補提啟用月〜處分月漏提的期間（補提傳票以處分日入帳，已提過的月份不重複）。
> 建議 4 的 PATCH 也補了（未提折舊可改全部欄位含成本；已提折舊只可改名稱與備註），
> 外加登錄作廢（未提折舊限定，已提 409 指路處分）與處分作廢（反向傳票沖回、資產回 active）。

**現象**　三件事疊在一起：

**(a) 登錄不入帳、處分卻沖帳。** 登錄資產不拋轉取得傳票是**刻意設計**
（`.flightwake/records/260727-fixed-assets.md:18`，與庫存開帳同哲學，要自己補手工傳票），
但 `disposeAsset` 無條件貸記 `asset.cost`。沒補傳票就處分 →
資產負債表出現 `{"code":"1411","name":"機器設備","amount":-112000}` 這種負數資產，
而 `balanced` 仍為 true、沒有任何報表會叫。
> ※ 本條的第二人複驗回報無效（correction 欄位是佔位字串），數字待重測；
> 但「取得不拋轉 vs 處分無條件沖帳」的不對稱在程式碼上是確定的。

**(b) 處分沒有銷項稅額、也不連發票。** 價款 150,000 的處分傳票只有
`借 1103 150,000 / 貸 1431 300,000 / 借 7501 150,000`，**沒有 2288 銷項稅額**；
`GET /invoices` 回 `[]`；401 的 202603 期 `outputSales 0 / outputTax 0`。
補手工傳票貸記 2288 也救不了 401——`vat.ts:37-41` 的銷項只讀 `invoices` 表。
唯一能進 401 的路是捏一個假商品、灌庫存、開銷貨單再開發票，代價是損益表憑空多出營業收入與銷貨成本。
營業人出售固定資產屬應稅銷售額，須開立統一發票並申報 401 銷項；
賣舊貨車 15 萬，系統一毛稅都沒算。

**(c) 未提折舊就處分不會被擋，處分後永遠補提不回。**
`disposeAsset` 不檢查啟用月至處分月之間是否已全數計提；而 `runDepreciation`
（`assets.ts:93`）與 `checkPeriod`（`period.ts:66`）都只撈 `status='active'`
——資產一轉 disposed，關帳檢核就失明、折舊也補不了。
有正常月結的公司實際曝險是「處分當月 1 期」（因為月結會逐月擋），
可用手工傳票把 7501 重分類回 6140 修正；但完全沒關過帳的公司會漏好幾期。

**建議補法**
1. `disposeAsset` 開頭補提「啟用月～處分月之間未提的期間」（或擋下要求先補提）。
2. `disposeAsset` 的 input 增 `taxable`（預設 true）與 `proceedsIncludeTax`，
   價款拆成「未稅 / 2288 銷項稅額」兩行，並提供開立發票的引導或直接接 `issueInvoice`；
   `Assets.tsx` 處分表單加「含稅／未稅」與「需開發票」提示（目前只有一句
   「差額自動列處分損益」）。
3. `disposeAsset` 擋掉「成本從未入帳」的資產，或在 `listAssets`／`runDepreciation` 回傳時
   比對 1411/1421/1431 帳上借餘與該類別資產成本合計，不符即回警示。
4. 補 `PATCH /fixed-assets/:id`：尚無 `asset_depreciations` 記錄者可改全部欄位，
   已有折舊者只能改名稱／備註／保管人。否則成本少打一個零只能靠假處分修正，
   而那會在損益表留下一筆憑空的出售資產損失（且沒有傳票刪除端點可以沖）。

---

## 二、Rough — 會拖慢、會出錯，但有難看的替代做法

### R1. 使用者輸入錯誤一律回 500 internal error，或錯誤訊息無法定位

> ✅ 部分修復（2026-08-10）：「SKU 撞號」與「字軌重建同一區間」兩列已改回 409
> （7b96c48／1428f25）；「合約空 PATCH」的 500（`No values to set`）已改 400（0025 站，
> 732cfa4——合約 partnerId 不存在的 FK 500 仍在）。其餘各列仍在。

同一個根因（缺輸入驗證／原生 Error 未轉成 AppError），散在各處：

| 操作 | 實測 | 位置 |
|---|---|---|
| 401 期別打錯（`202608`／`2026-07`／`abc`／`202613`） | 500 `{"error":"internal error"}`，真因只在 server log | `app.ts:992-996` 只檢查有無 period；`packages/vat/src/period.ts:6,10` 丟原生 Error |
| 報表日期亂填（income-statement／balance-sheet／ledger／dashboard／ar-aging） | 500 | `app.ts:1083-1094`、`1513-1536` 只檢查存在性；字串直接進 SQL date |
| 民國年（`115-06-01`） | **200 且全 0**，比 500 更危險 | 同上 |
| 非數字 id（`/expense-claims/abc`） | 500（NaN 進 SQL） | `app.ts:1172` 等 20 處 `Number(c.req.param("id"))` |
| SKU 撞號 | 500 | `app.ts:685-690` 未接 23505 |
| 字軌重建同一區間 | 500 | `uq_track_range` 未接住 |
| 合約 partnerId 不存在／空 PATCH | 500（FK violation／`No values to set`） | `app.ts:1212`、`1232` |
| 進項供應商缺統編 | 422 但訊息不說是哪一張單、哪個供應商 | `vat.ts:143`（查詢裡已有 docDate/invTrack/invNo/name 可用） |

**影響**　申報期限只有 15 天，會計看到「internal error」只會認為系統壞了；
看到「有一張缺統編」卻要自己去 30 張進貨單裡翻，多家同時缺時還要一輪一輪試錯。

**建議補法**　專案自己已經立過這條規範——`app.ts:250-266` 的 `idParam()` 註解寫明
「網址打錯是使用者的輸入錯誤，該回 400」。把同一個原則套到 query 參數：
報表與 401 的日期／期別用共用的 zod schema（含真日期檢查，擋掉 `2026-13-45` 與 `115-06-01`），
並加 `from <= to` 的 refine（`/exports/*` 目前也不擋顛倒）；
`vat.ts:143` 改成收集所有問題筆數後一次拋出，附進貨單號、日期、發票號碼與供應商名稱。

### R2. 日期先後與未來日期全面不檢查

> ✅ 已修（2026-08-10，第四批，commit d202745）：共用驗證收在 `services/dates.ts`——
> ①「不合理的未來日期」（超過今天＋1 年）422：銷貨/進貨/收付款/手工傳票/報價/訂單/採購單/
> 退回退出/報銷（claimDate 與付款日）/扣繳給付日/資產處分日/發票作廢日；
> **過去日期一律不擋**（補登歷史單據是正常作業）。
> ②日期先後 422（訊息點名哪兩個日期矛盾）：合約截止日≥生效日（POST＋PATCH 合併後檢查）、
> 發票作廢日≥開立日、期初單到期日≥原單日；`openDocuments` 帶 asOf 時只列 `docDate <= asOf`
> 的單（1/15 的收款沖不到 6/8 的銷貨；指名沖銷未來單據時 422 點名兩個日期，
> 溢收會照 0027 掛預收）。③`runDepreciation` 拒絕晚於本月的期間（跳過的期間永遠補不回）。
> ④「成交轉訂單」前端補日期輸入（預設今天）。
> 刻意不加：退回單 certDate ≥ docDate——returns.ts 檔內已有查證過的不擋理由
> （先議定折讓、貨後來才退是可能時序，證明單日期規則未查證）。
> dueDate ≥ docDate 在 0022/0033 已擋。

同樣一類：`tax-parameters` 對期間顛倒擋得死死的（422，訊息還寫「畫面上它看起來跟正常的列一樣」），
其他地方一律放行。

| 情境 | 實測 |
|---|---|
| 合約截止日早於生效日 | `startDate 2027-01-01 / endDate 2026-01-01` → 201，且會被 `Contracts.tsx:25` 標成「已逾期」計入頁首警示——一份還沒開始的合約被催著續約 |
| 發票作廢日早於開立日 | 200，`<InvoiceDate>20260804</InvoiceDate>` 配 `<CancelDate>20260101</CancelDate>`。更糟：`reverseSale` 的 entryDate 就是 cancelDate（`invoices.ts:242`），迴轉傳票會落在原交易發生前六個月。**純 UI 操作就會發生**（`Invoices.tsx:19` 不送 cancelDate，用今天；而銷貨單可以開未來日期） |
| 收款日早於被沖銷的銷貨單 | `openDocuments`（`ledger.ts:95-131`）只用 asOf 篩退回沖銷，不篩單據本身日期 → 1/15 的收款可沖 6/8 的銷貨單。副作用是那筆錢在兩個日期之間從帳齡表整個消失（同日資產負債表 1144 卻是負的） |
| 未來日期的報銷單／扣繳單 | `claimDate: 2027-12-31` → 201；`payDate: 2030-01-01` → 201，落進 2030 年度彙總 |
| 折舊跑到未來期間 | `POST /depreciations/run {"period":"2030-12"}` → 201。月結檢查會逐月擋著不讓你關帳（設計是對的），但**那一期永遠補不回**（asset×period 冪等會跳過），資產頁的累計數與總帳從此差一個月，且沒有撤銷入口。`Assets.tsx:120` 的 `<input type="month">` 沒有 max |
| 成交轉訂單 | `Orders.tsx:185` 寫死 `new Date()`，沒有日期輸入；客戶的採購單日期是上週五也只能記成今天 |
| 資產處分日早於取得日 | 200 |

**建議補法**　各 input 加 refine（合約 `endDate >= startDate`、作廢 `cancelDate >= invoiceDate`
且不晚於今天、`openDocuments` 加 `docDate <= asOf`）；未來日期超出合理範圍時回一則
`taxNotes` 式的提醒而非靜默通過；`runDepreciation` 拒絕晚於今日所在月的 period；
「成交轉訂單」加日期輸入（預設今天）。

### R3. 所有清單都沒有篩選、排序與分頁

> ✅ 其中「`/invoices` 每筆都帶完整 XML」已修（2026-08-10，commit 975813b）：
> 清單改白名單挑欄位（不含 xml／cancelXml），前端檢視與下載改走單張端點。
>
> ✅ 篩選與分頁已修（2026-08-10，第四批，commit d202745）：sales/purchases/invoices/journal-entries/
> expense-claims/cash-docs/quotes/orders/purchase-orders 九端點收
> `from/to`（單據日期）＋`partnerId`（有對象者；發票/傳票/報銷收到會 400 指路）＋
> `limit/offset`（預設 200、上限 500）。**回應形狀不變（仍是陣列）**，總筆數在
> `X-Total-Count` 標頭；無效參數（壞日期、範圍顛倒、非整數）400 出聲，不再靜默回全表。
> 全部清單改新到舊排序（原本 /sales /purchases /invoices /cash-docs 沒有 orderBy）。
> 服務層同步下推 SQL：`listOrders`/`listPurchaseOrders`/`listQuotes`/`listClaims`/
> `listJournalEntries` 的全表載入＋O(n×m) 記憶體比對改為「頁內 id 各關聯一次查詢」。
> 前端九張清單頁補日期範圍＋對象篩選列（樣式照 audit-logs），
> 總數超過顯示筆數時出聲提示縮小範圍。狀態（status）篩選未做。

query 參數**被靜默忽略**（回 200，不會回 400 告訴你沒生效）。實測：

```
/quotes?status=open|partnerId=2|limit=10|from=…|page=2|q=…  → 八種寫法全部 200 且 n=44（全表）
/orders /sales /purchases /cash-docs /invoices /expense-claims /withholding-payments /journal-entries → 同
/withholding-payments?partnerId=999999（不存在的人）→ 200 回全部（腳本對帳會拿到全公司總額）
```
`/invoices` 更是每筆都帶完整 `xml` 與 `cancelXml`（5 筆 9,056 bytes，其中 82% 是 XML），
而 `Invoices.tsx:47` 直接吃列表回應裡的 `inv.xml`——不是懶載入，每次開頁都強制下載。
沒有 `orderBy` 的清單（`/invoices`）在有人作廢一張之後順序還會漂移。
服務層另有全表載入＋O(n×m) 記憶體比對（`orders.ts:74-86`、`173-194` 一次拉五張全表），
所以只在 API 加 limit 是不夠的。

規模量測：500 張報價 242 KB／12 ms、1200 張銷貨 246 KB／7 ms、800 張報銷 472 KB／18 ms
——**這不是效能問題，是「第二年這一頁還能不能用」的問題**：找一張特定客戶的單只能 Ctrl+F。

同一個 codebase 已經有正確樣板：`GET /audit-logs`（`app.ts:497-507`）有 limit（上限 500）
＋before cursor＋userId/method/path/failedOnly，前端 `Settings.tsx:311-355` 也配了篩選器 UI。

**建議補法**　照 audit-logs 那組 pattern，逐一補 `partnerId / status / from / to / limit / offset`
（回 `{rows, total}`），未知或無效參數回 400；服務層同步下推到 SQL；
前端各頁加對應篩選列。優先序：報銷（狀態篩選，會計每天用）＞銷貨／進貨＞報價訂單＞發票。

### R4. 銷貨單／進貨單列表看不到對象，也看不到品項

> ✅ 部分修復（2026-08-10，commit 22a4e0e）：補了 `GET /sales/:id`（單頭＋明細＋客戶名稱，
> 白名單挑欄位，供列印使用）。兩張清單本身仍無 partnerName／lines，`GET /purchases/:id` 仍 404。

`app.ts:869/874` 兩支都是 `db.select().from(schema.sales|purchases)` 原表直出，
沒有 `partnerName`、沒有 `lines`；`GET /sales/:id`、`/purchases/:id` 皆 404。
`Sales.tsx:98` 表頭是「單號／日期／未稅／稅額／總額／發票／退貨」，`Purchases.tsx:190` 同樣沒有供應商欄。
對照 `listOrders`（`orders.ts:176-193`）與 `listPurchaseOrders` 都有 `partnerName` 與明細，
退貨單／收付款單／進貨退出列表也都有對象名稱——**只有這兩張最常用的表沒有**。

繞路都不完整：`/sales/:id/returnable` 回 productName 但**不回 partnerName**；
發票頁只涵蓋「已開票」的單；退貨紀錄表只涵蓋「退過」的單。
「還沒開票、也沒退過」的銷貨單完全無解——而那正是財務站在這一頁要按「開 B2B／B2C」的當下狀態。
資料其實拿得到：`Sales.tsx:10` 已經 `useFetch("/partners")`，只是從沒用來查名字
（同 repo 的 `CashDocs.tsx:41` 正是這樣做的）。

**建議補法**　`listSales()`／`listPurchases()` 比照 `listOrders` 補 `partnerName` ＋
`lines`（含 productName）＋ `orderId`／發票狀態；前端表頭加「客戶／供應商」與「來源訂單」欄，
明細做可展開列。

### R5. 重複資料一律不擋

> ✅ 部分修復（2026-08-10，commit 7b96c48）：第一項已修——`partners.tax_id` 加 partial unique
> index（升級 migration 先驗既有重複並給整併指示），POST/PATCH 撞統編回 409 並講出撞到誰。
> 供應商發票重複登錄與報銷發票號碼重複（後兩項，都會讓進項稅重複列報）仍未擋。
>
> ✅ 第二項也已修（2026-08-10，commit 975813b，migration 0029）：同供應商＋同字軌號碼
> 重複登錄回 422 並指出撞到哪張進貨單（自己重登、作廢單、空白號碼排除），DB partial unique
> index 做防線；升級前驗舊庫重複並給整併指示。
>
> ✅ 第三項（報銷側）也已修（2026-08-10，commit 9241d71）：`createClaim` 登錄發票號碼時查
> purchases 與 expense_items 兩邊的既有號碼（同單內重號也擋），撞號 422 指出撞到哪張單；
> 作廢進貨單／退回的報銷單放行（照 0029 進貨側的模式），兩邊賣方統編都有值且不同
> （跨期重用的同號發票）也放行——任一邊沒填統編就無從分辨，一律擋下並指路補統編。
>
> ✅ 反向也已擋（2026-08-10，第四批，commit cb68196）：`PATCH /purchases/:id/supplier-invoice` 反向查
> expense_items 的既有報銷號碼，撞號 422 指出撞到哪張報銷單；放行條件鏡像報銷側
> （退回的報銷單不算、兩邊賣方統編都有值且不同放行）。互查閉環完成。

三處同一個性質，且都會造成實際損失：

- **同一組統編可重複建成多筆客戶**：`partners` 只有 `partners_pkey`，`tax_id` 無 unique。
  連 PATCH 都能把既有對象改成撞號。分裂之後 AR 散在兩個 id 上、`/partner-balances` 出現兩列
  同一家公司，且**一張票沖不掉兩邊**（跨對象沖銷 422），也**沒有合併或停用的路徑**
  （無 DELETE、無 active 欄位）。下拉選單只顯示名稱不顯示統編（`DocForm.tsx:56` 等），
  開單當下沒有任何線索能分辨。
- **同一張供應商發票可登錄在兩張進貨單上**：兩次 PATCH 都 200，401 媒體檔出現兩筆
  同賣方同字軌同號碼的記錄，`inputExpenseTax` 重複計算＝少繳稅。
  （銷項那側 `docs/specs/einvoice-mig41.md:15` 明文要求不得重複並以 `invoices.sale_id UNIQUE` 落實，
  進項完全沒有對應防線。）
- **同一張發票號碼可重複報銷**：`createClaim`（`expenses.ts:44-99`）只驗格式
  `/^[A-Z]{2}\d{8}$/`，從不查既有 `expense_items`；連同一張報銷單裡放兩筆相同號碼也照收。
  實測四筆同號 → 401 媒體檔四筆一模一樣、50 元的進項稅被算成 200。
  而 expense_items 與 purchases 兩邊也不互查。

**建議補法**
- `partners.tax_id` 加 partial unique index（`WHERE tax_id IS NOT NULL`——taxId 選填、個人一律 NULL），
  POST/PATCH 攔 23505 回 409「統編 XXXXXXXX 已建檔：#id 某某公司」；
  下拉選單顯示「名稱（統編）」；提供合併或改掛路徑。
- 進項與報銷：登錄／建單前查同號（跨 `purchases` 與 `expense_items` 兩張表），
  命中回 409 並指出已登錄在哪一張單；確有正當重複時走 `allowDuplicate` 旗標。
  401 產檔時再做一次重號偵測，比照 `returnsNotReflected` 揭露而非靜默產檔。

### R6. 收付款：同一個客戶，三個地方三個答案；而且看不到沖了哪幾張

> ✅ 部分修復（2026-08-10，commit e567ea5）：**溢收／溢付**那一段不一致已由 B9 解掉——
> 超過對象未沖總額的部分落 2231 預收／1212 預付，open-documents 以 docType 'prepaid' 分列、
> partner-balances 加 prepaidReceived/prepaidPaid、帳齡 credit 欄改跟 2231 走。
>
> ✅ 已修復（2026-08-10，第四批，commit 57a2ab7）：餘額口徑統一到 `services/balances.ts` 單一事實來源——
> open-documents 的 remaining 改含「未指定沖銷收款 FIFO 沖最舊」（與帳齡同一份
> settlementMaps），三處對同一組資料同一個答案（test/balance-consistency.test.ts 釘住）；
> returns.ts 的沖應收付上限改吃同一份 partnerBalanceMaps（原本付款「全額」扣應付，
> 溢付時退出單 apOffset 被壓低；也補上期初單與作廢排除）。沖銷關係補了
> `GET /cash-docs/:id`（沖了哪幾張、各沖多少、那些單現在還剩多少），收付款頁點「沖銷明細」
> 可見。**未動**：帳齡列下鑽 UI 與 open-documents 對 sales 角色開放（業務催款視角）。

- **不一致**：未指定沖銷的收款，`openDocuments`（`ledger.ts:112,126`）只扣
  `cash_doc_allocations`、完全不看 `cash_docs`，而 `arAging`（`orders.ts:324-348`）
  會把它放進對象層級 FIFO pool 補沖。實測：應收 470,400、收 200,000 未指定沖銷 →
  open-documents 仍顯示兩張單全額（合計 470,400），partner-balances 與 ar-aging 都是 270,400。
  會計照 open-documents 開下一張收款單，很可能再收一次。
  （`partner-balances` 的 `ar: -463,460` 與 ar-aging 的 `credit: 463,460` 是同一數字的兩種正負慣例，
  不算第三個答案——但那兩者與 open-documents 確實對不起來。）
- **看不到沖銷關係**：`GET /cash-docs` 是原表直出，POST 時回的 `allocations` 在清單完全消失；
  `GET /cash-docs/:id` 404。客戶打來問「7 月匯的那 30,240 是付哪張單」，
  畫面上查不到（`CashDocs.tsx:198` 表頭只有單號／類別／日期／對象／金額／摘要），
  傳票摘要也只有「收款單 - 家常屋」不含單號。立沖功能做了，只在建立當下看得到一次。
- **帳齡無法下鑽、無法篩選**：`/reports/ar-aging` 只吃 asOf（`app.ts:1533-1536`），
  rows 是客戶層級彙總；`Sales.tsx:241-253` 每列是純文字。
  下鑽其實有（`/open-documents` ＋ CashDocs 頁的立沖表格），但**業務角色打不到**
  （掛在 cash 頁權限，`auth.ts:380`；`ROLE_PAGES` 只給 admin/finance）——
  而業務正是要打電話催款的那個人。

**建議補法**　`openDocuments` 改為與 arAging 同一套邏輯（先扣該對象未指定沖銷的餘額再算 remaining），
或至少回傳對象層級的 `unappliedCredit` 並在立沖表格上方提示；
`GET /cash-docs` join `cash_doc_allocations` 帶出沖銷單據，清單加可展開列；
帳齡列可展開（用帳齡自己的沖銷結果，含 FIFO），並把這條讀取路徑對 sales 角色開放。

### R7. 銀行對帳與票據（支票）管理完全沒有

- **銀行對帳**：`/bank-reconciliation`、`/bank-statements`、`/reconciliations` 全 404；
  `cash_docs` 與 `journal_lines` 都沒有 `reconciled/cleared` 欄位；
  `PATCH /journal-lines/:id` 也不存在。最接近的是 `/reports/ledger?accountCode=1103`
  （逐筆帶餘額），但無法勾選已兌現，畫面（`Reports.tsx:47-73`）只有六欄、沒有勾選框也沒有下載鈕，
  `GET /cash-docs` 又不吃 accountId、`/exports/journal` 也不吃 accountCode。
  月底對存摺只能照螢幕逐筆看。差異來源是在途匯款、手續費、自動扣款
  （這家公司不用支票，所以不含未兌現支票）。
- **票據**：`1141 應收票據`／`2141 應付票據` 的 `isCash=false`，拿來當收付科目回 422。
  應收側可以自建一個 `isCash:true` 的科目繞過去（沖銷正確），但**現金水位會說謊**
  （儀表板 cash 顯示 105,000，手上其實只有一張三個月後的票）；
  應付側連繞都繞不了（`app.ts:712` 的 `assertCashIsAsset` 只准資產類，建 2142 回 400），
  只能手工傳票，而進貨單會永遠掛在未付清單上。沒有票號、到期日、付款行、票據狀態欄位，
  也沒有「這個月哪幾張票到期」的任何查詢。

> 票據管理是 `gap-analysis-2607.md:45` 記錄的**緩議**（2026-07-27 使用者確認公司未使用支票），
> 這裡列出是因為換一家收客票的公司就會撞到，不是要推翻那個決定。
> 銀行對帳則是 `.flightwake/STATE.md` 自己列的「使用者定的五步」裡唯一沒動的一項。

**建議補法**　銀行對帳：`journal_lines` 或 `cash_docs` 加 `reconciled_at`
＋`POST /bank-reconciliations`（輸入對帳日與存摺餘額、勾選已兌現、產出調節表），
明細分類帳頁補勾稽 UI 與 CSV 匯出。票據：`accounts` 加 `is_note` 旗標＋
`cash_doc_instruments`（票號／到期日／付款行／狀態 held|deposited|cleared|bounced）
＋「票據到期兌現」動作，前端加票據到期清單頁。

### R8. 進貨的運費、關稅、報關費無法計入存貨成本

`docInput`（`app.ts:236-248`）沒有 freight/otherCharges（送了 201 但靜默丟棄），
`purchaseEntryLines`（`packages/core/src/posting.ts:24-33`）只有借 1301 subtotal／借 1288／貸 2144。
四條變通全部破功：手工傳票借 1301 → 總帳與存貨明細直接脫鉤（那筆錢永遠卡在 1301、
**永遠不會轉進銷貨成本**）；灌進單價 → 應付與進項稅額都假、匯出的進項清冊出現不存在的發票；
建假商品「運費」→ 庫存多一列在庫；`/inventory/opening` 只加金額不加數量 → 400。
`/inventory/landed-cost`、`/purchases/:id/charges` 全 404。

**影響**　存貨低估、毛利高估。實測：landed cost 6,500 的貨賣 5,000，
儀表板顯示「本月毛利 2,000（40%）」（`dashboard.ts:40` 的 grossProfit = subtotal − cogs，
結構上永遠不含 6127），真實毛利是 −1,500。當月淨利是對的（6127 有入損益），
錯的是資產低估、毛利／費用切分、以及跨月配比。

**建議補法**　進貨單加 landed cost 明細（運費／關稅／其他），依各明細金額比例分攤進
`inventory_movements` 的 `unitCost` 與 `amount`，傳票端一併借 1301；
或提供獨立的「進貨費用分攤單」指定分攤到某幾張進貨單。
需同時改 `posting.ts` 的 `purchaseEntryLines` 與 `documents.ts:152-162`。
> `docs/specs/chart-of-accounts.md:223`（B26）已把它登記在**待確認**表，並註明
> 「若要資本化進存貨，需改 posting.ts，不是純種子變更」——是已知待補，不是決定不做。

### R9. 沒有庫存異動明細帳

`inventory_movements` 資料齊全（productId／direction／qty／unitCost／amount／sourceType／sourceId，
五個寫入點都在寫），但**整個 repo 沒有任何一條讀它的 API**：
`/inventory/movements`、`/products/:id/movements`、`/reports/inventory-ledger`
等 23 條路徑全 404；`/inventory?productId=1` 的參數被忽略（`app.ts:921` 沒讀 query）。
退路也不通：`GET /sales/:id`、`/purchases/:id` 404；`/reports/ledger?accountCode=1301`
回的是多商品混在一起的金額、沒有數量；稽核日誌刻意不記 body。
期初開帳（`sourceType: opening, sourceId: 0`）與發票作廢回補（`invoices.ts:300`）
這兩類異動用單據反推**永遠拼不回來**。

**影響**　倉管說實際只有 380 包時，會計想查「這個月進了幾次、出了幾次」完全無從查起，
盤點差異也無法歸因。

**建議補法**　`GET /inventory/movements?productId=&from=&to=`，join 來源單據
（sourceType/sourceId → 進貨／銷貨／退出／期初），回逐筆結存數量與結存金額，讓均價的每次變動可追。
注意 `inventory_movements` 沒有 `doc_date`（只有 `created_at`），期間篩選需 join 回來源單據。

> ✅ **已修（2026-08-10，第四批，commit 45b8c7b，migration 0035）**：
> `GET /inventory/movements?productId=&from=&to=`——逐筆異動（來源單據標籤、進出量、
> 單價、結存量與結存金額），期初＝範圍前異動淨額、結存不斷鏈；作廢回沖列照列並標明
> 「作廢回補／回沖」。0035 給 `inventory_movements` 補了 `doc_date`（既有資料以來源單據
> 回填；opening 無來源可回連、退回 created_at 台北日期——0035 起開帳異動落真正的開帳日）。
> 前端：儀表板庫存列點「明細」展開。權限與 `/inventory` 同（dashboard 頁）。

### R10. 庫存開帳可無限重複執行，沒有防呆也沒有刪除入口

同商品同日同內容連送兩次，兩次都 201，數量翻倍。沒有 `GET /inventory/openings`
（看不到已開過哪些）、沒有 DELETE、`qty` 必須 > 0（負數 400）。
`submitOpening`（`Settings.tsx:399-411`）沒有 in-flight 鎖、按鈕沒有 disabled，快速連點會送兩次。
（成功訊息是有的，`Settings.tsx:405/458`；操作日誌也記得到「按了兩次」，但不記數量。）
污染範圍只有 `inventory_movements` 多出的一列（不拋轉傳票所以不動帳），
但因為庫存不能減（B8），系統內無法修復，只能下 SQL。
現成護欄：期間關帳後再開回 409——導入完就關帳，重複開帳從此被擋。

**建議補法**　偵測該商品已有 `sourceType='opening'` 的異動時回 409 並提示既有數量
（可用 `force` 覆寫）；新增 `GET /inventory/openings`；`submitOpening` 加送出中鎖定。

### R11. 費用報銷：三個相鄰的缺口

> ✅ 已修復（2026-08-10，commit 98018c1，migration 0036）：①作廢入口
> `POST /expense-claims/:id/void`（限 finance/admin）——反向傳票沖核准＋付款傳票、
> 401／彙總／R5 查重以 voided_at 排除、同號發票釋出；rejected 可 `PATCH /expense-claims/:id`
> 改明細重送（前端把原單連收據影像帶回表單）。②approve/reject 取登入者比對申請人
> （自核 409；admin 例外放行並留痕），`expense_claims` 補 `approved_by_user_id/approved_at`。
> ③`users.employee_id` partial unique＋POST/PATCH 409，設定頁下拉標示「（已連 xxx）」並停用。

- **無作廢／沖銷，退回後不能改重送**：approved/paid 一律鎖死（再 approve/reject 皆 409），
  `PATCH/PUT/DELETE /expense-claims/:id` 全 404，`rejected` 是終點狀態。
  金額多打一個 0 被核准後，手工反向傳票**救得了總帳、救不了 401**
  （`vat.ts:128-133,170` 的進項直接 join `expense_items`，不讀總帳）——
  那張多報 4,500 元進項稅的媒體檔會照樣送出去。
  退回後重建要重打明細**並重新上傳同一張收據照片**（原單影像只能在明細視窗看，表單不回填）。
  `.flightwake/records/260722-expenses-contracts.md:34` 已自承「報銷退回後不能編輯重送，體驗補強候選」。
- **財務可以核准自己送的單，且沒有主管簽核層**：`approve` 端點（`app.ts:1179-1181`）
  的 handler 連 `c.get("user")` 都沒取，不可能比對申請人。實測 finance 帳號
  送單→核准→付款三個動作由同一個 session 完成，零阻擋零警示。
  而且 `expense_claims` 表**沒有 approvedBy/approvedAt** ——單據上查不到誰核准的，
  唯一留痕的 `audit_logs` 只有 admin 看得到。業務主管完全沒有簽核角色（sales/purchasing 打 approve 403）。
- **兩個使用者帳號可以連到同一個員工**：`users.employee_id` 沒有 unique
  （`migrations/0007_auth.sql:13`），POST 與 PATCH 都不查重。
  管理者在 `Settings.tsx:110` 的下拉點錯一格（該下拉不標示某員工已被佔用），
  就把一個人的報銷紀錄（住哪家旅館、吃了什麼）全開給另一個帳號，且能以她的名義送單。
  這是報銷模組唯一的隱私保護。

**建議補法**　`POST /expense-claims/:id/reverse`（寫反向傳票並記 `reversal_entry_id`）；
`rejected` 可改明細後回 submitted；`approve`／`reject` 取登入者比對 `claim.employeeId`，
相同時回 409（或要求 admin 核准並記 audit note），`expense_claims` 補
`approved_by_user_id / approved_at`；`users.employee_id` 加 partial unique index
（允許多個 NULL）＋POST/PATCH 回 409，下拉標示「（已連 xxx）」。

### R12. 費用報銷：附件與匯出

> ✅ 部分修復（2026-08-10，commit 98018c1）：影像取出口
> `GET /expense-claims/:id/items/:itemId/image`（本人限定同 GET /:id）＋明細畫面逐張下載；
> `GET /exports/expense-claims?from&to` CSV（單號／員工／付款方式／分類／憑證別／發票號碼／
> 發票日期／賣方統編／金額／可扣抵稅額／狀態／核准與付款傳票號；rejected 不列、
> 已作廢照列並標注）。尚缺：每筆多附件（仍限一張圖）、PDF 收件、附件打包端點。

- **每筆明細只能一張圖**：`expense_items.image` 是單一 text 欄位，送 `images:[…]` 被丟棄。
  住宿的訂房確認單＋發票要掛兩份時無解——補一筆 0 元明細會被 `amount > 0` 擋（400），
  送出後也沒有任何編輯端點可以補掛。
- **PDF 在畫面上一律拒收**：`readReceiptImage()`（`einvoice-qr.ts:41-46`）把檔案塞進
  `new Image()`，PDF 觸發 onerror →「影像格式不支援」，image 從未寫入；
  上傳欄位 `accept="image/*"`。電信費、雲端訂閱、機票、住宿的憑證幾乎都是 PDF，
  員工只能先截圖再上傳，畫質差到會計看不清發票號碼。
  （直接打 API 塞得進去，但明細畫面 `Expenses.tsx:288-290` 是 `<img>`，會顯示破圖且無下載。）
- **沒有報銷專屬匯出**：`/exports/expense-claims` 404，`exports.ts` 全檔無 expense 字樣。
  報銷是外部記帳士最常回頭要憑證的一塊（伙食、交際、差旅都是查核重點），
  現在只能丟傳票 CSV（看不到發票號碼、賣方統編、憑證影像）或一張一張右鍵存圖。

> 對照組：**合約模組同一批交付卻做完整了**——`accept=".pdf,image/*"`（`Contracts.tsx:120`）、
> `GET /contracts/:id/file` 單獨取檔、`<a download>` 真正下載。報銷三樣都沒有。

**建議補法**　`expense_items.image` 改成 `attachments`（JSONB 陣列，含 mimeType/fileName/data），
zod 驗 data URI 前綴限 `image/*` 與 `application/pdf`，`accept` 補 pdf，
明細依 mimeType 決定 `<img>` 或 `<a download>`；補
`GET /exports/expense-claims?from&to`（單號／日期／員工／分類／說明／憑證別／發票號碼／
發票日期／賣方統編／金額／可扣抵稅額／狀態／核准傳票號／付款傳票號）與附件打包端點。

### R13. 費用報銷：沒有「公司欠員工多少」，也沒有代墊 vs 公司支付

> ✅ 大致修復（2026-08-10，commit 98018c1，migration 0036）：
> `GET /expense-claims/payable-summary` 依員工彙總 approved 未付（不再借道 2201 餘額——
> 那條路混入銷貨退回的應付客戶）；報銷頁財務視角掛待付小表、dashboard 加
> `approvedUnpaidClaims` 卡片、月結檢查加「已核准未付」提醒、`listClaims` 收 status。
> `claimInput` 加 `paidBy`：company（公司卡／公司帳戶）於核准時指定付款科目
> （現金或負債類科目）直接貸它、狀態進 paid，進項稅照進 401——假員工 workaround 退場。
> 尚缺：1288 總帳餘額與 401 可扣抵進項稅的對帳警示。

- `dashboard.ts:60` 的 `pendingClaims` 只算 `submitted`；`listClaims`（`expenses.ts:216`）
  只接 employeeId，沒有 status 參數；月結檢查（`period.ts:87-107`）也只提醒 submitted。
  「這個月要發多少報銷款」只能自己把清單全撈下來手動篩 approved 加總。
  （查得到的路徑是 `/reports/ledger?accountCode=2201` ——每筆 memo 都帶員工姓名，
  期末餘額就是已核准未付總額；但那條路不乾淨，會混入銷貨退回的應付客戶
  ——`posting.ts:66` 的 `saleReturnEntryLines` 也貸 2201，而 `chart-of-accounts.md:127`
  的規格只記了報銷那兩條路徑。）
- 沒有付款方式欄位：`claimInput`（`app.ts:1136-1156`）與 `expense_items` 都沒有
  `paidBy`，送了靜默丟棄。公司信用卡付的費用**可以**走報銷流程（進項稅正確進 401），
  但要靠一個沒被文件化的 workaround：建一個名為「公司信用卡（玉山）」的假員工當付款主體、
  用 2201 當過渡科目、付款日填卡帳結清日。改走手工傳票則進項稅**一毛都不進 401**
  （`generate401` 只掃 invoices / purchases / expense_items，不讀總帳），等於白白放棄可扣抵稅額，
  而系統一句話都不說。另外信用卡建不成應付科目（`isCash` 只准資產類，回 400）。

**建議補法**　`dashboard` 加 `approvedUnpaid {count, amount, byEmployee[]}`，
Dashboard 顯示「待付報銷」卡片；`listClaims` 加 status/from/to；
月結檢查的 claims 項一併提醒 approved 未付；
`claimInput` 加 `paidBy: "employee" | "company"`（company 時核准分錄直接貸現金／公司卡負債科目，
狀態直接進 paid）。若兩者都不做，`Expenses.tsx` 至少要明說「公司卡付的費用也要從這裡報，
否則進項稅不會進 401」。另補 1288 總帳餘額與 401 得扣抵進項稅的對帳警示。

### R14. 扣繳：沒有繳庫流程，費率就地覆寫無版本，缺所得格式代號

- **繳庫**：`/withholding-remittances`、`/withholding-payments/remit|settle` 全 404；
  `liabilityBalances`（`withholding.ts:466-481`）是一支不分期間的 SUM，
  註解自陳「不限日期也不限年度」。繳款只能開手工傳票，且系統沒有留下
  「這 6,000 是繳哪個月、哪幾筆」的任何紀錄。
  （逐月跑 `/reports/ledger?accountCode=2211` 的 opening 可以推，但要人自己一個月一個月跑、
  自己假設先進先出，同月多筆或部分繳納就歸不了屬。）
- **費率就地覆寫**：`updateCategory`（`withholding.ts:104-138`）是 UPDATE，
  扣繳類別沒有生效期間也沒有歷史列。舊單據答得出費率（`tax_rate_bp_at_entry` 有快照），
  但依據來源會變成錯配——`sourceNote` 不會被清掉，於是那一列變成「5%，依據 A 公告」
  而 A 公告寫的是 10%，畫面上沒有任何提示。
  這正是 `migrations/0016_tax_parameters.sql:7-9` 明白寫著要修的洞
  （「它沒有生效期間——費率變動時只能覆寫，覆寫掉的那一刻，去年的單據就再也解釋不出來了」），
  但扣繳從未被接上稅法參數表。
- **所得格式代號**：`withholding_categories` 沒有這個欄位（送了靜默丟棄），
  彙總分組鍵寫死 `${partnerId}:${categoryId}`。同一位受領人的同類所得（設計費、翻譯費都記 6124）
  若分了兩個類別，彙總就會比實際要開的憑單多出幾列，得自己相加。
  `docs/specs/withholding.md:143-146` 已寫明「屆時的做法是在類別上加一個使用者填寫的格式代號欄位」，
  押在拿到媒體檔格式規格時一起做。

**建議補法**　新增 `withholding_remittances`（繳納日／所屬期間／稅款/保費金額／現金科目／傳票 id）
＋`POST /withholding-remittances` 自動拋轉借 2211/2212 貸現金；
`liabilityBalances` 改為「按給付月份分組的未繳餘額」，畫面換成「月份 × 已扣 × 已繳 × 未繳」小表。
費率：併入 `tax_parameters`（`kind='withholding_rate'`、`scopeKey=類別 id`，沿用生效期間與
`supersedePrevious`），或至少改動時寫一份歷史表並在畫面提供「費率沿革」。
格式代號欄位照 `sourceNote` 的紀律加（使用者自填、程式不驗證），`paymentSummary` 在該欄有值時
改用 `partnerId + 格式代號` 分組。

### R15. 月結與年度結轉：檢查太少、可關未來、重開無痕、結轉不可逆

四件事同一區：

- **月結檢查只有 3 項**（sequential／depreciation／claims，`period.ts:53/77/100`）。
  最該有的一項沒有：**本期已入帳但未開發票的銷貨**。實測：銷貨單 2026-04-13 含稅 75,128
  已經把 4101 收入與 2288 銷項稅額拋進總帳，401 的 202603 期卻是
  `invoiceCount 0 / outputSales 0 / outputTax 0`，而月結檢查說「全部通過」、直接 201 關帳。
  （提出過的另外四項——試算表借貸不平、庫存負數、應收明細對總帳——查證後多為假陽性：
  不平的傳票進不了庫、超賣有 409 擋、明細與總帳同源。真正該加的是未開發票、
  以及 B6 說的存貨對帳。）
- **可以關還沒到來的月份，第一次關帳也沒有下界**。全新資料庫直接
  `POST /period-closes {period:"2099-12"}` → 201，之後今天的傳票一律 409
  「已關帳（帳務關至 2099-12）」。反過來，新公司隨手選了本月按關帳，
  等於把導入前**所有**月份無聲鎖死（實測 2019-01 的傳票也被擋），而那些月份從沒被檢查過。
  `Reports.tsx:178` 的 `<input type="month">` 沒有 max，兩顆按鈕都沒有二次確認。
- **重開一次只能退一個月、不需理由、事後查不到重開了哪一期**。
  要修 2026-03 就得連按五次（4~7 月一起解鎖）；重開是 `DELETE` 掉 `period_closes` 那一列
  （`period.ts:148`），所以事後完全看不出 2026-07 曾被關過，連原始關帳人與時間也被覆蓋。
  `audit_logs` 記得到「誰、什麼時候、對 /period-closes/latest 發過 DELETE」，
  但因為刻意不記 body，記不到是哪一期（可由「目前 closedThrough ＋ 完整日誌」確定性反推，
  但畫面上沒有這個工具）。
- **年度結轉不可逆**。結轉後 `DELETE /period-closes/latest` 回 409
  「請先聯絡記帳士處理結轉分錄」，而系統**沒有任何端點能處理那張分錄**
  （`DELETE /journal-entries/:id`、`/year-closes/:year` 皆 404）——訊息指向一條不存在的路。
  （這是刻意設計且有測試守著；真正的解法是會計實務上的前期損益調整——在還開著的期間下
  手工傳票沖 3351，系統支援。但沒有任何地方指向它，而且沖銷若走損益科目會污染次年損益表，
  科目表裡也沒有「前期損益調整」專戶。）

**建議補法**　`checkPeriod` 加兩項：未開發票的銷貨（列單號與含稅金額）、存貨明細對 1301；
加一項 blocking「期間結束日晚於今天則不可關」；`through===null` 時若該期間之前仍有傳票，
提示「最早的傳票在 YYYY-MM，請從那裡開始關」。
`period_closes` 加 `status/reopened_by/reopened_at/reopen_reason`，重開改 UPDATE 保留歷史列，
並要求填理由、在 UI 顯示「將同時解鎖 2026-04~07」的確認。
`reopenLatest` 的 409 訊息改成指引前期損益調整（沖 3351）而非「聯絡記帳士」。

### R16. 報表：試算表沒有期間、四張表拿不出檔案、明細分類帳沒有對方科目

- **試算表不吃任何參數**（`app.ts:922` 直接 `trialBalance(db)`，服務層也沒有 where）。
  `?from=&to=` 與不帶完全相同，欄位只有 `code/name/debit/credit`
  ——是「開帳至今累計發生額」，沒有期初／期末餘額。年度結轉後收入費用在這張表上互相沖平
  （4101 變成 `debit 2400 / credit 2400`）。
  台灣中小企業每月給記帳士的第一張表要的是「期初／本期借／本期貸／期末」四欄。
  （公平地說：期間別數字別處拿得到——`/reports/ledger` 有 opening/closing 且前端有起訖日期，
  損益表排除結轉分錄、資產負債表正確。缺的是**一次列出全部科目**的那張彙總表，
  現在要對 74 個科目逐一呼叫 `/reports/ledger` 才湊得出來。）
- **四張報表只能在畫面上看**：`Reports.tsx` 全檔沒有下載或列印按鈕
  （`downloadText` 就在 `api.ts:41`，同 repo 的 Exports/Vat/Contracts 都在用）；
  `/exports/trial-balance|ledger|income-statement|balance-sheet|expenses|cash-docs` 全 404。
  只有傳票明細寄得出去，而它的表頭沒有「來源」欄——`journal_entries.source_type` 有值
  （purchase/sale/manual/closing）卻沒被 select，記帳士要匯進自家軟體時只能靠人工判讀摘要字串。
- **明細分類帳一次只能看一個科目**，每行只有 `entryId/entryDate/memo/debit/credit/balance`
  ——沒有對方科目、沒有交易對象。應收帳款明細帳的用途就是「跟哪一家對帳」，
  現在看到「銷貨單 #1 借 75,128」查不出是誰欠的。沒有總分類帳（accountCode 必填、無多選）。
  （`/exports/journal` 的 CSV 同一傳票所有分錄相鄰，對方科目看得到；但那是依傳票排序的日記簿，
  沒有交易對象欄，要在 Excel 樞紐。）

**建議補法**　`trialBalance` 加選填 from/to（不帶維持現行累計以保住 Dashboard 的平衡檢查
與既有測試），回 `opening/periodDebit/periodCredit/closing` 並提供排除 `sourceType='closing'`
的選項；`exports.ts` 增 `trialBalanceExport / ledgerExport / incomeStatementExport /
balanceSheetExport`，`journalExport` 表頭加「來源類別／來源單號」；
`ledgerReport` 每行補 `counterpartCodes`（同傳票其他科目）與 `partnerName`
（由 `source_type/source_id` 反查），accountCode 支援多選或不傳（＝總分類帳）；
`Reports.tsx` 每張卡片加「下載 CSV」。

### R17. 手工傳票只能新增

> ✅ 大致已修（2026-08-10，migration 0025）：`POST /journal-entries/:id/void`（理由必填）
> 產生反向沖轉傳票（借貸互換、memo「作廢沖轉 #原單號」、reversal_entry_id 關聯雙向可查），
> 原單期間已關可帶 voidDate 以開放期間沖轉；系統拋轉的傳票 422 指路作廢來源單據；
> 反向沖轉傳票本身不可再被作廢（覆核修補 12167ff）。**尚缺**：零元空傳票 API 仍建得出、
> 未來日期仍放行、`/trial-balance` 仍無 asOf。

`PATCH/PUT/DELETE /journal-entries/:id`、`POST /journal-entries/:id/reverse` 全 404；
`journal_entries` 沒有 `reversal_of`／`reversed_by` 欄位，所以自己補的反向傳票在系統上看不出關係。
另外兩個小洞：`assertBalanced`（`posting.ts:13-22`）認為 0 === 0 平衡，
所以 API 建得出**金額為零的空傳票**（前端擋得住，`Journal.tsx:104` 送出鈕會 disabled）；
未來日期一律放行（`assertPeriodOpen` 只擋已關帳的過去），而 `/trial-balance` 沒有 asOf，
2030 年的傳票會直接算進今天的試算表（損益表與資產負債表則正確按日期過濾）。

**建議補法**　`reverseManualEntry()`＋`POST /journal-entries/:id/reverse`
（借貸互換、memo 指向原傳票、原傳票所屬期間已關則擋）；`createManualEntry` 加
「借方合計必須 > 0」；entryDate 晚於今天時回 warning。

### R18. 電子發票：合併月結發票做不到、有統編開成 B2C 不擋、查詢無篩選

> ✅ 其中第三項的「每筆都帶完整 XML」已修（2026-08-10，commit 975813b）：
> `GET /invoices` 改白名單挑欄位（不含 xml／cancelXml，補上載具／捐贈欄），
> 前端檢視／下載改走單張端點。合併開票、B2C 誤開不擋、篩選分頁仍未動；
> `POST /sales/:id/invoice` 的回應仍含整包 xml（單張、量小，刻意未動）。

- **合併開票**：`invoices.sale_id` 是 `notNull` 外鍵、`issueInvoice(db, saleId, input)`
  只吃一個 saleId，所以「同一客戶當月所有銷貨合開一張」在資料模型層就做不到
  （跟是不是同一張訂單無關）。`POST /invoices {saleIds:[…]}`、`/invoices/consolidate`
  全 404，`Sales.tsx:34-43` 也是逐列單張。一個月分 8 次送貨給超市，客戶會收到 8 張發票，
  字軌一次吃掉 8 個號。兩條替代（整月不出貨月底一次全出／月底手開總銷貨單）都要付代價：
  前者庫存與應收整月停在錯的數字且僅限單一訂單；後者總單掛不回訂單（`docInput` 無 orderId、
  無 `PATCH /sales/:id`），訂單會永遠停在 open、出貨紀錄消失。
- **有統編的公司客戶開成 B2C，不擋也不提醒**：`invoices.ts:97` 只有單向檢查
  （B2B 缺統編 422），反向完全沒有。`Sales.tsx:128-129` 兩顆按鈕並排、沒有預選也沒有二次確認，
  而**同一頁看不到這張單賣給誰**（見 R4）。手滑一下，買方公司就拿不到 5% 進項扣抵，
  要等對方發現、退回來作廢重開（該期已關帳就只剩折讓一途）。
  （對照組：`Expenses.tsx:71,79-81` 在進項那側已經做了完全同型的統編比對與可扣抵提示。）
- **查詢等於全部撈出來**：見 R3；額外的是每筆都帶完整 XML。

**建議補法**　合併開票需拆 `invoice_sales` 中介表或 `invoice_lines`
（不是只加一個端點，要先改 schema）；`issueInvoice` 在 `mode==="B2C" && partner.taxId`
時回 422 並要求前端帶 `confirmB2C: true`，前端依 `partner.taxId` 預設高亮或只顯示對應按鈕。

### R19. 401 沒有申報前檢核，也沒有申報後留痕

> ✅ 部分修復（2026-08-10，commit a6e6d85）：**申報後留痕已做**——`vat_returns` 表（期別／
> 各關鍵金額／期末留抵）＋存檔／查詢／刪除端點（鏈序把關：只能刪最新一期），
> 下一期的上期留抵自動承轉（同時解掉 B11(a)）。**尚缺**：申報前 preflight（未開發票的銷貨、
> 未登錄供應商發票的進貨等）、空白未使用發票 D 明細、期末營業稅沖轉傳票
> （2288 沖 1288——vat_returns 刻意不掛 journal_entry_id，見 migration 0024 檔頭）。

- **申報前**：`generate401` 只查 invoices 表，從不回頭看有沒有銷貨單沒開發票。
  實測 202605 期有兩張銷貨單合計 72,450，該期 401 的 `invoiceCount/outputSales/outputTax` 全是 0，
  媒體檔是 0 bytes，回應與畫面**沒有任何提示**（`returnsNotReflected` 全 0、`parameterNotes` 空）。
  總帳明明有 3,450 的銷項稅額。這與同一支 API 對退回折讓做的「不靜默產檔」紅色警示
  形成刺眼對比，而且方向更糟（那個讓稅多繳，這個讓稅少繳）。
  同類還有：**空白未使用發票（課稅別 D）不申報**——`media.ts:27,58` 定義並支援 `"D"`，
  但沒有任何呼叫端；148 個空白號碼在附件五完全不出現，也沒有任何揭露。
  （第 8 欄「使用發票份數」本來就不該含空白未使用，那部分是提出者誤解；
  真正該補的是附件五的 D 明細，而起訖號碼在附件五版面上如何落位尚未從原文核對過。）
- **申報後**：沒有任何 `vat_*` 資料表（41 張表掃過）。「這期報過了沒／繳了多少／
  還有多少留抵可以抵」系統答不出來（單期算得出來，算完就丟，下一期不承接）。
  `1288` 與 `2288` 從開帳起累加、永不結轉，1287 留抵稅額零筆分錄；
  月結檢查也沒有任何一項與營業稅有關。
  `docs/specs/chart-of-accounts.md:347` 已把它列為**已知缺口第 4 條**
  （「期末營業稅沖轉沒有自動化…尚未納入關帳流程」）。

**建議補法**　`generate401` 回一組 `preflight`：本期已入帳但未開發票的銷貨（張數／金額／單號）、
未登錄供應商發票的進貨單、缺統編的交易對象、字軌是否足夠；
Vat 頁在產檔按鈕上方以清單呈現，有問題就要求逐項確認。
新增 `vat_returns` 表（期別／產檔時間／各關鍵金額／應實繳／累積留抵／繳款日期與金額）＋
`POST /vat-returns/401/file` 存檔並自動拋轉結轉傳票（2288 沖 1288，差額入 2281 或 1287），
下一期的 `prevCarryForward` 直接讀上一期存檔值（同時解掉 B11(a)）。
附件五補 D 記錄與相應揭露（起訖號碼落位需先查證原文）。

### R20. 進項憑證的期間歸屬用「進貨單日期」而非供應商發票日期

> ✅ 已修（2026-08-10，commit 975813b，migration 0029）：`purchases` 補 `inv_date`
> （登錄供應商發票時一併填），401 期間篩選與媒體檔年月改吃發票日期；無值退回進貨單日期
> 並以 `inputDateFallback` 在回應出聲；補登的關帳鎖改鎖「歸期那幾期」；前端登錄列補
> 日期輸入與未登錄警示。
>
> ✅ **原「尚缺」的 purchasesExport 已補（2026-08-10，commit 9241d71）**：進項發票 CSV 加
> 「發票日期」欄，期間篩選改吃 `coalesce(inv_date, doc_date)`——與 401 歸期同一口徑。

`purchases` 表沒有任何供應商發票日期欄位（送 `invoiceDate` 靜默丟棄），
`vat.ts:105-107,151-152` 的期間篩選與媒體檔年月都用 `docDate`。
發票開 6/30、貨 7/2 才到並入帳 → 系統報成 115/07，賣方申報的是 115/06，
買賣雙方勾稽不符。反向：供應商 9 月才把 6 月的發票寄來，系統無法把它報進當期
——而且 `PATCH /purchases/:id/supplier-invoice` 沒有關帳鎖（見 B13），
所以它會**無聲改掉上一期已申報的數字**。連「改動 doc_date 換期別」這條爛路都不存在
（`PATCH/PUT /purchases/:id` 皆 404）。

> **報銷那條路做對了**：`expense_items` 有 `invoice_date`，`vat.ts:118-131,170-171`
> 用它篩期與產年月。實測 claimDate 2026-09-05 / invoiceDate 2026-06-30 的報銷單正確落在 202605。
> 也就是說「帳務日 ≠ 憑證日」的區分在本專案已有實作前例，只有進貨單這條路沒做。

**建議補法**　`purchases` 增 `inv_date`（登錄供應商發票時一併填），
媒體檔年月與期間篩選改用它（無值時退回 docDate 並在回應揭露）；
`Purchases.tsx` 的登錄發票列一併加日期輸入；同時補 `assertPeriodOpen`。

### R21. 權限：業務採購看不到合約，卻可以新增員工

> ✅ 部分修復（2026-08-10，commit 98018c1）：`/contracts` 拆讀寫——GET（含附件）開放
> sales/purchasing（ROLE_PAGES 補 contracts，到期橫幅輪得到最該看的人），寫入收斂
> admin/finance，前端對唯讀角色隱藏表單與狀態按鈕；`/employees` 寫入自 masters 頁拆出
> 限 admin/finance，Masters 對其餘角色只留唯讀清單。尚缺：自助改密碼
> （`POST /auth/password`）與 employee 角色的「我的帳號」頁。

- **合約**：`auth.ts:385` 把 `/contracts` 掛在 contracts 頁，`ROLE_PAGES` 只給 admin/gm/finance。
  實測 sales 與 purchasing 對 GET/POST/PATCH/附件下載全部 403，前端連導覽列都看不到那一頁。
  合約是業務談下來的、採購是跟供應商簽的，卻只有財務和老闆看得到。
  到期提醒又只是 `Contracts.tsx:94-97` 的畫面橫幅（前端自己算），
  最該收到提醒的人永遠收不到。auth.ts 對別的角色決定都有寫理由
  （ar-aging 刻意掛 sales 頁「業務要催款」等），唯獨這條沒有任何說明。
- **員工主檔**：`/employees` 掛在 masters 頁，而 masters 開給 sales 與 purchasing
  （`roles.ts:54-55`）。業務為了建客戶進「客戶與商品」頁，順手就能新增員工，
  而且建了之後（見 B3）任何人都刪不掉、停不了、改不了，同名還可無限增生。
- **沒有自助改密碼**：`/auth/password`、`/auth/change-password` 全 404，
  `/users` 是 admin 限定，所以除了 admin 以外沒有人能改自己的密碼
  （finance 與 employee 對自己的 id 送 PATCH 都是 403）。
  上線時管理者替每個人設一組初始密碼，員工永遠改不掉；要改只能拜託管理者重設，
  而重設會立即把該使用者登出。（TOTP 反而是刻意做成自助的，
  `app.ts:449-452` 註解明寫「一律只能設定自己的，路徑上沒有 userId 這個參數」
  ——同樣的路由形狀已經存在，密碼只是漏掉。）

**建議補法**　`/contracts` 拆讀寫兩條規則：GET 開放給 sales/purchasing（寫入維持 admin/finance），
`ROLE_PAGES` 對應補 contracts，docs/api.md 同步；
`/employees` 的寫入從 masters 頁拆出來，改用 finance/admin 專屬規則，
`Masters.tsx:178-201` 對 sales/purchasing 隱藏新增表單只留唯讀清單；
新增 `POST /auth/password {currentPassword, newPassword}`（照 `/auth/totp/disable` 的形狀，
成功後保留當前 session、踢掉其他 session），Settings 頁加「修改我的密碼」卡片，
並讓 employee 角色看得到一個最小化的「我的帳號」頁。

---

## 三、內容缺口——欄位與選項夠不夠一家真公司用

這一節單獨列，因為「模組有了但欄位太少」是這輪最普遍的問題。
以下每一格都經實測（送進去回 201 但被 zod 靜默丟棄，或資料表根本沒有該欄位）。

### 3.1 交易對象（客戶／供應商）

> ✅ 部分修復（2026-08-10，commit 7b96c48）：聯絡人／電話／Email、地址／送貨地址、
> 付款條件（天數）、信用額度、業務負責人已補。尚缺：發票寄送信箱獨立欄位
> （先以單一 email 涵蓋）、預設載具／常用捐贈碼、active。

現有：`name / tax_id / is_customer / is_supplier / is_individual / id_no`。

| 缺的欄位 | 誰要用 | 沒有的後果 |
|---|---|---|
| 聯絡人、電話、Email | 業務、財務 | 催收找不到人；另開 Excel |
| 發票寄送信箱 | 財務 | 電子發票寄不出去 |
| 地址、送貨地址 | 倉庫、扣繳 | 出貨單印不出送貨地址；扣繳憑單的受領人地址填不出來 |
| 付款條件（天數） | 財務 | 帳齡以出貨日分桶，逾期定義全公司硬寫 30 天（B1） |
| 信用額度 | 業務主管 | 賒銷零控管 |
| 業務負責人 | 老闆 | 分業績、算獎金、客戶找承辦人都做不到（單據層有 createdBy，客戶層沒有） |
| 預設載具／常用捐贈碼 | 開票 | B2C 熟客每次重問手抄 |
| active（停用） | 全部 | 倒閉客戶清不掉（可用取消角色旗標代替，但畫面沒開口，見「刻意不做」） |

### 3.2 商品

> ✅ 部分修復（2026-08-10，commit 7b96c48）：標準售價、分類、is_service、安全庫存（min_stock）
> 已補。尚缺：課稅別（B12）、條碼、active、客戶專屬價／價目表、進價歷史與供應商比價。

現有：`sku / name / unit`。

| 缺的欄位 | 沒有的後果 |
|---|---|
| 標準售價（list_price） | 每張單每一行手打單價；沒有「賣低於底價」檢核 |
| 分類 category | 銷售分析只能逐項看，做不出品類報表 |
| is_service / track_inventory | 運費、安裝費、顧問費開不了單（B2） |
| 課稅別（應稅／零稅率／免稅） | 外銷做不到（B12） |
| 安全庫存 / 再訂購點 | 沒有缺料警示——這是中小企業導入 ERP 最想要的功能之一 |
| 條碼 barcode | 無法掃碼 |
| active | 停產品清不掉 |

另缺客戶專屬價（大盤／零售不同價）與價目表：`/price-lists`、`/product-prices` 全 404，
`products` 之外沒有任何價格資料表（全庫的 `unit_price` 都掛在單據明細上）。
也沒有進價歷史查詢（`GET /products/:id/purchase-history` 404）與供應商比價
——「同一項冷凍薯條，日昇報 185、豐原報 178」只能寫在 memo 或另開 Excel。

### 3.3 員工

> ✅ 部分修復（2026-08-10，commit 7b96c48）：title／phone／email／hire_date／note 已補，
> 且可 PATCH（含停用）。尚缺：emp_no（unique）／department／resign_date／銀行帳號；
> 部門維度整套仍不存在（見 3.8）。

現有：`name / active`。缺 `emp_no`（unique）、`department`、`title`、`hire_date`、
`resign_date`、`email`、銀行帳號。
> 注意：即使補了 `department`，也做不出部門別費用分析——**整套系統沒有任何部門維度**
> （傳票、報銷單、報表都沒有；全 repo 搜 `department` 只有 `chart.ts:227` 的一句提示文字）。
> 那是另一個更大的缺口，見 3.8。

### 3.4 合約

現有：`partner_id / counterparty / title / amount / sign_date / start_date / end_date /
status / memo / file_name / file_data`。

| 缺的 | 後果 |
|---|---|
| 合約編號（contract_no） | 公司內部講的是 C-2026-001，不是資料庫的 #7 |
| ~~類別（sales/purchase/lease/service）~~ | ✅ 0037 補 kind（營收型態）＋0046 補 direction（sale/purchase 方向，與 kind 正交）；進貨側分期＝勾對進貨單（match），銷貨側＝開單（bill），清單可篩方向 |
| 我方負責人、我方簽署人、對方簽署人 | 沒人被提醒續約 |
| 幣別（currency） | demo 已有一家新加坡客戶；外幣合約會直接記成台幣（amount 是純整數） |
| 付款條件 | 只能塞 memo |
| 終止日期、終止原因、結案日期 | 「什麼時候終止、為什麼」是日後爭議最關鍵的兩件事，現在只能塞 memo 自由文字——**而畫面上連 memo 都塞不進去**（清單沒有編輯入口，唯一的 PATCH 只送 status） |
| auto_renew / notice_days / renewed_from_contract_id | 沒有續約鏈；`POST /contracts/:id/renew` 404 |
| 多份附件 | 只有單一組 file_name/file_data，正本掃描＋增補協議＋回簽頁放不下；**建立時沒帶就永遠補不上**（PATCH 帶 fileData 時：只送它 → 500；配一個合法欄位一起送 → **200 但附件靜默遺失**）；也沒有 DELETE 可以重建 |

合約還有兩個非欄位的缺口：
- **狀態機零約束**：terminated → active、ended → draft 都回 200，demo 已終止的合約可直接復活。
  而畫面上 terminated/ended 的列**一顆按鈕都沒有**——誤點「終止」後在 UI 上不可逆，
  且 `setStatus` 沒有二次確認。
- **與交易零連結**：`GET /contracts/:id/progress` 404；`sales/purchases/orders` 都沒有
  `contract_id`（全 schema 搜零命中）。demo 的「年度供貨合約 3,600,000」無法回答
  「已出貨多少、還剩多少額度、有沒有超約」。合約在這套系統裡只是一份可下載的 PDF 加幾個欄位，
  跟帳完全分離——**合約管理的主要價值（履約追蹤）不存在**。
- **到期提醒只活在前端**：`EXPIRY_SOON_DAYS = 45` 寫在 `Contracts.tsx:13`，
  `GET /contracts/expiring` 404、`?expiringWithinDays=90` 被忽略，
  dashboard 與 `services/dashboard.ts` 搜「contract」零結果。唯一會提醒的地方是
  「有人剛好點開合約頁」，而那頁只有 admin/gm/finance 進得去（R21）。

### 3.5 報價單與訂單

| 缺的 | 後果 |
|---|---|
| 有效期限 validUntil | 「本報價有效期 30 天」是台灣報價單的標準行 |
| 交期 deliveryDate | 訂單與採購單都沒有；`.flightwake/records/260727-sales-pipeline.md:35` 與 `260727-purchase-dashboard.md:34` 都已登記為待辦，且註明「兩邊一起加」 |
| 付款條件、條款（多行 terms） | 只有一個單行 memo 輸入框（API 端 memo 是 text 可放長文，畫面是 `<input>` 打不出換行） |
| 明細的 description / note | 送了靜默丟棄 |
| 折扣（listPrice + discountBp 或 discountAmount） | 量價、季末回饋、尾數抹零全部只能自己算好實收價打進去；負數行被 `unitPrice.nonnegative()` 擋（400）。議價過程在系統裡沒有痕跡，老闆事後查不到誰給了多少折扣。（MIG XML 的 `DiscountAmount` 欄位已存在但沒有任何服務層餵值） |
| 業務員 salespersonId | 只有 `createdBy`（使用者 id，記的是「誰打字」不是業務歸屬），而業務角色連 `/users` 都 403，那個 3 在畫面上永遠翻不成「黃志偉」 |
| 失單原因 lostReason | `POST /quotes/:id/lost` 收了 `reason` 但不落地。老闆問「這個月丟了幾張、為什麼丟」，系統只能回答「丟了 8 張」。價格輸了／交期趕不上／客戶取消，對策完全不同——這是報價模組唯一能產出的管理資訊 |
| 採購單預計到貨日 expectedDate | 下了單就沒有交期可追；3 月下的單到 8 月沒到貨只是一列 `status=open`。對照：應收端已經有 `overdueAr` 的概念 |

> ✅ **其中交期已修（2026-08-10，第四批，commit 45b8c7b，migration 0035）**：
> quotes/orders 補 `expected_date`（預計交期）、purchase_orders 補 `expected_date`
> （預計到貨日），NULL＝未約定；轉訂單原樣帶入。表單與清單顯示，訂單/採購單清單
> 「今天 > 交期且未結」標紅（只標色，刻意不做自動提醒排程）。
> 同 commit 補**訂單確認單列印**（B5 尾款）：品項、金額、交期、付款條件、簽回欄。
> 其餘（validUntil／多行條款／折扣／業務員／失單原因／docNo）仍未動。

**單據編號**：所有單據都沒有 `docNo`（全 repo 搜 `docNo|doc_no` 零命中），
畫面上印的是資料庫流水號 `#3`。而且不只畫面——**總帳傳票摘要就是 `#id`**
（`documents.ts:232` 寫死 `銷貨單 #${doc!.id}`），**交給記帳士的 CSV 也是裸 id**
（`進貨單號,日期,…` 下一行是 `1,2026-08-01,…`）。客戶手上的紙本對不起來，
會計事後翻傳票也沒有第二條線索。
（好消息：發票號碼是正確的 `KZ10000000`；流水號在日常操作下也不會跳號——
超賣與非客戶檢查都在 INSERT 之前，交易不會吃掉 sequence。）

### 3.6 費用報銷分類

`GET /expense-categories` 只有 11 類，且寫死在 `packages/core/src/chart.ts:224` 的常數裡
（沒有 `POST /expense-categories`）：
6112 員工伙食、6115 員工福利、6131 交通與差旅、6132 電話與網路、6133 文具與辦公用品、
6135 水電瓦斯、6136 保險、6137 餐飲與交際、6138 修繕維護、6139 廣告行銷、6188 其他。

送其他科目一律 422（實測 6111 薪資、6113 勞健保、6126 資訊服務費、自建 6199 全部
「報銷分類不存在」）。**一家食品貿易公司常見的缺了一半**：停車費與過路費、快遞與貨運、
訓練進修與研討會、書報雜誌與軟體雲端訂閱（SaaS 只能塞 6132 郵電費或 6188）、
規費與公會會費、樣品與試吃品。全部只能進「6188 其他」，會計每個月要把「其他」拆開逐筆重分類
——正是這套系統應該省掉的工。
> `docs/specs/chart-of-accounts.md:351`（缺口 6）已把「6126 等是否開放報銷」列為待決。

**建議**：若堅持分類清單留在程式裡，至少補齊上述六類並在 `chart.ts` 補對應 6xxx 科目；
或改成「清單仍是程式常數，但允許使用者啟用／停用某分類」，
並允許自建的 `accounts.type === 'expense'` 科目掛進報銷（不再需要白名單）。

### 3.7 固定資產類別

`packages/core/src/assets.ts:18-24` 硬編碼只有五種：
computer(3 年) / office(5) / machine(7) / vehicle(5) / misc(5)，沒有 `POST /asset-categories`。
傳 land / building / intangible / software / improvement 一律 422。

食品貿易公司買店面或倉庫（房屋建築物耐用 35~50 年）、買 ERP 或設計軟體
（電腦軟體屬無形資產、走不同科目）、承租店面做裝潢（租賃改良應按租期攤提）都很常見，
現在只能硬塞 misc 5 年，年限與科目都不符耐用年數表，記帳士年度調整時要整批重算。

資產本身也缺：保管人（可 FK employees）、存放地點、序號、供應商、取得發票號碼、使用部門。
年度盤點要按地點清點、失竊理賠要提序號與發票，現在全部只能塞單一 memo，無法排序也無法篩選。

另外兩件相關的：
- **8 萬元以下小額資產一次列費用**的慣例，系統完全不提示：7,000 元的印表機照樣排 60 期折舊、
  每月提 97 元。`createAsset` 沒有任何金額門檻檢查。系統其他地方（進貨／銷貨的 `taxNotes`）
  已有「把稅務判斷講出來」的慣例，這裡沒接上。門檻金額應放進 `tax_parameters` 而非硬編碼。
- **查不到任何折舊明細**：`GET /depreciations`、`/fixed-assets/:id`、`/reports/depreciation`
  全 404。營所稅結算申報要附「固定資產及折舊明細表」；期中想查「這台車今年提了多少」
  也沒地方看，只能去傳票頁用 memo 字串人工過濾拼湊。
  > ✅ **折舊明細表已補（2026-08-10，第四批，commit 45b8c7b）**：
  > `GET /reports/depreciation-schedule?year=`——各資產的期初累折＋本年度折舊＝期末累折、
  > 帳面淨值（取自已入帳的 asset_depreciations，漏提的月份看得出來少）；`format=csv`
  > 同一條路由回 ExportFile 形狀供下載。前端掛報表頁（表格＋CSV）。
  > 各資產「逐期折舊×傳票號」的單筆明細（`/fixed-assets/:id`）仍未做。

**建議**：把 `ASSET_CATEGORIES` 搬進資料庫（key/label/years/asset_code/accum_code，
migration 帶預設值），開 `POST/PATCH /asset-categories`；內建至少補「房屋建築物」
「租賃權益改良」「電腦軟體（無形資產）」三類，並允許類別層級標記「不提折舊」（土地）。
補 `GET /fixed-assets/:id`（含各期折舊與傳票號）與 `GET /reports/depreciation?year=`
（各資產 × 各月矩陣＋年度合計），並掛進 `exports.ts`。

### 3.8 報表維度與版面

- **沒有部門／專案／成本中心維度**：對 40 張表與所有 migration 搜
  `department|project|cost_center|branch|segment` **零命中**；`journal_lines` 只有
  `entryId/accountId/debit/credit`，手工傳票每行只收 `accountCode/debit/credit`，
  報表端點也沒有任何維度篩選。「北區業務跟南區業務誰賺錢」「這檔展店專案花了多少」
  只能靠開一堆平行科目（6121-北、6121-南）土法煉鋼，科目表會爆炸且做不了跨科目彙總。
  這是市售 ERP 的標配。
- **損益表沒有分類小計**：`revenue`／`expense` 是平的科目陣列
  （5101 銷貨成本與 6121 租金支出並列在同一個 expense 清單），沒有營業毛利／營業利益／
  營業外收支／稅前淨利。**資產負債表沒有流動／非流動分類**（1101→1439 一條平面清單）。
  銀行看的是毛利率與流動比率，兩者都要靠分類小計才算得出來。
- **沒有比較期間**：`?compare=prev`、`?compareAsOf=` 被忽略。老闆看的是「這個月比上個月／
  去年同期好不好」，現在得抄兩次報表用 Excel 減。
- **沒有公司抬頭**：兩張表的回應都沒有 `company` 欄位，列印出來不是一張能交出去的財務報表。
- **現金流量表只有直接法三大類總額＋逐筆流水**，沒有間接法（本期損益 → 加回折舊 →
  調整應收應付 → 營業活動淨現金流），也沒有分項小計（銷貨收現／支付供應商／支付薪資／支付稅款）。
  銀行融資與會計師查核要的是間接法。逐筆明細在交易量大時會變成幾千列無法閱讀。
  （好消息：期末現金與資產負債表現金合計完全相符。）

### 3.9 其他下拉與選項

- **扣繳補充保費沒有門檻與單次上限欄位**：`withholding_categories` 只有一個費率。
  付 20 位接案者各 3,000 元，會計得手動把 40 個試算欄位改成 0，改漏一個就是替對方多扣錢還要退。
  依專案「不斷言」的紀律，正確做法不是內建門檻，而是**給一個讓使用者把自己查到的門檻填進來的欄位**
  （`tax_threshold / supplement_threshold / supplement_cap`，皆允許 NULL＝未設定，
  `source_note` 註明依據），`resolveAmounts` 在低於門檻時預設 0 並在 notes 說明。
- **扣繳彙總沒有月份維度**：租金類憑單要填所得所屬期間（起訖月份），
  一整年不是每個月都有給付時，起訖只能靠人翻清單自己看，而那張清單沒有任何篩選。
  建議 `paymentSummary` 每組加 `firstPayDate / lastPayDate / byMonth`。
- **沒有任何地方能記錄申報／繳納期限**：`tax_parameters` 只支援級距（brackets）與布林
  （boolValue），送 `kind:"withholding_deadline"` 回 422「這一列沒有值」。
  「系統不斷言期限」是對的紀律（見第四節），但目前的做法是**連使用者自己查到的期限也無處可放**
  ——稅率走的是「你查證後填進來、寫明依據」，期限卻連欄位都沒有，同一套紀律只做了一半。
  建議加一種 `kind='deadline'` 的參數型別（值為使用者自填文字＋可選的「每月第幾日」結構），
  再接上 dashboard 的提醒卡，文案標明是使用者自己填的。
- **營業稅率那列參數自稱「不是查證結果」，卻沒有任何地方提醒新公司去確認**：
  新裝系統 `GET /tax-parameters` 只有一列，`enteredBy=null`、
  `sourceNote="此列是既有行為的遷移…不是本專案的查證結果；請確認後補上你的依據來源。"`
  Dashboard 全檔沒有任何 `/tax-parameters` 引用，清單五步也不含它，
  而每一張銷貨、進貨、發票都直接吃這個 5%。等於新公司預設帶著一個沒有人簽名的稅率在開發票。
  建議 Dashboard 清單補一步「確認營業稅率」（done：存在 kind=vat 且 enteredBy 非 null 的列），
  TaxParameters 頁對 `enteredBy=null` 的列標「系統預設值，尚未由貴公司確認」。
- **沒有多倉／儲位**：`/warehouses`、`/locations` 404，`inventory_movements` 沒有
  `warehouse_id`，`GET /inventory` 每個商品只有一個總數。食品貿易至少會有常溫倉與冷凍倉，
  很多還有寄放在物流商或客戶端的寄倉（demo 資料裡就有「宏遠物流」這個供應商）。
  混成一個數字後，倉管不知道去哪裡揀貨，也無法對單一倉庫盤點。
  短期至少在 products 加 `storage_type`（常溫／冷藏／冷凍）供分組顯示。
- **沒有給非工程師的首次上線說明**：`README.md` 全篇開發者取向；
  `docs/deployment.md:18` 只有一句「首次進入會出現初始設定…之後在設定頁新增其他同事的帳號」，
  然後就跳到備份與 TOTP，完全沒提字軌、稅籍編號、稅法參數、庫存開帳、應收付開帳。
  上面每一條卡關（字軌 409、401 的 422、期初 6,000 差額）都是因為沒有人告訴使用者順序。
  建議新增 `docs/getting-started.md`（繁中，給老闆／會計看）：
  公司基本檔含稅籍 → 確認營業稅率 → 字軌 → 科目確認 → 員工主檔與帳號 →
  庫存開帳＋期初傳票 → 應收付開帳 → 第一張進貨／銷貨／發票 → 月結，
  README 與 Login 首次設定畫面各放一個連結。

---

## 四、刻意不做的事——別再當成 bug 修一次

這一節的作用是保護既有的設計決定。以下每一項在這輪驗證中都被提出過、
都經查證後判定為**設計而非缺陷**，理由與出處如下。

| 項目 | 為什麼是設計 | 出處 |
|---|---|---|
| **系統不斷言任何稅率、免稅額度、申報期限、格式代號** | 使用者查證後填入並寫明依據來源；`tax_parameters` 是 append-only（改動＝新增一段生效期間，`supersedePrevious` 自動封上一段的 valid_to），PATCH/DELETE 一律 404 | `.flightwake/DECISIONS.md`（2026-08-01/02）、`docs/specs/tax-parameters.md` |
| **存貨成本用移動加權平均，主檔不放標準成本** | 成本由實際進貨推導（`inventory_movements.unitCost` → `avgUnitCost`），退貨沖回原單成本、進貨折讓 FIFO 消耗推定 | `.flightwake/DECISIONS.md:14-16`；缺的是**售價**不是成本 |
| **庫存開帳只建 movement、不拋轉傳票** | 與市售系統「期初庫存／期初科目餘額分開輸入」相同，避免發明權益調節科目 | `apps/api/src/services/ledger.ts:257-260`、`.flightwake/records/260722-ledger-batch.md:17`、`apps/api/test/ledger.test.ts:59` |
| **固定資產登錄不拋轉取得傳票** | 與庫存開帳同哲學 | `.flightwake/records/260727-fixed-assets.md:18` |
| **主檔沒有 DELETE，只有停用** | 科目一旦入帳就必須永遠查得到名稱，刪除會讓歷史傳票變孤兒；「不用了」＝停用 | `apps/api/src/app.ts:694-704`（accounts 段落註解） |
| **交易對象的停用＝取消 is_customer/is_supplier 旗標** | 六處伺服端硬擋（`documents.ts:59`、`orders.ts:39`、`purchase-orders.ts:25`、`ledger.ts:139`），停用後硬送 id 也開不出單，且歷史資料完好、可逆。缺的只是 Masters 頁的一顆切換鈕（＋停用會連帶擋掉該對象收付款，未結清前不能停用） | 實測 `POST /sales` → 422「非客戶: 倒閉客戶A」 |
| **`GET /partners/:id/id-no` 明文端點與 `DELETE .../id-no`** | 前者是扣繳憑單取數需要；後者是「改回法人、或使用者要求刪除自己的資料」的出口——因為掛著扣繳單就擋住刪除，個資刪除請求會無路可走 | `apps/api/src/app.ts:653-657` |
| **401／媒體檔的取數只認單據，不認手工傳票** | 銷項＝本系統開立之電子發票、進項＝已登錄供應商發票之進貨單與報銷明細。手工傳票改得動總帳、改不動申報，兩邊是刻意分離的 | `apps/api/src/services/vat.ts:37-41` 註解 |
| **退回折讓「不靜默產檔」** | 401 減項尚未實作，但系統會回 `returnsNotReflected` 並在 Vat 頁以紅字警示，理由寫得很清楚：「使用者會照著這張申報書繳稅，落差必須擺在他眼前」。**這是本專案的紀律範本**，其他缺口（未開發票的銷貨、空白未使用發票）應該比照辦理，而不是把警示拿掉 | `.flightwake/DECISIONS.md:21`、`docs/specs/vat-401-403.md` |
| **同一張銷貨單只能有一張有效發票** | 防重複開立；作廢後可重開，且作廢的號碼不回收（號碼連續性） | `docs/specs/einvoice-mig41.md:15`、`uq_invoices_sale_issued` |
| **已收貨的採購單不可 cancel（409）** | 背後已開出進貨單、入了庫存、拋了傳票，整張取消會與已入帳憑證衝突。**正確的補法是加「短交結案」，不是放寬 cancel** | `apps/api/test/purchase-orders.test.ts:105`、銷售端 `orders.ts:269` 同理 |
| **年度已結轉的期間不可重開（409）** | 有測試守著；正解是會計實務上的前期損益調整（在還開著的期間沖 3351），不是解除結轉 | `.flightwake/records/260727-period-close.md`、`apps/api/test/period-close.test.ts:154-156` |
| **稽核日誌不記 request body** | body 含密碼與身分證號，關鍵字過濾是「失敗開放」的設計。逃生口是路由自己主動填的 `note`（`c.set("auditNote")`）——目前沒有任何路由用它，該用的地方應該用（例如關帳重開的期間），而不是改成全記 | `packages/db/migrations/0018_audit_log.sql` 檔頭 |
| **清單不回附件內容** | 影像走單筆端點（`GET /expense-claims/:id`、`/contracts/:id/file`），避免 payload 過大 | `apps/api/src/services/expenses.ts:225` |
| **總經理（gm）全域唯讀** | 改派 gm 不能當作權限的替代方案（gm 開不了報價單） | `.flightwake/records/260727-auth-roles.md` |
| **TOTP 只能設定自己的（路徑上沒有 userId）** | 密碼的自助端點應該照這個形狀補，不是改成 admin 代設 | `apps/api/src/app.ts:449-452` |
| **票據（支票）管理緩議** | 使用者 2026-07-27 確認公司未使用支票。1141/2141 科目刻意先留位給日後的模組與手工傳票用 | `gap-analysis-2607.md:45`、`packages/core/src/chart.ts:133` |
| **薪資／勞健保延後到 Phase 5** | 明確的路線決定。但導入時必須明講「薪資請繼續用原本的方式，只有結果的傳票要自己補進來」，並提供一個可一鍵套用的薪資傳票範本（6111/6113/6114/2202/2211/2212 六行預填）。注意 `260729-accounts-and-401-fix.md:26` 的分界：「Phase 5 延後的是薪資計算模組，不是薪資會計科目」——同理，延後的是薪資計算，不是員工能不能停用 | `docs/ROADMAP.md:60-65`、`.flightwake/DECISIONS.md:37` |
| **報銷分類的可扣抵預設值由伺服端強制** | 6137 餐飲與交際預設不可扣抵，前端主張 `deductible:true` 會被擋回 false。這是對的，不要放寬 | `packages/core/src/chart.ts:233`、`apps/api/test/expenses-contracts.test.ts:108` |
| **下拉選單以角色旗標過濾** | `DocForm`／`CashDocs`／`Orders`／`Purchases` 都以 `isCustomer`/`isSupplier` 過濾，且伺服端同步硬擋 | 見上「交易對象停用」 |

---

## 五、建議動工順序

### 第一批：上線前必補（不補的話第一週就會停擺或算錯稅）

> ✅ **本批六項已於 2026-08-10 修復**：1 → 7b96c48、2 → 400a709、3 → 1428f25、
> 4 → a6e6d85（migration 0024）、5 → 7878024、6 → 22a4e0e；另有覆核修正＋對抗測試 9bec2f1。
> 各項留下的尾巴見對應章節（B1-B3／B5-B7／B10-B11／B13）標注的「尚缺」。

1. **主檔欄位＋更新端點**（B1 / B2 / B3 / 3.1-3.3）
   ——一次 migration 把 partners、products、employees 的欄位補齊，
   並補 `PATCH /products/:id`、`PATCH /employees/:id`、放寬 `PATCH /partners/:id`。
   附帶：`partners.tax_id` 的 partial unique index（R5）、products 的 `is_service` 旗標
   （解掉服務業與運費，B2）。
2. **期初導入**（B6）——期初應收付單＋庫存開帳的合計顯示與月結對帳檢查。
   不補這一項，既有公司根本搬不進來。
3. **字軌**（B7）——期別驗證、DELETE、409/500 轉正、Dashboard 清單補一步。
   改動小，但它是「照著指示做完卻開不出第一張發票」的直接原因。
4. **401 的三塊算錯稅**（B10 / B11(a)(c)）——進項憑證分類分流、上期留抵接線、
   申報人與委託欄位。這三項不補，產出的申報檔就不能送。
5. **關帳鎖補齊**（B13）——`issueInvoice`、`PATCH supplier-invoice`、
   前端 payClaim 的日期。三處各一行，防止已申報數字被無聲改掉。
6. **對外文件的最小集**（B5 的前兩項）——報價單／出貨單列印、電子發票 XML 批次匯出與單張下載。
   沒有這兩樣，銷售與申報都無法對外交付。

### 第二批：第一個月內

> ✅ **其中 7／8／9 已於 2026-08-10 修復**：7 → 732cfa4（migration 0025，
> 短交結案端點與收貨單價覆寫仍缺，見 B4「尚缺」）、8 → 0f582b2（0026；R9 庫存異動
> 明細帳未做）、9 → e567ea5（0027）。另同日完成原列第三批的 15（B12 零稅率，7861444）
> 與 23（G0401/G0501，5a1fd8e），以及 R 系列雜項五件（975813b，0029：R5 進項防重複、
> R20 進項歸期、/invoices 清單瘦身、字軌區間重疊、載具捐贈碼）＋覆核修正（12167ff）。
> 10-14 未動。
>
> ✅ **第三批（同日）收掉 7 的殘留與更多尾巴**：作廢層加固（懸空檢查／voidDate 順序，
> 8d92bb9）＋作廢入口蓋到退回折讓與期初單（5e339d7，0030）；7 的短交結案與收貨單價
> 覆寫（c14aeb5，0032）；B14／16（d1f9e62，0031）；ap-aging、進項 CSV 歸期、
> 報銷發票查重（R5 報銷側）、B7 尾款（9241d71，0033）＋覆核修正（02ced63）。
> 10-14 仍未動（其中 14 的訂單課稅別已由 0032 帶入，交期欄位仍缺）。
>
> ✅ **第四批（同日）**：餘額口徑統一（57a2ab7，R6＋returns 溢付修正）、處分發票登錄
> ＋R5 進貨側反向查報銷（cb68196，0034）、內容尾款四件（45b8c7b，0035：
> 交期欄位、訂單確認單列印、折舊明細表、R9 庫存異動明細帳——8 的 R9 殘留至此收掉）。
> 另同批：10 的 R3（九張清單篩選分頁）與 11 的 R2（共用日期驗證）＋清單 N+1（d202745）；
> 13 的 R11 全部（作廢／退回重送／自核擋／帳號查重）＋R12 前半（影像下載與 CSV 匯出）
> ＋R13（待付彙總與公司支付）與 R21 權限收緊（98018c1，0036）；
> 覆核 f889be0（五條二階組合鏈對抗實測全數成立，探針轉正式迴歸）。
> 10 的 R4、11 的 R1、12（R16）、13 的 PDF 與多附件、14 的其餘欄位仍未動。

7. **單據更正／作廢／結案**（B4）——優先序：扣繳單作廢（憑單會報錯外部人的所得）＞
   收付款作廢＞訂單／採購單短交結案＞合約 PATCH＞報銷沖銷＞手工傳票沖銷＞資產修改。
8. **庫存調整單**（B8）與**庫存異動明細帳**（R9）——每月報廢盤虧是常態。
9. **預收／預付**（B9）——`unappliedAccountCode` ＋預收沖銷的 allocation type。
10. **清單篩選與分頁**（R3）＋**銷貨/進貨列表顯示對象與品項**（R4）——
    照 `/audit-logs` 的樣板做，先做報銷與銷貨兩頁。
11. **輸入驗證與錯誤訊息**（R1 / R2）——共用的日期 zod schema、`idParam` 原則套到 query、
    23505 與 FK 轉 4xx。一次做完全部端點，成本低、感受強。
12. **報表匯出與試算表期間**（R16）——記帳士每個月要的東西。
13. **費用報銷的三件事**（R11 / R12 的 PDF 與附件）——自我核准把關、退回重送、PDF 收得下。
14. **內容補齊**：報銷分類（3.6）、資產類別（3.7）、報價單條款與交期欄位（3.5）、
    合約欄位與狀態機（3.4）。這些多半是純資料＋表單，可以與上面並行。

### 第三批：可以等（但要在文件裡講清楚現在做不到）

15. **零稅率與 403 兼營**（B12）——先做「擋下並說明」，完整實作等有實際外銷/兼營客戶。
    > ✅ **零稅率已修、兼營已做實擋下（2026-08-10，commit 7861444，migration 0028）**：
    > 詳見 B12 節標注；403 申報本體仍未做。
16. **固定資產處分的稅與發票**（B14(b)）＋折舊明細表（3.7）。
    > ✅ **前半已補（2026-08-10，commit d1f9e62，migration 0031）**：處分拆 2288 銷項稅額
    > ＋自動補提折舊＋PATCH/作廢，詳見 B14 節標注。
    > ✅ **處分發票登錄也已接（2026-08-10，第四批，migration 0034）**：invoices 來源泛化
    > （asset_id），處分可同交易開立發票、401 銷項自然涵蓋，詳見 B14 節標注。
    > ✅ **折舊明細表（3.7）也已補（同日第四批，commit 45b8c7b）**：
    > `GET /reports/depreciation-schedule?year=`＋CSV，詳見 3.7 節標注。
17. **銀行對帳**（R7 前半）——`.flightwake/STATE.md` 五步裡唯一沒動的一項。
18. **合約與交易的連結／履約追蹤**（3.4）、**續約與到期提醒 API**。
19. **部門／專案維度**（3.8）——影響採購決定，但要動 `journal_lines` schema，工程量大。
20. **多倉與儲位**（3.9）、**票據管理**（R7 後半，等有客戶用支票再做）。
21. **報表版面**（分類小計、比較期間、公司抬頭、間接法現金流量表）。
22. **合併月結發票**（R18）——需先改 invoice↔sale 的關聯模型。
23. **G0401/G0501 折讓證明單 XML**（B5）——repo 內已有官方範例可做 golden 測試，
    不需憑證；真正卡在憑證的只有傳輸與驗測。
    > ✅ **已補（2026-08-10，commit 5a1fd8e）**：兩個產生器＋四份官方範例 golden；
    > 銷貨折讓單（有證明單號碼＋日期）單張下載與批次匯出接線完成。G0501 的服務層
    > 接線等作廢層蓋到 sales_returns（0025 未含折讓單）。
    > ✅ **G0501 接線也已完成（2026-08-10，commit 5e339d7，migration 0030）**：
    > 折讓單有作廢入口後，單張下載與批次匯出同期帶 G0401＋G0501，詳見 B5 節標注。

### 貫穿全程的一件事

補 `docs/getting-started.md`（3.9 最後一項）。這輪十條流程裡，
至少有五個「卡住」是因為使用者不知道正確順序，而不是因為功能不存在。
一份兩頁的繁中上線順序清單，成本最低、擋掉的痛最多。
