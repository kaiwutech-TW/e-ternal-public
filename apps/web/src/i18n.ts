/**
 * 前端語言切換：zh-TW（來源語言）／en。形狀比照 theme.ts——
 * - 偏好存 localStorage（`eternal-locale`），沒有偏好時看瀏覽器語言（英語圈評審第一次開就是英文）
 * - 套用方式是 <html lang>；切換時發 `eternal-locale-change`，所有 useLocale() 一起重畫
 * - api.ts 每個請求帶 Accept-Language，伺服端錯誤訊息跟著同一個偏好走
 *
 * 用法：`const t = useT(); <button>{t("儲存")}</button>`。
 * React 樹外（工具函式、模組層常數）用 `t()`——它讀當下偏好，但**不會**跟著切換重算，
 * 所以只能用在每次呼叫時才求值的地方。
 */
import { createTranslator, isLocale, type Locale, type Params, type Translator } from "@tw-erp/core";
import { useEffect, useMemo, useState } from "react";
import { en } from "./locales/en.ts";

const KEY = "eternal-locale";
const EVENT = "eternal-locale-change";
const HTML_LANG: Record<Locale, string> = { "zh-TW": "zh-Hant-TW", en: "en" };
export const LOCALE_LABEL: Record<Locale, string> = { "zh-TW": "繁體中文", en: "English" };

const translatorFor = createTranslator({ en });

function safeGet(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function getLocale(): Locale {
  const stored = safeGet();
  if (isLocale(stored)) return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav.toLowerCase().startsWith("en") ? "en" : "zh-TW";
}

export function setLocale(locale: Locale): void {
  try { localStorage.setItem(KEY, locale); } catch { /* 私密視窗等：這次 session 仍生效 */ }
  applyLocale(locale);
  window.dispatchEvent(new Event(EVENT));
}

export function applyLocale(locale: Locale = getLocale()): void {
  document.documentElement.lang = HTML_LANG[locale];
}

/** 非 hook 版：讀當下偏好求值一次（React 樹外用） */
export const t: Translator = (key: string, params?: Params) => translatorFor(getLocale())(key, params);

export function useLocale(): Locale {
  const [locale, set] = useState<Locale>(getLocale);
  useEffect(() => {
    const on = () => set(getLocale());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return locale;
}

export function useT(): Translator {
  const locale = useLocale();
  return useMemo(() => translatorFor(locale), [locale]);
}
