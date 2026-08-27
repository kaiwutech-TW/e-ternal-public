/**
 * 稅法參數：使用者自己查證後填入的稅率／級距／可扣抵性，附生效期間與依據來源。
 *
 * ★ 本頁的紀律：這些數字是**使用者填的資料**，不是系統的知識。
 *   所以畫面上不會出現任何我們預設的稅率、級距金額或繳納期限；
 *   欄位說明與範例一律用中性數字（3.5%、10 萬）——例子裡的數字就是使用者最可能照抄的答案。
 *
 * ★ append-only：新增一列、接續前一列，就這兩個動作。沒有「編輯」也沒有「刪除」，
 *   因為舊年度必須算得回來（核定或更正可能兩三年後才來）。歷史列一律看得到，只標狀態。
 */
import { BRACKET_MODE_LABELS, bpToPercentText, percentToBp, type Translator } from "@tw-erp/core";
import { useState } from "react";
import { api } from "../api.ts";
import { fmt, useFetch } from "../hooks.ts";
import { useT } from "../i18n.ts";
import type { TaxBracket, TaxParameterList, TaxParameterRow } from "../types.ts";
import { EmptyState } from "../ui.tsx";

/** 我們自己會去讀的 kind 有白話名稱；使用者自訂的 kind 原樣顯示（中文＝字典 key，使用處 t()） */
const KIND_LABELS: Record<string, string> = {
  vat: "營業稅率",
  income_tax: "營所稅級距",
  undistributed_earnings: "未分配盈餘",
  input_tax_deductible: "報銷分類：進項稅可否扣抵",
};

/** 這幾種 kind 系統真的會拿去算，其他的只是保管 */
const KIND_USED_BY: Record<string, string> = {
  vat: "進貨／銷貨／報價／訂單／採購單／退回單的稅額，以及發票 XML 與 401 的 B2C 拆算",
  input_tax_deductible: "報銷單建立時要不要拆出 1288 進項稅額",
};

const STATUS_LABEL: Record<TaxParameterRow["status"], string> = {
  active: "生效中",
  expired: "已失效",
  future: "尚未生效",
};

function periodText(t: Translator, row: TaxParameterRow): string {
  return `${row.validFrom} ~ ${row.validTo ?? t("（仍有效）")}`;
}

/** 值的白話顯示。null 與 0 的差別在這一頁一樣重要：沒有值的列根本存不進來（DB CHECK 擋著） */
function valueText(t: Translator, row: TaxParameterRow): string {
  if (row.boolValue !== null) return row.boolValue ? t("是（可扣抵）") : t("否（不可扣抵）");
  if (!row.brackets?.length) return t("（沒有級距）");
  return row.brackets
    .map((b) => {
      const range = `${fmt(b.from)}${b.to === null ? t(" 以上") : `–${fmt(b.to)}`}`;
      if (b.mode === "exempt") return t("{range}：不課", { range });
      const pct = b.rateBp === null || b.rateBp === undefined ? "？" : bpToPercentText(b.rateBp);
      return b.mode === "rate_on_total"
        ? t("{range}：全額 × {pct}%", { range, pct })
        : t("{range}：超過起點的部分 × {pct}%", { range, pct });
    })
    .join(t("；"));
}

export function TaxParameters() {
  const t = useT();
  const list = useFetch<TaxParameterList>("/tax-parameters");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const rows = list.data?.rows ?? [];
  const recordOnly = new Set(list.data?.recordOnlyKinds ?? []);
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="notice">{ok}</div>}

      {/* 誠實揭露擺在最前面：使用者要先知道系統管到哪裡、什麼還是他自己的責任 */}
      <div className="card">
        <h3>{t("這一頁做什麼、不做什麼")}</h3>
        <p style={{ margin: "0 0 6px" }}>
          <strong>{t("會做")}</strong>{t("：把你")}<strong>{t("自己查證到的")}</strong>{t("稅法數值記下來——費率、級距、可否扣抵——並且記住它")}
          <strong>{t("從哪一天到哪一天有效")}</strong>{t("、你是")}<strong>{t("照哪裡填的")}</strong>{t("。其中兩種會被系統真的拿去算：")}
          <strong>{t("營業稅率")}</strong>{t("（每一張進貨／銷貨／報價／訂單／採購單／退回單的稅額，以及發票 XML 與 401 的 B2C 拆算）與")}
          <strong>{t("報銷分類的可扣抵性")}</strong>{t("（報銷核准要不要拆出 1288）。")}
        </p>
        <p style={{ margin: "0 0 6px" }}>
          <strong>{t("不會做")}</strong>{t("：系統")}<strong>{t("不內建任何稅率、級距或免稅額度")}</strong>{t("，也不判斷你填的數字對不對。尤其：")}
          <strong>{t("本系統不計算營所稅，也不計算未分配盈餘加徵的稅")}</strong>
          {t("——那兩種參數存在這裡，只是讓你把查到的規則（含生效期間與依據）記錄下來，")}
          <strong>{t("實際申報仍須你自行計算與填報")}</strong>{t("。存了參數不等於系統會幫你報稅。系統同樣")}
          <strong>{t("不提示任何繳納或申報期限")}</strong>{t("。")}
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>
          <strong>{t("這張表只增不改")}</strong>{t("：法規變了是「新增一列＋把舊列接續起來」，舊列的值與依據永遠留著。原因是")}
          <strong>{t("舊年度必須算得回來")}</strong>
          {t("——核定通知或更正申報可能兩三年後才來，那時要重算的是「當年那個費率下的數字」。也因此，")}
          <strong>{t("補設或更新參數不會回頭重算已建立的單據")}</strong>{t("。")}
        </p>
      </div>

      <NewParameterForm
        existingKinds={kinds}
        onSaved={(msg) => {
          setOk(msg);
          setError(null);
          list.reload();
        }}
        onError={(msg) => {
          setError(msg);
          setOk(null);
        }}
      />

      {rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="📐"
            title={t("還沒有任何稅法參數")}
            desc={t(
              "這裡放你自己查到的稅率與規則。最該先填的是「營業稅率」——" +
                "沒有涵蓋單據日期的設定時，系統會沿用一個既有的預設值並在每張單上提醒你（那個預設值不是本專案查證的結果）。" +
                "填的時候順手在「依據來源」寫下你是照哪個頁面、哪一天查的：明年這個數字若變了，你會需要知道當初的出處。",
            )}
          />
        </div>
      ) : (
        kinds.map((kind) => (
          <div className="card" key={kind}>
            <h3>
              {t(KIND_LABELS[kind] ?? kind)}
              <span style={{ fontSize: 12.5, color: "var(--text-2)", fontWeight: 400 }}> {t("（kind: {kind}）", { kind })}</span>
            </h3>
            {KIND_USED_BY[kind] ? (
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-2)" }}>
                {t("系統會拿它來算：{usedBy}。", { usedBy: t(KIND_USED_BY[kind] ?? "") })}
              </p>
            ) : (
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--amber)" }}>
                {recordOnly.has(kind)
                  ? t("系統只保管這組規則，不會拿它計算任何東西——申報時請自行計算與填報。")
                  : t("這是你自訂的參數，系統只保管、不會拿它計算任何東西。")}
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th>{t("名稱")}</th>
                  <th>{t("適用對象")}</th>
                  <th>{t("生效期間")}</th>
                  <th>{t("值")}</th>
                  <th>{t("依據來源")}</th>
                  <th>{t("誰填的／何時")}</th>
                  <th>{t("狀態")}</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => r.kind === kind)
                  .map((r) => (
                    <tr key={r.id} style={r.status === "expired" ? { opacity: 0.62 } : undefined}>
                      <td>
                        #{r.id} {r.label}
                      </td>
                      <td>{r.scopeKey ?? "—"}</td>
                      <td>{periodText(t, r)}</td>
                      <td>{valueText(t, r)}</td>
                      <td>
                        {r.sourceNote ?? (
                          <span style={{ color: "var(--amber)" }}>{t("未註明依據來源")}</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12.5, color: "var(--text-2)" }}>
                        {r.enteredByName ?? t("系統（首次啟動時建立）")}
                        <br />
                        {r.enteredAt.slice(0, 10)}
                      </td>
                      <td>
                        <span className={`badge ${r.status === "active" ? "issued" : "canceled"}`}>
                          {t(STATUS_LABEL[r.status])}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0 0" }}>
              {t("已失效的列")}<strong>{t("刻意不隱藏")}</strong>{t("：它就是「那一年是照什麼算的」的唯一紀錄。")}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

const EMPTY_BRACKET: TaxBracket = { from: 0, to: null, mode: "rate_on_total", rateBp: null };

/**
 * 新增一列。刻意做成「一次填完整列」而不是就地編輯：
 * 就地編輯的心智模型是「改掉這個值」，而這張表的心智模型是「從某天起換一個值，舊的留著」。
 */
function NewParameterForm(props: {
  existingKinds: string[];
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const t = useT();
  const [kind, setKind] = useState("vat");
  const [customKind, setCustomKind] = useState("");
  const [scopeKey, setScopeKey] = useState("");
  const [label, setLabel] = useState("");
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));
  const [validTo, setValidTo] = useState("");
  const [shape, setShape] = useState<"brackets" | "bool">("brackets");
  const [brackets, setBrackets] = useState<TaxBracket[]>([{ ...EMPTY_BRACKET }]);
  const [boolValue, setBoolValue] = useState(true);
  const [sourceNote, setSourceNote] = useState("");
  const [supersede, setSupersede] = useState(false);

  const effectiveKind = kind === "__custom" ? customKind.trim() : kind;
  const setBracket = (i: number, patch: Partial<TaxBracket>) =>
    setBrackets((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const submit = async () => {
    try {
      if (!effectiveKind) throw new Error(t("請選擇或輸入參數種類（kind）"));
      if (!label.trim()) throw new Error(t("請給這一列一個看得懂的名稱（例如「營業稅率」）"));
      const payload: Record<string, unknown> = {
        kind: effectiveKind,
        label: label.trim(),
        validFrom,
        ...(validTo ? { validTo } : {}),
        ...(scopeKey.trim() ? { scopeKey: scopeKey.trim() } : {}),
        ...(sourceNote.trim() ? { sourceNote: sourceNote.trim() } : {}),
        ...(supersede ? { supersedePrevious: true } : {}),
      };
      if (shape === "bool") {
        payload["boolValue"] = boolValue;
      } else {
        payload["brackets"] = brackets.map((b) => ({
          from: Math.round(b.from),
          to: b.to === null ? null : Math.round(b.to),
          mode: b.mode,
          rateBp: b.mode === "exempt" ? null : (b.rateBp ?? null),
        }));
      }
      const created = await api.post<{ id: number; superseded: { id: number; newValidTo: string } | null }>(
        "/tax-parameters",
        payload,
      );
      props.onSaved(
        created.superseded
          ? t(
              "已新增第 #{id} 列，並把第 #{prevId} 列的生效迄日設為 {newValidTo}（該列的值與依據原封不動）。提醒：這不會回頭重算已建立的單據。",
              { id: created.id, prevId: created.superseded.id, newValidTo: created.superseded.newValidTo },
            )
          : t("已新增第 #{id} 列。提醒：這不會回頭重算已建立的單據。", { id: created.id }),
      );
      setLabel("");
      setSourceNote("");
      setBrackets([{ ...EMPTY_BRACKET }]);
      setSupersede(false);
    } catch (e) {
      props.onError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h3>{t("新增一列（這張表只增不改）")}</h3>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          {t("參數種類")}
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setShape(e.target.value === "input_tax_deductible" ? "bool" : "brackets");
            }}
          >
            <option value="vat">{t("營業稅率（系統會拿去算）")}</option>
            <option value="input_tax_deductible">{t("報銷分類：進項稅可否扣抵（系統會拿去算）")}</option>
            <option value="income_tax">{t("營所稅級距（只記錄，系統不計算）")}</option>
            <option value="undistributed_earnings">{t("未分配盈餘（只記錄，系統不計算）")}</option>
            {props.existingKinds
              .filter((k) => !KIND_LABELS[k])
              .map((k) => (
                <option key={k} value={k}>{t("{kind}（你自訂的）", { kind: k })}</option>
              ))}
            <option value="__custom">{t("— 自訂一種 —")}</option>
          </select>
        </label>
        {kind === "__custom" && (
          <label className="field">
            {t("自訂種類代號")}
            <input value={customKind} onChange={(e) => setCustomKind(e.target.value)} placeholder={t("例如 my_rule")} />
          </label>
        )}
        <label className="field">
          {t("適用對象（可留空）")}
          <input
            value={scopeKey}
            onChange={(e) => setScopeKey(e.target.value)}
            placeholder={kind === "input_tax_deductible" ? t("費用科目代號，例如 6137") : t("留空＝全公司一個值")}
          />
        </label>
        <label className="field">
          {t("名稱")}
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("例如：營業稅率")} />
        </label>
        <label className="field">
          {t("生效起日")}
          <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </label>
        <label className="field">
          {t("生效迄日（留空＝仍有效）")}
          <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </label>
        <label className="field">
          {t("值的形狀")}
          <select value={shape} onChange={(e) => setShape(e.target.value as "brackets" | "bool")}>
            <option value="brackets">{t("級距／費率")}</option>
            <option value="bool">{t("是／否")}</option>
          </select>
        </label>
      </form>

      {shape === "bool" ? (
        <div style={{ marginTop: 10 }}>
          <label className="field" style={{ maxWidth: 260 }}>
            {t("值")}
            <select value={boolValue ? "1" : "0"} onChange={(e) => setBoolValue(e.target.value === "1")}>
              <option value="1">{t("是")}</option>
              <option value="0">{t("否")}</option>
            </select>
          </label>
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th className="num">{t("起（含）")}</th>
                <th className="num">{t("迄（含，留空＝無上限）")}</th>
                <th>{t("計算方式")}</th>
                <th className="num">{t("費率 %")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {brackets.map((b, i) => (
                <tr key={i}>
                  <td className="num">
                    <input
                      style={{ width: 110 }}
                      type="number"
                      value={b.from}
                      onChange={(e) => setBracket(i, { from: Number(e.target.value) })}
                    />
                  </td>
                  <td className="num">
                    <input
                      style={{ width: 110 }}
                      type="number"
                      value={b.to ?? ""}
                      onChange={(e) => setBracket(i, { to: e.target.value === "" ? null : Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <select
                      value={b.mode}
                      onChange={(e) => setBracket(i, { mode: e.target.value as TaxBracket["mode"] })}
                    >
                      {(Object.keys(BRACKET_MODE_LABELS) as (keyof typeof BRACKET_MODE_LABELS)[]).map((m) => (
                        <option key={m} value={m}>{t(BRACKET_MODE_LABELS[m])}</option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      style={{ width: 80 }}
                      disabled={b.mode === "exempt"}
                      value={b.rateBp === null || b.rateBp === undefined ? "" : bpToPercentText(b.rateBp)}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        setBracket(i, { rateBp: raw === "" ? null : percentToBp(Number(raw)) });
                      }}
                      placeholder={t("例如 3.5")}
                    />
                  </td>
                  <td>
                    {brackets.length > 1 && (
                      <button
                        className="small"
                        onClick={() => setBrackets((bs) => bs.filter((_, j) => j !== i))}
                      >
                        {t("移除")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="small" style={{ marginTop: 8 }} onClick={() => setBrackets((bs) => [...bs, { ...EMPTY_BRACKET }])}>
            {t("加一個級距")}
          </button>
          {/* 三種 mode 的算式說明，例子一律用中性數字 */}
          <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0 0" }}>
            <strong>{t("不課")}</strong>{t("：這一段的稅額是 0。")}<br />
            <strong>{t("全額課")}</strong>{t("：稅額 ＝ ")}<strong>{t("全額 × 費率")}</strong>{t("。例：某段設 3.5%，課稅基礎 10 萬 → 10 萬 × 3.5% ＝ 3,500。")}<br />
            <strong>{t("超額累進")}</strong>{t("：稅額 ＝ ")}<strong>{t("超過這一段起點的部分 × 費率")}</strong>{t("。例：某段是「10 萬以上、20%」，課稅基礎 30 萬 → (30 萬 − 10 萬) × 20% ＝ 40,000。")}<br />
            {t("金額剛好等於某一段的起點時，歸")}<strong>{t("較高")}</strong>{t("的那一段（＝「超過 X 者適用下一段」）。最高一段的「迄」請留空，否則超過上限的金額會算不出稅額。單一費率（例如營業稅率）就是「一段、無上限、全額課」。")}
          </p>
        </div>
      )}

      <form className="inline" style={{ marginTop: 10 }} onSubmit={(e) => e.preventDefault()}>
        <label className="field" style={{ flex: 1, minWidth: 320 }}>
          {t("依據來源（你查到的出處與查詢日期）")}
          <input
            value={sourceNote}
            onChange={(e) => setSourceNote(e.target.value)}
            placeholder={t("例如：依據 XXX 頁面，查詢日 2026-08-01")}
          />
        </label>
        <label className="field" style={{ maxWidth: 300 }}>
          <span>
            <input type="checkbox" checked={supersede} onChange={(e) => setSupersede(e.target.checked)} /> {t("接續前一列")}
          </span>
          <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
            {t("把同一種參數的前一列迄日設為生效起日的前一天")}
          </span>
        </label>
        <button className="primary" onClick={() => void submit()}>{t("新增這一列")}</button>
      </form>
      <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0 0" }}>
        <strong>{t("沒有「編輯」也沒有「刪除」")}</strong>
        {t("：舊列必須留著，否則去年那張單的稅額就再也解釋不出來。費率變動時請勾「接續前一列」——舊列只會被補上迄日，值與依據原封不動。如果某一列從第一天就填錯了，請新增一列從「更正生效日」起接續，並在依據來源寫明更正的是哪一列；")}
        <strong>{t("已依錯誤值建立的單據不會回頭重算")}</strong>{t("，需要更正的請自行判斷處理方式（沖銷重開或手工傳票）。")}
      </p>
    </div>
  );
}
