export type Role = "巡检员" | "厂务工程师" | "班组长";
export type Shift = "早班" | "中班" | "晚班";
export type RecordStatus = "submitted" | "reviewed";
export type JudgeLevel = "正常" | "关注" | "异常";

/** 某一洁净等级下的阈值限值（达到/等于上限即判异常） */
export interface ThresholdRule {
  particleUpper: number; // ≥0.5μm 粒子，个/m³
  tempLower: number; // ℃
  tempUpper: number; // ℃
  humidityLower: number; // %RH
  humidityUpper: number; // %RH
  pressureLower: number; // Pa
  pressureUpper: number; // Pa
}

/** 已发布的阈值版本（发布后不可变，只影响之后新建的记录） */
export interface ThresholdVersion {
  id: string;
  label: string; // 如 v1.0
  publishedAt: number;
  publishedBy: string;
  note: string;
  rules: Record<string, ThresholdRule>; // key: 洁净等级
}

export interface JudgeDetail {
  item: string; // 粒子计数 / 温度 / 湿度 / 压差
  value: number;
  level: JudgeLevel;
  limit: string; // 限值描述
  reason: string; // 判定依据
}

export interface Judgment {
  overall: JudgeLevel;
  details: JudgeDetail[];
}

export interface InspectionRecord {
  id: string;
  roomNo: string;
  cleanliness: string;
  shift: Shift;
  inspector: string;
  particleCount: number;
  temperature: number;
  humidity: number;
  pressure: number;
  deviceStatus: string;
  note: string;
  status: RecordStatus;
  /** 创建时快照的阈值版本（历史记录始终按此版本显示判定） */
  thresholdVersionId: string;
  thresholdLabel: string;
  judgment: Judgment;
  /** 乐观锁版本号，每次成功保存 +1 */
  version: number;
  createdAt: number;
  updatedAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
}

/** 表单内容（字符串，提交时才解析为数值） */
export interface RecordFormPayload {
  roomNo: string;
  cleanliness: string;
  shift: Shift;
  particleCount: string;
  temperature: string;
  humidity: string;
  pressure: string;
  deviceStatus: string;
  note: string;
}

/** 未提交草稿：id 为 "new"（新建）或记录 id（编辑） */
export interface Draft {
  id: string;
  baseVersion: number; // 编辑基于的记录版本，新建为 0
  payload: RecordFormPayload;
  updatedAt: number;
}

export interface AuditEntry {
  id: string;
  ts: number;
  actor: string;
  action: string;
  recordId?: string;
  detail: string;
}
