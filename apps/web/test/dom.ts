/**
 * DOM 測試的共用入口。**要 render 元件的測試從這裡取 render／screen／userEvent**，
 * 不要直接 import @testing-library/react。
 *
 * 為什麼多一層：testing-library 的自動 cleanup 掛在全域 `afterEach` 上，而這個 workspace
 * 沒開 vitest 的 globals（`expect`／`afterEach` 都是 import 進來的），所以那個自動註冊
 * **不會發生**。少了它，前一則測試 render 的節點會留在 document.body 裡，下一則
 * `screen.getByText` 就可能撈到上一則的東西——測試會綠，但綠得沒有意義。
 * 把 cleanup 綁在「你反正一定要 import 的那支模組」上，是唯一不需要靠人記得的做法。
 *
 * 用法（檔案第一行必須有環境宣告，否則 node 環境下沒有 document）：
 *
 *     // @vitest-environment jsdom
 *     import { render, screen, userEvent } from "./dom.ts";
 *
 * ★ 射程：jsdom 沒有 canvas，`HTMLCanvasElement.getContext` 回 null。
 *   影像解碼／QR 掃描那條路在這裡測不到，靠實機。
 *
 * ★ localStorage：這個 workspace 的 jsdom 版本（30）在 vitest 底下**不提供** Web Storage——
 *   `globalThis.localStorage` 與 `window.localStorage` 都是 undefined（實測，見
 *   dashboard-prep-checklist 那支第一次跑的失敗）。凡是靠它記狀態的元件（側欄收合、主題、
 *   agent 聊天紀錄、準備清單）在這裡都會直接炸。下面裝一個**記憶體版**替身：同一個 API、
 *   每則測試後清空（掛在同一個 afterEach 上），所以「重新 render 仍在」「換使用者看不到」
 *   這類斷言測得出真正的行為。只在缺的時候裝，將來 jsdom 補回來就自動讓路。
 */
import { cleanup } from "@testing-library/react";
import userEventLib from "@testing-library/user-event";
import { afterEach } from "vitest";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}
if (typeof globalThis.localStorage === "undefined") {
  const ls = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true });
  // 元件多半寫 `localStorage.x`（裸識別字）＝ globalThis；少數寫 `window.localStorage`，一併接上
  if (typeof window !== "undefined") Object.defineProperty(window, "localStorage", { value: ls, configurable: true });
}

afterEach(cleanup);
/**
 * 語言：jsdom 的 navigator.language 是 en-US，src/i18n.ts 沒有偏好時會跟瀏覽器走→英文；
 * 但既有 dom 測試全用中文標籤查元素。這裡把偏好釘在 zh-TW（每則測試前後都釘），
 * 要測英文的測試自己呼叫 setLocale("en")。
 */
// jsdom 沒有 matchMedia（theme.ts 的 useEffectiveTheme 會呼叫）：裝一個永遠 light 的替身
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }) as MediaQueryList;
}

const pinLocale = () => localStorage.setItem("eternal-locale", "zh-TW");
pinLocale();
afterEach(() => { localStorage.clear(); pinLocale(); });

export * from "@testing-library/react";
export const userEvent = userEventLib;
