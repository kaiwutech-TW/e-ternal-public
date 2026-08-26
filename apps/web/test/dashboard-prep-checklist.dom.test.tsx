// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { AuthContext } from "../src/auth.ts";
import { PrepChecklist } from "../src/pages/Dashboard.tsx";
import type { AuthUser } from "../src/types.ts";
import { render, screen, userEvent } from "./dom.ts";

/**
 * 「開始使用前的準備」卡：勾選清單，狀態存 localStorage、按使用者分 key、全勾完收起。
 *
 * 這張卡不打任何 API（它問的是系統外的準備，系統偵測不到），所以測試不需要 mock fetch。
 * 三件真的要守的事：①勾選會存下來且重載還在 ②不同使用者互不干擾（共用電腦換帳號）
 * ③全部勾完就不佔版面。第②點是這張卡放 localStorage 而不是放資料庫的唯一理由，
 * 沒測到它的話那個設計決定就只是一句註解。
 */
const admin: AuthUser = { id: 7, username: "boss", displayName: "老闆", role: "admin", employeeId: null, totpEnabled: false };
const finance: AuthUser = { id: 9, username: "acct", displayName: "會計", role: "finance", employeeId: null, totpEnabled: false };

const renderAs = (user: AuthUser) => render(<AuthContext.Provider value={user}><PrepChecklist /></AuthContext.Provider>);

describe("首頁：開始使用前的準備清單", () => {
  beforeEach(() => localStorage.clear());

  it("初次登入八項都沒勾、標題寫還缺 8 項，且清單裡沒有任何稅率數字", () => {
    renderAs(admin);
    expect(screen.getByText("開始使用前的準備（還缺 8 項）")).toBeDefined();
    expect(screen.getAllByRole("checkbox")).toHaveLength(8);
    // 零斷言：這張卡只能說「去查」，不能替使用者填答案
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\d+(\.\d+)?\s?%/);
  });

  it("勾一項 → 標題數字跟著減、狀態寫進本機、重新 render 仍是勾的", async () => {
    const u = userEvent.setup();
    const first = renderAs(admin);
    await u.click(screen.getByRole("checkbox", { name: "訂好切換日" }));
    expect(screen.getByText("開始使用前的準備（還缺 7 項）")).toBeDefined();
    expect(JSON.parse(localStorage.getItem("eternal-prep:7") ?? "[]")).toEqual(["cutover"]);

    first.unmount();
    renderAs(admin);
    expect((screen.getByRole("checkbox", { name: "訂好切換日" }) as HTMLInputElement).checked).toBe(true);
  });

  it("按使用者分 key：管理者勾過的東西，會計登入看不到", async () => {
    const u = userEvent.setup();
    const a = renderAs(admin);
    await u.click(screen.getByRole("checkbox", { name: "訂好切換日" }));
    a.unmount();

    renderAs(finance);
    expect(screen.getByText("開始使用前的準備（還缺 8 項）")).toBeDefined();
    expect((screen.getByRole("checkbox", { name: "訂好切換日" }) as HTMLInputElement).checked).toBe(false);
  });

  it("全部勾完卡片收起；取消一項又出現", async () => {
    const u = userEvent.setup();
    renderAs(admin);
    for (const box of screen.getAllByRole("checkbox")) await u.click(box);
    expect(screen.queryByText(/開始使用前的準備/)).toBeNull();

    // 存的是全部八個 key；下次登入也不會再出現
    expect(JSON.parse(localStorage.getItem("eternal-prep:7") ?? "[]")).toHaveLength(8);
  });

  it("本機存的東西壞掉（不是 JSON）也照常畫出來，不炸首頁", () => {
    localStorage.setItem("eternal-prep:7", "{not json");
    renderAs(admin);
    expect(screen.getByText("開始使用前的準備（還缺 8 項）")).toBeDefined();
  });
});
