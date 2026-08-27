import type { Dictionary } from "@tw-erp/core";

export const pii: Dictionary = {
  "這筆身分證號是加密儲存的，但目前的 PII_KEY 未設定，無法解密。請把當初加密時使用的 PII_KEY 設回環境變數後重啟（金鑰遺失則此欄位無法復原）。":
    "This National ID is stored encrypted, but PII_KEY is not set, so it cannot be decrypted. Restore the PII_KEY used at encryption time in the environment and restart (if the key is lost, this field cannot be recovered).",
  "身分證號解密失敗：目前的 PII_KEY 與這筆資料不是同一把金鑰。請確認環境變數是否被改過（換金鑰不會自動重新加密既有資料）。":
    "Failed to decrypt the National ID: the current PII_KEY is not the key this record was encrypted with. Check whether the environment variable was changed (rotating the key does not re-encrypt existing data).",
};
