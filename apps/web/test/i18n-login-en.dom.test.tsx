// @vitest-environment jsdom
/** 端到端最小證據：切成英文後，真的有一頁整頁是英文（登入頁沒有 API 依賴，最適合當煙霧測試） */
import { describe, expect, it } from "vitest";
import { setLocale } from "../src/i18n.ts";
import { Login } from "../src/pages/Login.tsx";
import { render, screen } from "./dom.ts";

describe("Login page in English", () => {
  it("沒有任何中文殘留，且看得到英文按鈕", () => {
    setLocale("en");
    const { container } = render(<Login needsSetup={false} onLogin={() => {}} />);
    // 語言切換鈕用目標語言自己的字寫（慣例：英文介面上寫「繁體中文」），所以它不算中文殘留
    container.querySelector("[data-locale-toggle]")?.remove();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
    expect(screen.getByRole("button", { name: /sign in|log in/i })).toBeTruthy();
  });
});
