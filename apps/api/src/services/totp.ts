/**
 * 二階段驗證的演算法本體（RFC 6238 TOTP，HMAC-SHA1／30 秒／6 碼）。
 *
 * 為什麼自己寫而不是裝套件：整個演算法是三十行 node:crypto 的呼叫，而它是登入路徑上的
 * 第二道憑證——引一個套件進來換三十行，等於用一條供應鏈風險換一點打字時間。
 * 同樣的理由，密碼雜湊當初也是直接用 node:crypto scrypt（見 auth.ts）。
 * 正確性不靠「相信自己寫對了」：totp.test.ts 用 RFC 6238 附錄 B 的官方測試向量驗。
 *
 * 為什麼還是 HMAC-SHA1 而不是 SHA-256：Google Authenticator、1Password、
 * Microsoft Authenticator 這些實際會被拿來用的 app，掃到 algorithm=SHA256 的
 * otpauth URI 有的會忽略參數、有的直接不支援，結果是使用者的驗證碼永遠對不上，
 * 而畫面上只會說「驗證碼錯誤」。TOTP 的 SHA1 用在 HMAC 裡，
 * 不受 SHA1 碰撞攻擊影響（那是雜湊碰撞，不是 HMAC 偽造）。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
/** 前後各容許一個時間窗（±30 秒），吸收使用者手機與伺服器的時鐘差 */
const WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out; // 不補 '='：otpauth URI 的慣例是不帶 padding
}

export function base32Decode(text: string): Buffer {
  // 使用者可能從畫面複製時帶進空白或小寫，這裡一律正規化——
  // 「貼上去說格式錯誤」是設定二階段驗證時最容易讓人放棄的一步
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`不是合法的 base32 字元: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 產生新的密鑰（20 bytes＝SHA1 的區塊大小，RFC 4226 建議值），以 base32 回傳 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * 指定時間窗的驗證碼。digits 只為了測試能對 RFC 6238 的 8 碼向量，正式一律 6 碼。
 */
export function totpCodeAt(secretBase32: string, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * 驗證使用者輸入的驗證碼。
 *
 * 比對用 timingSafeEqual：驗證碼只有六位數，時間差洩漏「前幾碼對了」會把
 * 一百萬種可能降到逐位猜測的六十次。這條在密碼比對上已經做了（auth.ts），
 * 沒有理由在第二因子上放掉。
 */
export function verifyTotp(secretBase32: string, input: string, now = Date.now()): boolean {
  const code = input.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const supplied = Buffer.from(code, "utf8");
  let ok = false;
  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    const expected = Buffer.from(totpCodeAt(secretBase32, counter + drift), "utf8");
    // 不 early-return：跑完所有時間窗，讓「第幾個窗命中」不從耗時看得出來
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) ok = true;
  }
  return ok;
}

/**
 * 驗證器 app 掃描／手動輸入用的 otpauth URI。
 * issuer 同時放在路徑與參數裡是刻意的——不同 app 讀的是不同一個，兩個都給才不會在
 * 使用者的手機上顯示成一串沒有標籤的數字。
 */
export function otpauthUri(secretBase32: string, username: string, issuer = "tw-erp"): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * 備援碼：手機掉了、換手機、app 被誤刪時的唯一出路。
 * 格式是四組四碼的 base32（去掉容易看錯的字母由 base32 字母表天然處理），
 * 以連字號分組——要用到它的時候人正處在「進不去系統」的壓力下，抄錯一個字元的代價很高。
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(10)).slice(0, 16);
    return raw.match(/.{1,4}/g)!.join("-");
  });
}

/** 比對前的正規化：使用者會連同連字號一起抄，也可能全部打小寫 */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}
