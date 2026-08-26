import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useAuth } from "../auth.ts";
import { fmt, useFetch } from "../hooks.ts";
import type { Employee, Partner, Product } from "../types.ts";
import { EmptyState } from "../ui.tsx";

/** 表單欄位 → API 值：空字串一律轉 null（伺服端擋空字串；null 才是「清空」的語意） */
const textOrNull = (f: FormData, name: string): string | null => {
  const v = String(f.get(name) ?? "").trim();
  return v || null;
};
const intOrNull = (f: FormData, name: string): number | null => {
  const v = String(f.get(name) ?? "").trim();
  return v === "" ? null : Number(v);
};

export function Masters() {
  const me = useAuth();
  // R21：員工主檔的寫入限財務/管理者（API 同此限制）。業務/採購進這頁是為了建客戶建商品，
  // 員工名冊對他們唯讀——原本順手就能新增員工，建了之後任何人都刪不掉
  const canEditEmployees = me.role === "admin" || me.role === "finance";
  const partners = useFetch<Partner[]>("/partners");
  const products = useFetch<Product[]>("/products");
  const employees = useFetch<Employee[]>("/employees");
  const [error, setError] = useState<string | null>(null);
  // 「個人」是 state 而非純表單欄位：勾了要即時換掉識別碼欄位（統編 ↔ 身分證號）
  const [isIndividual, setIsIndividual] = useState(false);
  // 編輯模式：非 null＝表單改成「修改 #id」，key 換掉讓 defaultValue 重新帶入
  const [editingPartner, setEditingPartner] = useState<Partner | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);

  const activeEmployees = (employees.data ?? []).filter((e) => e.active);
  const employeeName = (id: number | null) =>
    id == null ? "—" : (employees.data?.find((e) => e.id === id)?.name ?? `#${id}`);

  // ── 員工 ─────────────────────────────────────────────────────────────
  const submitEmployee = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const payload = {
      name: String(f.get("name") ?? ""),
      title: textOrNull(f, "title"),
      phone: textOrNull(f, "phone"),
      email: textOrNull(f, "email"),
      hireDate: textOrNull(f, "hireDate"),
      note: textOrNull(f, "note"),
    };
    try {
      if (editingEmployee) await api.patch(`/employees/${editingEmployee.id}`, payload);
      else await api.post("/employees", payload);
      setError(null);
      setEditingEmployee(null);
      employees.reload();
      form.reset();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 停用（離職）／復職：停用後不再出現在報銷申請人與業務負責人的選項，歷史單據照樣查得到名字 */
  const toggleEmployeeActive = async (emp: Employee) => {
    try {
      await api.patch(`/employees/${emp.id}`, { active: !emp.active });
      setError(null);
      employees.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── 交易對象 ─────────────────────────────────────────────────────────
  const submitPartner = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const taxId = String(f.get("taxId") ?? "").trim();
    const idNo = String(f.get("idNo") ?? "").trim();
    const shared = {
      name: f.get("name"),
      isCustomer: f.get("isCustomer") === "on",
      isSupplier: f.get("isSupplier") === "on",
      isIndividual,
      contactPerson: textOrNull(f, "contactPerson"),
      phone: textOrNull(f, "phone"),
      email: textOrNull(f, "email"),
      address: textOrNull(f, "address"),
      shipToAddress: textOrNull(f, "shipToAddress"),
      paymentTermDays: intOrNull(f, "paymentTermDays"),
      creditLimit: intOrNull(f, "creditLimit"),
      salesOwnerEmployeeId: intOrNull(f, "salesOwnerEmployeeId"),
      note: textOrNull(f, "note"),
    };
    try {
      if (editingPartner) {
        // 編輯時不碰 idNo（PII 走列上的專用按鈕）；統編清空要送 null（「沒帶」不會清）
        await api.patch(`/partners/${editingPartner.id}`, {
          ...shared,
          ...(isIndividual ? {} : { taxId: taxId || null }),
        });
      } else {
        // 個人與法人的識別碼互斥（伺服端也擋）：勾了個人只送身分證號，沒勾只送統編
        await api.post("/partners", {
          ...shared,
          ...(isIndividual ? (idNo ? { idNo } : {}) : taxId ? { taxId } : {}),
        });
      }
      setError(null);
      setEditingPartner(null);
      partners.reload();
      form.reset();
      setIsIndividual(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEditPartner = (p: Partner) => {
    setEditingPartner(p);
    setIsIndividual(p.isIndividual);
    setError(null);
  };

  /**
   * 既有對象改成個人：扣繳支出單只接受個人，而被擋下來的人多半只是建檔時忘了勾。
   * 改成個人時一併把統編清空（伺服端要求兩者互斥），否則使用者會卡在一個自己解不開的 422。
   */
  const toggleIndividual = async (p: Partner) => {
    try {
      await api.patch(`/partners/${p.id}`, {
        isIndividual: !p.isIndividual,
        ...(!p.isIndividual ? { taxId: null } : {}),
      });
      setError(null);
      partners.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 補填身分證號（年度憑單申報要用）。明文不進任何清單，改完畫面上也只顯示「已填」 */
  const editIdNo = async (p: Partner) => {
    const current = window.prompt(
      `${p.name} 的身分證統一編號／居留證號（年度扣繳憑單申報要用；留空並確定＝清除）`,
      "",
    );
    if (current === null) return;
    try {
      const value = current.trim();
      if (value) await api.patch(`/partners/${p.id}`, { idNo: value });
      else await api.delete(`/partners/${p.id}/id-no`);
      setError(null);
      partners.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── 商品 ─────────────────────────────────────────────────────────────
  const submitProduct = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const shared = {
      name: f.get("name"),
      unit: f.get("unit") || "個",
      listPrice: intOrNull(f, "listPrice"),
      category: textOrNull(f, "category"),
      isService: f.get("isService") === "on",
      minStock: intOrNull(f, "minStock"),
      note: textOrNull(f, "note"),
    };
    try {
      // SKU 不可改（歷史單據與倉庫標籤都對著它），編輯時不送
      if (editingProduct) await api.patch(`/products/${editingProduct.id}`, shared);
      else await api.post("/products", { sku: f.get("sku"), ...shared });
      setError(null);
      setEditingProduct(null);
      products.reload();
      form.reset();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      {/* sticky：商品表單在頁面下半，SKU 撞號的 409 出現在頂端會看不到（實際被使用者回報過） */}
      {error && <div className="error sticky-alert">{error}</div>}

      <div className="card">
        <h3>{editingPartner ? `修改交易對象 #${editingPartner.id}（${editingPartner.name}）` : "新增交易對象"}</h3>
        {/* key 讓編輯對象切換時整張表單重掛、defaultValue 重新帶入（uncontrolled 表單的正規做法） */}
        <form key={editingPartner?.id ?? "new-partner"} className="inline" onSubmit={submitPartner}>
          <label className="field">名稱<input name="name" required defaultValue={editingPartner?.name ?? ""} /></label>
          <label className="field">
            個人
            <input
              type="checkbox"
              name="isIndividual"
              checked={isIndividual}
              onChange={(e) => setIsIndividual(e.target.checked)}
            />
          </label>
          {/* 兩個識別碼欄位互斥顯示：同時出現的話，使用者一定會兩個都填，而伺服端會擋（統編是營利事業的識別碼） */}
          {isIndividual ? (
            !editingPartner && (
              <label className="field">
                身分證統一編號／居留證號
                <input name="idNo" maxLength={20} placeholder="年度扣繳憑單申報要用" />
              </label>
            )
          ) : (
            <label className="field">
              統一編號（選填，會驗檢查碼）
              <input name="taxId" maxLength={8} defaultValue={editingPartner?.taxId ?? ""} />
            </label>
          )}
          <label className="field">客戶<input type="checkbox" name="isCustomer" defaultChecked={editingPartner?.isCustomer ?? false} /></label>
          <label className="field">供應商<input type="checkbox" name="isSupplier" defaultChecked={editingPartner?.isSupplier ?? false} /></label>
          <label className="field">聯絡人<input name="contactPerson" defaultValue={editingPartner?.contactPerson ?? ""} /></label>
          <label className="field">電話<input name="phone" defaultValue={editingPartner?.phone ?? ""} /></label>
          <label className="field">Email（電子發票寄送）<input name="email" defaultValue={editingPartner?.email ?? ""} /></label>
          <label className="field">地址<input name="address" size={28} defaultValue={editingPartner?.address ?? ""} /></label>
          <label className="field">送貨地址（出貨用，可不同於登記地址）<input name="shipToAddress" size={28} defaultValue={editingPartner?.shipToAddress ?? ""} /></label>
          <label className="field">
            付款條件（天，0＝貨到付款，留空＝未約定）
            <input name="paymentTermDays" type="number" min={0} style={{ width: 90 }} defaultValue={editingPartner?.paymentTermDays ?? ""} />
          </label>
          <label className="field">
            信用額度（元，留空＝不設限）
            <input name="creditLimit" type="number" min={0} style={{ width: 110 }} defaultValue={editingPartner?.creditLimit ?? ""} />
          </label>
          <label className="field">
            業務負責人
            <select name="salesOwnerEmployeeId" defaultValue={editingPartner?.salesOwnerEmployeeId ?? ""}>
              <option value="">—</option>
              {activeEmployees.map((emp) => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </select>
          </label>
          <label className="field">備註<input name="note" size={24} defaultValue={editingPartner?.note ?? ""} /></label>
          <button className="primary">{editingPartner ? "儲存修改" : "新增"}</button>
          {editingPartner && (
            <button type="button" className="small" onClick={() => { setEditingPartner(null); setIsIndividual(false); }}>
              取消編輯
            </button>
          )}
        </form>
        {isIndividual && (
          <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0 0" }}>
            勾了「個人」代表對方是自然人（例如個人房東、個人接案者）：付錢給他們時可能有代扣稅款與年度憑單申報的義務——
            要不要扣、扣多少、什麼時候申報，請自行查證（系統沒有門檻與適用情形的模型，不會替你判斷）。
            這類支出請在「扣繳」頁開單，系統會把費用、代扣稅款與實付金額一次記好。
            自然人沒有統一編號，所以統編欄位會換成身分證號（只有申報憑單時才會用到，系統不會把它放進任何清單或匯出檔）。
          </p>
        )}
        {partners.data?.length === 0 && (
          <EmptyState
            icon="👥"
            title="還沒有交易對象"
            desc="客戶和供應商都建在這裡。勾「客戶」的會出現在報價、銷貨的下拉選單；勾「供應商」的出現在進貨——同一家公司可以兩個都勾。"
          />
        )}
        {partners.data && partners.data.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>ID</th><th>名稱</th><th>統編</th><th>聯絡人／電話</th><th>付款條件</th>
              <th className="num">信用額度</th><th>業務負責人</th><th>身分證號</th><th>角色</th><th></th>
            </tr>
          </thead>
          <tbody>
            {partners.data?.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td title={[p.address && `地址：${p.address}`, p.shipToAddress && `送貨：${p.shipToAddress}`, p.note && `備註：${p.note}`].filter(Boolean).join("\n") || undefined}>
                  {p.name}
                  {p.isIndividual && <span className="badge" style={{ marginLeft: 4 }}>個人</span>}
                </td>
                <td>{p.taxId ?? "—"}</td>
                <td>
                  {p.contactPerson ?? "—"}
                  {p.phone && <div style={{ fontSize: 12, color: "var(--text-2)" }}>{p.phone}</div>}
                </td>
                <td>{p.paymentTermDays == null ? "未約定" : p.paymentTermDays === 0 ? "貨到付款" : `月結 ${p.paymentTermDays} 天`}</td>
                <td className="num">{p.creditLimit == null ? "—" : fmt(p.creditLimit)}</td>
                <td>{employeeName(p.salesOwnerEmployeeId)}</td>
                {/* 明文不顯示也不傳到前端（PII）：這一欄只回答「要填年度憑單時抄得出來嗎」 */}
                <td>{p.isIndividual ? (p.hasIdNo ? "已填" : "未填（申報憑單需要）") : "—"}</td>
                <td>{[p.isCustomer && "客戶", p.isSupplier && "供應商"].filter(Boolean).join("、") || "—"}</td>
                <td>
                  <button className="small" onClick={() => startEditPartner(p)}>編輯</button>{" "}
                  <button className="small" onClick={() => void toggleIndividual(p)}>
                    {p.isIndividual ? "改為公司" : "改為個人"}
                  </button>{" "}
                  {p.isIndividual && (
                    <button className="small" onClick={() => void editIdNo(p)}>
                      {p.hasIdNo ? "改身分證號" : "填身分證號"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>

      <div className="card">
        <h3>{editingEmployee ? `修改員工 #${editingEmployee.id}（${editingEmployee.name}）` : "員工（費用報銷、業務負責人用）"}</h3>
        {canEditEmployees ? (
        <form key={editingEmployee?.id ?? "new-employee"} className="inline" onSubmit={submitEmployee}>
          <label className="field">姓名<input name="name" required defaultValue={editingEmployee?.name ?? ""} /></label>
          <label className="field">職稱<input name="title" defaultValue={editingEmployee?.title ?? ""} /></label>
          <label className="field">電話<input name="phone" defaultValue={editingEmployee?.phone ?? ""} /></label>
          <label className="field">Email<input name="email" defaultValue={editingEmployee?.email ?? ""} /></label>
          <label className="field">到職日<input name="hireDate" type="date" defaultValue={editingEmployee?.hireDate ?? ""} /></label>
          <label className="field">備註<input name="note" defaultValue={editingEmployee?.note ?? ""} /></label>
          <button className="primary">{editingEmployee ? "儲存修改" : "新增"}</button>
          {editingEmployee && (
            <button type="button" className="small" onClick={() => setEditingEmployee(null)}>取消編輯</button>
          )}
        </form>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-2)", margin: 0 }}>員工名冊為唯讀——新增或修改請找財務或管理者。</p>
        )}
        {employees.data?.length === 0 && (
          <EmptyState
            icon="🧑‍💼"
            title="還沒有員工"
            desc="費用報銷單要指定申請人，只有這裡建過的人才選得到。跟登入帳號是兩回事——會報帳但不用登入系統的同事，也要建在這裡。"
          />
        )}
        {employees.data && employees.data.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>ID</th><th>姓名</th><th>職稱</th><th>電話</th><th>Email</th><th>到職日</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            {employees.data?.map((emp) => (
              <tr key={emp.id}>
                <td>{emp.id}</td>
                <td>{emp.name}</td>
                <td>{emp.title ?? "—"}</td>
                <td>{emp.phone ?? "—"}</td>
                <td>{emp.email ?? "—"}</td>
                <td>{emp.hireDate ?? "—"}</td>
                <td>{emp.active ? "在職" : <span className="badge canceled">停用</span>}</td>
                <td>
                  {canEditEmployees && (
                    <>
                      <button className="small" onClick={() => setEditingEmployee(emp)}>編輯</button>{" "}
                      {/* 停用＝離職：從報銷申請人與業務負責人的選項消失，歷史單據照樣查得到名字 */}
                      <button className="small" onClick={() => void toggleEmployeeActive(emp)}>
                        {emp.active ? "停用" : "復職"}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>

      <div className="card">
        <h3>{editingProduct ? `修改商品 #${editingProduct.id}（${editingProduct.sku}）` : "新增商品"}</h3>
        <form key={editingProduct?.id ?? "new-product"} className="inline" onSubmit={submitProduct}>
          {/* SKU 不可改：歷史單據與倉庫標籤都對著它；編輯時唯讀展示 */}
          <label className="field">SKU<input name="sku" required={!editingProduct} readOnly={!!editingProduct} defaultValue={editingProduct?.sku ?? ""} /></label>
          <label className="field">品名<input name="name" required defaultValue={editingProduct?.name ?? ""} /></label>
          <label className="field">單位<input name="unit" placeholder="個" defaultValue={editingProduct?.unit ?? ""} /></label>
          <label className="field">
            標準售價（元，留空＝未定價；開單自動帶入、可改）
            <input name="listPrice" type="number" min={0} style={{ width: 110 }} defaultValue={editingProduct?.listPrice ?? ""} />
          </label>
          <label className="field">分類<input name="category" list="product-categories" defaultValue={editingProduct?.category ?? ""} placeholder="打字搜尋既有分類或新增" /></label>
          {/* 既有分類做成 datalist：可打字過濾、也可直接打新分類（分類是自由字串，不是主檔） */}
          <datalist id="product-categories">
            {[...new Set(products.data?.map((p) => p.category).filter((c): c is string => !!c))].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <label className="field">
            服務項目（運費、安裝費、顧問費——不入庫存）
            <input type="checkbox" name="isService" defaultChecked={editingProduct?.isService ?? false} />
          </label>
          <label className="field">
            安全庫存（留空＝不設）
            <input name="minStock" type="number" min={0} style={{ width: 90 }} defaultValue={editingProduct?.minStock ?? ""} />
          </label>
          <label className="field">備註<input name="note" defaultValue={editingProduct?.note ?? ""} /></label>
          <button className="primary">{editingProduct ? "儲存修改" : "新增"}</button>
          {editingProduct && (
            <button type="button" className="small" onClick={() => setEditingProduct(null)}>取消編輯</button>
          )}
        </form>
        {products.data?.length === 0 && (
          <EmptyState
            icon="📦"
            title="還沒有商品"
            desc="報價、銷貨、進貨的品項都從這裡挑。SKU 是你自己的編號規則（例如 A-001）。服務項目（運費、顧問費）也建在這裡——勾「服務項目」就不會過庫存檢查。"
          />
        )}
        {products.data && products.data.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>ID</th><th>SKU</th><th>品名</th><th>單位</th><th>分類</th><th className="num">標準售價</th><th>安全庫存</th><th></th></tr></thead>
          <tbody>
            {products.data?.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{p.sku}</td>
                <td title={p.note ?? undefined}>
                  {p.name}
                  {p.isService && <span className="badge" style={{ marginLeft: 4 }}>服務</span>}
                </td>
                <td>{p.unit}</td>
                <td>{p.category ?? "—"}</td>
                <td className="num">{p.listPrice == null ? "未定價" : fmt(p.listPrice)}</td>
                <td>{p.isService ? "—" : p.minStock ?? "—"}</td>
                <td><button className="small" onClick={() => setEditingProduct(p)}>編輯</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>
    </div>
  );
}
