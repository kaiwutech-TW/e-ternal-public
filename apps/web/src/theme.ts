/**
 * 外觀主題：Light / Dark / System 三段。
 * - 偏好存 localStorage；套用方式是 <html data-theme="light|dark">，system＝不設屬性
 *   （styles.css 的深色 token 同時掛在 media query 的 :root:not([data-theme="light"])
 *   與 :root[data-theme="dark"] 上，三種狀態都吃得到正確的一組）。
 * - index.html 有一段 pre-paint 的 inline script 先套屬性，避免整頁閃一下白。
 */
import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";

const KEY = "eternal-theme";

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function setThemePref(pref: ThemePref): void {
  localStorage.setItem(KEY, pref);
  applyTheme(pref);
  window.dispatchEvent(new Event("eternal-theme-change"));
}

export function applyTheme(pref: ThemePref = getThemePref()): void {
  if (pref === "system") delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = pref;
}

/** 目前實際生效的外觀（system 會解析成 light/dark）——logo 圖檔切換用 */
export function useEffectiveTheme(): "light" | "dark" {
  const calc = (): "light" | "dark" => {
    const p = getThemePref();
    if (p !== "system") return p;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const [theme, setTheme] = useState<"light" | "dark">(calc);
  useEffect(() => {
    const onChange = () => setTheme(calc());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onChange);
    window.addEventListener("eternal-theme-change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("eternal-theme-change", onChange);
    };
  }, []);
  return theme;
}
