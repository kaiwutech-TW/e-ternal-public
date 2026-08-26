/**
 * tw-erp API 客戶端。兩種憑證：
 * - **API 金鑰（建議）**：`Authorization: Bearer twerp_sk_…`，無 session、無重登邏輯。
 * - 帳密：登入換 session cookie，401 時自動重登一次。**帳號一旦啟用二階段驗證就會失效**
 *   （機器沒有手機，登入會收到 401 totpRequired）——所以正式部署請改用金鑰。
 * fetchImpl 可注入（測試以 Hono app.fetch 端對端，不走網路）。
 */

export interface ClientOptions {
  baseUrl: string; // 例 http://localhost:3000/api（含 /api 前綴）
  /** 二選一：有金鑰就用金鑰，否則用帳密 */
  apiKey?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  fetchImpl?: typeof fetch;
}

export class TwErpClient {
  private cookie: string | null = null;
  private readonly opts: ClientOptions;
  private readonly fetchImpl: typeof fetch;

  // 注意：node --experimental-strip-types 不支援 constructor parameter property，故手動指派
  constructor(opts: ClientOptions) {
    if (!opts.apiKey && !(opts.username && opts.password)) {
      throw new Error("請提供 TWERP_API_KEY，或 TWERP_USERNAME＋TWERP_PASSWORD（見 docs/mcp.md）");
    }
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async login(): Promise<void> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.opts.username, password: this.opts.password }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (body.includes("totpRequired")) {
        throw new Error(
          "這個帳號已啟用二階段驗證，帳密登入無法用於機器（機器沒有手機）。" +
            "請在「設定」頁替它產生一把 API 金鑰，改設 TWERP_API_KEY。",
        );
      }
      throw new Error(`tw-erp 登入失敗（${res.status}）: ${body}`);
    }
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) throw new Error("tw-erp 登入未回 set-cookie");
    this.cookie = setCookie.split(";")[0]!;
  }

  async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const useKey = !!this.opts.apiKey;
    if (!useKey && !this.cookie) await this.login();
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        ...(useKey ? { authorization: `Bearer ${this.opts.apiKey}` } : { cookie: this.cookie! }),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // 金鑰沒有「過期」這回事——401 就是被撤銷或打錯了，重試只會再錯一次
    if (res.status === 401 && !retried && !useKey) {
      this.cookie = null; // session 過期 → 重登一次
      return this.request(method, path, body, true);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} 失敗（${res.status}）: ${json?.error ?? text}`);
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}
