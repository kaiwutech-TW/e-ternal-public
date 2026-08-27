/**
 * 稅法參數：使用者自己查證、自己填、自己註明依據的稅率／級距／布林旗標，帶生效期間。
 * 規格與界線見 docs/specs/tax-parameters.md。
 *
 * ★ 本模組的設計紀律（使用者已拍板，違反者一律重做）：
 *   **系統絕不斷言任何稅率、免稅額度、繳納期限或憑單格式代號。**
 *   程式提供結構與算術，不提供答案。因此這裡沒有任何稅率常數、沒有級距金額、
 *   沒有「這一類應該要 X%」的判斷，連錯誤訊息與範例都用中性數字（3.5%、10 萬）——
 *   例子裡的數字就是使用者最可能照抄的答案。
 *
 * ★ **append-only**：這張表只新增、不覆寫、不刪除。
 *   理由是舊年度必須算得回來：核定通知或更正申報可能兩三年後才來，那時要重算的是
 *   「當年那個費率下的數字」。參數列被覆寫的那一刻，過去每一張單據的稅額就變成
 *   查不出來歷的孤兒——帳上寫 50，系統現在算 40，沒有任何地方解釋得了 50 是怎麼來的。
 *   唯一允許改動舊列的情形是「接續」（supersedePrevious）：把前一列的 valid_to
 *   設為新列 valid_from 的前一天，而且**只動 valid_to**。
 *
 * ★ 回退（fallback）不得靜默：解析不到涵蓋該日期的參數時，建單不會失敗
 *   （那會讓沒設定過參數的新資料庫連第一張單都開不出來），但一定在回應裡帶警告，
 *   明白說出「用的是既有預設值，不是你查證的結果」。
 */
import {
  VAT_RATE_FALLBACK,
  BP_PER_UNIT,
  dayBefore,
  flatRateBp,
  resolveParameter,
  validateBrackets,
  type TaxBracket,
} from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { tr } from "../i18n.ts";

/** 系統自己會去讀的 kind。使用者仍可自訂其他 kind（維護頁依 kind 分組列出） */
export const TAX_PARAMETER_KINDS = {
  /** 營業稅率：單一費率（一個涵蓋全區間的 rate_on_total 級距），進銷貨與發票取它 */
  VAT: "vat",
  /** 營所稅級距：**系統不計算營所稅**，這個 kind 只是讓你把查到的規則記下來 */
  INCOME_TAX: "income_tax",
  /** 未分配盈餘：同上，只記錄不計算 */
  UNDISTRIBUTED_EARNINGS: "undistributed_earnings",
  /** 報銷分類的進項稅可否扣抵：scope_key＝費用科目代號，bool_value＝可否扣抵 */
  INPUT_TAX_DEDUCTIBLE: "input_tax_deductible",
} as const;

/** 這兩種 kind 系統只保管、不計算——維護頁與 API 都要講清楚，免得使用者以為存了就會自動報稅 */
export const RECORD_ONLY_KINDS: readonly string[] = [
  TAX_PARAMETER_KINDS.INCOME_TAX,
  TAX_PARAMETER_KINDS.UNDISTRIBUTED_EARNINGS,
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface TaxParameterInput {
  kind: string;
  scopeKey?: string | null | undefined;
  label: string;
  validFrom: string;
  validTo?: string | null | undefined;
  brackets?: TaxBracket[] | null | undefined;
  boolValue?: boolean | null | undefined;
  sourceNote?: string | null | undefined;
  /**
   * 接續：自動把同一 (kind, scopeKey) 中「仍涵蓋 validFrom」的前一列 valid_to
   * 設為 validFrom 的前一天。這是唯一允許改動舊列的操作，而且只動 valid_to。
   */
  supersedePrevious?: boolean | undefined;
}

function assertShape(input: TaxParameterInput): void {
  const hasBrackets = input.brackets !== null && input.brackets !== undefined;
  const hasBool = input.boolValue !== null && input.boolValue !== undefined;
  if (hasBrackets === hasBool) {
    throw new AppError(
      422,
      hasBrackets
        ? "一列參數只能有一種值：級距與是／否二選一。兩種都填的話取數時無從決定要看哪一個，而那個歧義只會在幾個月後某張單據算錯時才浮出來"
        : "這一列沒有值：級距型參數請至少填一個級距，是／否型參數請選「是」或「否」",
    );
  }
  if (!ISO_DATE.test(input.validFrom)) throw new AppError(422, "生效起日須為 YYYY-MM-DD: {value}", { value: input.validFrom });
  if (input.validTo != null) {
    if (!ISO_DATE.test(input.validTo)) throw new AppError(422, "生效迄日須為 YYYY-MM-DD: {value}", { value: input.validTo });
    if (input.validTo < input.validFrom) {
      throw new AppError(
        422,
        "生效迄日 {to} 早於起日 {from}：這一列會永遠解析不到任何日期，而畫面上它看起來跟正常的列一樣。迄日留空代表「仍有效」",
        { to: input.validTo, from: input.validFrom },
      );
    }
  }
  if (hasBrackets) {
    const problems = validateBrackets(input.brackets!);
    if (problems.length > 0) throw new AppError(422, "級距設定有問題：{problems}", { problems: problems.join("；") });
  }
}

function periodText(row: { validFrom: string; validTo: string | null }): string {
  return `${row.validFrom} ~ ${row.validTo ?? "（仍有效）"}`;
}

/** 兩段期間（迄日 null＝無限）是否相交 */
function overlaps(
  a: { validFrom: string; validTo: string | null },
  b: { validFrom: string; validTo: string | null },
): boolean {
  const aTo = a.validTo ?? "9999-12-31";
  const bTo = b.validTo ?? "9999-12-31";
  return a.validFrom <= bTo && b.validFrom <= aTo;
}

async function siblings(db: Db, kind: string, scopeKey: string | null) {
  return db
    .select()
    .from(schema.taxParameters)
    .where(
      and(
        eq(schema.taxParameters.kind, kind),
        scopeKey === null
          ? isNull(schema.taxParameters.scopeKey)
          : eq(schema.taxParameters.scopeKey, scopeKey),
      ),
    )
    .orderBy(asc(schema.taxParameters.validFrom), asc(schema.taxParameters.id));
}

export async function createParameter(db: Db, input: TaxParameterInput, userId: number) {
  assertShape(input);
  const scopeKey = input.scopeKey ?? null;
  const label = input.label.trim();
  if (!label) throw new AppError(422, "請給這一列一個看得懂的名稱（例如「營業稅率」「6137 交際費可否扣抵」）");

  return db.transaction(async (tx) => {
    const existing = await siblings(tx, input.kind, scopeKey);

    // 只能往未來延伸：新列的生效起日必須晚於同一參數的每一列。
    //
    // 為什麼要擋：append-only 只守住了「值」——沒有列被刪、每一列的值都還在——
    // 但它沒守住「那一天該用哪個值」，而後者才是這張表存在的理由。
    // 對抗驗證實測過：在 [1900-01-01~null @500] 之上插一列 validFrom=1900-01-02 並接續，
    // 一次呼叫就讓資料庫裡每一張既有單據的費率解析變成另一個值（歷史沒被刪，但不再算得回來）。
    // 補建歷史費率是正當需求，做法是**由舊到新依序新增**，每一列都晚於前一列。
    const latest = existing[existing.length - 1];
    // 用嚴格小於：同日的情形交給下方接續分支處理，那裡的訊息指路更具體（怎麼更正填錯的那一列）
    if (latest && input.validFrom < latest.validFrom) {
      throw new AppError(
        422,
        "新列的生效起日 {from} 早於既有的第 #{id} 列（{latestFrom} 起）。參數只能往未來延伸——往回插一列會改變「過去某一天該用哪個值」，等於讓已經算過的年度算不回來。若你正在補建歷史費率，請由舊到新依序新增；若要更正的是既有那一列的值，請新增一列從「更正生效日」起接續，並在依據來源欄寫明更正了哪一列",
        { from: input.validFrom, id: latest.id, latestFrom: latest.validFrom },
      );
    }

    // 接續：只動前一列的 valid_to，不動它的值、來源與輸入者（append-only 的唯一例外）
    let superseded: { id: number; label: string; newValidTo: string } | null = null;
    if (input.supersedePrevious) {
      // 「前一列」＝生效起日早於新列、且期間仍涵蓋（或延伸到）新列起日的那一列。
      // 取起日最晚的一筆：中間可能還有更早、已經被接續過的列，那些不該再動
      const candidates = existing.filter(
        (r) => r.validFrom < input.validFrom && (r.validTo === null || r.validTo >= input.validFrom),
      );
      const prev = candidates[candidates.length - 1];
      if (!prev) {
        const sameDay = existing.find((r) => r.validFrom === input.validFrom);
        if (sameDay) {
          throw new AppError(
            422,
            "找不到可接續的前一列：第 #{id} 列的生效起日與新列同為 {from}，接續會把它的迄日設成起日的前一天（期間顛倒）。本表刻意 append-only——舊年度必須算得回來，所以不提供「改掉填錯的那一列」。若這一列從第一天就填錯，請新增一列從「更正生效日」起接續，並在依據來源欄寫明「更正第 #{id} 列」；已依錯誤值建立的單據不會回頭重算，需要更正的請自行判斷處理方式（沖銷重開或手工傳票）",
            { id: sameDay.id, from: input.validFrom },
          );
        }
        throw new AppError(
          422,
          "找不到可接續的前一列（同一種參數在 {from} 之前沒有仍生效的設定）。這是第一列的話請取消「接續前一列」直接新增",
          { from: input.validFrom },
        );
      }
      const newValidTo = dayBefore(input.validFrom);
      await tx
        .update(schema.taxParameters)
        .set({ validTo: newValidTo })
        .where(eq(schema.taxParameters.id, prev.id));
      superseded = { id: prev.id, label: prev.label, newValidTo };
    }

    // 重疊檢查在接續之後：接續本來就是為了把重疊消掉，先檢查會把合法的接續擋下來
    const after = await siblings(tx, input.kind, scopeKey);
    const wanted = { validFrom: input.validFrom, validTo: input.validTo ?? null };
    const conflict = after.find((r) => overlaps(r, wanted));
    if (conflict) {
      throw new AppError(
        422,
        "生效期間與第 #{id} 列「{label}」（{period}）重疊。同一種參數在同一天只能有一個值，否則單據要用哪一個沒有答案。若這是新費率取代舊費率，請勾選「接續前一列」——系統會把第 #{id} 列的迄日設為 {dayBefore}，舊列的值與依據都原樣保留",
        { id: conflict.id, label: conflict.label, period: periodText(conflict), dayBefore: dayBefore(input.validFrom) },
      );
    }

    const [row] = await tx
      .insert(schema.taxParameters)
      .values({
        kind: input.kind,
        scopeKey,
        label,
        validFrom: input.validFrom,
        validTo: input.validTo ?? null,
        brackets: input.brackets ?? null,
        boolValue: input.boolValue ?? null,
        sourceNote: input.sourceNote?.trim() || null,
        enteredBy: userId,
      })
      .returning();
    return { ...row!, superseded };
  });
}

/**
 * 全部列出，含**已失效的列**。
 * append-only 的價值就在歷史看得到：隱藏舊列等於把「當年是照什麼算的」藏起來，
 * 那正是這張表存在的理由。狀態由 asOf 推導，前端據此標示（標示，不隱藏）。
 */
export async function listParameters(db: Db, asOf?: string) {
  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(schema.taxParameters)
    .orderBy(
      asc(schema.taxParameters.kind),
      asc(schema.taxParameters.scopeKey),
      asc(schema.taxParameters.validFrom),
      asc(schema.taxParameters.id),
    );
  const users = await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users);
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));
  return rows.map((r) => ({
    ...r,
    enteredByName: r.enteredBy === null ? null : (nameOf.get(r.enteredBy) ?? `#${r.enteredBy}`),
    status: r.validFrom > today ? "future" : r.validTo !== null && r.validTo < today ? "expired" : "active",
  }));
}

// --- 系統實際取用參數的兩條路徑 ---

export interface VatRateResolution {
  /** basis point（萬分之一）：3.5% ＝ 350 */
  rateBp: number;
  /** 給 calcTax 用的小數費率 */
  rate: number;
  /** 用到的參數列；回退時為 null */
  parameterId: number | null;
  /** true＝沒有解析到參數，用的是既有預設值 */
  fallback: boolean;
  /** 一律原樣回給前端顯示：回退**不可靜默** */
  notes: string[];
}

function fallbackResolution(reason: string): VatRateResolution {
  return {
    rateBp: Math.round(VAT_RATE_FALLBACK * BP_PER_UNIT),
    rate: VAT_RATE_FALLBACK,
    parameterId: null,
    fallback: true,
    notes: [
      tr(
        "{reason}本單暫以系統既有的預設值計稅。這個預設值是本系統在「稅法參數」功能出現前一直在用的那個數字，**不是本專案查證的結果**——請到「稅法參數」頁新增一列營業稅率，填入你查到的費率與依據來源。補設參數不會回頭重算已建立的單據。",
        { reason },
      ),
    ],
  };
}

/**
 * 依單據日期解析營業稅率。
 *
 * 為什麼是「單據日期」而不是「今天」：費率變動時，跨期間的單據必須照它自己那一天的費率算，
 * 否則補一張上個月的單就會用到這個月的費率，而帳上看不出差別。
 *
 * 為什麼回退而不是擋下建單：空的參數表（全新資料庫）或早於最早生效日的日期（補舊單）
 * 都不該讓系統壞掉——擋下的話使用者連第一張單都開不出來，而錯誤訊息指向的設定頁
 * 對「只想先試用看看」的人是一道死牆。代價是必須**大聲**：notes 一路回到畫面上。
 */
export async function resolveVatRate(db: Db, onDate: string): Promise<VatRateResolution> {
  const rows = await db
    .select()
    .from(schema.taxParameters)
    .where(eq(schema.taxParameters.kind, TAX_PARAMETER_KINDS.VAT));
  const hit = resolveParameter(rows, TAX_PARAMETER_KINDS.VAT, onDate, null);
  if (!hit) return fallbackResolution(tr("找不到生效期間涵蓋 {onDate} 的營業稅率設定，", { onDate }));
  if (!hit.brackets) {
    return fallbackResolution(tr("營業稅率設定第 #{id} 列沒有級距內容（可能是是／否型的參數放錯 kind），", { id: hit.id }));
  }
  const rateBp = flatRateBp(hit.brackets);
  if (rateBp === null) {
    // 使用者填了多段級距（例如某種查定課徵的形狀）。進銷貨流程接的是單一費率，
    // 這裡默默取第一段會算出一個看起來很正常卻沒人說得出來歷的稅額
    return fallbackResolution(
      tr("營業稅率設定第 #{id} 列「{label}」不是單一費率（有多個級距，或最上層的計算方式不是「全額課」），而進銷貨與發票流程只接得上單一費率，", {
        id: hit.id,
        label: hit.label,
      }),
    );
  }
  return { rateBp, rate: rateBp / BP_PER_UNIT, parameterId: hit.id, fallback: false, notes: [] };
}

export interface DeductibleResolution {
  deductible: boolean;
  /** 'parameter'＝使用者在稅法參數頁設定的值；'default'＝core 的 EXPENSE_CATEGORIES 預設值 */
  source: "parameter" | "default";
  parameterId: number | null;
  sourceNote: string | null;
  validFrom: string | null;
  validTo: string | null;
}

/**
 * 報銷分類的進項稅可否扣抵：先查使用者設定，查不到才用 core 的**預設值**。
 *
 * 為什麼分類清單留在 core、只有這個布林值可覆寫：分類清單餵養 SYSTEM_ACCOUNT_CODES
 * （＝哪些科目停不掉、改不了碼），搬成資料會讓使用者刪一個分類就解除一個科目的保護
 * （理由完整寫在 packages/core/src/chart.ts 的 EXPENSE_CATEGORIES 註解）。
 * 可扣抵性則純粹是稅法參數，與結構無關——它才是該由使用者查證後填入、附依據來源的那一半。
 */
export async function resolveDeductible(
  db: Db,
  accountCode: string,
  onDate: string,
  fallbackValue: boolean,
): Promise<DeductibleResolution> {
  const rows = await db
    .select()
    .from(schema.taxParameters)
    .where(eq(schema.taxParameters.kind, TAX_PARAMETER_KINDS.INPUT_TAX_DEDUCTIBLE));
  const hit = resolveParameter(rows, TAX_PARAMETER_KINDS.INPUT_TAX_DEDUCTIBLE, onDate, accountCode);
  if (!hit || hit.boolValue === null) {
    return {
      deductible: fallbackValue,
      source: "default",
      parameterId: null,
      sourceNote: null,
      validFrom: null,
      validTo: null,
    };
  }
  return {
    deductible: hit.boolValue,
    source: "parameter",
    parameterId: hit.id,
    sourceNote: hit.sourceNote,
    validFrom: hit.validFrom,
    validTo: hit.validTo,
  };
}

/**
 * 依單據自己的費率快照解析——找不到快照才退回依日期解析參數。
 *
 * 為什麼要有這支：任何「讀取時再依日期解析費率」的路徑，都會在新增一列參數之後
 * **追溯改掉已落地單據的推導結果**（401 的 B2C 拆算實測從稅額 50 變 175，
 * 而發票 XML 與總帳 2288 都還是 50，三者互不相符且畫面上零徵兆）。
 * 單據建立當下存下 vat_rate_bp，之後一律用它，參數怎麼改都動不到歷史。
 * 快照為 NULL 的是本欄位出現前建立的舊單，只能退回依日期解析（並帶回警告）。
 */
export async function rateFromSnapshot(
  db: Db,
  snapshotBp: number | null,
  fallbackDate: string,
): Promise<VatRateResolution> {
  if (snapshotBp !== null) {
    return { rateBp: snapshotBp, rate: snapshotBp / BP_PER_UNIT, parameterId: null, fallback: false, notes: [] };
  }
  const resolved = await resolveVatRate(db, fallbackDate);
  return {
    ...resolved,
    notes: [
      ...resolved.notes,
      tr(
        "這張單據沒有費率快照（建立於本功能之前），稅額是依 {fallbackDate} 重新解析參數推導的——若參數在那之後被新增或接續過，推導結果可能與當初入帳的金額不一致。",
        { fallbackDate },
      ),
    ],
  };
}
