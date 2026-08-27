import { Fragment, useState } from "react";
import { api, downloadText } from "../api.ts";
import { useAuth } from "../auth.ts";
import { fmt, useFetch, useListFetch } from "../hooks.ts";
import { useT } from "../i18n.ts";
import { CompanyHeaderBlock, PrintOverlay } from "../print.tsx";
import { EmptyState, ListFilterBar, TaxNotes, pickTaxNotes } from "../ui.tsx";
import type { Account, ArAging, CompanyHeader, DocRow, InvoiceRow, Partner, Product, ReturnRow, SaleDetail } from "../types.ts";
import { DocForm } from "./DocForm.tsx";
import { CertCell, ReturnForm } from "./ReturnForm.tsx";

/**
 * 出貨單（銷貨單）列印視圖（B5）：給倉庫備貨、司機送貨、客戶簽收的那張紙。
 * 資料一次從 GET /sales/:id 取齊（單頭＋明細＋客戶抬頭），公司抬頭取 /company-profile。
 */
function SalePrintView(props: { sale: SaleDetail; company: CompanyHeader | null; onClose: () => void }) {
  const t = useT();
  const { sale } = props;
  const p = sale.partner;
  return (
    <PrintOverlay onClose={props.onClose}>
      <CompanyHeaderBlock company={props.company} docTitle={t("出貨單（銷貨單）")} />
      <div className="meta-row">
        <div>
          {t("客戶：{name}", { name: p?.name ?? sale.partnerName })}
          {p?.taxId ? t("（統編 {taxId}）", { taxId: p.taxId }) : ""}
          {p?.contactPerson ? t("　聯絡人 {name}", { name: p.contactPerson }) : ""}
          {p?.phone ? t("　電話 {phone}", { phone: p.phone }) : ""}
        </div>
        <div>{t("單號：#{id}", { id: sale.id })}</div>
      </div>
      <div className="meta-row">
        <div>{t("送貨地址：{address}", { address: p?.shipToAddress ?? p?.address ?? "＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿" })}</div>
        <div>{t("出貨日期：{date}", { date: sale.docDate })}{sale.dueDate ? t("　收款到期：{date}", { date: sale.dueDate }) : ""}</div>
      </div>
      <table>
        <thead>
          <tr><th>{t("品名")}</th><th>{t("編號")}</th><th className="num">{t("數量")}</th><th>{t("單位")}</th><th className="num">{t("單價（未稅）")}</th><th className="num">{t("金額")}</th></tr>
        </thead>
        <tbody>
          {sale.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.productName}</td>
              <td>{l.sku}</td>
              <td className="num">{Number(l.qty).toLocaleString("zh-TW")}</td>
              <td>{l.unit}</td>
              <td className="num">{Number(l.unitPrice).toLocaleString("zh-TW")}</td>
              <td className="num">{fmt(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="totals">
        <div>
          {t("未稅合計：{subtotal} 元　營業稅：{tax} 元", { subtotal: fmt(sale.subtotal), tax: fmt(sale.tax) })}
          {sale.taxType === "2" &&
            t("（零稅率・{via}{cert}）", {
              via: sale.zeroTaxViaCustoms ? t("經海關出口") : t("非經海關"),
              cert: sale.zeroTaxCertNo ? t("・證明文件 {certNo}", { certNo: sale.zeroTaxCertNo }) : "",
            })}
        </div>
        <div className="grand">{t("總計：{total} 元", { total: fmt(sale.total) })}</div>
      </div>
      <div className="sign-row">
        <div className="sign-box">{t("出貨人簽章")}</div>
        <div className="sign-box">{t("送貨人簽章")}</div>
        <div className="sign-box">{t("客戶簽收（請核對品項數量）")}</div>
      </div>
      <div className="foot-note">{t("本單為出貨與簽收憑據；發票另行開立。金額為整數新台幣元。")}</div>
    </PrintOverlay>
  );
}

export function Sales() {
  const t = useT();
  // 作廢限財務／管理者（auth.ts RULES）：業務角色不顯示按鈕——顯示一個按了必 403 的鍵是誘導
  const canVoid = ["admin", "finance"].includes(useAuth().role);
  const partners = useFetch<Partner[]>("/partners");
  const products = useFetch<Product[]>("/products");
  // 清單篩選（R3）：日期範圍＋客戶，預設只回最新 200 筆（總數看 X-Total-Count）
  const [filterQ, setFilterQ] = useState("");
  const docs = useListFetch<DocRow[]>(`/sales${filterQ ? `?${filterQ}` : ""}`);
  // 發票清單是「銷貨單 → 發票」的對照來源：跟著同一組日期範圍走、上限拉到 500——
  // 若只拿預設 200 筆，篩到較舊的銷貨單時會查不到它的發票而誤顯示「開 B2B/B2C」按鈕
  const invoiceQ = (() => {
    const fq = new URLSearchParams(filterQ);
    const q = new URLSearchParams({ limit: "500" });
    const from = fq.get("from");
    const to = fq.get("to");
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    return q.toString();
  })();
  const invoices = useFetch<InvoiceRow[]>(`/invoices?${invoiceQ}`);
  const accounts = useFetch<Account[]>("/accounts");
  const returns = useFetch<ReturnRow[]>("/sales-returns");
  // 「哪些退回還缺證明單」要查得到：只在表格裡顯示「—」等於沒有追蹤能力，
  // 而證明單要自己去外面開，漏一張就是申報時少一筆減項的依據。
  // 已作廢的單（0030）不追：它不進 401 減項，不需要證明單
  const [certOnly, setCertOnly] = useState(false);
  const missingCert = (returns.data ?? []).filter((r) => !r.certNo && !r.voidedAt);
  const [returningId, setReturningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 列印視圖（B5）：按「列印」時才抓單筆明細，公司抬頭供任何登入者讀取
  const company = useFetch<CompanyHeader>("/company-profile");
  const [printSale, setPrintSale] = useState<SaleDetail | null>(null);
  const openPrint = async (id: number) => {
    try {
      setPrintSale(await api.get<SaleDetail>(`/sales/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // 稅率回退警告：開發票（B2C 拆算）與退回單都吃營業稅率
  const [taxNotes, setTaxNotes] = useState<string[]>([]);
  const [agingAsOf, setAgingAsOf] = useState(new Date().toISOString().slice(0, 10));
  const aging = useFetch<ArAging>(`/reports/ar-aging?asOf=${agingAsOf}`);

  // 每張銷貨單的累計已退（含折讓）：直接顯示在列上，財務不必翻退回紀錄就看得出這張單被退過。
  // 已作廢退回單（0030）不算——它的迴轉效果已被反向傳票收回，與伺服端 returnable 同口徑
  const returnedOf = (saleId: number) =>
    (returns.data ?? [])
      .filter((r) => r.saleId === saleId && !r.voidedAt)
      .reduce((s, r) => ({ count: s.count + 1, net: s.net + r.subtotal }), { count: 0, net: 0 });

  // 作廢後可重開：同一銷貨單可能多張發票，顯示 issued 那張，否則最後一張作廢的
  const invoiceOf = (saleId: number) => {
    const list = invoices.data?.filter((i) => i.saleId === saleId) ?? [];
    return list.find((i) => i.status === "issued") ?? list[list.length - 1];
  };

  const issue = async (saleId: number, mode: "B2B" | "B2C", extra?: Record<string, unknown>) => {
    try {
      setTaxNotes(pickTaxNotes(await api.post(`/sales/${saleId}/invoice`, { mode, ...(extra ?? {}) })));
      setError(null);
      setIssuingB2CId(null);
      invoices.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * B2C 面板（0029，B5 尾款）：載具／捐贈碼在開立當下就要進 XML，事後補不了——
   * 原本按鈕直接送 { mode:"B2C" }，消費者說「存手機條碼」店員在畫面上無處可填。
   * 「無」＝維持現行預設（紙本證明聯）。載具類別以 MIG 代號送出：3J0002 手機條碼、
   * CQ0001 自然人憑證；其他載具類別可切「自訂」手填代號。
   */
  const [issuingB2CId, setIssuingB2CId] = useState<number | null>(null);
  const [b2cKind, setB2cKind] = useState<"none" | "3J0002" | "CQ0001" | "custom" | "donate">("none");
  const [b2cCarrierType, setB2cCarrierType] = useState("");
  const [b2cCarrierId, setB2cCarrierId] = useState("");
  const [b2cNpoban, setB2cNpoban] = useState("");
  const startIssueB2C = (saleId: number) => {
    setIssuingB2CId(saleId);
    setB2cKind("none");
    setB2cCarrierType("");
    setB2cCarrierId("");
    setB2cNpoban("");
    setError(null);
  };
  const confirmIssueB2C = (saleId: number) => {
    if (b2cKind === "donate") {
      if (!b2cNpoban.trim()) {
        setError(t("捐贈發票要填受贈機構的捐贈碼（愛心碼）——向對方或財政部愛心碼查詢平台取得"));
        return;
      }
      return void issue(saleId, "B2C", { donateMark: "1", npoban: b2cNpoban.trim() });
    }
    if (b2cKind !== "none") {
      const type = b2cKind === "custom" ? b2cCarrierType.trim() : b2cKind;
      const id = b2cCarrierId.trim();
      if (!type || !id) {
        setError(t("載具要填類別與號碼（手機條碼載具請輸入 / 開頭的條碼）"));
        return;
      }
      return void issue(saleId, "B2C", { carrier: { type, id1: id, id2: id } });
    }
    return void issue(saleId, "B2C");
  };

  // 零稅率缺證明文件（0028，B12）：出口報單／外匯證明幾乎一定在建單後才拿到，
  // 要主動報數字並給補登入口——申報零稅率銷售額需以證明文件為依據，漏一張就是申報缺依據
  const zeroMissingCert = (docs.data ?? []).filter(
    (d) => d.taxType === "2" && !d.zeroTaxCertNo && !d.reversalEntryId,
  );
  const backfillZeroCert = async (d: DocRow) => {
    const label = d.zeroTaxViaCustoms ? t("出口報單號碼") : t("外匯證明等文件號碼");
    const certNo = window.prompt(
      t("銷貨單 #{id} 是零稅率（{via}）。", { id: d.id, via: d.zeroTaxViaCustoms ? t("經海關出口") : t("非經海關") }) + "\n" +
        t("請輸入{label}（系統只登錄號碼，不驗證文件內容）：", { label }),
      d.zeroTaxCertNo ?? "",
    );
    if (certNo === null || !certNo.trim()) return;
    try {
      await api.patch(`/sales/${d.id}/zero-tax-cert`, { certNo: certNo.trim() });
      setError(null);
      docs.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * 折讓證明單 XML 下載（G0401，第二批）：折讓單登錄號碼＋日期後才產得出來。
   * 端點回的是純 XML（照 /invoices/:id/xml 的習慣）而非 JSON，所以不走 api.get
   * （它會 JSON.parse 炸掉）；錯誤回應是 JSON，照常取 error 顯示可操作訊息。
   */
  const downloadG0401 = async (r: ReturnRow) => {
    try {
      const res = await fetch(`/api/sales-returns/${r.id}/g0401-xml`);
      const text = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? msg;
        } catch {
          /* 非 JSON 錯誤體照用狀態碼 */
        }
        throw new Error(msg);
      }
      downloadText(`G0401-${r.certNo}.xml`, text);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 作廢退回／折讓單（0030）：理由必填；退回單的庫存反向回沖、折讓單不動庫存 */
  const voidReturn = async (r: ReturnRow) => {
    const label = r.kind === "return" ? t("退回單") : t("折讓單");
    const reason = window.prompt(
      t("作廢{label} #{id}（{total} 元）：請輸入作廢理由。", { label, id: r.id, total: fmt(r.total) }) + "\n" +
        (r.kind === "return"
          ? t("回補過的庫存會再沖出去（退回來的貨已再賣出時會被擋下）、傳票以反向分錄沖平。")
          : t("傳票以反向分錄沖平；已登錄證明單的折讓單，作廢後請下載 G0501 作廢訊息上傳。")),
    );
    if (reason === null) return;
    try {
      await api.post(`/sales-returns/${r.id}/void`, { reason: reason.trim() });
      setError(null);
      returns.reload();
      aging.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** G0501 作廢折讓證明單下載（0030）：與 G0401 同一套純 XML 下載習慣 */
  const downloadG0501 = async (r: ReturnRow) => {
    try {
      const res = await fetch(`/api/sales-returns/${r.id}/g0501-xml`);
      const text = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? msg;
        } catch {
          /* 非 JSON 錯誤體照用狀態碼 */
        }
        throw new Error(msg);
      }
      downloadText(`G0501-${r.certNo}.xml`, text);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 作廢銷貨單（B4）：僅限未開發票或發票已作廢者；理由必填，庫存回補、傳票沖平 */
  const voidSale = async (d: DocRow) => {
    const reason = window.prompt(
      t("作廢銷貨單 #{id}（{total} 元）：請輸入作廢理由。", { id: d.id, total: fmt(d.total) }) + "\n" +
        t("庫存會按原出庫成本回補、傳票以反向分錄沖平；單子打錯請作廢後重開一張正確的。"),
    );
    if (reason === null) return;
    try {
      await api.post(`/sales/${d.id}/void`, { reason: reason.trim() });
      setError(null);
      docs.reload();
      aging.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <TaxNotes notes={taxNotes} />
      <div className="card">
        <h3>{t("新增銷貨單")}</h3>
        <DocForm
          kind="sales"
          partners={partners.data ?? []}
          products={products.data ?? []}
          onCreated={docs.reload}
          onError={setError}
        />
      </div>
      {/* 四個詞的反向指路。原本這段只寫在「電子發票」頁的作廢面板裡——使用者得先按下作廢才看得到，
          等於在錯誤發生後才給提示。而「沖銷」在畫面上有兩種意思（整單沖銷／收款沖應收），
          不講清楚就會有人拿作廢去處理退貨，把上一期已申報的數字改掉。 */}
      <details className="card" style={{ paddingTop: 10 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          {t("該用「退貨／折讓」還是「作廢發票」？（點開看四個詞的差別）")}
        </summary>
        <ul style={{ fontSize: 13, lineHeight: 1.9, margin: "8px 0 0", paddingLeft: 20 }}>
          <li>
            <strong>{t("退貨")}</strong>{t("：貨真的回到倉庫。庫存回補、成本按原銷貨成本回沖，以")}<strong>{t("退貨當期")}</strong>{t("入帳，原銷貨單金額不變。← 多數情況用這個")}
          </li>
          <li>
            <strong>{t("折讓")}</strong>{t("：貨沒退，但要少收錢（破損議價、量大回饋、尾數抹零）。不動庫存。")}
          </li>
          <li>
            <strong>{t("作廢發票")}</strong>{t("：")}<strong>{t("發票本身開錯了")}</strong>{t("（金額打錯、統編錯）且發票還拿得回來。在「電子發票」頁操作。發票日期所屬月份已關帳時會被擋下——那一期可能已經申報過，此時唯一的路是開退貨／折讓單。")}
          </li>
          <li>
            <strong>{t("沖銷")}</strong>{t("：畫面上有兩個意思，看位置——這一頁的「已沖銷」標記指")}<strong>{t("整張銷貨單被迴轉")}</strong>{t("（只會由作廢發票時連帶產生）；「收付款」頁的沖銷指")}<strong>{t("收到的錢沖掉哪幾張單的應收")}</strong>{t("，兩者無關。")}
          </li>
          <li style={{ color: "var(--red)" }}>
            <strong>{t("單子打錯")}</strong>{t("：還沒開發票（或發票已作廢）的銷貨單可以直接按「作廢」——庫存回補、傳票沖平、原單留痕，然後重開一張正確的。已開發票且未作廢的要先作廢發票；該月已關帳的只能走退貨／折讓（以當期認列）。")}
          </li>
        </ul>
      </details>
      <div className="card">
        <h3>{t("銷貨單")}</h3>
        <ListFilterBar
          partners={partners.data?.filter((p) => p.isCustomer) ?? []}
          partnerLabel={t("客戶")}
          onApply={setFilterQ}
          total={docs.total}
          shown={docs.data?.length ?? 0}
        />
        {zeroMissingCert.length > 0 && (
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--red)" }}>
            {t("有 ")}<strong>{t("{n} 筆零稅率銷貨", { n: zeroMissingCert.length })}</strong>{t("還沒登錄證明文件號碼（經海關＝出口報單號碼；非經海關＝外匯證明文件號碼等）。申報零稅率銷售額需檢附證明文件——取得號碼後按該列的「補登證明文件」填入；系統只登錄號碼，不驗證文件真偽。")}
          </p>
        )}
        <table>
          <thead>
            <tr><th>{t("單號")}</th><th>{t("日期")}</th><th>{t("收款到期")}</th><th className="num">{t("未稅")}</th><th className="num">{t("稅額")}</th><th className="num">{t("總額")}</th><th>{t("發票")}</th><th>{t("退貨")}</th><th></th></tr>
          </thead>
          <tbody>
            {docs.data?.map((d) => {
              const inv = invoiceOf(d.id);
              const ret = returnedOf(d.id);
              return (
                <Fragment key={d.id}>
                <tr>
                  <td>
                    #{d.id}
                    {d.taxType === "2" && (
                      <>
                        {" "}
                        <span
                          className="badge"
                          title={
                            (d.zeroTaxViaCustoms ? t("經海關出口") : t("非經海關")) +
                            (d.zeroTaxCertNo ? t("｜證明文件 {certNo}", { certNo: d.zeroTaxCertNo }) : t("｜證明文件號碼未登錄"))
                          }
                          style={d.zeroTaxCertNo ? undefined : { background: "var(--red-tint)", color: "var(--red)" }}
                        >
                          {d.zeroTaxCertNo ? t("零稅率") : t("零稅率・缺證明")}
                        </span>
                      </>
                    )}
                  </td>
                  <td>{d.docDate}</td>
                  {/* 未約定＝客戶主檔沒填付款條件（帳齡會以單據日估算）；補填後之後的新單自動帶入 */}
                  <td>{d.dueDate ?? t("未約定")}</td>
                  <td className="num">{fmt(d.subtotal)}</td>
                  <td className="num">{fmt(d.tax)}</td>
                  <td className="num">{fmt(d.total)}</td>
                  <td>
                    {inv ? (
                      <>
                        {inv.invoiceNumber}{" "}
                        <span className={`badge ${inv.status}`}>{inv.status === "issued" ? t("已開立") : t("已作廢")}</span>
                      </>
                    ) : (
                      t("未開立")
                    )}{" "}
                    {d.reversalEntryId && (
                      <span className="badge canceled" title={d.voidReason ? t("作廢理由：{reason}", { reason: d.voidReason }) : t("整張銷貨單已迴轉")}>
                        {t("已沖銷")}
                      </span>
                    )}
                  </td>
                  {/* 原單金額不變，退掉的部分另外標示——沖銷式的「整張消失」會讓老闆看不出賣了多少、退了多少 */}
                  <td>{ret.count ? <span className="badge">{t("已退 {net} 元（{count} 張）", { net: fmt(ret.net), count: ret.count })}</span> : "—"}</td>
                  <td>
                    {(!inv || inv.status === "canceled") && !d.reversalEntryId && (
                      <>
                        <button className="small" onClick={() => void issue(d.id, "B2B")}>{inv ? t("重開 B2B") : t("開 B2B")}</button>{" "}
                        <button className="small" onClick={() => startIssueB2C(d.id)}>{inv ? t("重開 B2C") : t("開 B2C")}</button>{" "}
                      </>
                    )}
                    {!d.reversalEntryId && returningId !== d.id && (
                      <button className="small" onClick={() => { setReturningId(d.id); setError(null); }}>{t("退貨／折讓")}</button>
                    )}{" "}
                    {/* 作廢（B4）：有 issued 發票或已沖銷的單不顯示——伺服端同樣會擋，這裡只是不誘導 */}
                    {canVoid && (!inv || inv.status === "canceled") && !d.reversalEntryId && (
                      <>
                        <button className="small" onClick={() => void voidSale(d)}>{t("作廢")}</button>{" "}
                      </>
                    )}
                    {d.taxType === "2" && !d.reversalEntryId && (
                      <>
                        <button className="small" onClick={() => void backfillZeroCert(d)}>
                          {d.zeroTaxCertNo ? t("改證明文件") : t("補登證明文件")}
                        </button>{" "}
                      </>
                    )}
                    <button className="small" onClick={() => void openPrint(d.id)}>{t("列印")}</button>
                  </td>
                </tr>
                {issuingB2CId === d.id && (
                  <tr>
                    <td colSpan={9}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                        <strong>{t("開立 B2C 發票")}</strong>
                        <label className="field">
                          {t("載具／捐贈")}
                          <select value={b2cKind} onChange={(e) => setB2cKind(e.target.value as typeof b2cKind)}>
                            <option value="none">{t("無（印紙本證明聯）")}</option>
                            <option value="3J0002">{t("手機條碼載具")}</option>
                            <option value="CQ0001">{t("自然人憑證載具")}</option>
                            <option value="custom">{t("其他載具（自填類別代號）")}</option>
                            <option value="donate">{t("捐贈（愛心碼）")}</option>
                          </select>
                        </label>
                        {b2cKind === "custom" && (
                          <input
                            placeholder={t("載具類別代號")}
                            style={{ width: 110 }}
                            value={b2cCarrierType}
                            onChange={(e) => setB2cCarrierType(e.target.value)}
                          />
                        )}
                        {(b2cKind === "3J0002" || b2cKind === "CQ0001" || b2cKind === "custom") && (
                          <input
                            placeholder={b2cKind === "3J0002" ? t("/ 開頭的手機條碼") : t("載具號碼")}
                            style={{ width: 140 }}
                            value={b2cCarrierId}
                            onChange={(e) => setB2cCarrierId(e.target.value)}
                          />
                        )}
                        {b2cKind === "donate" && (
                          <input
                            placeholder={t("捐贈碼（愛心碼）")}
                            style={{ width: 140 }}
                            value={b2cNpoban}
                            onChange={(e) => setB2cNpoban(e.target.value)}
                          />
                        )}
                        <button className="small" onClick={() => confirmIssueB2C(d.id)}>{t("開立")}</button>
                        <button className="small" onClick={() => setIssuingB2CId(null)}>{t("取消")}</button>
                        <span style={{ color: "var(--text-2)" }}>
                          {t("存載具或捐贈的發票不印證明聯；「無」維持現行預設。載具號碼與捐贈碼系統不驗證真偽，請照消費者出示的條碼輸入。")}
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
                {returningId === d.id && (
                  <tr>
                    <td colSpan={9}>
                      <ReturnForm
                        side="sale"
                        docId={d.id}
                        accounts={accounts.data ?? []}
                        onCancel={() => setReturningId(null)}
                        onError={setError}
                        onDone={(notes) => {
                          setTaxNotes(notes ?? []);
                          setReturningId(null);
                          setError(null);
                          returns.reload();
                          aging.reload();
                        }}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>{t("退貨／折讓紀錄（原銷貨單維持原金額，這裡是它的減項）")}</h3>
        {missingCert.length > 0 && (
          /* 證明單要自己到外面開（財政部軟體或加值中心平台），系統只登錄號碼。
             漏開一張就是申報時少一筆減項的依據，所以要主動報數字而不是讓使用者自己數「—」 */
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--red)" }}>
            {t("有 ")}<strong>{t("{n} 筆", { n: missingCert.length })}</strong>{t("還沒登錄退回折讓證明單號碼。")}
            <strong>{t("折讓單")}</strong>{t("的號碼由貴公司自行編定，補登號碼＋日期後可直接在本頁下載 G0401 折讓證明單 XML（放進 Turnkey 上傳目錄即可）；")}<strong>{t("退回單")}</strong>{t("的證明單仍需以財政部軟體或加值中心平台開立後回來補登。沒補登的，申報時就少一筆減項的依據。")}{" "}
            <button className="small" onClick={() => setCertOnly((v) => !v)}>
              {certOnly ? t("顯示全部") : t("只看缺證明單的")}
            </button>
          </p>
        )}
        {returns.data?.length === 0 && (
          <EmptyState
            icon="↩️"
            title={t("還沒有退貨或折讓")}
            desc={t("客戶把貨退回來，就在上面的銷貨單列按「退貨／折讓」——庫存會自動回補、成本按原銷貨成本回沖。貨沒退但要少收錢（破損議價、量大回饋）請選「折讓」，那不會動到庫存。")}
          />
        )}
        {returns.data && returns.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>{t("單號")}</th><th>{t("日期")}</th><th>{t("客戶")}</th><th>{t("類型")}</th><th>{t("原銷貨單")}</th>
                <th className="num">{t("未稅")}</th><th className="num">{t("稅額")}</th><th className="num">{t("沖應收")}</th>
                <th className="num">{t("應退客戶")}</th>
                {/* 證明單號要看得到：不然使用者填了號碼卻在任何列表都找不到，開單時填的等於丟進黑洞 */}
                <th title={t("折讓：號碼自編，補登號碼＋日期後可下載 G0401 XML（Turnkey 上傳）。退回：仍以外部（財政部軟體或加值中心平台）開立後補登號碼")}>{t("證明單")}</th>
                <th>{t("原因")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(certOnly ? missingCert : returns.data).map((r) => (
                <tr key={r.id}>
                  <td>
                    #{r.id}
                    {r.voidedAt && (
                      <>
                        {" "}
                        <span className="badge canceled" title={t("作廢理由：{reason}", { reason: r.voidReason ?? t("未記錄") })}>{t("已作廢")}</span>
                      </>
                    )}
                  </td>
                  <td>{r.docDate}</td>
                  <td>{r.partnerName}</td>
                  <td><span className="badge">{r.kind === "return" ? t("退回") : t("折讓")}</span></td>
                  <td>#{r.saleId}</td>
                  <td className="num">{fmt(r.subtotal)}</td>
                  <td className="num">{fmt(r.tax)}</td>
                  <td className="num">{fmt(r.arOffset ?? 0)}</td>
                  <td className="num">{fmt((r.payableAmount ?? 0) + r.cashAmount)}</td>
                  <td>
                    {/* 已作廢的單不可再補登證明單（伺服端同樣會 409），只顯示既有登錄值 */}
                    {r.voidedAt ? (
                      <span>{r.certNo ? `${r.certNo}${r.certDate ? `（${r.certDate}）` : ""}` : "—"}</span>
                    ) : (
                      <CertCell
                        side="sale"
                        returnId={r.id}
                        certNo={r.certNo}
                        certDate={r.certDate}
                        onSaved={() => { setError(null); returns.reload(); }}
                        onError={setError}
                      />
                    )}
                    {/* G0401 只給折讓單：退回的表達方式官方範例沒涵蓋，端點也會 422 指路。
                        缺日期時按下去會得到可操作的 422 訊息（叫使用者補日期），不藏按鈕 */}
                    {r.kind === "allowance" && r.certNo && (
                      <>
                        {" "}
                        <button
                          className="small"
                          title={t("下載 G0401 折讓證明單 XML（檔名照 MIG 慣例，放進 Turnkey 上傳目錄）")}
                          onClick={() => void downloadG0401(r)}
                        >
                          G0401 XML
                        </button>
                      </>
                    )}
                    {/* G0501（0030）：作廢已登錄證明單的折讓單，要把作廢訊息也交出去 */}
                    {r.kind === "allowance" && r.certNo && r.voidedAt && (
                      <>
                        {" "}
                        <button
                          className="small"
                          title={t("下載 G0501 作廢折讓證明單 XML（原 G0401 已上傳過的，要一併上傳這份作廢訊息）")}
                          onClick={() => void downloadG0501(r)}
                        >
                          G0501 XML
                        </button>
                      </>
                    )}
                  </td>
                  <td>{r.memo || "—"}</td>
                  <td>
                    {/* 作廢（0030）限財務／管理者；已作廢的不再顯示（伺服端同樣會 409） */}
                    {canVoid && !r.voidedAt && (
                      <button className="small" onClick={() => void voidReturn(r)}>{t("作廢")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>{t("應收帳齡（催款用：收款自動沖最舊的銷貨單，剩下的按**收款到期日**分逾期桶）")}</h3>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="field">{t("基準日")}<input type="date" value={agingAsOf} onChange={(e) => setAgingAsOf(e.target.value)} /></label>
        </form>
        {/* 回退標註（沒有到期日的舊單以單據日估算）：不可靜默，混兩種算法要讓人看得出來 */}
        {(aging.data?.notes ?? []).map((n, i) => (
          <p key={i} style={{ fontSize: 13, color: "var(--red)", margin: "8px 0 0" }}>{n}</p>
        ))}
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>{t("客戶")}</th>
              <th className="num">{t("未到期")}</th>
              <th className="num">{t("逾期 30 天內")}</th>
              <th className="num">{t("逾期 31–60 天")}</th>
              <th className="num">{t("逾期 61–90 天")}</th>
              <th className="num">{t("逾期超過 90 天")}</th>
              <th className="num">{t("未收合計")}</th>
              <th className="num">{t("已到期未收")}</th>
              <th className="num">{t("預收")}</th>
            </tr>
          </thead>
          <tbody>
            {aging.data?.rows.map((r) => (
              <tr key={r.partnerId}>
                <td>{r.name}</td>
                <td className="num">{r.notDue ? fmt(r.notDue) : "—"}</td>
                <td className="num">{r.d0_30 ? fmt(r.d0_30) : "—"}</td>
                <td className="num">{r.d31_60 ? fmt(r.d31_60) : "—"}</td>
                <td className="num">{r.d61_90 ? fmt(r.d61_90) : "—"}</td>
                <td className="num" style={r.d90plus ? { color: "var(--red)", fontWeight: 600 } : undefined}>
                  {r.d90plus ? fmt(r.d90plus) : "—"}
                </td>
                <td className="num">{fmt(r.total)}</td>
                <td className="num" style={r.overdue ? { color: "var(--red)", fontWeight: 600 } : undefined}>
                  {r.overdue ? fmt(r.overdue) : "—"}
                </td>
                <td className="num">{r.credit ? fmt(r.credit) : "—"}</td>
              </tr>
            ))}
            {aging.data && aging.data.rows.length > 0 && (
              <tr style={{ fontWeight: 600 }}>
                <td>{t("合計")}</td>
                <td className="num">{fmt(aging.data.totals.notDue)}</td>
                <td className="num">{fmt(aging.data.totals.d0_30)}</td>
                <td className="num">{fmt(aging.data.totals.d31_60)}</td>
                <td className="num">{fmt(aging.data.totals.d61_90)}</td>
                <td className="num">{fmt(aging.data.totals.d90plus)}</td>
                <td className="num">{fmt(aging.data.totals.total)}</td>
                <td className="num">{fmt(aging.data.totals.overdue)}</td>
                <td className="num">{fmt(aging.data.totals.credit)}</td>
              </tr>
            )}
          </tbody>
        </table>
        {aging.data?.rows.length === 0 && <p style={{ fontSize: 13, color: "var(--text-2)" }}>{t("目前沒有未收款項。")}</p>}
      </div>
      {printSale && (
        <SalePrintView sale={printSale} company={company.data} onClose={() => setPrintSale(null)} />
      )}
    </div>
  );
}
