/**
 * API 錯誤訊息英文字典入口：key ＝ AppError 的中文原句（含 {x} 佔位）。
 * **每個來源檔一份字典**放在 `en/`（services/ledger.ts → en/ledger.ts；app.ts → en/app.ts）。
 * 缺的 key 回中文。孤兒／未翻 key 用 `node scripts/i18n-scan.mjs` 查。
 */
import type { Dictionary } from "@tw-erp/core";
import { app } from "./en/app.ts";
import { hrLeave } from "./en/hr-leave.ts";
import { ledger } from "./en/ledger.ts";
import { voidSvc } from "./en/void.ts";
import { returns } from "./en/returns.ts";
import { recurringPayables } from "./en/recurring-payables.ts";
import { expenses } from "./en/expenses.ts";
import { invoices } from "./en/invoices.ts";
import { documents } from "./en/documents.ts";
import { contracts } from "./en/contracts.ts";
import { orders } from "./en/orders.ts";
import { payroll } from "./en/payroll.ts";
import { assets } from "./en/assets.ts";
import { agentMemories } from "./en/agent-memories.ts";
import { purchaseOrders } from "./en/purchase-orders.ts";
import { auth } from "./en/auth.ts";
import { period } from "./en/period.ts";
import { withholding } from "./en/withholding.ts";
import { agentChat } from "./en/agent-chat.ts";
import { inventoryAdjustments } from "./en/inventory-adjustments.ts";
import { attendance } from "./en/attendance.ts";
import { vat } from "./en/vat.ts";
import { allowanceXml } from "./en/allowance-xml.ts";
import { taxParameters } from "./en/tax-parameters.ts";
import { opening } from "./en/opening.ts";
import { apiKeys } from "./en/api-keys.ts";
import { agentSettings } from "./en/agent-settings.ts";
import { reports } from "./en/reports.ts";

export const en: Dictionary = {
  ...app,
  ...hrLeave,
  ...ledger,
  ...voidSvc,
  ...returns,
  ...recurringPayables,
  ...expenses,
  ...invoices,
  ...documents,
  ...contracts,
  ...orders,
  ...payroll,
  ...assets,
  ...agentMemories,
  ...purchaseOrders,
  ...auth,
  ...period,
  ...withholding,
  ...agentChat,
  ...inventoryAdjustments,
  ...attendance,
  ...vat,
  ...allowanceXml,
  ...taxParameters,
  ...opening,
  ...apiKeys,
  ...agentSettings,
  ...reports,
};
