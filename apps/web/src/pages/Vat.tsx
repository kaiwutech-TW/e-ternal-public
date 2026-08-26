import { useState } from "react";
import { api, downloadText } from "../api.ts";
import { fmt, useFetch } from "../hooks.ts";
import type { Vat401, VatFiling } from "../types.ts";

const DEDUCTION_LABEL: Record<string, string> = {
  "3": "進貨或費用（不可扣抵）",
  "4": "固定資產（不可扣抵）",
};

export function Vat() {
  const now = new Date();
  const oddMonth = now.getMonth() + 1 - (now.getMonth() % 2); // 本期奇數起始月
  const [period, setPeriod] = useState(`${now.getFullYear()}${String(oddMonth).padStart(2, "0")}`);
  // 上期留抵的人工覆寫：空字串＝交給系統（自動承轉上期申報紀錄，找不到就 0 並出聲）
  const [prevOverride, setPrevOverride] = useState("");
  const [result, setResult] = useState<Vat401 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const filings = useFetch<VatFiling[]>("/vat-returns/401/filings");

  const generate = async () => {
    try {
      const qs = prevOverride.trim() ? `&prevCarryForward=${prevOverride.trim()}` : "";
      setResult(await api.get<Vat401>(`/vat-returns/401?period=${period}${qs}`));
      setError(null);
      setOk(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const fileReturn = async () => {
    if (!result) return;
    try {
      await api.post("/vat-returns/401/file", {
        period: result.period,
        ...(prevOverride.trim() ? { prevCarryForward: Number(prevOverride.trim()) } : {}),
      });
      setOk(`期別 ${result.period} 的申報結果已存檔——下一期產出時會自動帶入期末留抵 ${fmt(result.summary.carryForward)} 元`);
      setError(null);
      filings.reload();
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  const deleteFiling = async (p: string) => {
    try {
      await api.delete(`/vat-returns/401/filings/${p}`);
      setError(null);
      filings.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const returnsTotal = result
    ? result.returnsNotReflected.sales.count + result.returnsNotReflected.purchases.count
    : 0;
  const deductedTotal = result
    ? result.returnsInFiling.sales.count +
      result.returnsInFiling.purchases.expense.count +
      result.returnsInFiling.purchases.fixedAsset.count
    : 0;
  const filed = result ? (filings.data ?? []).some((f) => f.period === result.period) : false;

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
      <div className="card">
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void generate(); }}>
          <label className="field">期別（YYYYMM，奇數月）<input value={period} onChange={(e) => setPeriod(e.target.value)} maxLength={6} /></label>
          <label className="field">
            上期累積留抵（留空＝自動承轉）
            <input
              value={prevOverride}
              onChange={(e) => setPrevOverride(e.target.value)}
              placeholder="自動"
              inputMode="numeric"
              style={{ width: 150 }}
              title="留空時自動帶入上一期申報紀錄的期末留抵；第一次申報或從舊系統轉入有留抵時在此輸入"
            />
          </label>
          <button className="primary">產出申報檔</button>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          銷項＝本期開立之電子發票（作廢以課稅別 F 申報）；進項＝已登錄供應商發票之進貨單
          （扣抵代號不可扣抵者只進媒體檔明細）；退回折讓＝已登錄證明單號碼者列入減項。
          產出後請以財政部電子申報繳稅軟體匯入驗證。
        </p>
      </div>

      {/* 稅法參數的警告（B2C 拆算走了回退費率）：這份檔案是拿去繳稅的，不能靜默 */}
      {result && (result.parameterNotes?.length ?? 0) > 0 && (
        <div className="notice">
          {result.parameterNotes!.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}

      {/* 留抵承轉、申報人、進項歸期退回（R20）的提醒：第一次申報預設 0、承轉斷鏈、
          申報人未填、沒登發票日期以進貨單日期歸期——都要出聲 */}
      {result &&
        (result.carryover.notes.length > 0 ||
          result.filer.notes.length > 0 ||
          (result.inputDateFallback?.notes.length ?? 0) > 0) && (
        <div className="notice">
          {[...result.carryover.notes, ...result.filer.notes, ...(result.inputDateFallback?.notes ?? [])].map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}

      {result && returnsTotal > 0 && (
        /*
          缺證明單的退回／折讓「不在減項裡」必須擋在數字前面講：會計會照著這張申報書繳稅。
          沒有這類單時整個區塊不出現——常態下多一句警告等於雜訊，真的出事時就沒人看了。
        */
        <div
          className="card"
          style={{ borderLeft: "4px solid var(--red)", background: "var(--red-tint)" }}
          role="alert"
        >
          <h3 style={{ color: "var(--red)", margin: "0 0 6px" }}>
            本期有退回／折讓還沒登錄證明單號碼，這些減項<u>沒有</u>列入申報檔
          </h3>
          <p style={{ margin: "0 0 6px" }}>
            {result.returnsNotReflected.sales.count > 0 && (
              <>
                <strong>銷貨退回／折讓 {result.returnsNotReflected.sales.count} 筆</strong>
                （銷售額 {fmt(result.returnsNotReflected.sales.subtotal)} 元、
                稅額 {fmt(result.returnsNotReflected.sales.tax)} 元）——銷項因此偏高＝多繳
              </>
            )}
            {result.returnsNotReflected.sales.count > 0 && result.returnsNotReflected.purchases.count > 0 && "；"}
            {result.returnsNotReflected.purchases.count > 0 && (
              <>
                <strong>進貨退出／折讓 {result.returnsNotReflected.purchases.count} 筆</strong>
                （金額 {fmt(result.returnsNotReflected.purchases.subtotal)} 元、
                稅額 {fmt(result.returnsNotReflected.purchases.tax)} 元）——進項未扣減
              </>
            )}
            。
          </p>
          <p style={{ margin: 0 }}>
            下一步：證明單需另行以財政部軟體或加值中心平台開立（本系統不產生），
            開好後到「銷貨」「進貨」頁的退回紀錄按<strong>「補登證明單」</strong>填入號碼與日期，
            再回到本頁重新產出，減項就會列入（歸期依證明單日期）。
          </p>
        </div>
      )}

      {result && (result.zeroRate.total !== 0 || result.zeroRate.missingCert.count > 0) && (
        /* 零稅率（0028，B12）：金額分欄與三種提醒（缺證明文件／退稅欄不計算／通關方式註記未填）。
           沒有零稅率銷售時整個區塊不出現——常態下多一句警告等於雜訊 */
        <div className="card">
          <h3>零稅率銷售額（已列入申報書代號 7／15／19／23）</h3>
          <p style={{ margin: "0 0 6px" }}>
            非經海關 {fmt(result.zeroRate.nonCustoms)} 元；經海關出口 {fmt(result.zeroRate.customs)} 元；
            退回折讓 {fmt(result.zeroRate.returns)} 元；合計 <strong>{fmt(result.zeroRate.total)}</strong> 元
            （已計入銷售額總計，稅額 0）。
          </p>
          {result.zeroRate.notes.map((n) => (
            <p key={n} style={{ margin: "0 0 4px", fontSize: 13, color: "var(--red)" }}>{n}</p>
          ))}
          {result.zeroRate.missingCert.count > 0 && (
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr><th>銷貨單</th><th>日期</th><th>依據類別</th><th className="num">銷售額</th></tr>
              </thead>
              <tbody>
                {result.zeroRate.missingCert.items.map((i) => (
                  <tr key={i.saleId}>
                    <td>#{i.saleId}</td>
                    <td>{i.docDate}</td>
                    <td>{i.viaCustoms ? "經海關（缺出口報單號碼）" : "非經海關（缺外匯證明等文件號碼）"}</td>
                    <td className="num">{fmt(i.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {result && (
        <>
          <div className="stat-row">
            {(["銷項銷售額", "銷項稅額", "得扣抵進項稅額", "上期累積留抵", "本期應實繳"] as const).map((label, i) => (
              <div className="stat" key={label}>
                <div className="label">{label}</div>
                <div className="value">
                  {fmt([
                    result.summary.salesTotal,
                    result.summary.outputTaxTotal,
                    result.summary.deductibleInputTaxTotal,
                    result.carryover.prevCarryForward,
                    result.summary.payable,
                  ][i]!)}
                </div>
              </div>
            ))}
            <div className="stat"><div className="label">期末累積留抵</div><div className="value">{fmt(result.summary.carryForward)}</div></div>
          </div>

          {/* 留抵承轉來源：這個數字直接改變應實繳，來源要可追 */}
          <p style={{ fontSize: 13, color: "var(--text-2)", margin: "4px 0 12px" }}>
            上期累積留抵（{result.carryover.prevPeriod} 期）來源：
            {result.carryover.source === "manual" && "手動輸入"}
            {result.carryover.source === "filed" && "自動承轉自上期申報紀錄"}
            {result.carryover.source === "none" && "無上期申報紀錄，以 0 帶入"}
            。申報人：
            {result.filer.name
              ? `${result.filer.name}${result.filer.hasIdNo ? "" : "（身分證號未填）"}`
              : "未設定"}
            ｜{result.filer.selfFiled ? "自行申報" : `委託申報（記帳士登錄字號 ${result.filer.agentNo}）`}
          </p>

          {deductedTotal > 0 && (
            <div className="card">
              <h3>已列入減項的退回／折讓（依證明單歸期）</h3>
              <p style={{ margin: "0 0 6px" }}>
                {result.returnsInFiling.sales.count > 0 && (
                  <>銷項退回及折讓 {result.returnsInFiling.sales.count} 筆
                  （{fmt(result.returnsInFiling.sales.amount)} 元、稅 {fmt(result.returnsInFiling.sales.tax)} 元）</>
                )}
                {result.returnsInFiling.sales.count > 0 &&
                  result.returnsInFiling.purchases.expense.count + result.returnsInFiling.purchases.fixedAsset.count > 0 && "；"}
                {result.returnsInFiling.purchases.expense.count > 0 && (
                  <>進項退出折讓（進貨費用）{result.returnsInFiling.purchases.expense.count} 筆
                  （{fmt(result.returnsInFiling.purchases.expense.amount)} 元、稅 {fmt(result.returnsInFiling.purchases.expense.tax)} 元）</>
                )}
                {result.returnsInFiling.purchases.fixedAsset.count > 0 && (
                  <>；進項退出折讓（固資）{result.returnsInFiling.purchases.fixedAsset.count} 筆
                  （{fmt(result.returnsInFiling.purchases.fixedAsset.amount)} 元、稅 {fmt(result.returnsInFiling.purchases.fixedAsset.tax)} 元）</>
                )}
              </p>
              {result.returnsInFiling.note && (
                <p style={{ margin: 0, fontSize: 13, color: "var(--red)" }}>{result.returnsInFiling.note}</p>
              )}
            </div>
          )}

          {result.nonDeductible.count > 0 && (
            <div className="card">
              <h3>不可扣抵進項（只申報明細，不計入可扣抵稅額）</h3>
              <p style={{ fontSize: 13, color: "var(--text-2)", margin: "0 0 8px" }}>
                下列進貨單的用途登錄為「不可扣抵」（扣抵代號 3/4）：進項稅額共 {fmt(result.nonDeductible.tax)} 元
                不會出現在申報書的可扣抵欄位，只寫入媒體檔明細。若其中有登錄錯的，
                到「進貨」頁按「改發票資訊」修正後重新產出。
              </p>
              <table>
                <thead>
                  <tr><th>進貨單</th><th>日期</th><th>發票號碼</th><th>用途</th><th className="num">未稅</th><th className="num">稅額</th></tr>
                </thead>
                <tbody>
                  {result.nonDeductible.items.map((i) => (
                    <tr key={i.purchaseId}>
                      <td>#{i.purchaseId}</td>
                      <td>{i.docDate}</td>
                      <td>{i.invoice}</td>
                      <td>{DEDUCTION_LABEL[i.deductionCode] ?? i.deductionCode}</td>
                      <td className="num">{fmt(i.amount)}</td>
                      <td className="num">{fmt(i.tax)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <h3>申報檔（所屬年月 民國 {result.rocPeriod.slice(0, 3)} 年 {result.rocPeriod.slice(3)} 月）</h3>
            <p>
              進銷項媒體檔（附件五，81 Bytes × {result.mediaFile.records} 筆）：
              <button className="small" onClick={() => downloadText(result.mediaFile.name, result.mediaFile.content)}>
                下載 {result.mediaFile.name}
              </button>
            </p>
            <p>
              申報書檔（附件六，112 欄）：
              <button className="small" onClick={() => downloadText(result.returnFile.name, result.returnFile.content)}>
                下載 {result.returnFile.name}
              </button>
            </p>
            <p style={{ marginBottom: 0 }}>
              {filed ? (
                <span style={{ fontSize: 13, color: "var(--text-2)" }}>本期已有申報紀錄（見下方清單）。更正申報請先刪除該期紀錄再重存。</span>
              ) : (
                <>
                  <button className="primary" onClick={() => void fileReturn()}>存為申報紀錄（下期自動承轉留抵）</button>{" "}
                  <span style={{ fontSize: 13, color: "var(--text-2)" }}>
                    向國稅局完成申報後再按——存的是「當時申報的數字」，下一期的上期留抵以它為準。
                  </span>
                </>
              )}
            </p>
          </div>
        </>
      )}

      {(filings.data?.length ?? 0) > 0 && (
        <div className="card">
          <h3>401 申報紀錄（留抵承轉的依據；只能刪最新一期）</h3>
          <table>
            <thead>
              <tr>
                <th>期別</th><th className="num">銷項銷售額</th><th className="num">銷項稅額</th>
                <th className="num">得扣抵進項稅額</th><th className="num">上期留抵</th>
                <th className="num">應實繳</th><th className="num">期末留抵</th><th>存檔時間</th><th />
              </tr>
            </thead>
            <tbody>
              {filings.data!.map((f, idx) => (
                <tr key={f.id}>
                  <td>{f.period}</td>
                  <td className="num">{fmt(f.outputSales)}</td>
                  <td className="num">{fmt(f.outputTax)}</td>
                  <td className="num">{fmt(f.deductibleInputTax)}</td>
                  <td className="num">{fmt(f.prevCarryForward)}</td>
                  <td className="num">{fmt(f.payable)}</td>
                  <td className="num">{fmt(f.carryForward)}</td>
                  <td>{f.createdAt.slice(0, 10)}</td>
                  <td>
                    {idx === 0 && (
                      <button
                        className="small"
                        title="更正申報用：刪掉最新一期的紀錄後重新產出、重新存檔"
                        onClick={() => void deleteFiling(f.period)}
                      >
                        刪除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
