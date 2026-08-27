import { canAccessPage } from "@tw-erp/core";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { pickTaxNotes } from "../ui.tsx";
import { useAuth } from "../auth.ts";
import { fmt } from "../hooks.ts";
import { useT } from "../i18n.ts";
import type { Account, ReturnKind, Returnable } from "../types.ts";

/**
 * 退回／折讓的共用表單，掛在來源單據列的下方展開。
 *
 * 文案刻意不用「沖銷」「迴轉」這類會計術語——使用者的觸發事件是「客戶打電話說要退貨」，
 * 他要回答的是「發生了什麼事」，而不是「這在會計上叫什麼」。
 * 「作廢」與「沖銷」在日常語感裡幾乎同義，正是誤選發票作廢的根源。
 */
export function ReturnForm(props: {
  side: "sale" | "purchase";
  docId: number;
  accounts: Account[];
  /** 帶上 taxNotes：退回單的稅額也吃營業稅率，走了回退值要讓使用者看到（由父層顯示，本表單送出後即關閉） */
  onDone: (taxNotes?: string[]) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const t = useT();
  const { side, docId } = props;
  const canUseCash = canAccessPage(useAuth().role, "cash");
  const [info, setInfo] = useState<Returnable | null>(null);
  const [kind, setKind] = useState<ReturnKind>("return");
  const [docDate, setDocDate] = useState(new Date().toISOString().slice(0, 10));
  const [certNo, setCertNo] = useState("");
  const [certDate, setCertDate] = useState("");
  const [memo, setMemo] = useState("");
  const [cashOut, setCashOut] = useState(false);
  const [cashAccountId, setCashAccountId] = useState(0);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [amount, setAmount] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const path = side === "sale" ? `/sales/${docId}/returnable` : `/purchases/${docId}/returnable`;
  useEffect(() => {
    let alive = true;
    api
      .get<Returnable>(path)
      .then((d) => {
        if (!alive) return;
        setInfo(d);
        // 預設全退：實務上大多是整批退回，要部分退再自己改數字
        setQty(Object.fromEntries(d.lines.map((l) => [l.id, Math.max(0, l.remainingQty)])));
        setAmount(Object.fromEntries(d.lines.map((l) => [l.id, 0])));
      })
      .catch((e: Error) => alive && props.onError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const cashAccounts = props.accounts.filter((a) => a.isCash && a.active);
  const label = side === "sale"
    ? { doc: "銷貨單", ret: "客戶把貨退回來了", allow: "貨沒退，但要少收錢", cash: "當場退現金給客戶" }
    : { doc: "進貨單", ret: "貨退回去給廠商了", allow: "貨沒退，廠商同意少收錢", cash: "廠商當場把錢退給我們" };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const lines = (info?.lines ?? [])
        .map((l) =>
          kind === "return"
            ? { sourceLineId: l.id, qty: qty[l.id] ?? 0 }
            : { sourceLineId: l.id, amount: Math.round(amount[l.id] ?? 0) },
        )
        .filter((l) => ("qty" in l ? (l.qty ?? 0) > 0 : (l.amount ?? 0) > 0));
      if (!lines.length) throw new Error(kind === "return" ? t("請填要退的數量") : t("請填折讓金額"));
      if (cashOut && !cashAccountId) throw new Error(t("請選擇退款用的現金／銀行科目"));
      const created = await api.post(side === "sale" ? `/sales/${docId}/returns` : `/purchases/${docId}/returns`, {
        kind,
        docDate,
        certNo: certNo.trim() || undefined,
        certDate: certDate || undefined,
        memo: memo.trim() || undefined,
        ...(cashOut ? { settlement: "cash", cashAccountId } : {}),
        lines,
      });
      props.onDone(pickTaxNotes(created));
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div style={{ fontSize: 13, color: "var(--text-2)" }}>{t("讀取原單明細中…")}</div>;

  return (
    <div style={{ padding: "10px 0", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          {t("發生了什麼事")}
          <select value={kind} onChange={(e) => setKind(e.target.value as ReturnKind)}>
            <option value="return">{t(label.ret)}</option>
            <option value="allowance">{t(label.allow)}</option>
          </select>
        </label>
        <label className="field">
          {kind === "return" ? t("退貨日期") : t("折讓日期")}
          <input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
        </label>
        <label className="field">
          {t("證明單號碼（選填）")}
          <input value={certNo} onChange={(e) => setCertNo(e.target.value)} style={{ width: 130 }} />
        </label>
        {/* 證明單日期必須有輸入通道：它與退貨日常常不同（貨這週退回去、供應商的證明單下個月才寄到），
            沒有這個欄位，將來要接 401 減項時無從判斷歸期（以證明單日期或貨物退回日為準尚未查證） */}
        <label className="field">
          {t("證明單日期（選填）")}
          <input type="date" value={certDate} onChange={(e) => setCertDate(e.target.value)} />
        </label>
        <label className="field">
          {t("原因（選填）")}
          <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
      </form>

      {/*
        誠實揭露，不是選配：表單向使用者要「證明單號碼」，很容易讓人以為系統會產生證明單。
        它不會——填進去的號碼只是登錄外部開立的那張單，方便日後對帳與申報時查找。
      */}
      <p style={{ fontSize: 12.5, color: "var(--amber)", background: "var(--amber-tint)", border: "1px solid var(--amber)", borderRadius: 6, padding: "6px 10px", margin: "8px 0 0" }}>
        {t("本系統")}<strong>{t("不會產生退回折讓證明單")}</strong>{t("（電子折讓證明單 XML 尚未實作）。")}{" "}
        {t("證明單需另行以財政部電子申報繳稅軟體或加值中心平台開立；上面兩個欄位是用來登錄那張單的號碼與日期，填了不代表已開立。")}{" "}
        {t("營業稅申報時的退回減項也還要人工填（見「營業稅申報」頁的提示）。")}
      </p>

      <table style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>{t("商品")}</th>
            <th className="num">{t("原數量")}</th>
            <th className="num">{t("原金額")}</th>
            <th className="num">{t("已退")}</th>
            <th className="num">{kind === "return" ? t("這次退幾個") : t("折讓金額（未稅）")}</th>
          </tr>
        </thead>
        <tbody>
          {info.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.productName}</td>
              <td className="num">{l.qty}</td>
              <td className="num">{fmt(l.amount)}</td>
              <td className="num">
                {l.returnedQty > 0 || l.returnedAmount > 0 || l.allowanceAmount > 0
                  ? t("退 {qty} 個／{amount} 元", { qty: l.returnedQty, amount: fmt(l.returnedAmount) }) +
                    (l.allowanceAmount > 0 ? t("、折讓 {amount} 元", { amount: fmt(l.allowanceAmount) }) : "")
                  : "—"}
              </td>
              <td className="num">
                {kind === "return" ? (
                  <input
                    type="number"
                    min={0}
                    max={Math.max(0, l.remainingQty)}
                    step="any"
                    style={{ width: 90 }}
                    value={qty[l.id] ?? 0}
                    onChange={(e) => setQty((m) => ({ ...m, [l.id]: Number(e.target.value) }))}
                  />
                ) : (
                  <input
                    type="number"
                    min={0}
                    max={l.remainingAllowance}
                    style={{ width: 90 }}
                    value={amount[l.id] ?? 0}
                    onChange={(e) => setAmount((m) => ({ ...m, [l.id]: Number(e.target.value) }))}
                  />
                )}
                <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                  {kind === "return"
                    ? t("最多 {n}", { n: Math.max(0, l.remainingQty) }) +
                      (side === "purchase" && l.onHandQty !== undefined ? t("（在庫 {n}）", { n: l.onHandQty }) : "")
                    : t("最多 {amount} 元", { amount: fmt(l.remainingAllowance) })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="inline" style={{ marginTop: 10 }} onSubmit={(e) => e.preventDefault()}>
        {/* 沒有收付款頁權限的角色連勾選都不給：後端會 403，先在這裡講清楚比讓他填完被擋友善。
            不是把整個退回單藏起來——他照樣開得成單，只是不能自己動現金 */}
        {canUseCash ? (
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={cashOut} onChange={(e) => setCashOut(e.target.checked)} />
            {t(label.cash)}
          </label>
        ) : (
          <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
            {t("{action}需要「收付款」頁的權限（會直接動到現金／銀行科目），您的角色沒有；這張單會自動沖抵貨款，剩下的掛{account}，由財務退款。", { action: t(label.cash), account: side === "sale" ? t("其他應付款") : t("其他應收款") })}
          </span>
        )}
        {cashOut && (
          <label className="field">
            {t("現金／銀行科目")}
            <select value={cashAccountId} onChange={(e) => setCashAccountId(Number(e.target.value))}>
              <option value={0}>{t("— 請選擇 —")}</option>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} {a.name}</option>
              ))}
            </select>
          </label>
        )}
      </form>

      {/* 對方科目由系統自動拆分，但一定要講出來——使用者不必懂會計，卻有權知道錢記到哪裡去了 */}
      <p style={{ fontSize: 12.5, color: "var(--text-2)", margin: "8px 0 0" }}>
        {side === "sale"
          ? t("系統會先沖掉這位客戶還欠的貨款；已經付清的部分會掛在「其他應付款」（＝該退還給客戶的錢），之後可用付款單退還或抵下次交易。")
          : t("系統會先沖掉還沒付給廠商的貨款；已經付清的部分會掛在「其他應收款」（＝廠商該退還給我們的錢）。")}
        {kind === "return"
          ? side === "sale"
            ? " " + t("退回的商品會回到庫存，成本按原銷貨成本回沖（等於那次出貨沒發生過）。")
            : " " + t("退出的商品按目前帳上的平均成本從庫存扣除；廠商退的錢與該成本的差額會調整銷貨成本（退的錢比帳上成本多就減少成本、少就增加成本）。")
          : side === "sale"
            ? " " + t("折讓不動庫存數量。")
            : " " + t("折讓不動庫存數量；廠商少收的錢會按「還在庫的比例」分攤到存貨成本與銷貨成本。")}
      </p>

      {/* 不可逆是真的：目前沒有刪除或更正退回單的入口（退錯只能再開一張反向的單，
          而反向的單又會再動一次庫存與成本）。表單預設「全退」，一鍵按下去就入帳，
          所以警告與二次確認不是禮貌問題 */}
      <p style={{ marginTop: 10, fontSize: 13, color: "var(--red)" }}>
        {t("送出後會立刻入帳並異動庫存，")}<strong>{t("目前沒有刪除或更正退回單的功能")}</strong>{t("。")}{" "}
        {t("請先確認數量與金額，尤其是預設帶入的「全退」數字。")}
      </p>
      <div style={{ marginTop: 10 }}>
        {confirming ? (
          <>
            <span style={{ marginRight: 8, color: "var(--red)" }}>{t("確定要入帳嗎？")}</span>
            <button className="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? t("處理中…") : t("確定入帳")}
            </button>{" "}
            <button onClick={() => setConfirming(false)}>{t("再檢查一下")}</button>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={() => setConfirming(true)}>
              {t("確認")}
            </button>{" "}
            <button onClick={props.onCancel}>{t("取消")}</button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 證明單欄位（退回紀錄表格用）：顯示號碼＋日期，並提供「補登／修改」。
 * 證明單一定是退貨入帳之後才在外面開（供應商那張更常是下個月才寄到），
 * 沒有事後補登的入口，「缺證明單 N 筆」永遠歸不了零、退回也永遠進不了 401 減項。
 * 補登後的減項歸期＝證明單日期（未填以退回日代），所以日期要一起收。
 */
export function CertCell(props: {
  side: "sale" | "purchase";
  returnId: number;
  certNo: string | null;
  certDate: string | null;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [no, setNo] = useState(props.certNo ?? "");
  const [date, setDate] = useState(props.certDate ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(
        `/${props.side === "sale" ? "sales-returns" : "purchase-returns"}/${props.returnId}`,
        { certNo: no.trim(), ...(date ? { certDate: date } : {}) },
      );
      setEditing(false);
      props.onSaved();
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <span style={{ whiteSpace: "nowrap" }}>
        <input
          autoFocus
          placeholder={t("證明單號碼")}
          style={{ width: 120 }}
          value={no}
          onChange={(e) => setNo(e.target.value)}
        />{" "}
        <input type="date" title={t("證明單日期（決定申報減項的歸期；未填以退回日計）")} value={date} onChange={(e) => setDate(e.target.value)} />{" "}
        <button className="small" disabled={busy || !no.trim()} onClick={() => void save()}>
          {busy ? "…" : t("儲存")}
        </button>{" "}
        <button className="small" onClick={() => setEditing(false)}>{t("取消")}</button>
      </span>
    );
  }
  return (
    <span style={props.certNo ? undefined : { color: "var(--red)" }}>
      {props.certNo ? `${props.certNo}${props.certDate ? `（${props.certDate}）` : ""}` : t("尚未登錄")}{" "}
      <button className="small" onClick={() => { setNo(props.certNo ?? ""); setDate(props.certDate ?? ""); setEditing(true); }}>
        {props.certNo ? t("修改") : t("補登")}
      </button>
    </span>
  );
}
