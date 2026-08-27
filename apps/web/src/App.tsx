import { PAGE_INFO, ROLE_LABELS, canAccessPage, type PageKey } from "@tw-erp/core";
import {
  Banknote,
  BarChart3,
  Moon,
  Sun,
  MonitorCog,
  CalendarClock,
  CalendarSync,
  Fingerprint,
  BookOpen,
  Building2,
  ClipboardList,
  Coins,
  FileOutput,
  FileSignature,
  Landmark,
  LayoutDashboard,
  ListTree,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Scale,
  Settings as SettingsIcon,
  Ticket,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
  Languages,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { AgentChat } from "./AgentChat.tsx";
import { AuthContext } from "./auth.ts";
import { getThemePref, setThemePref, useEffectiveTheme, type ThemePref } from "./theme.ts";
import { LOCALE_LABEL, setLocale, useLocale, useT } from "./i18n.ts";
import { NavContext } from "./ui.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Assets } from "./pages/Assets.tsx";
import { Attendance } from "./pages/Attendance.tsx";
import { CashDocs } from "./pages/CashDocs.tsx";
import { Payroll } from "./pages/Payroll.tsx";
import { RecurringPayables } from "./pages/RecurringPayables.tsx";
import { Hr } from "./pages/Hr.tsx";
import { Contracts } from "./pages/Contracts.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Expenses } from "./pages/Expenses.tsx";
import { Exports } from "./pages/Exports.tsx";
import { Invoices } from "./pages/Invoices.tsx";
import { Journal } from "./pages/Journal.tsx";
import { Login } from "./pages/Login.tsx";
import { Masters } from "./pages/Masters.tsx";
import { Orders } from "./pages/Orders.tsx";
import { Purchases } from "./pages/Purchases.tsx";
import { Reports } from "./pages/Reports.tsx";
import { Sales } from "./pages/Sales.tsx";
import { TaxParameters } from "./pages/TaxParameters.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Vat } from "./pages/Vat.tsx";
import { Withholding } from "./pages/Withholding.tsx";
import type { AuthUser } from "./types.ts";

interface PageDef {
  key: PageKey;
  label: string;
  desc: string; // 頁首一句話：這頁是做什麼的、怎麼用
  group: string;
  /** 側欄圖示（lucide：單色線條、粗細一致——emoji 的彩色雜訊在密集清單裡顯得廉價） */
  icon: LucideIcon;
  el: JSX.Element;
}

const PAGES: PageDef[] = [
  { key: "dashboard", icon: LayoutDashboard, group: "日常工作", el: <Dashboard />, ...PAGE_INFO["dashboard"] },
  { key: "orders", icon: ClipboardList, group: "日常工作", el: <Orders />, ...PAGE_INFO["orders"] },
  { key: "sales", icon: Truck, group: "日常工作", el: <Sales />, ...PAGE_INFO["sales"] },
  { key: "purchases", icon: Package, group: "日常工作", el: <Purchases />, ...PAGE_INFO["purchases"] },
  { key: "attendance", icon: Fingerprint, group: "日常工作", el: <Attendance />, ...PAGE_INFO["attendance"] },
  { key: "expenses", icon: Receipt, group: "日常工作", el: <Expenses />, ...PAGE_INFO["expenses"] },
  { key: "contracts", icon: FileSignature, group: "日常工作", el: <Contracts />, ...PAGE_INFO["contracts"] },
  { key: "masters", icon: Users, group: "基本資料", el: <Masters />, ...PAGE_INFO["masters"] },
  { key: "accounts", icon: ListTree, group: "基本資料", el: <Accounts />, ...PAGE_INFO["accounts"] },
  { key: "cash", icon: Wallet, group: "財務", el: <CashDocs />, ...PAGE_INFO["cash"] },
  { key: "assets", icon: Building2, group: "財務", el: <Assets />, ...PAGE_INFO["assets"] },
  { key: "journal", icon: BookOpen, group: "財務", el: <Journal />, ...PAGE_INFO["journal"] },
  { key: "payroll", icon: Banknote, group: "財務", el: <Payroll />, ...PAGE_INFO["payroll"] },
  { key: "recurring", icon: CalendarSync, group: "財務", el: <RecurringPayables />, ...PAGE_INFO["recurring"] },
  { key: "reports", icon: BarChart3, group: "財務", el: <Reports />, ...PAGE_INFO["reports"] },
  { key: "invoices", icon: Ticket, group: "稅務申報", el: <Invoices />, ...PAGE_INFO["invoices"] },
  { key: "vat", icon: Landmark, group: "稅務申報", el: <Vat />, ...PAGE_INFO["vat"] },
  { key: "withholding", icon: Coins, group: "稅務申報", el: <Withholding />, ...PAGE_INFO["withholding"] },
  { key: "tax-parameters", icon: Scale, group: "稅務申報", el: <TaxParameters />, ...PAGE_INFO["tax-parameters"] },
  { key: "exports", icon: FileOutput, group: "稅務申報", el: <Exports />, ...PAGE_INFO["exports"] },
  { key: "hr", icon: CalendarClock, group: "基本資料", el: <Hr />, ...PAGE_INFO["hr"] },
  { key: "settings", icon: SettingsIcon, group: "系統", el: <Settings />, ...PAGE_INFO["settings"] },
];

const GROUPS = ["日常工作", "基本資料", "財務", "稅務申報", "系統"];

/** 目前網址對應的頁面 key（/contracts → "contracts"）。伺服端任何路徑都回 index.html（SPA fallback） */
const pathPage = () => decodeURIComponent(window.location.pathname.replace(/^\//, ""));

export function App() {
  // undefined = 還在確認登入狀態；null = 未登入
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  // 側欄狀態：collapsed＝桌面縮成圖示欄（記在 localStorage，重開瀏覽器維持）；
  // mobileOpen＝手機版抽屜（預設收起，選完頁自動關）
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("nav-collapsed") === "1");
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem("nav-collapsed", v ? "0" : "1");
      return !v;
    });
  };
  // 收合態的懸浮提示：overflow-y:auto 會裁掉 CSS 絕對定位的 tooltip，
  // 改用一顆 position:fixed 的元素、進入時記下按鈕的垂直位置
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);

  // ⌘/Ctrl+B 切換側欄（VS Code／Linear 的同一個慣例鍵）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 頁面 key 與網址同步：重新整理停在原頁、可加書籤、上一頁可用。
  // 初始值直接從網址來——登入前就記住使用者想去哪，登入後直接落地
  const [page, setPageState] = useState<string>(pathPage());
  const setPage = (key: string) => {
    setPageState(key);
    if (pathPage() !== key) window.history.pushState(null, "", `/${key}`);
  };

  useEffect(() => {
    const onPop = () => setPageState(pathPage());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 網址指向的頁不存在或無權限時，實際顯示的是第一個可用頁——把網址改成真的在看的那頁
  //（replaceState 不進歷史，避免上一頁按鈕在壞網址間打轉）
  useEffect(() => {
    if (!user) return;
    const allowed = PAGES.filter((p) => canAccessPage(user.role, p.key));
    const cur = allowed.find((p) => p.key === page) ?? allowed[0]!;
    if (pathPage() !== cur.key) window.history.replaceState(null, "", `/${cur.key}`);
  }, [user, page]);

  useEffect(() => {
    (async () => {
      try {
        const status = await api.get<{ needsSetup: boolean }>("/auth/setup-status");
        setNeedsSetup(status.needsSetup);
        if (status.needsSetup) {
          setUser(null);
          return;
        }
        setUser(await api.get<AuthUser>("/auth/me"));
      } catch {
        setUser(null);
      }
    })();
    const onUnauthorized = () => setUser(null);
    window.addEventListener("api-unauthorized", onUnauthorized);
    return () => window.removeEventListener("api-unauthorized", onUnauthorized);
  }, []);

  // 主題偏好（hook 必須在任何條件 return 之前——放後面會炸 React #310）
  const [themePref, setThemePrefState] = useState<ThemePref>(getThemePref);
  // 語言：zh-TW／en 兩段輪替（形狀比照外觀鈕；偏好與 <html lang> 由 i18n.ts 管）
  const locale = useLocale();
  const t = useT();
  const cycleLocale = () => setLocale(locale === "en" ? "zh-TW" : "en");
  const effectiveTheme = useEffectiveTheme();
  const cycleTheme = () => {
    // 三段循環：跟隨系統 → 淺色 → 深色 → 跟隨系統
    const next: ThemePref = themePref === "system" ? "light" : themePref === "light" ? "dark" : "system";
    setThemePref(next);
    setThemePrefState(next);
  };

  if (user === undefined) return null;
  if (!user) {
    return (
      <Login
        needsSetup={needsSetup}
        onLogin={(u) => {
          setUser(u);
          setNeedsSetup(false);
          // 刻意不清 page：登入前記在網址上的目的地（書籤、被登出前看的頁）登入後直接落地
        }}
      />
    );
  }

  const pages = PAGES.filter((p) => canAccessPage(user.role, p.key));
  const current = pages.find((p) => p.key === page) ?? pages[0]!;

  const logout = async () => {
    try {
      await api.post("/auth/logout", {});
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider value={user}>
      <NavContext.Provider value={(key) => { setPage(key); setMobileOpen(false); }}>
        <div className="layout">
          {/* 手機版的開關（CSS 只在窄螢幕顯示）；抽屜開著時給一層背板點擊即關 */}
          <button className="menu-fab" onClick={() => setMobileOpen(true)} aria-label={t("開啟選單")}><Menu size={20} /></button>
          {mobileOpen && <div className="nav-backdrop" onClick={() => setMobileOpen(false)} />}
          <nav className={`sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}>
            <div className="sidebar-head">
              {/* 深淺色各一張圖：深色變體把 navy 抬亮（CSS 濾鏡調不出來，離線產好）。
                  用 effectiveTheme 而不是 <picture> media query——手動選的主題 media query 看不見 */}
              <img className="brand-badge" src={effectiveTheme === "dark" ? "/mark-dark.png" : "/mark.png"} alt="" aria-hidden />
              <h1 className="brand-name">E-ternal</h1>
            </div>
            {GROUPS.map((group) => {
              const items = pages.filter((p) => p.group === group);
              if (!items.length) return null;
              return (
                <div key={group}>
                  {pages.length > 3 && <div className="group">{t(group)}</div>}
                  {items.map((p) => (
                    <button
                      key={p.key}
                      className={p.key === current.key ? "active" : ""}
                      onClick={() => { setPage(p.key); setMobileOpen(false); }}
                      onMouseEnter={(e) => {
                        if (!collapsed || mobileOpen) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        setTip({ label: t(p.label), top: r.top + r.height / 2 });
                      }}
                      onMouseLeave={() => setTip(null)}
                    >
                      <span className="nav-icon" aria-hidden><p.icon size={18} strokeWidth={1.8} /></span>
                      <span className="nav-label">{t(p.label)}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            <button className="collapse-btn" onClick={toggleCollapsed} title="⌘/Ctrl+B">
              <span className="nav-icon" aria-hidden>
                {collapsed ? <PanelLeftOpen size={18} strokeWidth={1.8} /> : <PanelLeftClose size={18} strokeWidth={1.8} />}
              </span>
              <span className="nav-label">{t("收合側邊欄")}</span>
            </button>
            <button className="collapse-btn" style={{ marginTop: 0 }} onClick={cycleTheme} title={t("外觀：淺色／深色／跟隨系統")}>
              <span className="nav-icon" aria-hidden>
                {themePref === "light" ? <Sun size={18} strokeWidth={1.8} /> : themePref === "dark" ? <Moon size={18} strokeWidth={1.8} /> : <MonitorCog size={18} strokeWidth={1.8} />}
              </span>
              <span className="nav-label">{t("外觀：")}{themePref === "light" ? t("淺色") : themePref === "dark" ? t("深色") : t("跟隨系統")}</span>
            </button>
            <button className="collapse-btn" style={{ marginTop: 0 }} onClick={cycleLocale} title={`${t("語言")}: ${LOCALE_LABEL[locale]}`}>
              <span className="nav-icon" aria-hidden><Languages size={18} strokeWidth={1.8} /></span>
              <span className="nav-label">{t("語言")}：{LOCALE_LABEL[locale]}</span>
            </button>
            <div className="user-box" style={{ paddingTop: 14, borderTop: "1px solid var(--line)" }}>
              <div style={{ fontSize: 12.5, color: "var(--text-2)", padding: "4px 10px" }}>
                {t("{name}（{role}）", { name: user.displayName, role: t(ROLE_LABELS[user.role]) })}
              </div>
              <button onClick={() => void logout()}>{t("登出")}</button>
            </div>
          </nav>
          {tip && collapsed && !mobileOpen && (
            <div className="nav-tooltip" style={{ top: tip.top }}>{tip.label}</div>
          )}
          <AgentChat />
          <main className="main" key={current.key}>
            <div className="page-header">
              <h2>{t(current.label)}</h2>
              <div className="desc">{t(current.desc)}</div>
            </div>
            {current.el}
          </main>
        </div>
      </NavContext.Provider>
    </AuthContext.Provider>
  );
}
