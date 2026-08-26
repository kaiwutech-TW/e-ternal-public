/**
 * 資料庫連線字串的解析：server.ts 與 scripts/migrate.ts 共用（兩支都要連同一個庫，
 * 而「密碼從哪來」這件事寫兩處必有一處過時）。
 *
 * 除了 DATABASE_URL，另支援 `DATABASE_PASSWORD_FILE`（<VAR>_FILE 慣例，
 * 與 postgres 官方映像的 POSTGRES_PASSWORD_FILE 是同一個做法）。
 *
 * 為什麼值得多這一條路徑：放在環境變數裡的密碼會出現在 `docker inspect` 的輸出、
 * 容器行程的 /proc/<pid>/environ、以及任何 `env` 的除錯輸出裡。凡是在 docker 群組裡的
 * 帳號都讀得到，而備份腳本、監控 agent 常常正是以那個身分在跑。改成檔案掛進容器
 * （compose secrets）之後，讀得到的範圍縮到這支行程本身。
 *
 * ⚠️ 這**不是加密**：密碼檔與資料庫在同一台主機上，拿到主機就兩者皆得。
 *    它縮小的是「不小心看到」與「順手撈到」的範圍，不是防得住已經進來的人。
 *    寫清楚是為了不讓人以為換成 secrets 就等於安全。
 */
import { readFileSync } from "node:fs";

export function resolveDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL 未設定（migration 請先執行 scripts/migrate.ts）");
    process.exit(1);
  }
  const passwordFile = process.env["DATABASE_PASSWORD_FILE"];
  if (!passwordFile) return url;

  // URL 的 password setter 會自行百分比編碼，pg 讀取時會解回來——含 @ : / # 的密碼可安全穿越
  const parsed = new URL(url);
  parsed.password = readFileSync(passwordFile, "utf8").trim();
  return parsed.toString();
}
