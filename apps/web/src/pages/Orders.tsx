import { useState } from "react";
import { api } from "../api.ts";
import { useAuth } from "../auth.ts";
import { fmt, useFetch, useListFetch } from "../hooks.ts";
import { CompanyHeaderBlock, PrintOverlay } from "../print.tsx";
import { EmptyState, ListFilterBar, TaxNotes, pickTaxNotes } from "../ui.tsx";
import type { CompanyHeader, OrderRow, Partner, Product, QuoteRow } from "../types.ts";

const QUOTE_STATUS: Record<QuoteRow["status"], string> = { open: "洽談中", won: "已成交", lost: "未成交" };
const ORDER_STATUS: Record<OrderRow["status"], string> = {
  open: "未出貨",
  partial: "部分出貨",
  closed: "已結案",
  canceled: "已取消",
};

interface Line {
  productId: number;
  qty: number;
  unitPrice: number;
}

/** 課稅別三欄（0032）：taxFields 開啟時 LinesForm 回傳；零稅率未選經海關與否時不帶（伺服端 422 必答） */
export interface TaxFieldsData {
  taxType?: "1" | "2";
  zeroTaxViaCustoms?: boolean;
  zeroTaxCertNo?: string;
}

/** 報價/訂單/採購單共用的明細編輯（交易對象＋日期＋動態商品列）；partners 由呼叫端先過濾角色 */
export function LinesForm(props: {
  title: string;
  dateLabel: string;
  partnerLabel?: string;
  partners: Partner[];
  products: Product[];
  /** 選到商品時帶入標準售價當預設單價（報價／訂單＝賣方視角才開；採購單的進價與售價無關） */
  useListPrice?: boolean;
  /** 課稅別下拉（報價／訂單＝銷項才開；採購單的進項屬性登錄在進貨單的發票欄，不在這裡） */
  taxFields?: boolean;
  /** 交期欄（0035）：有給標籤才顯示（報價／訂單＝預計交期、採購單＝預計到貨日）。留空＝未約定 */
  expectedDateLabel?: string;
  onSubmit: (
    data: { partnerId: number; date: string; memo: string; expectedDate?: string; lines: Line[] } & TaxFieldsData,
  ) => Promise<void>;
}) {
  const [partnerId, setPartnerId] = useState(0);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState("");
  const [memo, setMemo] = useState("");
  // 課稅別預設應稅：絕大多數單據不必碰這一格；免稅（'3'）不提供選項——伺服端拒收（要用 403 申報），
  // 放一個按了必 422 的選項是誘導
  const [taxType, setTaxType] = useState<"1" | "2">("1");
  const [viaCustoms, setViaCustoms] = useState("");
  const [certNo, setCertNo] = useState("");
  const [lines, setLines] = useState<Line[]>([{ productId: 0, qty: 1, unitPrice: 0 }]);
  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickProduct = (i: number, productId: number) => {
    const product = props.products.find((p) => p.id === productId);
    setLine(i, {
      productId,
      ...(props.useListPrice && product?.listPrice != null ? { unitPrice: product.listPrice } : {}),
    });
  };

  const submit = async () => {
    // 零稅率才帶三欄；未選「經海關與否」時不帶那一格——讓伺服端的 422 必答訊息說明兩者差在哪
    const taxData: TaxFieldsData =
      props.taxFields && taxType === "2"
        ? {
            taxType,
            ...(viaCustoms ? { zeroTaxViaCustoms: viaCustoms === "customs" } : {}),
            ...(certNo.trim() ? { zeroTaxCertNo: certNo.trim() } : {}),
          }
        : {};
    await props.onSubmit({
      partnerId,
      date,
      memo,
      ...(props.expectedDateLabel && expectedDate ? { expectedDate } : {}),
      lines: lines.filter((l) => l.productId && l.qty > 0),
      ...taxData,
    });
    setLines([{ productId: 0, qty: 1, unitPrice: 0 }]);
    setMemo("");
    setExpectedDate("");
    setTaxType("1");
    setViaCustoms("");
    setCertNo("");
  };

  return (
    <div>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          {props.partnerLabel ?? "客戶"}
          <select value={partnerId} onChange={(e) => setPartnerId(Number(e.target.value))}>
            <option value={0}>— 請選擇 —</option>
            {props.partners.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="field">{props.dateLabel}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {props.expectedDateLabel && (
          <label className="field">
            {props.expectedDateLabel}（選填）
            <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
          </label>
        )}
        <label className="field">備註（選填）<input value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
        {props.taxFields && (
          <label className="field">
            課稅別
            <select value={taxType} onChange={(e) => setTaxType(e.target.value as "1" | "2")}>
              <option value="1">應稅</option>
              <option value="2">零稅率（外銷）</option>
            </select>
          </label>
        )}
        {props.taxFields && taxType === "2" && (
          <>
            <label className="field">
              零稅率依據
              <select value={viaCustoms} onChange={(e) => setViaCustoms(e.target.value)}>
                <option value="">— 必選 —</option>
                <option value="customs">經海關出口（出口報單）</option>
                <option value="noncustoms">非經海關（外匯證明等）</option>
              </select>
            </label>
            <label className="field">
              證明文件號碼（可事後補登）
              <input value={certNo} placeholder="出口報單／外匯證明號碼" onChange={(e) => setCertNo(e.target.value)} />
            </label>
          </>
        )}
      </form>
      {lines.map((l, i) => (
        <form key={i} className="inline" style={{ marginTop: 8 }} onSubmit={(e) => e.preventDefault()}>
          <label className="field">
            商品
            <select value={l.productId} onChange={(e) => pickProduct(i, Number(e.target.value))}>
              <option value={0}>— 請選擇 —</option>
              {props.products.map((p) => (
                <option key={p.id} value={p.id}>{p.sku} {p.name}{p.isService ? "（服務）" : ""}</option>
              ))}
            </select>
          </label>
          <label className="field">數量<input type="number" min={0} value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} /></label>
          <label className="field">單價（未稅）<input type="number" min={0} step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} /></label>
          {i === lines.length - 1 && (
            <button className="small" onClick={() => setLines((ls) => [...ls, { productId: 0, qty: 1, unitPrice: 0 }])}>
              ＋明細
            </button>
          )}
        </form>
      ))}
      <div style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => void submit()}>{props.title}</button>
      </div>
    </div>
  );
}

/**
 * 報價單列印視圖（B5）：交給客戶簽回的那張紙。報價單清單本來就帶明細，
 * 品名由商品主檔對照（quote_lines 只存 productId），客戶抬頭取交易對象主檔。
 */
function QuotePrintView(props: {
  quote: QuoteRow;
  partner: Partner | undefined;
  products: Product[];
  company: CompanyHeader | null;
  onClose: () => void;
}) {
  const { quote, partner } = props;
  const productOf = new Map(props.products.map((p) => [p.id, p]));
  return (
    <PrintOverlay onClose={props.onClose}>
      <CompanyHeaderBlock company={props.company} docTitle="報價單" />
      <div className="meta-row">
        <div>
          客戶：{partner?.name ?? quote.partnerName}
          {partner?.taxId ? `（統編 ${partner.taxId}）` : ""}
          {partner?.contactPerson ? `　聯絡人 ${partner.contactPerson}` : ""}
          {partner?.phone ? `　電話 ${partner.phone}` : ""}
        </div>
        <div>單號：#{quote.id}　報價日：{quote.quoteDate}</div>
      </div>
      <table>
        <thead>
          <tr><th>品名</th><th className="num">數量</th><th>單位</th><th className="num">單價（未稅）</th><th className="num">金額</th></tr>
        </thead>
        <tbody>
          {quote.lines.map((l) => {
            const product = productOf.get(l.productId);
            return (
              <tr key={l.id}>
                <td>{product ? product.name : `商品 #${l.productId}`}</td>
                <td className="num">{Number(l.qty).toLocaleString("zh-TW")}</td>
                <td>{product?.unit ?? ""}</td>
                <td className="num">{Number(l.unitPrice).toLocaleString("zh-TW")}</td>
                <td className="num">{fmt(l.amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="totals">
        <div>未稅合計：{fmt(quote.subtotal)} 元　營業稅：{fmt(quote.tax)} 元</div>
        <div className="grand">總計：{fmt(quote.total)} 元</div>
      </div>
      {quote.expectedDate && <div>預計交期：{quote.expectedDate}</div>}
      {quote.memo && <div>備註：{quote.memo}</div>}
      <div className="sign-row">
        <div className="sign-box">報價人簽章</div>
        <div className="sign-box">客戶確認簽回（簽名即表同意上列品項與金額）</div>
      </div>
      <div className="foot-note">金額為整數新台幣元；稅額以報價當日設定之稅率估算，實際以出貨當日開立之單據為準。</div>
    </PrintOverlay>
  );
}

/** 付款條件的白話（列印用）：主檔天數 → 文字。null＝未約定——印「另議」而不是留白讓客戶猜 */
function paymentTermLabel(partner: Partner | undefined): string {
  if (!partner || partner.paymentTermDays == null) return "另議（未約定）";
  return partner.paymentTermDays === 0 ? "貨到付款" : `月結 ${partner.paymentTermDays} 天`;
}

/**
 * 訂單確認單列印視圖（B5 尾款）：成交後給客戶簽回的那張紙——品項、金額、交期、付款條件
 * 一次講清楚，事後吵「當初說好什麼」有紙為憑。照報價單列印的同一套（PrintOverlay＋公司抬頭）。
 */
function OrderPrintView(props: {
  order: OrderRow;
  partner: Partner | undefined;
  products: Product[];
  company: CompanyHeader | null;
  onClose: () => void;
}) {
  const { order, partner } = props;
  const productOf = new Map(props.products.map((p) => [p.id, p]));
  return (
    <PrintOverlay onClose={props.onClose}>
      <CompanyHeaderBlock company={props.company} docTitle="訂單確認單" />
      <div className="meta-row">
        <div>
          客戶：{partner?.name ?? order.partnerName}
          {partner?.taxId ? `（統編 ${partner.taxId}）` : ""}
          {partner?.contactPerson ? `　聯絡人 ${partner.contactPerson}` : ""}
          {partner?.phone ? `　電話 ${partner.phone}` : ""}
        </div>
        <div>
          單號：#{order.id}
          {order.quoteId ? `（報價單 #${order.quoteId}）` : ""}
          　訂單日：{order.orderDate}
        </div>
      </div>
      <table>
        <thead>
          <tr><th>品名</th><th className="num">數量</th><th>單位</th><th className="num">單價（未稅）</th><th className="num">金額</th></tr>
        </thead>
        <tbody>
          {order.lines.map((l) => {
            const product = productOf.get(l.productId);
            return (
              <tr key={l.id}>
                <td>{product ? product.name : l.productName}</td>
                <td className="num">{Number(l.qty).toLocaleString("zh-TW")}</td>
                <td>{product?.unit ?? ""}</td>
                <td className="num">{Number(l.unitPrice).toLocaleString("zh-TW")}</td>
                <td className="num">{fmt(l.amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="totals">
        <div>未稅合計：{fmt(order.subtotal)} 元　營業稅：{fmt(order.tax)} 元</div>
        <div className="grand">總計：{fmt(order.total)} 元</div>
      </div>
      <div>預計交期：{order.expectedDate ?? "另議（未約定）"}　付款條件：{paymentTermLabel(partner)}</div>
      {order.memo && <div>備註：{order.memo}</div>}
      <div className="sign-row">
        <div className="sign-box">承辦人簽章</div>
        <div className="sign-box">客戶確認簽回（簽名即表同意上列品項、金額與交期）</div>
      </div>
      <div className="foot-note">金額為整數新台幣元；稅額以訂單當日設定之稅率估算，實際以出貨當日開立之單據為準。</div>
    </PrintOverlay>
  );
}

export function Orders() {
  // 作廢限財務／管理者（auth.ts RULES）：業務角色不顯示按鈕——顯示一個按了必 403 的鍵是誘導
  const canVoid = ["admin", "finance"].includes(useAuth().role);
  const partners = useFetch<Partner[]>("/partners");
  const products = useFetch<Product[]>("/products");
  // 清單篩選（R3）：報價單與訂單各自一組（日期欄不同：報價日 vs 訂單日）
  const [quoteFilterQ, setQuoteFilterQ] = useState("");
  const quotes = useListFetch<QuoteRow[]>(`/quotes${quoteFilterQ ? `?${quoteFilterQ}` : ""}`);
  const [orderFilterQ, setOrderFilterQ] = useState("");
  const orders = useListFetch<OrderRow[]>(`/orders${orderFilterQ ? `?${orderFilterQ}` : ""}`);
  const company = useFetch<CompanyHeader>("/company-profile");
  const [printQuote, setPrintQuote] = useState<QuoteRow | null>(null);
  const [printOrder, setPrintOrder] = useState<OrderRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 稅率回退警告：API 說「這張單用的是既有預設值」時要讓使用者看到，不可靜默
  const [taxNotes, setTaxNotes] = useState<string[]>([]);
  const [shippingId, setShippingId] = useState<number | null>(null);
  const [shipQty, setShipQty] = useState<Record<number, number>>({});
  const [shipDate, setShipDate] = useState(new Date().toISOString().slice(0, 10));
  // 成交轉訂單的日期輸入（R2）：原本寫死「今天」——客戶的採購單日期是上週五也只能記成今天
  const [convertingId, setConvertingId] = useState<number | null>(null);
  const [convertDate, setConvertDate] = useState(new Date().toISOString().slice(0, 10));

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setTaxNotes(pickTaxNotes(await fn()));
      setError(null);
      setShippingId(null);
      quotes.reload();
      orders.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 作廢報價單（B4）：單子建錯用「作廢」（不進統計）；客戶沒成交用「未成交」（成交率的分母），兩者是兩件事 */
  const voidQuote = async (q: QuoteRow) => {
    const reason = window.prompt(
      `作廢報價單 #${q.id}（${fmt(q.total)} 元）：請輸入作廢理由。\n` +
        "作廢＝這張單建錯了、不該進任何統計；客戶沒成交請改按「未成交」。",
    );
    if (reason === null) return;
    try {
      await api.post(`/quotes/${q.id}/void`, { reason: reason.trim() });
      setError(null);
      quotes.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startShip = (o: OrderRow) => {
    setShippingId(o.id);
    setShipDate(new Date().toISOString().slice(0, 10));
    setShipQty(Object.fromEntries(o.lines.map((l) => [l.id, l.remainingQty])));
  };

  const confirmShip = (o: OrderRow) =>
    act(() => {
      const lines = o.lines
        .map((l) => ({ orderLineId: l.id, qty: shipQty[l.id] ?? 0 }))
        .filter((l) => l.qty > 0);
      if (!lines.length) throw new Error("出貨量全為 0");
      return api.post(`/orders/${o.id}/ship`, { docDate: shipDate, lines });
    });

  /** 短交結案（0032）：結案＝到此為止（已出貨的單據留著、剩餘量不再出）；取消＝從沒發生（僅限未出貨） */
  const closeOrder = (o: OrderRow) => {
    const remaining = o.lines
      .filter((l) => l.remainingQty > 0)
      .map((l) => `${l.productName} ${l.remainingQty}`)
      .join("、");
    const reason = window.prompt(
      `結案訂單 #${o.id}：請輸入結案原因（例如：客戶砍單、無法備貨）。\n` +
        `結案＝到此為止：已出貨的單據全部留著，剩餘（${remaining || "無"}）不再出貨。\n` +
        `這張單從沒發生請改用「取消訂單」（僅限完全未出貨）。`,
    );
    if (reason === null) return;
    void act(() => api.post(`/orders/${o.id}/close`, { reason: reason.trim() }));
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <TaxNotes notes={taxNotes} />

      <div className="card">
        <h3>新增報價單</h3>
        <LinesForm
          title="建立報價單"
          dateLabel="報價日"
          partners={(partners.data ?? []).filter((p) => p.isCustomer)}
          products={products.data ?? []}
          useListPrice
          taxFields
          expectedDateLabel="預計交期"
          onSubmit={async ({ partnerId, date, memo, expectedDate, lines, ...tax }) => {
            try {
              if (!partnerId) throw new Error("請選客戶");
              if (!lines.length) throw new Error("至少一筆有效明細");
              setTaxNotes(pickTaxNotes(await api.post("/quotes", { partnerId, quoteDate: date, memo: memo || undefined, expectedDate, lines, ...tax })));
              setError(null);
              quotes.reload();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      </div>

      <div className="card">
        <h3>報價單</h3>
        <ListFilterBar
          partners={partners.data?.filter((p) => p.isCustomer) ?? []}
          partnerLabel="客戶"
          onApply={setQuoteFilterQ}
          total={quotes.total}
          shown={quotes.data?.length ?? 0}
        />
        {quotes.data?.length === 0 && (
          <EmptyState
            icon="🤝"
            title="還沒有報價單"
            desc={(partners.data ?? []).some((p) => p.isCustomer)
              ? "客戶問價時，用上面的表單開一張報價單——成交後一鍵轉訂單。"
              : "先到「客戶與商品」建立客戶與商品，回來就能開第一張報價單。"}
          />
        )}
        {quotes.data && quotes.data.length > 0 && (
        <table>
          <thead>
            <tr><th>單號</th><th>日期</th><th>交期</th><th>客戶</th><th>內容</th><th className="num">總額（含稅）</th><th>狀態</th><th></th></tr>
          </thead>
          <tbody>
            {quotes.data?.map((q) => (
              <tr key={q.id}>
                <td>#{q.id}</td>
                <td>{q.quoteDate}</td>
                <td>{q.expectedDate ?? "—"}</td>
                <td>{q.partnerName}</td>
                <td>{q.memo || `${q.lines.length} 項`}</td>
                <td className="num">{fmt(q.total)}</td>
                <td>
                  {q.voidedAt ? (
                    <span className="badge canceled" title={`作廢理由：${q.voidReason ?? ""}`}>已作廢</span>
                  ) : (
                    <span className={`badge ${q.status === "won" ? "issued" : q.status === "lost" ? "canceled" : ""}`}>
                      {QUOTE_STATUS[q.status]}
                    </span>
                  )}
                  {q.taxType === "2" && (
                    <span className="badge" title={q.zeroTaxViaCustoms ? "經海關出口" : "非經海關（外匯證明等）"}>零稅率</span>
                  )}
                  {q.orderId && <span style={{ fontSize: 12 }}>（訂單 #{q.orderId}）</span>}
                </td>
                <td>
                  {q.status === "open" && !q.voidedAt && convertingId !== q.id && (
                    <>
                      <button
                        className="small"
                        onClick={() => {
                          setConvertingId(q.id);
                          setConvertDate(new Date().toISOString().slice(0, 10));
                        }}
                      >
                        成交轉訂單
                      </button>{" "}
                      <button className="small" onClick={() => void act(() => api.post(`/quotes/${q.id}/lost`, {}))}>未成交</button>{" "}
                    </>
                  )}
                  {q.status === "open" && !q.voidedAt && convertingId === q.id && (
                    <>
                      {/* 訂單日期可回填（R2）：客戶採購單的日期常在上週，不是按下按鈕的今天 */}
                      <input
                        type="date"
                        value={convertDate}
                        onChange={(e) => setConvertDate(e.target.value)}
                        style={{ width: 140 }}
                      />{" "}
                      <button
                        className="small primary"
                        onClick={() =>
                          void act(async () => {
                            const res = await api.post(`/quotes/${q.id}/convert`, { orderDate: convertDate });
                            setConvertingId(null);
                            return res;
                          })
                        }
                      >
                        確認轉單
                      </button>{" "}
                      <button className="small" onClick={() => setConvertingId(null)}>取消</button>{" "}
                    </>
                  )}
                  {/* 建錯的單（含誤標未成交的）可作廢；won 由伺服端擋（訂單已帶著這份金額在跑） */}
                  {canVoid && q.status !== "won" && !q.voidedAt && (
                    <>
                      <button className="small" onClick={() => void voidQuote(q)}>作廢</button>{" "}
                    </>
                  )}
                  <button className="small" onClick={() => setPrintQuote(q)}>列印</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>

      <div className="card">
        <h3>直接下單（不經報價）</h3>
        <LinesForm
          title="建立訂單"
          dateLabel="訂單日"
          partners={(partners.data ?? []).filter((p) => p.isCustomer)}
          products={products.data ?? []}
          useListPrice
          taxFields
          expectedDateLabel="預計交期"
          onSubmit={async ({ partnerId, date, memo, expectedDate, lines, ...tax }) => {
            try {
              if (!partnerId) throw new Error("請選客戶");
              if (!lines.length) throw new Error("至少一筆有效明細");
              setTaxNotes(pickTaxNotes(await api.post("/orders", { partnerId, orderDate: date, memo: memo || undefined, expectedDate, lines, ...tax })));
              setError(null);
              orders.reload();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      </div>

      <div className="card">
        <h3>訂單（出貨會開銷貨單並拋轉庫存/傳票）</h3>
        <ListFilterBar
          partners={partners.data?.filter((p) => p.isCustomer) ?? []}
          partnerLabel="客戶"
          onApply={setOrderFilterQ}
          total={orders.total}
          shown={orders.data?.length ?? 0}
        />
        <table>
          <thead>
            <tr><th>單號</th><th>日期</th><th>交期</th><th>客戶</th><th>出貨進度</th><th className="num">總額（含稅）</th><th>狀態</th><th></th></tr>
          </thead>
          <tbody>
            {orders.data?.map((o) => {
              // 逾期交期（0035）：今天已過預計交期且未結（open/partial）——只標色提醒，不做任何自動通知
              const overdue =
                o.expectedDate != null &&
                (o.status === "open" || o.status === "partial") &&
                new Date().toISOString().slice(0, 10) > o.expectedDate;
              return (
              <tr key={o.id}>
                <td>#{o.id}{o.quoteId && <span style={{ fontSize: 12 }}>（報價 #{o.quoteId}）</span>}</td>
                <td>{o.orderDate}</td>
                <td style={overdue ? { color: "var(--red)", fontWeight: 600 } : undefined}>
                  {o.expectedDate ?? "—"}{overdue && "（逾期）"}
                </td>
                <td>{o.partnerName}</td>
                <td>
                  {o.lines.map((l) => (
                    <div key={l.id} style={{ fontSize: 13 }}>
                      {l.productName}：{Number(l.shippedQty)}/{Number(l.qty)}
                      {shippingId === o.id && l.remainingQty > 0 && (
                        <>
                          {" 出 "}
                          <input
                            type="number"
                            min={0}
                            max={l.remainingQty}
                            style={{ width: 70 }}
                            value={shipQty[l.id] ?? 0}
                            onChange={(e) => setShipQty((m) => ({ ...m, [l.id]: Number(e.target.value) }))}
                          />
                        </>
                      )}
                    </div>
                  ))}
                  {o.saleIds.length > 0 && (
                    <div style={{ fontSize: 12, color: "var(--text-2)" }}>銷貨單：{o.saleIds.map((id) => `#${id}`).join("、")}</div>
                  )}
                </td>
                <td className="num">{fmt(o.total)}</td>
                <td>
                  <span
                    className={`badge ${o.status === "closed" ? "issued" : o.status === "canceled" ? "canceled" : ""}`}
                    title={o.closeReason ? `短交結案：${o.closeReason}` : undefined}
                  >
                    {o.status === "closed" && o.closedAt ? "短交結案" : ORDER_STATUS[o.status]}
                  </span>
                  {o.taxType === "2" && (
                    <span className="badge" title={o.zeroTaxViaCustoms ? "經海關出口" : "非經海關（外匯證明等）"}>零稅率</span>
                  )}
                </td>
                <td>
                  {(o.status === "open" || o.status === "partial") && shippingId !== o.id && (
                    <button className="small" onClick={() => startShip(o)}>出貨</button>
                  )}
                  {shippingId === o.id && (
                    <>
                      <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />{" "}
                      <button className="small" onClick={() => void confirmShip(o)}>確認出貨</button>{" "}
                      <button className="small" onClick={() => setShippingId(null)}>取消</button>
                    </>
                  )}{" "}
                  {o.status === "open" && shippingId !== o.id && (
                    <button className="small" onClick={() => void act(() => api.post(`/orders/${o.id}/cancel`, {}))}>取消訂單</button>
                  )}{" "}
                  {(o.status === "open" || o.status === "partial") && shippingId !== o.id && (
                    <button className="small" title="到此為止：已出貨的留著，剩餘量不再出" onClick={() => closeOrder(o)}>結案</button>
                  )}{" "}
                  {/* 訂單確認單（B5 尾款）：給客戶簽回——含品項、金額、交期、付款條件 */}
                  <button className="small" onClick={() => setPrintOrder(o)}>列印</button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {printQuote && (
        <QuotePrintView
          quote={printQuote}
          partner={partners.data?.find((p) => p.id === printQuote.partnerId)}
          products={products.data ?? []}
          company={company.data}
          onClose={() => setPrintQuote(null)}
        />
      )}
      {printOrder && (
        <OrderPrintView
          order={printOrder}
          partner={partners.data?.find((p) => p.id === printOrder.partnerId)}
          products={products.data ?? []}
          company={company.data}
          onClose={() => setPrintOrder(null)}
        />
      )}
    </div>
  );
}
