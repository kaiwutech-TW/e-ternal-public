/**
 * 扣繳：付錢給個人（房東、接案設計師、記帳的個人工作者）時的帳務與年度憑單取數。
 *
 * ★ 本頁的紀律：費率是**使用者填的資料**，不是系統的知識。
 *   所以畫面上不會出現任何我們預設的稅率、門檻或繳納期限；
 *   費率沒填就明白寫「尚未設定」，並且一路提醒使用者在來源欄註明他查到的依據。
 *   試算值一律可以改——他手上的繳款單才是真的。
 */
import { bpToPercentText, percentToBp, withheldByRate, type Translator } from "@tw-erp/core";
import { useState } from "react";
import { api } from "../api.ts";
import { fmt, useFetch } from "../hooks.ts";
import { useT } from "../i18n.ts";
import { PrintOverlay } from "../print.tsx";
import type {
  Account,
  CompanyHeader,
  Partner,
  WithholdingCategory,
  WithholdingPaymentRow,
  WithholdingSummary,
  WithholdingSummaryRow,
} from "../types.ts";
import { EmptyState } from "../ui.tsx";

/**
 * 扣繳憑單套印參考（B5）：年度彙總的一列（受領人 × 類別）印成一張對照單。
 * **這不是財政部格式的憑單**——媒體檔格式規格尚未取得（docs/specs/withholding.md），
 * 這張紙的用途是留存，以及交付受領人核對金額與身分資料；格式代號欄空白留人填。
 * 身分證號走既有的單筆明文端點（限財務／管理者），非該權限按下去會收到 403 的訊息。
 */
function WithholdingSlipView(props: {
  year: number;
  row: WithholdingSummaryRow;
  idNo: string | null;
  company: CompanyHeader | null;
  onClose: () => void;
}) {
  const t = useT();
  const { row, company } = props;
  const blank = "＿＿＿＿＿＿";
  return (
    <PrintOverlay onClose={props.onClose}>
      <div className="print-head">
        <div className="doc-title" style={{ marginTop: 0 }}>{t("扣繳憑單套印參考")}</div>
        <div className="co-meta">{t("{year} 年度（依給付日歸年）　※ 非財政部格式，僅供留存與交付受領人核對", { year: props.year })}</div>
      </div>
      <table>
        <tbody>
          <tr>
            <th style={{ width: "28%" }}>{t("格式代號（所得類別）")}</th>
            <td>{blank}{t("（請依申報軟體之代號自行填寫）")}</td>
          </tr>
          <tr>
            <th>{t("扣繳單位")}</th>
            <td>
              {company
                ? `${company.name}${t("（統一編號 {taxId}）", { taxId: company.taxId })}${company.address ?? ""}${company.personInCharge ? `　${t("負責人 {name}", { name: company.personInCharge })}` : ""}`
                : t("（公司基本檔未設定——請至「設定」頁填寫）")}
            </td>
          </tr>
          <tr><th>{t("所得人（受領人）")}</th><td>{row.partnerName}</td></tr>
          <tr>
            <th>{t("身分證統一編號")}</th>
            <td>{props.idNo ?? t("（未填——請先到「客戶與商品」頁補登，否則憑單填不出來）")}</td>
          </tr>
          <tr><th>{t("給付內容（本系統類別）")}</th><td>{row.categoryLabel}{t("（{n} 筆）", { n: row.count })}</td></tr>
          <tr><th className="num">{t("給付總額")}</th><td className="num">{t("{amount} 元", { amount: fmt(row.grossAmount) })}</td></tr>
          <tr><th className="num">{t("扣繳稅額")}</th><td className="num">{t("{amount} 元", { amount: fmt(row.taxWithheld) })}</td></tr>
          <tr><th className="num">{t("給付淨額")}</th><td className="num">{t("{amount} 元", { amount: fmt(row.grossAmount - row.taxWithheld) })}</td></tr>
          <tr>
            <th className="num">{t("代扣補充保費（參考）")}</th>
            <td className="num">{t("{amount} 元（不屬扣繳憑單欄位，列出供對帳）", { amount: fmt(row.supplementWithheld) })}</td>
          </tr>
        </tbody>
      </table>
      {(row.unsetTaxRateCount > 0 || row.unsetSupplementRateCount > 0) && (
        <div className="foot-note" style={{ fontWeight: 600 }}>
          {t("⚠ 本列有 {n} 筆在費率尚未設定時建立，代扣以 0 計——不代表不用扣。請先回「扣繳」頁核對更正後再套印。", { n: row.unsetTaxRateCount + row.unsetSupplementRateCount })}
        </div>
      )}
      <div className="sign-row">
        <div className="sign-box">{t("扣繳義務人簽章")}</div>
        <div className="sign-box">{t("所得人簽收")}</div>
      </div>
      <div className="foot-note">
        {t("金額為整數新台幣元。正式憑單請以財政部申報軟體產製；申報與繳納期限本系統不提示，請依主管機關公告辦理。")}
      </div>
    </PrintOverlay>
  );
}

/** 費率顯示：null 與 0 必須看得出差別——前者是「還沒查」，後者是「查過、不用扣」 */
function rateText(t: Translator, bp: number | null): string {
  return bp === null ? t("尚未設定") : `${bpToPercentText(bp)}%`;
}

export function Withholding() {
  const t = useT();
  const categories = useFetch<WithholdingCategory[]>("/withholding-categories");
  const partners = useFetch<Partner[]>("/partners");
  const accounts = useFetch<Account[]>("/accounts");
  const payments = useFetch<WithholdingPaymentRow[]>("/withholding-payments");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  // --- 建單表單 ---
  const [partnerId, setPartnerId] = useState(0);
  const [categoryId, setCategoryId] = useState(0);
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [grossAmount, setGrossAmount] = useState(0);
  // null＝使用者沒改過，送出時不帶這個欄位，由伺服端以費率試算（試算邏輯只有一份）
  const [taxOverride, setTaxOverride] = useState<number | null>(null);
  const [supplementOverride, setSupplementOverride] = useState<number | null>(null);
  const [cashAccountId, setCashAccountId] = useState(0);
  const [memo, setMemo] = useState("");

  // --- 年度彙總 ---
  const [year, setYear] = useState(new Date().getFullYear());
  const [summary, setSummary] = useState<WithholdingSummary | null>(null);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  // 套印（B5）：公司抬頭任何登入者可讀；身分證號明文按下套印時單筆取（限財務／管理者）
  const company = useFetch<CompanyHeader>("/company-profile");
  const [slip, setSlip] = useState<{ row: WithholdingSummaryRow; idNo: string | null } | null>(null);
  const openSlip = async (row: WithholdingSummaryRow) => {
    try {
      const idNo = row.hasIdNo
        ? (await api.get<{ idNo: string | null }>(`/partners/${row.partnerId}/id-no`)).idNo
        : null;
      setSlip({ row, idNo });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const individuals = partners.data?.filter((p) => p.isIndividual) ?? [];
  const activeCategories = categories.data?.filter((c) => c.active) ?? [];
  const cashAccounts = accounts.data?.filter((a) => a.isCash) ?? [];
  const category = categories.data?.find((c) => c.id === categoryId) ?? null;

  // 試算與伺服端共用 core 的同一個函式（withheldByRate）：兩邊各寫一份必然會漂移。
  // 但 withheldByRate 對非整數會 throw，而這裡是在 render 期間呼叫——
  // 使用者在金額欄打一個小數點就會讓整頁變白畫面，連錯誤訊息都看不到。
  // 金額本來就只收整數元（送出時伺服端也擋），所以 render 用的試算取整後再算。
  const grossForEstimate = Number.isFinite(grossAmount) ? Math.floor(grossAmount) : 0;
  const estTax =
    grossForEstimate > 0 && category ? withheldByRate(grossForEstimate, category.taxRateBp) : null;
  const estSupplement =
    grossForEstimate > 0 && category ? withheldByRate(grossForEstimate, category.supplementRateBp) : null;
  const taxValue = taxOverride ?? estTax ?? 0;
  const supplementValue = supplementOverride ?? estSupplement ?? 0;
  const netPreview = grossAmount - taxValue - supplementValue;

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * 作廢扣繳支出單（B4）：金額打錯的正路是「作廢＋重開」，不是手工傳票沖帳——
   * 手工傳票救得了總帳，救不了年度彙總（憑單取數來源），受領人會被掛上不存在的所得。
   */
  const voidPayment = async (p: WithholdingPaymentRow) => {
    const reason = window.prompt(
      t("作廢扣繳支出單 #{id}（{name}，給付總額 {amount} 元）：請輸入作廢理由。", { id: p.id, name: p.partnerName, amount: fmt(p.grossAmount) }) + "\n" +
        t("反向傳票會沖平費用／代扣款／現金，這張單也不再計入年度彙總；金額打錯請作廢後重開一張。"),
    );
    if (reason === null) return;
    try {
      await api.post(`/withholding-payments/${p.id}/void`, { reason: reason.trim() });
      setError(null);
      payments.reload();
      if (summary) void loadSummary(year);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submitPayment = async () => {
    try {
      if (!partnerId) throw new Error(t("請選擇受領人（只有勾了「個人」的交易對象會出現在這裡）"));
      if (!categoryId) throw new Error(t("請選擇扣繳類別"));
      if (grossAmount <= 0) throw new Error(t("給付總額須為正整數（填扣繳前的總額，不是實際匯出去的錢）"));
      if (!cashAccounts.length) throw new Error(t("沒有可用的現金科目，請到「會計科目」頁把銀行帳戶勾為現金科目"));
      // 未動過下拉時採第一個現金科目（與畫面顯示的一致）：畫面顯示 A 卻送出 0 是最糟的組合
      const chosenCashId = cashAccountId || cashAccounts[0]!.id;
      const created = await api.post<{ notes: string[] }>("/withholding-payments", {
        partnerId,
        categoryId,
        payDate,
        grossAmount,
        // 沒改過就不帶：讓伺服端以費率試算，避免前端把一個「看起來是使用者填的」數字送過去
        ...(taxOverride !== null ? { taxWithheld: taxOverride } : {}),
        ...(supplementOverride !== null ? { supplementWithheld: supplementOverride } : {}),
        cashAccountId: chosenCashId,
        ...(memo ? { memo } : {}),
      });
      setError(null);
      setNotes(created.notes ?? []);
      setGrossAmount(0);
      setTaxOverride(null);
      setSupplementOverride(null);
      setMemo("");
      payments.reload();
      if (summary) void loadSummary(year);
    } catch (e) {
      setNotes([]);
      setError((e as Error).message);
    }
  };

  const loadSummary = async (y: number) => {
    try {
      setSummary(await api.get<WithholdingSummary>(`/withholding-payments/summary?year=${y}`));
      setRevealed({});
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 身分證號按需顯示：明文不進任何清單，要看得單筆點開（填年度憑單時才需要） */
  const reveal = async (id: number) => {
    try {
      const row = await api.get<{ idNo: string | null }>(`/partners/${id}/id-no`);
      setRevealed((r) => ({ ...r, [id]: row.idNo ?? t("（未填）") }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {notes.length > 0 && (
        <div className="notice">
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}

      {/* 誠實揭露擺在最前面：使用者要先知道系統管到哪裡、什麼還是他自己的責任 */}
      <div className="card">
        <h3>{t("這一頁做什麼、不做什麼")}</h3>
        <p style={{ margin: "0 0 6px" }}>
          <strong>{t("會做")}</strong>{t("：把「付給個人的錢」記成一張單——認列費用、代扣的稅款與補充保費、實際付出去的金額，並自動產生會計分錄（借費用／貸 2211 代扣所得稅、2212 代扣勞健保費、貸 銀行或現金）。下方的年度彙總依「受領人 × 類別」加總，就是填各類所得憑單的取數來源。")}
        </p>
        <p style={{ margin: "0 0 6px" }}>
          <strong>{t("不會做")}</strong>{t("：系統")}<strong>{t("不內建任何費率")}</strong>{t("。扣繳率、補充保費費率請你自己查證後填進下方的類別設定，並在「依據來源」欄寫下你查到的出處與查詢日期——這些數字每年可能變動，由系統代你斷言只會讓錯誤被當成權威。系統也")}<strong>{t("不產生憑單媒體檔")}</strong>{t("（固定長度欄位的格式規格尚未取得，見 ")}<code>docs/specs/withholding.md</code>{t("），請以財政部的申報軟體填報；本頁的彙總數字是拿來抄進那套軟體的。系統同樣")}<strong>{t("不提示任何繳納或申報期限")}</strong>{t("——期限本專案未查證，請依國稅局公告辦理。")}
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>
          {t("費率填了之後，建單時會自動試算成預設值，但")}<strong>{t("永遠可以改")}</strong>{t("：小額給付的免扣門檻、身分別的例外這些規則系統沒有模型，你手上的繳款單才是準的。")}
        </p>
      </div>

      {/* --- 類別設定 --- */}
      <div className="card">
        <h3>{t("扣繳類別與費率（費率由你填寫，並請註明依據來源）")}</h3>
        <table>
          <thead>
            <tr>
              <th>{t("類別")}</th><th>{t("費用科目")}</th><th className="num">{t("扣繳率")}</th><th className="num">{t("補充保費率")}</th>
              <th>{t("依據來源")}</th><th>{t("狀態")}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {categories.data?.map((c) => (
              <CategoryRow
                key={c.id}
                category={c}
                accounts={accounts.data ?? []}
                onSaved={() => categories.reload()}
                onError={setError}
              />
            ))}
          </tbody>
        </table>
        <form
          className="inline"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            void act(async () => {
              await api.post("/withholding-categories", {
                label: String(f.get("label")).trim(),
                expenseAccountCode: String(f.get("expenseAccountCode")),
              });
              form.reset();
              categories.reload();
            });
          }}
        >
          <label className="field">{t("新增類別（白話名稱）")}<input name="label" required placeholder={t("例如：付給個人的翻譯費")} /></label>
          <label className="field">
            {t("記到哪個費用科目")}
            <select name="expenseAccountCode" defaultValue="6188">
              {(accounts.data ?? [])
                .filter((a) => a.type === "expense" && a.active)
                .map((a) => (
                  <option key={a.id} value={a.code}>{a.code} {a.name}</option>
                ))}
            </select>
          </label>
          <button className="primary">{t("新增類別")}</button>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          {t("新增的類別費率一律是空的（＝尚未設定），建單時會以 0 計並提醒你。填 0 和留空不一樣：")}<strong>{t("0 代表「我查過，這類不用扣」")}</strong>{t("，留空代表「還沒查」。")}
        </p>
      </div>

      {/* --- 建立扣繳支出單 --- */}
      <div className="card">
        <h3>{t("新增扣繳支出單")}</h3>
        {individuals.length === 0 ? (
          <EmptyState
            icon="🧾"
            title={t("還沒有「個人」的交易對象")}
            desc={t("這張單只用於付款給自然人（個人房東、個人接案者）。請先到「客戶與商品」頁新增交易對象並勾選「個人」——已經建過的對象也可以在那裡改成個人。")}
            actionLabel={t("去建立個人交易對象")}
            actionPage="masters"
          />
        ) : (
          <>
            <form className="inline" onSubmit={(e) => e.preventDefault()}>
              <label className="field">
                {t("受領人（個人）")}
                <select value={partnerId} onChange={(e) => setPartnerId(Number(e.target.value))}>
                  <option value={0}>{t("— 請選擇 —")}</option>
                  {individuals.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.hasIdNo ? "" : t("（未填身分證號）")}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                {t("扣繳類別")}
                <select
                  value={categoryId}
                  onChange={(e) => {
                    setCategoryId(Number(e.target.value));
                    setTaxOverride(null);
                    setSupplementOverride(null);
                  }}
                >
                  <option value={0}>{t("— 請選擇 —")}</option>
                  {activeCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t("{label}（扣繳率 {tax}／補充保費率 {supplement}）", { label: c.label, tax: rateText(t, c.taxRateBp), supplement: rateText(t, c.supplementRateBp) })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">{t("給付日")}<input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></label>
              <label className="field">
                {t("給付總額（扣繳前）")}
                <input
                  type="number"
                  min={0}
                  value={grossAmount}
                  onChange={(e) => setGrossAmount(Number(e.target.value))}
                />
              </label>
              <label className="field">
                {t("代扣所得稅")}
                <input
                  type="number"
                  min={0}
                  value={taxValue}
                  onChange={(e) => setTaxOverride(Number(e.target.value))}
                />
              </label>
              <label className="field">
                {t("代扣補充保費")}
                <input
                  type="number"
                  min={0}
                  value={supplementValue}
                  onChange={(e) => setSupplementOverride(Number(e.target.value))}
                />
              </label>
              <label className="field">
                {t("付款科目")}
                <select
                  value={cashAccountId || cashAccounts[0]?.id || 0}
                  onChange={(e) => setCashAccountId(Number(e.target.value))}
                >
                  {cashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">{t("摘要")}<input value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
              <button className="primary" onClick={() => void submitPayment()}>{t("建立")}</button>
            </form>
            <div className="stat-row" style={{ marginTop: 12 }}>
              <div className="stat"><div className="label">{t("認列費用（給付總額）")}</div><div className="value">{fmt(grossAmount)}</div></div>
              <div className="stat"><div className="label">{t("代扣合計")}</div><div className="value">{fmt(taxValue + supplementValue)}</div></div>
              <div className="stat">
                <div className="label">{t("實付給對方")}</div>
                <div className="value" style={netPreview < 0 ? { color: "var(--red)" } : undefined}>{fmt(netPreview)}</div>
              </div>
            </div>
            {/* 兩種費率各自提醒：原本兩個提示都只看 taxRateBp，於是
                「扣繳率填了、補充保費率留空」時畫面顯示代扣補充保費 0 卻一個字都不提，
                使用者會合理認為系統已經判斷不必扣；而「只填補充保費率、沒填來源」則永遠不提示 */}
            {category && category.taxRateBp === null && (
              <div className="notice" style={{ marginTop: 12 }}>
                {t("「{label}」", { label: category.label })}<strong>{t("尚未設定扣繳率")}</strong>{t("，代扣所得稅預設為 0——這不代表不用扣，只代表系統還不知道要扣多少。請在上方的類別設定填入你查到的費率並註明依據來源；或直接在這張單填入正確的代扣金額。")}
              </div>
            )}
            {category && category.supplementRateBp === null && (
              <div className="notice" style={{ marginTop: 12 }}>
                {t("「{label}」", { label: category.label })}<strong>{t("尚未設定補充保費率")}</strong>{t("，代扣補充保費預設為 0——同樣不代表不用扣。這一類支出要不要扣補充保費請自行查證，查到後填入類別設定，或直接在這張單填入金額。")}
              </div>
            )}
            {category && (category.taxRateBp !== null || category.supplementRateBp !== null) && !category.sourceNote && (
              <div className="notice" style={{ marginTop: 12 }}>
                {t("「{label}」的費率有填但沒有依據來源。建議在類別設定的「依據來源」欄寫下出處與查詢日期——明年這個數字若變了，你會需要知道當初是照哪裡填的。", { label: category.label })}
              </div>
            )}
            {netPreview < 0 && (
              <div className="error">{t("代扣合計超過給付總額，實付金額會變成負數。給付總額請填「扣繳前」的金額。")}</div>
            )}
          </>
        )}
      </div>

      {/* --- 已登錄的扣繳支出 --- */}
      <div className="card">
        <h3>{t("已登錄的扣繳支出")}</h3>
        {payments.data?.length === 0 ? (
          <EmptyState
            icon="📄"
            title={t("還沒有扣繳支出單")}
            desc={t("每次付租金或委外費用給個人時開一張，系統會同時記好費用、代扣稅款與實付金額；年底的憑單申報就靠這些單彙總。")}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("給付日")}</th><th>{t("受領人")}</th><th>{t("類別")}</th>
                <th className="num">{t("給付總額")}</th><th className="num">{t("代扣所得稅")}</th>
                <th className="num">{t("代扣補充保費")}</th><th className="num">{t("實付")}</th>
                <th>{t("付款科目")}</th><th>{t("摘要")}</th><th>{t("傳票")}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {payments.data?.map((p) => (
                <tr key={p.id}>
                  <td>{p.payDate}</td>
                  <td>{p.partnerName}</td>
                  <td>{p.categoryLabel}</td>
                  <td className="num">{fmt(p.grossAmount)}</td>
                  <td className="num">{fmt(p.taxWithheld)}</td>
                  <td className="num">{fmt(p.supplementWithheld)}</td>
                  <td className="num">{fmt(p.netAmount)}</td>
                  <td>{p.cashAccountName}</td>
                  <td>{p.memo}</td>
                  <td>{p.journalEntryId ? `#${p.journalEntryId}` : "—"}</td>
                  <td>
                    {p.voidedAt ? (
                      <span className="badge canceled" title={t("作廢理由：{reason}", { reason: p.voidReason ?? "" })}>{t("已作廢")}</span>
                    ) : (
                      <button className="small" onClick={() => void voidPayment(p)}>{t("作廢")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- 年度彙總 --- */}
      <div className="card">
        <h3>{t("年度彙總（申報各類所得憑單的取數來源）")}</h3>
        {summary && (summary.total.unsetTaxRateCount > 0 || summary.total.unsetSupplementRateCount > 0) && (
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--red)" }}>
            {t("⚠ 本年度有")}
            {summary.total.unsetTaxRateCount > 0 && <strong> {t("{n} 筆", { n: summary.total.unsetTaxRateCount })}</strong>}
            {summary.total.unsetTaxRateCount > 0 && t("在尚未設定扣繳率時建立")}
            {summary.total.unsetTaxRateCount > 0 && summary.total.unsetSupplementRateCount > 0 && t("、")}
            {summary.total.unsetSupplementRateCount > 0 && <strong> {t("{n} 筆", { n: summary.total.unsetSupplementRateCount })}</strong>}
            {summary.total.unsetSupplementRateCount > 0 && t("在尚未設定補充保費率時建立")}
            {t("，那些代扣金額是")}<strong>{t("以 0 計")}</strong>{t("——這不代表不用扣，只代表系統當時不知道要扣多少。下表以紅字標出。補設費率")}<strong>{t("不會回頭重算已建立的單據")}</strong>{t("，需要更正的請自行判斷處理方式。")}
          </p>
        )}
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void loadSummary(year); }}>
          <label className="field">
            {t("年度（西元，依給付日歸年）")}
            <input type="number" min={2000} max={2200} value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </label>
          <button className="primary">{t("查詢")}</button>
        </form>
        {summary && (
          <>
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>{t("受領人")}</th><th>{t("類別")}</th><th className="num">{t("筆數")}</th>
                  <th className="num">{t("給付總額")}</th><th className="num">{t("代扣所得稅")}</th>
                  <th className="num">{t("代扣補充保費")}</th><th className="num">{t("實付")}</th><th>{t("身分證號")}</th><th></th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => (
                  <tr key={`${r.partnerId}:${r.categoryId}`}>
                    <td>{r.partnerName}</td>
                    <td>{r.categoryLabel}</td>
                    <td className="num">{r.count}</td>
                    <td className="num">{fmt(r.grossAmount)}</td>
                    {/* 未設費率而算出的 0 必須看得出來：它跟「查過確實不用扣的 0」在數字上一模一樣，
                        而這張表是申報憑單的取數來源——不標出來，使用者永遠不會發現自己漏設了費率 */}
                    <td className="num" style={r.unsetTaxRateCount > 0 ? { color: "var(--red)" } : undefined}>
                      {fmt(r.taxWithheld)}
                      {r.unsetTaxRateCount > 0 && (
                        <span title={t("其中 {n} 筆建立時尚未設定扣繳率，代扣以 0 計", { n: r.unsetTaxRateCount })}>
                          {" "}⚠{r.unsetTaxRateCount}
                        </span>
                      )}
                    </td>
                    <td className="num" style={r.unsetSupplementRateCount > 0 ? { color: "var(--red)" } : undefined}>
                      {fmt(r.supplementWithheld)}
                      {r.unsetSupplementRateCount > 0 && (
                        <span title={t("其中 {n} 筆建立時尚未設定補充保費率，代扣以 0 計", { n: r.unsetSupplementRateCount })}>
                          {" "}⚠{r.unsetSupplementRateCount}
                        </span>
                      )}
                    </td>
                    <td className="num">{fmt(r.netAmount)}</td>
                    <td>
                      {revealed[r.partnerId] ? (
                        <code>{revealed[r.partnerId]}</code>
                      ) : r.hasIdNo ? (
                        <button className="small" onClick={() => void reveal(r.partnerId)}>{t("顯示")}</button>
                      ) : (
                        <span style={{ color: "var(--red)" }}>{t("未填")}</span>
                      )}
                    </td>
                    {/* 套印一張憑單參考單（受領人×類別＝一張）：正式憑單仍以申報軟體產製 */}
                    <td><button className="small" onClick={() => void openSlip(r)}>{t("套印")}</button></td>
                  </tr>
                ))}
                {summary.rows.length === 0 && (
                  <tr><td colSpan={9}>{t("{year} 年沒有扣繳支出紀錄。", { year: summary.year })}</td></tr>
                )}
              </tbody>
              {summary.rows.length > 0 && (
                <tfoot>
                  <tr>
                    <th colSpan={2}>{t("合計")}</th>
                    <th className="num">{summary.total.count}</th>
                    <th className="num">{fmt(summary.total.grossAmount)}</th>
                    <th className="num">{fmt(summary.total.taxWithheld)}</th>
                    <th className="num">{fmt(summary.total.supplementWithheld)}</th>
                    <th className="num">{fmt(summary.total.netAmount)}</th>
                    <th></th>
                    <th></th>
                  </tr>
                </tfoot>
              )}
            </table>
            <p style={{ margin: "12px 0 6px" }}>
              {t("這是申報憑單的取數來源。本系統")}<strong>{t("不產生")}</strong>{t("憑單媒體檔（固定長度欄位的格式規格尚未取得，見 ")}<code>docs/specs/withholding.md</code>{t("），請以財政部的申報軟體填報，並自行核對每一位受領人的金額與身分資料。身分證號沒填的受領人請先補填，否則憑單填不出來（在「客戶與商品」頁補）。")}
            </p>
            <div className="stat-row">
              {summary.liabilities.map((l) => (
                <div className="stat" key={l.code}>
                  <div className="label">{l.code} {l.name}</div>
                  <div className="value">{fmt(l.balance)}</div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 13, color: "var(--text-2)", margin: "6px 0 0" }}>
              {t("上面兩個餘額是")}<strong>{t("已經從對方身上扣下來、但還沒繳出去")}</strong>{t("的稅款與保費（不分年度，是「現在還欠多少」）。繳款之後請到「傳票」頁開一張手工傳票沖掉它（借 2211／2212、貸 銀行存款），餘額就會回到 0。")}
              <strong>{t("系統不提示繳納期限")}</strong>{t("——期限請依國稅局／健保署的公告辦理。")}
            </p>
          </>
        )}
      </div>
      {slip && summary && (
        <WithholdingSlipView
          year={summary.year}
          row={slip.row}
          idNo={slip.idNo}
          company={company.data}
          onClose={() => setSlip(null)}
        />
      )}
    </div>
  );
}

/**
 * 類別的一列：費率與依據來源就地編輯。
 * 費率輸入用百分比（人腦的單位），存的是 basis point（整數，避免浮點）——
 * 轉換只在這一層發生，percentToBp／bpToPercentText 與伺服端共用同一份定義。
 */
function CategoryRow(props: {
  category: WithholdingCategory;
  accounts: Account[];
  onSaved: () => void;
  onError: (msg: string | null) => void;
}) {
  const t = useT();
  const { category: c } = props;
  const [editing, setEditing] = useState(false);
  const [tax, setTax] = useState(c.taxRateBp === null ? "" : bpToPercentText(c.taxRateBp));
  const [supplement, setSupplement] = useState(
    c.supplementRateBp === null ? "" : bpToPercentText(c.supplementRateBp),
  );
  const [source, setSource] = useState(c.sourceNote ?? "");

  /** 空字串＝清回「尚未設定」（送 null）；有值就轉 bp */
  const toBp = (text: string): number | null | undefined => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const bp = percentToBp(Number(trimmed));
    if (bp === null) return undefined; // 呼叫端據此擋下
    return bp;
  };

  const save = async () => {
    const taxBp = toBp(tax);
    const supplementBp = toBp(supplement);
    if (taxBp === undefined || supplementBp === undefined) {
      props.onError(t("費率請填 0 到 100 之間的百分比，可帶小數（例如 3.5）；留空代表尚未設定"));
      return;
    }
    try {
      await api.patch(`/withholding-categories/${c.id}`, {
        taxRateBp: taxBp,
        supplementRateBp: supplementBp,
        sourceNote: source.trim() || null,
      });
      props.onError(null);
      setEditing(false);
      props.onSaved();
    } catch (e) {
      props.onError((e as Error).message);
    }
  };

  const toggleActive = async () => {
    try {
      await api.patch(`/withholding-categories/${c.id}`, { active: !c.active });
      props.onError(null);
      props.onSaved();
    } catch (e) {
      props.onError((e as Error).message);
    }
  };

  const accountName = props.accounts.find((a) => a.code === c.expenseAccountCode);
  return (
    <tr>
      <td>{c.label}</td>
      <td>
        {c.expenseAccountCode} {accountName?.name ?? t("（科目不存在）")}
        {accountName && !accountName.active && <span style={{ color: "var(--red)" }}>{t("（已停用，開單會被擋）")}</span>}
      </td>
      {editing ? (
        <>
          <td className="num">
            <input style={{ width: 70 }} value={tax} onChange={(e) => setTax(e.target.value)} placeholder="%" />
          </td>
          <td className="num">
            <input style={{ width: 70 }} value={supplement} onChange={(e) => setSupplement(e.target.value)} placeholder="%" />
          </td>
          <td>
            <input
              style={{ width: 260 }}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={t("例如：依據 XXX 頁面，查詢日 2026-07-30")}
            />
          </td>
          <td>{c.active ? t("啟用") : t("停用")}</td>
          <td>
            <button className="small" onClick={() => void save()}>{t("儲存")}</button>{" "}
            <button className="small" onClick={() => setEditing(false)}>{t("取消")}</button>
          </td>
        </>
      ) : (
        <>
          <td className="num" style={c.taxRateBp === null ? { color: "var(--amber)" } : undefined}>
            {rateText(t, c.taxRateBp)}
          </td>
          <td className="num" style={c.supplementRateBp === null ? { color: "var(--amber)" } : undefined}>
            {rateText(t, c.supplementRateBp)}
          </td>
          <td>
            {c.sourceNote ?? (
              <span style={{ color: "var(--amber)" }}>
                {c.taxRateBp === null && c.supplementRateBp === null ? "—" : t("未註明依據來源")}
              </span>
            )}
          </td>
          <td><span className={`badge ${c.active ? "issued" : "canceled"}`}>{c.active ? t("啟用") : t("停用")}</span></td>
          <td>
            <button className="small" onClick={() => setEditing(true)}>{t("填費率／來源")}</button>{" "}
            <button className="small" onClick={() => void toggleActive()}>{c.active ? t("停用") : t("啟用")}</button>
          </td>
        </>
      )}
    </tr>
  );
}
