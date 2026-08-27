import { ROLES, ROLE_LABELS, type Role } from "@tw-erp/core";
import { periodOf } from "@tw-erp/einvoice";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useAuth } from "../auth.ts";
import { fmt, useFetch } from "../hooks.ts";
import { useT } from "../i18n.ts";
import type {
  AgentSettingsRow,
  ApiKeyRow,
  AuditRow,
  Employee,
  OpeningBalanceRow,
  Partner,
  Product,
  TotpStatus,
  Track,
  UserRow,
} from "../types.ts";

/** 供應商下拉的顯示名稱（中文當 i18n key，使用處 t()）。custom 是逃生門——新供應商冒出來時不必等我們改程式 */
const AGENT_PROVIDER_LABELS: Array<[string, string]> = [
  ["anthropic", "Anthropic（Claude）"],
  ["openai", "OpenAI"],
  ["google", "Google（Gemini API key／AI Studio）"],
  ["vertex-ai", "Google Vertex AI（express mode API key；不支援服務帳戶 OAuth）"],
  ["azure-openai", "Azure OpenAI"],
  ["ollama", "Ollama（自架，通常免金鑰）"],
  ["custom", "其他／自架相容端點"],
];

interface Company {
  name: string;
  taxId: string;
  address: string | null;
  personInCharge: string | null;
  telephone: string | null;
  email: string | null;
  taxRegistrationNo: string | null;
  cityCode: string | null;
  filerName: string | null;
  /** 申報人身分證號是 PII：API 只回「有沒有填」，明文限財務／管理者走單獨端點 */
  hasFilerIdNo: boolean;
  filerAreaCode: string | null;
  filerPhone: string | null;
  filerExt: string | null;
  declarationAgentNo: string | null;
  /** 兼營免稅／特種稅額（0028，B12）：true＝產 401 直接 422 指路 403 */
  vatMixedBusiness: boolean;
}

interface OpeningLine {
  productId: number;
  qty: number;
  unitCost: number;
}

/** 使用者管理（admin 限定）：新增帳號、指派角色、連結員工主檔、停用/啟用、重設密碼 */
function UsersAdmin() {
  const t = useT();
  const me = useAuth();
  const users = useFetch<UserRow[]>("/users");
  const employees = useFetch<Employee[]>("/employees");
  const [error, setError] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      setResettingId(null);
      users.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createUser = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await act(async () => {
      await api.post("/users", {
        username: String(f.get("username")).trim(),
        displayName: String(f.get("displayName")).trim(),
        password: String(f.get("password")),
        role: String(f.get("role")),
        ...(Number(f.get("employeeId")) ? { employeeId: Number(f.get("employeeId")) } : {}),
      });
      form.reset();
    });
  };

  const employeeName = (id: number | null) =>
    id ? (employees.data?.find((emp) => emp.id === id)?.name ?? `#${id}`) : "—";

  // R11：一個員工只能連一個帳號（API 已 409＋DB 唯一索引）。下拉標示「已連哪個帳號」
  // 並停用該選項——原本點錯一格就把一個人的報銷紀錄全開給另一個帳號，且畫面零提示
  const linkedUserOf = (employeeId: number, excludeUserId?: number) =>
    users.data?.find((u) => u.employeeId === employeeId && u.id !== excludeUserId);
  const employeeOption = (emp: Employee, excludeUserId?: number) => {
    const linked = linkedUserOf(emp.id, excludeUserId);
    return (
      <option key={emp.id} value={emp.id} disabled={!!linked}>
        {emp.name}{linked ? t("（已連 {username}）", { username: linked.username }) : ""}
      </option>
    );
  };

  return (
    <div className="card">
      <h3>{t("使用者管理（帳號決定登入後看得到哪些頁面）")}</h3>
      {error && <div className="error">{error}</div>}
      <form className="inline" onSubmit={createUser}>
        <label className="field">{t("帳號")}<input name="username" required /></label>
        <label className="field">{t("顯示名稱")}<input name="displayName" required /></label>
        <label className="field">{t("密碼（至少 6 碼）")}<input name="password" type="password" minLength={6} required /></label>
        <label className="field">
          {t("角色")}
          <select name="role" defaultValue="employee">
            {ROLES.map((r) => (
              <option key={r} value={r}>{t(ROLE_LABELS[r])}</option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("連結員工（報銷身分）")}
          <select name="employeeId" defaultValue={0}>
            <option value={0}>{t("— 不連結 —")}</option>
            {employees.data?.filter((emp) => emp.active).map((emp) => employeeOption(emp))}
          </select>
        </label>
        <button className="primary">{t("新增使用者")}</button>
      </form>
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr><th>{t("帳號")}</th><th>{t("顯示名稱")}</th><th>{t("角色")}</th><th>{t("連結員工")}</th><th>{t("狀態")}</th><th></th></tr>
        </thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.displayName}</td>
              <td>
                {u.id === me.id ? (
                  t(ROLE_LABELS[u.role])
                ) : (
                  <select value={u.role} onChange={(e) => void act(() => api.patch(`/users/${u.id}`, { role: e.target.value as Role }))}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{t(ROLE_LABELS[r])}</option>
                    ))}
                  </select>
                )}
              </td>
              <td>
                <select
                  value={u.employeeId ?? 0}
                  onChange={(e) => void act(() => api.patch(`/users/${u.id}`, { employeeId: Number(e.target.value) || null }))}
                >
                  <option value={0}>{t("— 不連結 —")}</option>
                  {employees.data?.map((emp) => employeeOption(emp, u.id))}
                </select>
                {u.employeeId !== null && !employees.data?.some((emp) => emp.id === u.employeeId) && employeeName(u.employeeId)}
              </td>
              <td><span className={`badge ${u.active ? "issued" : "canceled"}`}>{u.active ? t("啟用") : t("停用")}</span></td>
              <td>
                {u.id !== me.id && (
                  <button className="small" onClick={() => void act(() => api.patch(`/users/${u.id}`, { active: !u.active }))}>
                    {u.active ? t("停用") : t("啟用")}
                  </button>
                )}{" "}
                {resettingId === u.id ? (
                  <>
                    <input
                      autoFocus
                      type="password"
                      placeholder={t("新密碼（至少 6 碼）")}
                      style={{ width: 150 }}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />{" "}
                    <button className="small" onClick={() => void act(() => api.patch(`/users/${u.id}`, { password: newPassword }))}>{t("確認")}</button>{" "}
                    <button className="small" onClick={() => setResettingId(null)}>{t("取消")}</button>
                  </>
                ) : (
                  <button className="small" onClick={() => { setResettingId(u.id); setNewPassword(""); }}>{t("重設密碼")}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 13, color: "var(--text-2)" }}>
        {t("停用或重設密碼會立即登出該使用者。角色能看的頁面：管理者/財務＝全部；總經理＝報表與各單據（唯讀）；業務＝主檔＋銷貨；採購＝主檔＋進貨；員工＝費用報銷。")}
      </p>
    </div>
  );
}

/**
 * Agent 接入（admin 限定）：API 金鑰＋LLM 供應商設定。
 *
 * 兩塊放同一張卡是因為它們是同一件事的兩半——「agent 怎麼進得來」與「agent 用哪個模型」。
 * 分開放的話，設定到一半的人會以為自己做完了。
 */
function AgentAccess() {
  const t = useT();
  const users = useFetch<UserRow[]>("/users");
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [settings, setSettings] = useState<AgentSettingsRow | null>(null);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const reload = async () => {
    setKeys(await api.get<ApiKeyRow[]>("/api-keys"));
    setSettings(await api.get<AgentSettingsRow>("/agent-settings"));
  };
  useEffect(() => { void reload().catch((e) => setError((e as Error).message)); }, []);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      await reload();
      setError(null);
      if (okMsg) setOk(okMsg);
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  const createKey = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    return act(async () => {
      const res = await api.post<{ name: string; key: string }>("/api-keys", {
        name: String(f.get("name")).trim(),
        userId: Number(f.get("userId")),
      });
      setNewKey(res);
      form.reset();
    });
  };

  const saveSettings = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const apiKey = String(f.get("apiKey") ?? "").trim();
    const baseUrl = String(f.get("baseUrl") ?? "").trim();
    return act(
      () =>
        api.put("/agent-settings", {
          provider: String(f.get("provider")),
          model: String(f.get("model")).trim(),
          baseUrl: baseUrl || null,
          ...(apiKey ? { apiKey } : {}), // 空白＝不動既有金鑰（畫面永遠讀不到明文）
          enabled: f.get("enabled") === "on",
        }),
      t("已儲存"),
    );
  };

  const userName = (id: number) => users.data?.find((u) => u.id === id)?.username ?? `#${id}`;

  return (
    <div className="card">
      <h3>{t("Agent 接入（讓 AI 助理連進這套系統）")}</h3>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}

      <h4>{t("API 金鑰")}</h4>
      <p style={{ fontSize: 13, color: "var(--text-2)" }}>
        {t("金鑰讓機器不必用密碼登入。")}<strong>{t("它的權限完全等於你指定的那個帳號")}</strong>{t("——請先建一個角色受限的專用帳號（例如只給「業務」）再發金鑰，不要把管理者帳號給 AI。金鑰不受二階段驗證影響（機器沒有手機），但可以隨時撤銷。")}
      </p>
      <form className="inline" onSubmit={createKey}>
        <label className="field">{t("用途說明")}<input name="name" required placeholder={t("Claude Desktop（會計助理）")} /></label>
        <label className="field">
          {t("以哪個帳號的身分")}
          <select name="userId" required defaultValue="">
            <option value="" disabled>{t("— 請選擇 —")}</option>
            {users.data?.filter((u) => u.active).map((u) => (
              <option key={u.id} value={u.id}>{u.displayName}（{u.username}／{t(ROLE_LABELS[u.role])}）</option>
            ))}
          </select>
        </label>
        <button className="primary">{t("產生金鑰")}</button>
      </form>

      {newKey && (
        <div style={{ marginTop: 12 }}>
          <div className="ok">{t("「{name}」的金鑰已產生——請現在就複製，這串只顯示這一次。", { name: newKey.name })}</div>
          <pre style={{ background: "var(--bg)", padding: 12, borderRadius: 4, fontSize: 14, overflowX: "auto" }}>
            {newKey.key}
          </pre>
          <p style={{ fontSize: 13, color: "var(--text-2)" }}>
            {t("資料庫只留雜湊，沒有任何方式能再取得。設定方式見 ")}<code>docs/mcp.md</code>{t("：環境變數 ")}<code>TWERP_API_KEY</code>{t("。")}
          </p>
        </div>
      )}

      <table style={{ marginTop: 12 }}>
        <thead>
          <tr><th>{t("用途")}</th><th>{t("身分")}</th><th>{t("前綴")}</th><th>{t("最後使用")}</th><th>{t("狀態")}</th><th></th></tr>
        </thead>
        <tbody>
          {keys?.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>{userName(k.userId)}</td>
              <td><code>twerp_sk_{k.prefix}…</code></td>
              <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("zh-TW", { hour12: false }) : t("從未使用")}</td>
              <td>
                <span className={`badge ${k.revokedAt ? "canceled" : "issued"}`}>
                  {k.revokedAt ? t("已撤銷") : t("有效")}
                </span>
              </td>
              <td>
                {!k.revokedAt && (
                  <button className="small" onClick={() => void act(() => api.delete(`/api-keys/${k.id}`), t("金鑰已撤銷"))}>
                    {t("撤銷")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {keys?.length === 0 && <p style={{ fontSize: 13, color: "var(--text-2)" }}>{t("尚未產生任何金鑰。")}</p>}

      <h4 style={{ marginTop: 20 }}>{t("LLM 供應商")}</h4>
      <p style={{ fontSize: 13, color: "var(--text-2)" }}>
        <strong>{t("這套系統本身不會呼叫 LLM。")}</strong>{t("這裡只是讓金鑰有一個統一的保管位置，給跑在旁邊的 agent 取用——不然金鑰會散落在每個人自己的環境變數裡，沒有人知道公司總共有幾把、誰還留著。系統不會替你驗證金鑰能不能用，也不預設型號（寫死的型號會過期，而過期的預設值比空白更難發現）。")}
      </p>
      {settings && (
        <form className="inline" onSubmit={saveSettings}>
          <label className="field">
            {t("模型供應商")}
            <select name="provider" defaultValue={settings.provider}>
              {AGENT_PROVIDER_LABELS.map(([v, label]) => (
                <option key={v} value={v}>{t(label)}</option>
              ))}
            </select>
          </label>
          <label className="field">{t("模型名稱")}<input name="model" defaultValue={settings.model} placeholder={t("向供應商查詢目前可用的型號")} /></label>
          <label className="field">{t("端點網址（自架或代理才要填）")}<input name="baseUrl" defaultValue={settings.baseUrl ?? ""} placeholder="https://…" /></label>
          <label className="field">
            {t("API 金鑰")}{settings.hasApiKey ? t("（目前：…{hint}，留空不變更）", { hint: settings.apiKeyHint ?? "????" }) : ""}
            <input name="apiKey" type="password" placeholder={settings.hasApiKey ? t("留空＝不變更") : t("貼上供應商的金鑰")} />
          </label>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
            {t("啟用")}
          </label>
          <button className="primary">{t("儲存")}</button>
        </form>
      )}
      <p style={{ fontSize: 13, color: "var(--text-2)" }}>
        {t("agent 的身分與底線寫在 ")}<code>agent/soul.md</code>{t("，能力清單在 ")}<code>agent/skill.md</code>{t("——接 agent 之前請先讀那兩份，特別是「絕不斷言稅率與申報期限」那一條。")}
      </p>
      <AgentMemories />
    </div>
  );
}

interface MemoryRow {
  id: number;
  name: string;
  title: string;
  body: string;
  type: string;
  tags: string;
  status: "proposed" | "active" | "archived";
  source: string;
  staleAfter: string | null;
  proposedByName: string | null;
  approvedByName: string | null;
  expired: boolean;
}

/**
 * 助理記憶（公司知識）：agent 在對話中提議、這裡核准才生效——成長迴圈與單據紅線同構。
 * 每一條全員 agent 共用（注入每個人的對話索引），所以管理權限＝admin。
 */
function AgentMemories() {
  const t = useT();
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryRow | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const reload = async () => setRows(await api.get<MemoryRow[]>("/agent-memories"));
  useEffect(() => { void reload().catch((e) => setError((e as Error).message)); }, []);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      await reload();
      setError(null);
      setOk(okMsg ?? null);
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  const proposed = rows?.filter((r) => r.status === "proposed") ?? [];
  const active = rows?.filter((r) => r.status === "active") ?? [];
  const archived = rows?.filter((r) => r.status === "archived") ?? [];

  return (
    <div style={{ marginTop: 20, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
      <h4 style={{ margin: "0 0 10px" }}>
        {t("助理記憶（公司知識）")}
        {proposed.length > 0 && <span className="badge draft" style={{ marginLeft: 8 }}>{t("{n} 條待核准", { n: proposed.length })}</span>}
        {active.some((r) => r.expired) && <span className="badge canceled" style={{ marginLeft: 6 }}>{t("{n} 條已過期待覆核", { n: active.filter((r) => r.expired).length })}</span>}
      </h4>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}

      {proposed.length > 0 && (
        <table style={{ marginBottom: 12 }}>
          <thead><tr><th>{t("待核准")}</th><th>{t("摘要")}</th><th>{t("提議人")}</th><th></th></tr></thead>
          <tbody>
            {proposed.map((m) => (
              <tr key={m.id}>
                <td><code>{m.name}</code></td>
                <td>
                  {m.title}
                  <div style={{ fontSize: "0.78125rem", color: "var(--text-3)", whiteSpace: "pre-wrap" }}>{m.body.slice(0, 200)}</div>
                </td>
                <td style={{ color: "var(--text-2)" }}>{m.source === "agent" ? t("助理提議") : ""}{m.proposedByName ? t("（{name} 的對話）", { name: m.proposedByName }) : ""}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="small primary" onClick={() => void act(() => api.post(`/agent-memories/${m.id}/approve`, {}), t("已核准——之後的對話開始生效"))}>{t("核准")}</button>{" "}
                  <button className="small" onClick={() => void act(() => api.delete(`/agent-memories/${m.id}`))}>{t("刪除")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const form = e.currentTarget;
          const stale = String(f.get("staleAfter") ?? "").trim();
          void act(async () => {
            await api.post("/agent-memories", {
              name: String(f.get("name")).trim(),
              title: String(f.get("title")).trim(),
              body: String(f.get("body")),
              tags: String(f.get("tags") ?? ""),
              ...(stale ? { staleAfter: stale } : {}),
            });
            form.reset();
          }, t("記憶已新增（立即生效）"));
        }}
      >
        <label className="field">{t("代號（kebab-case）")}<input name="name" required pattern="[a-z0-9][a-z0-9-]+" placeholder="saturday-is-restday" /></label>
        <label className="field" style={{ minWidth: 220 }}>{t("一行摘要（索引只顯示它）")}<input name="title" required /></label>
        <label className="field" style={{ minWidth: 260 }}>{t("內容")}<textarea name="body" required rows={2} /></label>
        <label className="field">{t("標籤（逗號分隔）")}<input name="tags" /></label>
        <label className="field">{t("到期日（會過期才填）")}<input name="staleAfter" type="date" /></label>
        <button className="primary">{t("新增記憶")}</button>
      </form>

      {active.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>{t("記憶")}</th><th>{t("摘要")}</th><th>{t("到期")}</th><th>{t("核准人")}</th><th></th></tr></thead>
          <tbody>
            {active.map((m) => (
              <tr key={m.id} style={m.expired ? { opacity: 0.6 } : undefined}>
                <td><code>{m.name}</code></td>
                <td>{m.title}{m.expired && <span className="badge canceled" style={{ marginLeft: 6 }}>{t("已過期")}</span>}</td>
                <td>{m.staleAfter ?? "—"}</td>
                <td style={{ color: "var(--text-2)" }}>{m.approvedByName ?? "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="small" onClick={() => setEditing(m)}>{t("編輯")}</button>{" "}
                  <button className="small" onClick={() => void act(() => api.post(`/agent-memories/${m.id}/archive`, {}), t("已封存（不再注入對話）"))}>{t("封存")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <form
          className="inline"
          style={{ marginTop: 12, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const stale = String(f.get("staleAfter") ?? "").trim();
            void act(async () => {
              await api.patch(`/agent-memories/${editing.id}`, {
                title: String(f.get("title")),
                body: String(f.get("body")),
                tags: String(f.get("tags") ?? ""),
                staleAfter: stale || null,
              });
              setEditing(null);
            }, t("記憶已更新"));
          }}
        >
          <span style={{ alignSelf: "center", fontWeight: 600 }}>{t("編輯")} <code>{editing.name}</code></span>
          <label className="field" style={{ minWidth: 220 }}>{t("摘要")}<input name="title" defaultValue={editing.title} required /></label>
          <label className="field" style={{ minWidth: 280 }}>{t("內容")}<textarea name="body" defaultValue={editing.body} required rows={3} /></label>
          <label className="field">{t("標籤")}<input name="tags" defaultValue={editing.tags} /></label>
          <label className="field">{t("到期日")}<input name="staleAfter" type="date" defaultValue={editing.staleAfter ?? ""} /></label>
          <button className="primary">{t("儲存")}</button>
          <button type="button" className="small" onClick={() => setEditing(null)}>{t("取消")}</button>
        </form>
      )}

      {archived.length > 0 && (
        <p style={{ fontSize: 13, marginTop: 10 }}>
          <button className="small" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? t("收起") : t("已封存 {n} 條", { n: archived.length })}
          </button>
        </p>
      )}
      {showArchived && archived.map((m) => (
        <div key={m.id} style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}><code>{m.name}</code> {m.title}</div>
      ))}

      <p style={{ fontSize: 13, color: "var(--text-2)", marginTop: 10 }}>
        {t("記憶會注入**每一位**同事的助理對話（索引＋按需讀取）。助理在對話中被教到公司事實時會「提議」新記憶，在這裡核准才生效——助理起草、人定稿，跟單據的紅線同一條。到期的記憶自動退出索引，請覆核後改到期日或封存。")}
      </p>
    </div>
  );
}

/**
 * 二階段驗證（每個人管自己的，不限角色）。
 *
 * 流程刻意是「產生密鑰 → 先驗一次 → 才啟用」：不驗就啟用的話，
 * 掃描失敗而自己沒發現的人，會在下一次登入時直接進不來。
 */
function TotpSelfService() {
  const t = useT();
  const me = useAuth();
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [resetting, setResetting] = useState(false);

  const reload = () => api.get<TotpStatus>("/auth/totp").then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void reload(); }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 已啟用者重新設定要重新輸入密碼——重新設定的效果與「關閉再重開」相同，而關閉已經要求密碼了
  const begin = (password?: string) =>
    act(async () => {
      setCodes(null);
      setSetup(await api.post<{ secret: string; uri: string }>("/auth/totp/setup", password ? { password } : {}));
      setResetting(false);
    });

  const confirm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const code = String(new FormData(form).get("code") ?? "").trim();
    return act(async () => {
      const res = await api.post<{ recoveryCodes: string[] }>("/auth/totp/enable", { code });
      setCodes(res.recoveryCodes);
      setSetup(null);
      form.reset();
      await reload();
    });
  };

  const disable = (password: string) =>
    act(async () => {
      await api.post("/auth/totp/disable", { password });
      setDisabling(false);
      setCodes(null);
      await reload();
    });

  return (
    <div className="card">
      <h3>{t("二階段驗證（登入時除了密碼，再要一組手機上的驗證碼）")}</h3>
      {error && <div className="error">{error}</div>}

      {status?.enabled ? (
        <>
          <p>
            <span className="badge issued">{t("已啟用")}</span>{" "}
            {t("備援碼還剩 ")}<strong>{status.recoveryCodesLeft}</strong>{t(" 組")}
            {status.recoveryCodesLeft <= 2 && t("（快用完了，建議重新設定以取得新的一組）")}
          </p>
          {disabling || resetting ? (
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                const password = String(new FormData(e.currentTarget).get("password") ?? "");
                return disabling ? disable(password) : begin(password);
              }}
            >
              <label className="field">
                {disabling ? t("請再輸入一次密碼以確認關閉") : t("請再輸入一次密碼以確認重新設定")}
                <input name="password" type="password" autoFocus required autoComplete="current-password" />
              </label>
              <button className="primary">{disabling ? t("確認關閉") : t("確認重新設定")}</button>{" "}
              <button type="button" className="small" onClick={() => { setDisabling(false); setResetting(false); }}>
                {t("取消")}
              </button>
            </form>
          ) : (
            <>
              <button className="small" onClick={() => setResetting(true)}>{t("重新設定（換手機時用）")}</button>{" "}
              <button className="small" onClick={() => setDisabling(true)}>{t("關閉")}</button>
            </>
          )}
          {resetting && (
            <p style={{ fontSize: 13, color: "var(--text-2)" }}>
              {t("新的密鑰要等你用新手機驗證通過才會生效——中途放棄的話，現在這支手機照樣能用。")}
            </p>
          )}
        </>
      ) : (
        !setup && (
          <>
            <p style={{ fontSize: 13, color: "var(--text-2)" }}>
              {t("尚未啟用。密碼一旦外洩（在別的網站用了同一組、手機被裝了側錄），別人第一次登入就會成功；第二因子是唯一能把「知道密碼」和「就是本人」分開的東西。系統對外提供服務時建議至少替管理者帳號啟用。")}
            </p>
            <button className="primary" onClick={() => void begin()}>{t("開始設定")}</button>
          </>
        )
      )}

      {setup && (
        <div style={{ marginTop: 12 }}>
          <p>
            {t("在手機的驗證器 app（Google Authenticator、1Password、Microsoft Authenticator 皆可）選「手動輸入」，帳號填 ")}<code>{me.username}</code>{t("，密鑰填：")}
          </p>
          <p><code style={{ fontSize: 16, letterSpacing: 1 }}>{setup.secret}</code></p>
          <p style={{ fontSize: 13, color: "var(--text-2)" }}>
            {t("手機上開這個系統的話，也可以直接點")}<a href={setup.uri}>{t("這個連結")}</a>{t("讓 app 自己帶入。")}
          </p>
          <form className="inline" onSubmit={confirm}>
            <label className="field">
              {t("app 上目前顯示的 6 位數")}
              <input name="code" autoFocus required inputMode="numeric" maxLength={6} />
            </label>
            <button className="primary">{t("驗證並啟用")}</button>
          </form>
        </div>
      )}

      {codes && (
        <div style={{ marginTop: 12 }}>
          <div className="ok">{t("已啟用。以下是備援碼——請現在就抄下來或列印。")}</div>
          <p style={{ fontSize: 13, color: "var(--text-2)" }}>
            <strong>{t("這些碼只會顯示這一次")}</strong>{t("（資料庫只留雜湊，沒有任何方式能再取得）。手機掉了、換手機、app 被誤刪時，用其中一組代替驗證碼登入，一組用過就失效。請放在手機以外的地方——存在同一支手機裡等於沒有備援。")}
          </p>
          <pre style={{ background: "var(--bg)", padding: 12, borderRadius: 4, fontSize: 15 }}>
            {codes.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * 操作日誌（admin 限定）：誰、什麼時候、對哪個路徑做了什麼、結果如何。
 *
 * 刻意只有查詢，沒有刪除也沒有保留天數——能被關掉的稽核不是稽核。
 * 也刻意不試圖把路徑翻譯成白話（「POST /sales/12/invoice」不會變成「王小明開了發票」）：
 * 翻譯表一定會跟不上路由的新增，而跟不上的時候畫面會顯示一個**錯的**白話說明，
 * 那比顯示原始路徑危險得多。原始路徑至少永遠是真的。
 */
function AuditLog() {
  const t = useT();
  const [filter, setFilter] = useState({ path: "", username: "", failedOnly: false });
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const users = useFetch<UserRow[]>("/users");

  const load = async () => {
    try {
      const userId = users.data?.find((u) => u.username === filter.username)?.id;
      const q = new URLSearchParams({ limit: "200" });
      if (filter.path.trim()) q.set("path", filter.path.trim());
      if (userId) q.set("userId", String(userId));
      if (filter.failedOnly) q.set("failedOnly", "1");
      setRows(await api.get<AuditRow[]>(`/audit-logs?${q}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // 只在掛載時自動載一次；之後由「查詢」按鈕觸發（日誌是要人主動去看的東西，不是即時看板）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users.data]);

  return (
    <div className="card">
      <h3>{t("操作日誌（誰動了什麼；只增不刪）")}</h3>
      {error && <div className="error">{error}</div>}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="field">
          {t("使用者")}
          <select value={filter.username} onChange={(e) => setFilter((f) => ({ ...f, username: e.target.value }))}>
            <option value="">{t("— 全部 —")}</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.username}>{u.displayName}（{u.username}）</option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("路徑前綴（如 /sales）")}
          <input value={filter.path} onChange={(e) => setFilter((f) => ({ ...f, path: e.target.value }))} placeholder="/" />
        </label>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={filter.failedOnly} onChange={(e) => setFilter((f) => ({ ...f, failedOnly: e.target.checked }))} />
          {t("只看被擋下的")}
        </label>
        <button className="primary">{t("查詢")}</button>
      </form>
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr><th>{t("時間")}</th><th>{t("使用者")}</th><th>{t("動作")}</th><th>{t("結果")}</th><th>{t("來源")}</th></tr>
        </thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: "nowrap" }}>{new Date(r.at).toLocaleString("zh-TW", { hour12: false })}</td>
              <td>{r.username || "—"}{r.role ? `（${t(ROLE_LABELS[r.role])}）` : ""}</td>
              <td><code>{r.method} {r.path}</code>{r.targetId ? ` → #${r.targetId}` : ""}</td>
              <td><span className={`badge ${r.status < 400 ? "issued" : "canceled"}`}>{r.status}</span></td>
              <td style={{ color: "var(--text-2)" }}>{r.source || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows?.length === 0 && <p style={{ fontSize: 13, color: "var(--text-2)" }}>{t("沒有符合條件的紀錄。")}</p>}
      <p style={{ fontSize: 13, color: "var(--text-2)" }}>
        {t("記錄所有會改變資料的操作（含被權限擋下、密碼錯誤、驗證失敗的嘗試），以及身分證號的單筆查詢；一般的瀏覽查詢不記錄。")}<strong>{t("不記錄請求內容")}</strong>{t("——所以查得到「誰改了某張單」，查不到「值從什麼變成什麼」。最多顯示最近 200 筆。")}
      </p>
    </div>
  );
}

/**
 * 期初應收／應付（B6）：既有公司導入時，把每一筆未收未付的舊單建進子帳。
 * 與庫存開帳不同，這裡**會**自動拋轉傳票（應收＝借應收帳款、貸累積盈虧；應付反向）——
 * 所以期初手工傳票不得再含應收付科目，卡片下方的提醒就是在講這件事。
 */
function OpeningBalances() {
  const t = useT();
  const partners = useFetch<Partner[]>("/partners");
  const rows = useFetch<OpeningBalanceRow[]>("/opening-balances");
  const [kind, setKind] = useState<"receivable" | "payable">("receivable");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // 應收只該選得到客戶、應付只該選得到供應商——選錯服務端會 422，但最好連選都選不到
  const eligible = partners.data?.filter((p) => (kind === "receivable" ? p.isCustomer : p.isSupplier)) ?? [];

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const val = (k: string) => String(f.get(k) ?? "").trim();
    try {
      await api.post("/opening-balances", {
        kind,
        partnerId: Number(f.get("partnerId")),
        entryDate: val("entryDate"),
        docDate: val("docDate"),
        ...(val("dueDate") ? { dueDate: val("dueDate") } : {}),
        amount: Number(f.get("amount")),
        ...(val("memo") ? { memo: val("memo") } : {}),
      });
      setError(null);
      setOk(t("期初單已建立並拋轉傳票；請確認期初手工傳票裡沒有再入一次應收／應付科目"));
      form.reset();
      rows.reload();
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  // 已作廢的單（0030）不進合計：那筆欠款已被反向傳票收回
  const alive = rows.data?.filter((r) => !r.voidedAt) ?? [];
  const totalOf = (kind: "receivable" | "payable") =>
    alive.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount, 0);

  /** 作廢期初單（0030）：理由必填；反向傳票沖開帳分錄，已被收款沖銷的伺服端會 409 指路 */
  const voidRow = async (r: OpeningBalanceRow) => {
    const reason = window.prompt(
      (r.kind === "receivable"
        ? t("作廢期初應收單 #{id}（{name}，{amount} 元）：請輸入作廢理由。", { id: r.id, name: r.partnerName, amount: fmt(r.amount) })
        : t("作廢期初應付單 #{id}（{name}，{amount} 元）：請輸入作廢理由。", { id: r.id, name: r.partnerName, amount: fmt(r.amount) })) +
        "\n" + t("傳票以反向分錄沖平；已被收付款單沖銷的要先作廢那張收付款單。"),
    );
    if (reason === null) return;
    try {
      await api.post(`/opening-balances/${r.id}/void`, { reason: reason.trim() });
      setError(null);
      setOk(null);
      rows.reload();
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  return (
    <div className="card">
      <h3>{t("期初應收／應付（既有公司導入：建立舊欠款的客戶／供應商明細）")}</h3>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
      <form className="inline" onSubmit={submit}>
        <label className="field">
          {t("類別")}
          <select value={kind} onChange={(e) => setKind(e.target.value as "receivable" | "payable")}>
            <option value="receivable">{t("期初應收（客戶欠我）")}</option>
            <option value="payable">{t("期初應付（我欠供應商）")}</option>
          </select>
        </label>
        <label className="field">
          {kind === "receivable" ? t("客戶") : t("供應商")}
          <select name="partnerId" required defaultValue="">
            <option value="" disabled>{t("— 請選擇 —")}</option>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="field">{t("開帳日（傳票日期）")}<input name="entryDate" type="date" required /></label>
        <label className="field">{t("原單日期（帳齡起算）")}<input name="docDate" type="date" required /></label>
        <label className="field">{t("到期日（未約定可不填）")}<input name="dueDate" type="date" /></label>
        <label className="field">{t("未收/未付金額")}<input name="amount" type="number" min={1} required /></label>
        <label className="field">{t("摘要（原單號等）")}<input name="memo" /></label>
        <button className="primary">{t("建立期初單")}</button>
      </form>
      {rows.data && rows.data.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>{t("類別")}</th><th>{t("對象")}</th><th>{t("開帳日")}</th><th>{t("原單日期")}</th><th>{t("到期日")}</th>
              <th className="num">{t("金額")}</th><th className="num">{t("已沖")}</th><th className="num">{t("未沖")}</th><th>{t("摘要")}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.data.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.kind === "receivable" ? t("應收") : t("應付")}
                  {r.voidedAt && (
                    <>
                      {" "}
                      <span className="badge canceled" title={t("作廢理由：{reason}", { reason: r.voidReason ?? t("未記錄") })}>{t("已作廢")}</span>
                    </>
                  )}
                </td>
                <td>{r.partnerName}</td>
                <td>{r.entryDate}</td>
                <td>{r.docDate}</td>
                <td>{r.dueDate ?? "—"}</td>
                <td className="num">{fmt(r.amount)}</td>
                <td className="num">{r.allocated ? fmt(r.allocated) : "—"}</td>
                <td className="num">{fmt(r.remaining)}</td>
                <td>{r.memo}</td>
                <td>
                  {/* 作廢（0030）：已作廢的不再顯示（伺服端同樣會 409） */}
                  {!r.voidedAt && (
                    <button className="small" type="button" onClick={() => void voidRow(r)}>{t("作廢")}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>{t("合計：應收 {receivable}／應付 {payable}（不含已作廢）", { receivable: fmt(totalOf("receivable")), payable: fmt(totalOf("payable")) })}</td>
              <td className="num">{fmt(alive.reduce((s, r) => s + r.amount, 0))}</td>
              <td className="num" />
              <td className="num">{fmt(alive.reduce((s, r) => s + r.remaining, 0))}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      )}
      <p style={{ fontSize: 13, color: "var(--text-2)" }}>
        {t("每一筆未收未付的舊單各建一筆（帳齡與收付款沖銷都以單據為單位）。建立時")}<strong>{t("系統自動拋轉傳票")}</strong>{t("（應收：借應收帳款、貸累積盈虧；應付相反），所以期初手工傳票")}<strong>{t("不要再包含應收帳款與應付帳款")}</strong>{t("，否則會重複入帳。這些期初單不會進 401 申報——期初欠款不是當期銷項進項。")}
      </p>
    </div>
  );
}

export function Settings() {
  const t = useT();
  const me = useAuth();
  const tracks = useFetch<Track[]>("/invoice-tracks");
  const products = useFetch<Product[]>("/products");
  const [company, setCompany] = useState<Company | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [openingDate, setOpeningDate] = useState(new Date().toISOString().slice(0, 10));
  const [openingLines, setOpeningLines] = useState<OpeningLine[]>([{ productId: 0, qty: 0, unitCost: 0 }]);

  const setOpeningLine = (i: number, patch: Partial<OpeningLine>) =>
    setOpeningLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // 開帳合計即時顯示（B6-b）：這個數字就是期初傳票要借記存貨科目的金額，
  // 不顯示的話老闆得自己拿計算機加，而加錯不會有任何紅字——帳會永久少一塊且借貸照樣平衡
  const openingTotal = openingLines
    .filter((l) => l.productId && l.qty > 0)
    .reduce((s, l) => s + Math.round(l.qty * l.unitCost), 0);

  const submitOpening = async () => {
    try {
      const valid = openingLines.filter((l) => l.productId && l.qty > 0);
      if (!valid.length) throw new Error(t("至少一筆有效開帳明細"));
      const res = await api.post<{ lines: number; totalAmount: number }>("/inventory/opening", {
        docDate: openingDate,
        lines: valid,
      });
      setError(null);
      setOk(
        t("庫存開帳完成（{n} 筆，合計 {amount} 元）。記得到「傳票」頁以手工傳票開帳，存貨科目（1301 商品存貨）請借記這個合計金額——不補的話資產負債表會一直少這批存貨，而且借貸照樣平衡、不會有紅字", { n: res.lines, amount: fmt(res.totalAmount) }),
      );
      setOpeningLines([{ productId: 0, qty: 0, unitCost: 0 }]);
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    api.get<Company>("/company-profile").then(setCompany).catch(() => setCompany(null));
  }, []);

  const saveCompany = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? "").trim();
    try {
      const saved = await api.put<Company>("/company-profile", {
        name: val("name"),
        taxId: val("taxId"),
        ...(val("address") ? { address: val("address") } : {}),
        ...(val("personInCharge") ? { personInCharge: val("personInCharge") } : {}),
        ...(val("telephone") ? { telephone: val("telephone") } : {}),
        ...(val("email") ? { email: val("email") } : {}),
        ...(val("taxRegistrationNo") ? { taxRegistrationNo: val("taxRegistrationNo") } : {}),
        ...(val("cityCode") ? { cityCode: val("cityCode").toUpperCase() } : {}),
        // 申報人區塊：空字串＝清空該欄（API 端如此解讀）；身分證號例外——
        // 畫面不回顯明文，留空的語意是「不改」，所以只在有輸入時送出
        filerName: val("filerName"),
        ...(val("filerIdNo") ? { filerIdNo: val("filerIdNo").toUpperCase() } : {}),
        filerAreaCode: val("filerAreaCode"),
        filerPhone: val("filerPhone"),
        filerExt: val("filerExt"),
        declarationAgentNo: val("declarationAgentNo"),
        // checkbox：FormData 只在勾選時有值
        vatMixedBusiness: f.get("vatMixedBusiness") != null,
      });
      setCompany(saved);
      setError(null);
      setOk(t("公司基本檔已儲存"));
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  const addTrack = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post("/invoice-tracks", {
        period: String(f.get("period")),
        track: String(f.get("track")).toUpperCase(),
        rangeStart: Number(f.get("rangeStart")),
        rangeEnd: Number(f.get("rangeEnd")),
      });
      setError(null);
      tracks.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // 只有「一張都還沒開」的區間刪得掉；開過的 API 會回 409 並說明只能逐張作廢發票（B7）
  const deleteTrack = async (id: number) => {
    try {
      await api.delete(`/invoice-tracks/${id}`);
      setError(null);
      tracks.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}

      <TotpSelfService />
      {me.role === "admin" && <AgentAccess />}
      {me.role === "admin" && <UsersAdmin />}
      {me.role === "admin" && <AuditLog />}

      <div className="card">
        <h3>{t("公司基本檔（發票賣方資訊＋申報稅籍＋401 申報人）")}</h3>
        <form className="inline" onSubmit={saveCompany}>
          <label className="field">{t("公司名稱")}<input name="name" defaultValue={company?.name ?? ""} required /></label>
          <label className="field">{t("統一編號")}<input name="taxId" defaultValue={company?.taxId ?? ""} maxLength={8} required /></label>
          <label className="field">{t("地址")}<input name="address" defaultValue={company?.address ?? ""} /></label>
          <label className="field">{t("負責人姓名")}<input name="personInCharge" defaultValue={company?.personInCharge ?? ""} /></label>
          <label className="field">{t("公司電話")}<input name="telephone" defaultValue={company?.telephone ?? ""} /></label>
          <label className="field">Email<input name="email" defaultValue={company?.email ?? ""} /></label>
          <label className="field">{t("稅籍編號（9 碼）")}<input name="taxRegistrationNo" defaultValue={company?.taxRegistrationNo ?? ""} maxLength={9} /></label>
          <label className="field">{t("縣市別代號（1 碼）")}<input name="cityCode" defaultValue={company?.cityCode ?? ""} maxLength={1} /></label>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {/* 兼營標記（0028，B12）：勾了之後 401 直接拒產並指路——比一份看起來正常、實則錯類別的申報書誠實 */}
            <input
              key={company?.vatMixedBusiness ? "mixed-1" : "mixed-0"}
              type="checkbox"
              name="vatMixedBusiness"
              defaultChecked={company?.vatMixedBusiness ?? false}
            />
            {t("兼營免稅／特種稅額（勾選後本系統不產 401——兼營要用 403 申報，本系統未支援，請以官方軟體或洽記帳士辦理）")}
          </label>
          <fieldset style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "8px 12px", margin: "8px 0", width: "100%" }}>
            <legend style={{ fontSize: 13, color: "var(--text-2)" }}>
              {t("401 申報人（申報書第 99-103 欄；委託記帳士申報時另填登錄字號）")}
            </legend>
            <label className="field">{t("申報人姓名")}<input name="filerName" defaultValue={company?.filerName ?? ""} maxLength={12} /></label>
            <label className="field">
              {t("申報人身分證號")}
              <input
                name="filerIdNo"
                maxLength={10}
                placeholder={company?.hasFilerIdNo ? t("已設定（留空表示不變）") : ""}
                autoComplete="off"
              />
            </label>
            <label className="field">{t("電話區碼")}<input name="filerAreaCode" defaultValue={company?.filerAreaCode ?? ""} maxLength={4} style={{ width: 70 }} /></label>
            <label className="field">{t("電話")}<input name="filerPhone" defaultValue={company?.filerPhone ?? ""} maxLength={11} /></label>
            <label className="field">{t("分機")}<input name="filerExt" defaultValue={company?.filerExt ?? ""} maxLength={5} style={{ width: 70 }} /></label>
            <label className="field">
              {t("委託記帳士登錄字號（留空＝自行申報）")}
              <input name="declarationAgentNo" defaultValue={company?.declarationAgentNo ?? ""} maxLength={20} />
            </label>
          </fieldset>
          <button className="primary">{t("儲存")}</button>
        </form>
      </div>

      <div className="card">
        <h3>{t("電子發票字軌區間（向國稅局申請核准後，於大平台取號）")}</h3>
        <form className="inline" onSubmit={addTrack}>
          <label className="field">{t("期別（YYYYMM 奇數月）")}<input name="period" maxLength={6} required /></label>
          <label className="field">{t("字軌（2 字母）")}<input name="track" maxLength={2} required /></label>
          <label className="field">{t("起號")}<input name="rangeStart" type="number" required /></label>
          <label className="field">{t("迄號")}<input name="rangeEnd" type="number" required /></label>
          <button className="primary">{t("新增區間")}</button>
        </form>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>{t("期別")}</th><th>{t("字軌")}</th><th className="num">{t("起號")}</th><th className="num">{t("迄號")}</th><th className="num">{t("下一號")}</th><th className="num">{t("剩餘")}</th><th /></tr></thead>
          <tbody>
            {tracks.data?.map((tr) => {
              const remaining = Math.max(0, tr.rangeEnd - tr.nextNo + 1);
              // 尾款預警（B7）：剩餘低於 20 轉紅——快用罄才發現，下期字軌來不及申請就開不了發票。
              // 只警示當期（含以後）的區間：過期期別本來就不再開號，紅字只會稀釋警示
              const low = remaining < 20 && tr.period >= periodOf(new Date().toISOString().slice(0, 10));
              return (
              <tr key={tr.id}>
                <td>{tr.period}</td>
                <td>{tr.track}</td>
                <td className="num">{String(tr.rangeStart).padStart(8, "0")}</td>
                <td className="num">{String(tr.rangeEnd).padStart(8, "0")}</td>
                <td className="num">{String(tr.nextNo).padStart(8, "0")}</td>
                <td
                  className="num"
                  style={low ? { color: "var(--red)", fontWeight: 600 } : undefined}
                  title={low ? t("剩餘號碼即將用罄：發票要連號使用，號碼用完就開不了發票——請確認是否已申請並建立後續字軌區間") : undefined}
                >
                  {remaining}{low && t("（即將用罄）")}
                </td>
                <td>
                  {tr.nextNo === tr.rangeStart ? (
                    <button className="small" onClick={() => deleteTrack(tr.id)}>{t("刪除")}</button>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--text-2)" }} title={t("已配出號碼的區間是配號紀錄，不可刪除；開錯的發票請至「電子發票」頁逐張作廢")}>
                      {t("已配號")}
                    </span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>{t("庫存開帳（既有公司導入：建立期初在庫量與成本）")}</h3>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="field">{t("開帳日")}<input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} /></label>
        </form>
        {openingLines.map((l, i) => (
          <form key={i} className="inline" style={{ marginTop: 8 }} onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              {t("商品")}
              <select value={l.productId} onChange={(e) => setOpeningLine(i, { productId: Number(e.target.value) })}>
                <option value={0}>{t("— 請選擇 —")}</option>
                {products.data?.map((p) => (
                  <option key={p.id} value={p.id}>{p.sku} {p.name}</option>
                ))}
              </select>
            </label>
            <label className="field">{t("數量")}<input type="number" min={0} value={l.qty} onChange={(e) => setOpeningLine(i, { qty: Number(e.target.value) })} /></label>
            <label className="field">{t("單位成本")}<input type="number" min={0} step="0.01" value={l.unitCost} onChange={(e) => setOpeningLine(i, { unitCost: Number(e.target.value) })} /></label>
            {i === openingLines.length - 1 && (
              <button className="small" onClick={() => setOpeningLines((ls) => [...ls, { productId: 0, qty: 0, unitCost: 0 }])}>
                {t("＋明細")}
              </button>
            )}
          </form>
        ))}
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={submitOpening}>{t("建立庫存開帳")}</button>
          {openingTotal > 0 && (
            <span style={{ marginLeft: 12, fontWeight: 600 }}>
              {t("開帳合計 {amount} 元（期初傳票的存貨科目請借記此金額）", { amount: fmt(openingTotal) })}
            </span>
          )}
        </div>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          {t("庫存開帳只建立在庫量與移動平均成本基礎，")}<strong>{t("不拋轉傳票")}</strong>{t("；請至「傳票」頁以一張手工傳票開帳其餘期初科目（現金銀行、存貨、固定資產、借款、股本、累積盈虧等），存貨科目借記上方合計金額。期初的應收／應付請改用下方「期初應收／應付」（那邊會自動拋轉，手工傳票不要重複入）。月結關帳的檢查清單會核對庫存明細帳與存貨科目餘額，漏補傳票時會在那裡提示差額。")}
        </p>
      </div>

      <OpeningBalances />
    </div>
  );
}
