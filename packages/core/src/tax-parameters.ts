/**
 * 稅法參數的「算術」與「解析」——而且只有這兩件事。
 *
 * ★ 本檔刻意不含任何稅率、級距金額、免稅額度與繳納期限。
 *   所有數值都來自使用者在「稅法參數」頁自己填的資料（tax_parameters），
 *   並由使用者自行在來源欄註明依據。理由與 withholding.ts 同一套：
 *   ① 這些數值會變，寫死在程式裡是定時炸彈；
 *   ② 本專案紀律是「法規原文為一級規格」，沒有一級來源就不寫成程式；
 *   ③ 把無法查證的數字寫進程式，等於把猜測包裝成看起來很權威的東西。
 *
 * 因此本檔提供的函式只回答兩個問題：
 *   「課稅基礎 X 落在使用者填的哪一個級距、依那一級的算式乘出來是多少」，以及
 *   「單據日期 D 該用使用者填的哪一列參數」。
 *
 * ⚠️ 本檔的註解與測試一律用**中性數字**（10 萬／30 萬的級距、3.5%／20%／50% 的費率）。
 *   例子裡的數字就是使用者最可能照抄的答案，而這些欄位存在的整個目的
 *   就是逼他自己去查、自己在來源欄留下依據。
 */
import { roundHalfUp } from "./money.ts";
import { BP_PER_UNIT } from "./withholding.ts";

/**
 * 級距的計算形狀。三種 mode 都是**通用的算術，不以任何特定稅制命名**：
 * 命名成「小規模營業人」「營所稅」之類，會讓使用者以為系統知道該用哪一種，
 * 而那正是本批要避免的事——他要自己看懂算式再選。
 *
 * - `exempt`          該級距不課，稅額恆為 0
 * - `rate_on_total`   稅額 = 課稅基礎**全額** × 費率
 * - `rate_of_excess`  稅額 = (課稅基礎 − 該級距起點) × 費率
 */
export const BRACKET_MODES = ["exempt", "rate_on_total", "rate_of_excess"] as const;
export type BracketMode = (typeof BRACKET_MODES)[number];

export const BRACKET_MODE_LABELS: Record<BracketMode, string> = {
  exempt: "不課（稅額 0）",
  rate_on_total: "全額課（稅額 = 全額 × 費率）",
  rate_of_excess: "超額累進（稅額 = 超過起點的部分 × 費率）",
};

export interface TaxBracket {
  /** 級距下界（含），整數元 */
  from: number;
  /** 級距上界（含）；null＝無上限 */
  to: number | null;
  mode: BracketMode;
  /** basis point（萬分之一）：3.5% ＝ 350。mode 為 exempt 時不需要 */
  rateBp?: number | undefined;
}

/** 由小到大排序（不改動輸入陣列）：解析與驗證都以 from 遞增為前提 */
function sorted(brackets: readonly TaxBracket[]): TaxBracket[] {
  return [...brackets].sort((a, b) => a.from - b.from);
}

/**
 * 找出課稅基礎落在哪一級距；找不到回 null。
 *
 * 涵蓋規則：`from <= base` 且 `to === null || base <= to`（**兩端都含**）。
 * 邊界值同時落在兩級時（前一級的 to 等於後一級的 from），取 **from 較大的那一級**——
 * 與口語的「超過 X 者適用下一級」一致，而且讓「剛好等於級距起點」有唯一答案。
 * 沒有這條規則的話，同一個金額會因為陣列順序而算出不同的稅，那種錯誤不會有任何徵兆。
 */
export function findBracket(base: number, brackets: readonly TaxBracket[]): TaxBracket | null {
  let hit: TaxBracket | null = null;
  for (const b of sorted(brackets)) {
    if (b.from <= base && (b.to === null || base <= b.to)) hit = b; // 後面命中的 from 更大，覆蓋前一個
  }
  return hit;
}

/**
 * 依級距計算稅額，四捨五入至整數元（沿用全系統的金額慣例，見 money.ts）。
 *
 * 找不到涵蓋 base 的級距時**丟錯而不是回 0**：0 與「使用者還沒設定這一段」在畫面上
 * 長得一模一樣，而後者放行的後果是一張稅額為 0 的單據靜靜地入帳。
 * 錯誤訊息帶得出脫困路徑（要補哪一段），這是本 repo 對每一道驗證的要求。
 */
export function computeByBrackets(base: number, brackets: readonly TaxBracket[]): number {
  if (!Number.isInteger(base) || base < 0) throw new Error(`課稅基礎須為非負整數元: ${base}`);
  if (brackets.length === 0) {
    throw new Error("這組參數沒有任何級距，算不出稅額（請在稅法參數頁為這一列補上至少一個級距）");
  }
  const bracket = findBracket(base, brackets);
  if (!bracket) {
    throw new Error(
      `課稅基礎 ${base} 沒有落在任何一個級距裡（級距之間可能有空隙，或最高一級漏了「無上限」）。` +
        `請到稅法參數頁補一個涵蓋 ${base} 的級距，或把最高一級的上限留空`,
    );
  }
  if (bracket.mode === "exempt") return 0;
  const rateBp = bracket.rateBp;
  if (rateBp === undefined || rateBp === null) {
    throw new Error(`級距（起點 ${bracket.from}）是課稅級距卻沒有填費率，請回稅法參數頁補上`);
  }
  const taxable = bracket.mode === "rate_of_excess" ? base - bracket.from : base;
  return roundHalfUp((taxable * rateBp) / BP_PER_UNIT);
}

/**
 * 級距的結構驗證：回傳「有問題的地方」清單，空陣列＝可用。
 * 回清單而不是丟第一個錯：使用者一次填好幾個級距，一次只講一個問題會讓他來回好幾趟。
 *
 * 刻意**不驗證**的事：級距金額的合理性、費率的合理性、級距要不要連續。
 * 那些都是稅制內容而不是結構——系統沒有立場說 3.5% 比 50% 合理，
 * 也不知道使用者是不是只想先設定其中一段。
 */
export function validateBrackets(brackets: readonly TaxBracket[]): string[] {
  const problems: string[] = [];
  if (brackets.length === 0) return ["至少要有一個級距"];
  const rows = sorted(brackets);
  rows.forEach((b, i) => {
    const where = `第 ${i + 1} 個級距（起點 ${b.from}）`;
    if (!Number.isInteger(b.from) || b.from < 0) problems.push(`${where}：起點須為非負整數元`);
    if (b.to !== null && (!Number.isInteger(b.to) || b.to < b.from)) {
      problems.push(`${where}：上限須為整數且不小於起點（留空代表無上限）`);
    }
    if (!BRACKET_MODES.includes(b.mode)) problems.push(`${where}：計算方式不明（${String(b.mode)}）`);
    if (b.mode === "exempt") {
      // 填了費率卻選「不課」不是錯誤，但那個費率永遠不會被用到——不講的話使用者會以為它生效了
      if (b.rateBp !== undefined && b.rateBp !== null) {
        problems.push(`${where}：計算方式是「不課」，填的費率不會被使用；請改計算方式或清空費率`);
      }
    } else if (
      b.rateBp === undefined ||
      b.rateBp === null ||
      !Number.isInteger(b.rateBp) ||
      b.rateBp < 0 ||
      b.rateBp > BP_PER_UNIT
    ) {
      // 上限 10000 bp＝100%：打錯一個零（把 3.5% 打成 35%）在設定當下擋掉，
      // 比等到某張單的稅額大得離譜才發現好
      problems.push(`${where}：費率須為 0–100 的百分比（可帶小數），留空只有「不課」才允許`);
    }
    if (i > 0) {
      const prev = rows[i - 1]!;
      if (prev.to === null) {
        problems.push(`${where}：前一個級距已經是「無上限」，它後面不可能再有級距`);
      } else if (b.from < prev.to) {
        // 允許 b.from === prev.to（邊界值歸較高的一級，見 findBracket）；
        // 真正的重疊會讓同一個金額有兩個答案，那是必須擋的
        problems.push(`${where}：與前一個級距（${prev.from}–${prev.to}）重疊`);
      }
    }
  });
  return problems;
}

/**
 * 把一組級距讀成「單一費率」（bp）——不是單一費率就回 null。
 *
 * 為什麼需要這支：營業稅在本系統是交給 `calcTax(net, rate)` 的一個費率，
 * 而不是走級距計算。使用者當然可以在 vat 這一列填出多段級距
 * （例如某些查定課徵的形狀），但那種形狀本系統的進銷貨流程接不上——
 * 這時回 null，由服務層走回退路徑並**明白告訴使用者為什麼**，
 * 而不是默默取第一段的費率當成全部。
 *
 * 認得兩種形狀：單一 `rate_on_total` 級距、單一 `exempt` 級距（＝0）。
 */
export function flatRateBp(brackets: readonly TaxBracket[]): number | null {
  if (brackets.length !== 1) return null;
  const only = brackets[0]!;
  if (only.mode === "exempt") return 0;
  if (only.mode !== "rate_on_total") return null;
  if (only.rateBp === undefined || only.rateBp === null) return null;
  if (!Number.isInteger(only.rateBp) || only.rateBp < 0 || only.rateBp > BP_PER_UNIT) return null;
  return only.rateBp;
}

/** 解析所需的最小欄位形狀（服務層的 drizzle 列與前端的型別都符合） */
export interface TaxParameterLike {
  kind: string;
  scopeKey: string | null;
  validFrom: string; // YYYY-MM-DD
  validTo: string | null; // null＝仍有效
}

/**
 * 找出「生效期間涵蓋 onDate」的那一列。找不到回 null。
 *
 * scopeKey 未給＝找 scopeKey 為 null 的列（例如全公司一個值的營業稅率）；
 * 給了就必須完全相符——**不做「找不到就退回 null scope」的 fallback**：
 * 那會讓「6137 沒設定」靜靜地套用到另一個科目的設定值上，而畫面上看不出來。
 *
 * 期間涵蓋是**兩端都含**：validFrom <= onDate <= (validTo ?? ∞)。
 * 日期一律 YYYY-MM-DD，字串比較即等同日期比較（同長度、零補位），不必轉 Date。
 *
 * 理論上不該有兩列同時涵蓋（服務層在寫入時擋重疊），但萬一有（例如直接改資料庫），
 * 取 validFrom 最晚的那一列：較新的設定勝出，而且結果是決定性的。
 */
export function resolveParameter<T extends TaxParameterLike>(
  rows: readonly T[],
  kind: string,
  onDate: string,
  scopeKey?: string | null,
): T | null {
  const wanted = scopeKey ?? null;
  let hit: T | null = null;
  for (const row of rows) {
    if (row.kind !== kind) continue;
    if ((row.scopeKey ?? null) !== wanted) continue;
    if (row.validFrom > onDate) continue;
    if (row.validTo !== null && row.validTo < onDate) continue;
    if (!hit || row.validFrom > hit.validFrom) hit = row;
  }
  return hit;
}

/** YYYY-MM-DD 的前一天（「接續」操作用）：跨月跨年跨閏日都交給 Date 的 UTC 算術 */
export function dayBefore(isoDate: string): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`日期格式須為 YYYY-MM-DD: ${isoDate}`);
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}
