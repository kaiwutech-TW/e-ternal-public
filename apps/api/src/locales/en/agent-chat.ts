import type { Dictionary } from "@tw-erp/core";

export const agentChat: Dictionary = {
  "LLM 供應商回應錯誤（{status}）：{message}。請到「設定 → Agent 接入」檢查型號與金鑰": "LLM provider returned an error ({status}): {message}. Check the model and API key under Settings → Agent Integration.",
  "內建助理尚未啟用。請管理者到「設定 → Agent 接入」選供應商、填型號與金鑰並啟用": "The built-in assistant is not enabled. An admin needs to choose a provider, enter the model and API key, and enable it under Settings → Agent Integration.",
  "anthropic 需要 API 金鑰（設定 → Agent 接入）": "anthropic requires an API key (Settings → Agent Integration).",
  "google（Gemini API key）需要 API 金鑰（設定 → Agent 接入）": "google (Gemini API key) requires an API key (Settings → Agent Integration).",
  "vertex-ai 需要 Vertex AI express mode 的 API 金鑰（設定 → Agent 接入）。服務帳戶 OAuth 認證不支援": "vertex-ai requires a Vertex AI express mode API key (Settings → Agent Integration). Service-account OAuth is not supported.",
  "{provider} 需要在「設定 → Agent 接入」填 Base URL（OpenAI 相容端點）": "{provider} requires a Base URL (OpenAI-compatible endpoint) under Settings → Agent Integration.",
};
