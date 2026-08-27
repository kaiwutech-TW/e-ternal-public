import { useState, type FormEvent } from "react";
import { ApiError, api } from "../api.ts";
import { setLocale, useLocale, useT } from "../i18n.ts";
import { useEffectiveTheme } from "../theme.ts";
import type { AuthUser } from "../types.ts";

/** 登入畫面；首次啟動（無任何使用者）時切為初始設定，建立第一個管理者帳號 */
export function Login({ needsSetup, onLogin }: { needsSetup: boolean; onLogin: (user: AuthUser) => void }) {
  const t = useT();
  const locale = useLocale();
  const theme = useEffectiveTheme();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 送出後才知道這個帳號有沒有啟用二階段驗證——伺服端回 totpRequired 時才長出這個欄位
  const [needsTotp, setNeedsTotp] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? "").trim();
    setBusy(true);
    try {
      const user = needsSetup
        ? await api.post<AuthUser>("/auth/setup", {
            username: val("username"),
            displayName: val("displayName"),
            password: val("password"),
          })
        : await api.post<AuthUser>("/auth/login", {
            username: val("username"),
            password: val("password"),
            ...(val("totpCode") ? { totpCode: val("totpCode") } : {}),
          });
      onLogin(user);
    } catch (err) {
      if (err instanceof ApiError && err.totpRequired) setNeedsTotp(true);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <div className="card" style={{ width: 360 }}>
        <img src={theme === "dark" ? "/logo-dark.png" : "/logo.png"} alt="E-ternal ERP" style={{ width: "72%", display: "block", margin: "4px auto 12px" }} />
        {/* 登入前也要能切語言：側欄的語言鈕要登入後才看得到，而第一次開站的人（例如英語圈評審）就在這頁 */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>{needsSetup ? t("初始設定：建立管理者帳號") : t("登入")}</h3>
          <button type="button" data-locale-toggle onClick={() => setLocale(locale === "en" ? "zh-TW" : "en")} aria-label={t("語言")} style={{ background: "none", border: 0, color: "var(--text-2)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>
            {locale === "en" ? "繁體中文" : "English"}
          </button>
        </div>
        {needsSetup && (
          <p style={{ fontSize: 13, color: "var(--text-2)" }}>
            {t("系統尚未有任何使用者。先建立第一個管理者帳號，之後再到「設定」頁新增其他同事。")}
          </p>
        )}
        {error && <div className="error">{error}</div>}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="field">{t("帳號")}<input name="username" autoFocus required autoComplete="username" /></label>
          {needsSetup && <label className="field">{t("顯示名稱（你的名字）")}<input name="displayName" required /></label>}
          <label className="field">
            {t("密碼")}
            <input name="password" type="password" required minLength={needsSetup ? 6 : 1} autoComplete={needsSetup ? "new-password" : "current-password"} />
          </label>
          {needsTotp && (
            <label className="field">
              {t("驗證碼")}
              <input
                name="totpCode"
                autoFocus
                required
                inputMode="text"
                autoComplete="one-time-code"
                placeholder={t("驗證器 app 的 6 位數，或一組備援碼")}
              />
            </label>
          )}
          <button className="primary" disabled={busy}>{needsSetup ? t("建立並登入") : t("登入")}</button>
        </form>
      </div>
    </div>
  );
}
