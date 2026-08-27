import { interpolate, type Params } from "@tw-erp/core";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** 服務層對資料庫的最小依賴：任何 drizzle pg driver（pg、PGlite）皆可注入 */
export type Db = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * 服務層錯誤。`key` 是中文原句（i18n 字典的 key，機制見 packages/core/src/i18n.ts），
 * `params` 是 `{x}` 佔位的值；`message` 永遠是套好參數的中文（log、測試斷言都看這個）。
 * 翻譯**不在這裡做**——服務層不知道使用者是誰、要哪種語言；app.onError 依 Accept-Language 翻。
 *
 * 既有 `new AppError(400, "固定句子")` 一律相容（key＝句子、無參數）。
 * 用樣板字串組的訊息要改成 `new AppError(400, "{name} 須為正整數（收到「{raw}」）", { name, raw })`
 * 才翻得到——樣板字串先組好再丟進來的，key 每次都不同，字典永遠對不上。
 */
export class AppError extends Error {
  readonly status: number;
  readonly key: string;
  readonly params: Params | undefined;

  constructor(status: number, key: string, params?: Params) {
    super(interpolate(key, params));
    this.status = status;
    this.key = key;
    this.params = params;
  }
}
