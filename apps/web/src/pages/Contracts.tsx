import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useAuth } from "../auth.ts";
import { fmt, useFetch } from "../hooks.ts";
import { useT } from "../i18n.ts";
import type { BillingDueRow, ContractRow, DocRow, InstallmentRow, Partner, Product } from "../types.ts";

/** 中文＝字典 key，使用處 t() */
const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  active: "生效中",
  ended: "已結案",
  terminated: "已終止",
};

const KIND_LABEL: Record<string, string> = {
  project: "專案",
  retainer: "顧問月費",
  maintenance: "維護",
  other: "其他",
};

/** 0046：方向與類型正交——sale 我開請款單；purchase 對方發票來、我勾對付款 */
const DIRECTION_LABEL: Record<string, string> = {
  sale: "銷貨（我方請款）",
  purchase: "進貨（我方付款）",
};

const EXPIRY_SOON_DAYS = 45;

/**
 * 請款計畫面板（0037）：一份合約展開後的分期列表＋開單。
 * 「開單」就是開一張真的銷貨單——稅額、到期日、關帳鎖全部走既有規則，
 * 這裡只是把「這期該請多少」帶進去；開錯了作廢那張銷貨單，本期自動回到未請款。
 */
function InstallmentPanel({
  contract,
  serviceProducts,
  canWrite,
  onError,
}: {
  contract: ContractRow;
  serviceProducts: Product[];
  canWrite: boolean;
  onError: (msg: string | null) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<InstallmentRow[] | null>(null);
  const [billingId, setBillingId] = useState<number | null>(null);
  const [productId, setProductId] = useState(0);
  // 進貨側（0046）：勾對候選＝該供應商未作廢的進貨單（一張只能勾一期，已勾的排除）
  const [candidates, setCandidates] = useState<DocRow[]>([]);
  const [purchaseId, setPurchaseId] = useState(0);
  const isPurchase = contract.direction === "purchase";

  const reload = () =>
    api.get<InstallmentRow[]>(`/contracts/${contract.id}/installments`).then(setItems).catch((e) => onError((e as Error).message));
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [contract.id]);
  useEffect(() => {
    if (!isPurchase || contract.partnerId === null) return;
    api
      .get<DocRow[]>(`/purchases?partnerId=${contract.partnerId}&limit=100`)
      .then((rows) => setCandidates(rows.filter((p) => !p.voidedAt)))
      .catch((e) => onError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.id, isPurchase, contract.partnerId]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
      onError(null);
      setBillingId(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const addRow = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    return act(async () => {
      await api.post(`/contracts/${contract.id}/installments`, {
        items: [{
          dueDate: String(f.get("dueDate")),
          amount: Number(f.get("amount")),
          ...(String(f.get("description") ?? "").trim() ? { description: String(f.get("description")).trim() } : {}),
        }],
      });
      form.reset();
    });
  };

  const generate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    return act(() =>
      api.post(`/contracts/${contract.id}/installments/generate`, {
        monthlyAmount: Number(f.get("monthlyAmount")),
        dayOfMonth: Number(f.get("dayOfMonth")),
        from: String(f.get("from")),
        to: String(f.get("to")),
      }),
    );
  };

  const bill = (installmentId: number) =>
    act(() =>
      api.post(`/contracts/${contract.id}/installments/${installmentId}/bill`, {
        productId,
        docDate: new Date().toISOString().slice(0, 10),
      }),
    );

  const match = (installmentId: number) =>
    act(async () => {
      await api.post(`/contracts/${contract.id}/installments/${installmentId}/match`, { purchaseId });
      setPurchaseId(0);
    });
  const unmatch = (installmentId: number) =>
    act(() => api.post(`/contracts/${contract.id}/installments/${installmentId}/unmatch`, {}));

  // 一張進貨單只能勾一期：本合約已勾走的從候選中排除（跨合約的由 API 擋）
  const linkedPurchaseIds = new Set(items?.map((i) => i.purchaseId).filter((x) => x !== null));
  const openCandidates = candidates.filter((p) => !linkedPurchaseIds.has(p.id));

  const planned = items?.reduce((s, i) => s + i.amount, 0) ?? 0;
  const billed = items?.filter((i) => i.billed).reduce((s, i) => s + i.amount, 0) ?? 0;

  return (
    <tr>
      <td colSpan={10} style={{ background: "var(--bg)", padding: 12 }}>
        <strong>{isPurchase ? t("付款計畫") : t("請款計畫")}</strong>
        {isPurchase
          ? t("（金額為未稅；已對上 {billed}／已排 {planned}", { billed: fmt(billed), planned: fmt(planned) })
          : t("（金額為未稅；已請 {billed}／已排 {planned}", { billed: fmt(billed), planned: fmt(planned) })}
        {contract.amount != null && planned !== contract.amount && (
          <span style={{ color: "var(--amber)" }}>
            {t("；與合約金額 {amount} 不一致——可能是保留款或未排完，請自行確認", { amount: fmt(contract.amount) })}
          </span>
        )}
        {t("）")}
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>{t("期")}</th><th>{isPurchase ? t("預計付款日") : t("預計請款日")}</th><th className="num">{t("金額（未稅）")}</th><th>{t("說明")}</th><th>{t("狀態")}</th><th></th></tr>
          </thead>
          <tbody>
            {items?.map((i) => (
              <tr key={i.id}>
                <td>{i.seq}</td>
                <td>{i.dueDate}</td>
                <td className="num">{fmt(i.amount)}</td>
                <td>{i.description}</td>
                <td>
                  {i.billed ? (
                    <span className="badge issued">{i.purchaseId !== null ? t("已勾對進貨單 #{id}", { id: i.purchaseId }) : t("已開單 #{id}", { id: i.saleId })}</span>
                  ) : (
                    <span className="badge canceled">{isPurchase ? t("未對上") : t("未請款")}</span>
                  )}
                </td>
                <td>
                  {canWrite && i.billed && isPurchase && i.purchaseId !== null && (
                    <button className="small" onClick={() => void unmatch(i.id)}>{t("解除勾對")}</button>
                  )}
                  {canWrite && !i.billed && contract.status === "active" && (
                    billingId === i.id ? (
                      isPurchase ? (
                        <>
                          <select value={purchaseId} onChange={(e) => setPurchaseId(Number(e.target.value))}>
                            <option value={0}>{t("— 勾對哪張進貨單 —")}</option>
                            {openCandidates.map((p) => (
                              <option key={p.id} value={p.id}>{t("#{id}｜{date}｜未稅 {subtotal}", { id: p.id, date: p.docDate, subtotal: fmt(p.subtotal) })}</option>
                            ))}
                          </select>{" "}
                          <button className="small" disabled={!purchaseId} onClick={() => void match(i.id)}>{t("確認勾對")}</button>{" "}
                          <button className="small" onClick={() => setBillingId(null)}>{t("取消")}</button>
                        </>
                      ) : (
                        <>
                          <select value={productId} onChange={(e) => setProductId(Number(e.target.value))}>
                            <option value={0}>{t("— 用哪個服務項目開單 —")}</option>
                            {serviceProducts.map((p) => (
                              <option key={p.id} value={p.id}>{p.sku} {p.name}</option>
                            ))}
                          </select>{" "}
                          <button className="small" disabled={!productId} onClick={() => void bill(i.id)}>{t("確認開單")}</button>{" "}
                          <button className="small" onClick={() => setBillingId(null)}>{t("取消")}</button>
                        </>
                      )
                    ) : (
                      <>
                        <button className="small" onClick={() => setBillingId(i.id)}>{isPurchase ? t("勾對進貨單") : t("開銷貨單")}</button>{" "}
                        <button
                          className="small"
                          onClick={() => void act(() => api.delete(`/contracts/${contract.id}/installments/${i.id}`))}
                        >
                          {t("刪除")}
                        </button>
                      </>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items?.length === 0 && <p style={{ fontSize: 13, color: "var(--text-2)" }}>{isPurchase ? t("尚未排付款計畫。") : t("尚未排請款計畫。")}</p>}
        {canWrite && contract.status !== "terminated" && (
          <>
            <form className="inline" style={{ marginTop: 8 }} onSubmit={addRow}>
              <label className="field">{isPurchase ? t("付款日") : t("請款日")}<input name="dueDate" type="date" required /></label>
              <label className="field">{t("金額（未稅）")}<input name="amount" type="number" min={1} required /></label>
              <label className="field">{t("說明")}<input name="description" placeholder={isPurchase ? t("第一季授權費…") : t("簽約金 30%…")} /></label>
              <button className="small">{t("＋加一期")}</button>
            </form>
            {contract.kind === "retainer" && (
              <form className="inline" style={{ marginTop: 4 }} onSubmit={generate}>
                <label className="field">{t("月費（未稅）")}<input name="monthlyAmount" type="number" min={1} required /></label>
                <label className="field">{isPurchase ? t("每月幾號付款") : t("每月幾號請款")}<input name="dayOfMonth" type="number" min={1} max={31} defaultValue={1} required /></label>
                <label className="field">{t("從")}<input name="from" type="date" defaultValue={contract.startDate} required /></label>
                <label className="field">{t("到")}<input name="to" type="date" defaultValue={contract.endDate ?? ""} required /></label>
                <button className="small">{t("一鍵展開整段月費排程")}</button>
              </form>
            )}
          </>
        )}
        {isPurchase && contract.partnerId === null && canWrite && (
          <p style={{ fontSize: 13, color: "var(--amber)" }}>
            {t("這份合約沒有連結供應商——勾對進貨單前請先在合約上選擇交易對象。")}
          </p>
        )}
        {isPurchase && contract.partnerId !== null && openCandidates.length === 0 && canWrite && (
          <p style={{ fontSize: 13, color: "var(--text-2)" }}>
            {t("這個供應商目前沒有可勾對的進貨單。對方發票寄到後，先到「進貨」登記進貨單，再回這裡勾對。")}
          </p>
        )}
        {!isPurchase && serviceProducts.length === 0 && canWrite && (
          <p style={{ fontSize: 13, color: "var(--amber)" }}>
            {t("開單前請先到「客戶與商品」建一個服務項目（勾「服務」，例如「顧問服務費」）——合約請款開的是銷貨單，需要一個服務項目當品項。")}
          </p>
        )}
      </td>
    </tr>
  );
}

export function Contracts() {
  const t = useT();
  // R21：sales/purchasing/gm 唯讀（API 的寫入限 admin/finance）——合約是他們談的、
  // 到期提醒最該給他們看，但金額與狀態是財務數字的依據，登記與修改歸口財務
  const me = useAuth();
  const canWrite = me.role === "admin" || me.role === "finance";
  const contracts = useFetch<ContractRow[]>("/contracts");
  const partners = useFetch<Partner[]>("/partners");
  const products = useFetch<Product[]>("/products");
  const billingDue = useFetch<BillingDueRow[]>("/contracts/billing-due?within=30");
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const serviceProducts = products.data?.filter((p) => p.isService) ?? [];
  // 0046：登記表單的方向（控制 partner 下拉的過濾）＋清單的方向篩選
  const [formDirection, setFormDirection] = useState<"sale" | "purchase">("sale");
  const [dirFilter, setDirFilter] = useState<"" | "sale" | "purchase">("");

  const renew = async (c: ContractRow) => {
    // 預設新約：舊約截止日翌日起、同長度。日期可之後在新約上編輯——先成鏈再微調
    const start = c.endDate
      ? new Date(new Date(`${c.endDate}T00:00:00Z`).getTime() + 86400_000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const end =
      c.endDate && c.startDate
        ? new Date(
            new Date(`${start}T00:00:00Z`).getTime() +
              (new Date(`${c.endDate}T00:00:00Z`).getTime() - new Date(`${c.startDate}T00:00:00Z`).getTime()),
          ).toISOString().slice(0, 10)
        : undefined;
    try {
      await api.post(`/contracts/${c.id}/renew`, { startDate: start, ...(end ? { endDate: end } : {}) });
      setError(null);
      contracts.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const soonLimit = new Date(Date.now() + EXPIRY_SOON_DAYS * 86400_000).toISOString().slice(0, 10);
  const expiringSoon = (c: ContractRow) =>
    c.status === "active" && !!c.endDate && c.endDate >= today && c.endDate <= soonLimit;
  const expired = (c: ContractRow) => c.status === "active" && !!c.endDate && c.endDate < today;

  const onFile = (f: File | null) => {
    if (!f) return setFile(null);
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result);
      if (data.length > 5_000_000) {
        setError(t("附件過大（上限約 3.5MB），請壓縮後再上傳"));
        setFile(null);
        return;
      }
      setFile({ name: f.name, data });
      setError(null);
    };
    reader.readAsDataURL(f);
  };

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? "").trim();
    try {
      await api.post("/contracts", {
        counterparty: val("counterparty"),
        title: val("title"),
        kind: val("kind") || "project",
        direction: formDirection,
        ...(val("partnerId") && Number(val("partnerId")) ? { partnerId: Number(val("partnerId")) } : {}),
        ...(val("amount") ? { amount: Number(val("amount")) } : {}),
        ...(val("signDate") ? { signDate: val("signDate") } : {}),
        startDate: val("startDate"),
        ...(val("endDate") ? { endDate: val("endDate") } : {}),
        ...(val("memo") ? { memo: val("memo") } : {}),
        ...(file ? { fileName: file.name, fileData: file.data } : {}),
      });
      setError(null);
      setFile(null);
      contracts.reload();
      e.currentTarget?.reset?.();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const setStatus = async (id: number, status: string) => {
    try {
      await api.patch(`/contracts/${id}`, { status });
      setError(null);
      contracts.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 編輯（B4）：金額談錯、展期改截止日、改名都要有出路——PATCH 原本只收 status/memo，
  // 其他欄位被靜默丟棄（單送 amount 甚至 500）。合約的「取消」是終止（status），不是作廢
  const [editingId, setEditingId] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ title: string; amount: string; endDate: string; memo: string }>({ title: "", amount: "", endDate: "", memo: "" });
  const startEdit = (c: ContractRow) => {
    setEditingId(c.id);
    setEdit({ title: c.title, amount: c.amount != null ? String(c.amount) : "", endDate: c.endDate ?? "", memo: c.memo ?? "" });
  };
  const saveEdit = async (id: number) => {
    try {
      await api.patch(`/contracts/${id}`, {
        ...(edit.title.trim() ? { title: edit.title.trim() } : {}),
        ...(edit.amount !== "" ? { amount: Number(edit.amount) } : {}),
        ...(edit.endDate ? { endDate: edit.endDate } : {}),
        ...(edit.memo.trim() ? { memo: edit.memo.trim() } : {}),
      });
      setError(null);
      setEditingId(null);
      contracts.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const downloadFile = async (id: number) => {
    try {
      const { fileName, fileData } = await api.get<{ fileName: string; fileData: string }>(`/contracts/${id}/file`);
      const a = Object.assign(document.createElement("a"), { href: fileData, download: fileName || `contract-${id}` });
      a.click();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const soonCount = contracts.data?.filter(expiringSoon).length ?? 0;
  const expiredCount = contracts.data?.filter(expired).length ?? 0;

  return (
    <div>
      {error && <div className="error sticky-alert">{error}</div>}
      {(soonCount > 0 || expiredCount > 0) && (
        <div className="error" style={{ background: "var(--amber-tint)", color: "var(--amber)" }}>
          {expiredCount > 0 && t("有 {n} 份生效中合約已過截止日，請處理續約或結案。", { n: expiredCount })}
          {soonCount > 0 && ` ${t("{n} 份合約將於 {days} 天內到期。", { n: soonCount, days: EXPIRY_SOON_DAYS })}`}
        </div>
      )}

      {(["sale", "purchase"] as const).map((dir) => {
        const due = billingDue.data?.filter((d) => d.direction === dir) ?? [];
        if (!due.length) return null;
        const hasOverdue = due.some((d) => d.overdue);
        return (
          <div className="card" key={dir}>
            <h3>
              {dir === "sale"
                ? (hasOverdue ? t("待請款（30 天內，含逾期）") : t("待請款（30 天內）"))
                : (hasOverdue ? t("待付款（30 天內，含逾期）") : t("待付款（30 天內）"))}
            </h3>
            <table>
              <thead>
                <tr><th>{t("合約")}</th><th>{t("期")}</th><th>{dir === "sale" ? t("預計請款日") : t("預計付款日")}</th><th className="num">{t("金額（未稅）")}</th><th>{t("說明")}</th></tr>
              </thead>
              <tbody>
                {due.map((d) => (
                  <tr key={d.installmentId} style={d.overdue ? { background: "var(--red-tint)" } : undefined}>
                    <td>#{d.contractId} {d.contractTitle}（{d.counterparty}）</td>
                    <td>{d.seq}</td>
                    <td>{d.dueDate}{d.overdue && t("（已逾期）")}</td>
                    <td className="num">{fmt(d.amount)}</td>
                    <td>{d.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 13, color: "var(--text-2)" }}>
              {dir === "sale"
                ? t("點下方清單的「請款計畫」展開該合約即可開單。")
                : t("對方發票寄到後先登記進貨單，再到下方「付款計畫」勾對；這裡是現金流的預告。")}
            </p>
          </div>
        );
      })}

      {canWrite && (
      <div className="card">
        <h3>{t("登記合約")}</h3>
        <form className="inline" onSubmit={add}>
          <label className="field">
            {t("方向")}
            <select value={formDirection} onChange={(e) => setFormDirection(e.target.value as "sale" | "purchase")}>
              {Object.entries(DIRECTION_LABEL).map(([v, label]) => (
                <option key={v} value={v}>{t(label)}</option>
              ))}
            </select>
          </label>
          <label className="field">{t("合約名稱")}<input name="title" required /></label>
          <label className="field">
            {t("類型")}
            <select name="kind" defaultValue="project">
              {Object.entries(KIND_LABEL).map(([v, label]) => (
                <option key={v} value={v}>{t(label)}</option>
              ))}
            </select>
          </label>
          <label className="field">{t("對方名稱")}<input name="counterparty" required /></label>
          <label className="field">
            {t("關聯交易對象（選填）")}
            <select name="partnerId" defaultValue={0}>
              <option value={0}>{t("— 無 —")}</option>
              {partners.data
                ?.filter((p) => (formDirection === "sale" ? p.isCustomer : p.isSupplier))
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
            </select>
          </label>
          <label className="field">{t("金額（選填）")}<input name="amount" type="number" min={0} /></label>
          <label className="field">{t("簽約日")}<input name="signDate" type="date" /></label>
          <label className="field">{t("生效日")}<input name="startDate" type="date" required /></label>
          <label className="field">{t("截止日（選填）")}<input name="endDate" type="date" /></label>
          <label className="field">{t("備註")}<input name="memo" /></label>
          <label className="field">{t("附件（PDF/圖片）")}<input type="file" accept=".pdf,image/*" onChange={(e) => onFile(e.target.files?.[0] ?? null)} /></label>
          <button className="primary">{t("登記")}</button>
        </form>
      </div>
      )}

      <div className="card">
        <h3>
          {t("合約清單")}{" "}
          <select style={{ fontSize: 13, fontWeight: 400 }} value={dirFilter} onChange={(e) => setDirFilter(e.target.value as "" | "sale" | "purchase")}>
            <option value="">{t("全部方向")}</option>
            <option value="sale">{t("銷貨（我方請款）")}</option>
            <option value="purchase">{t("進貨（我方付款）")}</option>
          </select>
        </h3>
        <table>
          <thead>
            <tr><th>{t("編號")}</th><th>{t("方向")}</th><th>{t("類型")}</th><th>{t("名稱")}</th><th>{t("對方")}</th><th className="num">{t("金額")}</th><th>{t("生效日")}</th><th>{t("截止日")}</th><th>{t("狀態")}</th><th></th></tr>
          </thead>
          <tbody>
            {contracts.data?.filter((c) => !dirFilter || c.direction === dirFilter).map((c) => (
              <>
              <tr key={c.id} style={expired(c) ? { background: "var(--red-tint)" } : expiringSoon(c) ? { background: "var(--amber-tint)" } : undefined}>
                <td>#{c.id}{c.renewedFromId && <span style={{ fontSize: 12, color: "var(--text-2)" }}>{t("（續自 #{id}）", { id: c.renewedFromId })}</span>}</td>
                <td>{c.direction === "purchase" ? t("進貨") : t("銷貨")}</td>
                <td>{t(KIND_LABEL[c.kind] ?? c.kind)}</td>
                <td>
                  {editingId === c.id ? (
                    <input style={{ width: 140 }} value={edit.title} onChange={(e) => setEdit((v) => ({ ...v, title: e.target.value }))} />
                  ) : (
                    c.title
                  )}
                </td>
                <td>{c.counterparty}</td>
                <td className="num">
                  {editingId === c.id ? (
                    <input type="number" min={0} style={{ width: 110 }} value={edit.amount} onChange={(e) => setEdit((v) => ({ ...v, amount: e.target.value }))} />
                  ) : c.amount != null ? (
                    fmt(c.amount)
                  ) : (
                    "—"
                  )}
                </td>
                <td>{c.startDate}</td>
                <td>
                  {editingId === c.id ? (
                    <input type="date" value={edit.endDate} onChange={(e) => setEdit((v) => ({ ...v, endDate: e.target.value }))} />
                  ) : (
                    <>{c.endDate ?? "—"}{expiringSoon(c) && t("（將到期）")}{expired(c) && t("（已逾期）")}</>
                  )}
                </td>
                <td><span className={`badge ${c.status === "active" ? "issued" : "canceled"}`}>{t(STATUS_LABEL[c.status] ?? c.status)}</span></td>
                <td>
                  {editingId === c.id ? (
                    <>
                      <button className="small" onClick={() => void saveEdit(c.id)}>{t("儲存")}</button>{" "}
                      <button className="small" onClick={() => setEditingId(null)}>{t("取消")}</button>
                    </>
                  ) : (
                    <>
                      {c.hasFile && <button className="small" onClick={() => void downloadFile(c.id)}>{t("附件")}</button>}{" "}
                      {canWrite && (
                        <>
                          <button className="small" onClick={() => startEdit(c)}>{t("編輯")}</button>{" "}
                          {c.status === "active" && (
                            <>
                              <button className="small" onClick={() => void setStatus(c.id, "ended")}>{t("結案")}</button>{" "}
                              <button className="small" onClick={() => void setStatus(c.id, "terminated")}>{t("終止")}</button>
                            </>
                          )}
                          {c.status === "draft" && (
                            <button className="small" onClick={() => void setStatus(c.id, "active")}>{t("生效")}</button>
                          )}
                          {(expiringSoon(c) || expired(c)) && (
                            <button className="small" onClick={() => void renew(c)}>{t("續約")}</button>
                          )}
                        </>
                      )}{" "}
                      <button className="small" onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}>
                        {expandedId === c.id ? t("收合") : c.direction === "purchase" ? t("付款計畫") : t("請款計畫")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
              {expandedId === c.id && (
                <InstallmentPanel
                  contract={c}
                  serviceProducts={serviceProducts}
                  canWrite={canWrite}
                  onError={setError}
                />
              )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
