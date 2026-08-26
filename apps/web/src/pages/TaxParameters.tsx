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
import { BRACKET_MODE_LABELS, bpToPercentText, percentToBp } from "@tw-erp/core";
import { useState } from "react";
import { api } from "../api.ts";
import { fmt, useFetch } from "../hooks.ts";
import type { TaxBracket, TaxParameterList, TaxParameterRow } from "../types.ts";
import { EmptyState } from "../ui.tsx";

/** 我們自己會去讀的 kind 有白話名稱；使用者自訂的 kind 原樣顯示 */
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

function periodText(row: TaxParameterRow): string {
  return `${row.validFrom} ~ ${row.validTo ?? "（仍有效）"}`;
}

/** 值的白話顯示。null 與 0 的差別在這一頁一樣重要：沒有值的列根本存不進來（DB CHECK 擋著） */
function valueText(row: TaxParameterRow): string {
  if (row.boolValue !== null) return row.boolValue ? "是（可扣抵）" : "否（不可扣抵）";
  if (!row.brackets?.length) return "（沒有級距）";
  return row.brackets
    .map((b) => {
      const range = `${fmt(b.from)}${b.to === null ? " 以上" : `–${fmt(b.to)}`}`;
      if (b.mode === "exempt") return `${range}：不課`;
      const pct = b.rateBp === null || b.rateBp === undefined ? "？" : bpToPercentText(b.rateBp);
      return `${range}：${b.mode === "rate_on_total" ? "全額" : "超過起點的部分"} × ${pct}%`;
    })
    .join("；");
}

export function TaxParameters() {
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
        <h3>這一頁做什麼、不做什麼</h3>
        <p style={{ margin: "0 0 6px" }}>
          <strong>會做</strong>：把你<strong>自己查證到的</strong>稅法數值記下來——費率、級距、可否扣抵——
          並且記住它<strong>從哪一天到哪一天有效</strong>、你是<strong>照哪裡填的</strong>。
          其中兩種會被系統真的拿去算：<strong>營業稅率</strong>（每一張進貨／銷貨／報價／訂單／採購單／退回單的稅額，
          以及發票 XML 與 401 的 B2C 拆算）與<strong>報銷分類的可扣抵性</strong>（報銷核准要不要拆出 1288）。
        </p>
        <p style={{ margin: "0 0 6px" }}>
          <strong>不會做</strong>：系統<strong>不內建任何稅率、級距或免稅額度</strong>，也不判斷你填的數字對不對。
          尤其：<strong>本系統不計算營所稅，也不計算未分配盈餘加徵的稅</strong>——
          那兩種參數存在這裡，只是讓你把查到的規則（含生效期間與依據）記錄下來，
          <strong>實際申報仍須你自行計算與填報</strong>。存了參數不等於系統會幫你報稅。
          系統同樣<strong>不提示任何繳納或申報期限</strong>。
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>
          <strong>這張表只增不改</strong>：法規變了是「新增一列＋把舊列接續起來」，舊列的值與依據永遠留著。
          原因是<strong>舊年度必須算得回來</strong>——核定通知或更正申報可能兩三年後才來，
          那時要重算的是「當年那個費率下的數字」。也因此，
          <strong>補設或更新參數不會回頭重算已建立的單據</strong>。
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
            title="還沒有任何稅法參數"
            desc={
              "這裡放你自己查到的稅率與規則。最該先填的是「營業稅率」——" +
              "沒有涵蓋單據日期的設定時，系統會沿用一個既有的預設值並在每張單上提醒你（那個預設值不是本專案查證的結果）。" +
              "填的時候順手在「依據來源」寫下你是照哪個頁面、哪一天查的：明年這個數字若變了，你會需要知道當初的出處。"
            }
          />
        </div>
      ) : (
        kinds.map((kind) => (
          <div className="card" key={kind}>
            <h3>
              {KIND_LABELS[kind] ?? kind}
              <span style={{ fontSize: 12.5, color: "var(--text-2)", fontWeight: 400 }}> （kind: {kind}）</span>
            </h3>
            {KIND_USED_BY[kind] ? (
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-2)" }}>
                系統會拿它來算：{KIND_USED_BY[kind]}。
              </p>
            ) : (
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--amber)" }}>
                {recordOnly.has(kind)
                  ? "系統只保管這組規則，不會拿它計算任何東西——申報時請自行計算與填報。"
                  : "這是你自訂的參數，系統只保管、不會拿它計算任何東西。"}
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th>名稱</th>
                  <th>適用對象</th>
                  <th>生效期間</th>
                  <th>值</th>
                  <th>依據來源</th>
                  <th>誰填的／何時</th>
                  <th>狀態</th>
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
                      <td>{periodText(r)}</td>
                      <td>{valueText(r)}</td>
                      <td>
                        {r.sourceNote ?? (
                          <span style={{ color: "var(--amber)" }}>未註明依據來源</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12.5, color: "var(--text-2)" }}>
                        {r.enteredByName ?? "系統（首次啟動時建立）"}
                        <br />
                        {r.enteredAt.slice(0, 10)}
                      </td>
                      <td>
                        <span className={`badge ${r.status === "active" ? "issued" : "canceled"}`}>
                          {STATUS_LABEL[r.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0 0" }}>
              已失效的列<strong>刻意不隱藏</strong>：它就是「那一年是照什麼算的」的唯一紀錄。
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
      if (!effectiveKind) throw new Error("請選擇或輸入參數種類（kind）");
      if (!label.trim()) throw new Error("請給這一列一個看得懂的名稱（例如「營業稅率」）");
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
        `已新增第 #${created.id} 列` +
          (created.superseded
            ? `，並把第 #${created.superseded.id} 列的生效迄日設為 ${created.superseded.newValidTo}（該列的值與依據原封不動）。`
            : "。") +
          "提醒：這不會回頭重算已建立的單據。",
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
      <h3>新增一列（這張表只增不改）</h3>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          參數種類
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setShape(e.target.value === "input_tax_deductible" ? "bool" : "brackets");
            }}
          >
            <option value="vat">營業稅率（系統會拿去算）</option>
            <option value="input_tax_deductible">報銷分類：進項稅可否扣抵（系統會拿去算）</option>
            <option value="income_tax">營所稅級距（只記錄，系統不計算）</option>
            <option value="undistributed_earnings">未分配盈餘（只記錄，系統不計算）</option>
            {props.existingKinds
              .filter((k) => !KIND_LABELS[k])
              .map((k) => (
                <option key={k} value={k}>{k}（你自訂的）</option>
              ))}
            <option value="__custom">— 自訂一種 —</option>
          </select>
        </label>
        {kind === "__custom" && (
          <label className="field">
            自訂種類代號
            <input value={customKind} onChange={(e) => setCustomKind(e.target.value)} placeholder="例如 my_rule" />
          </label>
        )}
        <label className="field">
          適用對象（可留空）
          <input
            value={scopeKey}
            onChange={(e) => setScopeKey(e.target.value)}
            placeholder={kind === "input_tax_deductible" ? "費用科目代號，例如 6137" : "留空＝全公司一個值"}
          />
        </label>
        <label className="field">
          名稱
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：營業稅率" />
        </label>
        <label className="field">
          生效起日
          <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </label>
        <label className="field">
          生效迄日（留空＝仍有效）
          <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </label>
        <label className="field">
          值的形狀
          <select value={shape} onChange={(e) => setShape(e.target.value as "brackets" | "bool")}>
            <option value="brackets">級距／費率</option>
            <option value="bool">是／否</option>
          </select>
        </label>
      </form>

      {shape === "bool" ? (
        <div style={{ marginTop: 10 }}>
          <label className="field" style={{ maxWidth: 260 }}>
            值
            <select value={boolValue ? "1" : "0"} onChange={(e) => setBoolValue(e.target.value === "1")}>
              <option value="1">是</option>
              <option value="0">否</option>
            </select>
          </label>
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th className="num">起（含）</th>
                <th className="num">迄（含，留空＝無上限）</th>
                <th>計算方式</th>
                <th className="num">費率 %</th>
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
                        <option key={m} value={m}>{BRACKET_MODE_LABELS[m]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      style={{ width: 80 }}
                      disabled={b.mode === "exempt"}
                      value={b.rateBp === null || b.rateBp === undefined ? "" : bpToPercentText(b.rateBp)}
                      onChange={(e) => {
                        const t = e.target.value.trim();
                        setBracket(i, { rateBp: t === "" ? null : percentToBp(Number(t)) });
                      }}
                      placeholder="例如 3.5"
                    />
                  </td>
                  <td>
                    {brackets.length > 1 && (
                      <button
                        className="small"
                        onClick={() => setBrackets((bs) => bs.filter((_, j) => j !== i))}
                      >
                        移除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="small" style={{ marginTop: 8 }} onClick={() => setBrackets((bs) => [...bs, { ...EMPTY_BRACKET }])}>
            加一個級距
          </button>
          {/* 三種 mode 的算式說明，例子一律用中性數字 */}
          <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0 0" }}>
            <strong>不課</strong>：這一段的稅額是 0。<br />
            <strong>全額課</strong>：稅額 ＝ <strong>全額 × 費率</strong>。
            例：某段設 3.5%，課稅基礎 10 萬 → 10 萬 × 3.5% ＝ 3,500。<br />
            <strong>超額累進</strong>：稅額 ＝ <strong>超過這一段起點的部分 × 費率</strong>。
            例：某段是「10 萬以上、20%」，課稅基礎 30 萬 → (30 萬 − 10 萬) × 20% ＝ 40,000。<br />
            金額剛好等於某一段的起點時，歸<strong>較高</strong>的那一段（＝「超過 X 者適用下一段」）。
            最高一段的「迄」請留空，否則超過上限的金額會算不出稅額。
            單一費率（例如營業稅率）就是「一段、無上限、全額課」。
          </p>
        </div>
      )}

      <form className="inline" style={{ marginTop: 10 }} onSubmit={(e) => e.preventDefault()}>
        <label className="field" style={{ flex: 1, minWidth: 320 }}>
          依據來源（你查到的出處與查詢日期）
          <input
            value={sourceNote}
            onChange={(e) => setSourceNote(e.target.value)}
            placeholder="例如：依據 XXX 頁面，查詢日 2026-08-01"
          />
        </label>
        <label className="field" style={{ maxWidth: 300 }}>
          <span>
            <input type="checkbox" checked={supersede} onChange={(e) => setSupersede(e.target.checked)} /> 接續前一列
          </span>
          <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
            把同一種參數的前一列迄日設為生效起日的前一天
          </span>
        </label>
        <button className="primary" onClick={() => void submit()}>新增這一列</button>
      </form>
      <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0 0" }}>
        <strong>沒有「編輯」也沒有「刪除」</strong>：舊列必須留著，否則去年那張單的稅額就再也解釋不出來。
        費率變動時請勾「接續前一列」——舊列只會被補上迄日，值與依據原封不動。
        如果某一列從第一天就填錯了，請新增一列從「更正生效日」起接續，並在依據來源寫明更正的是哪一列；
        <strong>已依錯誤值建立的單據不會回頭重算</strong>，需要更正的請自行判斷處理方式（沖銷重開或手工傳票）。
      </p>
    </div>
  );
}
