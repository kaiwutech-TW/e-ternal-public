import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.ts";
import {
  DAY_TYPE_LABELS,
  KIND_LABELS,
  STATUS_BADGE,
  STATUS_LABELS,
  fmtMinutes,
  requestSummary,
  type HrRequest,
  type LeaveBalance,
  type LeaveType,
} from "./hr-shared.ts";

interface PunchRow {
  id: number;
  punchedAt: string;
  direction: "in" | "out";
  workDate: string;
  method: string;
}

interface MyAttendance {
  today: string | null;
  punches: PunchRow[];
  suggestedDirection?: "in" | "out";
  schedule: { workDate: string; shiftCode: string; shiftName: string; startTime: string; endTime: string; color: string; note: string }[];
  notLinked?: boolean;
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });

/** 出勤打卡（0039/0040）：打卡＋班表＋假別額度＋三種申請與待我簽核 */
export function Attendance() {
  const t = useT();
  const [data, setData] = useState<MyAttendance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [mine, setMine] = useState<HrRequest[]>([]);
  const [toSign, setToSign] = useState<HrRequest[]>([]);
  const [comments, setComments] = useState<Record<number, string>>({});

  const reload = () =>
    Promise.all([
      api.get<MyAttendance>("/attendance/my").then(setData),
      api.get<LeaveBalance[]>("/attendance/my-balances").then(setBalances),
      api.get<LeaveType[]>("/leave-types").then(setLeaveTypes),
      api.get<HrRequest[]>("/hr-requests/my").then(setMine),
      api.get<HrRequest[]>("/hr-requests/pending-approvals").then(setToSign),
    ]).catch((e) => setError((e as Error).message));
  useEffect(() => {
    void reload();
  }, []);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
      if (okMsg) setOk(okMsg);
      await reload();
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── 申請表單 ──
  const [kind, setKind] = useState<"leave" | "overtime" | "punch_correction">("leave");
  const submitRequest = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    const body: Record<string, unknown> = { kind, reason: String(f.get("reason") ?? "") };
    if (kind === "leave") {
      body.leaveTypeId = Number(f.get("leaveTypeId"));
      const start = String(f.get("startAt"));
      const end = String(f.get("endAt"));
      body.startAt = new Date(start).toISOString();
      body.endAt = new Date(end).toISOString();
      body.minutes = Number(f.get("minutes"));
    } else if (kind === "overtime") {
      body.workDate = String(f.get("workDate"));
      body.dayType = String(f.get("dayType"));
      body.minutes = Number(f.get("minutes"));
    } else {
      body.workDate = String(f.get("workDate"));
      body.direction = String(f.get("direction"));
      body.claimedTime = String(f.get("claimedTime"));
    }
    void act(async () => {
      const res = await api.post<HrRequest>("/hr-requests", body);
      form.reset();
      setOk(res.autoApproved ? t("已送出並自動核准（你沒有可簽核的主管）") : t("申請已送出，等待簽核"));
    });
  };

  const doPunch = (direction: "in" | "out") => void act(() => api.post("/attendance/punch", { direction }));

  if (data?.notLinked) {
    return (
      <div className="card">
        <p>{t("你的帳號還沒連結員工主檔，無法打卡。請管理者到「設定 → 使用者管理」把你的帳號連上員工。")}</p>
      </div>
    );
  }

  const suggested = data?.suggestedDirection ?? "in";
  const today = data?.today ?? new Date().toISOString().slice(0, 10);

  return (
    <div>
      {error && <div className="error sticky-alert">{error}</div>}
      {ok && <div className="ok">{ok}</div>}

      <div className="card" style={{ textAlign: "center" }}>
        <div style={{ fontSize: "0.875rem", color: "var(--text-2)" }}>{today}</div>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 14 }}>
          {(["in", "out"] as const).map((d) => (
            <button
              key={d}
              className="primary"
              disabled={busy}
              onClick={() => doPunch(d)}
              style={{
                padding: suggested === d ? "18px 44px" : "12px 28px",
                fontSize: suggested === d ? "1.125rem" : "0.9375rem",
                ...(suggested !== d ? { background: "rgba(0,0,0,0.08)", color: "var(--text)" } : {}),
              }}
            >
              {d === "in" ? t("上班打卡") : t("下班打卡")}
            </button>
          ))}
        </div>
        <p style={{ fontSize: "0.78125rem", color: "var(--text-3)", marginTop: 12 }}>
          {t("打卡記錄的是事實：打錯方向不用慌，補一筆正確的即可（紀錄不可修改，異常用下面的補卡申請更正）。")}
        </p>
      </div>

      {toSign.length > 0 && (
        <div className="card">
          <h3>{t("待我簽核（{n}）", { n: toSign.length })}</h3>
          <table>
            <thead><tr><th>{t("申請人")}</th><th>{t("類型")}</th><th>{t("內容")}</th><th>{t("事由")}</th><th>{t("意見")}</th><th></th></tr></thead>
            <tbody>
              {toSign.map((r) => (
                <tr key={r.id}>
                  <td>{r.employeeName}</td>
                  <td>{t(KIND_LABELS[r.kind] ?? r.kind)}</td>
                  <td>{requestSummary(r)}</td>
                  <td style={{ color: "var(--text-2)" }}>{r.reason || "—"}</td>
                  <td>
                    <input
                      style={{ width: 120 }}
                      placeholder={t("（可留意見）")}
                      value={comments[r.id] ?? ""}
                      onChange={(e) => setComments({ ...comments, [r.id]: e.target.value })}
                    />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className="small primary"
                      disabled={busy}
                      onClick={() => void act(() => api.post(`/hr-requests/${r.id}/approve`, { comment: comments[r.id] ?? "" }), t("已核准"))}
                    >
                      {t("核准")}
                    </button>{" "}
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() => void act(() => api.post(`/hr-requests/${r.id}/reject`, { comment: comments[r.id] ?? "" }), t("已駁回"))}
                    >
                      {t("駁回")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>{t("送出申請")}</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {(Object.keys(KIND_LABELS) as ("leave" | "overtime" | "punch_correction")[]).map((k) => (
            <button key={k} className={`small ${kind === k ? "primary" : ""}`} onClick={() => setKind(k)}>
              {t(KIND_LABELS[k] ?? k)}
            </button>
          ))}
        </div>
        <form className="inline" onSubmit={submitRequest}>
          {kind === "leave" && (
            <>
              <label className="field">
                {t("假別")}
                <select name="leaveTypeId" required defaultValue="">
                  <option value="" disabled>{t("— 選假別 —")}</option>
                  {leaveTypes.filter((lt) => lt.active).map((lt) => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
                </select>
              </label>
              <label className="field">{t("從")}<input name="startAt" type="datetime-local" required /></label>
              <label className="field">{t("到")}<input name="endAt" type="datetime-local" required /></label>
              <label className="field">{t("時數（分鐘）")}<input name="minutes" type="number" min={1} required placeholder={t("扣午休後的實際分鐘")} /></label>
            </>
          )}
          {kind === "overtime" && (
            <>
              <label className="field">{t("加班日期")}<input name="workDate" type="date" required /></label>
              <label className="field">
                {t("日型")}
                <select name="dayType" required defaultValue="">
                  <option value="" disabled>{t("— 選日型 —")}</option>
                  {Object.entries(DAY_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
                </select>
              </label>
              <label className="field">{t("時數（分鐘）")}<input name="minutes" type="number" min={1} required /></label>
            </>
          )}
          {kind === "punch_correction" && (
            <>
              <label className="field">{t("出勤日")}<input name="workDate" type="date" required /></label>
              <label className="field">
                {t("方向")}
                <select name="direction" required defaultValue="">
                  <option value="" disabled>—</option>
                  <option value="in">{t("上班")}</option>
                  <option value="out">{t("下班")}</option>
                </select>
              </label>
              <label className="field">{t("時刻")}<input name="claimedTime" type="time" required /></label>
            </>
          )}
          <label className="field" style={{ minWidth: 200 }}>{t("事由")}<input name="reason" placeholder={t("（選填）")} /></label>
          <button className="primary" disabled={busy}>{t("送出")}</button>
        </form>
        {kind === "overtime" && (
          <p style={{ fontSize: "0.78125rem", color: "var(--text-3)" }}>
            {t("這天是平日、休息日、例假日還是國定假日由你自己選——加班費倍率按日型計算，選錯會算錯錢。")}
          </p>
        )}
      </div>

      {balances.length > 0 && (
        <div className="card">
          <h3>{t("我的假別額度（{year} 年）", { year: new Date().getFullYear() })}</h3>
          <table>
            <thead><tr><th>{t("假別")}</th><th>{t("給假")}</th><th>{t("已用")}</th><th>{t("簽核中")}</th><th>{t("剩餘")}</th></tr></thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.id}>
                  <td>{b.leaveTypeName}</td>
                  <td>{fmtMinutes(b.grantedMinutes)}</td>
                  <td>{fmtMinutes(b.usedMinutes)}</td>
                  <td>{b.pendingMinutes ? fmtMinutes(b.pendingMinutes) : "—"}</td>
                  <td><strong>{fmtMinutes(Math.max(0, b.grantedMinutes - b.usedMinutes - b.pendingMinutes))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mine.length > 0 && (
        <div className="card">
          <h3>{t("我的申請")}</h3>
          <table>
            <thead><tr><th>{t("類型")}</th><th>{t("內容")}</th><th>{t("狀態")}</th><th>{t("簽核進度")}</th><th></th></tr></thead>
            <tbody>
              {mine.map((r) => (
                <tr key={r.id}>
                  <td>{t(KIND_LABELS[r.kind] ?? r.kind)}</td>
                  <td>{requestSummary(r)}</td>
                  <td><span className={`badge ${STATUS_BADGE[r.status]}`}>{t(STATUS_LABELS[r.status] ?? r.status)}</span></td>
                  <td style={{ fontSize: "0.8125rem", color: "var(--text-2)" }}>
                    {r.steps.length
                      ? r.steps.map((s) => `${s.approverName}${s.status === "approved" ? "✓" : s.status === "rejected" ? "✗" : s.status === "pending" ? "…" : ""}`).join(" → ")
                      : t("（免簽核）")}
                    {r.steps.find((s) => s.comment)?.comment && `：${r.steps.find((s) => s.comment)!.comment}`}
                  </td>
                  <td>
                    {r.status === "pending" && (
                      <button className="small" disabled={busy} onClick={() => void act(() => api.post(`/hr-requests/${r.id}/cancel`, {}), t("已取消"))}>
                        {t("取消")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>{t("今天的打卡")}</h3>
        {data?.punches.length ? (
          <table>
            <thead><tr><th>{t("時間")}</th><th>{t("方向")}</th><th>{t("方式")}</th></tr></thead>
            <tbody>
              {data.punches.map((p) => (
                <tr key={p.id}>
                  <td>{hhmm(p.punchedAt)}</td>
                  <td><span className={`badge ${p.direction === "in" ? "issued" : "canceled"}`}>{p.direction === "in" ? t("上班") : t("下班")}</span></td>
                  <td>{p.method === "web" ? t("網頁") : p.method === "correction" ? t("補卡") : p.method}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: "var(--text-2)" }}>{t("今天還沒有打卡。")}</p>
        )}
      </div>

      <div className="card">
        <h3>{t("我的班表（前後一週）")}</h3>
        {data?.schedule.length ? (
          <table>
            <thead><tr><th>{t("日期")}</th><th>{t("班別")}</th><th>{t("時間")}</th><th>{t("備註")}</th></tr></thead>
            <tbody>
              {data.schedule.map((s) => (
                <tr key={s.workDate} style={s.workDate === today ? { background: "var(--accent-tint)" } : undefined}>
                  <td>{s.workDate}{s.workDate === today && t("（今天）")}</td>
                  <td>
                    <span className="badge" style={{ background: `${s.color}22`, color: s.color }}>{s.shiftCode} {s.shiftName}</span>
                  </td>
                  <td>{s.startTime} ~ {s.endTime}</td>
                  <td style={{ color: "var(--text-2)" }}>{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: "var(--text-2)" }}>{t("這兩週沒有排班（固定班的同事看這裡是空的屬正常，排班制請等主管排班）。")}</p>
        )}
      </div>
    </div>
  );
}
