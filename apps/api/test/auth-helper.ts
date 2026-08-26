/** 測試共用：首次 setup 建 admin 並回傳帶 session cookie 的 headers（所有 API 已 default-deny） */
import type { Hono } from "hono";

export async function setupAdmin(
  app: { request: Hono["request"] },
  username = "admin",
): Promise<Record<string, string>> {
  const res = await app.request("/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName: "管理者", password: "secret-test" }),
  });
  if (res.status !== 201) throw new Error(`auth setup 失敗: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("auth setup 未回 set-cookie");
  return { cookie };
}

/** 以既有使用者登入，回傳帶 cookie 的 headers */
export async function loginAs(
  app: { request: Hono["request"] },
  username: string,
  password: string,
): Promise<Record<string, string>> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login 失敗: ${res.status} ${await res.text()}`);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}
