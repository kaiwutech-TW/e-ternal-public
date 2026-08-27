import { Fragment, useState } from "react";
import { api } from "../api.ts";
import { useAuth } from "../auth.ts";
import { useT } from "../i18n.ts";
import { fmt, useFetch, useListFetch } from "../hooks.ts";
import { EmptyState, ListFilterBar, TaxNotes, pickTaxNotes } from "../ui.tsx";
import type { Account, ApAging, DocRow, Partner, Product, PurchaseOrderRow, ReturnRow } from "../types.ts";
import { DocForm } from "./DocForm.tsx";
import { LinesForm } from "./Orders.tsx";
import { CertCell, ReturnForm } from "./ReturnForm.tsx";

/**
 * 進項憑證的白話下拉（B10）。代號是申報媒體檔的語言，會計日常說的是「這張是什麼發票、買來做什麼」。
 * 格式：25 電子發票／21 三聯式統一發票（紙本）／22 載有稅額之其他憑證（二聯式收銀機發票等）——
 * 選錯格子，申報書的紙本欄與電子發票欄會跟媒體檔對不起來。
 * 用途（扣抵代號）：3、4 是「進項稅額不可扣抵」的憑證（例如交際應酬用途），
 * 選 1/2 會把不可扣抵的稅算進可扣抵合計＝少繳稅，被查到要補稅加罰。
 */
const INV_FORMATS: [string, string][] = [
  ["25", "電子發票"],
  ["21", "三聯式統一發票（紙本）"],
  ["22", "其他載有稅額之憑證（二聯收銀機等）"],
];
const DEDUCTION_CODES: [string, string][] = [
  ["1", "進貨或費用（可扣抵）"],
  ["2", "固定資產（可扣抵）"],
  ["3", "進貨或費用（不可扣抵，如交際應酬用途）"],
  ["4", "固定資產（不可扣抵）"],
];

const PO_STATUS: Record<PurchaseOrderRow["status"], string> = {
  open: "未到貨",
  partial: "部分到貨",
  closed: "已結案",
  canceled: "已取消",
};

export function Purchases() {
  const t = useT();
  // 作廢限財務／管理者（auth.ts RULES）：採購角色不顯示按鈕——顯示一個按了必 403 的鍵是誘導
  const canVoid = ["admin", "finance"].includes(useAuth().role);
  const partners = useFetch<Partner[]>("/partners");
  const products = useFetch<Product[]>("/products");
  // 清單篩選（R3）：進貨單與採購單各自一組（兩張表的日期欄不同：單據日 vs 下單日）
  const [docFilterQ, setDocFilterQ] = useState("");
  const docs = useListFetch<DocRow[]>(`/purchases${docFilterQ ? `?${docFilterQ}` : ""}`);
  const [poFilterQ, setPoFilterQ] = useState("");
  const pos = useListFetch<PurchaseOrderRow[]>(`/purchase-orders${poFilterQ ? `?${poFilterQ}` : ""}`);
  const accounts = useFetch<Account[]>("/accounts");
  const returns = useFetch<ReturnRow[]>("/purchase-returns");
  // 「哪些退回還缺證明單」要查得到：只在表格裡顯示「—」等於沒有追蹤能力，
  // 而證明單要自己去外面開，漏一張就是申報時少一筆減項的依據
  const [certOnly, setCertOnly] = useState(false);
  // 已作廢的單（0030）不追證明單：它不進 401 減項
  const missingCert = (returns.data ?? []).filter((r) => !r.certNo && !r.voidedAt);
  const [returningId, setReturningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 稅率回退警告：API 說「這張單用的是既有預設值」時要讓使用者看到，不可靜默
  const [taxNotes, setTaxNotes] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);

  // 已作廢退出單（0030）不算累計已退：與伺服端 returnable 同口徑
  const returnedOf = (purchaseId: number) =>
    (returns.data ?? [])
      .filter((r) => r.purchaseId === purchaseId && !r.voidedAt)
      .reduce((s, r) => ({ count: s.count + 1, net: s.net + r.subtotal }), { count: 0, net: 0 });
  const [invInput, setInvInput] = useState("");
  const [invFormat, setInvFormat] = useState("25");
  const [invDeduction, setInvDeduction] = useState("1");
  // 供應商發票日期（0029，R20）：401 進項歸期優先用它。預設帶進貨單日期（多數發票與進貨同日），
  // 跨月的發票（6/30 開票、7/2 到貨）改掉這一格，申報才與賣方落在同一期
  const [invDate, setInvDate] = useState("");
  // 應付帳齡（0033）：與銷貨頁的應收帳齡同一套（付款自動沖最舊進貨單，剩下的按付款到期日分桶）
  const [agingAsOf, setAgingAsOf] = useState(new Date().toISOString().slice(0, 10));
  const aging = useFetch<ApAging>(`/reports/ap-aging?asOf=${agingAsOf}`);
  const [receivingId, setReceivingId] = useState<number | null>(null);
  const [receiveQty, setReceiveQty] = useState<Record<number, number>>({});
  // 收貨單價（0032）：預設帶採購單價；到貨發票價不同（調價、匯率）時改這一格，進貨單以收貨價入帳
  const [receivePrice, setReceivePrice] = useState<Record<number, number>>({});
  const [receiveDate, setReceiveDate] = useState(new Date().toISOString().slice(0, 10));

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      setReceivingId(null);
      pos.reload();
      docs.reload();
      aging.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startReceive = (po: PurchaseOrderRow) => {
    setReceivingId(po.id);
    setReceiveDate(new Date().toISOString().slice(0, 10));
    setReceiveQty(Object.fromEntries(po.lines.map((l) => [l.id, l.remainingQty])));
    setReceivePrice(Object.fromEntries(po.lines.map((l) => [l.id, Number(l.unitPrice)])));
  };

  const confirmReceive = (po: PurchaseOrderRow) =>
    act(async () => {
      const lines = po.lines
        .map((l) => {
          const price = receivePrice[l.id];
          return {
            poLineId: l.id,
            qty: receiveQty[l.id] ?? 0,
            // 只有真的改了價才帶：與採購單價相同就交給伺服端預設，回應也不會多出覆寫紀錄
            ...(price !== undefined && price !== Number(l.unitPrice) ? { unitPrice: price } : {}),
          };
        })
        .filter((l) => l.qty > 0);
      if (!lines.length) throw new Error(t("收貨量全為 0"));
      const res = await api.post(`/purchase-orders/${po.id}/receive`, { docDate: receiveDate, lines });
      // 收貨價覆寫與費率警告走同一條 taxNotes 通道：改了價要當場看得到入帳依據
      setTaxNotes(pickTaxNotes(res));
      return res;
    });

  /** 短交結案（0032）：結案＝到此為止（已收貨的單據留著、剩餘量不再收）；取消＝從沒發生（僅限未收貨） */
  const closePo = (po: PurchaseOrderRow) => {
    const remaining = po.lines
      .filter((l) => l.remainingQty > 0)
      .map((l) => `${l.productName} ${l.remainingQty}`)
      .join("、");
    const reason = window.prompt(
      t("結案採購單 #{id}：請輸入結案原因（例如：廠商斷貨、需求取消）。\n結案＝到此為止：已收貨的單據全部留著，剩餘（{remaining}）不再收貨。\n這張單從沒發生請改用「取消採購單」（僅限完全未收貨）。", { id: po.id, remaining: remaining || t("無") }),
    );
    if (reason === null) return;
    void act(() => api.post(`/purchase-orders/${po.id}/close`, { reason: reason.trim() }));
  };

  const registerInvoice = async (id: number) => {
    const m = /^([A-Z]{2})(\d{8})$/.exec(invInput.trim().toUpperCase());
    if (!m) {
      setError(t("格式須為 2 字母＋8 數字，例：AB12345678"));
      return;
    }
    try {
      await api.patch(`/purchases/${id}/supplier-invoice`, {
        track: m[1],
        no: m[2],
        format: invFormat,
        deductionCode: invDeduction,
        ...(invDate ? { invDate } : {}),
      });
      setError(null);
      setEditingId(null);
      setInvInput("");
      docs.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 作廢進貨單（B4）：反向傳票沖平、庫存以原入庫成本沖出；貨已賣出或已有退出單時伺服端會 409 指路 */
  const voidPurchase = async (d: DocRow) => {
    const reason = window.prompt(
      t("作廢進貨單 #{id}（{amount} 元）：請輸入作廢理由。\n庫存會沖出原入庫量（在庫不足會被擋下）、傳票以反向分錄沖平；單子打錯請作廢後重開一張。", { id: d.id, amount: fmt(d.total) }),
    );
    if (reason === null) return;
    try {
      await api.post(`/purchases/${d.id}/void`, { reason: reason.trim() });
      setError(null);
      docs.reload();
      pos.reload();
      aging.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 作廢退出／折讓單（0030）：理由必填；退出的貨按原成本補回、折讓的存貨帳面回復 */
  const voidReturn = async (r: ReturnRow) => {
    const label = r.kind === "return" ? t("退出單") : t("折讓單");
    const reason = window.prompt(
      t("作廢{label} #{id}（{amount} 元）：請輸入作廢理由。\n沖出過的庫存會按原成本補回、傳票以反向分錄沖平；單子打錯請作廢後重開一張正確的。", { label, id: r.id, amount: fmt(r.total) }),
    );
    if (reason === null) return;
    try {
      await api.post(`/purchase-returns/${r.id}/void`, { reason: reason.trim() });
      setError(null);
      returns.reload();
      aging.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 開啟登錄／修改：已登錄的單帶入既有值——號碼打錯、格式選錯都要有 UI 可改（B10） */
  const startInvoiceEdit = (d: DocRow) => {
    setEditingId(d.id);
    setInvInput(d.invTrack ? `${d.invTrack}${d.invNo}` : "");
    setInvFormat(d.invFormat ?? "25");
    setInvDeduction(d.deductionCode ?? "1");
    setInvDate(d.invDate ?? d.docDate);
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <TaxNotes notes={taxNotes} />

      <div className="card">
        <h3>{t("新增採購單（先下單追蹤，到貨再收貨轉進貨）")}</h3>
        <LinesForm
          title={t("建立採購單")}
          dateLabel={t("採購日")}
          partnerLabel={t("供應商")}
          partners={(partners.data ?? []).filter((p) => p.isSupplier)}
          products={products.data ?? []}
          expectedDateLabel={t("預計到貨日")}
          onSubmit={async ({ partnerId, date, memo, expectedDate, lines }) => {
            try {
              if (!partnerId) throw new Error(t("請選供應商"));
              if (!lines.length) throw new Error(t("至少一筆有效明細"));
              setTaxNotes(pickTaxNotes(await api.post("/purchase-orders", { partnerId, orderDate: date, memo: memo || undefined, expectedDate, lines })));
              setError(null);
              pos.reload();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      </div>

      <div className="card">
        <h3>{t("採購單（收貨會開進貨單並拋轉庫存/傳票）")}</h3>
        <ListFilterBar
          partners={partners.data?.filter((p) => p.isSupplier) ?? []}
          partnerLabel={t("供應商")}
          onApply={setPoFilterQ}
          total={pos.total}
          shown={pos.data?.length ?? 0}
        />
        <table>
          <thead>
            <tr><th>{t("單號")}</th><th>{t("日期")}</th><th>{t("預計到貨")}</th><th>{t("供應商")}</th><th>{t("到貨進度")}</th><th className="num">{t("總額（含稅）")}</th><th>{t("狀態")}</th><th></th></tr>
          </thead>
          <tbody>
            {pos.data?.map((po) => {
              // 逾期到貨（0035）：今天已過預計到貨日且未結——3 月下的單到 8 月沒到貨，這一格會一直紅著
              const overdue =
                po.expectedDate != null &&
                (po.status === "open" || po.status === "partial") &&
                new Date().toISOString().slice(0, 10) > po.expectedDate;
              return (
              <tr key={po.id}>
                <td>#{po.id}</td>
                <td>{po.orderDate}</td>
                <td style={overdue ? { color: "var(--red)", fontWeight: 600 } : undefined}>
                  {po.expectedDate ?? "—"}{overdue && t("（逾期）")}
                </td>
                <td>{po.partnerName}</td>
                <td>
                  {po.lines.map((l) => (
                    <div key={l.id} style={{ fontSize: 13 }}>
                      {l.productName}：{Number(l.receivedQty)}/{Number(l.qty)}
                      {receivingId === po.id && l.remainingQty > 0 && (
                        <>
                          {" "}{t("收")}{" "}
                          <input
                            type="number"
                            min={0}
                            max={l.remainingQty}
                            style={{ width: 70 }}
                            value={receiveQty[l.id] ?? 0}
                            onChange={(e) => setReceiveQty((m) => ({ ...m, [l.id]: Number(e.target.value) }))}
                          />
                          {" "}{t("單價")}{" "}
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            style={{ width: 90 }}
                            title={t("收貨單價（未稅）：預設採購單價 {price}；到貨發票價不同時改這裡，進貨單以收貨價入帳", { price: Number(l.unitPrice) })}
                            value={receivePrice[l.id] ?? Number(l.unitPrice)}
                            onChange={(e) => setReceivePrice((m) => ({ ...m, [l.id]: Number(e.target.value) }))}
                          />
                        </>
                      )}
                    </div>
                  ))}
                  {po.purchaseIds.length > 0 && (
                    <div style={{ fontSize: 12, color: "var(--text-2)" }}>{t("進貨單：{ids}", { ids: po.purchaseIds.map((id) => `#${id}`).join("、") })}</div>
                  )}
                </td>
                <td className="num">{fmt(po.total)}</td>
                <td>
                  <span
                    className={`badge ${po.status === "closed" ? "issued" : po.status === "canceled" ? "canceled" : ""}`}
                    title={po.closeReason ? t("短交結案：{reason}", { reason: po.closeReason }) : undefined}
                  >
                    {po.status === "closed" && po.closedAt ? t("短交結案") : t(PO_STATUS[po.status])}
                  </span>
                </td>
                <td>
                  {(po.status === "open" || po.status === "partial") && receivingId !== po.id && (
                    <button className="small" onClick={() => startReceive(po)}>{t("收貨")}</button>
                  )}
                  {receivingId === po.id && (
                    <>
                      <input type="date" value={receiveDate} onChange={(e) => setReceiveDate(e.target.value)} />{" "}
                      <button className="small" onClick={() => void confirmReceive(po)}>{t("確認收貨")}</button>{" "}
                      <button className="small" onClick={() => setReceivingId(null)}>{t("取消")}</button>
                    </>
                  )}{" "}
                  {po.status === "open" && receivingId !== po.id && (
                    <button className="small" onClick={() => void act(() => api.post(`/purchase-orders/${po.id}/cancel`, {}))}>{t("取消採購單")}</button>
                  )}{" "}
                  {(po.status === "open" || po.status === "partial") && receivingId !== po.id && (
                    <button className="small" title={t("到此為止：已收貨的留著，剩餘量不再收")} onClick={() => closePo(po)}>{t("結案")}</button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>{t("新增進貨單")}</h3>
        <DocForm
          kind="purchases"
          partners={partners.data ?? []}
          products={products.data ?? []}
          onCreated={docs.reload}
          onError={setError}
        />
      </div>
      <div className="card">
        <h3>{t("進貨單（登錄供應商發票後才會納入 401 進項扣抵）")}</h3>
        <ListFilterBar
          partners={partners.data?.filter((p) => p.isSupplier) ?? []}
          partnerLabel={t("供應商")}
          onApply={setDocFilterQ}
          total={docs.total}
          shown={docs.data?.length ?? 0}
        />
        <table>
          <thead>
            <tr><th>{t("單號")}</th><th>{t("日期")}</th><th className="num">{t("未稅")}</th><th className="num">{t("稅額")}</th><th className="num">{t("總額")}</th><th>{t("進項發票")}</th><th>{t("退出")}</th><th></th></tr>
          </thead>
          <tbody>
            {docs.data?.map((d) => {
              const ret = returnedOf(d.id);
              return (
              <Fragment key={d.id}>
              <tr>
                <td>
                  #{d.id}{" "}
                  {d.voidedAt && (
                    <span className="badge canceled" title={t("作廢理由：{reason}", { reason: d.voidReason ?? "" })}>{t("已作廢")}</span>
                  )}
                </td>
                <td>{d.docDate}</td>
                <td className="num">{fmt(d.subtotal)}</td>
                <td className="num">{fmt(d.tax)}</td>
                <td className="num">{fmt(d.total)}</td>
                <td>
                  {d.invTrack ? (
                    <>
                      {d.invTrack}{d.invNo}
                      <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                        {t(INV_FORMATS.find(([code]) => code === d.invFormat)?.[1] ?? d.invFormat ?? "")}｜
                        {t(DEDUCTION_CODES.find(([code]) => code === d.deductionCode)?.[1] ?? d.deductionCode ?? "")}
                      </div>
                      {/* 發票日期（R20）＝401 歸期依據；沒登的舊單以進貨單日期歸期，要看得出來 */}
                      <div style={{ fontSize: 12, color: d.invDate ? "var(--text-2)" : "var(--red)" }}>
                        {d.invDate ? t("發票日期 {date}", { date: d.invDate }) : t("發票日期未登錄（申報歸期以進貨單日期代）")}
                      </div>
                    </>
                  ) : (
                    t("未登錄")
                  )}
                </td>
                <td>{ret.count ? <span className="badge">{t("已退 {amount} 元（{count} 張）", { amount: fmt(ret.net), count: ret.count })}</span> : "—"}</td>
                <td>
                  {editingId !== d.id && !d.voidedAt && (
                    <button className="small" onClick={() => startInvoiceEdit(d)}>
                      {d.invTrack ? t("改發票資訊") : t("登錄發票")}
                    </button>
                  )}
                  {editingId === d.id && (
                    <>
                      <input
                        autoFocus
                        placeholder="AB12345678"
                        maxLength={10}
                        style={{ width: 110 }}
                        value={invInput}
                        onChange={(e) => setInvInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && registerInvoice(d.id)}
                      />{" "}
                      <input
                        type="date"
                        title={t("供應商發票上的開立日期：401 進項歸期用它（跨月發票務必照發票填，才與賣方申報落在同一期）")}
                        value={invDate}
                        onChange={(e) => setInvDate(e.target.value)}
                      />{" "}
                      <select title={t("憑證種類（決定申報書落哪一欄）")} value={invFormat} onChange={(e) => setInvFormat(e.target.value)}>
                        {INV_FORMATS.map(([code, label]) => (
                          <option key={code} value={code}>{t(label)}</option>
                        ))}
                      </select>{" "}
                      <select title={t("用途（決定進項稅額可否扣抵；選錯會少繳或多繳稅）")} value={invDeduction} onChange={(e) => setInvDeduction(e.target.value)}>
                        {DEDUCTION_CODES.map(([code, label]) => (
                          <option key={code} value={code}>{t(label)}</option>
                        ))}
                      </select>{" "}
                      <button className="small" onClick={() => registerInvoice(d.id)}>{t("確認")}</button>{" "}
                      <button className="small" onClick={() => setEditingId(null)}>{t("取消")}</button>
                    </>
                  )}{" "}
                  {/* 與「登錄供應商發票」並排：對會計而言這兩件事是同一類動作——登錄供應商寄來的紙 */}
                  {returningId !== d.id && editingId !== d.id && !d.voidedAt && (
                    <>
                      <button className="small" onClick={() => { setReturningId(d.id); setError(null); }}>{t("退出／折讓")}</button>{" "}
                      {canVoid && <button className="small" onClick={() => void voidPurchase(d)}>{t("作廢")}</button>}
                    </>
                  )}
                </td>
              </tr>
              {returningId === d.id && (
                <tr>
                  <td colSpan={8}>
                    <ReturnForm
                      side="purchase"
                      docId={d.id}
                      accounts={accounts.data ?? []}
                      onCancel={() => setReturningId(null)}
                      onError={setError}
                      onDone={(notes) => {
                        setTaxNotes(notes ?? []);
                        setReturningId(null);
                        setError(null);
                        returns.reload();
                        docs.reload();
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
        <h3>{t("退出／折讓紀錄（原進貨單維持原金額，這裡是它的減項）")}</h3>
        {missingCert.length > 0 && (
          /* 與銷貨端同一條規則：證明單是廠商開給我們的，沒收到／沒登錄就沒有申報減項的依據 */
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--red)" }}>
            {t("有 {n} 筆還沒登錄退回折讓證明單號碼。這張單通常由廠商開立給我們，收到之後回到這裡補登號碼，申報時才有減項的依據。", { n: missingCert.length })}{" "}
            <button className="small" onClick={() => setCertOnly((v) => !v)}>
              {certOnly ? t("顯示全部") : t("只看缺證明單的")}
            </button>
          </p>
        )}
        {returns.data?.length === 0 && (
          <EmptyState
            icon="📦"
            title={t("還沒有進貨退出或折讓")}
            desc={t("貨有問題退回給廠商，就在上面的進貨單列按「退出／折讓」——庫存會自動扣除、應付帳款同步減少。貨沒退但廠商同意少收錢（短少、破損議價）請選「折讓」。")}
          />
        )}
        {returns.data && returns.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>{t("單號")}</th><th>{t("日期")}</th><th>{t("供應商")}</th><th>{t("類型")}</th><th>{t("原進貨單")}</th>
                <th className="num">{t("未稅")}</th><th className="num">{t("稅額")}</th><th className="num">{t("沖應付")}</th>
                <th className="num">{t("成本差異")}</th>
                <th title={t("外部（財政部軟體或加值中心平台）開立的退回折讓證明單號碼與日期；本系統不產生證明單")}>{t("證明單")}</th>
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
                  <td><span className="badge">{r.kind === "return" ? t("退出") : t("折讓")}</span></td>
                  <td>#{r.purchaseId}</td>
                  <td className="num">{fmt(r.subtotal)}</td>
                  <td className="num">{fmt(r.tax)}</td>
                  <td className="num">{fmt(r.apOffset ?? 0)}</td>
                  <td
                    className="num"
                    title={t("廠商退的錢與帳上沖掉的存貨成本之間的差額，已調整銷貨成本（正數＝減少成本、負數＝增加成本）")}
                  >
                    {r.costDiff ? fmt(r.costDiff) : "—"}
                  </td>
                  <td>
                    {/* 已作廢的單不可再補登證明單（伺服端同樣會 409），只顯示既有登錄值 */}
                    {r.voidedAt ? (
                      <span>{r.certNo ? `${r.certNo}${r.certDate ? `（${r.certDate}）` : ""}` : "—"}</span>
                    ) : (
                      <CertCell
                        side="purchase"
                        returnId={r.id}
                        certNo={r.certNo}
                        certDate={r.certDate}
                        onSaved={() => { setError(null); returns.reload(); }}
                        onError={setError}
                      />
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
        <h3>{t("應付帳齡（排付款用：付款自動沖最舊的進貨單，剩下的按**付款到期日**分逾期桶）")}</h3>
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
              <th>{t("供應商")}</th>
              <th className="num">{t("未到期")}</th>
              <th className="num">{t("逾期 30 天內")}</th>
              <th className="num">{t("逾期 31–60 天")}</th>
              <th className="num">{t("逾期 61–90 天")}</th>
              <th className="num">{t("逾期超過 90 天")}</th>
              <th className="num">{t("未付合計")}</th>
              <th className="num">{t("已到期未付")}</th>
              <th className="num">{t("預付")}</th>
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
        {aging.data?.rows.length === 0 && <p style={{ fontSize: 13, color: "var(--text-2)" }}>{t("目前沒有未付款項。")}</p>}
      </div>
    </div>
  );
}
