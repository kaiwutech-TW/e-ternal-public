import type { Dictionary } from "@tw-erp/core";

/** WebMcp.tsx ＋ webmcp/tools.ts 的簽核卡字串 */
export const WebMcp: Dictionary = {
  "報價草稿（人機共編）": "Quote draft (co-edited)",
  "尚未送出": "Not submitted",
  "放棄草稿": "Discard draft",
  "未稅單價": "Unit price (untaxed)",
  "小計": "Subtotal",
  "刪除此行": "Remove line",
  "未稅合計": "Subtotal (untaxed)",
  "元（稅額送出時由系統計算）": "TWD (tax computed by the system at submission)",
  "送出走 agent 的 submit_draft → 簽核卡；或繼續口頭請 agent 修改":
    "Submitting goes through the agent's submit_draft → approval card; or keep asking the agent to edit",
  "需要你的核准": "Your approval is needed",
  "要建立這張報價單嗎？": "Create this quote?",
  "明細筆數": "Lines",
  // 「稅額」共用 common.ts 的 "VAT"——營業稅語境比泛稱 Tax 準確
  "由系統於建立時計算": "computed by the system at creation",
  "核准建立": "Approve & create",
  "agent 只能起草——沒有這顆按鈕，任何資料都進不了帳。":
    "The agent can only draft — without this button, nothing enters the books.",
  "Agent 活動": "Agent activity",
  "此瀏覽器不支援 WebMCP": "This browser has no WebMCP support",
  "等待 agent 連線——工具已依你的角色註冊完成。":
    "Waiting for an agent — tools are registered for your role.",
};
