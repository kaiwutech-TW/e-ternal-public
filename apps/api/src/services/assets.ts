/**
 * 固定資產＋自動折舊（缺口第二層批次 A；B14 三重失準修正於第三批）。
 * - 登錄不拋轉取得傳票（取得入帳走進貨/手工傳票，與庫存開帳同哲學），本模組管折舊與處分
 * - 每月計提：平均法，啟用日當月起提；(成本−殘值)÷(年×12) 四捨五入，末期以剩餘可折金額收斂
 * - 冪等：asset×period 唯一，重跑同期間只補漏提的資產（例如期中新登錄）
 * - 處分（B14 修正後）：
 *   (a) 成本未入帳先擋（422 指路補取得傳票）——登錄不入帳、處分卻沖帳的不對稱，
 *       原本會把資產科目打成負數而 balanced 照樣為 true
 *   (b) 價款拆「未稅＋銷項稅額」（taxable 預設 true、proceedsIncludeTax 預設 true；
 *       費率依處分日由 tax_parameters 解析，回退不靜默），處分損益以**未稅**價款對帳面計
 *   (c) 折舊截止＝處分當月（與「啟用日當月起提」對稱）：處分時自動補提
 *       啟用月～處分月之間漏提的期間，補提傳票以處分日入帳（原期間可能已關）
 * - 修改（PATCH）：未提折舊可改基本資料（成本打錯不再只能假處分）；
 *   已提折舊後只可改名稱與備註——改成本／年限／殘值會讓已提各期金額無法解釋
 */
import {
  ACCOUNT,
  ASSET_CATEGORIES,
  DEPRECIATION_EXPENSE_CODE,
  DISPOSAL_GAIN_CODE,
  DISPOSAL_LOSS_CODE,
  calcTax,
  defaultSalvage,
  monthlyDepreciation,
  roundHalfUp,
} from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { assertMonthNotFuture, assertNotFarFuture } from "./dates.ts";
import { issueDisposalInvoiceCore, type DisposalIssueInput } from "./invoices.ts";
import { assertPeriodOpen } from "./period.ts";
import { resolveVatRate } from "./tax-parameters.ts";

const CATEGORY_BY_KEY = new Map(ASSET_CATEGORIES.map((c) => [c.key, c]));

export interface AssetInput {
  name: string;
  category: string;
  cost: number;
  startDate: string;
  usefulYears?: number | undefined; // 未填則用類別預設
  salvage?: number | undefined; // 未填則 成本/(年數+1)
  memo?: string | undefined;
}

async function accountIdByCode(db: Db, codes: string[]): Promise<Map<string, number>> {
  const rows = await db.select().from(schema.accounts).where(inArray(schema.accounts.code, codes));
  const map = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of codes) if (!map.has(code)) throw new AppError(500, `科目未初始化: ${code}（請重跑 migrate/seed）`);
  return map;
}

export async function createAsset(db: Db, input: AssetInput, createdBy: number) {
  const category = CATEGORY_BY_KEY.get(input.category);
  if (!category) throw new AppError(422, `資產類別不存在: ${input.category}`);
  const usefulYears = input.usefulYears ?? category.years;
  const salvage = input.salvage ?? defaultSalvage(input.cost, usefulYears);
  if (salvage >= input.cost) throw new AppError(422, "殘值不得大於等於取得成本");
  const [row] = await db
    .insert(schema.fixedAssets)
    .values({
      name: input.name,
      category: category.key,
      assetCode: category.assetCode,
      accumCode: category.accumCode,
      cost: input.cost,
      salvage,
      usefulYears,
      startDate: input.startDate,
      memo: input.memo ?? "",
      createdBy,
    })
    .returning();
  return row!;
}

export async function listAssets(db: Db) {
  const assets = await db.select().from(schema.fixedAssets);
  const deps = await db.select().from(schema.assetDepreciations);
  return assets
    .map((a) => {
      const mine = deps.filter((d) => d.assetId === a.id);
      const accumulated = mine.reduce((s, d) => s + d.amount, 0);
      const lastPeriod = mine.map((d) => d.period).sort().at(-1) ?? null;
      return {
        ...a,
        categoryLabel: CATEGORY_BY_KEY.get(a.category)?.label ?? a.category,
        accumulated,
        bookValue: a.cost - accumulated,
        monthly: monthlyDepreciation(a.cost, a.salvage, a.usefulYears),
        remainingDepreciable: Math.max(0, a.cost - a.salvage - accumulated),
        lastPeriod,
      };
    })
    .sort((a, b) => b.id - a.id);
}

/**
 * 折舊明細表（gap 3.7，0035 批）：營所稅結算申報「固定資產及折舊明細表」的取數底稿，
 * 也是期中查「這台車今年提了多少」的地方。每資產一列：
 * 期初累計折舊（至上年末）＋本年度折舊（含處分時補提到本年的期間）＝期末累計折舊，
 * 帳面淨值＝成本−期末累計折舊。
 * - 已作廢的資產不列（登錄本身是錯的，沒有帳）；已處分的照列並標處分日——
 *   年度中處分的資產在申報明細表上仍要出現。
 * - 只列「該年度已啟用」的資產（啟用日 ≤ 年末）；數字全部取自 asset_depreciations
 *   已入帳的期間，不是理論值——漏提的月份這張表就是看得出來少，這是底稿的意義。
 */
export async function depreciationSchedule(db: Db, year: number) {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new AppError(400, `year 須為四位數西元年（收到「${year}」）`);
  }
  const yearEnd = `${year}-12-31`;
  const assets = await db.select().from(schema.fixedAssets).where(isNull(schema.fixedAssets.voidedAt));
  const deps = await db.select().from(schema.assetDepreciations);
  const byAsset = new Map<number, typeof deps>();
  for (const d of deps) {
    const list = byAsset.get(d.assetId) ?? [];
    list.push(d);
    byAsset.set(d.assetId, list);
  }
  const rows = assets
    .filter((a) => a.startDate <= yearEnd)
    .map((a) => {
      const mine = byAsset.get(a.id) ?? [];
      // period 是 YYYY-MM 字串，字典序＝時間序
      const openingAccum = mine.filter((d) => d.period < `${year}-01`).reduce((s, d) => s + d.amount, 0);
      const yearDep = mine.filter((d) => d.period.slice(0, 4) === String(year)).reduce((s, d) => s + d.amount, 0);
      const accumulated = openingAccum + yearDep;
      return {
        assetId: a.id,
        name: a.name,
        categoryLabel: CATEGORY_BY_KEY.get(a.category)?.label ?? a.category,
        startDate: a.startDate,
        usefulYears: a.usefulYears,
        cost: a.cost,
        salvage: a.salvage,
        openingAccum,
        yearDepreciation: yearDep,
        accumulated,
        bookValue: a.cost - accumulated,
        status: a.status,
        disposedAt: a.status === "disposed" ? a.disposedAt : null,
      };
    })
    .sort((a, b) => a.assetId - b.assetId);
  return {
    year,
    rows,
    totals: {
      cost: rows.reduce((s, r) => s + r.cost, 0),
      openingAccum: rows.reduce((s, r) => s + r.openingAccum, 0),
      yearDepreciation: rows.reduce((s, r) => s + r.yearDepreciation, 0),
      accumulated: rows.reduce((s, r) => s + r.accumulated, 0),
      bookValue: rows.reduce((s, r) => s + r.bookValue, 0),
    },
  };
}

const PATCH_FIELD_LABELS: Record<string, string> = {
  name: "名稱",
  category: "類別（科目）",
  cost: "取得成本",
  salvage: "殘值",
  usefulYears: "耐用年限",
  startDate: "啟用日",
  memo: "備註",
};

export interface AssetPatch {
  name?: string | undefined;
  category?: string | undefined;
  cost?: number | undefined;
  salvage?: number | undefined;
  usefulYears?: number | undefined;
  startDate?: string | undefined;
  memo?: string | undefined;
}

/**
 * 修改資產基本資料（B14 建議 4）：成本少打一個零不再只能靠假處分修正。
 * - 尚無折舊紀錄且未處分：全部欄位可改（類別改了科目跟著換——尚未有任何傳票引用它）。
 * - 已提折舊或已處分：只可改名稱與備註。已提各期的金額是按舊的成本／殘值／年限算的，
 *   改了基礎資料，那些傳票就成了無法解釋的數字；要下帳走處分，差額以手工傳票調整。
 */
export async function updateAsset(db: Db, assetId: number, patch: AssetPatch) {
  return db.transaction(async (tx) => {
    const [asset] = await tx.select().from(schema.fixedAssets).where(eq(schema.fixedAssets.id, assetId)).for("update");
    if (!asset) throw new AppError(404, `資產不存在: ${assetId}`);
    if (asset.voidedAt) {
      throw new AppError(
        409,
        `資產 #${assetId} 已於 ${asset.voidedAt.toISOString().slice(0, 10)} 作廢（理由：${asset.voidReason ?? "未記錄"}），不可修改。請重新登錄一筆正確的資產`,
      );
    }
    const keys = (Object.keys(patch) as (keyof AssetPatch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) throw new AppError(400, "沒有要修改的欄位（請至少帶一個要改的欄位）");

    const deps = await tx
      .select()
      .from(schema.assetDepreciations)
      .where(eq(schema.assetDepreciations.assetId, assetId));
    const restricted = deps.length > 0 || asset.status === "disposed";
    if (restricted) {
      const blocked = keys.filter((k) => k !== "name" && k !== "memo");
      if (blocked.length > 0) {
        const accumulated = deps.reduce((s, d) => s + d.amount, 0);
        const why =
          deps.length > 0
            ? `已提折舊 ${deps.length} 期（累計 ${accumulated} 元）——已提各期的金額是按登錄時的成本／殘值／年限算的，` +
              `改了這些基礎資料，那些折舊傳票就成了無法解釋的數字`
            : "已處分——處分損益是按登錄資料算的，帳已定案";
        throw new AppError(
          422,
          `資產 #${assetId}（${asset.name}）${why}。` +
            `目前只可修改：名稱、備註（這次要改的「${blocked.map((k) => PATCH_FIELD_LABELS[k] ?? k).join("、")}」不在其中）。` +
            `若登錄確實有誤：要讓資產下帳請走「處分」（價款 0＝報廢），折舊差額請以手工傳票調整`,
        );
      }
    }

    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set["name"] = patch.name;
    if (patch.memo !== undefined) set["memo"] = patch.memo;
    if (!restricted) {
      if (patch.category !== undefined) {
        const category = CATEGORY_BY_KEY.get(patch.category);
        if (!category) throw new AppError(422, `資產類別不存在: ${patch.category}`);
        set["category"] = category.key;
        set["assetCode"] = category.assetCode;
        set["accumCode"] = category.accumCode;
      }
      if (patch.cost !== undefined) set["cost"] = patch.cost;
      if (patch.salvage !== undefined) set["salvage"] = patch.salvage;
      if (patch.usefulYears !== undefined) set["usefulYears"] = patch.usefulYears;
      if (patch.startDate !== undefined) set["startDate"] = patch.startDate;
      const cost = patch.cost ?? asset.cost;
      const salvage = patch.salvage ?? asset.salvage;
      if (salvage >= cost) {
        throw new AppError(
          422,
          `殘值（${salvage}）不得大於等於取得成本（${cost}）——若剛改了成本，請同時帶上正確的殘值`,
        );
      }
    }
    const [updated] = await tx.update(schema.fixedAssets).set(set).where(eq(schema.fixedAssets.id, assetId)).returning();
    return updated!;
  });
}

/**
 * 執行某期間（YYYY-MM）的折舊計提：對每個啟用中、未作廢、已達啟用月、尚有可折金額、
 * 該期間未提過的資產各開一張傳票（借 折舊費用／貸 累計折舊）。回傳本次計提清單。
 */
export async function runDepreciation(db: Db, period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError(400, "期間格式須為 YYYY-MM");
  // R2：未來月份一個都不放行——跳過的期間因 asset×period 冪等永遠補不回（詳見 dates.ts）
  assertMonthNotFuture(period, "折舊期間");
  return db.transaction(async (tx) => {
    // 已作廢的資產排除：登錄本身是錯的，不該再長出任何折舊傳票
    const assets = await tx
      .select()
      .from(schema.fixedAssets)
      .where(and(eq(schema.fixedAssets.status, "active"), isNull(schema.fixedAssets.voidedAt)));
    const deps = await tx.select().from(schema.assetDepreciations);
    const provided = new Set(deps.map((d) => `${d.assetId}:${d.period}`));
    const accumulatedOf = new Map<number, number>();
    for (const d of deps) accumulatedOf.set(d.assetId, (accumulatedOf.get(d.assetId) ?? 0) + d.amount);

    const codes = await accountIdByCode(tx, [
      DEPRECIATION_EXPENSE_CODE,
      ...new Set(assets.map((a) => a.accumCode)),
    ]);
    // 傳票日＝期間最後一天
    const [y, m] = [Number(period.slice(0, 4)), Number(period.slice(5, 7))];
    const entryDate = `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    await assertPeriodOpen(tx, entryDate);

    const results = [];
    for (const a of assets) {
      if (a.startDate.slice(0, 7) > period) continue; // 尚未啟用
      if (provided.has(`${a.id}:${period}`)) continue; // 本期已提
      const accumulated = accumulatedOf.get(a.id) ?? 0;
      const remaining = a.cost - a.salvage - accumulated;
      if (remaining <= 0) continue; // 已提足
      const amount = Math.min(monthlyDepreciation(a.cost, a.salvage, a.usefulYears), remaining);
      if (amount <= 0) continue;

      const [entry] = await tx
        .insert(schema.journalEntries)
        .values({
          entryDate,
          memo: `${period} 折舊：${a.name}`,
          sourceType: "depreciation",
          sourceId: a.id,
        })
        .returning();
      await tx.insert(schema.journalLines).values([
        { entryId: entry!.id, accountId: codes.get(DEPRECIATION_EXPENSE_CODE)!, debit: amount, credit: 0 },
        { entryId: entry!.id, accountId: codes.get(a.accumCode)!, debit: 0, credit: amount },
      ]);
      await tx.insert(schema.assetDepreciations).values({
        assetId: a.id,
        period,
        amount,
        journalEntryId: entry!.id,
      });
      results.push({ assetId: a.id, name: a.name, amount, journalEntryId: entry!.id });
    }
    return { period, count: results.length, total: results.reduce((s, r) => s + r.amount, 0), items: results };
  });
}

export interface DisposalInput {
  date: string;
  proceeds?: number | undefined;
  accountCode?: string | undefined;
  /** 是否計銷項稅額（預設 true）。系統無從斷言哪筆處分免稅——不計稅是使用者的明示選擇 */
  taxable?: boolean | undefined;
  /** 價款是否含稅（預設 true：填的是實收金額，由系統拆出未稅與稅額） */
  proceedsIncludeTax?: boolean | undefined;
  /**
   * 同時開立發票（0034，可選）：發票金額＝處分價款、稅額＝處分稅額，401 銷項自然涵蓋。
   * 不帶＝不開（taxNotes 出聲提醒），可事後於 POST /fixed-assets/:id/invoice 補開
   */
  invoice?: DisposalIssueInput | undefined;
}

/** YYYY-MM 逐月列舉（含首尾） */
function monthsThrough(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  let y = Number(fromMonth.slice(0, 4));
  let m = Number(fromMonth.slice(5, 7));
  for (;;) {
    const cur = `${y}-${String(m).padStart(2, "0")}`;
    if (cur > toMonth) break;
    out.push(cur);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

interface DisposalPlan {
  asset: typeof schema.fixedAssets.$inferSelect;
  /** 補提計畫（啟用月～處分月之間漏提的期間） */
  catchUp: { period: string; amount: number }[];
  /** 補提後的累計折舊 */
  accumulated: number;
  /** 補提後的帳面淨值＝處分損益的比較基礎 */
  bookValue: number;
  /** 未稅價款 */
  netProceeds: number;
  /** 銷項稅額 */
  tax: number;
  /** 實收總額（含稅）＝現金科目借方 */
  cashTotal: number;
  /** 正＝利益、負＝損失（未稅價款 − 帳面淨值） */
  gain: number;
  /** 計稅時解析到的營業稅率快照（bp）；未計稅＝null。落地供日後開票用（0034） */
  rateBp: number | null;
  taxNotes: string[];
}

/** 401 銷項取數來源是發票清單：計稅處分不開發票就進不了 401，這句提醒在試算與未開票的處分都要出聲 */
function invoiceReminder(netProceeds: number, tax: number): string {
  return (
    `處分價款已拆為未稅 ${netProceeds} 元＋銷項稅額 ${tax} 元（貸 ${ACCOUNT.OUTPUT_TAX} 銷項稅額）。` +
    `401 的銷項取數來源是發票清單，這筆處分要開立統一發票才會進 401——` +
    `可在處分時一併開立（處分表單的「開立發票」），或事後於資產頁對這筆處分補開；` +
    `不在本系統開立者，請自行確認該期申報涵蓋這筆銷項`
  );
}

/**
 * 處分試算＝實際處分的同一套計算與同一組前置檢查（差別只在不落帳）。
 * 檢查順序刻意固定：存在→未作廢→未處分→關帳→日期先後→成本已入帳，
 * 讓試算擋下的錯誤與送出時完全一致——畫面上先看到的就是送出會發生的。
 */
async function computeDisposalPlan(tx: Db, assetId: number, input: DisposalInput): Promise<DisposalPlan> {
  const [asset] = await tx.select().from(schema.fixedAssets).where(eq(schema.fixedAssets.id, assetId)).for("update");
  if (!asset) throw new AppError(404, `資產不存在: ${assetId}`);
  if (asset.voidedAt) {
    throw new AppError(
      409,
      `資產 #${assetId} 已於 ${asset.voidedAt.toISOString().slice(0, 10)} 作廢（理由：${asset.voidReason ?? "未記錄"}），沒有可處分的帳面`,
    );
  }
  if (asset.status === "disposed") throw new AppError(409, "資產已處分");
  // R2：年份打錯的未來處分日當場擋下（過去日期不擋，關帳鎖另行把關）
  assertNotFarFuture(input.date, "處分日期");
  await assertPeriodOpen(tx, input.date);
  if (input.date < asset.startDate) {
    throw new AppError(422, `處分日 ${input.date} 早於啟用日 ${asset.startDate}——資產不可能在啟用前被處分，請檢查日期`);
  }

  // (a) 成本未入帳先擋：登錄刻意不拋轉取得傳票（檔頭），處分卻要貸記整筆成本——
  // 沒補取得傳票就處分，資產科目會被打成負數而 balanced 照樣為 true，沒有任何報表會叫
  const [assetAccount] = await tx.select().from(schema.accounts).where(eq(schema.accounts.code, asset.assetCode));
  if (!assetAccount) throw new AppError(500, `科目未初始化: ${asset.assetCode}（請重跑 migrate/seed）`);
  const acctLines = await tx
    .select({ debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .where(eq(schema.journalLines.accountId, assetAccount.id));
  const balance = acctLines.reduce((s, l) => s + l.debit - l.credit, 0);
  if (balance < asset.cost) {
    throw new AppError(
      422,
      `資產「${asset.name}」的取得成本 ${asset.cost} 元尚未入帳：科目 ${asset.assetCode} 目前借餘 ${balance} 元，` +
        `處分要貸記 ${asset.cost} 元，會把帳面打成負數。登錄刻意不拋轉取得傳票（取得走進貨單或手工傳票）——` +
        `請先到「傳票」頁補一張取得分錄（借 ${asset.assetCode} ${asset.cost}／貸 銀行存款或其他應付款），再處分`,
    );
  }

  // (c) 折舊補提到處分當月（與「啟用日當月起提」對稱；末期以剩餘可折金額收斂）。
  // 補提傳票以**處分日**入帳：漏提的期間可能已關帳，帳落在處分日不會回溯改動已定案的月份
  const deps = await tx
    .select()
    .from(schema.assetDepreciations)
    .where(eq(schema.assetDepreciations.assetId, assetId));
  const provided = new Set(deps.map((d) => d.period));
  let accumulated = deps.reduce((s, d) => s + d.amount, 0);
  const monthly = monthlyDepreciation(asset.cost, asset.salvage, asset.usefulYears);
  const catchUp: { period: string; amount: number }[] = [];
  for (const period of monthsThrough(asset.startDate.slice(0, 7), input.date.slice(0, 7))) {
    if (provided.has(period)) continue;
    const remaining = asset.cost - asset.salvage - accumulated;
    if (remaining <= 0) break;
    const amount = Math.min(monthly, remaining);
    if (amount <= 0) break;
    catchUp.push({ period, amount });
    accumulated += amount;
  }
  const bookValue = asset.cost - accumulated;

  // (b) 價款拆「未稅＋銷項稅額」：費率依**處分日**由 tax_parameters 解析（回退不靜默）
  const proceeds = input.proceeds ?? 0;
  const taxable = input.taxable ?? true;
  const includeTax = input.proceedsIncludeTax ?? true;
  let netProceeds = proceeds;
  let tax = 0;
  let cashTotal = proceeds;
  let rateBp: number | null = null;
  const taxNotes: string[] = [];
  if (taxable && proceeds > 0) {
    const vat = await resolveVatRate(tx, input.date);
    taxNotes.push(...vat.notes);
    rateBp = vat.rateBp;
    if (includeTax) {
      netProceeds = roundHalfUp(proceeds / (1 + vat.rate));
      tax = proceeds - netProceeds;
    } else {
      netProceeds = proceeds;
      tax = calcTax(netProceeds, vat.rate);
      cashTotal = netProceeds + tax;
    }
  }
  const gain = netProceeds - bookValue;
  return { asset, catchUp, accumulated, bookValue, netProceeds, tax, cashTotal, gain, rateBp, taxNotes };
}

/** 處分試算：與 disposeAsset 同一套計算與檢查，但不落任何帳——給表單「先看到損益再送出」用 */
export async function previewDisposal(db: Db, assetId: number, input: DisposalInput) {
  return db.transaction(async (tx) => {
    const plan = await computeDisposalPlan(tx, assetId, input);
    // 試算不知道送出時會不會勾「開立發票」：提醒照出，表單文字會說明勾了就自動涵蓋
    const taxNotes = plan.tax > 0 ? [...plan.taxNotes, invoiceReminder(plan.netProceeds, plan.tax)] : plan.taxNotes;
    return {
      assetId,
      name: plan.asset.name,
      catchUp: { count: plan.catchUp.length, total: plan.catchUp.reduce((s, c) => s + c.amount, 0), items: plan.catchUp },
      accumulated: plan.accumulated,
      bookValue: plan.bookValue,
      proceeds: plan.cashTotal,
      netProceeds: plan.netProceeds,
      tax: plan.tax,
      gain: plan.gain,
      taxNotes,
    };
  });
}

/**
 * 處分/報廢：補提折舊到處分當月 → 沖成本與累折、收處分價款（可 0＝報廢）、
 * 認列銷項稅額（taxable 時），差額（未稅價款 − 帳面）認列處分損益。
 */
export async function disposeAsset(db: Db, assetId: number, input: DisposalInput) {
  return db.transaction(async (tx) => {
    const plan = await computeDisposalPlan(tx, assetId, input);
    const { asset, catchUp, accumulated, bookValue, netProceeds, tax, cashTotal, gain, rateBp, taxNotes } = plan;

    // 收款科目改以 accounts.is_cash 驗證，不再寫死 1101/1103：
    // 處分價款照樣可能收進零用金或使用者自建的銀行帳戶（1104 銀行存款－玉山），
    // 寫死等於逼使用者先收到不存在的帳戶再自己開傳票轉出
    const cashAccounts = await tx.select().from(schema.accounts).where(eq(schema.accounts.isCash, true));
    const cashCode = input.accountCode ?? ACCOUNT.BANK;
    const cashAccount = cashAccounts.find((a) => a.code === cashCode);
    if (!cashAccount) {
      throw new AppError(
        422,
        `收款科目須為現金科目（目前可用：${cashAccounts.map((a) => `${a.code} ${a.name}`).join("、") || "無"}）。` +
          `要新增銀行帳戶科目請到「會計科目」頁建立資產類科目並勾選「現金科目」`,
      );
    }
    // 與手工傳票／收付款單同一條規則：停用的科目不得再過帳
    if (!cashAccount.active) {
      throw new AppError(400, `科目已停用，不可再過帳: ${cashAccount.code} ${cashAccount.name}`);
    }

    const codes = await accountIdByCode(tx, [
      asset.assetCode,
      asset.accumCode,
      cashCode,
      DEPRECIATION_EXPENSE_CODE,
      DISPOSAL_GAIN_CODE,
      DISPOSAL_LOSS_CODE,
      ACCOUNT.OUTPUT_TAX,
    ]);

    // (c) 補提傳票（借 6140／貸 累折），一期一張、都以處分日入帳，asset_depreciations 記原期間
    for (const cu of catchUp) {
      const [entry] = await tx
        .insert(schema.journalEntries)
        .values({
          entryDate: input.date,
          memo: `${cu.period} 折舊（處分補提）：${asset.name}`,
          sourceType: "depreciation",
          sourceId: assetId,
        })
        .returning();
      await tx.insert(schema.journalLines).values([
        { entryId: entry!.id, accountId: codes.get(DEPRECIATION_EXPENSE_CODE)!, debit: cu.amount, credit: 0 },
        { entryId: entry!.id, accountId: codes.get(asset.accumCode)!, debit: 0, credit: cu.amount },
      ]);
      await tx.insert(schema.assetDepreciations).values({
        assetId,
        period: cu.period,
        amount: cu.amount,
        journalEntryId: entry!.id,
      });
    }

    const lines = [
      ...(accumulated > 0 ? [{ accountId: codes.get(asset.accumCode)!, debit: accumulated, credit: 0 }] : []),
      ...(cashTotal > 0 ? [{ accountId: codes.get(cashCode)!, debit: cashTotal, credit: 0 }] : []),
      { accountId: codes.get(asset.assetCode)!, debit: 0, credit: asset.cost },
      ...(tax > 0 ? [{ accountId: codes.get(ACCOUNT.OUTPUT_TAX)!, debit: 0, credit: tax }] : []),
      ...(gain > 0
        ? [{ accountId: codes.get(DISPOSAL_GAIN_CODE)!, debit: 0, credit: gain }]
        : gain < 0
          ? [{ accountId: codes.get(DISPOSAL_LOSS_CODE)!, debit: -gain, credit: 0 }]
          : []),
    ];
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({
        entryDate: input.date,
        memo:
          `處分資產：${asset.name}（帳面 ${bookValue}、未稅價款 ${netProceeds}` +
          (tax > 0 ? `、銷項稅額 ${tax}` : "") +
          `）`,
        sourceType: "disposal",
        sourceId: assetId,
      })
      .returning();
    await tx.insert(schema.journalLines).values(lines.map((l) => ({ entryId: entry!.id, ...l })));
    const [updated] = await tx
      .update(schema.fixedAssets)
      .set({
        status: "disposed",
        disposedAt: input.date,
        disposalEntryId: entry!.id,
        disposalProceeds: cashTotal,
        disposalTax: tax,
        // 費率快照（0034）：日後開票（處分時沒勾、或作廢重開）要用處分當時的費率，不能重新解析
        disposalVatRateBp: rateBp,
        // 前一次處分作廢後再處分：作廢欄位歸零，這一輪的處分才是現況（舊歷程都在傳票上）
        disposalReversalEntryId: null,
        disposalVoidedAt: null,
        disposalVoidedBy: null,
        disposalVoidReason: null,
      })
      .where(and(eq(schema.fixedAssets.id, assetId)))
      .returning();

    // 同時開立發票（0034，可選）：同一交易內開立——發票開不出來（字軌用完、B2B 缺統編）
    // 整筆處分一起回滾，不會留下「帳已沖轉、發票沒開成」的中間態
    let invoice = null;
    const notes = [...taxNotes];
    if (input.invoice) {
      invoice = await issueDisposalInvoiceCore(tx, assetId, input.invoice);
      notes.push(...invoice.taxNotes, `已開立發票 ${invoice.invoiceNumber}（買受人 ${invoice.buyerName}），401 銷項將自動涵蓋這筆處分`);
    } else if (tax > 0) {
      notes.push(invoiceReminder(netProceeds, tax));
    }
    return {
      ...updated!,
      accumulated,
      bookValue,
      proceeds: cashTotal,
      netProceeds,
      tax,
      gain,
      catchUp: { count: catchUp.length, total: catchUp.reduce((s, c) => s + c.amount, 0), items: catchUp },
      disposalEntryId: entry!.id,
      invoice,
      taxNotes: notes,
    };
  });
}
