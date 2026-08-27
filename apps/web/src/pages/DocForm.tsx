import { useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.ts";
import { fmt, useFetch } from "../hooks.ts";
import { TaxNotes } from "../ui.tsx";
import type { Partner, PartnerBalance, Product } from "../types.ts";

interface Line {
  productId: number;
  qty: number;
  unitPrice: number;
}

/** 進貨/銷貨共用的單據建立表單（動態明細列） */
export function DocForm(props: {
  kind: "purchases" | "sales";
  partners: Partner[];
  products: Product[];
  onCreated: () => void;
  onError: (msg: string | null) => void;
}) {
  const t = useT();
  const isSales = props.kind === "sales";
  const eligible = props.partners.filter((p) => (isSales ? p.isCustomer : p.isSupplier));
  const [partnerId, setPartnerId] = useState<number>(0);
  const [docDate, setDocDate] = useState(new Date().toISOString().slice(0, 10));
  // 收款到期日（銷貨）／付款到期日（進貨，0033）：留空＝依對象付款條件自動推算（沒約定＝不設）
  const [dueDate, setDueDate] = useState("");
  // 課稅別（0028，B12，僅銷貨）：一個下拉表達「應稅／零稅率經海關／零稅率非經海關」——
  // 經海關與否落在 401 不同欄位，必須在建單時就說清楚，不能留給系統猜
  const [taxKind, setTaxKind] = useState<"taxable" | "zeroCustoms" | "zeroNonCustoms">("taxable");
  const [zeroCertNo, setZeroCertNo] = useState("");
  const isZero = isSales && taxKind !== "taxable";
  const [lines, setLines] = useState<Line[]>([{ productId: 0, qty: 1, unitPrice: 0 }]);
  // 伺服端回的稅法參數警告（例如：找不到涵蓋單據日期的營業稅率，用了既有預設值）。
  // 這種事**不可以靜默**：系統替使用者做了一個他不知道的決定，就得說出來
  const [taxNotes, setTaxNotes] = useState<string[]>([]);
  // 客戶未收餘額 vs 信用額度的提示（僅銷貨）。只提示不擋單——授信是商業判斷不是系統判斷
  const balances = useFetch<PartnerBalance[]>(isSales ? "/partner-balances" : null);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  /** 選到商品時帶入標準售價當預設單價（可改）；買進的價格跟售價無關，進貨不帶 */
  const pickProduct = (i: number, productId: number) => {
    const product = props.products.find((p) => p.id === productId);
    setLine(i, {
      productId,
      ...(isSales && product?.listPrice != null ? { unitPrice: product.listPrice } : {}),
    });
  };

  const selectedPartner = eligible.find((p) => p.id === partnerId);
  const arBalance = balances.data?.find((b) => b.partnerId === partnerId)?.ar ?? 0;
  const draftSubtotal = lines.reduce((s, l) => s + (l.productId ? Math.round(l.qty * l.unitPrice) : 0), 0);
  const creditLimit = selectedPartner?.creditLimit ?? null;
  const overLimit = creditLimit != null && arBalance + draftSubtotal > creditLimit;

  const submit = async () => {
    try {
      if (!partnerId) throw new Error(props.kind === "purchases" ? t("請選供應商") : t("請選客戶"));
      const valid = lines.filter((l) => l.productId && l.qty > 0);
      if (!valid.length) throw new Error(t("至少一筆有效明細"));
      const created = await api.post<{ taxNotes?: string[] }>(`/${props.kind}`, {
        partnerId,
        docDate,
        lines: valid,
        ...(dueDate ? { dueDate } : {}),
        ...(isZero
          ? {
              taxType: "2",
              zeroTaxViaCustoms: taxKind === "zeroCustoms",
              ...(zeroCertNo.trim() ? { zeroTaxCertNo: zeroCertNo.trim() } : {}),
            }
          : {}),
      });
      setTaxNotes(created.taxNotes ?? []);
      props.onError(null);
      props.onCreated();
      setLines([{ productId: 0, qty: 1, unitPrice: 0 }]);
      setDueDate("");
      setTaxKind("taxable");
      setZeroCertNo("");
      balances.reload();
    } catch (e) {
      setTaxNotes([]);
      props.onError((e as Error).message);
    }
  };

  return (
    <div>
      <TaxNotes notes={taxNotes} />
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          {props.kind === "purchases" ? t("供應商") : t("客戶")}
          <select value={partnerId} onChange={(e) => setPartnerId(Number(e.target.value))}>
            <option value={0}>{t("— 請選擇 —")}</option>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="field">{t("日期")}<input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} /></label>
        {/* 到期日兩側都有（銷貨 0022、進貨 0033）：帳齡按它分逾期桶 */}
        <label className="field">
          {(() => {
            const days = selectedPartner?.paymentTermDays;
            const term = days == null ? "" : days === 0 ? t("貨到付款") : t("{n} 天", { n: days });
            if (isSales) {
              return days != null
                ? t("收款到期日（留空＝依客戶付款條件：{term}）", { term })
                : t("收款到期日（留空＝依客戶付款條件，此客戶未約定）");
            }
            return days != null
              ? t("付款到期日（留空＝依供應商付款條件：{term}）", { term })
              : t("付款到期日（留空＝依供應商付款條件，此供應商未約定）");
          })()}
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        {isSales && (
          /* 課稅別（0028，B12）：經海關與否落在 401 不同欄位，所以是三選一而不是勾選框。
             免稅刻意不列——免稅（兼營）要用 403 申報，本系統只支援 401，列了就是誘導錯報 */
          <label className="field">
            {t("課稅別")}
            <select value={taxKind} onChange={(e) => setTaxKind(e.target.value as typeof taxKind)}>
              <option value="taxable">{t("應稅")}</option>
              <option value="zeroCustoms">{t("零稅率（經海關出口）")}</option>
              <option value="zeroNonCustoms">{t("零稅率（非經海關）")}</option>
            </select>
          </label>
        )}
        {isZero && (
          <label className="field">
            {taxKind === "zeroCustoms" ? t("出口報單號碼（可留空，之後補登）") : t("外匯證明等文件號碼（可留空，之後補登）")}
            <input
              value={zeroCertNo}
              onChange={(e) => setZeroCertNo(e.target.value)}
              maxLength={50}
              placeholder={t("系統不驗證文件內容")}
            />
          </label>
        )}
      </form>
      {isZero && (
        <p style={{ fontSize: 13, margin: "6px 0 0", color: "var(--text-2)" }}>
          {t("零稅率單稅額為 0、收入記「銷貨收入－零稅率」。申報零稅率銷售額需檢附證明文件（經海關＝出口報單；非經海關＝取得外匯證明文件等）——號碼還沒拿到可先開單，之後回到銷貨單列表補登；系統只登錄號碼，不驗證文件真偽。")}
        </p>
      )}
      {isSales && selectedPartner && (
        /* 未收餘額與信用額度：超過只提示、照樣能送出——額度是給業務判斷用的參考線，不是系統的門 */
        <p style={{ fontSize: 13, margin: "6px 0 0", color: overLimit ? "var(--red)" : "var(--text-2)" }}>
          {t("{name} 目前未收餘額 {ar} 元", { name: selectedPartner.name, ar: fmt(arBalance) })}
          {creditLimit != null ? t("／信用額度 {limit} 元", { limit: fmt(creditLimit) }) : t("（未設信用額度）")}
          {overLimit && t("——本單未稅 {amount} 元加上未收餘額將超過信用額度，是否續開請自行斟酌（系統不擋）", { amount: fmt(draftSubtotal) })}
        </p>
      )}
      {lines.map((l, i) => (
        <form key={i} className="inline" style={{ marginTop: 8 }} onSubmit={(e) => e.preventDefault()}>
          <label className="field">
            {t("商品")}
            <select value={l.productId} onChange={(e) => pickProduct(i, Number(e.target.value))}>
              <option value={0}>{t("— 請選擇 —")}</option>
              {props.products.map((p) => (
                <option key={p.id} value={p.id}>{p.sku} {p.name}{p.isService ? t("（服務）") : ""}</option>
              ))}
            </select>
          </label>
          <label className="field">{t("數量")}<input type="number" min={0} value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} /></label>
          <label className="field">{t("單價（未稅）")}<input type="number" min={0} step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} /></label>
          {i === lines.length - 1 && (
            <button className="small" onClick={() => setLines((ls) => [...ls, { productId: 0, qty: 1, unitPrice: 0 }])}>
              {t("＋明細")}
            </button>
          )}
        </form>
      ))}
      <div style={{ marginTop: 12 }}>
        {/* 原本這顆按鈕寫「稅額 5% 自動計算」——那是系統在斷言稅率，而稅率是使用者填的資料。
            現在只說明**做了什麼**（依單據日期查你設定的費率），不說那個費率是多少 */}
        <button className="primary" onClick={submit}>
          {props.kind === "purchases" ? t("建立進貨單（依單據日期套用你設定的營業稅率、自動拋轉傳票）") : t("建立銷貨單（依單據日期套用你設定的營業稅率、自動拋轉傳票）")}
        </button>
      </div>
    </div>
  );
}
