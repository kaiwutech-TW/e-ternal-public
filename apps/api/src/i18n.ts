/**
 * 伺服端 i18n 出口：唯一的語言判斷點是 `Accept-Language`（前端 api.ts 每個請求都帶）。
 * 只翻 AppError（key＋params）；服務層本身不翻、也不知道 locale。
 */
import { createTranslator, negotiateLocale, type Locale } from "@tw-erp/core";
import type { Context } from "hono";
import { en } from "./locales/en.ts";

const translatorFor = createTranslator({ en });

export function localeOf(c: Context): Locale {
  return negotiateLocale(c.req.header("accept-language"));
}

export function translateFor(locale: Locale) {
  return translatorFor(locale);
}
