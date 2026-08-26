/**
 * TOTP 演算法驗收：對 RFC 6238 附錄 B 的官方測試向量。
 *
 * 這個檔案的存在理由：演算法是自己寫的（三十行 node:crypto，不引套件），
 * 而「自己寫對了」不能靠自己說了算。官方向量是唯一能證明它與全世界的驗證器 app
 * 算出同一個數字的東西——錯了的症狀是所有人的驗證碼永遠對不上，且畫面只說「錯誤」。
 */
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  totpCodeAt,
  verifyTotp,
} from "../src/services/totp.ts";

/** RFC 6238 的測試密鑰是 ASCII "12345678901234567890" */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "utf8"));

describe("RFC 6238 官方測試向量（8 碼）", () => {
  // [Unix 時間（秒）, 預期驗證碼]，取自 RFC 6238 Appendix B 的 SHA1 那幾列
  const VECTORS: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(VECTORS)("T=%i → %s", (seconds, expected) => {
    expect(totpCodeAt(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(expected);
  });
});

describe("base32", () => {
  it("RFC 4648 的編碼範例", () => {
    expect(base32Encode(Buffer.from("foobar", "utf8"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString("utf8")).toBe("foobar");
  });

  it("解碼容忍空白、連字號、小寫與 padding（使用者是用複製貼上的）", () => {
    const secret = generateTotpSecret();
    const messy = `${secret.slice(0, 4)} ${secret.slice(4, 8)}-${secret.slice(8)}`.toLowerCase();
    expect(base32Decode(messy)).toEqual(base32Decode(secret));
  });

  it("非法字元丟錯，不安靜地當成 0", () => {
    expect(() => base32Decode("ABC1")).toThrow(/base32/); // 1 不在字母表裡（易與 I 混淆才被排除）
  });
});

describe("verifyTotp", () => {
  const secret = generateTotpSecret();
  const now = 1_800_000_000_000; // 固定時點，避免測試在時間窗邊界上偶發失敗

  it("當下這一窗的碼會過", () => {
    expect(verifyTotp(secret, totpCodeAt(secret, Math.floor(now / 1000 / 30)), now)).toBe(true);
  });

  it("前後各一窗都容許（吸收手機與伺服器的時鐘差）", () => {
    const counter = Math.floor(now / 1000 / 30);
    expect(verifyTotp(secret, totpCodeAt(secret, counter - 1), now)).toBe(true);
    expect(verifyTotp(secret, totpCodeAt(secret, counter + 1), now)).toBe(true);
  });

  it("差兩窗就不行（容忍度不是越大越好，那是在放寬暴力破解的空間）", () => {
    const counter = Math.floor(now / 1000 / 30);
    expect(verifyTotp(secret, totpCodeAt(secret, counter - 2), now)).toBe(false);
    expect(verifyTotp(secret, totpCodeAt(secret, counter + 2), now)).toBe(false);
  });

  it("格式不對一律 false，不丟例外（輸入來自使用者，例外會變成 500）", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect(verifyTotp(secret, bad, now)).toBe(false);
    }
  });

  it("另一個密鑰的碼不會過", () => {
    const other = generateTotpSecret();
    expect(verifyTotp(secret, totpCodeAt(other, Math.floor(now / 1000 / 30)), now)).toBe(false);
  });
});

describe("otpauth URI", () => {
  it("帶得齊驗證器 app 需要的參數，且 issuer 路徑與參數都有", () => {
    const uri = otpauthUri("ABCDEFGH", "admin");
    expect(uri).toMatch(/^otpauth:\/\/totp\/tw-erp%3Aadmin\?/);
    const q = new URL(uri).searchParams;
    expect(q.get("secret")).toBe("ABCDEFGH");
    expect(q.get("issuer")).toBe("tw-erp");
    expect(q.get("algorithm")).toBe("SHA1");
    expect(q.get("digits")).toBe("6");
    expect(q.get("period")).toBe("30");
  });
});

describe("備援碼", () => {
  it("十組、彼此不同、分組好抄", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it("正規化吃得下連字號與小寫（人在進不去系統的壓力下抄的）", () => {
    expect(normalizeRecoveryCode("abcd-efgh-ijkl-mnop")).toBe("ABCDEFGHIJKLMNOP");
    expect(normalizeRecoveryCode(" ABCD EFGH IJKL MNOP ")).toBe("ABCDEFGHIJKLMNOP");
  });
});
