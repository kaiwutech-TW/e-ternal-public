import { describe, expect, it } from "vitest";
import { createTranslator, interpolate, isLocale, negotiateLocale, translate } from "./i18n.ts";

const dicts = { en: { "儲存": "Save", "{name} 須在 {min}–{max} 之間": "{name} must be between {min} and {max}" } };

describe("translate", () => {
  it("zh-TW 回 key 本身（來源語言）", () => expect(translate(dicts, "zh-TW", "儲存")).toBe("儲存"));
  it("en 查字典", () => expect(translate(dicts, "en", "儲存")).toBe("Save"));
  it("en 缺翻譯就 fallback 回中文，絕不回空字串或代號", () =>
    expect(translate(dicts, "en", "沒翻的句子")).toBe("沒翻的句子"));
  it("參數插值兩種語言都套", () => {
    expect(translate(dicts, "zh-TW", "{name} 須在 {min}–{max} 之間", { name: "稅率", min: 0, max: 100 })).toBe("稅率 須在 0–100 之間");
    expect(translate(dicts, "en", "{name} 須在 {min}–{max} 之間", { name: "rate", min: 0, max: 100 })).toBe("rate must be between 0 and 100");
  });
  it("缺的參數保留 {x}（看得出來少了什麼）", () => expect(interpolate("{a}/{b}", { a: 1 })).toBe("1/{b}"));
  it("createTranslator 綁字典", () => expect(createTranslator(dicts)("en")("儲存")).toBe("Save"));
});

describe("negotiateLocale", () => {
  it("空／缺 → zh-TW", () => {
    expect(negotiateLocale(null)).toBe("zh-TW");
    expect(negotiateLocale("")).toBe("zh-TW");
  });
  it("en-US → en；zh-Hant / zh-CN / zh → zh-TW", () => {
    expect(negotiateLocale("en-US,en;q=0.9")).toBe("en");
    expect(negotiateLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(negotiateLocale("zh-CN")).toBe("zh-TW");
  });
  it("依 q 值排序，不是依出現順序", () => expect(negotiateLocale("zh-TW;q=0.5, en;q=0.9")).toBe("en"));
  it("都對不上（ja）→ zh-TW", () => expect(negotiateLocale("ja-JP")).toBe("zh-TW"));
  it("q=0 視為不接受", () => expect(negotiateLocale("en;q=0, zh")).toBe("zh-TW"));
  it("isLocale", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });
});
