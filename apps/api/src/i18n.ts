/**
 * 伺服端 i18n 出口。唯一的語言判斷點是 `Accept-Language`（前端 api.ts 每個請求都帶）。
 *
 * 兩條路：
 * 1. **AppError**：服務層丟 key＋params，`app.onError` 出口翻（服務層不知道 locale）。
 * 2. **回給前端顯示的提示句**（notes／warnings／label／hint）：服務層在組回應時就要是使用者的語言，
 *    這裡用 AsyncLocalStorage 把「這個請求的 locale」帶進去，服務層呼叫 `tr(key, params)` 即可。
 *    沒有請求上下文（腳本、測試直接呼叫服務）時 `tr` 回來源語言（中文）——與 fallback 一致，絕不空白。
 *
 * 為什麼不讓服務層收 locale 參數：34 個 push 點散在 8 個檔，每條呼叫鏈都要多穿一個參數；
 * ALS 是 Node 標準做法，middleware 一處設定、全鏈可見。
 */
import { createTranslator, negotiateLocale, SOURCE_LOCALE, type Locale, type Params } from "@tw-erp/core";
import type { Context, MiddlewareHandler } from "hono";
import { AsyncLocalStorage } from "node:async_hooks";
import { en } from "./locales/en.ts";

const translatorFor = createTranslator({ en });
const requestLocale = new AsyncLocalStorage<Locale>();

export function localeOf(c: Context): Locale {
  return negotiateLocale(c.req.header("accept-language"));
}

export function translateFor(locale: Locale) {
  return translatorFor(locale);
}

/** 目前請求的語言；沒有請求上下文時是來源語言 */
export function currentLocale(): Locale {
  return requestLocale.getStore() ?? SOURCE_LOCALE;
}

/** 服務層用：依目前請求語言翻一句要回給前端**顯示**的話（key＝中文原句，同字典） */
export function tr(key: string, params?: Params): string {
  return translatorFor(currentLocale())(key, params);
}

/** 掛在最外層：之後這個請求鏈上所有 `tr()`／`currentLocale()` 都看得到語言 */
export const localeMiddleware: MiddlewareHandler = (c, next) => requestLocale.run(localeOf(c), next);
