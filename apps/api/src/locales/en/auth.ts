import type { Dictionary } from "@tw-erp/core";

export const auth: Dictionary = {
  "登入失敗次數過多，請約 {waitMin} 分鐘後再試": "Too many failed sign-in attempts. Try again in about {waitMin} minute(s).",
  "帳號已停用": "This account has been deactivated.",
  "驗證碼不正確或已過期": "The verification code is incorrect or has expired.",
  "重新設定二階段驗證需要再輸入一次密碼": "Re-enter your password to reset two-factor authentication.",
  "尚未產生密鑰，請先重新開始設定": "No secret has been generated yet. Please restart the setup.",
  "驗證碼不正確。請確認手機時間是自動校時的——時鐘差超過一分鐘就會一直對不上": "Incorrect verification code. Make sure your phone's clock is set automatically — a drift of more than one minute will keep codes from matching.",
  "使用者不存在": "User not found.",
  "密碼不正確": "Incorrect password.",
  "系統已完成初始設定": "Initial setup has already been completed.",
};
