// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../src/auth.ts";
import { resetSellerSuggestionsForTests } from "../src/CategorySuggestions.tsx";
import type { EInvoiceQr, EInvoiceQrScan } from "../src/einvoice-qr.ts";
import { Expenses } from "../src/pages/Expenses.tsx";
import type { AuthUser, ExpenseCategory } from "../src/types.ts";
import { render, screen, userEvent } from "./dom.ts";
import { expenseCategoryFixture, suggestionApiRow } from "./expenses-fixtures.ts";

/**
 * 報銷表單的**行為**測試：真的把頁面畫出來、真的選檔、真的按按鈕，斷言畫面上的狀態。
 *
 * ★ 為什麼這一支必須存在（而不是繼續用 source-grep）：
 *   這一批工作連續被推翻的原因每次都一樣——紅線由「讀原始碼字面」的測試守著，
 *   而換一種寫法就穿過去。實測記錄：把「只有一個候選就自動選分類」寫在 grep 的區間之外，
 *   tsc 乾淨、138 條測試全綠；把只選一張的捷徑寫成 `files.length < 2`（而不是 `=== 1`），
 *   同樣全綠。grep 守的是**某一種寫法**，不是那個行為。
 *   下面這幾條守的是行為：分類欄位在使用者按下去之前是不是空的、第二張同號的有沒有被擋。
 *
 * ★ 射程（vite.config.ts 的說明同此）：jsdom **沒有 canvas**，readReceiptImage 那條路
 *   （FileReader → Image → drawImage → getImageData → zxing）在這裡跑不起來，
 *   所以它是這支測試唯一 mock 掉的東西——mock 的是「照片變成掃描結果」這個**外部邊界**，
 *   不是被測的邏輯。QR 解碼本身另有自己的測試（test/einvoice-qr.test.ts，餵 RGBA 陣列），
 *   而「相機拍到的東西解不解得出來」靠實機，這裡量不到也不假裝量得到。
 */

/* ─────────────────────────── 影像解碼那個邊界（唯一的 mock） ─────────────────────────── */

const decoder = vi.hoisted(() => ({
  /** 檔名 → 這個檔案「掃出來」是什麼。沒登記的檔名＝讀取途中丟例外（局部失敗那條路） */
  results: new Map<string, { image: string; qr: EInvoiceQr | null; scan: EInvoiceQrScan }>(),
}));

vi.mock("../src/einvoice-qr.ts", () => ({
  readReceiptImage: async (file: File) => {
    const hit = decoder.results.get(file.name);
    if (!hit) throw new Error("影像格式不支援");
    return hit;
  },
}));

const SELLER_TAX_ID = "87654321";
const COMPANY_TAX_ID = "12345678";

/** 一張掃得到唯一左碼的電子發票（reason === "ok"）。同一個號碼要能重複用，所以號碼是參數。 */
function registerScan(fileName: string, invoiceNumber: string): void {
  const qr: EInvoiceQr = {
    invoiceNumber,
    invoiceDate: "2026-07-21",
    salesAmount: 1000,
    totalAmount: 1050,
    buyerTaxId: COMPANY_TAX_ID,
    sellerTaxId: SELLER_TAX_ID,
  };
  decoder.results.set(fileName, {
    image: "data:image/jpeg;base64,AAAA",
    qr,
    scan: { qr, left: `left-${invoiceNumber}`, right: null, lefts: [`left-${invoiceNumber}`], codes: [], reason: "ok" },
  });
}

/* ─────────────────────────── 假的 API（頁面掛載時要問的那幾支） ─────────────────────────── */

const CATEGORY_CODES = ["6112", "6115", "6133", "6137"];
const CATEGORIES: ExpenseCategory[] = CATEGORY_CODES.map(expenseCategoryFixture);

/**
 * 候選的回傳**用共用 fixture 造**（test/expenses-fixtures.ts），不在這裡另捏一份欄位名——
 * 前端讀錯欄位名時這裡就會餵它一個它讀不到的鍵，畫面上的數字直接變成空的（見下面的斷言）。
 */
function installApi(suggestions: Record<string, ReturnType<typeof suggestionApiRow>[]>): void {
  const respond = (body: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/employees" || path === "/accounts" || path === "/expense-claims") return respond([]);
    if (path === "/company-profile") return respond({ taxId: COMPANY_TAX_ID });
    if (path === "/expense-categories") return respond(CATEGORIES);
    if (path === "/expense-categories/suggestions") {
      return respond(suggestions[url.searchParams.get("sellerTaxId") ?? ""] ?? []);
    }
    // 沒登記的端點不靜靜回空陣列：頁面多問了一支而這裡不知道時，要看得見
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: `測試 harness 沒有登記這個端點：${path}` }),
      headers: { get: () => null },
    };
  });
}

const ME: AuthUser = {
  id: 1,
  username: "emp",
  displayName: "王小明",
  // 一般員工：這條路上最沒有議價空間的角色，也是候選功能主要服務的人
  role: "employee",
  employeeId: 7,
  totpEnabled: false,
};

const renderExpenses = () => render(<AuthContext.Provider value={ME}><Expenses /></AuthContext.Provider>);

/* ── 畫面上的查找。用 label 找而不是 querySelector：使用者也是靠這幾個字找到欄位的 ── */
const categorySelects = () => screen.getAllByLabelText(/^這筆是什麼/) as HTMLSelectElement[];
const amountInputs = () => screen.getAllByLabelText(/^金額/) as HTMLInputElement[];
const fileInputs = () => screen.getAllByLabelText(/^單據照片/) as HTMLInputElement[];

const upload = async (rowIndex: number, fileName: string) => {
  const file = new File(["fake"], fileName, { type: "image/jpeg" });
  await userEvent.setup().upload(fileInputs()[rowIndex]!, file);
};

afterEach(() => {
  vi.unstubAllGlobals();
  decoder.results.clear();
  // 候選的快取活在 src/CategorySuggestions.tsx 的模組層（跨列共用，才問得只剩一次）——
  // 不清掉的話，下一則測試看到的是上一則那個賣方問到的答案，而畫面上完全看不出來
  resetSellerSuggestionsForTests();
});

/* ═══════════════════ 【①】候選不會自動變成分類 ═══════════════════ */

describe("【①】歷史分類候選：攤開來給人看，不替他選", () => {
  it("只有一個候選也不自動填——沒有點下去，分類欄位就是空的", async () => {
    // 「只有一個」正是那個好意最想成立的情形：看起來沒有別的選擇，幫他填掉不是很順嗎
    installApi({ [SELLER_TAX_ID]: [suggestionApiRow("6133", 12)] });
    registerScan("a.jpg", "AB10000001");
    renderExpenses();
    await upload(0, "a.jpg");

    // 等候選真的出現在畫面上（沒有這一步，下面那條斷言會因為「還沒問到」而假綠）
    const pick = await screen.findByRole("button", { name: /6133/ });

    // ★ 紅線：一個點擊都還沒發生，分類仍然是「請選擇」
    expect(categorySelects()[0]!.value).toBe("");

    // 【③】順帶釘住欄位名：前端讀錯鍵的話這裡是「（ 張單）」，數字整個不見
    expect(pick.textContent).toContain("12 張單");
    expect(pick.textContent).not.toContain("筆）");

    // 使用者自己按下去，才寫進分類
    await userEvent.setup().click(pick);
    expect(categorySelects()[0]!.value).toBe("6133");
  });

  it("有多個候選時同樣不自動選（也不預選最常用的那一個）", async () => {
    installApi({
      [SELLER_TAX_ID]: [suggestionApiRow("6133", 30), suggestionApiRow("6112", 5), suggestionApiRow("6115", 2)],
    });
    registerScan("a.jpg", "AB10000002");
    renderExpenses();
    await upload(0, "a.jpg");

    await screen.findByRole("button", { name: /6133/ });
    expect(screen.getByRole("button", { name: /6112/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /6115/ })).toBeDefined();
    expect(categorySelects()[0]!.value).toBe("");

    // 按的是排在後面、單據數最少的那一個——寫進去的是他點的，不是「看起來像答案」的第一個
    await userEvent.setup().click(screen.getByRole("button", { name: /6115/ }));
    expect(categorySelects()[0]!.value).toBe("6115");
  });

  it("按候選只碰分類這一欄：金額與辨識結果原封不動", async () => {
    installApi({ [SELLER_TAX_ID]: [suggestionApiRow("6133", 12)] });
    registerScan("a.jpg", "AB10000003");
    renderExpenses();
    await upload(0, "a.jpg");

    const pick = await screen.findByRole("button", { name: /6133/ });
    expect(amountInputs()[0]!.value).toBe("1050"); // QR 上的總額
    await userEvent.setup().click(pick);
    expect(amountInputs()[0]!.value).toBe("1050");
    expect(screen.getByText(/已辨識：發票 AB10000003/)).toBeDefined();
  });

  it("沒有歷史的賣方，畫面上一個字都不多（冷啟動不出聲）", async () => {
    installApi({}); // 端點回空陣列＝這家店沒有被歸過
    registerScan("a.jpg", "AB10000004");
    renderExpenses();
    await upload(0, "a.jpg");

    await screen.findByText(/已辨識：發票 AB10000004/);
    expect(screen.queryByText(/被歸過這幾個分類/)).toBeNull();
    expect(categorySelects()[0]!.value).toBe("");
  });
});

/* ═══════════════════ 【①-b】列數這個維度用掃的，不是取樣 ═══════════════════ */

/**
 * 前一次穿透就是把自動填的條件掛在「表單有幾列」上——而測試從頭到尾只跑過一列的表單。
 * 這一條把那個維度掃過去：一列、兩列……六列，每加一列就檢查一次分類欄位。
 *
 * 為什麼這一條放在**頁面層**而不是元件層：列數只有這一層知道（元件根本收不到它）。
 * 也就是說，這條測試要抓的東西，今天必須由這一層自己重新去問端點才寫得出來——
 * 那件事另有 test/expenses-suggestions-dataflow.test.ts 在盯（見那支的射程說明）。
 */
describe("【①-b】不論表單上有幾列，分類都不會自己被填上", () => {
  it("從一列加到六列，每一步分類欄位都還是「請選擇」", async () => {
    installApi({ [SELLER_TAX_ID]: [suggestionApiRow("6133", 12)] });
    registerScan("a.jpg", "AB10000010");
    renderExpenses();
    await upload(0, "a.jpg");
    await screen.findByRole("button", { name: /6133/ });

    const user = userEvent.setup();
    for (let rows = 1; rows <= 6; rows++) {
      // 每一列都檢查（不是只看第一列）：自動填有可能掛在「最後一列」或「第 k 列」上
      for (const [k, sel] of categorySelects().entries()) {
        expect(sel.value, `表單 ${rows} 列時的第 ${k + 1} 列`).toBe("");
      }
      expect(categorySelects()).toHaveLength(rows);
      if (rows < 6) await user.click(screen.getByRole("button", { name: "＋再加一張" }));
    }

    // 掃完之後那個候選鈕仍然在，而且按下去照樣只寫他點的那一個——掃描沒有把功能掃掉
    await user.click(screen.getByRole("button", { name: /6133/ }));
    expect(categorySelects()[0]!.value).toBe("6133");
    expect(categorySelects()[1]!.value).toBe("");
  });
});

/* ═══════════════════ 【②】只選一張也要走同號防重 ═══════════════════ */

describe("【②】同號防重：一張也是一批", () => {
  it("先選一張、再單獨選一張同號的——第二張被擋下，而且講得出跟誰重複", async () => {
    installApi({});
    registerScan("a.jpg", "AB10000001");
    registerScan("b.jpg", "AB10000001"); // 同一張發票（重複選到同一個檔案，或同一張拍了兩次）
    renderExpenses();

    // 第一張：一張一張加的人走的就是這條路（不是一次選十張）
    await upload(0, "a.jpg");
    await screen.findByText(/已辨識：發票 AB10000001/);

    // 再開一列，把同號的那張單獨選進去
    await userEvent.setup().click(screen.getByRole("button", { name: "＋再加一張" }));
    await upload(1, "b.jpg");

    const blocked = await screen.findByText(/與表單上已經有的明細相同/);
    expect(blocked.textContent).toContain("AB10000001"); // 是哪一個號碼
    expect(blocked.textContent).toContain("b.jpg"); // 是哪一張照片
    // 沒有帶入：發票欄位與金額都留在原狀，使用者不會以為它進去了
    expect(amountInputs()[1]!.value).toBe("0");
    // 而且畫面上只有一筆帶著這個號碼——送出去才不會被伺服端 422 把整張單退回
    expect(screen.getAllByText(/已辨識：發票 AB10000001/)).toHaveLength(1);
  });

  /**
   * 【④】第一張讀不進來時，使用者原本站著的那一列**留著**（那是上一輪修對的行為）——
   * 但它同時被排除在防重之外，於是同一批後面的檔案可以帶著跟它相同的號碼過關，
   * 伺服端 422 把整張單退回。這一條走的是完整的畫面路徑：那一列真的留著，而且真的還算數。
   */
  it("第一張讀不進來、原本那一列留著時，同一批後面的檔案照樣比得到它", async () => {
    installApi({});
    registerScan("first.jpg", "AB10000001");
    registerScan("dup.jpg", "AB10000001");
    // boom.jpg 沒有登記＝讀取途中丟例外（手機拍的 HEIC、壞檔）
    renderExpenses();

    await upload(0, "first.jpg");
    await screen.findByText(/已辨識：發票 AB10000001/);

    // 同一列再選兩張：第一張讀不進來（原本那一列因此留著），第二張跟它同號
    const files = ["boom.jpg", "dup.jpg"].map((name) => new File(["fake"], name, { type: "image/jpeg" }));
    await userEvent.setup().upload(fileInputs()[0]!, files);

    await screen.findByText(/boom.jpg：這張沒有讀進來/);
    const blocked = await screen.findByText(/與表單上已經有的明細相同/);
    expect(blocked.textContent).toContain("dup.jpg");
    expect(blocked.textContent).toContain("AB10000001");
    // 原本那一列還在（沒有被讀失敗的那一張連坐清掉），而且全表只有它帶著這個號碼
    expect(screen.getAllByText(/已辨識：發票 AB10000001/)).toHaveLength(1);
  });

  it("號碼不同就不會被誤擋（防重不是「第二張一律擋」）", async () => {
    installApi({});
    registerScan("a.jpg", "AB10000001");
    registerScan("b.jpg", "AB10000002");
    renderExpenses();

    await upload(0, "a.jpg");
    await screen.findByText(/已辨識：發票 AB10000001/);
    await userEvent.setup().click(screen.getByRole("button", { name: "＋再加一張" }));
    await upload(1, "b.jpg");

    await screen.findByText(/已辨識：發票 AB10000002/);
    expect(screen.queryByText(/與表單上已經有的明細相同/)).toBeNull();
    expect(amountInputs()[1]!.value).toBe("1050");
  });
});
