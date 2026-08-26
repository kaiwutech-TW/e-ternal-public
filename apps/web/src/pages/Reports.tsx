import { useState } from "react";
import { api, downloadText } from "../api.ts";
import { fmt, useFetch } from "../hooks.ts";
import type { Account, BalanceSheet, CashFlow, CheckItem, DepreciationSchedule, IncomeStatement, LedgerReport, PeriodCloses } from "../types.ts";

const ACTIVITY_LABEL = { operating: "營業", investing: "投資", financing: "籌資" } as const;

/** 明細分類帳：單一科目期初＋逐筆＋累計餘額 */
function LedgerCard() {
  // 明細分類帳查的是歷史，已停用的科目也要能選
  const accounts = useFetch<Account[]>("/accounts?includeInactive=1");
  const today = new Date().toISOString().slice(0, 10);
  const [code, setCode] = useState("");
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<LedgerReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      if (!code) throw new Error("請選科目");
      setReport(await api.get<LedgerReport>(`/reports/ledger?accountCode=${code}&from=${from}&to=${to}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h3>明細分類帳（單一科目逐筆與累計餘額）</h3>
      {error && <div className="error">{error}</div>}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="field">
          科目
          <select value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">— 請選擇 —</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.code}>{a.code} {a.name}</option>
            ))}
          </select>
        </label>
        <label className="field">起日<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">迄日<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="primary">產出</button>
      </form>
      {report && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr><th>日期</th><th>傳票</th><th>摘要</th><th className="num">借方</th><th className="num">貸方</th><th className="num">餘額</th></tr>
          </thead>
          <tbody>
            <tr style={{ color: "var(--text-2)" }}>
              <td>{report.from}</td><td></td><td>期初餘額</td><td className="num"></td><td className="num"></td>
              <td className="num">{fmt(report.opening)}</td>
            </tr>
            {report.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.entryDate}</td>
                <td>#{l.entryId}</td>
                <td>{l.memo}</td>
                <td className="num">{l.debit ? fmt(l.debit) : ""}</td>
                <td className="num">{l.credit ? fmt(l.credit) : ""}</td>
                <td className="num">{fmt(l.balance)}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 600 }}>
              <td>{report.to}</td><td></td><td>期末餘額</td><td></td><td></td>
              <td className="num">{fmt(report.closing)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 現金流量表（直接法）：現金分錄按對方科目分類三大活動 */
function CashFlowCard() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [cf, setCf] = useState<CashFlow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setCf(await api.get<CashFlow>(`/reports/cash-flow?from=${from}&to=${to}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h3>現金流量表（直接法：現金/銀行分錄按對方科目分類）</h3>
      {error && <div className="error">{error}</div>}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="field">起日<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">迄日<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="primary">產出</button>
      </form>
      {cf && (
        <>
          <table style={{ marginTop: 12, maxWidth: 480 }}>
            <tbody>
              <tr><td>期初現金</td><td className="num">{fmt(cf.opening)}</td></tr>
              <tr><td>營業活動淨現金流</td><td className="num">{fmt(cf.operating)}</td></tr>
              <tr><td>投資活動淨現金流</td><td className="num">{fmt(cf.investing)}</td></tr>
              <tr><td>籌資活動淨現金流</td><td className="num">{fmt(cf.financing)}</td></tr>
              <tr style={{ fontWeight: 600 }}><td>本期現金淨增減</td><td className="num">{fmt(cf.net)}</td></tr>
              <tr style={{ fontWeight: 600 }}><td>期末現金</td><td className="num">{fmt(cf.closing)}</td></tr>
            </tbody>
          </table>
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>日期</th><th>摘要</th><th>活動</th><th className="num">現金流</th></tr></thead>
            <tbody>
              {cf.detail.map((d, i) => (
                <tr key={i}>
                  <td>{d.date}</td>
                  <td>{d.memo}</td>
                  <td>{ACTIVITY_LABEL[d.activity]}</td>
                  <td className="num">{fmt(d.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/**
 * 折舊明細表（gap 3.7）：各資產的期初累折＋本年度折舊＝期末累折、帳面淨值——
 * 營所稅結算申報「固定資產及折舊明細表」的取數底稿。數字取自已入帳的折舊，
 * 漏提的月份這張表看得出來少。CSV 與畫面同一份取數（format=csv）。
 */
function DepreciationScheduleCard() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [schedule, setSchedule] = useState<DepreciationSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setSchedule(await api.get<DepreciationSchedule>(`/reports/depreciation-schedule?year=${year}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const downloadCsv = async () => {
    try {
      const file = await api.get<{ name: string; content: string; rows: number }>(
        `/reports/depreciation-schedule?year=${year}&format=csv`,
      );
      downloadText(file.name, file.content);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h3>折舊明細表（各資產的年度折舊、累計折舊與帳面淨值；營所稅申報底稿）</h3>
      {error && <div className="error">{error}</div>}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="field">年度<input type="number" style={{ width: 90 }} value={year} onChange={(e) => setYear(Number(e.target.value))} /></label>
        <button className="primary">產出</button>
        <button className="small" type="button" onClick={() => void downloadCsv()}>下載 CSV</button>
      </form>
      {schedule && schedule.rows.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>{schedule.year} 年度沒有已啟用的資產。</p>
      )}
      {schedule && schedule.rows.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>名稱</th><th>類別</th><th>啟用日</th><th className="num">耐用年數</th>
              <th className="num">取得成本</th><th className="num">殘值</th>
              <th className="num">期初累計折舊</th><th className="num">本年度折舊</th>
              <th className="num">期末累計折舊</th><th className="num">帳面淨值</th><th>狀態</th>
            </tr>
          </thead>
          <tbody>
            {schedule.rows.map((r) => (
              <tr key={r.assetId}>
                <td>{r.name}</td>
                <td>{r.categoryLabel}</td>
                <td>{r.startDate}</td>
                <td className="num">{r.usefulYears}</td>
                <td className="num">{fmt(r.cost)}</td>
                <td className="num">{fmt(r.salvage)}</td>
                <td className="num">{fmt(r.openingAccum)}</td>
                <td className="num">{fmt(r.yearDepreciation)}</td>
                <td className="num">{fmt(r.accumulated)}</td>
                <td className="num">{fmt(r.bookValue)}</td>
                <td>{r.status === "disposed" ? `已處分 ${r.disposedAt ?? ""}` : "使用中"}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 600 }}>
              <td>合計</td><td></td><td></td><td></td>
              <td className="num">{fmt(schedule.totals.cost)}</td>
              <td></td>
              <td className="num">{fmt(schedule.totals.openingAccum)}</td>
              <td className="num">{fmt(schedule.totals.yearDepreciation)}</td>
              <td className="num">{fmt(schedule.totals.accumulated)}</td>
              <td className="num">{fmt(schedule.totals.bookValue)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 月結關帳＋年度結轉（財務）：依序關帳、檢查清單、重開、年度結轉 */
function PeriodClose() {
  const closes = useFetch<PeriodCloses>("/period-closes");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [period, setPeriod] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1); // 預設關上個月
    return d.toISOString().slice(0, 7);
  });
  const [checks, setChecks] = useState<CheckItem[] | null>(null);
  const [year, setYear] = useState(new Date().getFullYear() - 1);

  const act = async (fn: () => Promise<string>) => {
    try {
      setOk(await fn());
      setError(null);
      setChecks(null);
      closes.reload();
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  const runCheck = async () => {
    try {
      setChecks(await api.get<CheckItem[]>(`/period-closes/check?period=${period}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h3>月結關帳（關帳後該月所有單據與傳票鎖定，不能再新增或調整）</h3>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
      <p style={{ fontSize: 14 }}>
        目前帳務關至：<strong>{closes.data?.closedThrough ?? "尚未關帳"}</strong>
      </p>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label className="field">期間<input type="month" value={period} onChange={(e) => { setPeriod(e.target.value); setChecks(null); }} /></label>
        <button className="small" onClick={() => void runCheck()}>月結檢查</button>
        <button
          className="primary"
          onClick={() => void act(async () => {
            await api.post("/period-closes", { period });
            return `${period} 已關帳`;
          })}
        >
          執行關帳
        </button>
        {closes.data?.closedThrough && (
          <button
            className="small"
            onClick={() => void act(async () => {
              const r = await api.delete<{ reopened: string }>("/period-closes/latest");
              return `${r.reopened} 已重開，可補入帳後再關`;
            })}
          >
            重開最近期間（{closes.data.closedThrough}）
          </button>
        )}
      </form>
      {checks && (
        <ul style={{ fontSize: 14, marginTop: 8 }}>
          {checks.map((c) => (
            <li key={c.key} style={{ color: c.ok ? "var(--green)" : c.blocking ? "var(--red)" : "var(--amber)" }}>
              {c.ok ? "✓" : c.blocking ? "✗" : "⚠"} {c.label}：{c.detail}
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="field">年度結轉（須先關至該年 12 月）<input type="number" style={{ width: 90 }} value={year} onChange={(e) => setYear(Number(e.target.value))} /></label>
          <button
            className="primary"
            onClick={() => void act(async () => {
              const r = await api.post<{ netIncome: number; journalEntryId: number }>("/year-closes", { year });
              return `${year} 年度結轉完成：本期損益 $${fmt(r.netIncome)} 已轉入累積盈虧（傳票 #${r.journalEntryId}）`;
            })}
          >
            執行年度結轉
          </button>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          結轉會把全年收入與費用結清到「3351 累積盈虧」，隔年損益表從零開始；本年度損益表不受結轉分錄影響。
        </p>
      </div>
    </div>
  );
}

export function Reports() {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [pl, setPl] = useState<IncomeStatement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadBs = async () => {
    try {
      setBs(await api.get<BalanceSheet>(`/reports/balance-sheet?asOf=${asOf}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loadPl = async () => {
    try {
      setPl(await api.get<IncomeStatement>(`/reports/income-statement?from=${from}&to=${to}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rows = (items: { code: string; name: string; amount: number }[]) =>
    items.map((r, i) => (
      <tr key={i}>
        <td>{r.code}</td>
        <td>{r.name}</td>
        <td className="num">{fmt(r.amount)}</td>
      </tr>
    ));

  return (
    <div>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>綜合損益表</h3>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void loadPl(); }}>
          <label className="field">起日<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">迄日<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button className="primary">產出</button>
        </form>
        {pl && (
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>科目</th><th>名稱</th><th className="num">金額</th></tr></thead>
            <tbody>
              {rows(pl.revenue)}
              <tr><td /><td><b>收入合計</b></td><td className="num"><b>{fmt(pl.totalRevenue)}</b></td></tr>
              {rows(pl.expense)}
              <tr><td /><td><b>費用合計</b></td><td className="num"><b>{fmt(pl.totalExpense)}</b></td></tr>
              <tr><td /><td><b>本期損益</b></td><td className="num"><b>{fmt(pl.netIncome)}</b></td></tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>資產負債表</h3>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void loadBs(); }}>
          <label className="field">基準日<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
          <button className="primary">產出</button>
        </form>
        {bs && (
          <>
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>科目</th><th>名稱</th><th className="num">金額</th></tr></thead>
              <tbody>
                {rows(bs.assets)}
                <tr><td /><td><b>資產合計</b></td><td className="num"><b>{fmt(bs.totalAssets)}</b></td></tr>
                {rows(bs.liabilities)}
                <tr><td /><td><b>負債合計</b></td><td className="num"><b>{fmt(bs.totalLiabilities)}</b></td></tr>
                {rows(bs.equity)}
                <tr><td /><td><b>權益合計（含本期損益）</b></td><td className="num"><b>{fmt(bs.totalEquity)}</b></td></tr>
              </tbody>
            </table>
            <p style={{ fontSize: 13, color: bs.balanced ? "var(--green)" : "var(--red)" }}>
              資產 {fmt(bs.totalAssets)} ＝ 負債 {fmt(bs.totalLiabilities)} ＋ 權益 {fmt(bs.totalEquity)}
              {bs.balanced ? " ✓" : "（不平，請檢查傳票）"}
            </p>
          </>
        )}
      </div>

      <CashFlowCard />
      <LedgerCard />
      <DepreciationScheduleCard />
      <PeriodClose />
    </div>
  );
}
