// @vitest-environment jsdom
import type { PageKey } from "@tw-erp/core";
import { describe, expect, it, vi } from "vitest";
import { EmptyState, NavContext } from "../src/ui.tsx";
import { render, screen, userEvent } from "./dom.ts";

/**
 * 這支測試的用途是**證明這條路真的通**——jsdom＋testing-library 能把一個真元件畫出來、
 * 能點得到它畫出來的按鈕、能看見 context 有沒有接上。
 *
 * 為什麼挑 EmptyState：它是這個 codebase 裡最小的「有分支的元件」——
 * 按鈕出不出現取決於 `props.onAction ?? (props.actionPage ? … : null)` 與 actionLabel 兩者，
 * 而這種「該出現的東西沒出現／不該出現的出現了」正是 source-grep 型測試看不見的那一類缺陷
 * （前四輪一直栽在這裡：紅線被 grep 守著，改寫成另一種寫法就靜靜穿過去）。
 * 它也不需要任何 mock：不打 API、唯一的外部依賴 NavContext 有預設值。
 */
describe("EmptyState（jsdom 探路）", () => {
  it("把 icon／title／desc 都畫出來", () => {
    render(<EmptyState icon="📄" title="還沒有報銷單" desc="按下面的按鈕開第一張。" />);
    expect(screen.getByText("📄")).toBeDefined();
    expect(screen.getByText("還沒有報銷單")).toBeDefined();
    expect(screen.getByText("按下面的按鈕開第一張。")).toBeDefined();
  });

  it("沒有 actionLabel 就不畫按鈕——零狀態不會出現一顆沒有字的按鈕", () => {
    render(<EmptyState icon="📄" title="還沒有報銷單" desc="說明" onAction={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("有 actionLabel 但沒有任何去處時也不畫按鈕——按了不會發生事情的按鈕不該存在", () => {
    render(<EmptyState icon="📄" title="還沒有報銷單" desc="說明" actionLabel="新增" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("點按鈕會呼叫 onAction", async () => {
    const onAction = vi.fn();
    render(<EmptyState icon="📄" title="還沒有報銷單" desc="說明" actionLabel="新增報銷" onAction={onAction} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "新增報銷" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  /**
   * actionPage 這條路要靠 NavContext 才成立。測它是為了替下一棒探路：
   * Expenses 用的是同一組 context 機制（useNav／useAuth），provider 包法就是這個樣子。
   */
  it("沒有 onAction 時，點按鈕會用 actionPage 呼叫 NavContext 的導覽函式", async () => {
    const nav = vi.fn();
    render(
      <NavContext.Provider value={nav}>
        <EmptyState icon="📄" title="還沒有報銷單" desc="說明" actionLabel="去報銷" actionPage={"expenses" satisfies PageKey} />
      </NavContext.Provider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "去報銷" }));
    expect(nav).toHaveBeenCalledWith("expenses");
  });

  /**
   * cleanup 的哨兵。test/dom.ts 註冊了 `afterEach(cleanup)`，理由寫在那支的檔頭——
   * 但「理由寫得很好」跟「它真的有跑」是兩件事：實測把那行註解掉，其餘四則測試**全綠**，
   * 也就是說沒有任何東西擋得住有人把它拿掉。這一則就是那道擋。
   *
   * 它刻意依賴**檔案內的執行順序**（vitest 同檔依宣告順序跑）：前面幾則都 render 了
   * 同一個 title，cleanup 沒生效的話 document.body 會累積四份 `.empty`，
   * getByText 撈到多個就直接丟錯。單獨跑這一則會平凡地通過——那是可以接受的，
   * 它要守的是「整檔跑完不殘留」這件事。
   */
  it("每則測試都從乾淨的 document 開始——前面幾則 render 的節點不會殘留", () => {
    render(<EmptyState icon="📄" title="還沒有報銷單" desc="說明" />);
    expect(screen.getByText("還沒有報銷單")).toBeDefined();
    expect(document.body.querySelectorAll(".empty")).toHaveLength(1);
  });
});
