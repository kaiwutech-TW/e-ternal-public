import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { useT } from "./i18n.ts";
import type { ExpenseCategory } from "./types.ts";

/* ════════════════ 賣方統編 → 歷史分類候選（W7）：攤開來給人看，不替他選 ════════════════
 *
 * 這一支存在的理由是**資料流**，不是排版。
 *
 * 「候選不得自動填進分類」這條紅線先後被三種寫法穿過去（守法都是測試：先是 source-grep、
 * 後來是型別隔離、再後來是 jsdom 行為測試）。三次成功的寫法有一個共同前提：
 * **同一段程式碼同時握著候選清單與寫進明細的能力**（setItem／任何做得出 patch 的東西）。
 * 只要那兩樣東西在同一個作用域裡，「只有一個候選就自動選」「claimCount 夠大就自動選」
 * 就永遠寫得出來，而測試只覆蓋得到被取樣到的組態，攻擊者總挑一個沒被取樣的維度。
 *
 * 所以這一輪不是再加一條測試，是**把資料拿掉**：
 *
 *   ★ 候選資料只存在於這支模組裡。它自己去問端點、自己存快取、自己篩、自己畫按鈕。
 *   ★ 它從外面只收「這一列的賣方統編」與一個 onPick 回呼。
 *   ★ 報銷表單那一層（Expenses.tsx：握著 setItem、知道有幾列、改得動任何欄位的那一層）
 *     的作用域裡**沒有候選清單這個值**——它不知道有幾個候選、不知道 claimCount 多少、
 *     也不知道第一個是誰。於是那三種寫法在那一層不是「測不到」，是**寫不出來**。
 *
 * ★ 這也是為什麼取數不做成可注入的 prop（`fetchOne={…}`）：
 *   父層一旦能提供取數函式，它就能在那個函式裡看見候選清單，紅線立刻退回原狀。
 *   要換掉取數只能從 ./api.ts 這個模組邊界換（測試就是這樣做的）。
 *
 * ★ 模組匯出面**只有元件本身**（外加型別與測試用的快取重置）。篩選與取數都不匯出，
 *   所以「父層 import 一支能算出候選的函式」在編譯期就不成立。
 *
 * 殘餘風險誠實寫在這裡：這支自己同時握著候選與 onPick，所以它**自己**仍然可以在 effect 裡
 * 呼叫 onPick。壓法有兩層——(1) 元件本體小到一眼看得完，除了畫按鈕與 onClick 沒有別的職責；
 * (2) test/expenses-category-suggestions.dom.test.tsx 用組態矩陣（候選數 0〜4、各種 claimCount、
 * 取數中／失敗／空結果、分類清單還沒回來）跑一遍，釘住「沒有點擊就沒有 onPick」。
 */

/**
 * 端點回的一筆候選（形狀由 api/src/services/expenses.ts 的 sellerCategorySuggestions 決定）。
 * 只活在取數的邊界上：離開 loadSellerSuggestions 之前一律被 toSuggestion 換成 CategorySuggestion。
 */
export interface SuggestionApiRow {
  accountCode: string;
  label: string;
  /**
   * **幾張單**這樣歸過（不是幾筆明細）。欄位名與語意都由伺服端決定
   * （sellerCategorySuggestions：`count(distinct claim_id)`）——一張單＝一次被公司接受的
   * 歸類決定，同一張單裡的五筆明細只經過一次核准。
   *
   * ★ 這個名字不是本地品味：前一版伺服端把 count 改名成 claimCount，前端沒跟上，
   *   畫面上那個數字永遠是 undefined（顯示成空白），而兩邊的測試各自捏了自己那一半的欄位名，
   *   誰都測不出來。test/expenses-field-names.test.ts 去讀 apps/api 的原始碼釘住這件事。
   */
  claimCount: number;
}

/**
 * 畫面上的一筆候選。分類代號在這裡叫 `code` 不叫 `accountCode`——
 * 這個換名今天已經不是紅線的主要防線（防線是上面那段資料流），留著的理由是它仍然便宜地
 * 讓「候選這條路上的東西」與「寫得進明細的 patch」在型別上長得不一樣，翻程式碼時一眼分得開。
 */
export interface CategorySuggestion {
  code: string;
  label: string;
  /** 幾張單這樣歸過（語意與欄位名同 SuggestionApiRow.claimCount，換型別時不改名） */
  claimCount: number;
}

/** 取數邊界：API 的形狀 → 畫面的形狀。 */
const toSuggestion = (r: SuggestionApiRow): CategorySuggestion => ({
  code: r.accountCode,
  label: r.label,
  claimCount: r.claimCount,
});

/**
 * 畫面最多列幾個候選。伺服端也有一條上限（SELLER_CATEGORY_LIMIT），這一條是**畫面自己的**：
 * 這幾個鈕是給人掃一眼就按的，端點哪天放寬了也不該讓這一列變成一整排按鈕。
 */
const MAX_CATEGORY_SUGGESTIONS = 3;

/**
 * 8 位數字才問得出去（端點對其他值回 400，見 app.ts）。
 * 形狀不對就**不發請求**，而不是退成一個沒帶統編的路徑換一個沒人看得到的錯誤。
 */
const suggestionsPath = (sellerTaxId: string): string | null =>
  /^\d{8}$/.test(sellerTaxId) ? `/expense-categories/suggestions?sellerTaxId=${sellerTaxId}` : null;

/**
 * 賣方統編 → 那一次問到的答案（**存的是 promise，不是陣列**）。
 *
 * 這份快取要同時擋掉兩種重複：批次一次進來十幾筆常常是同一家店（十幾列同時掛載，
 * 各自去問就是十幾個請求問同一個答案），以及使用者每打一個字造成的重繪。
 * 存 promise 就同時涵蓋「已經有答案」與「還在問」——第二列拿到的是第一列那顆 promise。
 *
 * 問不到（網路斷、500）也留在這裡＝**不重試**：這個掛在每一列上，重試等於使用者每動一次
 * 表單就對同一個掛掉的端點再送一次請求。重新整理頁面（模組重新載入）就會再問一次。
 */
const answers = new Map<string, Promise<CategorySuggestion[]>>();

function loadSellerSuggestions(sellerTaxId: string): Promise<CategorySuggestion[]> {
  const hit = answers.get(sellerTaxId);
  if (hit) return hit;
  const asking = api
    .get<SuggestionApiRow[]>(suggestionsPath(sellerTaxId)!)
    .then((rows) => rows.map(toSuggestion))
    // 問不到就什麼都不顯示：候選是輔助，不是這張單能不能送出的條件，
    // 為它多一條錯誤列只會蓋掉真正擋住送出的那一句。
    .catch(() => []);
  answers.set(sellerTaxId, asking);
  return asking;
}

/**
 * 測試用：清掉上面那份跨元件、跨測試存活的快取。
 *
 * 匯出它不會鬆動紅線（它交不出任何候選資料），但少了它，前一則測試問到的答案會被
 * 下一則沿用——測試會綠，而綠得沒有意義。正式程式碼不該叫它。
 */
export function resetSellerSuggestionsForTests(): void {
  answers.clear();
}

/**
 * 這一列此刻該顯示哪幾個候選。
 *
 * 只留**下拉選單裡也有**的科目：按鈕交出去的是 accountCode，而下拉的 value 就是它——
 * 選單裡沒有這個代號的話，按下去會變成「狀態改了、下拉卻顯示『請選擇』」，
 * 使用者只會以為那個按鈕壞了。兩邊今天同源（core 的 EXPENSE_CATEGORIES），這是防它們哪天不同源。
 * categories 還沒載回來（null）時回空：那時候下拉本來就是空的，沒有東西可以對得起來。
 */
function visibleSuggestions(
  rows: readonly CategorySuggestion[],
  categories: ExpenseCategory[] | null,
): CategorySuggestion[] {
  if (!categories) return [];
  const codes = new Set(categories.map((c) => c.accountCode));
  return rows.filter((r) => codes.has(r.code)).slice(0, MAX_CATEGORY_SUGGESTIONS);
}

/**
 * 這一列的候選：自己去問、自己記得。回傳值**不離開這支模組**（只給下面那個元件畫）。
 *
 * 賣方換了（重拍一張照片、清掉辨識結果）先把上一家的答案清掉，
 * 不然新的答案回來之前，畫面上掛的是別家店的歷史。
 */
function useSellerSuggestions(sellerTaxId: string | undefined): CategorySuggestion[] {
  const [rows, setRows] = useState<CategorySuggestion[]>([]);
  useEffect(() => {
    setRows((prev) => (prev.length === 0 ? prev : []));
    if (!sellerTaxId || suggestionsPath(sellerTaxId) === null) return;
    let alive = true;
    void loadSellerSuggestions(sellerTaxId).then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, [sellerTaxId]);
  return rows;
}

/**
 * 掃完 QR 之後號碼／日期／金額／統編都帶好了，只剩「這筆是什麼」要自己從下拉找。
 * 這裡把這家賣方過去被歸過的分類攤開來——**是候選，不是決定**。
 *
 * ★ 為什麼不替他選：分類決定的是「這筆花費的用途」，而用途不在發票裡也不在照片裡。
 *   同一家便利商店可以是誤餐費、可以是文具、可以是招待客戶。自動填出來的分類跟使用者
 *   自己選的長得一模一樣，錯了要等財務退回、或等到 401 申報時才看得出來。
 *
 * ★ 沒有候選就回 null——冷啟動時畫面上什麼都不多出來。「目前沒有建議」那種話填滿了版面，
 *   卻沒有給使用者任何他還不知道的東西。
 *
 * 這裡只講分類代號、名稱與**幾張單**這樣歸過，**不重複講可扣抵性**：那件事由同一列的
 * DeductibleNote 講，而它是拿本單日期（claimDate）去判定的。在這裡另外講一次，
 * 遲早會變成拿另一個日期講的另一個答案。
 */
export function CategorySuggestions(props: {
  sellerTaxId: string | undefined;
  /** 下拉選單此刻有哪些科目（用來濾掉按下去會落空的代號）。這不是候選資料。 */
  categories: ExpenseCategory[] | null;
  /** 批次上傳期間鎖住：呼叫端的 patch 是 index-based，而批次正在往中間插列 */
  disabled: boolean;
  /** 使用者按了哪一個。只有 onClick 會叫它——沒有點擊就沒有這個呼叫（矩陣測試釘住） */
  onPick: (accountCode: string) => void;
}) {
  const t = useT();
  const rows = visibleSuggestions(useSellerSuggestions(props.sellerTaxId), props.categories);
  if (!props.sellerTaxId || rows.length === 0) return null;
  return (
    <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 4 }}>
      {t("這家賣方（統編 {id}）在公司過去", { id: props.sellerTaxId })}<strong>{t("已核准")}</strong>{t("的報銷單裡被歸過這幾個分類，括號裡是")}<strong>{t("幾張單")}</strong>{t("這樣歸過（同一張單裡的好幾筆只算一次——那是一次被接受的決定）。要用哪一個由你決定（同一家店可以有不同用途，系統不替你挑）：")}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
        {rows.map((s) => (
          <button key={s.code} disabled={props.disabled} className="small" onClick={() => props.onPick(s.code)}>
            {t("{code} {label}（{count} 張單）", { code: s.code, label: s.label, count: s.claimCount })}
          </button>
        ))}
      </div>
    </div>
  );
}
