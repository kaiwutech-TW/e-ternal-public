import { Sparkles, Trash2, X } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { AuthContext } from "./auth.ts";
import { useT } from "./i18n.ts";

interface AgentStep {
  tool: string;
  summary: string;
  ok: boolean;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  steps?: AgentStep[];
}

const HISTORY_CAP = 60;

/**
 * 內建助理側欄（agent 執行層 Phase 1）。
 * 紅線提示直接寫在空狀態：助理只會查資料與建草稿，核准過帳永遠是人按。
 * 聊天記錄存瀏覽器本機（localStorage，**按使用者 id 分 key**——共用電腦換帳號
 * 互看不到彼此的記錄），保留最近 60 則。刻意不進資料庫：聊天不是單據，
 * 落了地就多一類要管保存與權限的敏感資料；要跨裝置同步時再議伺服端方案。
 */
export function AgentChat() {
  const user = useContext(AuthContext);
  const t = useT();
  const storageKey = `eternal-agent-chat:${user?.id ?? 0}`;
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => {
    try {
      const raw = localStorage.getItem(`eternal-agent-chat:${user?.id ?? 0}`);
      return raw ? (JSON.parse(raw) as ChatMsg[]) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, busy]);

  // 每次變動就落地本機；壞掉（配額滿等）就靜默放棄——聊天存不進去不該打斷使用
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(msgs.slice(-HISTORY_CAP)));
    } catch {
      /* noop */
    }
  }, [msgs, storageKey]);

  const clearHistory = () => {
    setMsgs([]);
    setError(null);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* noop */
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatMsg[] = [...msgs, { role: "user", content: text }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ reply: string; steps: AgentStep[] }>("/agent/chat", {
        messages: next.slice(-40).map((m) => ({ role: m.role, content: m.content })),
      });
      setMsgs([...next, { role: "assistant", content: res.reply, steps: res.steps }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="agent-fab" onClick={() => setOpen(true)} title={t("E-ternal 助理")} aria-label={t("開啟助理")}>
        <Sparkles size={20} />
      </button>
    );
  }

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <Sparkles size={15} />
        <span style={{ flex: 1, fontWeight: 600 }}>{t("E-ternal 助理")}</span>
        {msgs.length > 0 && (
          <button className="small" onClick={clearHistory} title={t("清除聊天記錄")} aria-label={t("清除聊天記錄")}><Trash2 size={14} /></button>
        )}
        <button className="small" onClick={() => setOpen(false)} aria-label={t("關閉")}><X size={14} /></button>
      </div>
      <div className="agent-body" ref={bodyRef}>
        {msgs.length === 0 && (
          <p className="agent-empty">
            {t("問我資料（「這個月毛利多少」「誰的特休快用完」），或請我起草單據（報價、請假/加班/補卡申請）。")}
            {t("我只能")}<b>{t("查資料")}</b>{t("與")}<b>{t("建草稿")}</b>{t("——核准、過帳、發薪永遠由人在對應頁面確認。")}
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`agent-msg ${m.role}`}>
            {m.steps && m.steps.length > 0 && (
              <div className="agent-steps">
                {m.steps.map((s, j) => (
                  <span key={j} className={`badge ${s.ok ? "issued" : "canceled"}`}>{s.summary}</span>
                ))}
              </div>
            )}
            <div className="agent-bubble">{m.content}</div>
          </div>
        ))}
        {busy && <div className="agent-msg assistant"><div className="agent-bubble agent-thinking">{t("思考中…")}</div></div>}
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
      <form
        className="agent-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("問資料，或請我起草單據…")}
          disabled={busy}
        />
        <button className="primary" disabled={busy || !input.trim()}>{t("送出")}</button>
      </form>
    </div>
  );
}
