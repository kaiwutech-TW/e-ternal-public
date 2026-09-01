/**
 * 全域「資料變了」廣播：畫面外的寫入（目前只有 WebMCP 的 submit_draft——
 * agent 起草、人簽核後建立單據）完成時通知所有 useFetch/useListFetch 重新取數，
 * 使用者不必手動按查詢才看得到剛簽核的那張單。
 *
 * 刻意不用 window CustomEvent：模組層訂閱器在 node 測試環境也跑得動，
 * 且訂閱範圍明確（只有 hooks.ts 掛），不會被頁面上其他人監聽誤用。
 */

const listeners = new Set<() => void>();

export function subscribeDataChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 畫面外寫入成功後呼叫：所有掛著的 fetch hook 會 reload */
export function notifyDataChanged(): void {
  listeners.forEach((fn) => fn());
}

/** 測試用：目前掛著幾個訂閱（宣稱「hooks 有訂閱」必須驗得到） */
export const dataChangedListenerCount = (): number => listeners.size;
