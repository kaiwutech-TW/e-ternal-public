import type { Dictionary } from "@tw-erp/core";

export const agentMemories: Dictionary = {
  "記憶代號須為 kebab-case 英數（2-64 字，如 saturday-is-restday），收到「{raw}」": "Memory name must be kebab-case alphanumeric (2–64 characters, e.g. saturday-is-restday); received \"{raw}\"",
  "記憶必須有一行摘要（title）——索引只放摘要，寫得好壞決定助理找不找得到": "A memory needs a one-line summary (title) — only the summary is indexed, so it determines whether the assistant can find it.",
  "記憶內容（body）不可為空": "Memory content (body) cannot be empty",
  "到期日格式須為 YYYY-MM-DD（收到「{raw}」）": "Expiry date must be in YYYY-MM-DD format (received \"{raw}\")",
  "記憶代號已存在: {name}（要修改內容請編輯既有那一條）": "Memory name already exists: {name} (edit the existing memory to change its content)",
  "記憶不存在: {id}": "Memory not found: {id}",
  "只有「待核准」的記憶可以核准（目前狀態: {status}）": "Only memories pending approval can be approved (current status: {status})",
  "只有「待核准」的記憶可以刪除；已生效的請用封存——狀態是歷史的一部分，不刪列": "Only memories pending approval can be deleted; archive active ones instead — status is part of the history and rows are not removed.",
};
