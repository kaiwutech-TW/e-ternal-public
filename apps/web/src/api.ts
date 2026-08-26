const BASE = "/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** 登入專用：密碼對了，但這個帳號還需要二階段驗證的驗證碼 */
    public readonly totpRequired = false,
  ) {
    super(message);
  }
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // session 過期/未登入：通知 App 切回登入畫面（登入 API 本身的 401 由表單自行顯示錯誤）
    if (res.status === 401 && path !== "/auth/login") {
      window.dispatchEvent(new CustomEvent("api-unauthorized"));
    }
    throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`, json?.totpRequired === true);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, "GET"),
  /**
   * 清單端點（R3）：回應仍是陣列，總筆數在 X-Total-Count 標頭——
   * 一般 get() 讀不到標頭，要顯示「共 N 筆」的清單頁改走這支。total 為 null＝端點沒帶標頭。
   */
  getList: async <T>(path: string): Promise<{ rows: T; total: number | null }> => {
    const res = await fetch(BASE + path);
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      if (res.status === 401) window.dispatchEvent(new CustomEvent("api-unauthorized"));
      throw new ApiError(res.status, (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    }
    const raw = res.headers.get("x-total-count");
    return { rows: json as T, total: raw !== null && /^\d+$/.test(raw) ? Number(raw) : null };
  },
  post: <T>(path: string, body: unknown) => request<T>(path, "POST", body),
  put: <T>(path: string, body: unknown) => request<T>(path, "PUT", body),
  patch: <T>(path: string, body: unknown) => request<T>(path, "PATCH", body),
  delete: <T>(path: string) => request<T>(path, "DELETE"),
  /**
   * 回純文字的端點（發票 XML、折讓證明單 XML 等）：不能走 request()——它會 JSON.parse 炸掉。
   * 錯誤回應仍是 JSON（{error}），照常取出可操作訊息。
   */
  getText: async (path: string): Promise<string> => {
    const res = await fetch(BASE + path);
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) window.dispatchEvent(new CustomEvent("api-unauthorized"));
      let msg = `HTTP ${res.status}`;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? msg;
      } catch {
        /* 非 JSON 錯誤體照用狀態碼 */
      }
      throw new ApiError(res.status, msg);
    }
    return text;
  },
};

export function downloadText(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
