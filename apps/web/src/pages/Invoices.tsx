import { useState } from "react";
import { api, downloadText } from "../api.ts";
import { useT } from "../i18n.ts";
import { buildEInvoiceQrPayloads, receiptBarcodeText } from "../einvoice-qr.ts";
import { fmt, useFetch, useListFetch } from "../hooks.ts";
import { ListFilterBar } from "../ui.tsx";
import { Code39, PrintOverlay, QrImg } from "../print.tsx";
import type { CompanyHeader, InvoiceRow, SaleDetail } from "../types.ts";

/** 期別文字：民國年＋雙月（例 2026-07-21 → 115年07-08月） */
function rocPeriodText(invoiceDate: string): string {
  const [y, m] = invoiceDate.split("-");
  const month = Number(m);
  const start = month - ((month - 1) % 2);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${Number(y) - 1911}年${two(start)}-${two(start + 1)}月`;
}

/**
 * 電子發票證明聯列印視圖（B5）：57mm 版面——店名、期別、號碼、日期、隨機碼、總計、
 * 買賣方統編、Code39 一維條碼、左右兩個 QR。QR 內容照 einvoice-qr.ts 的欄位配置反向產生；
 * 加密驗證區以佔位字元填入（正式驗真需大平台 QRCode 金鑰），螢幕上有提示、紙上不印那句。
 */
function ReceiptPrintView(props: {
  invoice: InvoiceRow;
  sale: SaleDetail;
  company: CompanyHeader;
  onClose: () => void;
}) {
  const t = useT();
  const { invoice: inv, sale, company } = props;
  // 左 QR 的銷售額欄位是**未稅**：B2B 的 salesAmount 本來就是未稅；
  // B2C 依 MIG 慣例存含稅總額，未稅取銷貨單的 subtotal（同一張單的落地數字，不重新拆算）
  const untaxed = inv.mode === "B2B" ? inv.salesAmount : sale.subtotal;
  const qr = buildEInvoiceQrPayloads({
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    randomNumber: inv.randomNumber,
    salesAmount: untaxed,
    totalAmount: inv.totalAmount,
    buyerTaxId: inv.buyerTaxId,
    sellerTaxId: company.taxId,
    items: sale.lines.map((l) => ({ name: l.productName, qty: Number(l.qty), unitPrice: Number(l.unitPrice) })),
  });
  const barcode = receiptBarcodeText(inv.invoiceNumber, inv.invoiceDate, inv.randomNumber);
  return (
    <PrintOverlay
      size="receipt"
      onClose={props.onClose}
      screenNote={t("此證明聯的左側 QR 加密驗證區（24 碼）目前以佔位字元填入：正式驗真值需以財政部大平台核發的 QRCode 專用金鑰產生，本系統尚未申請。號碼、日期、金額、統編等明碼欄位皆可正常掃描核對。")}
    >
      <div className="r-store">{company.name}</div>
      <div className="r-title">{t("電子發票證明聯")}</div>
      <div className="r-period">{rocPeriodText(inv.invoiceDate)}</div>
      <div className="r-no">{inv.invoiceNumber.slice(0, 2)}-{inv.invoiceNumber.slice(2)}</div>
      <div className="r-line">{t("{date}　隨機碼 {random}　總計 {total}", { date: inv.invoiceDate, random: inv.randomNumber, total: fmt(inv.totalAmount) })}</div>
      <div className="r-line">
        {t("賣方 {taxId}", { taxId: company.taxId })}
        {inv.buyerTaxId ? t("　買方 {taxId}", { taxId: inv.buyerTaxId }) : ""}
      </div>
      <Code39 value={barcode} height={26} />
      <div className="r-qrs">
        <QrImg text={qr.left} size={80} />
        <QrImg text={qr.right} size={80} />
      </div>
    </PrintOverlay>
  );
}

export function Invoices() {
  const t = useT();
  // 清單篩選（R3）：日期範圍（發票日期）；買受人請用統編欄目視——發票沒有 partnerId
  const [filterQ, setFilterQ] = useState("");
  const invoices = useListFetch<InvoiceRow[]>(`/invoices${filterQ ? `?${filterQ}` : ""}`);
  const company = useFetch<CompanyHeader>("/company-profile");
  const [error, setError] = useState<string | null>(null);
  const [xmlView, setXmlView] = useState<{ title: string; xml: string } | null>(null);
  const [cancelingId, setCancelingId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [receipt, setReceipt] = useState<{ invoice: InvoiceRow; sale: SaleDetail } | null>(null);

  /** reverse＝連動沖銷來源單據：銷貨發票沖銷貨單（reverseSale）、處分發票沖回處分（reverseDisposal） */
  const cancel = async (inv: InvoiceRow, reverse: boolean) => {
    if (!reason.trim()) {
      setError(t("請填寫作廢原因"));
      return;
    }
    try {
      await api.post(`/invoices/${inv.id}/cancel`, {
        reason: reason.trim(),
        ...(inv.saleId ? { reverseSale: reverse } : { reverseDisposal: reverse }),
      });
      setError(null);
      setCancelingId(null);
      setReason("");
      invoices.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 證明聯要銷貨單明細（B2C 未稅額與品項給 QR 用），按下時才抓 */
  const openReceipt = async (inv: InvoiceRow) => {
    try {
      if (!company.data) throw new Error(t("公司基本檔未設定，證明聯缺賣方統編——請先到「設定」頁填寫"));
      if (inv.saleId === null) throw new Error(t("處分發票沒有銷貨單明細，無法產生證明聯——請以 XML 為準"));
      setReceipt({ invoice: inv, sale: await api.get<SaleDetail>(`/sales/${inv.saleId}`) });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * XML 按需抓單張端點（清單瘦身後 GET /invoices 刻意不含 xml/cancelXml）：
   * kind=cancel 走 /cancel-xml（F0501）。檢視與下載共用這一支。
   */
  const fetchXml = (inv: InvoiceRow, kind: "issue" | "cancel") =>
    api.getText(`/invoices/${inv.id}/${kind === "cancel" ? "cancel-xml" : "xml"}`);
  const viewXml = async (inv: InvoiceRow, kind: "issue" | "cancel") => {
    try {
      setXmlView({ title: `${inv.invoiceNumber} ${kind === "cancel" ? "F0501" : "F0401"}`, xml: await fetchXml(inv, kind) });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const downloadXml = async (inv: InvoiceRow, kind: "issue" | "cancel") => {
    try {
      // 檔名照 MIG 官方範例慣例（F0401-發票號碼.xml）：拿去 Turnkey 上傳不用改名
      downloadText(`${kind === "cancel" ? "F0501" : "F0401"}-${inv.invoiceNumber}.xml`, await fetchXml(inv, kind));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 載具／捐贈欄：落地欄位（0029）直接畫；null＝0029 前的舊發票（值只在 XML 裡） */
  const carrierText = (inv: InvoiceRow) => {
    if (inv.donateMark === "1") return t("捐贈 {code}", { code: inv.npoban ?? "" }).trim();
    if (inv.carrierType) return `${inv.carrierType === "3J0002" ? t("手機條碼") : inv.carrierType === "CQ0001" ? t("自然人憑證") : inv.carrierType} ${inv.carrierId ?? ""}`.trim();
    return "—";
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <ListFilterBar onApply={setFilterQ} total={invoices.total} shown={invoices.data?.length ?? 0} />
        <table>
          <thead>
            <tr><th>{t("發票號碼")}</th><th>{t("日期")}</th><th>{t("類型")}</th><th title={t("銷貨＝對銷貨單開立；處分＝對固定資產處分開立（0034）")}>{t("來源")}</th><th>{t("課稅別")}</th><th>{t("買受人")}</th><th title={t("B2C 的載具或捐贈碼（開立當下的快照）；「—」＝無載具（紙本證明聯）或 0029 前的舊發票")}>{t("載具／捐贈")}</th><th className="num">{t("總額")}</th><th>{t("狀態")}</th><th></th></tr>
          </thead>
          <tbody>
            {invoices.data?.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.invoiceNumber}</td>
                <td>{inv.invoiceDate}</td>
                <td>{inv.mode}</td>
                <td>{inv.saleId ? t("銷貨 #{id}", { id: inv.saleId }) : t("處分資產 #{id}", { id: inv.assetId })}</td>
                {/* 課稅別（0028）：開立當下的快照。零稅率＝稅額 0、金額在 ZeroTaxSalesAmount */}
                <td>{inv.taxType === "2" ? <span className="badge">{t("零稅率")}</span> : t("應稅")}</td>
                <td>{inv.buyerName}</td>
                <td>{carrierText(inv)}</td>
                <td className="num">{fmt(inv.totalAmount)}</td>
                <td><span className={`badge ${inv.status}`}>{inv.status === "issued" ? t("已開立") : t("已作廢")}</span></td>
                <td>
                  <button className="small" onClick={() => void viewXml(inv, "issue")}>
                    XML
                  </button>{" "}
                  <button className="small" onClick={() => void downloadXml(inv, "issue")}>
                    {t("下載 XML")}
                  </button>{" "}
                  {inv.status === "canceled" && (
                    <>
                      <button className="small" onClick={() => void viewXml(inv, "cancel")}>
                        {t("作廢 XML")}
                      </button>{" "}
                      <button className="small" onClick={() => void downloadXml(inv, "cancel")}>
                        {t("下載作廢 XML")}
                      </button>{" "}
                    </>
                  )}
                  {/* 證明聯的品項與未稅額取自銷貨單明細——處分發票沒有銷貨單，證明聯請以 XML 為準 */}
                  {inv.status === "issued" && inv.saleId !== null && (
                    <>
                      <button className="small" onClick={() => void openReceipt(inv)}>{t("證明聯")}</button>{" "}
                    </>
                  )}
                  {inv.status === "issued" && cancelingId !== inv.id && (
                    <button className="small" onClick={() => { setCancelingId(inv.id); setReason(""); }}>{t("作廢")}</button>
                  )}
                  {cancelingId === inv.id && (
                    <>
                      <input
                        autoFocus
                        placeholder={t("作廢原因")}
                        style={{ width: 140 }}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />{" "}
                      <button className="small" onClick={() => cancel(inv, true)}>
                        {inv.saleId ? t("作廢並沖銷銷貨單") : t("作廢並沖回處分")}
                      </button>{" "}
                      <button className="small" onClick={() => cancel(inv, false)}>{t("僅作廢（將重開發票）")}</button>{" "}
                      <button className="small" onClick={() => setCancelingId(null)}>{t("取消")}</button>
                      {/* 作廢與退貨是兩件事，但在日常語感裡「作廢」「沖銷」幾乎同義——這裡直接把岔路寫出來，
                          否則使用者會拿作廢去處理退貨，把上一期已申報的數字改掉 */}
                      {inv.saleId ? (
                        <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4 }}>
                          {t("這張發票開錯了（金額打錯、統編錯）且還拿得回來 → 用這裡：沖銷＝迴轉傳票＋庫存退回；僅作廢則不動帳，須至銷貨頁重開發票。")}
                          <br />
                          <strong>{t("貨已經出去、客戶要退貨或要折價")}</strong>{t(" → 不要用作廢，請到「銷貨」頁對那張銷貨單按「退貨／折讓」，以退貨當期入帳。")}
                          <strong>{t("發票日期所屬月份已關帳時作廢會被擋下")}</strong>
                          {t("（作廢改的是那一期、可能已申報的銷項數字），此時唯一的路就是開退貨／折讓單。")}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4 }}>
                          {t("處分發票：「沖回處分」＝反向傳票沖回處分損益／累計折舊／銷項稅額，資產回到使用中（處分本身是誤操作時用）。僅作廢＝發票開錯、處分沒錯——帳不動，請至「資產」頁對這筆處分重開發票，否則 2288 銷項稅額不會進 401。")}
                        </div>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {xmlView && (
        <div className="card">
          <h3>{xmlView.title} <button className="small" onClick={() => setXmlView(null)}>{t("關閉")}</button></h3>
          <pre className="xml">{xmlView.xml}</pre>
        </div>
      )}
      {receipt && company.data && (
        <ReceiptPrintView
          invoice={receipt.invoice}
          sale={receipt.sale}
          company={company.data}
          onClose={() => setReceipt(null)}
        />
      )}
    </div>
  );
}
