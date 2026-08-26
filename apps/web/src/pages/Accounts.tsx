import { allowedTypesForCode } from "@tw-erp/core";
import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useFetch } from "../hooks.ts";
import type { Account, AccountType } from "../types.ts";
import { EmptyState } from "../ui.tsx";

const TYPE_LABEL: Record<AccountType, string> = {
  asset: "資產",
  liability: "負債",
  equity: "權益",
  revenue: "收入",
  expense: "費用",
};

/** 首碼提示與新增表單的預設值一致：使用者看得到編碼規則才不會亂編 */
const TYPE_HINT: Record<AccountType, string> = {
  asset: "1 開頭",
  liability: "2 開頭",
  equity: "3 開頭",
  revenue: "4 或 7 開頭（營業收入／營業外收益）",
  expense: "5、6、7、8 開頭（成本／費用／業外損失／所得稅）",
};

/**
 * 這個科目的「類別」欄要不要給下拉選單。
 * 兩種情形都要給：
 * 1. 代號首碼本來就允許多種類別（只有 7xxx 業外收支）；
 * 2. 科目現在的類別根本不在允許清單內＝舊資料留下的錯配科目。
 *    第 2 點是實際踩到的洞：原本只判斷 length > 1，於是 6127 被建成 asset 這種錯配科目
 *    在編輯時只顯示純文字，使用者看得到問題卻無從更正（送出還會被後端擋，等於死路）。
 */
function typeEditable(a: Account): boolean {
  const allowed = allowedTypesForCode(a.code);
  return allowed.length > 1 || !allowed.includes(a.type);
}

export function Accounts() {
  // 維護頁一律連停用科目一起抓：停用的科目要能被找到才點得回啟用
  const accounts = useFetch<Account[]>("/accounts?includeInactive=1");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<
    { id: number; name: string; type: AccountType; originalType: AccountType; isCash: boolean } | null
  >(null);
  const [newType, setNewType] = useState<AccountType>("expense");

  const addAccount = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      const type = String(f.get("type")) as AccountType;
      await api.post("/accounts", {
        code: String(f.get("code") ?? "").trim(),
        name: String(f.get("name") ?? "").trim(),
        type,
        // 只有資產類科目才談得上現金（後端也擋），其餘一律送 false
        isCash: type === "asset" && f.get("isCash") === "on",
      });
      setError(null);
      setNotice(null);
      accounts.reload();
      form.reset();
      setNewType("expense");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const setActive = async (a: Account, active: boolean) => {
    try {
      // 停用有餘額的科目後端不擋，但會回 warning——要顯示出來，否則餘額就這樣被「藏」進停用清單裡
      const res = await api.patch<Account & { warning?: string }>(`/accounts/${a.id}`, { active });
      setError(null);
      setNotice(res.warning ?? null);
      accounts.reload();
    } catch (err) {
      setNotice(null);
      setError((err as Error).message);
    }
  };

  // 只在類別真的被改動時才送 type。無條件送會害「已入帳的錯配科目」連改名都做不到：
  // startEdit 會把錯配科目的類別預設成合法值，於是純改名也變成一次改類別的請求，
  // 後端看到有分錄就回 422，使用者被鎖死。改名與改類別是兩件事，不該綁在一起送。
  const saveEdit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editing) return;
    try {
      const res = await api.patch<Account & { warning?: string }>(`/accounts/${editing.id}`, {
        name: editing.name.trim(),
        ...(editing.type !== editing.originalType ? { type: editing.type } : {}),
        isCash: editing.isCash,
      });
      setError(null);
      setNotice(res.warning ?? null);
      setEditing(null);
      accounts.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // 開啟編輯：錯配科目要把類別預設成第一個合法類別，否則 select 的 value 對不到任何 option。
  // originalType 記的是資料庫裡的原值（可能是錯配的），saveEdit 用它判斷類別到底有沒有被動過
  const startEdit = (a: Account) => {
    const allowed = allowedTypesForCode(a.code);
    setEditing({
      id: a.id,
      name: a.name,
      type: allowed.includes(a.type) ? a.type : (allowed[0] ?? a.type),
      originalType: a.type,
      isCash: a.isCash,
    });
  };

  const all = accounts.data ?? [];
  const rows = showInactive ? all : all.filter((a) => a.active);
  const inactiveCount = all.filter((a) => !a.active).length;

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="card">
        <h3>新增科目</h3>
        <form className="inline" onSubmit={addAccount}>
          <label className="field">科目代號（4 碼數字）<input name="code" required maxLength={4} placeholder="6121" /></label>
          <label className="field">科目名稱<input name="name" required placeholder="租金支出" /></label>
          <label className="field">
            類別
            <select name="type" value={newType} onChange={(e) => setNewType(e.target.value as AccountType)}>
              {(Object.keys(TYPE_LABEL) as AccountType[]).map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t]}（{TYPE_HINT[t]}）</option>
              ))}
            </select>
          </label>
          {/* 現金科目只對資產類有意義，選其他類別時直接不顯示（後端也會擋） */}
          {newType === "asset" && (
            <label className="field" title="勾了以後，這個科目的收付會被算進現金流量表與儀表板的現金水位">
              <input type="checkbox" name="isCash" />
              現金科目
            </label>
          )}
          <button className="primary">新增</button>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          編碼規則：1 資產、2 負債、3 權益、4 營業收入、5 營業成本、6 營業費用、7 營業外收支、8 所得稅。
          代號首碼與類別必須相符（例如 6 開頭一定是費用），選錯會被擋下。
          代號一經建立就不能改（歷史傳票會對不起來）——打錯代號請停用後另建一個；
          若只是類別選錯，在該科目「還沒入過帳」之前可以直接改（7 開頭的業外科目才有收入／費用可選）。
          建好科目後要記期初餘額，請到「傳票」頁開一張開帳傳票。
        </p>
        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          新增自己的銀行帳戶科目（例如 1104 銀行存款－玉山）時記得勾「現金科目」：
          勾了它才會被算進現金流量表與儀表板的現金水位，也才會出現在收付款、報銷付款、
          資產處分價款的科目下拉選單。沒勾的話，錢照樣記在帳上（試算表、資產負債表都看得到），
          但現金流量表會完全看不到這個帳戶的進出——期末現金就會和資產負債表對不起來。
        </p>
      </div>

      <div className="card">
        <h3>科目一覽（{rows.length} 個）</h3>
        <label className="field" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          顯示已停用科目（{inactiveCount} 個）
        </label>

        {accounts.data?.length === 0 && (
          <EmptyState
            icon="📒"
            title="還沒有會計科目"
            desc="科目表應該在系統初始化時就灌好。若這裡是空的，代表 seed 沒跑到，請執行 pnpm --filter @tw-erp/api migrate 後重新整理。"
          />
        )}

        {rows.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr><th>代號</th><th>名稱</th><th>類別</th><th>現金科目</th><th>狀態</th><th>操作</th></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} style={a.active ? undefined : { opacity: 0.55 }}>
                  <td>{a.code}</td>
                  <td>
                    {editing?.id === a.id ? (
                      <form className="inline" onSubmit={saveEdit}>
                        <input
                          value={editing.name}
                          autoFocus
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        />
                        <button className="small">儲存</button>
                        <button type="button" className="small" onClick={() => setEditing(null)}>取消</button>
                      </form>
                    ) : (
                      a.name
                    )}
                  </td>
                  <td>
                    {/* 給 select 的條件有兩種情形：
                        (1) 7xxx 一個首碼對應兩種類別，本來就要選；
                        (2) 這個科目「現在的類別」不在代號首碼允許的清單裡＝舊資料的錯配科目，
                            退成純文字就等於沒有更正途徑（送出還會被後端 400 擋，卻連改都改不了）。 */}
                    {editing?.id === a.id && typeEditable(a) ? (
                      <select
                        value={editing.type}
                        onChange={(e) => {
                          const type = e.target.value as AccountType;
                          // 改成非資產類就一併取消現金科目（現金只對資產類有意義，後端也擋）
                          setEditing({ ...editing, type, isCash: type === "asset" ? editing.isCash : false });
                        }}
                      >
                        {allowedTypesForCode(a.code).map((t) => (
                          <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                        ))}
                      </select>
                    ) : (
                      TYPE_LABEL[a.type]
                    )}
                    {!allowedTypesForCode(a.code).includes(a.type) && (
                      <span
                        className="badge canceled"
                        title={`代號 ${a.code.charAt(0)}xxx 與類別「${TYPE_LABEL[a.type]}」不符，這個科目的金額在報表上會缺席。請按編輯改成正確類別`}
                      >
                        類別不符
                      </span>
                    )}
                  </td>
                  <td>
                    {editing?.id === a.id && (editing.type === "asset" || editing.isCash) ? (
                      <label title="勾了以後，這個科目的收付會被算進現金流量表與儀表板的現金水位">
                        <input
                          type="checkbox"
                          checked={editing.isCash}
                          disabled={editing.type !== "asset"}
                          onChange={(e) => setEditing({ ...editing, isCash: e.target.checked })}
                        />{" "}
                        納入現金流量表
                      </label>
                    ) : a.isCash ? (
                      <span className="badge issued" title="現金流量表與現金水位會算進這個科目">現金</span>
                    ) : (
                      ""
                    )}
                  </td>
                  <td>
                    {a.isSystem && <span className="badge" title="系統科目：進銷貨、收付款、折舊、報銷、年度結轉的自動分錄直接指定這個代號">系統</span>}
                    {a.active ? <span className="badge issued">啟用中</span> : <span className="badge canceled">已停用</span>}
                  </td>
                  <td>
                    {editing?.id !== a.id && (
                      <button className="small" onClick={() => startEdit(a)}>編輯</button>
                    )}{" "}
                    {a.isSystem ? (
                      // 系統科目不可停用；但「已經是停用狀態」的系統科目必須給得回啟用的路，
                      // 否則自動分錄永遠過不了帳（正常情況下 seed 會在啟動時自動扳回啟用）
                      a.active ? (
                        <span style={{ fontSize: 12, color: "var(--text-2)" }}>系統科目不可停用</span>
                      ) : (
                        <button className="small" onClick={() => setActive(a, true)}>啟用（系統科目停用中會讓單據過不了帳）</button>
                      )
                    ) : a.active ? (
                      <button className="small" onClick={() => setActive(a, false)}>停用</button>
                    ) : (
                      <button className="small" onClick={() => setActive(a, true)}>啟用</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style={{ fontSize: 13, color: "var(--text-2)" }}>
          停用不是刪除：已經記過帳的科目永遠留在系統裡，明細分類帳與報表照樣查得到，
          停用只是讓它不再出現在傳票、收付款、報銷的下拉選單，且停用後不能再對它過帳。
          停用還有餘額的科目不會被阻擋，但會提示餘額金額——要把餘額轉走請先開一張手工傳票。
          標示「系統」的科目被自動分錄直接指定，停用了進銷貨就無法過帳，因此不開放停用（名稱仍可改）。
          勾了「現金科目」的科目會被算進現金流量表與儀表板現金水位；預設科目表內建的
          1101 庫存現金、1102 零用金、1103 銀行存款一律是現金科目，改了會在下次啟動時被系統校正回來。
        </p>
      </div>
    </div>
  );
}
