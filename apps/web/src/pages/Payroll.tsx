import { useState } from "react";
import { api } from "../api.ts";
import { useFetch } from "../hooks.ts";
import type { Employee } from "../types.ts";
import { DAY_TYPE_LABELS, fmtMinutes } from "./hr-shared.ts";

interface SalaryRow {
  id: number;
  employeeId: number;
  employeeName: string;
  validFrom: string;
  payType: "monthly" | "hourly";
  baseAmount: number;
  hourlyDivisor: number | null;
  mealAllowance: number;
  mealAllowanceInBase: boolean;
  laborInsEmployee: number;
  laborInsEmployer: number;
  healthInsEmployee: number;
  healthInsEmployer: number;
  pensionEmployer: number;
  sourceNote: string;
  note: string;
}

interface RateRow {
  id: number;
  dayType: string;
  fromMinutes: number;
  multiplierBp: number;
  fixedMinutes: number | null;
  sourceNote: string;
}

interface RunRow {
  id: number;
  month: string;
  status: "draft" | "finalized";
  journalEntryId: number | null;
  finalizedAt: string | null;
}

interface ItemRow {
  id: number;
  employeeId: number;
  employeeName: string;
  basePay: number;
  mealAllowance: number;
  overtimePay: number;
  leaveDeduction: number;
  lateEarlyDeduction: number;
  absenceDeduction: number;
  otherEarning: number;
  otherDeduction: number;
  laborInsEmployee: number;
  healthInsEmployee: number;
  laborInsEmployer: number;
  healthInsEmployer: number;
  pensionEmployer: number;
  netPay: number;
  memo: string;
  detail: { warnings?: string[] };
}

interface RunDetail extends RunRow {
  items: ItemRow[];
}

const nt = (n: number) => n.toLocaleString("zh-TW");

/** 薪資（0041）：薪資檔（歷次）、加班費率、發薪作業。所有法定數字使用者自填，系統只做算術 */
export function Payroll() {
  const employees = useFetch<Employee[]>("/employees");
  const salaries = useFetch<SalaryRow[]>("/employee-salaries");
  const rates = useFetch<RateRow[]>("/overtime-rates");
  const runs = useFetch<RunRow[]>("/payroll-runs");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [edits, setEdits] = useState<Record<number, { otherEarning: string; otherDeduction: string; memo: string }>>({});

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      setError(null);
      setOk(okMsg ?? null);
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  const openRun = (id: number) => void act(async () => { setEdits({}); setRun(await api.get<RunDetail>(`/payroll-runs/${id}`)); });

  return (
    <div>
      {error && <div className="error sticky-alert">{error}</div>}
      {ok && <div className="ok">{ok}</div>}

      <div className="card">
        <h3>員工薪資檔（歷次紀錄）</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            const divisor = String(f.get("hourlyDivisor") ?? "").trim();
            void act(async () => {
              await api.post("/employee-salaries", {
                employeeId: Number(f.get("employeeId")),
                validFrom: String(f.get("validFrom")),
                payType: String(f.get("payType")),
                baseAmount: Number(f.get("baseAmount")),
                hourlyDivisor: divisor ? Number(divisor) : null,
                mealAllowance: Number(f.get("mealAllowance") || 0),
                mealAllowanceInBase: f.get("mealAllowanceInBase") === "on",
                laborInsEmployee: Number(f.get("laborInsEmployee") || 0),
                laborInsEmployer: Number(f.get("laborInsEmployer") || 0),
                healthInsEmployee: Number(f.get("healthInsEmployee") || 0),
                healthInsEmployer: Number(f.get("healthInsEmployer") || 0),
                pensionEmployer: Number(f.get("pensionEmployer") || 0),
                sourceNote: String(f.get("sourceNote") ?? ""),
                note: String(f.get("note") ?? ""),
              });
              form.reset();
              salaries.reload();
            }, "薪資列已新增（調薪＝再新增一列，舊列保留）");
          }}
        >
          <label className="field">
            員工
            <select name="employeeId" required defaultValue="">
              <option value="" disabled>— 選員工 —</option>
              {employees.data?.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
          <label className="field">生效日<input name="validFrom" type="date" required /></label>
          <label className="field">
            計薪
            <select name="payType" defaultValue="monthly">
              <option value="monthly">月薪</option>
              <option value="hourly">時薪</option>
            </select>
          </label>
          <label className="field">本薪（元；時薪制填時薪）<input name="baseAmount" type="number" min={0} required style={{ width: 110 }} /></label>
          <label className="field">時薪換算除數（月薪制才需要）<input name="hourlyDivisor" type="number" min={1} placeholder="未填＝不算加班與扣款" style={{ width: 170 }} /></label>
          <label className="field">伙食津貼（元/月，選填）<input name="mealAllowance" type="number" min={0} defaultValue={0} style={{ width: 120 }} /></label>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input name="mealAllowanceInBase" type="checkbox" />計入時薪基底
          </label>
          <label className="field">勞保（員工）<input name="laborInsEmployee" type="number" min={0} defaultValue={0} style={{ width: 90 }} /></label>
          <label className="field">勞保（雇主）<input name="laborInsEmployer" type="number" min={0} defaultValue={0} style={{ width: 90 }} /></label>
          <label className="field">健保（員工）<input name="healthInsEmployee" type="number" min={0} defaultValue={0} style={{ width: 90 }} /></label>
          <label className="field">健保（雇主）<input name="healthInsEmployer" type="number" min={0} defaultValue={0} style={{ width: 90 }} /></label>
          <label className="field">勞退提繳（雇主）<input name="pensionEmployer" type="number" min={0} defaultValue={0} style={{ width: 110 }} /></label>
          <label className="field" style={{ minWidth: 200 }}>依據來源（投保級距表版本等）<input name="sourceNote" placeholder="你查證的依據" /></label>
          <label className="field">備註<input name="note" /></label>
          <button className="primary">新增薪資列</button>
        </form>
        {salaries.data && salaries.data.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>員工</th><th>生效日</th><th>計薪</th><th>本薪</th><th>伙食津貼</th><th>除數</th><th>勞保（員/雇）</th><th>健保（員/雇）</th><th>勞退</th><th>依據</th></tr></thead>
            <tbody>
              {salaries.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.employeeName}</td>
                  <td>{s.validFrom}</td>
                  <td>{s.payType === "monthly" ? "月薪" : "時薪"}</td>
                  <td style={{ textAlign: "right" }}>{nt(s.baseAmount)}</td>
                  <td style={{ textAlign: "right" }}>{s.mealAllowance ? `${nt(s.mealAllowance)}${s.mealAllowanceInBase ? "（入基底）" : ""}` : "—"}</td>
                  <td>{s.hourlyDivisor ?? "—"}</td>
                  <td>{nt(s.laborInsEmployee)}／{nt(s.laborInsEmployer)}</td>
                  <td>{nt(s.healthInsEmployee)}／{nt(s.healthInsEmployer)}</td>
                  <td>{nt(s.pensionEmployer)}</td>
                  <td style={{ color: "var(--text-3)", maxWidth: 200 }}>{s.sourceNote || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          薪資檔是歷次紀錄：調薪新增一列（舊列不動），算薪取「當月月底仍生效的那一列」。
          勞健保是每人每月定額——請照投保級距表自行查填，系統不內建級距也不驗算。
        </p>
      </div>

      <div className="card">
        <h3>加班費率（倍率自填）</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            const fixedH = String(f.get("fixedHours") ?? "").trim();
            void act(async () => {
              await api.post("/overtime-rates", {
                dayType: String(f.get("dayType")),
                fromMinutes: Number(f.get("fromHours")) * 60,
                multiplierBp: Math.round(Number(f.get("multiplier")) * 10000),
                fixedMinutes: fixedH ? Math.round(Number(fixedH) * 60) : null,
                sourceNote: String(f.get("sourceNote") ?? ""),
              });
              form.reset();
              rates.reload();
            });
          }}
        >
          <label className="field">
            日型
            <select name="dayType" required defaultValue="">
              <option value="" disabled>—</option>
              {Object.entries(DAY_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field">加班第幾小時起<input name="fromHours" type="number" min={0} step={0.5} required style={{ width: 120 }} /></label>
          <label className="field">倍率（例 1.34）<input name="multiplier" type="number" min={0.01} step={0.01} required style={{ width: 110 }} /></label>
          <label className="field">以固定時數計（小時，選填）<input name="fixedHours" type="number" min={0.5} step={0.5} placeholder="例假日「做 6 給 8」填 8" style={{ width: 170 }} /></label>
          <label className="field" style={{ minWidth: 200 }}>依據來源<input name="sourceNote" placeholder="你查證的條號" /></label>
          <button className="primary">新增費率</button>
        </form>
        {rates.data && rates.data.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>日型</th><th>起算</th><th>倍率</th><th>計法</th><th>依據</th><th></th></tr></thead>
            <tbody>
              {rates.data.map((r) => (
                <tr key={r.id}>
                  <td>{DAY_TYPE_LABELS[r.dayType] ?? r.dayType}</td>
                  <td>第 {fmtMinutes(r.fromMinutes)} 起</td>
                  <td>{(r.multiplierBp / 10000).toFixed(2)} 倍</td>
                  <td>{r.fixedMinutes ? `以固定 ${fmtMinutes(r.fixedMinutes)} 計` : "實際時數"}</td>
                  <td style={{ color: "var(--text-3)" }}>{r.sourceNote || "—"}</td>
                  <td><button className="small" onClick={() => void act(async () => { await api.delete(`/overtime-rates/${r.id}`); rates.reload(); })}>刪除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          每個日型可設多段（前 2 小時一個倍率、之後另一個倍率＝兩列）；級距**按每張加班單**（＝按日）套用。
          「以固定時數計」給例假日「做 6 給 8」這種形狀：時數一進該級距就以固定時數計酬。
          倍率是勞基法數字，系統不預填——沒設費率的日型加班費算 0，發薪作業會明講。已定案的薪資單不受之後改費率影響。
        </p>
      </div>

      <div className="card">
        <h3>發薪作業</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(async () => {
              const created = await api.post<RunDetail>("/payroll-runs", { month: String(f.get("month")) });
              runs.reload();
              setRun(created);
            }, "已建立草稿——確認數字後再定案");
          }}
        >
          <label className="field">月份<input name="month" type="month" required defaultValue={new Date().toISOString().slice(0, 7)} /></label>
          <button className="primary">建立發薪作業（草稿）</button>
        </form>
        {runs.data && runs.data.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>月份</th><th>狀態</th><th>傳票</th><th></th></tr></thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.month}</td>
                  <td><span className={`badge ${r.status === "finalized" ? "issued" : "draft"}`}>{r.status === "finalized" ? "已定案" : "草稿"}</span></td>
                  <td>{r.journalEntryId ? `#${r.journalEntryId}` : "—"}</td>
                  <td><button className="small" onClick={() => openRun(r.id)}>明細</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {run && (
        <div className="card">
          <h3>
            {run.month} 明細{" "}
            <span className={`badge ${run.status === "finalized" ? "issued" : "draft"}`}>
              {run.status === "finalized" ? "已定案" : "草稿"}
            </span>
          </h3>
          {run.status === "draft" && (
            <p style={{ marginBottom: 8 }}>
              <button className="small" onClick={() => void act(async () => setRun(await api.post<RunDetail>(`/payroll-runs/${run.id}/recalc`, {})), "已重算（手動調整項保留）")}>
                重算（出勤或參數有更新時）
              </button>{" "}
              <button
                className="small primary"
                onClick={() =>
                  void act(async () => {
                    const r = await api.post<RunRow>(`/payroll-runs/${run.id}/finalize`, {});
                    runs.reload();
                    openRun(run.id);
                    // 出路只能寫程式真的做得到的：收付款單的對象必須是供應商、借方是應付帳款，
                    // 沖不了 2202 應付薪資（services/ledger.ts）——照那條路做會讓 2202 永遠掛著、
                    // 應付帳款被壓成負數。實際發薪走手工傳票
                    setOk(`已定案並過帳（傳票 #${r.journalEntryId}）：月底計提，實發掛 2202 應付薪資。發薪當天到「傳票」開一張借 2202、貸 銀行存款的手工傳票沖掉它`);
                  })
                }
              >
                定案並過帳
              </button>
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>員工</th><th>本薪</th><th>伙食津貼</th><th>加班費</th><th>請假扣</th><th>遲到早退扣</th><th>缺勤扣</th><th>調整＋</th><th>調整−</th>
                <th>勞健保（員工）</th><th>實發</th><th>備註</th>{run.status === "draft" && <th></th>}
              </tr>
            </thead>
            <tbody>
              {run.items.map((i) => {
                const e = edits[i.id] ?? { otherEarning: String(i.otherEarning), otherDeduction: String(i.otherDeduction), memo: i.memo };
                const warnings = i.detail?.warnings ?? [];
                return (
                  <>
                    <tr key={i.id}>
                      <td>{i.employeeName}</td>
                      <td style={{ textAlign: "right" }}>{nt(i.basePay)}</td>
                      <td style={{ textAlign: "right" }}>{i.mealAllowance ? nt(i.mealAllowance) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{nt(i.overtimePay)}</td>
                      <td style={{ textAlign: "right" }}>{i.leaveDeduction ? `−${nt(i.leaveDeduction)}` : "—"}</td>
                      <td style={{ textAlign: "right" }}>{i.lateEarlyDeduction ? `−${nt(i.lateEarlyDeduction)}` : "—"}</td>
                      <td style={{ textAlign: "right" }}>{i.absenceDeduction ? `−${nt(i.absenceDeduction)}` : "—"}</td>
                      <td>
                        {run.status === "draft" ? (
                          <input style={{ width: 80 }} type="number" min={0} value={e.otherEarning}
                            onChange={(ev) => setEdits({ ...edits, [i.id]: { ...e, otherEarning: ev.target.value } })} />
                        ) : nt(i.otherEarning)}
                      </td>
                      <td>
                        {run.status === "draft" ? (
                          <input style={{ width: 80 }} type="number" min={0} value={e.otherDeduction}
                            onChange={(ev) => setEdits({ ...edits, [i.id]: { ...e, otherDeduction: ev.target.value } })} />
                        ) : nt(i.otherDeduction)}
                      </td>
                      <td style={{ textAlign: "right" }}>{nt(i.laborInsEmployee + i.healthInsEmployee)}</td>
                      <td style={{ textAlign: "right" }}><strong>{nt(i.netPay)}</strong></td>
                      <td>
                        {run.status === "draft" ? (
                          <input style={{ width: 120 }} value={e.memo} placeholder="調整原因"
                            onChange={(ev) => setEdits({ ...edits, [i.id]: { ...e, memo: ev.target.value } })} />
                        ) : (i.memo || "—")}
                      </td>
                      {run.status === "draft" && (
                        <td>
                          <button
                            className="small"
                            onClick={() =>
                              void act(async () => {
                                await api.patch(`/payroll-items/${i.id}`, {
                                  otherEarning: Number(e.otherEarning || 0),
                                  otherDeduction: Number(e.otherDeduction || 0),
                                  memo: e.memo,
                                });
                                openRun(run.id);
                              }, "已調整")
                            }
                          >
                            儲存
                          </button>
                        </td>
                      )}
                    </tr>
                    {warnings.length > 0 && (
                      <tr key={`${i.id}-w`}>
                        <td colSpan={run.status === "draft" ? 13 : 12} style={{ color: "var(--amber)", fontSize: "0.8125rem", background: "rgba(245,158,11,0.06)" }}>
                          ⚠ {warnings.join("；")}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
          <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
            扣繳稅款本批不計算（員工薪資的扣繳稅額表未內建）：要代扣請用「調整−」欄自行填入並留備註。
            定案後這份明細就是快照——之後改費率、補打卡都不會回頭改它。
          </p>
        </div>
      )}
    </div>
  );
}
