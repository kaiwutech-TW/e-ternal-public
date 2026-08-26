import { createContext, useContext, useState } from "react";
import type { PageKey } from "@tw-erp/core";

/** 頁面導覽：App 提供 setPage，任何元件（新手引導、零狀態按鈕）都能帶使用者去下一步 */
export const NavContext = createContext<(page: PageKey) => void>(() => {});
export const useNav = () => useContext(NavContext);

/** 零狀態：空清單不留白，告訴使用者這裡是什麼、下一步按哪裡 */
export function EmptyState(props: {
  icon: string;
  title: string;
  desc: string;
  actionLabel?: string;
  actionPage?: PageKey;
  onAction?: () => void;
}) {
  const nav = useNav();
  const act = props.onAction ?? (props.actionPage ? () => nav(props.actionPage!) : null);
  return (
    <div className="empty">
      <div className="icon">{props.icon}</div>
      <div className="title">{props.title}</div>
      <p>{props.desc}</p>
      {act && props.actionLabel && (
        <button className="primary" onClick={act}>{props.actionLabel}</button>
      )}
    </div>
  );
}

/**
 * 清單篩選列（R3）：日期範圍＋（有對象的清單）交易對象，樣式照操作日誌的篩選列
 * （form.inline＋label.field＋「查詢」按鈕）。清單預設只回最新 200 筆，
 * total 超過顯示筆數時在這裡出聲——否則使用者不會知道「看不到的單」是被分頁截掉的。
 */
export function ListFilterBar(props: {
  /** 提供＝顯示對象下拉；undefined＝此清單沒有對象欄（發票、傳票、報銷） */
  partners?: { id: number; name: string }[] | null | undefined;
  /** 對象欄位標籤：銷貨頁「客戶」、進貨頁「供應商」，預設「對象」 */
  partnerLabel?: string | undefined;
  /** 按「查詢」時回傳查詢字串（不含 ?；空字串＝清除篩選） */
  onApply: (query: string) => void;
  /** X-Total-Count；null＝尚未載入 */
  total: number | null;
  /** 目前實際顯示的筆數 */
  shown: number;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const truncated = props.total !== null && props.total > props.shown;
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        const q = new URLSearchParams();
        if (from) q.set("from", from);
        if (to) q.set("to", to);
        if (partnerId) q.set("partnerId", partnerId);
        props.onApply(q.toString());
      }}
    >
      <label className="field">
        日期起
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="field">
        日期迄
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      {props.partners !== undefined && (
        <label className="field">
          {props.partnerLabel ?? "對象"}
          <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">— 全部 —</option>
            {props.partners?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      )}
      <button className="primary">查詢</button>
      {props.total !== null && (
        <span style={{ fontSize: 13, color: truncated ? "var(--amber)" : "var(--text-2)", alignSelf: "center" }}>
          共 {props.total.toLocaleString("zh-TW")} 筆
          {truncated && `，僅顯示最新 ${props.shown} 筆——請用日期範圍或對象縮小查詢`}
        </span>
      )}
    </form>
  );
}

/**
 * 稅率回退警告。API 在「找不到涵蓋該日期的稅率參數」時會回 taxNotes，
 * 意思是這張單的稅額用的是既有預設值、而不是使用者查證後填的參數。
 *
 * 為什麼要做成共用元件：這件事有九條 API 路徑會產生，而原本只有進銷貨表單畫得出來，
 * 其餘六條靜靜把警告丟掉——使用者看到的就是一個沒有來歷的稅額。
 * 回退**不可靜默**是這批的設計紀律；複製六次註定會漏掉第七個呼叫端。
 */
export function TaxNotes(props: { notes: string[] | undefined }) {
  if (!props.notes?.length) return null;
  return (
    <div className="notice" role="status">
      {props.notes.map((n) => (
        <div key={n}>{n}</div>
      ))}
    </div>
  );
}

/**
 * 從任意 API 回應裡安全取出 taxNotes。
 * 九條路徑的回應形狀各不相同（有的是單據本身、有的包在 { order, saleId, taxNotes } 裡），
 * 與其在每一頁各寫一次型別轉換，不如集中在這裡——漏接一條的代價是使用者看到
 * 一個沒有來歷的稅額，而畫面上不會有任何跡象告訴他該去查。
 */
export function pickTaxNotes(res: unknown): string[] {
  const notes = (res as { taxNotes?: unknown } | null | undefined)?.taxNotes;
  return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === "string") : [];
}
