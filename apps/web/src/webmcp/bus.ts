/**
 * WebMCP 的共享狀態匯流排（不依賴 React）：
 * - 活動紀錄：每次工具呼叫都留一筆，給「Agent 活動」側欄即時顯示
 * - 報價草稿：agent 與人共同編輯的那份草稿（誰改的、改了哪格都記）
 * - 簽核請求：submit_draft 走到這裡「暫停」，等人按核准/退回才繼續
 *
 * 工具的 execute 在 React 樹外執行，所以狀態放模組層、用訂閱通知 UI。
 */

// ---------- 活動紀錄 ----------

export interface ActivityEntry {
  id: number;
  time: string; // HH:MM:SS
  actor: "agent" | "human";
  tool: string;
  summary: string;
  status: "ok" | "error" | "pending";
}

let activitySeq = 0;
let activities: ActivityEntry[] = [];
const activityListeners = new Set<() => void>();

export function logActivity(e: Omit<ActivityEntry, "id" | "time">): number {
  const id = ++activitySeq;
  activities = [
    ...activities.slice(-99),
    { ...e, id, time: new Date().toTimeString().slice(0, 8) },
  ];
  activityListeners.forEach((fn) => fn());
  return id;
}

export function resolveActivity(id: number, status: "ok" | "error", summary?: string): void {
  activities = activities.map((a) =>
    a.id === id ? { ...a, status, ...(summary !== undefined ? { summary } : {}) } : a,
  );
  activityListeners.forEach((fn) => fn());
}

export const getActivities = (): ActivityEntry[] => activities;
export function subscribeActivities(fn: () => void): () => void {
  activityListeners.add(fn);
  return () => activityListeners.delete(fn);
}

// ---------- 報價草稿（人機共編） ----------

export interface QuoteDraftLine {
  productId: number;
  productName: string;
  unit: string;
  qty: number;
  /** 未稅單價（整數元；系統紀律：稅額到送出時由後端按稅法參數計算，前端不斷言稅率） */
  unitPrice: number;
}

export interface QuoteDraft {
  partnerId: number;
  partnerName: string;
  quoteDate: string;
  expectedDate?: string;
  memo?: string;
  lines: QuoteDraftLine[];
  /** 最後一次變更：哪個欄位、誰改的——草稿卡用它做高亮動畫 */
  lastEdit: { key: string; actor: "agent" | "human"; at: number } | null;
}

let draft: QuoteDraft | null = null;
const draftListeners = new Set<() => void>();
const notifyDraft = () => draftListeners.forEach((fn) => fn());

export const getDraft = (): QuoteDraft | null => draft;
export function subscribeDraft(fn: () => void): () => void {
  draftListeners.add(fn);
  return () => draftListeners.delete(fn);
}

export function setDraft(next: QuoteDraft | null): void {
  draft = next;
  notifyDraft();
}

export function editDraft(key: string, actor: "agent" | "human", mutate: (d: QuoteDraft) => void): void {
  if (!draft) return;
  const copy: QuoteDraft = { ...draft, lines: draft.lines.map((l) => ({ ...l })) };
  mutate(copy);
  copy.lastEdit = { key, actor, at: Date.now() };
  draft = copy;
  notifyDraft();
}

/** 未稅合計（稅額刻意不算——零斷言紀律：稅率屬於後端稅法參數） */
export const draftSubtotal = (d: QuoteDraft): number =>
  d.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);

// ---------- 簽核請求（結構性紅線：唯一的送出通道） ----------

export interface ApprovalRequest {
  title: string;
  /** 顯示給人看的重點列（金額、對象、筆數） */
  facts: Array<[string, string]>;
  resolve: (approved: boolean) => void;
}

let approval: ApprovalRequest | null = null;
const approvalListeners = new Set<() => void>();

export const getApproval = (): ApprovalRequest | null => approval;
export function subscribeApproval(fn: () => void): () => void {
  approvalListeners.add(fn);
  return () => approvalListeners.delete(fn);
}

/** 工具端呼叫：掛出簽核卡、await 人的決定。同時間只允許一張（後到的直接拒絕）。 */
export function requestApproval(title: string, facts: Array<[string, string]>): Promise<boolean> {
  if (approval) return Promise.resolve(false);
  return new Promise<boolean>((res) => {
    approval = {
      title,
      facts,
      resolve: (ok) => {
        approval = null;
        approvalListeners.forEach((fn) => fn());
        res(ok);
      },
    };
    approvalListeners.forEach((fn) => fn());
  });
}
