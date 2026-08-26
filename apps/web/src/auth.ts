import { createContext, useContext } from "react";
import type { AuthUser } from "./types.ts";

/** 目前登入者；App 登入後提供，各頁用 useAuth() 取用（登入前不會渲染任何頁面） */
export const AuthContext = createContext<AuthUser | null>(null);

export function useAuth(): AuthUser {
  const user = useContext(AuthContext);
  if (!user) throw new Error("useAuth 必須在登入後的頁面內使用");
  return user;
}
