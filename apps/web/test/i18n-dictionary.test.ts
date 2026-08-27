/**
 * 字典守門（前端＋API 兩份都查）：
 * 1. 值不得為空——空字串不會 fallback，畫面會真的空白
 * 2. 值裡的 {x} 佔位必須是 key 裡有的——翻譯時把 {n} 打成 {count} 會顯示成字面 "{count}"
 * 3. key 裡的佔位在值裡至少要出現（少了＝那個資訊在英文版消失；允許刻意省略時在此列白名單）
 */
import { describe, expect, it } from "vitest";
import { en as apiEn } from "../../api/src/locales/en.ts";
import { en as webEn } from "../src/locales/en.ts";

const PLACEHOLDER = /\{(\w+)\}/g;
const names = (s: string) => new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1]!));
/** 英文版刻意不顯示某個參數的 key（要加就寫理由） */
const ALLOW_DROP: Record<string, string[]> = {};
/**
 * 刻意翻成空字串的片段：中文句被 <strong> 切成幾段，英文語序把這一段的意思併進相鄰片段了
 * （" 組"＝「剩餘救援碼：3 組」的量詞；"有 "＝「有 N 筆還沒登錄」的句首）。空字串不會 fallback，是有意的。
 */
const ALLOW_EMPTY = new Set([" 組", "有 "]);

for (const [label, dict] of [["web", webEn], ["api", apiEn]] as const) {
  describe(`${label} en dictionary`, () => {
    it("沒有空值", () => {
      const empty = Object.entries(dict).filter(([k, v]) => v.trim() === "" && !ALLOW_EMPTY.has(k)).map(([k]) => k);
      expect(empty).toEqual([]);
    });
    it("值裡的佔位都在 key 裡", () => {
      const bad = Object.entries(dict)
        .filter(([k, v]) => [...names(v)].some((n) => !names(k).has(n)))
        .map(([k, v]) => `${k} → ${v}`);
      expect(bad).toEqual([]);
    });
    it("key 裡的佔位都有翻進值（除白名單）", () => {
      const bad = Object.entries(dict)
        .filter(([k, v]) => [...names(k)].some((n) => !names(v).has(n) && !(ALLOW_DROP[k] ?? []).includes(n)))
        .map(([k, v]) => `${k} → ${v}`);
      expect(bad).toEqual([]);
    });
  });
}
