/**
 * 連線字串組裝驗收：DATABASE_PASSWORD_FILE（<VAR>_FILE 慣例）。
 * 重點在「含特殊字元的密碼能不能安全穿越 URL」——這條路徑一旦錯，
 * 症狀是啟動時連不上資料庫，而錯誤訊息只會說密碼錯誤，看不出是被編碼吃掉的。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "../src/db-url.ts";

const dir = mkdtempSync(join(tmpdir(), "twerp-dburl-"));
const writeSecret = (content: string): string => {
  const path = join(dir, `pw-${content.length}-${Math.abs(hash(content))}`);
  writeFileSync(path, content);
  return path;
};
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

/**
 * 實際交給 pg 解析，而不是自己比對字串——會用到這個值的是 pg，不是我們。
 * connectionParameters 沒有出現在 pg 的型別宣告裡（是實作細節），所以要轉型才拿得到。
 */
const passwordSeenByPg = (url: string): string | undefined =>
  (new pg.Client({ connectionString: url }) as unknown as { connectionParameters: { password?: string } })
    .connectionParameters.password;

afterEach(() => {
  delete process.env["DATABASE_URL"];
  delete process.env["DATABASE_PASSWORD_FILE"];
});

describe("resolveDatabaseUrl", () => {
  it("沒設 DATABASE_PASSWORD_FILE 時原樣回傳（內網部署的現行形狀）", () => {
    process.env["DATABASE_URL"] = "postgres://twerp:inline-pw@db:5432/twerp";
    expect(resolveDatabaseUrl()).toBe("postgres://twerp:inline-pw@db:5432/twerp");
  });

  it("設了就從檔案取密碼，且蓋掉 URL 裡原有的那個", () => {
    process.env["DATABASE_URL"] = "postgres://twerp:should-be-ignored@db:5432/twerp";
    process.env["DATABASE_PASSWORD_FILE"] = writeSecret("from-file");
    expect(passwordSeenByPg(resolveDatabaseUrl())).toBe("from-file");
  });

  it("含 @ : / # 的密碼能安全穿越（百分比編碼後 pg 會解回來）", () => {
    process.env["DATABASE_URL"] = "postgres://twerp@db:5432/twerp";
    process.env["DATABASE_PASSWORD_FILE"] = writeSecret("p@ss:w/rd#1&x");
    expect(passwordSeenByPg(resolveDatabaseUrl())).toBe("p@ss:w/rd#1&x");
  });

  it("檔尾的換行不算密碼的一部分（echo 寫出來的檔一定有這個換行）", () => {
    process.env["DATABASE_URL"] = "postgres://twerp@db:5432/twerp";
    process.env["DATABASE_PASSWORD_FILE"] = writeSecret("trailing-newline-pw\n");
    expect(passwordSeenByPg(resolveDatabaseUrl())).toBe("trailing-newline-pw");
  });
});
