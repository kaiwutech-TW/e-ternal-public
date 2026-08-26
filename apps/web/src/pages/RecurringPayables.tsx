import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmt, useFetch } from "../hooks.ts";
import type { Account, Partner } from "../types.ts";

/**
 * 週期性支出（0047）：每月／每季／每年固定要付出去的錢。
 *
 * 零斷言紀律在這一頁有三個落點，改文案前先看 services/recurring-payables.ts 的檔頭：
 *  ① 頻率下拉**只能是純算術命名**（每月／每季／每年）——不得出現任何以稅目或險種
 *     命名的範本選項，那等於系統告訴你誰該多久繳一次。
 *  ② 依據欄必填，**placeholder 不得舉任何例子**（含金額、月份、法規名稱）——
 *     在寫的人眼裡是說明，在用的人眼裡是預設答案。
 *  ③ 提醒文案的主詞只能是「你設定的」，不得出現期限／日前／應於／逾期未申報。
 */
interface Payable {
  id: number;
  name: string;
  partnerId: number | null;
  partnerName: string | null;
  defaultAccountCode: string | null;
  basis: string;
  intervalMonths: number;
  dayOfMonth: number;
  defaultAmount: number;
  startDate: string;
  endDate: string | null;
  status: "active" | "ended";
  memo: string;
}

interface Item {
  id: number;
  seq: number;
  dueDate: string;
  amount: number;
  description: string;
  expenseClaimId: number | null;
  journalEntryId: number | null;
  settled: boolean;
}

/** 純算術的頻率快捷。名稱只描述「多久一次」，不描述「什麼東西該這樣繳」 */
const INTERVALS = [
  { months: 1, label: "每月" },
  { months: 2, label: "每 2 個月" },
  { months: 3, label: "每季（3 個月）" },
  { months: 6, label: "每半年（6 個月）" },
  { months: 12, label: "每年（12 個月）" },
];

const intervalLabel = (n: number) => INTERVALS.find((i) => i.months === n)?.label ?? `每 ${n} 個月`;

function ItemPanel({ payable, onError }: { payable: Payable; onError: (m: string | null) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [settlingId, setSettlingId] = useState<number | null>(null);
  const [mode, setMode] = useState<"claim" | "entry">("entry");
  const [docId, setDocId] = useState("");

  const reload = () =>
    api.get<Item[]>(`/recurring-payables/${payable.id}/items`).then(setItems).catch((e) => onError((e as Error).message));
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [payable.id]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
      onError(null);
      setSettlingId(null);
      setDocId("");
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const planned = items?.reduce((s, i) => s + i.amount, 0) ?? 0;
  const settled = items?.filter((i) => i.settled).reduce((s, i) => s + i.amount, 0) ?? 0;

  return (
    <tr>
      <td colSpan={8} style={{ background: "var(--bg)", padding: 12 }}>
        <strong>付款計畫</strong>（已結清 {fmt(settled)}／已排 {fmt(planned)}）
        <form
          className="inline"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(() => api.post(`/recurring-payables/${payable.id}/items/generate`, { to: String(f.get("to")) }));
          }}
        >
          <label className="field">
            展開到
            <input name="to" type="date" required defaultValue={payable.endDate ?? ""} />
          </label>
          <button className="small">依「{intervalLabel(payable.intervalMonths)}、{payable.dayOfMonth} 號」展開排程</button>
        </form>
        {items && items.length > 0 && (
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr><th>期</th><th>預計付款日</th><th className="num">金額</th><th>說明</th><th>狀態</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.seq}</td>
                  <td>{i.dueDate}</td>
                  <td className="num">{fmt(i.amount)}</td>
                  <td>{i.description || "—"}</td>
                  <td>
                    {i.settled ? (
                      <span className="badge issued">
                        {i.expenseClaimId !== null ? `報銷單 #${i.expenseClaimId}` : `傳票 #${i.journalEntryId}`}
                      </span>
                    ) : (
                      <span className="badge canceled">未結清</span>
                    )}
                  </td>
                  <td>
                    {i.settled ? (
                      <button className="small" onClick={() => void act(() => api.post(`/recurring-payables/${payable.id}/items/${i.id}/unsettle`, {}))}>
                        解除結清
                      </button>
                    ) : settlingId === i.id ? (
                      <>
                        <select value={mode} onChange={(e) => setMode(e.target.value as "claim" | "entry")}>
                          <option value="entry">手工傳票</option>
                          <option value="claim">報銷單</option>
                        </select>{" "}
                        <input
                          style={{ width: 90 }}
                          type="number"
                          min={1}
                          placeholder="單號"
                          value={docId}
                          onChange={(e) => setDocId(e.target.value)}
                        />{" "}
                        <button
                          className="small"
                          disabled={!docId}
                          onClick={() =>
                            void act(() =>
                              api.post(`/recurring-payables/${payable.id}/items/${i.id}/settle`, {
                                [mode === "claim" ? "expenseClaimId" : "journalEntryId"]: Number(docId),
                              }),
                            )
                          }
                        >
                          確認結清
                        </button>{" "}
                        <button className="small" onClick={() => setSettlingId(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <button className="small" onClick={() => setSettlingId(i.id)}>結清</button>{" "}
                        <button className="small" onClick={() => void act(() => api.delete(`/recurring-payables/${payable.id}/items/${i.id}`))}>刪除</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          結清＝把你**已經開好**的那張單指過來，這裡不會生成任何單據，也不會產生任何分錄。
          付款走報銷單（費用報銷頁，選「公司支付」）或手工傳票（傳票頁）都可以；
          房租、軟體訂閱、專業服務費目前不在報銷分類清單裡，走手工傳票。
          指向的報銷單被作廢，這一期會自動回到未結清。
        </p>
      </td>
    </tr>
  );
}

export function RecurringPayables() {
  const payables = useFetch<Payable[]>("/recurring-payables");
  const partners = useFetch<Partner[]>("/partners");
  const accounts = useFetch<Account[]>("/accounts");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showEnded, setShowEnded] = useState(false);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      setError(null);
      setOk(okMsg ?? null);
    } catch (e) {
      setOk(null);
      setError((e as Error).message);
    }
  };

  const rows = payables.data?.filter((p) => showEnded || p.status === "active") ?? [];

  return (
    <div>
      {error && <div className="error sticky-alert">{error}</div>}
      {ok && <div className="ok">{ok}</div>}

      <div className="card">
        <h3>新增一筆固定支出</h3>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            const val = (k: string) => String(f.get(k) ?? "").trim();
            void act(async () => {
              await api.post("/recurring-payables", {
                name: val("name"),
                basis: val("basis"),
                intervalMonths: Number(f.get("intervalMonths")),
                dayOfMonth: Number(f.get("dayOfMonth")),
                defaultAmount: Number(f.get("defaultAmount") || 0),
                startDate: val("startDate"),
                ...(val("endDate") ? { endDate: val("endDate") } : {}),
                ...(Number(val("partnerId")) ? { partnerId: Number(val("partnerId")) } : {}),
                ...(val("defaultAccountCode") ? { defaultAccountCode: val("defaultAccountCode") } : {}),
                ...(val("memo") ? { memo: val("memo") } : {}),
              });
              form.reset();
              payables.reload();
            }, "已新增。展開排程後，到期的期會出現在首頁");
          }}
        >
          <label className="field">名稱<input name="name" required style={{ width: 160 }} /></label>
          <label className="field">
            多久一次
            <select name="intervalMonths" defaultValue={1}>
              {INTERVALS.map((i) => <option key={i.months} value={i.months}>{i.label}</option>)}
            </select>
          </label>
          <label className="field">幾號<input name="dayOfMonth" type="number" min={1} max={31} defaultValue={5} required style={{ width: 70 }} /></label>
          <label className="field">每期金額<input name="defaultAmount" type="number" min={0} required style={{ width: 110 }} /></label>
          <label className="field">從<input name="startDate" type="date" required /></label>
          <label className="field">到（選填）<input name="endDate" type="date" /></label>
          <label className="field">
            對象（選填）
            <select name="partnerId" defaultValue={0}>
              <option value={0}>— 無 —</option>
              {partners.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            費用科目（選填）
            <select name="defaultAccountCode" defaultValue="">
              <option value="">— 無 —</option>
              {accounts.data?.filter((a) => a.type === "expense" && a.active).map((a) => (
                <option key={a.id} value={a.code}>{a.code} {a.name}</option>
              ))}
            </select>
          </label>
          {/* placeholder 刻意不舉任何例子：舉了就會被照抄，「自己查、自己留出處」的設計會失效 */}
          <label className="field" style={{ minWidth: 260 }}>
            依據（必填）<input name="basis" required placeholder="這個金額與頻率是從哪裡來的" />
          </label>
          <label className="field">備註<input name="memo" /></label>
          <button className="primary">新增</button>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          這一頁是**計畫**：不會產生任何分錄，也不會進應付帳款。
          金額與頻率全部由你填，系統只做日期算術——它不知道、也不會告訴你什麼錢該多久付一次、
          什麼時候該付。展開排程後，接近付款日的期會出現在首頁。
        </p>
      </div>

      <div className="card">
        <h3>
          固定支出清單{" "}
          <label style={{ fontSize: 13, fontWeight: 400 }}>
            <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> 含已停用
          </label>
        </h3>
        <table>
          <thead>
            <tr><th>名稱</th><th>頻率</th><th className="num">每期金額</th><th>對象</th><th>科目</th><th>依據</th><th>狀態</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <>
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{intervalLabel(p.intervalMonths)}・{p.dayOfMonth} 號</td>
                  <td className="num">{fmt(p.defaultAmount)}</td>
                  <td>{p.partnerName ?? "—"}</td>
                  <td>{p.defaultAccountCode ?? "—"}</td>
                  <td style={{ color: "var(--text-3)", maxWidth: 220 }}>{p.basis}</td>
                  <td><span className={`badge ${p.status === "active" ? "issued" : "canceled"}`}>{p.status === "active" ? "使用中" : "已停用"}</span></td>
                  <td>
                    <button className="small" onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}>
                      {expandedId === p.id ? "收合" : "付款計畫"}
                    </button>{" "}
                    <button
                      className="small"
                      onClick={() =>
                        void act(async () => {
                          await api.patch(`/recurring-payables/${p.id}`, { status: p.status === "active" ? "ended" : "active" });
                          payables.reload();
                        })
                      }
                    >
                      {p.status === "active" ? "停用" : "啟用"}
                    </button>
                  </td>
                </tr>
                {expandedId === p.id && <ItemPanel payable={p} onError={setError} />}
              </>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p style={{ fontSize: 13, color: "var(--text-2)" }}>還沒有固定支出。</p>}
      </div>
    </div>
  );
}
