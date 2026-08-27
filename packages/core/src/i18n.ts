/**
 * i18n 機制（零相依）。**來源語言是繁體中文，字典的 key 就是中文原句。**
 *
 * 為什麼 key 用中文原句而不是 `expenses.submit.error` 這種代號：
 * - 既有 3000+ 行 UI 字串與 500+ 條錯誤訊息全是中文寫死的；用原句當 key，
 *   包一層 `t()` 就完成遷移，不必替每一句發明代號、也不必維護「代號→中文」那份字典。
 * - 缺翻譯時 fallback 回 key＝畫面顯示中文，**永遠不會出現空白或代號**——
 *   demo 路徑以外的頁面就是靠這條活著。
 * - 代價：中文原句改一個字，英文翻譯就脫鉤。`scripts/i18n-scan.mjs` 會列出
 *   「字典裡有、程式碼裡沒人用」的孤兒 key，改句子時跑一次即可。
 *
 * 參數用 `{name}` 佔位：`t("{name} 須在 {min}–{max} 之間", { name, min, max })`。
 * 不做複數規則、不做性別——中文沒有，英文的 demo 路徑手寫兩句就好。
 */

export type Locale = "zh-TW" | "en";
export const LOCALES: readonly Locale[] = ["zh-TW", "en"] as const;
/** 來源語言：字典 key 本身就是這個語言的句子 */
export const SOURCE_LOCALE: Locale = "zh-TW";

export type Params = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type Dictionary = Readonly<Record<string, string>>;
/** 每個 locale 一份字典；SOURCE_LOCALE 不需要（key 就是句子） */
export type Dictionaries = Partial<Readonly<Record<Locale, Dictionary>>>;

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** `{x}` → params.x。沒給的參數**保留原樣** `{x}`（看得出來少了什麼，而不是變成空字串） */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = params[k];
    return v === undefined || v === null ? m : String(v);
  });
}

export function translate(dicts: Dictionaries, locale: Locale, key: string, params?: Params): string {
  const raw = locale === SOURCE_LOCALE ? key : (dicts[locale]?.[key] ?? key);
  return interpolate(raw, params);
}

export type Translator = (key: string, params?: Params) => string;

/** 綁定字典後，依 locale 取一個 `t()`。前端 hook 與 API 錯誤出口都用這個 */
export function createTranslator(dicts: Dictionaries): (locale: Locale) => Translator {
  return (locale) => (key, params) => translate(dicts, locale, key, params);
}

/**
 * `Accept-Language` 協商：依 q 值排序，第一個對得上的 locale 勝出，都對不上回來源語言。
 * `en-US`、`en-GB` → en；`zh-TW`、`zh-Hant`、`zh` → zh-TW（簡體使用者也給繁中——本系統沒有簡中）。
 * 前端的語言切換也是送這個標頭，所以這裡是伺服端**唯一**的語言判斷點。
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return SOURCE_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part, i) => {
      const [tag = "", ...ps] = part.trim().split(";");
      const q = ps.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((r) => r.tag && r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  for (const { tag } of ranked) {
    if (tag === "en" || tag.startsWith("en-")) return "en";
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-TW";
  }
  return SOURCE_LOCALE;
}
