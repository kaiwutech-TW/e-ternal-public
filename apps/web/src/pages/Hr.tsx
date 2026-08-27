import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.ts";
import { useFetch } from "../hooks.ts";
import type { Employee } from "../types.ts";
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

interface SummaryRow {
  employeeId: number;
  employeeName: string;
  punchExempt: boolean;
  scheduledDays: number;
  scheduledMinutes: number;
  workedMinutes: number;
  lateCount: number;
  lateMinutes: number;
  earlyLeaveCount: number;
  earlyLeaveMinutes: number;
  absentDays: number;
  absentMinutes: number;
  leaveByType: Record<string, number>;
  overtimeByDayType: Record<string, number>;
}

interface CalendarRow {
  day: string;
  kind: string;
  name: string;
}

interface DepartmentRow {
  id: number;
  name: string;
  parentId: number | null;
  managerEmployeeId: number | null;
  managerName: string | null;
  active: boolean;
}

interface ShiftRow {
  id: number;
  code: string;
  name: string;
  color: string;
  startTime: string;
  endTime: string;
  breaks: { start: string; end: string }[];
  dayCutoff: string;
  active: boolean;
}

interface BoardRow {
  id: number;
  employeeId: number;
  workDate: string;
  shiftId: number;
  shiftCode: string;
  color: string;
}

interface PunchRow {
  id: number;
  employeeId: number;
  punchedAt: string;
  direction: string;
  workDate: string;
  sourceIp: string;
  method: string;
}

const t5 = (t: string) => t.slice(0, 5);

/** 人事管理（0039 第一批）：部門、班別、排班、出勤設定、打卡紀錄 */
export function Hr() {
  const t = useT();
  const employees = useFetch<Employee[]>("/employees");
  const departments = useFetch<DepartmentRow[]>("/departments");
  const shifts = useFetch<ShiftRow[]>("/shifts");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      setError(null);
      if (okMsg) setOk(okMsg);
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  // ── 出勤設定 ──
  const [settings, setSettings] = useState<{ ipAllowlist: string; flexMinutes: number; lateEarlyMode: "schedule" | "shortfall" } | null>(null);
  useEffect(() => {
    api.get<{ ipAllowlist: string; flexMinutes: number; lateEarlyMode: "schedule" | "shortfall" }>("/attendance/settings").then(setSettings).catch(() => {});
  }, []);

  // ── 排班 ──
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [boardFrom, setBoardFrom] = useState(new Date().toISOString().slice(0, 10));
  const [boardTo, setBoardTo] = useState(new Date(Date.now() + 13 * 86400_000).toISOString().slice(0, 10));
  const loadBoard = () =>
    act(async () => setBoard(await api.get<BoardRow[]>(`/schedules?from=${boardFrom}&to=${boardTo}`)));

  // ── 打卡紀錄 ──
  const [punches, setPunches] = useState<PunchRow[] | null>(null);
  const [punchFrom, setPunchFrom] = useState(new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10));
  const [punchTo, setPunchTo] = useState(new Date().toISOString().slice(0, 10));

  const empName = (id: number) => employees.data?.find((e) => e.id === id)?.name ?? `#${id}`;

  // ── 假別／額度帳／行事曆／申請單／月彙總（0040）──
  const leaveTypes = useFetch<LeaveType[]>("/leave-types");
  const [ltEdits, setLtEdits] = useState<Record<number, { payRatioPercent: string; sourceNote: string }>>({});
  const [balYear, setBalYear] = useState(String(new Date().getFullYear()));
  const [balances, setBalances] = useState<LeaveBalance[] | null>(null);
  const loadBalances = () => act(async () => setBalances(await api.get<LeaveBalance[]>(`/leave-balances?year=${balYear}`)));
  const [calYear, setCalYear] = useState(String(new Date().getFullYear()));
  const [calendar, setCalendar] = useState<CalendarRow[] | null>(null);
  const loadCalendar = () => act(async () => setCalendar(await api.get<CalendarRow[]>(`/calendar-days?year=${calYear}`)));
  const [requests, setRequests] = useState<HrRequest[] | null>(null);
  const [reqStatus, setReqStatus] = useState("");
  const loadRequests = () =>
    act(async () => setRequests(await api.get<HrRequest[]>(`/hr-requests${reqStatus ? `?status=${reqStatus}` : ""}`)));
  const [sumMonth, setSumMonth] = useState(new Date().toISOString().slice(0, 7));
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const loadSummary = () => act(async () => setSummary(await api.get<SummaryRow[]>(`/attendance/summary?month=${sumMonth}`)));

  return (
    <div>
      {error && <div className="error sticky-alert">{error}</div>}
      {ok && <div className="ok">{ok}</div>}

      <div className="card">
        <h3>{t("出勤設定")}</h3>
        {settings && (
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => api.put("/attendance/settings", settings), t("出勤設定已儲存"));
            }}
          >
            <label className="field" style={{ minWidth: 340 }}>
              {t("打卡 IP 白名單（逗號分隔，支援 CIDR；留空＝不限制）")}
              <input
                value={settings.ipAllowlist}
                onChange={(e) => setSettings({ ...settings, ipAllowlist: e.target.value })}
                placeholder={t("例：203.0.113.0/24, 198.51.100.7")}
              />
            </label>
            <label className="field">
              {t("彈性上下班（分鐘，0＝不彈性）")}
              <input
                type="number"
                min={0}
                max={240}
                value={settings.flexMinutes}
                onChange={(e) => setSettings({ ...settings, flexMinutes: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              {t("遲到早退計法")}
              <select
                value={settings.lateEarlyMode}
                onChange={(e) => setSettings({ ...settings, lateEarlyMode: e.target.value as "schedule" | "shortfall" })}
              >
                <option value="schedule">{t("對表定起訖（晚進＝遲到、早出＝早退）")}</option>
                <option value="shortfall">{t("補時制（當日工時補不滿表定才記早退）")}</option>
              </select>
            </label>
            <button className="primary">{t("儲存")}</button>
          </form>
        )}
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          {t("白名單擋的是「打卡」這個動作；來源 IP 無論如何都會記在打卡紀錄上。")}
          {t("彈性上下班的語意：可比表定時間早/晚 N 分鐘上班，早到可早走、晚到需晚下。")}
          {t("補時制下漏刷卡的日子不自動扣款——當成出勤異常交人工處理（系統不猜他工作到幾點）。")}
        </p>
      </div>

      <div className="card">
        <h3>{t("部門")}</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            void act(async () => {
              await api.post("/departments", {
                name: String(f.get("name")).trim(),
                ...(Number(f.get("parentId")) ? { parentId: Number(f.get("parentId")) } : {}),
                ...(Number(f.get("managerId")) ? { managerEmployeeId: Number(f.get("managerId")) } : {}),
              });
              form.reset();
              departments.reload();
            });
          }}
        >
          <label className="field">{t("部門名稱")}<input name="name" required /></label>
          <label className="field">
            {t("上級部門")}
            <select name="parentId" defaultValue={0}>
              <option value={0}>{t("— 頂層 —")}</option>
              {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="field">
            {t("部門主管（簽核鏈的「當層主管」）")}
            <select name="managerId" defaultValue={0}>
              <option value={0}>{t("— 未指定 —")}</option>
              {employees.data?.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
          <button className="primary">{t("新增部門")}</button>
        </form>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>{t("部門")}</th><th>{t("上級")}</th><th>{t("主管")}</th><th>{t("狀態")}</th></tr></thead>
          <tbody>
            {departments.data?.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.parentId ? departments.data?.find((x) => x.id === d.parentId)?.name ?? `#${d.parentId}` : "—"}</td>
                <td>{d.managerName ?? "—"}</td>
                <td><span className={`badge ${d.active ? "issued" : "canceled"}`}>{d.active ? t("啟用") : t("停用")}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>{t("員工歸屬（簽核鏈取數來源）")}</h3>
        <table>
          <thead><tr><th>{t("員工")}</th><th>{t("部門")}</th><th>{t("直屬主管")}</th><th>{t("類型")}</th><th>{t("免打卡")}</th></tr></thead>
          <tbody>
            {employees.data?.filter((e) => e.active).map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td>
                  <select
                    value={e.departmentId ?? 0}
                    onChange={(ev) =>
                      void act(async () => {
                        await api.patch(`/employees/${e.id}`, { departmentId: Number(ev.target.value) || null });
                        employees.reload();
                      })
                    }
                  >
                    <option value={0}>{t("— 無 —")}</option>
                    {departments.data?.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={e.managerEmployeeId ?? 0}
                    onChange={(ev) =>
                      void act(async () => {
                        await api.patch(`/employees/${e.id}`, { managerEmployeeId: Number(ev.target.value) || null });
                        employees.reload();
                      })
                    }
                  >
                    <option value={0}>{t("— 無 —")}</option>
                    {employees.data?.filter((m) => m.active && m.id !== e.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={e.employmentType ?? "fulltime"}
                    onChange={(ev) =>
                      void act(async () => {
                        await api.patch(`/employees/${e.id}`, { employmentType: ev.target.value });
                        employees.reload();
                      })
                    }
                  >
                    <option value="fulltime">{t("全職")}</option>
                    <option value="parttime">{t("部分工時")}</option>
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={e.punchExempt ?? false}
                    onChange={(ev) =>
                      void act(async () => {
                        await api.patch(`/employees/${e.id}`, { punchExempt: ev.target.checked });
                        employees.reload();
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          {t("申請單的簽核鏈在**送出當下**決定：直屬主管 → 部門主管 → 上級部門主管（去重、跳過本人）。")}
          {t("之後改這裡不影響已送出的單。兩者都沒有的人（老闆）送單即自動核准。免打卡者不列入遲到早退與缺勤。")}
        </p>
      </div>

      <div className="card">
        <h3>{t("班別")}</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            void act(async () => {
              await api.post("/shifts", {
                code: String(f.get("code")).trim(),
                name: String(f.get("name")).trim(),
                startTime: String(f.get("startTime")),
                endTime: String(f.get("endTime")),
                ...(String(f.get("dayCutoff")) ? { dayCutoff: String(f.get("dayCutoff")) } : {}),
              });
              form.reset();
              shifts.reload();
            });
          }}
        >
          <label className="field">{t("代碼（如 D001）")}<input name="code" required maxLength={10} /></label>
          <label className="field">{t("名稱")}<input name="name" required /></label>
          <label className="field">{t("上班")}<input name="startTime" type="time" required /></label>
          <label className="field">{t("下班（小於上班＝跨日班）")}<input name="endTime" type="time" required /></label>
          <label className="field">{t("歸屬日切點（預設 04:00）")}<input name="dayCutoff" type="time" /></label>
          <button className="primary">{t("新增班別")}</button>
        </form>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>{t("代碼")}</th><th>{t("名稱")}</th><th>{t("時間")}</th><th>{t("休息")}</th><th>{t("切點")}</th><th>{t("狀態")}</th></tr></thead>
          <tbody>
            {shifts.data?.map((s) => (
              <tr key={s.id}>
                <td><span className="badge" style={{ background: `${s.color}22`, color: s.color }}>{s.code}</span></td>
                <td>{s.name}</td>
                <td>{t5(s.startTime)} ~ {t5(s.endTime)}{t5(s.endTime) < t5(s.startTime) && t("（跨日）")}</td>
                <td>{s.breaks.length ? s.breaks.map((b) => `${b.start}-${b.end}`).join("、") : "—"}</td>
                <td>{t5(s.dayCutoff)}</td>
                <td><span className={`badge ${s.active ? "issued" : "canceled"}`}>{s.active ? t("啟用") : t("停用")}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          {t("歸屬日切點：這個時刻（含）之前的打卡歸前一天——跨日晚班的下班卡才不會被算到隔天。代碼建立後不可改。")}
        </p>
      </div>

      <div className="card">
        <h3>{t("排班")}</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const ids = (f.getAll("employeeIds") as string[]).map(Number).filter(Boolean);
            void act(async () => {
              const res = await api.post<{ scheduled: number; days: number; employees: number }>("/schedules", {
                employeeIds: ids,
                shiftId: Number(f.get("shiftId")),
                from: String(f.get("from")),
                to: String(f.get("to")),
                weekdays: (f.getAll("weekdays") as string[]).map(Number).filter(Boolean),
              });
              setOk(t("已排 {employees} 人 × {days} 天", { employees: res.employees, days: res.days }));
              await loadBoard();
            });
          }}
        >
          <label className="field">
            {t("員工（可多選）")}
            <select name="employeeIds" multiple size={5} style={{ minWidth: 160 }}>
              {employees.data?.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
          <label className="field">
            {t("班別")}
            <select name="shiftId" required defaultValue="">
              <option value="" disabled>{t("— 選班別 —")}</option>
              {shifts.data?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
            </select>
          </label>
          <label className="field">{t("從")}<input name="from" type="date" required /></label>
          <label className="field">{t("到")}<input name="to" type="date" required /></label>
          <label className="field">
            {t("只排週幾（不勾＝每天）")}
            <span style={{ display: "flex", gap: 6 }}>
              {["一", "二", "三", "四", "五", "六", "日"].map((w, i) => (
                <label key={w} style={{ fontSize: "0.8125rem", display: "flex", alignItems: "center", gap: 2 }}>
                  <input type="checkbox" name="weekdays" value={i + 1} />{t(w)}
                </label>
              ))}
            </span>
          </label>
          <button className="primary">{t("批次排班")}</button>
        </form>

        <form className="inline" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void loadBoard(); }}>
          <label className="field">{t("看板從")}<input type="date" value={boardFrom} onChange={(e) => setBoardFrom(e.target.value)} /></label>
          <label className="field">{t("到")}<input type="date" value={boardTo} onChange={(e) => setBoardTo(e.target.value)} /></label>
          <button className="small">{t("載入班表")}</button>
        </form>
        {board.length > 0 && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>{t("日期")}</th><th>{t("員工")}</th><th>{t("班別")}</th><th></th></tr></thead>
            <tbody>
              {board.map((b) => (
                <tr key={b.id}>
                  <td>{b.workDate}</td>
                  <td>{empName(b.employeeId)}</td>
                  <td><span className="badge" style={{ background: `${b.color}22`, color: b.color }}>{b.shiftCode}</span></td>
                  <td>
                    <button className="small" onClick={() => void act(async () => { await api.delete(`/schedules/${b.id}`); await loadBoard(); })}>
                      {t("刪除")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>{t("打卡紀錄")}</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => setPunches(await api.get<PunchRow[]>(`/attendance/punches?from=${punchFrom}&to=${punchTo}`)));
          }}
        >
          <label className="field">{t("從")}<input type="date" value={punchFrom} onChange={(e) => setPunchFrom(e.target.value)} /></label>
          <label className="field">{t("到")}<input type="date" value={punchTo} onChange={(e) => setPunchTo(e.target.value)} /></label>
          <button className="small">{t("查詢")}</button>
        </form>
        {punches && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>{t("出勤日")}</th><th>{t("員工")}</th><th>{t("時刻")}</th><th>{t("方向")}</th><th>{t("來源 IP")}</th><th>{t("方式")}</th></tr></thead>
            <tbody>
              {punches.map((p) => (
                <tr key={p.id}>
                  <td>{p.workDate}</td>
                  <td>{empName(p.employeeId)}</td>
                  <td>{new Date(p.punchedAt).toLocaleString("zh-TW", { hour12: false })}</td>
                  <td><span className={`badge ${p.direction === "in" ? "issued" : "canceled"}`}>{p.direction === "in" ? t("上班") : t("下班")}</span></td>
                  <td style={{ color: "var(--text-3)" }}>{p.sourceIp || "—"}</td>
                  <td>{p.method}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          {t("打卡紀錄不可修改（勞基法出勤紀錄保存義務）；異常更正走「出勤打卡」頁的補卡申請，核准後以「補卡」方式列在這裡。")}
        </p>
      </div>

      <div className="card">
        <h3>{t("假別")}</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            void act(async () => {
              await api.post("/leave-types", { code: String(f.get("code")).trim(), name: String(f.get("name")).trim() });
              form.reset();
              leaveTypes.reload();
            });
          }}
        >
          <label className="field">{t("自訂假別代碼（小寫英數）")}<input name="code" required maxLength={20} pattern="[a-z0-9_]+" /></label>
          <label className="field">{t("名稱")}<input name="name" required /></label>
          <button className="primary">{t("新增自訂假別")}</button>
        </form>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>{t("假別")}</th><th>{t("來源")}</th><th>{t("給薪比率％")}</th><th>{t("依據來源")}</th><th>{t("狀態")}</th><th></th></tr></thead>
          <tbody>
            {leaveTypes.data?.map((lt) => {
              const edit = ltEdits[lt.id] ?? {
                payRatioPercent: lt.payRatioPercent === null ? "" : String(lt.payRatioPercent),
                sourceNote: lt.sourceNote,
              };
              return (
                <tr key={lt.id}>
                  <td>{lt.name}</td>
                  <td>{lt.isSystem ? t("內建") : t("自訂")}</td>
                  <td>
                    <input
                      style={{ width: 70 }}
                      type="number"
                      min={0}
                      max={100}
                      placeholder={t("未填")}
                      value={edit.payRatioPercent}
                      onChange={(e) => setLtEdits({ ...ltEdits, [lt.id]: { ...edit, payRatioPercent: e.target.value } })}
                    />
                  </td>
                  <td>
                    <input
                      style={{ minWidth: 180 }}
                      placeholder={t("你查證的依據（條號／函釋）")}
                      value={edit.sourceNote}
                      onChange={(e) => setLtEdits({ ...ltEdits, [lt.id]: { ...edit, sourceNote: e.target.value } })}
                    />
                  </td>
                  <td><span className={`badge ${lt.active ? "issued" : "canceled"}`}>{lt.active ? t("啟用") : t("停用")}</span></td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className="small"
                      onClick={() =>
                        void act(async () => {
                          await api.patch(`/leave-types/${lt.id}`, {
                            payRatioPercent: edit.payRatioPercent === "" ? null : Number(edit.payRatioPercent),
                            sourceNote: edit.sourceNote,
                          });
                          leaveTypes.reload();
                        }, t("假別已更新"))
                      }
                    >
                      {t("儲存")}
                    </button>{" "}
                    <button
                      className="small"
                      onClick={() =>
                        void act(async () => {
                          await api.patch(`/leave-types/${lt.id}`, { active: !lt.active });
                          leaveTypes.reload();
                        })
                      }
                    >
                      {lt.active ? t("停用") : t("啟用")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          {t("內建假別是法定清單的「名稱」，只能停用不能刪；給薪比率與年度給假天數是勞基法數字，系統一律不預填——請自己查證後填入並留下依據來源。比率沒填的假別在算薪時不會計扣款（會明講）。")}
        </p>
      </div>

      <div className="card">
        <h3>{t("額度帳（年度給假）")}</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            void act(async () => {
              await api.post("/leave-balances", {
                employeeId: Number(f.get("employeeId")),
                leaveTypeId: Number(f.get("leaveTypeId")),
                year: Number(f.get("year")),
                grantedMinutes: Number(f.get("hours")) * 60 + Number(f.get("mins") || 0),
                note: String(f.get("note") ?? ""),
              });
              form.reset();
              await loadBalances();
            }, t("額度已儲存（同人同假別同年度會直接覆蓋）"));
          }}
        >
          <label className="field">
            {t("員工")}
            <select name="employeeId" required defaultValue="">
              <option value="" disabled>{t("— 選員工 —")}</option>
              {employees.data?.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
          <label className="field">
            {t("假別")}
            <select name="leaveTypeId" required defaultValue="">
              <option value="" disabled>{t("— 選假別 —")}</option>
              {leaveTypes.data?.filter((lt) => lt.active).map((lt) => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </select>
          </label>
          <label className="field">{t("年度")}<input name="year" type="number" defaultValue={new Date().getFullYear()} min={2000} max={2100} required style={{ width: 90 }} /></label>
          <label className="field">{t("時")}<input name="hours" type="number" min={0} required style={{ width: 70 }} /></label>
          <label className="field">{t("分")}<input name="mins" type="number" min={0} max={59} defaultValue={0} style={{ width: 60 }} /></label>
          <label className="field" style={{ minWidth: 180 }}>{t("給假依據（年資等）")}<input name="note" placeholder={t("例：年資 3 年，對照表你查的那一列")} /></label>
          <button className="primary">{t("給假")}</button>
        </form>
        <form className="inline" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void loadBalances(); }}>
          <label className="field">{t("年度")}<input type="number" value={balYear} onChange={(e) => setBalYear(e.target.value)} style={{ width: 90 }} /></label>
          <button className="small">{t("載入額度帳")}</button>
        </form>
        {balances && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>{t("員工")}</th><th>{t("假別")}</th><th>{t("給假")}</th><th>{t("已用")}</th><th>{t("簽核中")}</th><th>{t("剩餘")}</th><th>{t("依據")}</th></tr></thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.id}>
                  <td>{b.employeeName}</td>
                  <td>{b.leaveTypeName}</td>
                  <td>{fmtMinutes(b.grantedMinutes)}</td>
                  <td>{fmtMinutes(b.usedMinutes)}</td>
                  <td>{b.pendingMinutes ? fmtMinutes(b.pendingMinutes) : "—"}</td>
                  <td><strong>{fmtMinutes(Math.max(0, b.grantedMinutes - b.usedMinutes - b.pendingMinutes))}</strong></td>
                  <td style={{ color: "var(--text-3)" }}>{b.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          {t("「已用」不是另一本帳——它永遠是已核准請假單的合計，額度帳只記「給了多少」。")}
          {t("特休按年資給幾天請自己查對照表（曆年制／週年制的換算也由你決定），這裡只收結果。")}
        </p>
      </div>

      <div className="card">
        <h3>{t("行事曆（國定假日／補班）")}</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const lines = String(f.get("bulk") ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
            const entries = lines.map((l) => {
              const [day, kindWord, ...rest] = l.split(/\s+/);
              const kind = kindWord === "補班" || kindWord === "makeup_workday" ? "makeup_workday" : "holiday";
              return { day: day ?? "", kind, name: rest.join(" ") };
            });
            const form = e.currentTarget;
            void act(async () => {
              await api.put("/calendar-days", { entries });
              form.reset();
              await loadCalendar();
            }, t("已儲存 {n} 天", { n: entries.length }));
          }}
        >
          <label className="field" style={{ width: "100%" }}>
            {t("批次貼上（一行一天：「2026-01-01 放假 元旦」或「2026-02-07 補班」；人事行政局每年公告，請自行查抄）")}
            <textarea name="bulk" rows={4} style={{ width: "100%", fontFamily: "monospace" }} placeholder={t("2026-01-01 放假 元旦\n2026-02-07 補班")} />
          </label>
          <button className="primary" style={{ marginTop: 8 }}>{t("儲存行事曆")}</button>
        </form>
        <form className="inline" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void loadCalendar(); }}>
          <label className="field">{t("年度")}<input type="number" value={calYear} onChange={(e) => setCalYear(e.target.value)} style={{ width: 90 }} /></label>
          <button className="small">{t("載入")}</button>
        </form>
        {calendar && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>{t("日期")}</th><th>{t("類型")}</th><th>{t("名稱")}</th><th></th></tr></thead>
            <tbody>
              {calendar.map((c) => (
                <tr key={c.day}>
                  <td>{c.day}</td>
                  <td><span className={`badge ${c.kind === "holiday" ? "issued" : "draft"}`}>{c.kind === "holiday" ? t("放假") : t("補班")}</span></td>
                  <td>{c.name || "—"}</td>
                  <td><button className="small" onClick={() => void act(async () => { await api.delete(`/calendar-days/${c.day}`); await loadCalendar(); })}>{t("刪除")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>{t("申請單總覽")}</h3>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void loadRequests(); }}>
          <label className="field">
            {t("狀態")}
            <select value={reqStatus} onChange={(e) => setReqStatus(e.target.value)}>
              <option value="">{t("全部")}</option>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
            </select>
          </label>
          <button className="small">{t("查詢")}</button>
        </form>
        {requests && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>{t("申請人")}</th><th>{t("類型")}</th><th>{t("內容")}</th><th>{t("事由")}</th><th>{t("狀態")}</th><th>{t("簽核進度")}</th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.employeeName}</td>
                  <td>{t(KIND_LABELS[r.kind] ?? r.kind)}</td>
                  <td>{requestSummary(r)}</td>
                  <td style={{ color: "var(--text-2)" }}>{r.reason || "—"}</td>
                  <td><span className={`badge ${STATUS_BADGE[r.status]}`}>{t(STATUS_LABELS[r.status] ?? r.status)}</span></td>
                  <td style={{ fontSize: "0.8125rem", color: "var(--text-2)" }}>
                    {r.steps.length
                      ? r.steps.map((s) => `${s.approverName}${s.status === "approved" ? "✓" : s.status === "rejected" ? "✗" : s.status === "pending" ? "…" : ""}`).join(" → ")
                      : t("（免簽核）")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>{t("月出勤彙總（算薪取數來源）")}</h3>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void loadSummary(); }}>
          <label className="field">{t("月份")}<input type="month" value={sumMonth} onChange={(e) => setSumMonth(e.target.value)} /></label>
          <button className="small">{t("彙總")}</button>
        </form>
        {summary && (
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr><th>{t("員工")}</th><th>{t("應出勤")}</th><th>{t("實際工時")}</th><th>{t("遲到")}</th><th>{t("早退")}</th><th>{t("缺勤")}</th><th>{t("請假")}</th><th>{t("加班")}</th></tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.employeeId}>
                  <td>{s.employeeName}{s.punchExempt && <span style={{ color: "var(--text-3)" }}>{t("（免打卡）")}</span>}</td>
                  <td>{t("{days} 天／{dur}", { days: s.scheduledDays, dur: fmtMinutes(s.scheduledMinutes) })}</td>
                  <td>{fmtMinutes(s.workedMinutes)}</td>
                  <td>{s.lateCount ? t("{count} 次／{mins} 分", { count: s.lateCount, mins: s.lateMinutes }) : "—"}</td>
                  <td>{s.earlyLeaveCount ? t("{count} 次／{mins} 分", { count: s.earlyLeaveCount, mins: s.earlyLeaveMinutes }) : "—"}</td>
                  <td>{s.absentDays ? t("{days} 天／{dur}", { days: s.absentDays, dur: fmtMinutes(s.absentMinutes) }) : "—"}</td>
                  <td style={{ fontSize: "0.8125rem" }}>
                    {Object.entries(s.leaveByType).map(([code, m]) => {
                      const lt = leaveTypes.data?.find((x) => x.code === code);
                      return `${lt?.name ?? code} ${fmtMinutes(m)}`;
                    }).join("、") || "—"}
                  </td>
                  <td style={{ fontSize: "0.8125rem" }}>
                    {Object.entries(s.overtimeByDayType).map(([dt, m]) =>
                      `${DAY_TYPE_LABELS[dt] ? t(DAY_TYPE_LABELS[dt]) : dt} ${fmtMinutes(m)}`,
                    ).join("、") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
          {t("應出勤＝排班的合計（排班時請自行避開國定假日）；請假整筆歸「起始日」所在月份；遲到早退吃「出勤設定」的彈性分鐘。免打卡者不計遲到早退與缺勤。")}
        </p>
      </div>
    </div>
  );
}
