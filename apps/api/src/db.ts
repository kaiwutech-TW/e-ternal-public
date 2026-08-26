import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** 服務層對資料庫的最小依賴：任何 drizzle pg driver（pg、PGlite）皆可注入 */
export type Db = PgDatabase<PgQueryResultHKT, any, any>;

export class AppError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
