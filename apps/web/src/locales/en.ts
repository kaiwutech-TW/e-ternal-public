/**
 * 英文字典入口：key ＝ 中文原句（機制與理由見 packages/core/src/i18n.ts）。
 * **每個來源檔一份字典**放在 `en/`（pages/Expenses.tsx → en/Expenses.ts；跨頁共用放 en/common.ts），
 * 這樣多人／多 agent 平行翻譯不會改到同一個檔。同一句在兩份出現時後者覆蓋——請放 common。
 * 缺的 key 會 fallback 顯示中文。孤兒／未翻 key 用 `node scripts/i18n-scan.mjs` 查。
 */
import type { Dictionary } from "@tw-erp/core";
import { common } from "./en/common.ts";
import { Expenses } from "./en/Expenses.ts";
import { CategorySuggestions } from "./en/CategorySuggestions.ts";
import { einvoiceQr } from "./en/einvoiceQr.ts";
import { Settings } from "./en/Settings.ts";
import { Withholding } from "./en/Withholding.ts";
import { Login } from "./en/Login.ts";
import { Sales } from "./en/Sales.ts";
import { Dashboard } from "./en/Dashboard.ts";
import { Orders } from "./en/Orders.ts";
import { Hr } from "./en/Hr.ts";
import { Purchases } from "./en/Purchases.ts";
import { CashDocs } from "./en/CashDocs.ts";
import { Attendance } from "./en/Attendance.ts";
import { hrShared } from "./en/hrShared.ts";
import { TaxParameters } from "./en/TaxParameters.ts";
import { Assets } from "./en/Assets.ts";
import { Contracts } from "./en/Contracts.ts";
import { Masters } from "./en/Masters.ts";
import { Accounts } from "./en/Accounts.ts";
import { Vat } from "./en/Vat.ts";
import { Reports } from "./en/Reports.ts";
import { ReturnForm } from "./en/ReturnForm.ts";
import { Payroll } from "./en/Payroll.ts";
import { RecurringPayables } from "./en/RecurringPayables.ts";
import { Journal } from "./en/Journal.ts";
import { Invoices } from "./en/Invoices.ts";
import { DocForm } from "./en/DocForm.ts";
import { Exports } from "./en/Exports.ts";
import { App } from "./en/App.ts";
import { print } from "./en/print.ts";
import { ui } from "./en/ui.ts";
import { AgentChat } from "./en/AgentChat.ts";

export const en: Dictionary = {
  ...Expenses,
  ...CategorySuggestions,
  ...einvoiceQr,
  ...Settings,
  ...Withholding,
  ...Login,
  ...Sales,
  ...Dashboard,
  ...Orders,
  ...Hr,
  ...Purchases,
  ...CashDocs,
  ...Attendance,
  ...hrShared,
  ...TaxParameters,
  ...Assets,
  ...Contracts,
  ...Masters,
  ...Accounts,
  ...Vat,
  ...Reports,
  ...ReturnForm,
  ...Payroll,
  ...RecurringPayables,
  ...Journal,
  ...Invoices,
  ...DocForm,
  ...Exports,
  ...App,
  ...print,
  ...ui,
  ...AgentChat,
  ...common, // 最後：共用詞優先於各頁
};
