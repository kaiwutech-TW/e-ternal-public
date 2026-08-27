import { useState } from "react";
import { api, downloadText } from "../api.ts";
import { useT } from "../i18n.ts";

interface ExportFile {
  name: string;
  content: string;
  rows: number;
}

interface EInvoiceXmlExport {
  invoiceCount: number;
  cancelCount: number;
  /** 折讓證明單 G0401（第二批）：依證明單日期歸期 */
  allowanceCount: number;
  /** 作廢折讓證明單 G0501（0030）：已作廢折讓單的作廢訊息，跟 G0401 同一期 */
  allowanceCancelCount: number;
  /** 該產卻產不出的折讓單（缺證明單號碼/日期、原發票已作廢…）——不靜默，逐條照登 */
  notes: string[];
  files: { name: string; content: string }[];
}

const KINDS = [
  { path: "journal", label: "傳票明細", note: "一列一分錄，含科目與摘要" },
  { path: "sales-invoices", label: "銷項發票", note: "本系統開立之電子發票（含作廢）" },
  { path: "purchases", label: "進項發票", note: "全部進貨單，未登錄發票者留空" },
  // R12：報銷是記帳士最常回頭要憑證的一塊（伙食、交際、差旅都是查核重點）
  { path: "expense-claims", label: "費用報銷明細", note: "一列一明細，含發票號碼、賣方統編、可扣抵稅額；已作廢的照列並標注" },
] as const;

export function Exports() {
  const t = useT();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // 折讓的出聲清單（缺證明單號碼等）：匯出成功也要顯示，漏一張＝申報時少一筆減項依據
  const [notes, setNotes] = useState<string[]>([]);

  const download = async (path: string) => {
    try {
      const file = await api.get<ExportFile>(`/exports/${path}?from=${from}&to=${to}`);
      downloadText(file.name, file.content);
      setError(null);
      setDone(t("已下載 {name}（{rows} 筆）", { name: file.name, rows: file.rows }));
    } catch (e) {
      setError((e as Error).message);
      setDone(null);
    }
  };

  /**
   * 電子發票 XML 批次（B5）：一張訊息一個 XML 檔、逐檔下載，不打包 zip
   * （Turnkey 的上傳目錄本來就吃逐檔；zip 要多一個依賴，拿到手還是得解開）。
   * 瀏覽器第一次會詢問「允許下載多個檔案」，允許後整批落地。
   */
  const downloadEInvoiceXml = async () => {
    try {
      const res = await api.get<EInvoiceXmlExport>(`/exports/einvoice-xml?from=${from}&to=${to}`);
      setNotes(res.notes ?? []);
      if (res.files.length === 0) {
        setError(null);
        setDone(t("此期間（{from} ～ {to}）沒有發票或折讓證明單可匯出。", { from, to }));
        return;
      }
      for (const f of res.files) downloadText(f.name, f.content);
      setError(null);
      setDone(
        t(
          "已下載 {n} 個 XML 檔（開立 F0401 {issued} 張、作廢 F0501 {canceled} 張、折讓 G0401 {allowance} 張、作廢折讓 G0501 {allowanceCanceled} 張）。檔名照 MIG 慣例，可直接放入 Turnkey 上傳目錄。",
          { n: res.files.length, issued: res.invoiceCount, canceled: res.cancelCount, allowance: res.allowanceCount, allowanceCanceled: res.allowanceCancelCount },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
      setDone(null);
    }
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="field">{t("起日")}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">{t("迄日")}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          {t("CSV 為 UTF-8 含 BOM，Excel 可直接開啟；金額為整數新台幣元。")}
        </p>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>{t("報表")}</th><th>{t("內容")}</th><th></th></tr>
          </thead>
          <tbody>
            {KINDS.map((k) => (
              <tr key={k.path}>
                <td>{t(k.label)}</td>
                <td>{t(k.note)}</td>
                <td><button className="small" onClick={() => download(k.path)}>{t("下載 CSV")}</button></td>
              </tr>
            ))}
            <tr>
              <td>{t("電子發票 XML")}</td>
              <td>{t("期間內全部發票的 F0401＋已作廢者的 F0501＋銷貨折讓的 G0401 與已作廢折讓的 G0501（依證明單日期歸期），逐檔下載（檔名照 MIG 慣例，供 Turnkey 上傳）")}</td>
              <td><button className="small" onClick={() => void downloadEInvoiceXml()}>{t("下載 XML")}</button></td>
            </tr>
          </tbody>
        </table>
        {done && <p style={{ fontSize: 13, color: "var(--green)" }}>{done}</p>}
        {notes.map((n, i) => (
          <p key={i} style={{ fontSize: 13, color: "var(--red)", margin: "4px 0 0" }}>{n}</p>
        ))}
      </div>
    </div>
  );
}
