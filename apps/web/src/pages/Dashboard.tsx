import { nextPeriod, periodOf } from "@tw-erp/einvoice";
import { Fragment, useEffect, useState } from "react";
import { api } from "../api.ts";
import { useAuth } from "../auth.ts";
import { fmt, useFetch } from "../hooks.ts";
import { useT } from "../i18n.ts";
import { useNav } from "../ui.tsx";
import type {
  DashboardData,
  DocRow,
  InventoryAdjustment,
  InventoryMovementLedger,
  InventoryRow,
  Partner,
  Product,
  QuoteRow,
  StocktakeRow,
  Track,
  TrialBalance,
  UpcomingRow,
  UserRow,
} from "../types.ts";

/**
 * 開始使用前的準備（管理者/財務）：docs/before-you-start.md 的一頁清單版。
 *
 * 跟下面 GettingStarted 的分工：那張卡檢查的是「系統裡有沒有資料」（公司檔填了沒、字軌建了沒），
 * 它檢查不到**系統外**的準備——稅率的依據來源查了沒、切換日的試算表跟記帳士要了沒。
 * 這些只有人自己知道，所以這張卡是勾選清單，不是自動偵測。
 *
 * 勾選狀態存瀏覽器本機、按使用者 id 分 key（沿用 AgentChat 的做法）：這是「我準備到哪」的個人備忘，
 * 不是公司資料，進資料庫反而會讓兩個管理者互相蓋掉對方的進度。
 * 全部勾完自動收起——與 GettingStarted 同一個形狀，不佔版面。
 *
 * ★ 零斷言：這裡只列「你要去查哪些數字」，不寫任何稅率、級距、倍率或期限的值。
 */
const PREP_ITEMS = [
  { key: "cutover", t: "訂好切換日", d: "從哪一天開始用這套記帳——期初餘額全部是那一天的餘額" },
  { key: "ids", t: "統編、稅籍編號（9 碼）、縣市別代號（1 碼）", d: "後兩個跟統編是不同的東西，申報用的是它們" },
  { key: "vat", t: "營業稅率＋你查到的依據來源", d: "系統不內建任何稅率；填進「稅法參數」時要附出處" },
  { key: "tracks", t: "（要開發票）字軌核准、期別與號碼區間", d: "先向主管機關申請核准，再到大平台取號" },
  { key: "hr-rates", t: "（要用薪資／扣繳）倍率、級距、上限，每個都有依據", d: "這一段建議整段轉給記帳士" },
  { key: "masters", t: "第一批客戶、供應商、商品", d: "至少要有第一張單會用到的那幾筆" },
  { key: "opening", t: "切換日的試算表，應收應付逐筆", d: "只給總額之後沖帳勾不了單；建議直接請記帳士提供" },
  { key: "roles", t: "每個人要給什麼角色", d: "要報銷的人帳號得連結員工主檔" },
] as const;

function prepStorageKey(userId: number): string {
  return `eternal-prep:${userId}`;
}

function readPrep(userId: number): Set<string> {
  try {
    const raw = localStorage.getItem(prepStorageKey(userId));
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(); // 私密模式或被擋：當成什麼都沒勾，不能讓首頁因此掛掉
  }
}

export function PrepChecklist() {
  const t = useT();
  const me = useAuth();
  const [done, setDone] = useState<Set<string>>(() => readPrep(me.id));

  const toggle = (key: string) => {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(prepStorageKey(me.id), JSON.stringify([...next]));
      } catch {
        /* 存不進去就只活在這次畫面裡，勾選本身照常運作 */
      }
      return next;
    });
  };

  const remaining = PREP_ITEMS.filter((it) => !done.has(it.key)).length;
  if (remaining === 0) return null;

  return (
    <div className="card">
      <h3>{t("開始使用前的準備（還缺 {n} 項）", { n: remaining })}</h3>
      <p>
        {t("這些是系統外的功課，勾起來只是給你自己看的備忘。完整說明見 repo 的 ")}<code>docs/before-you-start.md</code>{t("。")}
      </p>
      <ul className="checklist">
        {PREP_ITEMS.map((it) => {
          const ok = done.has(it.key);
          return (
            <li key={it.key} className={ok ? "done" : ""}>
              <input
                type="checkbox"
                id={`prep-${it.key}`}
                checked={ok}
                onChange={() => toggle(it.key)}
                aria-label={t(it.t)}
              />
              <label htmlFor={`prep-${it.key}`} className="body">
                <div className="t">{t(it.t)}</div>
                <div className="d">{t(it.d)}</div>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 開始使用清單（管理者/財務）：照著點就把系統設定完；全部完成後自動收起 */
function GettingStarted() {
  const t = useT();
  const nav = useNav();
  const company = useFetch<{ name: string } | null>("/company-profile");
  const users = useFetch<UserRow[]>("/users");
  const partners = useFetch<Partner[]>("/partners");
  const products = useFetch<Product[]>("/products");
  const purchases = useFetch<DocRow[]>("/purchases");
  const quotes = useFetch<QuoteRow[]>("/quotes");
  const tracks = useFetch<Track[]>("/invoice-tracks");

  // 當期字軌期別：直接吃 API 配號同一個 periodOf（雙月一期、奇數月起算），不在前端另抄一份規則。
  // done 條件是「當期有還開得出號碼的區間」——沒設定就開不出第一張發票，
  // 而原本這份清單五步做完就收起，使用者從此不會再被提醒（B7）
  const currentPeriod = periodOf(new Date().toISOString().slice(0, 10));

  const steps = [
    {
      done: !!company.data && !company.error,
      t: "填公司基本檔",
      d: "公司名稱與統編——開發票、報稅都要用",
      page: "settings" as const,
      label: "去設定",
    },
    {
      done: (users.data?.length ?? 0) > 1,
      t: "幫同事開帳號",
      d: "每個人用自己的帳號登入，看到的功能跟著角色走",
      page: "settings" as const,
      label: "新增帳號",
    },
    {
      done: (partners.data?.length ?? 0) > 0 && (products.data?.length ?? 0) > 0,
      t: "建立客戶與商品",
      d: "有了基本資料，開單時下拉選單才有東西可選",
      page: "masters" as const,
      label: "去建資料",
    },
    {
      done: (tracks.data ?? []).some((t) => t.period === currentPeriod && t.nextNo <= t.rangeEnd),
      t: "設定發票字軌",
      d: "把國稅局核准的當期字軌區間輸進來——沒有這一步，出貨後開不出第一張發票",
      page: "settings" as const,
      label: "設定字軌",
    },
    {
      done: (purchases.data?.length ?? 0) > 0,
      t: "記第一筆進貨",
      d: "把現有庫存或新叫的貨記進來，之後銷貨才有成本可算",
      page: "purchases" as const,
      label: "記進貨",
    },
    {
      done: (quotes.data?.length ?? 0) > 0,
      t: "開第一張報價單",
      d: "報價 → 成交轉訂單 → 出貨，帳會自動記好",
      page: "orders" as const,
      label: "開報價",
    },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  if (remaining === 0) return null; // 都完成了，不佔版面

  return (
    <div className="card">
      <h3>{t("開始使用（還剩 {n} 步）", { n: remaining })}</h3>
      <ul className="checklist">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? "done" : ""}>
            <span className="mark">{s.done ? "✓" : i + 1}</span>
            <span className="body">
              <div className="t">{t(s.t)}</div>
              <div className="d">{t(s.d)}</div>
            </span>
            {!s.done && (
              <button className="small" onClick={() => nav(s.page)}>{t(s.label)}</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 下一期字軌的預先提醒（B7 尾款）：只在「當期字軌存在、下期還沒建」時出現——
 * 當期都沒建的走上面的開始使用清單，不重複唸；下期建好了就安靜。
 * 刻意不斷言任何申報或建軌期限（那是稅法的事實，不是系統的知識），
 * 只講機制：發票要連號使用，下期開始前要先建好字軌，否則換期第一張發票會開不出來。
 */
function NextTrackReminder() {
  const t = useT();
  const nav = useNav();
  const tracks = useFetch<Track[]>("/invoice-tracks");
  const current = periodOf(new Date().toISOString().slice(0, 10));
  const next = nextPeriod(current);
  const hasCurrent = (tracks.data ?? []).some((t) => t.period === current);
  const hasNext = (tracks.data ?? []).some((t) => t.period === next);
  if (!tracks.data || !hasCurrent || hasNext) return null;
  return (
    <div className="card">
      <p style={{ margin: 0, fontSize: 14, color: "var(--red)" }}>
        <strong>{t("下一期（{year} 年 {from}–{to} 月）的發票字軌尚未建立。", { year: next.slice(0, 4), from: Number(next.slice(4)), to: Number(next.slice(4)) + 1 })}</strong>{" "}
        {t("發票要連號使用，下期開始前要先建好字軌——收到國稅局核准的下期字軌區間後，請到「設定」頁輸入，否則換期後第一張發票會開不出來。")}{" "}
        <button className="small" onClick={() => nav("settings")}>{t("去設定字軌")}</button>
      </p>
    </div>
  );
}

/**
 * 還沒做完的事（0047）：合約待請款／待付款、固定支出到期、合約快到期，合成一張卡。
 * 一個人的公司沒有人會替你打開那一頁——首頁就是那個人。
 * **每一列的日期都是使用者自己設定的**：系統不知道也不提示任何法定申報或繳費期限。
 * 全空時整張卡不渲染（同「開始使用」清單收起的形狀）。
 */
function Upcoming({ rows }: { rows: UpcomingRow[] }) {
  const t = useT();
  const nav = useNav();
  if (!rows.length) return null;
  const overdueCount = rows.filter((r) => r.overdue).length;
  return (
    <div className="card">
      <h3>
        {overdueCount > 0
          ? t("還沒做完的事（30 天內，其中 {n} 筆已過你設定的日期）", { n: overdueCount })
          : t("還沒做完的事（30 天內）")}
      </h3>
      <table>
        <thead>
          <tr><th>{t("類型")}</th><th>{t("項目")}</th><th>{t("日期")}</th><th className="num">{t("金額")}</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}-${r.date}-${i}`} style={r.overdue ? { background: "var(--red-tint)" } : undefined}>
              <td>{t(r.label)}</td>
              <td>{r.detail}</td>
              <td>{r.date}{r.overdue && t("（已過）")}</td>
              <td className="num">{r.amount === null ? "—" : fmt(r.amount)}</td>
              <td><button className="small" onClick={() => nav(r.page)}>{t("前往")}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 13, color: "var(--text-2)" }}>
        {t("這裡的每一筆日期都是你自己在合約或固定支出上設定的。系統不知道、也不會提示任何法定申報或繳費的時間——那些請你自己查證後設成固定支出。")}
      </p>
    </div>
  );
}

/** 經營儀表板（總經理/財務/管理者）：一眼看懂公司現況 */
function BizStats() {
  const t = useT();
  const today = new Date().toISOString().slice(0, 10);
  const d = useFetch<DashboardData>(`/reports/dashboard?asOf=${today}`);
  if (!d.data) return null;
  const s = d.data;
  const stat = (label: string, value: string, warn = false) => (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={warn ? { color: "var(--red)" } : undefined}>{value}</div>
    </div>
  );
  return (
    <>
      <div className="stat-row">
        {stat(t("本月營收（{month}，未稅）", { month: s.month }), fmt(s.revenue.subtotal))}
        {stat(t("本月毛利"), fmt(s.revenue.grossProfit))}
        {stat(t("現金水位"), fmt(s.cash), s.cash < 0)}
        {stat(t("應收未收"), fmt(s.ar))}
        {stat(t("應付未付"), fmt(s.ap))}
      </div>
      <div className="stat-row">
        {stat(t("在手訂單（{n} 張未出貨，未稅）", { n: s.backlog.count }), fmt(s.backlog.amount))}
        {stat(t("未到貨採購（{n} 張，未稅）", { n: s.inbound.count }), fmt(s.inbound.amount))}
        {stat(t("報銷待核（{n} 件）", { n: s.pendingClaims.count }), fmt(s.pendingClaims.amount))}
        {/* R13：已核准未付＝公司現在欠員工的錢；逐員工的明細在「報銷」頁的待付彙總 */}
        {stat(t("待付報銷（{n} 件，欠員工）", { n: s.approvedUnpaidClaims.count }), fmt(s.approvedUnpaidClaims.amount))}
        {/* 逾期＝過了收款到期日還沒收到（不再是硬編碼 30 天）；無到期日的舊單以單據日估算 */}
        {stat(t("逾期應收（已到期未收）"), fmt(s.overdueAr), s.overdueAr > 0)}
      </div>
      <Upcoming rows={s.upcoming ?? []} />
    </>
  );
}

const REASON_LABEL: Record<InventoryAdjustment["reason"], string> = {
  count: "盤點差異",
  scrap: "報廢",
  expiry: "過期報廢",
};

/**
 * 庫存調整（0026，B8；限 admin/finance——API 同此限制）：
 * ①盤點：載入底稿（現有品項＋帳面量）→ 填實盤量 → 差異由系統算、整批建調整單。
 * ②報廢／手動調整：直接填調整量（負數＝減）。
 * ③調整歷史：含明細與作廢入口（更正＝作廢＋重開，與其他單據同一原則）。
 */
function InventoryAdjustments({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const history = useFetch<InventoryAdjustment[]>("/inventory/adjustments");
  const products = useFetch<Product[]>("/products");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  // 盤點底稿：counted 以字串保存，空字串＝這個品項這次沒盤（不送）
  const [sheet, setSheet] = useState<StocktakeRow[] | null>(null);
  const [counted, setCounted] = useState<Record<number, string>>({});
  const [stockDate, setStockDate] = useState(today);
  const [stockMemo, setStockMemo] = useState("");

  const loadSheet = async () => {
    try {
      setSheet(await api.get<StocktakeRow[]>("/inventory/stocktake"));
      setCounted({});
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submitStocktake = async () => {
    try {
      const lines = (sheet ?? [])
        .filter((r) => counted[r.productId] !== undefined && counted[r.productId] !== "")
        .map((r) => ({ productId: r.productId, countedQty: Number(counted[r.productId]) }));
      if (!lines.length) throw new Error(t("請至少填一個品項的實盤量（沒盤到的品項留空即可）"));
      const res = await api.post<{ adjustment: { id: number; totalIn: number; totalOut: number } | null; message: string | null }>(
        "/inventory/stocktake",
        { docDate: stockDate, ...(stockMemo.trim() ? { memo: stockMemo.trim() } : {}), lines },
      );
      setError(null);
      setOk(
        res.adjustment
          ? t("盤點完成：調整單 #{id}（盤盈 {inAmt} 元、盤虧 {outAmt} 元），傳票已自動拋轉", { id: res.adjustment.id, inAmt: fmt(res.adjustment.totalIn), outAmt: fmt(res.adjustment.totalOut) })
          : (res.message ?? t("實盤量與帳面量一致，未建立調整單")),
      );
      setSheet(null);
      setCounted({});
      setStockMemo("");
      history.reload();
      onChanged();
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  // 報廢／手動調整
  const [adjDate, setAdjDate] = useState(today);
  const [adjReason, setAdjReason] = useState<InventoryAdjustment["reason"]>("scrap");
  const [adjMemo, setAdjMemo] = useState("");
  const [adjLines, setAdjLines] = useState<{ productId: number; qtyDiff: number }[]>([{ productId: 0, qtyDiff: 0 }]);
  const setAdjLine = (i: number, patch: Partial<{ productId: number; qtyDiff: number }>) =>
    setAdjLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submitAdjustment = async () => {
    try {
      const lines = adjLines.filter((l) => l.productId && l.qtyDiff !== 0);
      if (!lines.length) throw new Error(t("至少一筆有效明細（商品＋不為 0 的調整量）"));
      // 報廢／過期只會讓庫存變少：使用者多半直接填正數數量，這裡自動轉負，不要求他想「負號」
      const signed =
        adjReason === "count" ? lines : lines.map((l) => ({ ...l, qtyDiff: -Math.abs(l.qtyDiff) }));
      const res = await api.post<{ id: number; totalIn: number; totalOut: number }>("/inventory/adjustments", {
        docDate: adjDate,
        reason: adjReason,
        ...(adjMemo.trim() ? { memo: adjMemo.trim() } : {}),
        lines: signed,
      });
      setError(null);
      setOk(t("調整單 #{id} 已建立（盤盈 {inAmt} 元、盤虧報廢 {outAmt} 元），傳票已自動拋轉", { id: res.id, inAmt: fmt(res.totalIn), outAmt: fmt(res.totalOut) }));
      setAdjLines([{ productId: 0, qtyDiff: 0 }]);
      setAdjMemo("");
      history.reload();
      onChanged();
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  /** 作廢調整單：反向傳票沖總帳、庫存以原成本回補；打錯的請作廢後重開 */
  const voidAdjustment = async (a: InventoryAdjustment) => {
    const reason = window.prompt(
      t("作廢庫存調整單 #{id}（{date} {reason}）：請輸入作廢理由。", { id: a.id, date: a.docDate, reason: t(REASON_LABEL[a.reason]) }) + "\n" +
        t("系統會開反向傳票沖平總帳、庫存以原成本回補；打錯的調整請作廢後重開一張。"),
    );
    if (reason === null) return;
    try {
      await api.post(`/inventory/adjustments/${a.id}/void`, { reason: reason.trim() });
      setError(null);
      history.reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}

      <div className="card">
        <h3>{t("盤點（載入底稿 → 填實盤量 → 系統算差異建調整單）")}</h3>
        {!sheet && (
          <button className="primary" onClick={() => void loadSheet()}>{t("載入盤點底稿")}</button>
        )}
        {sheet && (
          <>
            <form className="inline" onSubmit={(e) => e.preventDefault()}>
              <label className="field">{t("盤點日")}<input type="date" value={stockDate} onChange={(e) => setStockDate(e.target.value)} /></label>
              <label className="field">{t("備註")}<input value={stockMemo} onChange={(e) => setStockMemo(e.target.value)} placeholder={t("例：月底例行盤點")} style={{ width: 220 }} /></label>
            </form>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr><th>SKU</th><th>{t("品名")}</th><th className="num">{t("帳面量")}</th><th className="num">{t("實盤量（留空＝未盤，不調整）")}</th></tr>
              </thead>
              <tbody>
                {sheet.map((r) => {
                  const v = counted[r.productId] ?? "";
                  const diff = v === "" ? null : Number(v) - r.bookQty;
                  return (
                    <tr key={r.productId}>
                      <td>{r.sku}</td>
                      <td>{r.name}</td>
                      <td className="num">{r.bookQty} {r.unit}</td>
                      <td className="num">
                        <input
                          type="number"
                          min={0}
                          value={v}
                          style={{ width: 100 }}
                          onChange={(e) => setCounted((m) => ({ ...m, [r.productId]: e.target.value }))}
                        />
                        {/* 差異即時顯示，但只是預覽——正式差異在送出當下以最新帳面量重算 */}
                        {diff !== null && diff !== 0 && (
                          <span style={{ marginLeft: 8, color: diff < 0 ? "var(--red)" : "var(--green)" }}>
                            {diff > 0 ? t("盤盈 +{n}", { n: diff }) : t("盤虧 {n}", { n: diff })}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ marginTop: 12 }}>
              <button className="primary" onClick={() => void submitStocktake()}>{t("送出盤點結果")}</button>{" "}
              <button className="small" onClick={() => setSheet(null)}>{t("取消")}</button>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-2)" }}>
              {t("差異由系統計算（實盤量 − 送出當下的帳面量），以當下移動平均成本計價並自動拋轉傳票（盤盈借存貨貸存貨盤盈、盤虧借存貨盤損貸存貨）；調整後平均成本不變。")}
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h3>{t("報廢／庫存調整（過期、破損、已知差異）")}</h3>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="field">{t("日期")}<input type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} /></label>
          <label className="field">
            {t("原因")}
            <select value={adjReason} onChange={(e) => setAdjReason(e.target.value as InventoryAdjustment["reason"])}>
              <option value="scrap">{t("報廢（破損）")}</option>
              <option value="expiry">{t("過期報廢")}</option>
              <option value="count">{t("盤點差異（可正可負）")}</option>
            </select>
          </label>
          <label className="field">{t("備註")}<input value={adjMemo} onChange={(e) => setAdjMemo(e.target.value)} placeholder={t("例：冷凍庫故障報廢")} style={{ width: 220 }} /></label>
        </form>
        {adjLines.map((l, i) => (
          <form key={i} className="inline" style={{ marginTop: 8 }} onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              {t("商品")}
              <select value={l.productId} onChange={(e) => setAdjLine(i, { productId: Number(e.target.value) })}>
                <option value={0}>{t("— 請選擇 —")}</option>
                {products.data?.filter((p) => !p.isService).map((p) => (
                  <option key={p.id} value={p.id}>{p.sku} {p.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              {adjReason === "count" ? t("調整量（負數＝減）") : t("報廢數量")}
              <input type="number" value={l.qtyDiff} onChange={(e) => setAdjLine(i, { qtyDiff: Number(e.target.value) })} />
            </label>
            {i === adjLines.length - 1 && (
              <button className="small" onClick={() => setAdjLines((ls) => [...ls, { productId: 0, qtyDiff: 0 }])}>
                {t("＋明細")}
              </button>
            )}
          </form>
        ))}
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void submitAdjustment()}>{t("建立調整單")}</button>
        </div>
      </div>

      {(history.data?.length ?? 0) > 0 && (
        <div className="card">
          <h3>{t("庫存調整歷史")}</h3>
          <table>
            <thead>
              <tr><th>{t("單號")}</th><th>{t("日期")}</th><th>{t("原因")}</th><th>{t("明細")}</th><th className="num">{t("盤盈")}</th><th className="num">{t("盤虧／報廢")}</th><th /></tr>
            </thead>
            <tbody>
              {history.data?.map((a) => (
                <tr key={a.id}>
                  <td>#{a.id}</td>
                  <td>{a.docDate}</td>
                  <td>
                    {t(REASON_LABEL[a.reason])}
                    {a.memo && <span style={{ color: "var(--text-2)" }}>（{a.memo}）</span>}{" "}
                    {a.voidedAt && (
                      <span className="badge canceled" title={t("作廢理由：{reason}（沖轉傳票 #{entry}）", { reason: a.voidReason ?? "", entry: a.reversalEntryId ?? "—" })}>
                        {t("已作廢")}
                      </span>
                    )}
                  </td>
                  <td>
                    {a.lines.map((l) => (
                      <div key={l.id}>
                        {l.sku} {l.productName}：{l.direction === "in" ? "+" : "−"}{Number(l.qty)}
                        {l.countedQty !== null && l.bookQty !== null && (
                          <span style={{ color: "var(--text-2)" }}>{t("（帳面 {book} → 實盤 {counted}）", { book: Number(l.bookQty), counted: Number(l.countedQty) })}</span>
                        )}
                        {t("＝{amount} 元", { amount: fmt(l.amount) })}
                      </div>
                    ))}
                  </td>
                  <td className="num">{a.totalIn ? fmt(a.totalIn) : "—"}</td>
                  <td className="num">{a.totalOut ? fmt(a.totalOut) : "—"}</td>
                  <td>
                    {!a.voidedAt && (
                      <button className="small" onClick={() => void voidAdjustment(a)}>{t("作廢")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * 庫存異動明細帳（R9，0035）：點商品展開——逐筆異動（來源單據、進出量、單價、結存），
 * 均價的每一次變動可追。日期範圍選填；期初＝範圍前異動的淨額，結存接著走。
 */
function MovementLedger(props: { productId: number }) {
  const t = useT();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ledger, setLedger] = useState<InventoryMovementLedger | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const q = new URLSearchParams({ productId: String(props.productId) });
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      setLedger(await api.get<InventoryMovementLedger>(`/inventory/movements?${q}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // 首次展開自動載入（不用多按一次）；改了日期再按「查詢」
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.productId]);

  return (
    <div style={{ padding: "8px 0" }}>
      {error && <div className="error">{error}</div>}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="field">{t("起日（選填）")}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">{t("迄日（選填）")}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="small">{t("查詢")}</button>
      </form>
      {ledger && (
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>{t("日期")}</th><th>{t("來源單據")}</th><th className="num">{t("入庫量")}</th><th className="num">{t("出庫量")}</th>
              <th className="num">{t("單位成本")}</th><th className="num">{t("金額")}</th><th className="num">{t("結存量")}</th><th className="num">{t("結存金額")}</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ color: "var(--text-2)" }}>
              <td>{ledger.from ?? t("（期初）")}</td><td>{t("期初結存")}</td>
              <td className="num"></td><td className="num"></td><td className="num"></td><td className="num"></td>
              <td className="num">{ledger.opening.qty}</td>
              <td className="num">{fmt(ledger.opening.amount)}</td>
            </tr>
            {ledger.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.docDate}</td>
                <td>{r.sourceLabel}</td>
                <td className="num">{r.direction === "in" ? r.qty : ""}</td>
                <td className="num">{r.direction === "out" ? r.qty : ""}</td>
                <td className="num">{r.unitCost}</td>
                <td className="num">{fmt(r.amount)}</td>
                <td className="num">{r.balanceQty}</td>
                <td className="num">{fmt(r.balanceAmount)}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 600 }}>
              <td>{ledger.to ?? ""}</td><td>{t("期末結存")}</td>
              <td className="num"></td><td className="num"></td><td className="num"></td><td className="num"></td>
              <td className="num">{ledger.closing.qty}</td>
              <td className="num">{fmt(ledger.closing.amount)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {ledger && ledger.rows.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>{t("此期間沒有異動。")}</p>
      )}
    </div>
  );
}

export function Dashboard() {
  const t = useT();
  const me = useAuth();
  const tb = useFetch<TrialBalance>("/trial-balance");
  const inv = useFetch<InventoryRow[]>("/inventory");
  const canSeeBiz = me.role === "gm" || me.role === "finance" || me.role === "admin";
  // 庫存異動明細帳（R9）：點商品展開；再點收合
  const [ledgerProductId, setLedgerProductId] = useState<number | null>(null);

  return (
    <div>
      {/* 準備清單在系統清單前面：先湊齊資料，再照順序設定（docs/before-you-start.md → SOP） */}
      {(me.role === "admin" || me.role === "finance") && <PrepChecklist />}
      {(me.role === "admin" || me.role === "finance") && <GettingStarted />}
      {/* 下一期字軌提醒（B7 尾款）：放在開始使用清單後面；清單全完成收起後這條仍會單獨出現 */}
      {(me.role === "admin" || me.role === "finance") && <NextTrackReminder />}
      {canSeeBiz && <BizStats />}
      <div className="stat-row">
        <div className="stat">
          <div className="label">{t("試算表借方合計")}</div>
          <div className="value">{tb.data ? fmt(tb.data.totalDebit) : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">{t("試算表貸方合計")}</div>
          <div className="value">{tb.data ? fmt(tb.data.totalCredit) : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">{t("借貸平衡")}</div>
          <div className="value">{tb.data ? (tb.data.totalDebit === tb.data.totalCredit ? "✓" : "✗") : "—"}</div>
        </div>
      </div>

      <div className="card">
        <h3>{t("試算表")}</h3>
        <table>
          <thead>
            <tr><th>{t("科目")}</th><th>{t("名稱")}</th><th className="num">{t("借方")}</th><th className="num">{t("貸方")}</th></tr>
          </thead>
          <tbody>
            {tb.data?.rows.map((r) => (
              <tr key={r.code}>
                <td>{r.code}</td>
                <td>{r.name}</td>
                <td className="num">{fmt(r.debit)}</td>
                <td className="num">{fmt(r.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>{t("庫存（服務項目不入庫存，不列；點「明細」看逐筆異動與結存）")}</h3>
        <table>
          <thead>
            <tr><th>SKU</th><th>{t("品名")}</th><th className="num">{t("在庫量")}</th><th className="num">{t("安全庫存")}</th><th className="num">{t("平均成本")}</th><th className="num">{t("帳面金額")}</th><th></th></tr>
          </thead>
          <tbody>
            {inv.data?.map((r) => (
              <Fragment key={r.productId}>
                <tr>
                  <td>{r.sku}</td>
                  <td>{r.name}</td>
                  {/* 低於安全庫存只標色提醒補貨，不擋任何單據 */}
                  <td className="num" style={r.belowMinStock ? { color: "var(--red)", fontWeight: 600 } : undefined}>
                    {r.qty}{r.belowMinStock && t("（低於安全庫存）")}
                  </td>
                  <td className="num">{r.minStock ?? "—"}</td>
                  <td className="num">{r.avgUnitCost ?? "—"}</td>
                  <td className="num">{fmt(r.amount)}</td>
                  <td>
                    <button
                      className="small"
                      onClick={() => setLedgerProductId((cur) => (cur === r.productId ? null : r.productId))}
                    >
                      {ledgerProductId === r.productId ? t("收合") : t("明細")}
                    </button>
                  </td>
                </tr>
                {ledgerProductId === r.productId && (
                  <tr>
                    <td colSpan={7}>
                      <MovementLedger productId={r.productId} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          {/* 合計列（B6-b）：與資產負債表的存貨科目對帳就靠這個數字——沒有它，
              想核對的人得把逐品金額自己加一遍，等於畫面上讀不到「庫存總額」 */}
          {inv.data && inv.data.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={5} style={{ fontWeight: 600 }}>{t("合計（應與資產負債表的存貨科目一致）")}</td>
                <td className="num" style={{ fontWeight: 600 }}>
                  {fmt(inv.data.reduce((s, r) => s + r.amount, 0))}
                </td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* 庫存調整（B8）：盤點／報廢／盤虧的入口與歷史。API 限 admin/finance，畫面同步只給這兩個角色 */}
      {(me.role === "admin" || me.role === "finance") && (
        <InventoryAdjustments
          onChanged={() => {
            inv.reload();
            tb.reload();
          }}
        />
      )}
    </div>
  );
}
