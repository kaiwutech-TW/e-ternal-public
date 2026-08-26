import { ACCOUNT } from "@tw-erp/core";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { fmt, useFetch } from "../hooks.ts";
import { TaxNotes } from "../ui.tsx";
import type { Account, AssetCategoryRow, DepreciationRunResult, DisposalPreview, FixedAssetRow, Partner } from "../types.ts";

export function Assets() {
  const categories = useFetch<AssetCategoryRow[]>("/asset-categories");
  const assets = useFetch<FixedAssetRow[]>("/fixed-assets");
  // 處分價款的收款科目：跟收付款頁同一份來源（isCash），零用金與自建銀行帳戶都收得了
  const accounts = useFetch<Account[]>("/accounts");
  // 處分發票的買受人（0034）：處分單上沒有交易對象，開票時指定
  const partners = useFetch<Partner[]>("/partners");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [taxNotes, setTaxNotes] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [disposingId, setDisposingId] = useState<number | null>(null);
  const [disposeDate, setDisposeDate] = useState(new Date().toISOString().slice(0, 10));
  const [proceeds, setProceeds] = useState(0);
  const [proceedsAccount, setProceedsAccount] = useState("");
  const [taxable, setTaxable] = useState(true);
  const [includeTax, setIncludeTax] = useState(true);
  // 開立發票（0034）："" ＝不開；選 B2B/B2C 時需一併選買受人
  const [invoiceMode, setInvoiceMode] = useState<"" | "B2B" | "B2C">("");
  const [invoicePartnerId, setInvoicePartnerId] = useState(0);
  // 事後補開／作廢重開（POST /fixed-assets/:id/invoice）的目標資產
  const [invoicingId, setInvoicingId] = useState<number | null>(null);
  // 試算（與實際處分同一套計算與檢查）：先看到補提折舊與預計損益，再按送出
  const [preview, setPreview] = useState<DisposalPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const selectedCategory = categories.data?.find((c) => c.key === category);
  const cashAccounts = accounts.data?.filter((a) => a.isCash) ?? [];
  // 預設落在銀行存款（處分價款幾乎都匯款），沒有的話取第一個現金科目
  const defaultCashCode = cashAccounts.find((a) => a.code === ACCOUNT.BANK)?.code ?? cashAccounts[0]?.code ?? "";
  const cashCode = proceedsAccount || defaultCashCode;

  useEffect(() => {
    if (disposingId === null) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const q = new URLSearchParams({
      date: disposeDate,
      proceeds: String(proceeds),
      taxable: String(taxable),
      proceedsIncludeTax: String(includeTax),
    });
    api
      .get<DisposalPreview>(`/fixed-assets/${disposingId}/dispose-preview?${q}`)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setPreviewError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [disposingId, disposeDate, proceeds, taxable, includeTax]);

  const register = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      if (!category) throw new Error("請選資產類別");
      const salvageRaw = String(f.get("salvage") ?? "").trim();
      await api.post("/fixed-assets", {
        name: String(f.get("name")).trim(),
        category,
        cost: Number(f.get("cost")),
        startDate: String(f.get("startDate")),
        ...(f.get("usefulYears") ? { usefulYears: Number(f.get("usefulYears")) } : {}),
        ...(salvageRaw !== "" ? { salvage: Number(salvageRaw) } : {}),
        ...(String(f.get("memo") ?? "").trim() ? { memo: String(f.get("memo")).trim() } : {}),
      });
      setError(null);
      setOk("資產已登錄。提醒：取得入帳（借 設備／貸 銀行或應付款）請至「傳票」頁以手工傳票處理");
      form.reset();
      setCategory("");
      assets.reload();
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  const runDepreciation = async () => {
    try {
      const result = await api.post<DepreciationRunResult>("/depreciations/run", { period });
      setError(null);
      setOk(
        result.count === 0
          ? `${period} 沒有需要計提的資產（都提過或已提足）`
          : `${period} 折舊計提完成：${result.count} 筆、共 $${fmt(result.total)}（${result.items.map((i) => `${i.name} ${fmt(i.amount)}`).join("、")}）`,
      );
      assets.reload();
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  const dispose = async (id: number) => {
    try {
      if (invoiceMode && !invoicePartnerId) throw new Error("要開立發票請選買受人（交易對象）；不開發票請把「開立發票」改回「不開」");
      const r = await api.post<{
        gain: number;
        tax: number;
        catchUp: { count: number; total: number };
        invoice: { invoiceNumber: string } | null;
        taxNotes: string[];
      }>(`/fixed-assets/${id}/dispose`, {
        date: disposeDate,
        proceeds,
        accountCode: cashCode,
        taxable,
        proceedsIncludeTax: includeTax,
        // 同一交易內開立：發票開不出來（字軌用完、B2B 缺統編）整筆處分回滾
        ...(invoiceMode ? { invoice: { mode: invoiceMode, partnerId: invoicePartnerId } } : {}),
      });
      setError(null);
      setOk(
        `資產已處分：${r.gain >= 0 ? `利益 $${fmt(r.gain)}` : `損失 $${fmt(-r.gain)}`}已入帳` +
          (r.catchUp.count > 0 ? `；自動補提折舊 ${r.catchUp.count} 期共 $${fmt(r.catchUp.total)}` : "") +
          (r.invoice ? `；已開立發票 ${r.invoice.invoiceNumber}` : ""),
      );
      setTaxNotes(r.taxNotes ?? []);
      setDisposingId(null);
      assets.reload();
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  /** 事後補開／作廢重開處分發票（0034）：金額＝處分價款、稅額＝處分稅額、發票日＝處分日 */
  const issueInvoice = async (id: number) => {
    try {
      if (!invoicePartnerId) throw new Error("請選買受人（交易對象）");
      const r = await api.post<{ invoiceNumber: string; taxNotes: string[] }>(`/fixed-assets/${id}/invoice`, {
        mode: invoiceMode || "B2B",
        partnerId: invoicePartnerId,
      });
      setError(null);
      setOk(`處分發票已開立：${r.invoiceNumber}（401 銷項將自動涵蓋這筆處分）`);
      setTaxNotes(r.taxNotes ?? []);
      setInvoicingId(null);
      assets.reload();
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  /** 作廢登錄（未提折舊限定；理由必填，資產永久留存並標記） */
  const voidAsset = async (a: FixedAssetRow) => {
    const reason = window.prompt(
      `作廢資產 #${a.id}「${a.name}」：請輸入作廢理由。\n` +
        "登錄不曾拋轉傳票，作廢只做標記；已提折舊的資產走「處分/報廢」而不是作廢。",
    );
    if (reason === null) return;
    try {
      await api.post(`/fixed-assets/${a.id}/void`, { reason: reason.trim() });
      setError(null);
      setOk(`資產 #${a.id} 已作廢`);
      assets.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 作廢處分（處分是誤操作）：反向傳票沖回處分損益／累折／銷項稅額，資產回到使用中 */
  const voidDisposal = async (a: FixedAssetRow) => {
    const reason = window.prompt(
      `作廢資產 #${a.id}「${a.name}」的處分（${a.disposedAt ?? ""}）：請輸入作廢理由。\n` +
        "處分傳票會以反向分錄沖回，資產回到使用中；處分時補提的折舊會留著（那是資產真實存在期間的折舊）。",
    );
    if (reason === null) return;
    try {
      await api.post(`/fixed-assets/${a.id}/dispose/void`, { reason: reason.trim() });
      setError(null);
      setOk(`資產 #${a.id} 的處分已作廢，資產回到使用中`);
      assets.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveEdit = async (a: FixedAssetRow, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const editable = canEditAll(a);
    try {
      await api.patch(`/fixed-assets/${a.id}`, {
        name: String(f.get("name")).trim(),
        memo: String(f.get("memo") ?? "").trim(),
        ...(editable
          ? {
              category: String(f.get("category")),
              cost: Number(f.get("cost")),
              salvage: Number(f.get("salvage")),
              usefulYears: Number(f.get("usefulYears")),
              startDate: String(f.get("startDate")),
            }
          : {}),
      });
      setError(null);
      setOk(`資產 #${a.id} 已更新`);
      setEditingId(null);
      assets.reload();
    } catch (err) {
      setOk(null);
      setError((err as Error).message);
    }
  };

  /** 未提折舊且未處分／未作廢：全部欄位可改；否則只可改名稱與備註（改年限會讓已提折舊無法解釋） */
  const canEditAll = (a: FixedAssetRow) => a.accumulated === 0 && a.status === "active" && !a.voidedAt;

  const statusBadge = (a: FixedAssetRow) => {
    if (a.voidedAt) return <span className="badge canceled">已作廢</span>;
    if (a.status === "disposed") return <span className="badge canceled">已處分 {a.disposedAt ?? ""}</span>;
    return <span className="badge issued">使用中</span>;
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
      <TaxNotes notes={taxNotes} />

      <div className="card">
        <h3>登錄資產（選類別自動帶年限與科目；折舊採平均法，殘值預設 成本÷(年數+1)）</h3>
        <form className="inline" onSubmit={register}>
          <label className="field">名稱<input name="name" required /></label>
          <label className="field">
            類別
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">— 請選擇 —</option>
              {categories.data?.map((c) => (
                <option key={c.key} value={c.key}>{c.label}（{c.years} 年，{c.hint}）</option>
              ))}
            </select>
          </label>
          <label className="field">取得成本<input name="cost" type="number" min={1} required /></label>
          <label className="field">啟用日（當月起提）<input name="startDate" type="date" required /></label>
          <label className="field">耐用年數（可改）<input name="usefulYears" type="number" min={1} placeholder={selectedCategory ? String(selectedCategory.years) : ""} /></label>
          <label className="field">殘值（留空自動算）<input name="salvage" type="number" min={0} /></label>
          <label className="field">備註<input name="memo" /></label>
          <button className="primary">登錄</button>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          登錄只建立折舊基礎，不會自動入帳——取得分錄（借 設備／貸 銀行或其他應付款）請至「傳票」頁開手工傳票；由報銷或進貨取得者該單據已入帳，勿重複。
          登錄打錯可直接「編輯」修正（提折舊前）或「作廢」重登。
        </p>
      </div>

      <div className="card">
        <h3>每月折舊計提（重跑同期間不會重複，只補漏提的資產）</h3>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="field">期間<input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
          <button className="primary" onClick={() => void runDepreciation()}>執行本期折舊</button>
        </form>
      </div>

      <div className="card">
        <h3>資產清單</h3>
        <table>
          <thead>
            <tr>
              <th>名稱</th><th>類別</th><th>啟用日</th>
              <th className="num">成本</th><th className="num">殘值</th><th className="num">月折舊</th>
              <th className="num">累計折舊</th><th className="num">帳面淨值</th><th>已提至</th><th>狀態</th><th></th>
            </tr>
          </thead>
          <tbody>
            {assets.data?.map((a) => (
              <Fragment key={a.id}>
                <tr style={a.voidedAt ? { opacity: 0.55 } : undefined}>
                  <td>{a.name}{a.memo && <span style={{ fontSize: 12, color: "var(--text-2)" }}>（{a.memo}）</span>}</td>
                  <td>{a.categoryLabel}</td>
                  <td>{a.startDate}</td>
                  <td className="num">{fmt(a.cost)}</td>
                  <td className="num">{fmt(a.salvage)}</td>
                  <td className="num">{fmt(a.monthly)}</td>
                  <td className="num">{fmt(a.accumulated)}</td>
                  <td className="num">{fmt(a.bookValue)}</td>
                  <td>{a.lastPeriod ?? "—"}{a.status === "active" && !a.voidedAt && a.remainingDepreciable === 0 && <span style={{ fontSize: 12, color: "var(--text-2)" }}>（已提足）</span>}</td>
                  <td>{statusBadge(a)}{a.voidedAt && a.voidReason && <span style={{ fontSize: 12, color: "var(--text-2)" }}>（{a.voidReason}）</span>}</td>
                  <td>
                    {!a.voidedAt && a.status === "active" && disposingId !== a.id && editingId !== a.id && (
                      <>
                        <button className="small" onClick={() => { setEditingId(a.id); setDisposingId(null); }}>編輯</button>{" "}
                        <button className="small" onClick={() => { setDisposingId(a.id); setEditingId(null); setInvoicingId(null); setProceeds(0); setTaxable(true); setIncludeTax(true); setInvoiceMode(""); setInvoicePartnerId(0); }}>處分/報廢</button>
                        {a.accumulated === 0 && (
                          <>
                            {" "}
                            <button className="small" onClick={() => void voidAsset(a)}>作廢</button>
                          </>
                        )}
                      </>
                    )}
                    {!a.voidedAt && a.status === "disposed" && (
                      <>
                        <button className="small" onClick={() => { setEditingId(a.id); setDisposingId(null); }}>編輯</button>{" "}
                        <button className="small" onClick={() => void voidDisposal(a)}>作廢處分</button>
                        {/* 事後補開／作廢重開（0034）：只有「有價款且有計稅」的處分開得了（服務層把關） */}
                        {(a.disposalTax ?? 0) > 0 && invoicingId !== a.id && (
                          <>
                            {" "}
                            <button className="small" onClick={() => { setInvoicingId(a.id); setDisposingId(null); setInvoiceMode("B2B"); setInvoicePartnerId(0); }}>開立發票</button>
                          </>
                        )}
                      </>
                    )}
                    {invoicingId === a.id && (
                      <button className="small" onClick={() => setInvoicingId(null)}>取消</button>
                    )}
                    {editingId === a.id && (
                      <button className="small" onClick={() => setEditingId(null)}>取消</button>
                    )}
                    {disposingId === a.id && (
                      <button className="small" onClick={() => setDisposingId(null)}>取消</button>
                    )}
                  </td>
                </tr>
                {editingId === a.id && (
                  <tr key={`edit-${a.id}`}>
                    <td colSpan={11}>
                      <form className="inline" onSubmit={(e) => void saveEdit(a, e)}>
                        <label className="field">名稱<input name="name" defaultValue={a.name} required /></label>
                        {canEditAll(a) && (
                          <>
                            <label className="field">
                              類別
                              <select name="category" defaultValue={a.category}>
                                {categories.data?.map((c) => (
                                  <option key={c.key} value={c.key}>{c.label}</option>
                                ))}
                              </select>
                            </label>
                            <label className="field">取得成本<input name="cost" type="number" min={1} defaultValue={a.cost} required /></label>
                            <label className="field">殘值<input name="salvage" type="number" min={0} defaultValue={a.salvage} required /></label>
                            <label className="field">耐用年數<input name="usefulYears" type="number" min={1} defaultValue={a.usefulYears} required /></label>
                            <label className="field">啟用日<input name="startDate" type="date" defaultValue={a.startDate} required /></label>
                          </>
                        )}
                        <label className="field">備註<input name="memo" defaultValue={a.memo} /></label>
                        <button className="primary">儲存</button>
                      </form>
                      {!canEditAll(a) && (
                        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
                          已提折舊（或已處分）的資產只能改名稱與備註——已提各期的金額是按登錄時的成本／殘值／年限算的，改了會讓那些傳票無法解釋。
                        </p>
                      )}
                    </td>
                  </tr>
                )}
                {disposingId === a.id && (
                  <tr key={`dispose-${a.id}`}>
                    <td colSpan={11}>
                      <form className="inline" onSubmit={(e) => { e.preventDefault(); void dispose(a.id); }}>
                        <label className="field">處分日<input type="date" value={disposeDate} onChange={(e) => setDisposeDate(e.target.value)} /></label>
                        <label className="field">處分價款（0＝報廢）<input type="number" min={0} style={{ width: 110 }} value={proceeds} onChange={(e) => setProceeds(Number(e.target.value))} /></label>
                        <label className="field">
                          銷項稅額
                          <select value={taxable ? "y" : "n"} onChange={(e) => setTaxable(e.target.value === "y")}>
                            <option value="y">計稅（拆出銷項稅額）</option>
                            <option value="n">不計稅</option>
                          </select>
                        </label>
                        {taxable && (
                          <label className="field">
                            價款
                            <select value={includeTax ? "y" : "n"} onChange={(e) => setIncludeTax(e.target.value === "y")}>
                              <option value="y">含稅（實收金額）</option>
                              <option value="n">未稅（稅另加）</option>
                            </select>
                          </label>
                        )}
                        <label className="field">
                          收款科目
                          <select value={cashCode} onChange={(e) => setProceedsAccount(e.target.value)}>
                            {cashAccounts.map((acc) => (
                              <option key={acc.id} value={acc.code}>{acc.code} {acc.name}</option>
                            ))}
                          </select>
                        </label>
                        {taxable && proceeds > 0 && (
                          <>
                            <label className="field">
                              開立發票
                              <select value={invoiceMode} onChange={(e) => setInvoiceMode(e.target.value as "" | "B2B" | "B2C")}>
                                <option value="">不開（可事後補開）</option>
                                <option value="B2B">B2B（買方有統編）</option>
                                <option value="B2C">B2C（個人買方）</option>
                              </select>
                            </label>
                            {invoiceMode && (
                              <label className="field">
                                買受人
                                <select value={invoicePartnerId} onChange={(e) => setInvoicePartnerId(Number(e.target.value))}>
                                  <option value={0}>— 請選擇 —</option>
                                  {partners.data?.map((p) => (
                                    <option key={p.id} value={p.id}>{p.name}{p.taxId ? `（${p.taxId}）` : ""}</option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </>
                        )}
                        <button className="small primary" disabled={!preview}>確認處分</button>
                      </form>
                      {preview && (
                        <p style={{ fontSize: 13 }}>
                          試算：
                          {preview.catchUp.count > 0 && <>補提折舊 {preview.catchUp.count} 期 ${fmt(preview.catchUp.total)} → </>}
                          帳面淨值 ${fmt(preview.bookValue)}；未稅價款 ${fmt(preview.netProceeds)}
                          {preview.tax > 0 && <>＋銷項稅額 ${fmt(preview.tax)}（實收 ${fmt(preview.proceeds)}）</>}
                          →{" "}
                          <b style={{ color: preview.gain >= 0 ? "var(--green)" : "var(--red)" }}>
                            {preview.gain >= 0 ? `處分利益 $${fmt(preview.gain)}` : `處分損失 $${fmt(-preview.gain)}`}
                          </b>
                          {preview.tax > 0 && (
                            <>
                              。401 的銷項取數來自發票清單——選「開立發票」會以處分價款
                              ${fmt(preview.proceeds)}（含稅額 ${fmt(preview.tax)}）同時開立，401 自動涵蓋；不開的話請自行開立並確認申報。
                            </>
                          )}
                        </p>
                      )}
                      {previewError && <p style={{ fontSize: 13, color: "var(--red)" }}>試算失敗：{previewError}</p>}
                    </td>
                  </tr>
                )}
                {invoicingId === a.id && (
                  <tr key={`invoice-${a.id}`}>
                    <td colSpan={11}>
                      <form className="inline" onSubmit={(e) => { e.preventDefault(); void issueInvoice(a.id); }}>
                        <label className="field">
                          類型
                          <select value={invoiceMode || "B2B"} onChange={(e) => setInvoiceMode(e.target.value as "B2B" | "B2C")}>
                            <option value="B2B">B2B（買方有統編）</option>
                            <option value="B2C">B2C（個人買方）</option>
                          </select>
                        </label>
                        <label className="field">
                          買受人
                          <select value={invoicePartnerId} onChange={(e) => setInvoicePartnerId(Number(e.target.value))}>
                            <option value={0}>— 請選擇 —</option>
                            {partners.data?.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}{p.taxId ? `（${p.taxId}）` : ""}</option>
                            ))}
                          </select>
                        </label>
                        <button className="small primary">開立</button>
                      </form>
                      <p style={{ fontSize: 13, color: "var(--text-2)" }}>
                        發票金額＝處分價款 ${fmt(a.disposalProceeds ?? 0)}（含銷項稅額 ${fmt(a.disposalTax ?? 0)}）、發票日期＝處分日 {a.disposedAt}。
                        同一筆處分至多一張有效發票；發票開錯可至「電子發票」頁作廢後回這裡重開。
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
