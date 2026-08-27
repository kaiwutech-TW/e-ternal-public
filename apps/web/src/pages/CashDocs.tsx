import { Fragment, useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmt, useFetch, useListFetch } from "../hooks.ts";
import { useT } from "../i18n.ts";
import type { Account, CashDocDetail, CashDocRow, OpenDocument, Partner, PartnerBalance } from "../types.ts";
import { EmptyState, ListFilterBar } from "../ui.tsx";

export function CashDocs() {
  const t = useT();
  const partners = useFetch<Partner[]>("/partners");
  const accounts = useFetch<Account[]>("/accounts");
  // 清單篩選（R3）：日期範圍＋對象
  const [filterQ, setFilterQ] = useState("");
  const docs = useListFetch<CashDocRow[]>(`/cash-docs${filterQ ? `?${filterQ}` : ""}`);
  const balances = useFetch<PartnerBalance[]>("/partner-balances");
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<"receipt" | "payment">("receipt");
  const [partnerId, setPartnerId] = useState(0);
  const [docDate, setDocDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState(0);
  const [memo, setMemo] = useState("");
  const [openDocs, setOpenDocs] = useState<OpenDocument[]>([]);
  // 立沖輸入以 `${docType}:${id}` 為鍵：銷貨單與期初單是兩個 id 空間，只用數字 id 會互相蓋掉
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  // 沖銷明細（R6）：點開才抓 GET /cash-docs/:id；每次點開重抓——事後沖用預收/預付
  // 或作廢都會改變「該單目前剩多少」，端快取會給出過期數字。再點一次收合
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, CashDocDetail>>({});
  const toggleDetail = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    try {
      const d = await api.get<CashDocDetail>(`/cash-docs/${id}`);
      setDetails((m) => ({ ...m, [id]: d }));
      setExpandedId(id);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 立沖：選定對象後載入未沖單據
  useEffect(() => {
    setAlloc({});
    if (!partnerId) {
      setOpenDocs([]);
      return;
    }
    // 帶上這張收付款單的日期：勾選清單與服務層驗證用同一個基準，
    // 否則日期在收款日之後的退回單會讓某張單在畫面上消失（或反之，勾了送出被擋）
    api
      .get<OpenDocument[]>(`/open-documents?partnerId=${partnerId}&kind=${kind}&asOf=${docDate}`)
      .then(setOpenDocs)
      .catch(() => setOpenDocs([]));
  }, [partnerId, kind, docDate]);

  // 現金科目以 isCash 旗標篩選（含自建的銀行帳戶科目）：寫死 1101/1103 會讓使用者收不到自己銀行的款
  const cashAccounts = accounts.data?.filter((a) => a.isCash) ?? [];
  const eligible = partners.data?.filter((p) => (kind === "receipt" ? p.isCustomer : p.isSupplier)) ?? [];
  const partnerName = (id: number) => partners.data?.find((p) => p.id === id)?.name ?? `#${id}`;
  const allocSum = Object.values(alloc).reduce((s, v) => s + (v || 0), 0);
  // 0027（B9）：open-documents 把預收/預付餘額以 docType 'prepaid' 分開列——
  // 立沖表格只放可沖銷的單據，預收/預付列到自己的沖用面板
  const settleDocs = openDocs.filter((d) => d.docType !== "prepaid");
  // 溢收預告：超過「該對象還欠多少」的部分會掛預收/預付。R6 之後 open-documents 的
  // remaining 已含「未指定沖銷的舊收付款 FIFO 沖最舊」，直接加總＝服務層算 unapplied
  // 用的同一個 outstanding（同一個端點、同一個 asOf＝本單日期），預告與入帳不會對不上
  const outstanding = settleDocs.reduce((s, d) => s + d.remaining, 0);
  const excess = partnerId > 0 && amount > outstanding ? amount - outstanding : 0;

  /** 作廢（B4）：更正＝作廢＋重開。理由必填，原單與反向傳票都永久留存 */
  const voidDoc = async (d: CashDocRow) => {
    const label = d.kind === "receipt" ? t("收款單") : t("付款單");
    const reason = window.prompt(
      t("作廢{label} #{id}（{amount} 元）：請輸入作廢理由。\n系統會開一張反向傳票沖平原傳票，這張單沖過的應收／應付會自動回復；金額打錯請作廢後重開一張。", { label, id: d.id, amount: fmt(d.amount) }),
    );
    if (reason === null) return;
    try {
      await api.post(`/cash-docs/${d.id}/void`, { reason: reason.trim() });
      setError(null);
      docs.reload();
      balances.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = async () => {
    try {
      if (!partnerId) throw new Error(kind === "receipt" ? t("請選客戶") : t("請選供應商"));
      if (!accountId) throw new Error(t("請選收付科目（現金/銀行）"));
      if (amount <= 0) throw new Error(t("金額須為正整數"));
      const allocations = Object.entries(alloc)
        .map(([key, v]) => {
          const [targetType, targetId] = key.split(":");
          return { targetType, targetId: Number(targetId), amount: v || 0 };
        })
        .filter((a) => a.amount > 0);
      await api.post("/cash-docs", {
        kind,
        partnerId,
        docDate,
        amount,
        accountId,
        ...(memo ? { memo } : {}),
        ...(allocations.length ? { allocations } : {}),
      });
      setError(null);
      setAmount(0);
      setMemo("");
      setAlloc({});
      setPartnerId(0);
      docs.reload();
      balances.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h3>{t("新增收款單／付款單（自動拋轉傳票沖應收/應付）")}</h3>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="field">
            {t("類別")}
            <select value={kind} onChange={(e) => { setKind(e.target.value as "receipt" | "payment"); setPartnerId(0); }}>
              <option value="receipt">{t("收款（客戶）")}</option>
              <option value="payment">{t("付款（供應商）")}</option>
            </select>
          </label>
          <label className="field">
            {kind === "receipt" ? t("客戶") : t("供應商")}
            <select value={partnerId} onChange={(e) => setPartnerId(Number(e.target.value))}>
              <option value={0}>{t("— 請選擇 —")}</option>
              {eligible.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="field">{t("日期")}<input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} /></label>
          <label className="field">{t("金額（含稅）")}<input type="number" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></label>
          <label className="field">
            {t("收付科目")}
            <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
              <option value={0}>{t("— 請選擇 —")}</option>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} {a.name}</option>
              ))}
            </select>
          </label>
          <label className="field">{t("摘要")}<input value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          <button className="primary" onClick={submit}>{t("建立")}</button>
        </form>
        {excess > 0 && (
          <p style={{ fontSize: 13, color: "var(--amber)", margin: "8px 0 0" }}>
            {kind === "receipt"
              ? t("本次溢收 {amount} 元將掛「預收款項」（負債）——應收不會變成負數，之後的銷貨可到下方「沖用預收／預付」面板用這筆餘額沖銷", { amount: fmt(excess) })
              : t("本次溢付 {amount} 元將掛「預付貨款」（資產）——應付不會變成負數，之後的進貨可到下方「沖用預收／預付」面板用這筆餘額沖銷", { amount: fmt(excess) })}
          </p>
        )}
        {partnerId > 0 && settleDocs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h4 style={{ margin: "4px 0" }}>{t("立沖：指定沖哪幾張單（不填則整筆列對象層級，帳齡自動沖最舊）")}</h4>
            <table>
              <thead>
                <tr>
                  <th>{kind === "receipt" ? t("銷貨單（含期初）") : t("進貨單（含期初）")}</th><th>{t("日期")}</th>
                  {/* 這一欄是退回後的淨額，不是原單金額——標題不講清楚就會與銷貨／進貨頁的數字對不上 */}
                  <th className="num" title={t("原單金額扣掉已沖回應收／應付的退回、折讓後的淨額")}>{t("單據金額（退回後）")}</th>
                  <th className="num">{t("其中已退")}</th>
                  <th className="num">{t("已沖")}</th>
                  {/* R6：未指定沖銷的舊收付款依日期自動沖最舊（與帳齡同一條規則）——
                      不分欄顯示的話，「已沖」對不上立沖紀錄，使用者無法歸因 */}
                  <th className="num" title={t("先前未指定沖銷的收付款餘額，依日期自動沖最舊的單（與帳齡同一條規則）")}>{t("未指定已抵")}</th>
                  <th className="num">{t("未沖餘額")}</th><th className="num">{t("本次沖銷")}</th>
                </tr>
              </thead>
              <tbody>
                {settleDocs.map((d) => (
                  <tr key={`${d.docType}:${d.id}`}>
                    <td>{d.docType === "opening" ? t("期初 #{id}", { id: d.id }) : `#${d.id}`}</td>
                    <td>{d.docDate}</td>
                    <td className="num">{fmt(d.total)}</td>
                    <td className="num" title={d.returned ? t("原單金額 {total} 元，已退 {returned} 元", { total: fmt(d.total + d.returned), returned: fmt(d.returned) }) : undefined}>
                      {d.returned ? fmt(d.returned) : "—"}
                    </td>
                    <td className="num">{d.allocated ? fmt(d.allocated) : "—"}</td>
                    <td className="num">{d.fifoApplied ? fmt(d.fifoApplied) : "—"}</td>
                    <td className="num">{fmt(d.remaining)}</td>
                    <td className="num">
                      <input
                        type="number"
                        min={0}
                        max={d.remaining}
                        style={{ width: 90 }}
                        value={alloc[`${d.docType}:${d.id}`] ?? ""}
                        onChange={(e) => setAlloc((m) => ({ ...m, [`${d.docType}:${d.id}`]: Number(e.target.value) }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {allocSum > 0 && (
              <p style={{ fontSize: 13, color: allocSum > amount ? "var(--red)" : "var(--green)" }}>
                {t("沖銷合計 {sum}／收付金額 {amount}", { sum: fmt(allocSum), amount: fmt(amount) })}{allocSum > amount && t("——超過收付金額，送出會被擋")}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h3>{t("未收／未付餘額（銷貨/進貨＋期初應收付 − 已收付；已沖銷銷貨不計）")}</h3>
        {balances.data?.length === 0 && (
          <EmptyState
            icon="⚖️"
            title={t("目前沒有未結清的款項")}
            desc={t("開出銷貨單就會產生應收、開進貨單就會產生應付，這裡會列出每個對象還差多少。全部收付完畢時也會是空的——那是好事。")}
          />
        )}
        {balances.data && balances.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t("交易對象")}</th>
              <th className="num">{t("應收餘額")}</th>
              {/* 預收/預付與應收/應付分列不互抵（0027，B9）：「他欠我 X」和「我欠他 Y」是兩個事實，
                  淨額會把資產負債表壓成一個假數字 */}
              <th className="num" title={t("收款超過應收的部分（掛預收款項，屬負債），可沖之後的銷貨")}>{t("預收餘額")}</th>
              <th className="num">{t("應付餘額")}</th>
              <th className="num" title={t("付款超過應付的部分（掛預付貨款，屬資產），可沖之後的進貨")}>{t("預付餘額")}</th>
            </tr>
          </thead>
          <tbody>
            {balances.data?.map((b) => (
              <tr key={b.partnerId}>
                <td>{b.name}</td>
                <td className="num">{b.ar ? fmt(b.ar) : ""}</td>
                <td className="num">{b.prepaidReceived ? fmt(b.prepaidReceived) : ""}</td>
                <td className="num">{b.ap ? fmt(b.ap) : ""}</td>
                <td className="num">{b.prepaidPaid ? fmt(b.prepaidPaid) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>

      <ApplyPrepaidCard
        partners={partners.data ?? []}
        onApplied={() => {
          docs.reload();
          balances.reload();
        }}
      />

      <div className="card">
        <h3>{t("收付款單")}</h3>
        <ListFilterBar
          partners={partners.data ?? []}
          onApply={setFilterQ}
          total={docs.total}
          shown={docs.data?.length ?? 0}
        />
        {docs.data?.length === 0 && (
          <EmptyState
            icon="💵"
            title={t("還沒有收付款單")}
            {...(balances.data && balances.data.length > 0
              ? { desc: t("收到客戶的錢、或付錢給供應商時，用上面的表單開一張——系統自動拋轉傳票沖銷應收／應付。") }
              : {
                  desc: t("要先有銷貨或進貨才會產生應收應付。開一張銷貨單之後回來這裡收款。"),
                  actionLabel: t("去開銷貨單"),
                  actionPage: "sales" as const,
                })}
          />
        )}
        {docs.data && docs.data.length > 0 && (
        <table>
          <thead><tr><th>{t("單號")}</th><th>{t("類別")}</th><th>{t("日期")}</th><th>{t("對象")}</th><th className="num">{t("金額")}</th><th className="num" title={t("建單時超過該對象未沖餘額、掛預收款項／預付貨款的部分")}>{t("其中預收/預付")}</th><th>{t("摘要")}</th><th>{t("狀態")}</th><th></th></tr></thead>
          <tbody>
            {docs.data?.map((d) => (
              <Fragment key={d.id}>
                <tr>
                  <td>#{d.id}</td>
                  <td>{d.kind === "receipt" ? t("收款") : t("付款")}</td>
                  <td>{d.docDate}</td>
                  <td>{partnerName(d.partnerId)}</td>
                  <td className="num">{fmt(d.amount)}</td>
                  <td className="num">{d.unappliedAmount ? fmt(d.unappliedAmount) : "—"}</td>
                  <td>{d.memo}</td>
                  <td>
                    {d.voidedAt ? (
                      <span className="badge canceled" title={t("作廢理由：{reason}（沖轉傳票 #{entry}）", { reason: d.voidReason ?? "", entry: d.reversalEntryId ?? "?" })}>
                        {t("已作廢")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <button className="small" onClick={() => void toggleDetail(d.id)}>
                      {expandedId === d.id ? t("收合") : t("沖銷明細")}
                    </button>{" "}
                    {!d.voidedAt && <button className="small" onClick={() => void voidDoc(d)}>{t("作廢")}</button>}
                  </td>
                </tr>
                {expandedId === d.id && details[d.id] && (
                  <tr>
                    <td colSpan={9}>
                      <DetailPanel detail={details[d.id]!} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        )}
      </div>
    </div>
  );
}

/**
 * 沖銷明細（R6）：這張收付款單沖了哪幾張單、各沖多少、那些單現在還剩多少。
 * 修正前立沖關係只在建立當下的回應看得到一次——客戶打來問「7 月匯的那 30,240
 * 是付哪張單」，畫面上查不到。
 */
function DetailPanel({ detail }: { detail: CashDocDetail }) {
  const t = useT();
  const targetLabel = (a: CashDocDetail["allocations"][number]) =>
    a.targetType === "opening" ? t("期初單 #{id}", { id: a.targetId }) : a.targetType === "sale" ? t("銷貨單 #{id}", { id: a.targetId }) : t("進貨單 #{id}", { id: a.targetId });
  return (
    <div style={{ fontSize: 13, padding: "4px 0" }}>
      {detail.allocations.length === 0 ? (
        <p style={{ margin: "4px 0" }}>
          {detail.unappliedAmount > 0
            ? t("這張單沒有指定沖銷任何單據——扣掉預收/預付的部分屬對象層級，帳齡與未沖清單會依日期自動沖該對象最舊的單。")
            : t("這張單沒有指定沖銷任何單據——整筆屬對象層級，帳齡與未沖清單會依日期自動沖該對象最舊的單。")}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("沖銷對象")}</th>
              <th>{t("對象單據日")}</th>
              <th>{t("沖銷方式")}</th>
              <th className="num">{t("沖銷金額")}</th>
              <th className="num" title={t("該單「當下」的未沖餘額（含未指定沖銷收付款的自動分攤）；— 表示原單已作廢或整單沖銷")}>{t("該單目前剩")}</th>
              <th>{t("傳票")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.allocations.map((a, i) => (
              <tr key={i}>
                <td>{targetLabel(a)}</td>
                <td>{a.targetDocDate ?? "—"}</td>
                {/* 立沖含在本單原傳票；事後沖用預收/預付有自己的沖用日與傳票（0027） */}
                <td>{a.fromPrepaid ? t("預收/預付沖用（{date}）", { date: a.allocDate ?? "?" }) : t("建單立沖")}</td>
                <td className="num">{fmt(a.amount)}</td>
                <td className="num">{a.targetRemaining === null ? "—" : fmt(a.targetRemaining)}</td>
                <td>{a.fromPrepaid ? `#${a.journalEntryId ?? "?"}` : detail.journalEntryId ? `#${detail.journalEntryId}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail.unappliedAmount > 0 && (
        <p style={{ margin: "6px 0 0", color: "var(--amber)" }}>
          {detail.kind === "receipt"
            ? t("建單時溢收掛「預收款項」 {amount} 元", { amount: fmt(detail.unappliedAmount) })
            : t("建單時溢付掛「預付貨款」 {amount} 元", { amount: fmt(detail.unappliedAmount) })}
          {detail.voidedAt
            ? t("（本單已作廢，餘額已由反向傳票收回）")
            : t("，已沖用 {used} 元、還剩 {left} 元可在「沖用預收／預付」面板使用", { used: fmt(detail.unappliedAmount - detail.prepaidRemaining), left: fmt(detail.prepaidRemaining) })}
        </p>
      )}
      {detail.voidedAt && detail.allocations.length > 0 && (
        <p style={{ margin: "6px 0 0", color: "var(--text-2)" }}>
          {t("本單已作廢：上列沖銷紀錄僅為軌跡，被沖過的單據未沖餘額已自動回復。")}
        </p>
      )}
    </div>
  );
}

/**
 * 沖用預收／預付（0027，B9）：挑一張還有餘額的收付款單，把餘額沖到之後的單據上。
 * 服務層會生自己的傳票（收款側借「預收款項」貸「應收帳款」；付款側借「應付帳款」貸「預付貨款」），
 * 沖用日受關帳鎖。
 */
function ApplyPrepaidCard({ partners, onApplied }: { partners: Partner[]; onApplied: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<"receipt" | "payment">("receipt");
  const [partnerId, setPartnerId] = useState(0);
  const [applyDate, setApplyDate] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<OpenDocument[]>([]);
  const [fromId, setFromId] = useState(0);
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const load = () =>
    api
      .get<OpenDocument[]>(`/open-documents?partnerId=${partnerId}&kind=${kind}&asOf=${applyDate}`)
      .then(setRows)
      .catch(() => setRows([]));
  useEffect(() => {
    setAlloc({});
    setFromId(0);
    if (!partnerId) {
      setRows([]);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId, kind, applyDate]);

  const eligible = partners.filter((p) => (kind === "receipt" ? p.isCustomer : p.isSupplier));
  const prepaid = rows.filter((d) => d.docType === "prepaid");
  const targets = rows.filter((d) => d.docType !== "prepaid");
  const from = prepaid.find((d) => d.id === fromId);
  const sum = Object.values(alloc).reduce((s, v) => s + (v || 0), 0);
  const label = kind === "receipt" ? t("預收") : t("預付");

  const submit = async () => {
    try {
      if (!from) throw new Error(t("請選要動用的{label}餘額（收付款單）", { label }));
      const allocations = Object.entries(alloc)
        .map(([key, v]) => {
          const [targetType, targetId] = key.split(":");
          return { targetType, targetId: Number(targetId), amount: v || 0 };
        })
        .filter((a) => a.amount > 0);
      if (!allocations.length) throw new Error(t("請在下方填要沖哪幾張單、各沖多少"));
      await api.post(`/cash-docs/${from.id}/apply-prepaid`, { applyDate, allocations });
      setError(null);
      setOkMsg(t("已用{doc} #{id} 的{label}餘額沖銷 {amount} 元（自動拋轉傳票）", { doc: kind === "receipt" ? t("收款單") : t("付款單"), id: from.id, label, amount: fmt(sum) }));
      setAlloc({});
      await load();
      onApplied();
    } catch (e) {
      setOkMsg(null);
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h3>{t("沖用預收／預付（不再收付現金，直接用先前溢收溢付的餘額沖銷單據）")}</h3>
      {error && <div className="error">{error}</div>}
      {okMsg && <p style={{ fontSize: 13, color: "var(--green)" }}>{okMsg}</p>}
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          {t("類別")}
          <select value={kind} onChange={(e) => { setKind(e.target.value as "receipt" | "payment"); setPartnerId(0); }}>
            <option value="receipt">{t("預收（沖客戶的銷貨）")}</option>
            <option value="payment">{t("預付（沖供應商的進貨）")}</option>
          </select>
        </label>
        <label className="field">
          {kind === "receipt" ? t("客戶") : t("供應商")}
          <select value={partnerId} onChange={(e) => setPartnerId(Number(e.target.value))}>
            <option value={0}>{t("— 請選擇 —")}</option>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="field">{t("沖用日")}<input type="date" value={applyDate} onChange={(e) => setApplyDate(e.target.value)} /></label>
        <label className="field">
          {t("動用哪張單的{label}餘額", { label })}
          <select value={fromId} onChange={(e) => { setFromId(Number(e.target.value)); setAlloc({}); }}>
            <option value={0}>{t("— 請選擇 —")}</option>
            {prepaid.map((d) => (
              <option key={d.id} value={d.id}>
                {t("#{id}（{date}，剩 {amount} 元）", { id: d.id, date: d.docDate, amount: fmt(d.remaining) })}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={() => void submit()}>{t("沖銷")}</button>
      </form>
      {partnerId > 0 && prepaid.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          {t("這個對象沒有{label}餘額——只有收付金額超過當時未沖餘額的收付款單才會產生{label}。", { label })}
        </p>
      )}
      {from && targets.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>{kind === "receipt" ? t("沒有可沖銷的未沖單據，先開銷貨單再回來沖。") : t("沒有可沖銷的未沖單據，先開進貨單再回來沖。")}</p>
      )}
      {from && targets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{kind === "receipt" ? t("銷貨單（含期初）") : t("進貨單（含期初）")}</th><th>{t("日期")}</th>
              <th className="num">{t("未沖餘額")}</th><th className="num">{t("本次沖銷")}</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((d) => (
              <tr key={`${d.docType}:${d.id}`}>
                <td>{d.docType === "opening" ? t("期初 #{id}", { id: d.id }) : `#${d.id}`}</td>
                <td>{d.docDate}</td>
                <td className="num">{fmt(d.remaining)}</td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={d.remaining}
                    style={{ width: 90 }}
                    value={alloc[`${d.docType}:${d.id}`] ?? ""}
                    onChange={(e) => setAlloc((m) => ({ ...m, [`${d.docType}:${d.id}`]: Number(e.target.value) }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {from && sum > 0 && (
        <p style={{ fontSize: 13, color: sum > from.remaining ? "var(--red)" : "var(--green)" }}>
          {t("沖銷合計 {sum}／{label}餘額 {amount}", { sum: fmt(sum), label, amount: fmt(from.remaining) })}
          {sum > from.remaining && t("——超過餘額，送出會被擋")}
        </p>
      )}
    </div>
  );
}
