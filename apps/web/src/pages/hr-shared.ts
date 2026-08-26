/** HR 共用型別與文案（Attendance／Hr／Payroll 三頁共用，避免三份標籤漂移） */

export interface LeaveType {
  id: number;
  code: string;
  name: string;
  isSystem: boolean;
  active: boolean;
  payRatioPercent: number | null;
  sourceNote: string;
  minUnitMinutes: number;
  note: string;
}

export interface LeaveBalance {
  id: number;
  employeeId: number;
  employeeName?: string;
  leaveTypeId: number;
  leaveTypeCode: string;
  leaveTypeName: string;
  year: number;
  grantedMinutes: number;
  usedMinutes: number;
  pendingMinutes: number;
  note: string;
}

export interface HrRequestStep {
  id: number;
  stepNo: number;
  approverName: string;
  status: string;
  comment: string;
  decidedAt: string | null;
}

export interface HrRequest {
  id: number;
  kind: "leave" | "overtime" | "punch_correction";
  employeeId: number;
  employeeName?: string;
  status: "pending" | "approved" | "rejected" | "canceled";
  reason: string;
  leaveTypeId: number | null;
  leaveTypeName?: string | null;
  startAt: string | null;
  endAt: string | null;
  minutes: number | null;
  dayType: string | null;
  workDate: string | null;
  direction: string | null;
  claimedTime: string | null;
  createdAt: string;
  steps: HrRequestStep[];
  autoApproved?: boolean;
}

export const KIND_LABELS: Record<string, string> = {
  leave: "請假",
  overtime: "加班",
  punch_correction: "補卡",
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "簽核中",
  approved: "已核准",
  rejected: "已駁回",
  canceled: "已取消",
};

export const STATUS_BADGE: Record<string, string> = {
  pending: "draft",
  approved: "issued",
  rejected: "canceled",
  canceled: "canceled",
};

export const DAY_TYPE_LABELS: Record<string, string> = {
  workday: "平日",
  restday: "休息日",
  regular_off: "例假日",
  holiday: "國定假日",
};

export const fmtMinutes = (m: number): string => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} 時` : `${h} 時 ${r} 分`;
};

/** 申請單的內容一句話（三種 kind 各自的重點欄位） */
export function requestSummary(r: HrRequest): string {
  if (r.kind === "leave") {
    const span = r.startAt && r.endAt
      ? `${new Date(r.startAt).toLocaleString("zh-TW", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ~ ${new Date(r.endAt).toLocaleString("zh-TW", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
      : "";
    return `${r.leaveTypeName ?? "？"} ${span}（${fmtMinutes(r.minutes ?? 0)}）`;
  }
  if (r.kind === "overtime") {
    return `${r.workDate} ${DAY_TYPE_LABELS[r.dayType ?? ""] ?? r.dayType}（${fmtMinutes(r.minutes ?? 0)}）`;
  }
  return `${r.workDate} ${r.direction === "in" ? "上班" : "下班"}卡補 ${r.claimedTime}`;
}
