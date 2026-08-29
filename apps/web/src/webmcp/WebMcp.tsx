/**
 * WebMCP 的 React 掛載點（App.tsx 登入後渲染一顆）：
 * 1. 動態註冊：依「角色 × 目前頁面」重算工具集丟給 navigator.modelContext——
 *    登出即清空、換角色換工具，agent 永遠只看得到「現在做得到的事」。
 * 2. 草稿共編卡：agent 起草、人直接改格子，兩邊的變更都高亮＋進活動紀錄。
 * 3. 簽核卡：submit_draft 的唯一出口，人不按核准，資料進不了 ERP。
 * 4. Agent 活動側欄：每次工具呼叫的即時足跡（demo 的可視化主角）。
 *
 * 瀏覽器沒有 WebMCP 時：工具註冊靜默略過，但 UI 照常可用（人自己也能用草稿卡）。
 */
import { X, Bot, User as UserIcon, Check } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import type { PageKey } from "@tw-erp/core";
import { useAuth } from "../auth.ts";
import { useT } from "../i18n.ts";
import { useNav } from "../ui.tsx";
import {
  draftSubtotal,
  editDraft,
  getActivities,
  getApproval,
  getDraft,
  setDraft,
  subscribeActivities,
  subscribeApproval,
  subscribeDraft,
} from "./bus.ts";
import { clearTools, hasWebMcp, syncTools } from "./model-context.ts";
import { buildTools } from "./tools.ts";
import "./webmcp.css";

export function WebMcp({ page }: { page: string }) {
  const user = useAuth();
  const nav = useNav();

  // 動態註冊：角色或頁面一變就整組重算。unmount（登出）→ 清空工具。
  useEffect(() => {
    syncTools(
      buildTools({
        role: user.role,
        getPage: () => page,
        navigate: (k: PageKey) => nav(k),
      }),
    );
    return clearTools;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.role, page]);

  return (
    <>
      <DraftCard />
      <ApprovalCard />
      <ActivityPanel supported={hasWebMcp()} toolCount={window.webmcp?.list().length ?? 0} />
    </>
  );
}

/** lastEdit 十秒內的欄位掛高亮 class（CSS 動畫淡出） */
const flash = (d: ReturnType<typeof getDraft>, key: string): string =>
  d?.lastEdit && d.lastEdit.key === key && Date.now() - d.lastEdit.at < 10_000
    ? ` wm-flash-${d.lastEdit.actor}`
    : "";

function DraftCard() {
  const t = useT();
  const d = useSyncExternalStore(subscribeDraft, getDraft);
  if (!d) return null;
  return (
    <div className="wm-draft card">
      <div className="wm-draft-head">
        <Bot size={16} />
        <strong>{t("報價草稿（人機共編）")}</strong>
        <span className="wm-tag">{t("尚未送出")}</span>
        <button className="wm-icon-btn" title={t("放棄草稿")} onClick={() => setDraft(null)}>
          <X size={15} />
        </button>
      </div>
      <div className="wm-draft-grid">
        <label>{t("客戶")}</label>
        <div className={`wm-val${flash(d, "all")}`}>{d.partnerName}</div>
        <label>{t("報價日")}</label>
        <input
          className={flash(d, "quoteDate")}
          type="date"
          value={d.quoteDate}
          onChange={(e) => editDraft("quoteDate", "human", (x) => { x.quoteDate = e.target.value; })}
        />
        <label>{t("預計交期")}</label>
        <input
          className={flash(d, "expectedDate")}
          type="date"
          value={d.expectedDate ?? ""}
          onChange={(e) => editDraft("expectedDate", "human", (x) => {
            if (e.target.value) x.expectedDate = e.target.value; else delete x.expectedDate;
          })}
        />
        <label>{t("備註")}</label>
        <input
          className={flash(d, "memo")}
          value={d.memo ?? ""}
          onChange={(e) => editDraft("memo", "human", (x) => {
            if (e.target.value) x.memo = e.target.value; else delete x.memo;
          })}
        />
      </div>
      <table className="wm-lines">
        <thead>
          <tr><th>{t("品名")}</th><th>{t("數量")}</th><th>{t("未稅單價")}</th><th>{t("小計")}</th><th /></tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={i} className={flash(d, "lines")}>
              <td>{l.productName}</td>
              <td>
                <input
                  className={`wm-num${flash(d, `line.${i}.qty`)}`}
                  type="number"
                  min={0}
                  value={l.qty}
                  onChange={(e) => editDraft(`line.${i}.qty`, "human", (x) => { x.lines[i]!.qty = Number(e.target.value); })}
                />
              </td>
              <td>
                <input
                  className={`wm-num${flash(d, `line.${i}.unitPrice`)}`}
                  type="number"
                  min={0}
                  value={l.unitPrice}
                  onChange={(e) => editDraft(`line.${i}.unitPrice`, "human", (x) => { x.lines[i]!.unitPrice = Number(e.target.value); })}
                />
              </td>
              <td className="wm-right">{(l.qty * l.unitPrice).toLocaleString()}</td>
              <td>
                <button className="wm-icon-btn" title={t("刪除此行")} onClick={() => editDraft("lines", "human", (x) => { x.lines.splice(i, 1); })}>
                  <X size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="wm-draft-foot">
        <span>{t("未稅合計")}: <strong>{draftSubtotal(d).toLocaleString()}</strong> {t("元（稅額送出時由系統計算）")}</span>
        <span className="wm-hint">{t("送出走 agent 的 submit_draft → 簽核卡；或繼續口頭請 agent 修改")}</span>
      </div>
    </div>
  );
}

function ApprovalCard() {
  const t = useT();
  const a = useSyncExternalStore(subscribeApproval, getApproval);
  if (!a) return null;
  return (
    <div className="wm-approval-backdrop">
      <div className="wm-approval card">
        <div className="wm-approval-head">
          <UserIcon size={16} />
          <strong>{t("需要你的核准")}</strong>
        </div>
        <div className="wm-approval-title">{t(a.title)}</div>
        <div className="wm-facts">
          {a.facts.map(([k, v]) => (
            <div key={k} className="wm-fact"><span>{t(k)}</span><strong>{t(v)}</strong></div>
          ))}
        </div>
        <div className="wm-approval-actions">
          <button className="wm-decline" onClick={() => a.resolve(false)}>{t("退回")}</button>
          <button className="wm-approve" onClick={() => a.resolve(true)}>
            <Check size={14} /> {t("核准建立")}
          </button>
        </div>
        <div className="wm-hint">{t("agent 只能起草——沒有這顆按鈕，任何資料都進不了帳。")}</div>
      </div>
    </div>
  );
}

/**
 * 永遠顯示（登入後）：狀態列就是診斷工具——評審與我們都能一眼看到
 * 「這個瀏覽器有沒有 WebMCP、註冊了幾個工具」，不用開 DevTools。
 */
function ActivityPanel({ supported, toolCount }: { supported: boolean; toolCount: number }) {
  const t = useT();
  const list = useSyncExternalStore(subscribeActivities, getActivities);
  return (
    <div className="wm-activity">
      <div className="wm-activity-head">
        <Bot size={14} />
        <span>{t("Agent 活動")}</span>
        {supported ? (
          <span className="wm-tag wm-tag-ok">WebMCP ready · {toolCount} tools</span>
        ) : (
          <span className="wm-tag">{t("此瀏覽器不支援 WebMCP")}</span>
        )}
      </div>
      {list.length === 0 ? (
        <div className="wm-hint" style={{ padding: "6px 10px" }}>
          {supported
            ? t("等待 agent 連線——工具已依你的角色註冊完成。")
            : t("需要支援 WebMCP 的瀏覽器（ChatGPT 桌面版內建瀏覽器，或 Chrome 146+ 開啟 WebMCP flag）。")}
        </div>
      ) : (
        <ul>
          {list.slice(-8).map((e) => (
            <li key={e.id} className={`wm-act-${e.status}`}>
              <span className="wm-act-time">{e.time}</span>
              {e.actor === "agent" ? <Bot size={12} /> : <UserIcon size={12} />}
              <code>{e.tool}</code>
              <span className="wm-act-sum">{e.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
