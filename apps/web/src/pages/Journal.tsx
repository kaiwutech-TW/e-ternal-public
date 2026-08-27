import { useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.ts";
import { fmt, useFetch, useListFetch } from "../hooks.ts";
import { ListFilterBar } from "../ui.tsx";
import type { Account, JournalEntryRow } from "../types.ts";

interface EntryLine {
  accountCode: string;
  /** 使用者在科目框打的原始文字；resolve 成功時 accountCode 才有值 */
  accountText?: string;
  debit: number;
  credit: number;
  /** 行摘要（0038）：這一行在動什麼；空字串＝顯示時退回單頭摘要 */
  memo: string;
}

// 與 db schema 的 doc_source enum 一對一：漏一個值，那類傳票的「來源」欄就會露出英文代碼給使用者看
const SOURCE_LABEL: Record<string, string> = {
  purchase: "進貨",
  sale: "銷貨",
  manual: "手工",
  receipt: "收款",
  payment: "付款",
  opening: "開帳",
  expense: "報銷",
  depreciation: "折舊",
  disposal: "資產處分",
  closing: "年度結轉",
  sale_return: "銷貨退回／折讓",
  purchase_return: "進貨退出／折讓",
  withholding: "扣繳支出",
  adjustment: "庫存調整",
};

export function Journal() {
  const t = useT();
  const accounts = useFetch<Account[]>("/accounts");
  // 清單篩選（R3）：日期範圍；傳票沒有交易對象欄
  const [filterQ, setFilterQ] = useState("");
  const entries = useListFetch<JournalEntryRow[]>(`/journal-entries${filterQ ? `?${filterQ}` : ""}`);
  const [error, setError] = useState<string | null>(null);
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<EntryLine[]>([
    { accountCode: "", debit: 0, credit: 0, memo: "" },
    { accountCode: "", debit: 0, credit: 0, memo: "" },
  ]);
  const [detail, setDetail] = useState<{ id: number; lines: { code: string; accountName: string; debit: number; credit: number; memo: string }[] } | null>(null);

  const setLine = (i: number, patch: Partial<EntryLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

  /**
   * 把使用者打的文字解析成科目代號：完整選項（「1101 庫存現金」）、純代號、
   * 或以四碼代號開頭的字串都認。解析不出來＝accountCode 空字串，紅框提示且擋送出——
   * 絕不靜默丟棄有金額的分錄（丟了會讓借貸合計與實際送出的內容對不上）。
   */
  const resolveCode = (text: string): string => {
    const txt = text.trim();
    if (!txt) return "";
    const exact = accounts.data?.find((a) => txt === a.code || txt === `${a.code} ${a.name}`);
    if (exact) return exact.code;
    const m = /^(\d{4})/.exec(txt);
    return m && accounts.data?.some((a) => a.code === m[1]) ? m[1]! : "";
  };
  const displayOf = (l: EntryLine) =>
    l.accountText ?? (l.accountCode ? `${l.accountCode} ${accounts.data?.find((a) => a.code === l.accountCode)?.name ?? ""}` : "");
  const unresolved = lines.some(
    (l) => (l.debit > 0 || l.credit > 0) && (l.accountText ?? "").trim() !== "" && !l.accountCode,
  );

  const addLine = () => {
    setLines((ls) => {
      // 新行的焦點：等 React 畫完再移（rAF 比 setTimeout 準——下一幀 DOM 一定在了）
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>(`[data-line-account="${ls.length}"]`)?.focus();
      });
      return [...ls, { accountCode: "", debit: 0, credit: 0, memo: "" }];
    });
  };
  /** 至少留兩行（一借一貸是傳票的最小形狀）；只想清空內容直接改欄位即可 */
  const removeLine = (i: number) => {
    setLines((ls) => (ls.length <= 2 ? ls : ls.filter((_, j) => j !== i)));
  };

  const submit = async () => {
    try {
      // 沒選科目或金額為 0 的行在這裡就被濾掉——**空白行永遠不會進資料庫**
      const valid = lines
        .filter((l) => l.accountCode && (l.debit > 0 || l.credit > 0))
        .map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit, memo: l.memo }));
      await api.post("/journal-entries", { entryDate, memo, lines: valid });
      setError(null);
      setMemo("");
      setLines([
        { accountCode: "", debit: 0, credit: 0, memo: "" },
        { accountCode: "", debit: 0, credit: 0, memo: "" },
      ]);
      entries.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 就地展開（同一列再點一次＝收合）——明細渲染在點擊列的正下方，不用捲到頁尾找 */
  const showDetail = async (id: number) => {
    if (detail?.id === id) return setDetail(null);
    try {
      setDetail(await api.get(`/journal-entries/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 作廢手工傳票（B4）：產生反向傳票沖平，原傳票留痕。系統傳票要作廢其來源單據（後端會指路） */
  const voidEntry = async (e: JournalEntryRow) => {
    const reason = window.prompt(
      t("作廢傳票 #{id}（{memo}）：請輸入作廢理由。", { id: e.id, memo: e.memo }) + "\n" +
        t("系統會開一張借貸互換的反向傳票沖平；打錯的分錄請作廢後重開一張。"),
    );
    if (reason === null) return;
    try {
      await api.post(`/journal-entries/${e.id}/void`, { reason: reason.trim() });
      setError(null);
      entries.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h3>{t("手工傳票（調整分錄、費用、期初科目餘額開帳）")}</h3>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="field">{t("日期")}<input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></label>
          <label className="field">{t("摘要")}<input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t("例：期初開帳")} style={{ width: 220 }} /></label>
        </form>
        {lines.map((l, i) => (
          <form
            key={i}
            className="inline"
            style={{ marginTop: 8 }}
            onSubmit={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              // 大量輸入的鍵盤流（慣例考據見 commit message）：
              // Enter＝在最後一行時新增一行；⌘/Ctrl+Enter＝建立傳票；⌘/Ctrl+⌫＝刪除本行
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (totalDebit === totalCredit && totalDebit > 0 && !unresolved) void submit();
              } else if (e.key === "Enter" && i === lines.length - 1) {
                e.preventDefault();
                addLine();
              } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                removeLine(i);
              }
            }}
          >
            <label className="field">
              {t("科目")}
              {/* datalist 版 combobox：可打代號（1101）或名稱（現金）過濾，74+ 個科目用純下拉太難撈 */}
              <input
                list="journal-account-options"
                data-line-account={i}
                value={displayOf(l)}
                onChange={(e) => setLine(i, { accountText: e.target.value, accountCode: resolveCode(e.target.value) })}
                placeholder={t("打代號或名稱搜尋")}
                style={{
                  width: 200,
                  ...((l.accountText ?? "").trim() !== "" && !l.accountCode ? { borderColor: "var(--red)", background: "var(--red-tint)" } : {}),
                }}
              />
            </label>
            <label className="field">{t("借方")}<input type="number" min={0} value={l.debit} onChange={(e) => setLine(i, { debit: Number(e.target.value) })} /></label>
            <label className="field">{t("貸方")}<input type="number" min={0} value={l.credit} onChange={(e) => setLine(i, { credit: Number(e.target.value) })} /></label>
            <label className="field">
              {t("行摘要（選填）")}
              <input
                value={l.memo}
                onChange={(e) => setLine(i, { memo: e.target.value })}
                placeholder={t("這一行在動什麼")}
                style={{ width: 180 }}
              />
            </label>
            <button
              className="small"
              title={t("刪除本行（⌘⌫）")}
              disabled={lines.length <= 2}
              onClick={() => removeLine(i)}
            >
              ✕
            </button>
            {i === lines.length - 1 && (
              <button className="small" onClick={addLine}>{t("＋分錄（Enter）")}</button>
            )}
          </form>
        ))}
        <datalist id="journal-account-options">
          {accounts.data?.filter((a) => a.active).map((a) => (
            <option key={a.id} value={`${a.code} ${a.name}`} />
          ))}
        </datalist>
        <div style={{ marginTop: 12 }}>
          <span style={{ marginRight: 12, color: totalDebit === totalCredit ? "var(--green)" : "var(--red)" }}>
            {totalDebit === totalCredit ? t("借 {debit}／貸 {credit}（已平）", { debit: fmt(totalDebit), credit: fmt(totalCredit) }) : t("借 {debit}／貸 {credit}（未平）", { debit: fmt(totalDebit), credit: fmt(totalCredit) })}
          </span>
          {unresolved && (
            <span style={{ marginRight: 12, color: "var(--red)" }}>{t("有分錄的科目對不上（紅框）——請從清單選一個")}</span>
          )}
          <button className="primary" onClick={submit} disabled={totalDebit !== totalCredit || totalDebit === 0 || unresolved}>
            {t("建立傳票")}
          </button>
          <div style={{ fontSize: "0.78125rem", color: "var(--text-3)", marginTop: 6 }}>
            {t("鍵盤：Enter＝新增一行（在最後一行時）、⌘/Ctrl+Enter＝建立傳票、⌘/Ctrl+⌫＝刪除該行。沒選科目或金額為 0 的行送出時會自動略過，不會被記錄。")}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>{t("傳票清單")}</h3>
        <ListFilterBar onApply={setFilterQ} total={entries.total} shown={entries.data?.length ?? 0} />
        <table>
          <thead>
            <tr><th>{t("編號")}</th><th>{t("日期")}</th><th>{t("摘要")}</th><th>{t("來源")}</th><th className="num">{t("金額（借方合計）")}</th><th></th></tr>
          </thead>
          <tbody>
            {entries.data?.map((e) => (
              <>
              <tr key={e.id}>
                <td>#{e.id}</td>
                <td>{e.entryDate}</td>
                <td>
                  {e.memo}{" "}
                  {e.voidedAt && (
                    <span className="badge canceled" title={t("作廢理由：{reason}（沖轉傳票 #{id}）", { reason: e.voidReason ?? "", id: e.reversalEntryId ?? "?" })}>
                      {t("已作廢")}
                    </span>
                  )}
                </td>
                <td>{e.sourceType ? t(SOURCE_LABEL[e.sourceType] ?? e.sourceType) : t("手工")}</td>
                <td className="num">{fmt(e.totalDebit)}</td>
                <td>
                  <button className="small" onClick={() => void showDetail(e.id)}>
                    {detail?.id === e.id ? t("收合") : t("明細")}
                  </button>{" "}
                  {/* 只有手工傳票能直接作廢：系統傳票作廢其來源單據（收付款／銷貨頁等各有作廢鍵） */}
                  {e.sourceType === "manual" && !e.voidedAt && (
                    <button className="small" onClick={() => void voidEntry(e)}>{t("作廢")}</button>
                  )}
                </td>
              </tr>
              {detail?.id === e.id && (
                <tr key={`${e.id}-detail`}>
                  <td colSpan={6} style={{ background: "var(--bg)", padding: 12 }}>
                    <table style={{ background: "transparent" }}>
                      <thead><tr><th>{t("科目")}</th><th>{t("名稱")}</th><th className="num">{t("借方")}</th><th className="num">{t("貸方")}</th><th>{t("行摘要")}</th></tr></thead>
                      <tbody>
                        {detail.lines.map((l, i) => (
                          <tr key={i}>
                            <td>{l.code}</td>
                            <td>{l.accountName}</td>
                            <td className="num">{l.debit ? fmt(l.debit) : ""}</td>
                            <td className="num">{l.credit ? fmt(l.credit) : ""}</td>
                            <td style={{ color: "var(--text-2)" }}>{l.memo || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
              </>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
