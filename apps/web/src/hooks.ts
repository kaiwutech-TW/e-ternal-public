import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";

/** path 傳 null＝這個畫面此刻不需要這筆資料（條件式取數），不發請求、data 維持 null */
export function useFetch<T>(path: string | null): { data: T | null; reload: () => void; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    api
      .get<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, reload, error };
}

/**
 * 清單版 useFetch（R3）：回應仍是陣列，另外把 X-Total-Count 讀出來——
 * 清單預設只回最新 200 筆，total > 顯示筆數時篩選列會提示使用者縮小範圍。
 */
export function useListFetch<T>(path: string | null): {
  data: T | null;
  total: number | null;
  reload: () => void;
  error: string | null;
} {
  const [data, setData] = useState<T | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    api
      .getList<T>(path)
      .then((r) => alive && (setData(r.rows), setTotal(r.total), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, total, reload, error };
}

export const fmt = (n: number) => n.toLocaleString("zh-TW");
