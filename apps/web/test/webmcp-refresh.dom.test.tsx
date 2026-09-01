// @vitest-environment jsdom
/**
 * 畫面外寫入 → 列表自動刷新：WebMCP 的 submit_draft 在人簽核後建立單據，
 * notifyDataChanged() 廣播必須讓 useFetch/useListFetch 重新取數——
 * 使用者不必手動按查詢才看得到剛簽核的那張單。
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "./dom.ts";
import { dataChangedListenerCount, notifyDataChanged, subscribeDataChanged } from "../src/data-events.ts";
import { useListFetch } from "../src/hooks.ts";

const fetchOk = (rows: unknown[], total: number) =>
  new Response(JSON.stringify(rows), { status: 200, headers: { "x-total-count": String(total) } });

describe("notifyDataChanged → useListFetch 自動 reload", () => {
  it("廣播後重新取數，資料與總筆數更新", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fetchOk([{ id: 6 }], 6))
      .mockResolvedValueOnce(fetchOk([{ id: 7 }, { id: 6 }], 7));

    const { result, unmount } = renderHook(() => useListFetch<Array<{ id: number }>>("/quotes"));
    await waitFor(() => expect(result.current.total).toBe(6));

    act(() => notifyDataChanged());
    await waitFor(() => expect(result.current.total).toBe(7));
    expect(result.current.data![0]!.id).toBe(7);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // 卸載後訂閱要清乾淨（否則換頁累積殭屍訂閱、每次廣播全部重打）
    const before = dataChangedListenerCount();
    unmount();
    expect(dataChangedListenerCount()).toBe(before - 1);
    fetchSpy.mockRestore();
  });

  it("訂閱器：退訂後不再收到廣播", () => {
    let hits = 0;
    const off = subscribeDataChanged(() => {
      hits++;
    });
    notifyDataChanged();
    off();
    notifyDataChanged();
    expect(hits).toBe(1);
  });
});
