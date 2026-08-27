// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CategorySuggestions,
  resetSellerSuggestionsForTests,
  type SuggestionApiRow,
} from "../src/CategorySuggestions.tsx";
import type { ExpenseCategory } from "../src/types.ts";
import { act, render, screen, userEvent, waitFor } from "./dom.ts";
import { expenseCategoryFixture, suggestionApiRow } from "./expenses-fixtures.ts";

/**
 * 賣方統編 → 歷史分類候選（W7）這支元件的**行為**測試。
 *
 * ★ 這一支守的是「殘餘風險」那一面。紅線（候選不得自動填進分類）今天主要由**資料流**保證：
 *   候選資料只存在於 src/CategorySuggestions.tsx 裡，報銷表單那一層看不到它（見那支的檔頭）。
 *   剩下唯一還寫得出自動填的地方，就是這支元件自己——它同時握著候選與 onPick，
 *   所以它可以在 effect 裡直接叫 onPick。
 *
 * ★ 為什麼是**矩陣**而不是一組：前三次穿透都不是「寫了測不到的程式」，而是把自動填的條件
 *   掛在**測試從來沒有變動過的維度**上（表單有幾列、claimCount 有沒有超過門檻）。
 *   單一組態的測試只證明那一組沒事。這裡用迴圈跑候選數 0〜4、claimCount 小／極大、
 *   取數中／取數失敗／空結果、分類清單有／沒有／對不上——每一組都斷言
 *   「render 完、沒有任何點擊，onPick 一次都沒被呼叫」。
 *   射程仍要誠實：矩陣涵蓋的是這幾個維度，不是所有可能的維度。
 */

/* ─────────────── 唯一的 mock：取數那個外部邊界（HTTP） ───────────────
 *
 * 取數**不做成 prop**（見元件檔頭：那會讓父層重新看見候選清單），所以要換掉它只剩模組邊界。
 */
const server = vi.hoisted(() => ({
  calls: [] as string[],
  handler: null as null | ((path: string) => Promise<SuggestionApiRow[]>),
}));

vi.mock("../src/api.ts", () => ({
  api: {
    get: (path: string) => {
      server.calls.push(path);
      if (!server.handler) throw new Error(`測試沒有裝 handler，但元件問了 ${path}`);
      return server.handler(path);
    },
  },
}));

const CATEGORIES: ExpenseCategory[] = ["6112", "6115", "6133", "6137"].map(expenseCategoryFixture);
/** 有分類清單、但沒有任何一個候選代號在裡面（下拉選不到的代號不該畫成按鈕） */
const UNRELATED_CATEGORIES: ExpenseCategory[] = ["9998", "9999"].map(expenseCategoryFixture);
const CODES = ["6133", "6112", "6115", "6137"];

/** 每則測試各用一個新統編：快取是跨元件共用的，共用統編會讓上一則的答案漂到下一則 */
let nextTaxId = 87654321;
const freshTaxId = () => String(nextTaxId++);

const respondWith = (rows: SuggestionApiRow[]) => {
  server.handler = async () => rows;
};

/** 讓 promise 的 then 都跑完（沒有這一步，斷言可能只是在「還沒問到」的空窗裡假綠） */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  server.calls.length = 0;
  server.handler = null;
});

afterEach(() => {
  // 快取活在模組層（跨元件、跨測試），不清掉的話下一則拿到的是上一則問到的答案
  resetSellerSuggestionsForTests();
});

/* ═════════ 【矩陣】沒有點擊，就沒有 onPick ═════════ */

type Outcome = "拿到答案" | "還在問" | "問不到";

const OUTCOMES: Outcome[] = ["拿到答案", "還在問", "問不到"];
const COUNTS = [0, 1, 2, 3, 4];
/** claimCount：1（「只有這一種歸法」最誘人自動選）與極大值（「這麼多張單都這樣歸，還用問嗎」） */
const CLAIM_COUNTS = [1, 999999];
const CATEGORY_SETS: [string, ExpenseCategory[] | null][] = [
  ["下拉載好了", CATEGORIES],
  ["下拉還沒回來", null],
  ["下拉裡沒有這些代號", UNRELATED_CATEGORIES],
];

const installOutcome = (outcome: Outcome, rows: SuggestionApiRow[]): void => {
  if (outcome === "拿到答案") respondWith(rows);
  if (outcome === "還在問") server.handler = () => new Promise<SuggestionApiRow[]>(() => {});
  if (outcome === "問不到") server.handler = async () => Promise.reject(new Error("網路斷了"));
};

describe("【矩陣】render 之後、任何點擊之前，onPick 一次都沒被呼叫", () => {
  for (const count of COUNTS) {
    for (const claimCount of CLAIM_COUNTS) {
      for (const outcome of OUTCOMES) {
        for (const [categoryLabel, categories] of CATEGORY_SETS) {
          it(`候選 ${count} 個／claimCount ${claimCount}／${outcome}／${categoryLabel}`, async () => {
            const rows = CODES.slice(0, count).map((c) => suggestionApiRow(c, claimCount));
            installOutcome(outcome, rows);
            const onPick = vi.fn();

            render(
              <CategorySuggestions
                sellerTaxId={freshTaxId()}
                categories={categories}
                disabled={false}
                onPick={onPick}
              />,
            );
            await settle();

            // 該看得到按鈕的組態就等它出現——不等的話下面那條斷言可能只是搶在答案回來之前
            const visible = outcome === "拿到答案" && categories === CATEGORIES ? Math.min(count, 3) : 0;
            if (visible > 0) {
              await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(visible));
            } else {
              expect(screen.queryAllByRole("button")).toHaveLength(0);
            }

            // ★ 紅線：一個點擊都沒發生
            expect(onPick).not.toHaveBeenCalled();

            // 再多等一輪：把「晚一拍才自動選」那種寫法也算進來
            await settle();
            expect(onPick).not.toHaveBeenCalled();

            // 使用者自己按下去才算數，而且按到哪一個就是哪一個（不是清單裡的第一個）
            if (visible > 0) {
              const buttons = screen.getAllByRole("button");
              const last = buttons[buttons.length - 1]!;
              await userEvent.setup().click(last);
              expect(onPick).toHaveBeenCalledTimes(1);
              expect(onPick).toHaveBeenCalledWith(CODES[visible - 1]);
            }
          });
        }
      }
    }
  }
});

describe("【矩陣】批次上傳期間鎖住時同樣不會自己選", () => {
  for (const count of COUNTS) {
    it(`候選 ${count} 個：鈕是 disabled，按下去也沒有 onPick`, async () => {
      respondWith(CODES.slice(0, count).map((c) => suggestionApiRow(c, 12)));
      const onPick = vi.fn();
      render(
        <CategorySuggestions sellerTaxId={freshTaxId()} categories={CATEGORIES} disabled={true} onPick={onPick} />,
      );
      await settle();

      const buttons = screen.queryAllByRole("button");
      expect(buttons).toHaveLength(Math.min(count, 3));
      for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
      if (buttons[0]) await userEvent.setup().click(buttons[0]);
      expect(onPick).not.toHaveBeenCalled();
    });
  }
});

/* ═════════ 【大掃描】把「條件掛在沒被取樣的值上」這條路壓窄 ═════════ */

/**
 * 前三次穿透的手法都一樣：自動填的條件掛在**測試從來沒有變動過的維度**上
 * （表單有幾列、claimCount 有沒有超過某個門檻）。上面那個矩陣只取樣 claimCount 的 1 與 999999，
 * 所以 `claimCount === 7` 這種寫法照樣穿得過去。
 *
 * 這一條把那兩個維度改成**掃描**而不是取樣：claimCount 掃 0〜120 與各量級的整數，
 * 代號掃一整段 61xx。射程仍然有限（掃不到的值永遠存在，例如 claimCount === 137），
 * 但「隨手挑一個門檻」這件事已經沒有安全的挑法了。
 */
describe("【大掃描】claimCount 與分類代號各種值，都不會自己選", () => {
  const CLAIM_SWEEP = [
    ...Array.from({ length: 121 }, (_, k) => k),
    500, 1000, 5000, 10000, 100000, 1000000, 999999, Number.MAX_SAFE_INTEGER,
  ];
  const CODE_SWEEP = Array.from({ length: 40 }, (_, k) => String(6100 + k));
  const SWEEP_CATEGORIES: ExpenseCategory[] = CODE_SWEEP.map(expenseCategoryFixture);

  it(`claimCount ${CLAIM_SWEEP.length} 種值 × 代號 ${CODE_SWEEP.length} 種，一次 onPick 都沒有`, async () => {
    const onPick = vi.fn();
    for (const [k, claimCount] of CLAIM_SWEEP.entries()) {
      const code = CODE_SWEEP[k % CODE_SWEEP.length]!;
      respondWith([suggestionApiRow(code, claimCount)]);
      const { unmount } = render(
        <CategorySuggestions
          sellerTaxId={freshTaxId()}
          categories={SWEEP_CATEGORIES}
          disabled={false}
          onPick={onPick}
        />,
      );
      await settle();
      // 按鈕真的畫出來了才算掃到（沒畫出來的話這一輪什麼都沒驗到）
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(onPick, `claimCount=${claimCount} code=${code}`).not.toHaveBeenCalled();
      unmount();
    }
  });

  it(`候選數 0〜8 都不會自己選（伺服端放寬上限也一樣）`, async () => {
    const onPick = vi.fn();
    const codes = Array.from({ length: 8 }, (_, k) => String(6100 + k));
    const cats: ExpenseCategory[] = codes.map(expenseCategoryFixture);
    for (let n = 0; n <= 8; n++) {
      respondWith(codes.slice(0, n).map((c, k) => suggestionApiRow(c, 30 - k)));
      const { unmount } = render(
        <CategorySuggestions sellerTaxId={freshTaxId()} categories={cats} disabled={false} onPick={onPick} />,
      );
      await settle();
      expect(screen.queryAllByRole("button"), `候選 ${n} 個`).toHaveLength(Math.min(n, 3));
      expect(onPick, `候選 ${n} 個`).not.toHaveBeenCalled();
      unmount();
    }
  });
});

/* ═════════ 取數：同一個賣方只問一次 ═════════ */

describe("同一個賣方統編不重複問（批次十幾筆常常是同一家店）", () => {
  it("同一批裡三列同賣方，只送出一個請求，三列都畫得出來", async () => {
    const taxId = freshTaxId();
    respondWith([suggestionApiRow("6133", 12)]);
    const onPick = vi.fn();
    render(
      <>
        {[0, 1, 2].map((k) => (
          <CategorySuggestions key={k} sellerTaxId={taxId} categories={CATEGORIES} disabled={false} onPick={onPick} />
        ))}
      </>,
    );
    await settle();

    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));
    expect(server.calls).toEqual([`/expense-categories/suggestions?sellerTaxId=${taxId}`]);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("第一個請求還沒回來，第二列才掛上去——不會送出第二個請求", async () => {
    const taxId = freshTaxId();
    let release!: (rows: SuggestionApiRow[]) => void;
    server.handler = () => new Promise<SuggestionApiRow[]>((r) => (release = r));
    const onPick = vi.fn();

    const { rerender } = render(
      <div>
        <CategorySuggestions sellerTaxId={taxId} categories={CATEGORIES} disabled={false} onPick={onPick} />
      </div>,
    );
    await settle();
    expect(server.calls).toHaveLength(1);

    rerender(
      <div>
        <CategorySuggestions sellerTaxId={taxId} categories={CATEGORIES} disabled={false} onPick={onPick} />
        <CategorySuggestions sellerTaxId={taxId} categories={CATEGORIES} disabled={false} onPick={onPick} />
      </div>,
    );
    await settle();
    expect(server.calls).toHaveLength(1);

    await act(async () => release([suggestionApiRow("6133", 12)]));
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(2));
    expect(server.calls).toHaveLength(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("不同賣方各問各的", async () => {
    const [a, b] = [freshTaxId(), freshTaxId()];
    respondWith([suggestionApiRow("6133", 12)]);
    render(
      <div>
        <CategorySuggestions sellerTaxId={a} categories={CATEGORIES} disabled={false} onPick={vi.fn()} />
        <CategorySuggestions sellerTaxId={b} categories={CATEGORIES} disabled={false} onPick={vi.fn()} />
      </div>,
    );
    await settle();
    expect([...server.calls].sort()).toEqual(
      [
        `/expense-categories/suggestions?sellerTaxId=${a}`,
        `/expense-categories/suggestions?sellerTaxId=${b}`,
      ].sort(),
    );
  });

  it("問不到就安靜，而且不重試（每動一次表單就重打一次掛掉的端點，比沒有候選更糟）", async () => {
    const taxId = freshTaxId();
    server.handler = async () => Promise.reject(new Error("網路斷了"));
    const { rerender } = render(
      <CategorySuggestions sellerTaxId={taxId} categories={CATEGORIES} disabled={false} onPick={vi.fn()} />,
    );
    await settle();
    expect(server.calls).toHaveLength(1);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/網路斷了|問不到|錯誤/);

    // 重繪（使用者又打了一個字）不重試
    rerender(<CategorySuggestions sellerTaxId={taxId} categories={CATEGORIES} disabled={false} onPick={vi.fn()} />);
    await settle();
    expect(server.calls).toHaveLength(1);
  });

  it("統編形狀不對就不發請求（端點對 8 位數字以外的值回 400，那個錯誤沒有人看得到）", async () => {
    server.handler = async () => [];
    for (const bad of [undefined, "", "1234567", "123456789", "1234567A", "８７６５４３２１"]) {
      const { unmount } = render(
        <CategorySuggestions sellerTaxId={bad} categories={CATEGORIES} disabled={false} onPick={vi.fn()} />,
      );
      await settle();
      unmount();
    }
    expect(server.calls).toEqual([]);
  });

  it("問的路徑帶得出端點檢核得過的統編", async () => {
    const taxId = freshTaxId();
    respondWith([]);
    render(<CategorySuggestions sellerTaxId={taxId} categories={CATEGORIES} disabled={false} onPick={vi.fn()} />);
    await settle();
    const q = new URL(`http://x${server.calls[0]!}`).searchParams.get("sellerTaxId");
    expect(q).toMatch(/^\d{8}$/);
    expect(q).toBe(taxId);
  });
});

/* ═════════ 畫面上到底寫了什麼 ═════════ */

describe("畫面", () => {
  const renderOne = async (rows: SuggestionApiRow[], categories: ExpenseCategory[] | null = CATEGORIES) => {
    respondWith(rows);
    const onPick = vi.fn();
    const view = render(
      <CategorySuggestions sellerTaxId={freshTaxId()} categories={categories} disabled={false} onPick={onPick} />,
    );
    await settle();
    return { ...view, onPick };
  };

  it("沒有候選就一個字都不多（冷啟動不出聲：「目前沒有建議」是純噪音）", async () => {
    const { container } = await renderOne([]);
    expect(container.textContent).toBe("");
    expect(screen.queryByText(/沒有建議|查無|目前沒有/)).toBeNull();
  });

  it("括號裡是**幾張單**，而且那個數字讀得到（前端讀錯欄位名時這裡會變成空白）", async () => {
    await renderOne([suggestionApiRow("6133", 12)]);
    const btn = await screen.findByRole("button", { name: /6133/ });
    expect(btn.textContent).toContain("12 張單");
    expect(btn.textContent).not.toContain("筆）");
    expect(btn.textContent).not.toMatch(/（\s*張單/);
  });

  it("最多三個（端點放寬了也不會把這一列變成一整排按鈕）", async () => {
    await renderOne(CODES.map((c, k) => suggestionApiRow(c, 10 - k)));
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /6137/ })).toBeNull();
  });

  it("順序照伺服端給的（決勝規則在那邊，前端不重排）", async () => {
    await renderOne([suggestionApiRow("6115", 2), suggestionApiRow("6133", 30), suggestionApiRow("6112", 5)]);
    const labels = screen.getAllByRole("button").map((b) => b.textContent!.trim().slice(0, 4));
    expect(labels).toEqual(["6115", "6133", "6112"]);
  });

  it("下拉選單裡沒有的代號不列（按下去會變成「狀態改了、下拉卻顯示請選擇」）", async () => {
    await renderOne([suggestionApiRow("9999", 30), suggestionApiRow("6133", 12)]);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /6133/ })).toBeDefined();
  });

  it("講的是公司過去核准過的單，不是「你」過去選的（端點算的是全公司，沒有依報銷人篩）", async () => {
    const { container } = await renderOne([suggestionApiRow("6133", 12)]);
    expect(container.textContent).toContain("公司過去");
    expect(container.textContent).not.toMatch(/你過去/);
  });

  it("不碰可扣抵性（那件事由同一列的 DeductibleNote 拿本單日期講一次）", async () => {
    const { container } = await renderOne([suggestionApiRow("6133", 12)]);
    expect(container.textContent).not.toContain("可扣抵");
    expect(container.textContent).not.toContain("進項稅");
  });

  it("換了賣方（重拍一張照片）不會留著上一家的歷史", async () => {
    const [a, b] = [freshTaxId(), freshTaxId()];
    server.handler = async (path) => (path.includes(a) ? [suggestionApiRow("6133", 12)] : [suggestionApiRow("6112", 4)]);
    const onPick = vi.fn();
    const { rerender } = render(
      <CategorySuggestions sellerTaxId={a} categories={CATEGORIES} disabled={false} onPick={onPick} />,
    );
    await settle();
    await screen.findByRole("button", { name: /6133/ });

    rerender(<CategorySuggestions sellerTaxId={b} categories={CATEGORIES} disabled={false} onPick={onPick} />);
    await settle();
    await waitFor(() => expect(screen.getByRole("button", { name: /6112/ })).toBeDefined());
    expect(screen.queryByRole("button", { name: /6133/ })).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });
});
