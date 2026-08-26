# tw-erp API 參考

> 本檔由 `apps/api/scripts/gen-api-docs.ts` 產生——改了路由或權限請重跑，勿手改。

## 認證

- 單埠部署時所有端點皆掛在 `/api` 前綴之下（例：`POST /api/auth/login`）。
- 認證採 session cookie（HttpOnly＋SameSite=Lax，https 請求另帶 Secure）：`POST /auth/login`
  （帳密）→ 後續請求自動帶 cookie；程式化存取請保存 `set-cookie` 回傳的 `sid` 並附於 `cookie` 標頭。
- 首次啟動（無任何使用者）以 `POST /auth/setup` 建立第一個管理者。
- 未登入一律 401；權限不足 403。角色權限為頁面級（見 packages/core/src/roles.ts）。
- 登入有節流：同一帳號 5 次／同一來源 30 次失敗（滑動視窗 15 分鐘）後回 **429**，
  自動癒合、不需人工解鎖。程式化存取請把 429 當成「稍後再試」而非憑證錯誤。
- 所有非 GET 請求（含被擋下的）都會寫進操作日誌；請求內容一律不記錄。

## 端點總覽（232 個）

| Method | Path | 可存取角色 |
|---|---|---|
| GET | `/accounts` | 任何已登入 |
| POST | `/accounts` | admin、finance |
| PATCH | `/accounts/:id` | admin、finance |
| GET | `/agent-memories` | admin |
| POST | `/agent-memories` | admin |
| DELETE | `/agent-memories/:id` | admin |
| PATCH | `/agent-memories/:id` | admin |
| POST | `/agent-memories/:id/approve` | admin |
| POST | `/agent-memories/:id/archive` | admin |
| GET | `/agent-memories/stats` | admin |
| GET | `/agent-settings` | admin |
| PUT | `/agent-settings` | admin |
| POST | `/agent/chat` | 任何已登入 |
| GET | `/api-keys` | admin |
| POST | `/api-keys` | admin |
| DELETE | `/api-keys/:id` | admin |
| GET | `/asset-categories` | admin、gm、finance |
| GET | `/attendance/my` | 任何已登入 |
| GET | `/attendance/my-balances` | 任何已登入 |
| POST | `/attendance/punch` | 任何已登入 |
| GET | `/attendance/punches` | admin、finance |
| GET | `/attendance/settings` | admin、finance |
| PUT | `/attendance/settings` | admin、finance |
| GET | `/attendance/summary` | admin、finance |
| GET | `/audit-logs` | admin |
| POST | `/auth/login` | 公開 |
| POST | `/auth/logout` | 任何已登入 |
| GET | `/auth/me` | 任何已登入 |
| POST | `/auth/setup` | 公開 |
| GET | `/auth/setup-status` | 公開 |
| GET | `/auth/totp` | 任何已登入 |
| POST | `/auth/totp/disable` | 任何已登入 |
| POST | `/auth/totp/enable` | 任何已登入 |
| POST | `/auth/totp/setup` | 任何已登入 |
| GET | `/calendar-days` | 任何已登入 |
| PUT | `/calendar-days` | admin、finance |
| DELETE | `/calendar-days/:day` | admin、finance |
| GET | `/cash-docs` | admin、finance |
| POST | `/cash-docs` | admin、finance |
| GET | `/cash-docs/:id` | admin、finance |
| POST | `/cash-docs/:id/apply-prepaid` | admin、finance |
| POST | `/cash-docs/:id/void` | admin、finance |
| GET | `/company-profile` | 任何已登入 |
| PUT | `/company-profile` | admin、finance |
| DELETE | `/company-profile/filer-id-no` | admin、finance |
| GET | `/company-profile/filer-id-no` | admin、finance |
| GET | `/contracts` | admin、gm、finance、sales、purchasing |
| POST | `/contracts` | admin、finance |
| PATCH | `/contracts/:id` | admin、finance |
| GET | `/contracts/:id/file` | admin、gm、finance、sales、purchasing |
| GET | `/contracts/:id/installments` | admin、gm、finance、sales、purchasing |
| POST | `/contracts/:id/installments` | admin、finance |
| DELETE | `/contracts/:id/installments/:iid` | admin、finance |
| PATCH | `/contracts/:id/installments/:iid` | admin、finance |
| POST | `/contracts/:id/installments/:iid/bill` | admin、finance |
| POST | `/contracts/:id/installments/:iid/match` | admin、finance |
| POST | `/contracts/:id/installments/:iid/unmatch` | admin、finance |
| POST | `/contracts/:id/installments/generate` | admin、finance |
| POST | `/contracts/:id/renew` | admin、finance |
| GET | `/contracts/billing-due` | admin、gm、finance、sales、purchasing |
| GET | `/contracts/expiring` | admin、gm、finance、sales、purchasing |
| GET | `/departments` | 任何已登入 |
| POST | `/departments` | admin、finance |
| PATCH | `/departments/:id` | admin、finance |
| POST | `/depreciations/run` | admin、finance |
| GET | `/employee-salaries` | admin、finance |
| POST | `/employee-salaries` | admin、finance |
| GET | `/employees` | 任何已登入 |
| POST | `/employees` | admin、finance |
| PATCH | `/employees/:id` | admin、finance |
| GET | `/expense-categories` | 任何已登入 |
| GET | `/expense-claims` | 任何已登入 |
| POST | `/expense-claims` | 任何已登入 |
| GET | `/expense-claims/:id` | 任何已登入 |
| PATCH | `/expense-claims/:id` | 任何已登入 |
| POST | `/expense-claims/:id/approve` | admin、finance |
| GET | `/expense-claims/:id/items/:itemId/image` | 任何已登入 |
| POST | `/expense-claims/:id/pay` | admin、finance |
| POST | `/expense-claims/:id/reject` | admin、finance |
| POST | `/expense-claims/:id/void` | admin、finance |
| GET | `/expense-claims/payable-summary` | 任何已登入 |
| GET | `/exports/einvoice-xml` | admin、finance |
| GET | `/exports/expense-claims` | admin、finance |
| GET | `/exports/journal` | admin、finance |
| GET | `/exports/purchases` | admin、finance |
| GET | `/exports/sales-invoices` | admin、finance |
| GET | `/fixed-assets` | admin、gm、finance |
| POST | `/fixed-assets` | admin、finance |
| PATCH | `/fixed-assets/:id` | admin、finance |
| POST | `/fixed-assets/:id/dispose` | admin、finance |
| GET | `/fixed-assets/:id/dispose-preview` | admin、gm、finance |
| POST | `/fixed-assets/:id/dispose/void` | admin、finance |
| POST | `/fixed-assets/:id/invoice` | admin、finance |
| POST | `/fixed-assets/:id/void` | admin、finance |
| GET | `/hr-requests` | admin、finance |
| POST | `/hr-requests` | 任何已登入 |
| POST | `/hr-requests/:id/approve` | 任何已登入 |
| POST | `/hr-requests/:id/cancel` | 任何已登入 |
| POST | `/hr-requests/:id/reject` | 任何已登入 |
| GET | `/hr-requests/my` | 任何已登入 |
| GET | `/hr-requests/pending-approvals` | 任何已登入 |
| GET | `/inventory` | admin、gm、finance、sales、purchasing |
| GET | `/inventory/adjustments` | admin、finance |
| POST | `/inventory/adjustments` | admin、finance |
| POST | `/inventory/adjustments/:id/void` | admin、finance |
| GET | `/inventory/movements` | admin、gm、finance、sales、purchasing |
| POST | `/inventory/opening` | admin、finance |
| GET | `/inventory/stocktake` | admin、finance |
| POST | `/inventory/stocktake` | admin、finance |
| GET | `/invoice-tracks` | admin、gm、finance |
| POST | `/invoice-tracks` | admin、finance |
| DELETE | `/invoice-tracks/:id` | admin、finance |
| GET | `/invoices` | admin、gm、finance |
| POST | `/invoices/:id/cancel` | admin、finance |
| GET | `/invoices/:id/cancel-xml` | admin、gm、finance |
| GET | `/invoices/:id/xml` | admin、gm、finance |
| GET | `/journal-entries` | admin、finance |
| POST | `/journal-entries` | admin、finance |
| GET | `/journal-entries/:id` | admin、finance |
| POST | `/journal-entries/:id/void` | admin、finance |
| GET | `/leave-balances` | admin、finance |
| POST | `/leave-balances` | admin、finance |
| GET | `/leave-types` | 任何已登入 |
| POST | `/leave-types` | admin、finance |
| PATCH | `/leave-types/:id` | admin、finance |
| GET | `/open-documents` | admin、finance |
| GET | `/opening-balances` | admin、finance |
| POST | `/opening-balances` | admin、finance |
| POST | `/opening-balances/:id/void` | admin、finance |
| GET | `/orders` | admin、gm、finance、sales |
| POST | `/orders` | admin、finance、sales |
| POST | `/orders/:id/cancel` | admin、finance、sales |
| POST | `/orders/:id/close` | admin、finance、sales |
| POST | `/orders/:id/ship` | admin、finance、sales |
| GET | `/overtime-rates` | admin、finance |
| POST | `/overtime-rates` | admin、finance |
| DELETE | `/overtime-rates/:id` | admin、finance |
| GET | `/partner-balances` | admin、gm、finance、sales |
| GET | `/partners` | 任何已登入 |
| POST | `/partners` | admin、finance、sales、purchasing |
| PATCH | `/partners/:id` | admin、finance、sales、purchasing |
| DELETE | `/partners/:id/id-no` | admin、finance |
| GET | `/partners/:id/id-no` | admin、finance |
| PATCH | `/payroll-items/:id` | admin、finance |
| GET | `/payroll-runs` | admin、finance |
| POST | `/payroll-runs` | admin、finance |
| GET | `/payroll-runs/:id` | admin、finance |
| POST | `/payroll-runs/:id/finalize` | admin、finance |
| POST | `/payroll-runs/:id/recalc` | admin、finance |
| GET | `/period-closes` | admin、gm、finance |
| POST | `/period-closes` | admin、finance |
| GET | `/period-closes/check` | admin、gm、finance |
| DELETE | `/period-closes/latest` | admin、finance |
| GET | `/products` | 任何已登入 |
| POST | `/products` | admin、finance、sales、purchasing |
| PATCH | `/products/:id` | admin、finance、sales、purchasing |
| GET | `/purchase-orders` | admin、gm、finance、purchasing |
| POST | `/purchase-orders` | admin、finance、purchasing |
| POST | `/purchase-orders/:id/cancel` | admin、finance、purchasing |
| POST | `/purchase-orders/:id/close` | admin、finance、purchasing |
| POST | `/purchase-orders/:id/receive` | admin、finance、purchasing |
| GET | `/purchase-returns` | admin、gm、finance、purchasing |
| PATCH | `/purchase-returns/:id` | admin、finance、purchasing |
| POST | `/purchase-returns/:id/void` | admin、finance |
| GET | `/purchases` | admin、gm、finance、purchasing |
| POST | `/purchases` | admin、finance、purchasing |
| GET | `/purchases/:id/returnable` | admin、gm、finance、purchasing |
| POST | `/purchases/:id/returns` | admin、finance、purchasing |
| PATCH | `/purchases/:id/supplier-invoice` | admin、finance、purchasing |
| POST | `/purchases/:id/void` | admin、finance |
| GET | `/quotes` | admin、gm、finance、sales |
| POST | `/quotes` | admin、finance、sales |
| POST | `/quotes/:id/convert` | admin、finance、sales |
| POST | `/quotes/:id/lost` | admin、finance、sales |
| POST | `/quotes/:id/void` | admin、finance |
| GET | `/recurring-payables` | admin、finance |
| POST | `/recurring-payables` | admin、finance |
| PATCH | `/recurring-payables/:id` | admin、finance |
| GET | `/recurring-payables/:id/items` | admin、finance |
| DELETE | `/recurring-payables/:id/items/:iid` | admin、finance |
| PATCH | `/recurring-payables/:id/items/:iid` | admin、finance |
| POST | `/recurring-payables/:id/items/:iid/settle` | admin、finance |
| POST | `/recurring-payables/:id/items/:iid/unsettle` | admin、finance |
| POST | `/recurring-payables/:id/items/generate` | admin、finance |
| GET | `/recurring-payables/due` | admin、finance |
| GET | `/reports/ap-aging` | admin、gm、finance、purchasing |
| GET | `/reports/ar-aging` | admin、gm、finance、sales |
| GET | `/reports/balance-sheet` | admin、gm、finance |
| GET | `/reports/cash-flow` | admin、gm、finance |
| GET | `/reports/dashboard` | admin、gm、finance |
| GET | `/reports/depreciation-schedule` | admin、gm、finance |
| GET | `/reports/income-statement` | admin、gm、finance |
| GET | `/reports/ledger` | admin、gm、finance |
| GET | `/sales` | admin、gm、finance、sales |
| POST | `/sales` | admin、finance、sales |
| GET | `/sales-returns` | admin、gm、finance、sales |
| PATCH | `/sales-returns/:id` | admin、finance、sales |
| GET | `/sales-returns/:id/g0401-xml` | admin、gm、finance、sales |
| GET | `/sales-returns/:id/g0501-xml` | admin、gm、finance、sales |
| POST | `/sales-returns/:id/void` | admin、finance |
| GET | `/sales/:id` | admin、gm、finance、sales |
| POST | `/sales/:id/invoice` | admin、finance |
| GET | `/sales/:id/returnable` | admin、gm、finance、sales |
| POST | `/sales/:id/returns` | admin、finance、sales |
| POST | `/sales/:id/void` | admin、finance |
| PATCH | `/sales/:id/zero-tax-cert` | admin、finance、sales |
| GET | `/schedules` | admin、finance |
| POST | `/schedules` | admin、finance |
| DELETE | `/schedules/:id` | admin、finance |
| GET | `/shifts` | 任何已登入 |
| POST | `/shifts` | admin、finance |
| PATCH | `/shifts/:id` | admin、finance |
| GET | `/tax-parameters` | admin、finance |
| POST | `/tax-parameters` | admin、finance |
| GET | `/trial-balance` | admin、gm、finance、sales、purchasing |
| GET | `/users` | admin |
| POST | `/users` | admin |
| PATCH | `/users/:id` | admin |
| GET | `/vat-returns/401` | admin、gm、finance |
| POST | `/vat-returns/401/file` | admin、finance |
| GET | `/vat-returns/401/filings` | admin、gm、finance |
| DELETE | `/vat-returns/401/filings/:period` | admin、finance |
| GET | `/withholding-categories` | admin、finance |
| POST | `/withholding-categories` | admin、finance |
| PATCH | `/withholding-categories/:id` | admin、finance |
| GET | `/withholding-payments` | admin、finance |
| POST | `/withholding-payments` | admin、finance |
| POST | `/withholding-payments/:id/void` | admin、finance |
| POST | `/withholding-payments/estimate` | admin、finance |
| GET | `/withholding-payments/summary` | admin、finance |
| GET | `/year-closes` | admin、gm、finance |
| POST | `/year-closes` | admin、finance |

## 慣例

- 金額一律整數新台幣元；日期 `YYYY-MM-DD`；期間 `YYYY-MM`。
- 寫入類端點會拋轉傳票者，於已關帳期間一律 409（月結關帳）。
- 錯誤格式：`{ "error": "訊息" }`，狀態碼 400/401/403/404/409/422。
- gm（總經理）角色對可見頁面一律唯讀（僅 GET）；報銷例外（可替自己送件）。
- 上表只反映**路徑層**的權限。唯一的 body 相依例外：`POST /sales/:id/returns` 與
  `POST /purchases/:id/returns` 帶 `settlement: "cash"` 時，另需「收付款（cash）」頁權限
  （退回單能直接貸／借記現金科目，否則等於繞過該頁的角色限制）；不帶則任何有原單頁權限的角色皆可。
