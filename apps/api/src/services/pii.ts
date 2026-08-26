/**
 * 身分證號的欄位級加密（公網部署前的安全批次④）。
 *
 * 威脅模型講清楚，才知道這件事保護得了什麼、保護不了什麼：
 * - **擋得住**：資料庫傾印檔、備份檔、雲端磁碟快照被單獨取得。這是 PII 最常見的外洩路徑
 *   ——備份依 3-2-1 原則本來就會被複製到第二台機器或雲端硬碟，複製出去的那一份
 *   不再受本系統的權限守衛保護，而它裡面躺著全公司往來個人的身分證號。
 * - **擋不住**：整台主機被拿下（金鑰在同一台機器的環境變數裡），或有權限的帳號被盜用
 *   （那時系統會乖乖解密給他看）。後者靠的是操作日誌與最小權限，不是加密。
 *   把「擋不住的」寫出來，是為了不讓人以為加了密就沒事了。
 *
 * 設計取捨：
 * - **PII_KEY 未設定時照舊存明文，不擋下使用者**。內網部署（本專案目前的實際形狀）
 *   沒有這個威脅，強制要求金鑰只會讓升級變成一次故障。代價是「沒設就沒保護」，
 *   所以 server.ts 啟動時會印一行警告——沉默的降級才是真正的問題。
 * - **舊的明文列不需要資料搬遷**：密文帶 `pii1$` 前綴，讀取時看前綴決定要不要解密。
 *   沒有前綴＝這是加密上線前寫入的明文，照原樣回傳。下次那一列被寫入時自然變成密文。
 * - 前綴與明文不可能撞名：輸入驗證限制 idNo 最長 20 字元，而最短的合法密文
 *   （4 前綴＋1＋16 IV＋1＋28 內文）就已經 50 字元。
 * - 解密失敗一律**大聲失敗**（丟出可讀的錯誤），絕不退回 null 或空字串——
 *   「金鑰換了」與「這個人沒填身分證號」在畫面上長得一模一樣，而處置方式完全相反。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { AppError } from "../db.ts";

const PREFIX = "pii1";
/** scrypt 的固定 salt：這裡只有一把金鑰，salt 的作用（讓同密碼產生不同雜湊）用不上 */
const KDF_SALT = "tw-erp-pii-v1";

/** scrypt 要幾十毫秒，而每次讀寫都會用到——同一個 PII_KEY 只推導一次 */
let cached: { secret: string; key: Buffer } | null = null;

function currentKey(): Buffer | null {
  const secret = process.env["PII_KEY"];
  if (!secret) return null;
  // 經過 KDF，所以 PII_KEY 給隨機字串或給人記得住的通行語都吃得下
  // （建議 `openssl rand -base64 32`；通行語的強度就是這把金鑰的強度）
  if (cached?.secret !== secret) cached = { secret, key: scryptSync(secret, KDF_SALT, 32) };
  return cached.key;
}

export function isEncryptedPii(value: string): boolean {
  return value.startsWith(`${PREFIX}$`);
}

/** 寫入時呼叫。沒設金鑰＝原樣存明文（見檔頭的取捨說明） */
export function encryptPii(plain: string | null | undefined): string | null | undefined {
  if (plain === null || plain === undefined || plain === "") return plain;
  // 已經是密文：PATCH 把舊值原封搬過來時會走到這裡，不能加密第二層
  if (isEncryptedPii(plain)) return plain;
  const key = currentKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}$${iv.toString("base64url")}$${body.toString("base64url")}`;
}

/** 讀取明文時呼叫。舊的明文列原樣回傳；解密不出來就丟錯，不假裝沒有資料 */
export function decryptPii(stored: string | null): string | null {
  if (stored === null || !isEncryptedPii(stored)) return stored;
  const key = currentKey();
  if (!key) {
    throw new AppError(
      500,
      "這筆身分證號是加密儲存的，但目前的 PII_KEY 未設定，無法解密。" +
        "請把當初加密時使用的 PII_KEY 設回環境變數後重啟（金鑰遺失則此欄位無法復原）。",
    );
  }
  const [, ivB64, bodyB64] = stored.split("$");
  try {
    const body = Buffer.from(bodyB64!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64!, "base64url"));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return decipher.update(body.subarray(0, body.length - 16)).toString("utf8") + decipher.final("utf8");
  } catch {
    throw new AppError(
      500,
      "身分證號解密失敗：目前的 PII_KEY 與這筆資料不是同一把金鑰。" +
        "請確認環境變數是否被改過（換金鑰不會自動重新加密既有資料）。",
    );
  }
}

/**
 * 啟動時的一行警告。沒設金鑰不是錯誤（內網部署本來就不需要），
 * 但**沉默的降級**是——所以它必須在容器日誌裡看得到。
 */
export function warnIfPiiUnprotected(): void {
  if (process.env["PII_KEY"]) return;
  console.warn(
    "[pii] PII_KEY 未設定：交易對象的身分證號以明文存放於資料庫與備份檔中。" +
      "內網部署可接受；對外提供服務前請設定（見 docs/deployment.md）。",
  );
}
