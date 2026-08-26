/**
 * 扣繳追蹤：付錢給個人（房東、接案設計師、記帳的個人工作者）時，
 * 把「認列多少費用 / 代扣多少 / 實付多少」記成一張單，並自動拋轉三腳（含現金四行）分錄。
 * 規格狀態與界線見 docs/specs/withholding.md。
 *
 * ★ 本模組的設計紀律（使用者已拍板，違反者一律重做）：
 *   **系統提供結構與算術，稅率／級距／門檻一律由使用者填寫並自行註明依據來源。**
 *   所以這裡沒有任何稅率常數、沒有門檻判斷、沒有免扣額、沒有居住者／非居住者的分支，
 *   也不產生任何憑單格式代號。費率來自使用者自己在扣繳類別裡填的 tax_rate_bp，
 *   而依費率算出來的金額**只是預設值**——使用者一律可以覆寫。
 *
 *   為什麼一定要能覆寫：小額給付的免扣門檻、身分別例外、跨月合併給付這些規則我們沒有模型，
 *   系統硬算出來的數字看起來很權威，卻可能和使用者手上的繳款單差一截；
 *   到那個時候「改不動」比「算錯」更糟——他只能放棄這張單改回手工傳票，
 *   於是年度憑單又回到沒有取數來源的狀態。
 *
 * 帳務結構：
 *   借 類別對應的費用科目   gross_amount   （認列的費用是給付總額，不是實付額）
 *     貸 2211 代扣所得稅      tax_withheld
 *     貸 2212 代扣勞健保費    supplement_withheld
 *     貸 現金／銀行科目       net_amount
 *   四行固定寫出（金額為 0 也寫）：對帳的人要能一眼看出「這張單扣了多少、實付多少」，
 *   而不是靠某一行有沒有出現去推論（與退回單 saleReturnEntryLines 同一個理由）。
 */
import {
  ACCOUNT,
  assertBalanced,
  withheldByRate,
  type EntryLine,
} from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, asc, eq, gte, inArray, isNull, lte, sql as sqlExpr } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { assertNotFarFuture } from "./dates.ts";
import { assertPeriodOpen } from "./period.ts";

// --- 扣繳類別（使用者自訂的費率設定）---

export interface CategoryInput {
  label: string;
  expenseAccountCode: string;
  /** basis point（10% = 1000）；null／未給＝尚未設定，不是 0 */
  taxRateBp?: number | null | undefined;
  supplementRateBp?: number | null | undefined;
  sourceNote?: string | null | undefined;
}

/**
 * 逐欄寫出而不用 Partial<CategoryInput>：exactOptionalPropertyTypes 之下
 * Partial 產生的選填欄位不接受「明確傳入 undefined」，而路由層的 zod 輸出正是那個形狀。
 */
export interface CategoryPatch {
  label?: string | undefined;
  expenseAccountCode?: string | undefined;
  taxRateBp?: number | null | undefined;
  supplementRateBp?: number | null | undefined;
  sourceNote?: string | null | undefined;
  active?: boolean | undefined;
}

/** 類別清單；預設含停用者（設定頁要看得到全部才啟用得回來），建單畫面自行篩 active */
export async function listCategories(db: Db) {
  return db
    .select()
    .from(schema.withholdingCategories)
    .orderBy(asc(schema.withholdingCategories.id));
}

async function requireAccountCode(db: Db, code: string) {
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.code, code));
  if (!account) {
    throw new AppError(
      422,
      `會計科目不存在: ${code}（請到「會計科目」頁新增這個代號，或改填一個已存在的費用科目）`,
    );
  }
  return account;
}

export async function createCategory(db: Db, input: CategoryInput) {
  const account = await requireAccountCode(db, input.expenseAccountCode);
  // 類別的對應科目必須是費用類：借方記的是「認列的費用」，
  // 指到資產或負債科目會讓這張單的金額在損益表上完全消失（而且沒有任何徵兆）
  if (account.type !== "expense") {
    throw new AppError(
      422,
      `${account.code} ${account.name} 不是費用類科目，不能當扣繳類別的費用科目` +
        `（扣繳支出單的借方是認列的費用；若這確實是費用請到「會計科目」頁改它的類別，` +
        `或改填 6xxx 開頭的費用科目）`,
    );
  }
  const [row] = await db
    .insert(schema.withholdingCategories)
    .values({
      label: input.label,
      expenseAccountCode: input.expenseAccountCode,
      taxRateBp: input.taxRateBp ?? null,
      supplementRateBp: input.supplementRateBp ?? null,
      sourceNote: input.sourceNote ?? null,
    })
    .returning();
  return row!;
}

export async function updateCategory(db: Db, id: number, patch: CategoryPatch) {
  const [target] = await db
    .select()
    .from(schema.withholdingCategories)
    .where(eq(schema.withholdingCategories.id, id));
  if (!target) throw new AppError(404, `扣繳類別不存在: ${id}`);
  if (patch.expenseAccountCode !== undefined) {
    const account = await requireAccountCode(db, patch.expenseAccountCode);
    if (account.type !== "expense") {
      throw new AppError(422, `${account.code} ${account.name} 不是費用類科目，不能當扣繳類別的費用科目`);
    }
  }
  const values = {
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.expenseAccountCode !== undefined ? { expenseAccountCode: patch.expenseAccountCode } : {}),
    // null 是有意義的值（清掉費率＝改回「尚未設定」），所以用 !== undefined 判斷而非真值判斷
    ...(patch.taxRateBp !== undefined ? { taxRateBp: patch.taxRateBp } : {}),
    ...(patch.supplementRateBp !== undefined ? { supplementRateBp: patch.supplementRateBp } : {}),
    ...(patch.sourceNote !== undefined ? { sourceNote: patch.sourceNote } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  };
  if (Object.keys(values).length === 0) {
    // drizzle 的 .set({}) 會丟 "No values to set"（500）——空 body 是使用者輸入問題
    throw new AppError(
      400,
      "未提供要修改的欄位（可改：label、expenseAccountCode、taxRateBp、supplementRateBp、sourceNote、active）",
    );
  }
  const [row] = await db
    .update(schema.withholdingCategories)
    .set(values)
    .where(eq(schema.withholdingCategories.id, id))
    .returning();
  return row!;
}

// --- 扣繳支出單 ---

export interface PaymentInput {
  partnerId: number;
  categoryId: number;
  payDate: string;
  grossAmount: number;
  /** 未給＝採用依類別費率的試算值（費率未設定時為 0）；給了＝使用者覆寫，一律照他的 */
  taxWithheld?: number | undefined;
  supplementWithheld?: number | undefined;
  cashAccountId: number;
  memo?: string | undefined;
}

/**
 * 依類別費率試算，並回報「為什麼是這個數字」。
 * notes 會原樣回給前端顯示——重點不是提醒，是讓使用者知道系統**沒有**替他判斷什麼。
 */
function resolveAmounts(
  input: PaymentInput,
  category: typeof schema.withholdingCategories.$inferSelect,
): { taxWithheld: number; supplementWithheld: number; netAmount: number; notes: string[] } {
  const notes: string[] = [];
  const resolve = (given: number | undefined, rateBp: number | null, label: string): number => {
    const estimated = withheldByRate(input.grossAmount, rateBp);
    if (given === undefined) {
      if (estimated === null) {
        notes.push(
          `「${category.label}」尚未設定${label}費率，本單的${label}以 0 計。` +
            `請到扣繳設定填入你查到的費率並在來源欄註明依據；已建立的單據不會回頭重算。`,
        );
        return 0;
      }
      return estimated;
    }
    if (estimated !== null && estimated !== given) {
      notes.push(`${label}已覆寫試算值（依費率試算 ${estimated} 元，實填 ${given} 元）。`);
    }
    if (estimated === null) {
      notes.push(`「${category.label}」尚未設定${label}費率，本單的 ${given} 元為你自行填入的金額。`);
    }
    return given;
  };
  const taxWithheld = resolve(input.taxWithheld, category.taxRateBp, "扣繳稅款");
  const supplementWithheld = resolve(input.supplementWithheld, category.supplementRateBp, "補充保費");
  const netAmount = input.grossAmount - taxWithheld - supplementWithheld;
  if (netAmount < 0) {
    throw new AppError(
      422,
      `代扣合計 ${taxWithheld + supplementWithheld} 元超過給付總額 ${input.grossAmount} 元，實付金額會變成負數。` +
        `請確認給付總額是「未扣繳前的總額」（不是實際匯出去的錢），或調低代扣金額`,
    );
  }
  return { taxWithheld, supplementWithheld, netAmount, notes };
}

/** 試算（不落地）：建單畫面即時顯示預設值與提示，與 POST 走同一份邏輯避免兩邊算出不同數字 */
export async function estimatePayment(db: Db, input: PaymentInput) {
  const [category] = await db
    .select()
    .from(schema.withholdingCategories)
    .where(eq(schema.withholdingCategories.id, input.categoryId));
  if (!category) throw new AppError(404, `扣繳類別不存在: ${input.categoryId}`);
  return resolveAmounts(input, category);
}

export async function createPayment(db: Db, input: PaymentInput, userId: number) {
  return db.transaction(async (tx) => {
    // R2：payDate 2030 會落進 2030 年度彙總（憑單取數），年份打錯當場擋下；過去日期不擋
    assertNotFarFuture(input.payDate, "給付日期");
    await assertPeriodOpen(tx, input.payDate);

    const [category] = await tx
      .select()
      .from(schema.withholdingCategories)
      .where(eq(schema.withholdingCategories.id, input.categoryId));
    if (!category) throw new AppError(404, `扣繳類別不存在: ${input.categoryId}`);
    if (!category.active) {
      throw new AppError(
        422,
        `扣繳類別已停用: ${category.label}（請在扣繳設定啟用它，或改選其他類別）`,
      );
    }

    const [partner] = await tx.select().from(schema.partners).where(eq(schema.partners.id, input.partnerId));
    if (!partner) throw new AppError(404, `交易對象不存在: ${input.partnerId}`);
    // 只接受自然人。這是**本頁的適用範圍**，不是稅法判斷——
    // 年度憑單彙總是依「受領人」分組的，混入法人會讓那張表失去意義。
    // 訊息刻意不說「對法人沒有扣繳問題」：那是我們沒查證的稅法斷言，
    // 而且把它當成脫困路徑等於告訴使用者「你不需要做這件事」，那不是出路。
    // 真正的出路有兩條：改勾個人，或改用手工傳票自己記三腳分錄。
    if (!partner.isIndividual) {
      throw new AppError(
        422,
        `${partner.name} 不是個人。扣繳支出單只處理「付款給自然人」的情形（個人房東、個人接案者等），` +
          `因為年度憑單彙總是依受領人分組的。` +
          `若他確實是個人，請到「客戶與商品」頁把這筆交易對象改為「個人」（統一編號要清空）；` +
          `若這筆付款是別的情形而你仍需要記錄代扣，請用「傳票」頁開一張手工傳票` +
          `（借費用／貸代扣款／貸現金），但那筆不會進入年度彙總`,
      );
    }

    const amounts = resolveAmounts(input, category);

    const accounts = await tx.select().from(schema.accounts);
    const cash = accounts.find((a) => a.id === input.cashAccountId);
    if (!cash) throw new AppError(404, `科目不存在: ${input.cashAccountId}`);
    // 與收付款單／報銷付款同一條規則：必須是現金科目，否則付出去的錢不會進現金流量表
    if (!cash.isCash) {
      throw new AppError(
        422,
        `${cash.code} ${cash.name} 不是現金科目，不能當付款科目` +
          `（若這是銀行帳戶，請到「會計科目」頁把它勾選為現金科目，付出的錢才會進現金流量表）`,
      );
    }
    if (!cash.active) {
      throw new AppError(400, `科目已停用，不可再過帳: ${cash.code} ${cash.name}（請改選其他現金科目，或先啟用它）`);
    }

    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const expense = byCode.get(category.expenseAccountCode);
    if (!expense) {
      throw new AppError(
        422,
        `扣繳類別「${category.label}」對應的費用科目 ${category.expenseAccountCode} 不存在` +
          `（請到「會計科目」頁新增它，或在扣繳設定改成別的費用科目）`,
      );
    }
    // 費用科目由使用者在扣繳設定指定，所以它「不是」系統科目，可能已被停用。
    // 之所以擋而不是照樣過帳：停用的語意是「不再出現在新單據」，繞過去等於停用只是把下拉藏起來。
    if (!expense.active) {
      throw new AppError(
        400,
        `科目已停用，不可再過帳: ${expense.code} ${expense.name}` +
          `（請在扣繳設定把「${category.label}」改成別的費用科目，或到「會計科目」頁啟用它）`,
      );
    }
    // 2211／2212 是系統科目（core 的 ACCOUNT 常數 → SYSTEM_ACCOUNT_CODES），
    // 停不掉也改不了碼；查不到只可能是種子沒跑過，那是部署問題不是使用者輸入問題
    const taxPayable = byCode.get(ACCOUNT.WITHHOLDING_TAX_PAYABLE);
    const supplementPayable = byCode.get(ACCOUNT.WITHHOLDING_SUPPLEMENT_PAYABLE);
    if (!taxPayable || !supplementPayable) {
      throw new AppError(500, "代扣款科目未初始化（2211／2212），請重新啟動服務讓科目種子灌入");
    }

    const lines: EntryLine[] = [
      { accountCode: expense.code, debit: input.grossAmount, credit: 0 },
      { accountCode: taxPayable.code, debit: 0, credit: amounts.taxWithheld },
      { accountCode: supplementPayable.code, debit: 0, credit: amounts.supplementWithheld },
      { accountCode: cash.code, debit: 0, credit: amounts.netAmount },
    ];
    // 借貸必平的最後一道保險：金額全部來自 CHECK 過的恆等式，這裡是防止未來改動時默默失衡
    assertBalanced(lines);

    const memo = input.memo?.trim() || `扣繳支出 - ${partner.name}（${category.label}）`;
    const [payment] = await tx
      .insert(schema.withholdingPayments)
      .values({
        partnerId: input.partnerId,
        categoryId: input.categoryId,
        payDate: input.payDate,
        grossAmount: input.grossAmount,
        taxWithheld: amounts.taxWithheld,
        supplementWithheld: amounts.supplementWithheld,
        cashAccountId: input.cashAccountId,
        netAmount: amounts.netAmount,
        memo,
        // 費率快照：讓年度彙總分得出「當時漏設費率而算 0」與「查過確實不用扣的 0」
        taxRateBpAtEntry: category.taxRateBp,
        supplementRateBpAtEntry: category.supplementRateBp,
        createdBy: userId,
      })
      .returning();
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({ entryDate: input.payDate, memo, sourceType: "withholding", sourceId: payment!.id })
      .returning();
    const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
    await tx.insert(schema.journalLines).values(
      lines.map((l) => ({
        entryId: entry!.id,
        accountId: idByCode.get(l.accountCode)!,
        debit: l.debit,
        credit: l.credit,
      })),
    );
    await tx
      .update(schema.withholdingPayments)
      .set({ journalEntryId: entry!.id })
      .where(eq(schema.withholdingPayments.id, payment!.id));
    return { ...payment!, journalEntryId: entry!.id, notes: amounts.notes };
  });
}

/** 清單（新到舊）；year 給了就只看該年度 */
export async function listPayments(db: Db, year?: number) {
  const rows = await db
    .select()
    .from(schema.withholdingPayments)
    .where(
      year === undefined
        ? undefined
        : and(
            gte(schema.withholdingPayments.payDate, `${year}-01-01`),
            lte(schema.withholdingPayments.payDate, `${year}-12-31`),
          ),
    );
  const partners = await db.select().from(schema.partners);
  const categories = await db.select().from(schema.withholdingCategories);
  const accounts = await db.select().from(schema.accounts);
  // 清單一律不帶 partners.id_no（PII）：這支是給畫面列表用的，身分證號在列表上沒有任何用途
  const partnerName = new Map(partners.map((p) => [p.id, p.name]));
  const categoryLabel = new Map(categories.map((c) => [c.id, c.label]));
  const accountName = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
  return rows
    .map((r) => ({
      ...r,
      partnerName: partnerName.get(r.partnerId) ?? `#${r.partnerId}`,
      categoryLabel: categoryLabel.get(r.categoryId) ?? `#${r.categoryId}`,
      cashAccountName: accountName.get(r.cashAccountId) ?? `#${r.cashAccountId}`,
    }))
    .sort((a, b) => b.payDate.localeCompare(a.payDate) || b.id - a.id);
}

/**
 * 年度彙總：依「受領人 × 類別」加總全年給付總額、扣繳稅額、補充保費與筆數。
 * 這是填各類所得憑單時的取數來源——**系統不產生憑單媒體檔**
 * （固定長度欄位格式規格未取得，見 docs/specs/withholding.md），請以財政部申報軟體填報。
 *
 * 依 pay_date 的年份分組（給付日），不是傳票日也不是建檔日：
 * 扣繳憑單申報的所屬年度看的是給付這件事發生在哪一年。
 */
export interface SummaryGroup {
  partnerId: number;
  partnerName: string;
  /** 身分證號本身不回傳（PII），只回「有沒有填」——沒填的話就填不出年度憑單，這才是要提醒的事 */
  hasIdNo: boolean;
  categoryId: number;
  categoryLabel: string;
  count: number;
  grossAmount: number;
  taxWithheld: number;
  supplementWithheld: number;
  netAmount: number;
  /**
   * 這一組裡有幾筆是在「類別費率尚未設定」的狀態下建立的（費率快照為 null）。
   * > 0 代表那幾筆的代扣金額是「因為系統不知道要扣多少而算 0」，不是「查過確實不用扣」——
   * 兩者在金額欄長得一模一樣，而這張表是申報憑單的取數來源，不標出來使用者無從發現自己漏設了。
   */
  unsetTaxRateCount: number;
  unsetSupplementRateCount: number;
}

export async function paymentSummary(db: Db, year: number) {
  const rows = await db
    .select()
    .from(schema.withholdingPayments)
    .where(
      and(
        gte(schema.withholdingPayments.payDate, `${year}-01-01`),
        lte(schema.withholdingPayments.payDate, `${year}-12-31`),
        // 已作廢單（0025，B4）不進年度彙總：這張表是憑單取數來源，
        // 打錯又作廢的單若仍計入，受領人會被掛上不存在的所得（B4 實測「最貴的一格」）
        isNull(schema.withholdingPayments.voidedAt),
      ),
    );
  const partners = await db.select().from(schema.partners);
  const categories = await db.select().from(schema.withholdingCategories);
  const partnerById = new Map(partners.map((p) => [p.id, p]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const groups = new Map<string, SummaryGroup>();
  for (const r of rows) {
    const key = `${r.partnerId}:${r.categoryId}`;
    const partner = partnerById.get(r.partnerId);
    const group =
      groups.get(key) ??
      {
        partnerId: r.partnerId,
        partnerName: partner?.name ?? `#${r.partnerId}`,
        hasIdNo: !!partner?.idNo,
        categoryId: r.categoryId,
        categoryLabel: categoryById.get(r.categoryId)?.label ?? `#${r.categoryId}`,
        count: 0,
        grossAmount: 0,
        taxWithheld: 0,
        supplementWithheld: 0,
        netAmount: 0,
        unsetTaxRateCount: 0,
        unsetSupplementRateCount: 0,
      };
    group.count += 1;
    group.grossAmount += r.grossAmount;
    group.taxWithheld += r.taxWithheld;
    group.supplementWithheld += r.supplementWithheld;
    group.netAmount += r.netAmount;
    if (r.taxRateBpAtEntry === null) group.unsetTaxRateCount += 1;
    if (r.supplementRateBpAtEntry === null) group.unsetSupplementRateCount += 1;
    groups.set(key, group);
  }
  const rowsOut = [...groups.values()].sort(
    (a, b) => a.partnerName.localeCompare(b.partnerName, "zh-TW") || a.categoryId - b.categoryId,
  );
  const total = rowsOut.reduce(
    (s, r) => ({
      count: s.count + r.count,
      grossAmount: s.grossAmount + r.grossAmount,
      taxWithheld: s.taxWithheld + r.taxWithheld,
      supplementWithheld: s.supplementWithheld + r.supplementWithheld,
      netAmount: s.netAmount + r.netAmount,
      unsetTaxRateCount: s.unsetTaxRateCount + r.unsetTaxRateCount,
      unsetSupplementRateCount: s.unsetSupplementRateCount + r.unsetSupplementRateCount,
    }),
    {
      count: 0, grossAmount: 0, taxWithheld: 0, supplementWithheld: 0, netAmount: 0,
      unsetTaxRateCount: 0, unsetSupplementRateCount: 0,
    },
  );
  return { year, rows: rowsOut, total, liabilities: await liabilityBalances(db) };
}

/**
 * 2211／2212 的當下餘額（貸方為正）＝已扣未繳的稅款／保費。
 * 不限日期也不限年度：這是「現在還欠國稅局／健保署多少」，繳庫後由使用者開手工傳票沖回而歸零。
 * **刻意不回傳任何繳納期限**——期限本專案未查證，系統不做任何期限提示（見 docs 表 B2 / B43）。
 */
export async function liabilityBalances(db: Db) {
  const codes: readonly string[] = [
    ACCOUNT.WITHHOLDING_TAX_PAYABLE,
    ACCOUNT.WITHHOLDING_SUPPLEMENT_PAYABLE,
  ];
  // 用 SQL 聚合而非撈回全部分錄：journal_lines 是全系統最大的表。
  // 轉 text 再由 JS 轉數字的理由與 app.ts 的 accountEntryStats 相同——跨筆 SUM 是 bigint，
  // ::int 在累積多年的庫上會炸成 500 integer out of range。
  const rows = await db
    .select({
      code: schema.accounts.code,
      name: schema.accounts.name,
      net: sqlExpr<string>`coalesce(sum(${schema.journalLines.credit} - ${schema.journalLines.debit}), 0)::text`,
    })
    .from(schema.accounts)
    .leftJoin(schema.journalLines, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(inArray(schema.accounts.code, [...codes]))
    .groupBy(schema.accounts.code, schema.accounts.name);
  const byCode = new Map(rows.map((r) => [r.code, { code: r.code, name: r.name, balance: Number(r.net) }]));
  return codes.map((code) => byCode.get(code) ?? { code, name: code, balance: 0 });
}
