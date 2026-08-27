// @vitest-environment jsdom
/**
 * 前端 i18n 架構：偏好持久化、<html lang>、切換時重畫、缺翻譯 fallback、請求帶 Accept-Language。
 * 這裡不測任何一頁的翻譯內容——那是字典的事，這裡守的是機制。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api.ts";
import { getLocale, setLocale, useT } from "../src/i18n.ts";
import { render, screen, userEvent } from "./dom.ts";

function Demo() {
  const t = useT();
  return (
    <div>
      <span data-testid="save">{t("儲存")}</span>
      <span data-testid="untranslated">{t("這句沒有翻譯")}</span>
      <span data-testid="param">{t("{name} 須在 {min}–{max} 之間", { name: "X", min: 1, max: 9 })}</span>
      <button onClick={() => setLocale(getLocale() === "en" ? "zh-TW" : "en")}>toggle</button>
    </div>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("語言偏好", () => {
  it("dom.ts 釘住 zh-TW；沒有偏好時跟瀏覽器語言（jsdom 是 en-US → en）", () => {
    expect(getLocale()).toBe("zh-TW");
    localStorage.removeItem("eternal-locale");
    expect(getLocale()).toBe("en");
  });
  it("setLocale 寫 localStorage 並套 <html lang>", () => {
    setLocale("en");
    expect(localStorage.getItem("eternal-locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    setLocale("zh-TW");
    expect(document.documentElement.lang).toBe("zh-Hant-TW");
  });
  it("localStorage 存了垃圾值就當沒存", () => {
    localStorage.setItem("eternal-locale", "klingon");
    expect(getLocale()).toBe("en"); // jsdom navigator 是 en-US
  });
});

describe("useT", () => {
  it("切換語言後所有用 useT 的元件一起重畫；缺翻譯顯示中文而不是空白", async () => {
    render(<Demo />);
    expect(screen.getByTestId("save").textContent).toBe("儲存");
    await userEvent.setup().click(screen.getByText("toggle"));
    expect(screen.getByTestId("save").textContent).toBe("Save");
    expect(screen.getByTestId("untranslated").textContent).toBe("這句沒有翻譯");
    expect(screen.getByTestId("param").textContent).toBe("X must be between 1 and 9");
    await userEvent.setup().click(screen.getByText("toggle"));
    expect(screen.getByTestId("save").textContent).toBe("儲存");
  });
});

describe("api 請求帶 Accept-Language", () => {
  it("get / post / getList / getText 都帶目前偏好", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    setLocale("en");
    await api.get("/x");
    await api.post("/x", { a: 1 });
    await api.getList("/x");
    await api.getText("/x");
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c.headers["accept-language"]).toBe("en");
    expect(calls[1]!.headers["content-type"]).toBe("application/json"); // 合併 header 不能把 JSON 型別擠掉
  });
});
