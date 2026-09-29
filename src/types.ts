// 洁净室巡检领域模型

export type Role = "巡检员" | "厂务工程师" | "班组长";

export type RecordStatus = "draft" | "submitted" | "reviewed";
export type JudgmentLevel = "正常" | "关注" | "异常";

/** 单个洁净等级的阈值指标 */
export interface ThresholdLimits {
  class: string;
  /** 0.5μm 粒子计数上限（粒/m³），达到即异常 */
  particleLimit: number;
  /** 静压差下限（Pa），低于即异常 */
  pressureMin: number;
  /** 温度范围（℃） */
  tempMin: number;
  tempMax: number;
  /** 相对湿度范围（%RH） */
  humidityMin: number;
  humidityMax: number;
}

/** 阈值版本：发布后只对新记录生效，历史记录保留自己的版本快照 */
export interface ThresholdVersion {
  version: number;
  label: string;
  effectiveAt: string;
  publishedBy: string;
  note: string;
  active: boolean;
  limits: ThresholdLimits[];
}

export interface Judgment {
  level: JudgmentLevel;
  /** 判定依据，如 "粒子计数 3520 ≥ 上限 3520（等于上限判异常）" */
  reasons: string[];
  /** 判定所依据的阈值版本（快照） */
  thresholdVersion: number;
  judgedAt: string;
}

export interface InspectionRecord {
  id: string;
  recordNo: string;
  roomNo: string;
  cleanLevel: string;
  /** 0.5μm 粒子计数（粒/m³） */
  particleCount: number | "";
  /** 温度（℃） */
  temperature: number | "";
  /** 相对湿度（%RH） */
  humidity: number | "";
  /** 静压差（Pa） */
  pressureDiff: number | "";
  equipmentStatus: string;
  handlingNote: string;
  status: RecordStatus;
  /** 记录版本：每次保存 +1，乐观锁令牌 */
  version: number;
  /** 阈值版本：新建/编辑时按当班阈值快照，之后永不重判 */
  thresholdVersion: number;
  judgment: Judgment;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  action:
    | "record.created"
    | "record.updated"
    | "record.submitted"
    | "record.review_approved"
    | "record.review_rejected"
    | "record.conflict"
    | "threshold.published";
  recordId?: string;
  recordNo?: string;
  fromVersion?: number;
  toVersion?: number;
  detail: string;
}

/** 未提交草稿：按 "new" 或记录 id 分别保存 */
export interface Draft {
  key: string;
  form: Record<string, string>;
  baseVersion: number | null;
  savedAt: string;
}

export interface DB {
  thresholds: ThresholdVersion[];
  records: InspectionRecord[];
  audit: AuditEntry[];
  drafts: Record<string, Draft>;
}

export const EMPTY_FORM: Record<string, string> = {
  roomNo: "",
  cleanLevel: "ISO 6",
  particleCount: "",
  temperature: "",
  humidity: "",
  pressureDiff: "",
  equipmentStatus: "正常",
  handlingNote: "",
};

export const CLEAN_LEVELS = ["ISO 5", "ISO 6", "ISO 7", "黄光区"];
export const EQUIPMENT_STATUS = ["正常", "关注", "异常", "停机维修"];

export const STATUS_LABEL: Record<RecordStatus, string> = {
  draft: "草稿",
  submitted: "已提交",
  reviewed: "已复核",
};
