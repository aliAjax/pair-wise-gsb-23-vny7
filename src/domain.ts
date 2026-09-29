import type {
  AuditEntry,
  InspectionRecord,
  JudgeDetail,
  JudgeLevel,
  Role,
  Shift,
  ThresholdRule,
  ThresholdVersion,
} from "./types";

export const CLEANLINESS_LEVELS = ["ISO 5", "ISO 6", "ISO 7", "黄光区"];
export const SHIFTS: Shift[] = ["早班", "中班", "晚班"];
export const ROLES: Role[] = ["巡检员", "厂务工程师", "班组长"];
export const DEVICE_STATUS = ["运行正常", "待机", "检修中", "停机"];

/** 达到限值的该比例即判“关注” */
export const WATCH_RATIO = 0.9;

export interface MetricInput {
  particleCount: number;
  temperature: number;
  humidity: number;
  pressure: number;
}

/** 单上限项目：value >= upper 判异常（等于上限判异常） */
function judgeUpper(item: string, value: number, upper: number, unit: string): JudgeDetail {
  const limit = `≤ ${upper}${unit}`;
  if (value >= upper) {
    return { item, value, level: "异常", limit, reason: `${value} ≥ 上限 ${upper}（等于上限判异常）` };
  }
  if (value >= upper * WATCH_RATIO) {
    return { item, value, level: "关注", limit, reason: `达到上限 ${upper} 的 ${WATCH_RATIO * 100}%` };
  }
  return { item, value, level: "正常", limit, reason: `低于上限 ${upper} 的 ${WATCH_RATIO * 100}%` };
}

/** 上下限项目：越界（含等于）判异常；距边界 10% 量程内判关注 */
function judgeRange(item: string, value: number, lower: number, upper: number, unit: string): JudgeDetail {
  const limit = `${lower} ~ ${upper}${unit}`;
  if (value >= upper) {
    return { item, value, level: "异常", limit, reason: `${value} ≥ 上限 ${upper}（等于上限判异常）` };
  }
  if (value <= lower) {
    return { item, value, level: "异常", limit, reason: `${value} ≤ 下限 ${lower}` };
  }
  const margin = (upper - lower) * (1 - WATCH_RATIO);
  if (value >= upper - margin) {
    return { item, value, level: "关注", limit, reason: `接近上限 ${upper}` };
  }
  if (value <= lower + margin) {
    return { item, value, level: "关注", limit, reason: `接近下限 ${lower}` };
  }
  return { item, value, level: "正常", limit, reason: `处于 ${lower} ~ ${upper} 范围内` };
}

/** 按某一阈值版本的规则判定一组测量值 */
export function judgeMetrics(m: MetricInput, rule: ThresholdRule): { overall: JudgeLevel; details: JudgeDetail[] } {
  const details: JudgeDetail[] = [
    judgeUpper("粒子计数", m.particleCount, rule.particleUpper, " 个/m³"),
    judgeRange("温度", m.temperature, rule.tempLower, rule.tempUpper, " ℃"),
    judgeRange("湿度", m.humidity, rule.humidityLower, rule.humidityUpper, " %RH"),
    judgeRange("压差", m.pressure, rule.pressureLower, rule.pressureUpper, " Pa"),
  ];
  const overall: JudgeLevel = details.some((d) => d.level === "异常")
    ? "异常"
    : details.some((d) => d.level === "关注")
      ? "关注"
      : "正常";
  return { overall, details };
}

/** 当前生效的阈值版本（最新发布） */
export function activeThreshold(thresholds: ThresholdVersion[]): ThresholdVersion | null {
  if (thresholds.length === 0) return null;
  return [...thresholds].sort((a, b) => b.publishedAt - a.publishedAt)[0];
}

/** 首次启动的种子数据：一个阈值版本 + 三条示例记录 + 审计 */
export function buildSeed(): {
  thresholds: ThresholdVersion[];
  records: InspectionRecord[];
  audits: AuditEntry[];
} {
  const now = Date.now();
  const hour = 3600_000;

  const threshold: ThresholdVersion = {
    id: "tv-seed-1",
    label: "v1.0",
    publishedAt: now - 10 * hour,
    publishedBy: "厂务工程师",
    note: "初始阈值：依据 ISO 14644-1 与厂务规范（达到/等于上限判异常）",
    rules: {
      "ISO 5": { particleUpper: 3520, tempLower: 18, tempUpper: 24, humidityLower: 40, humidityUpper: 55, pressureLower: 5, pressureUpper: 20 },
      "ISO 6": { particleUpper: 35200, tempLower: 18, tempUpper: 24, humidityLower: 40, humidityUpper: 55, pressureLower: 5, pressureUpper: 20 },
      "ISO 7": { particleUpper: 352000, tempLower: 18, tempUpper: 26, humidityLower: 35, humidityUpper: 60, pressureLower: 5, pressureUpper: 25 },
      "黄光区": { particleUpper: 352000, tempLower: 20, tempUpper: 24, humidityLower: 40, humidityUpper: 50, pressureLower: 5, pressureUpper: 20 },
    },
  };

  const mk = (input: {
    id: string;
    roomNo: string;
    cleanliness: string;
    shift: Shift;
    particleCount: number;
    temperature: number;
    humidity: number;
    pressure: number;
    note: string;
    createdAt: number;
    reviewed?: boolean;
  }): InspectionRecord => {
    const judgment = judgeMetrics(
      {
        particleCount: input.particleCount,
        temperature: input.temperature,
        humidity: input.humidity,
        pressure: input.pressure,
      },
      threshold.rules[input.cleanliness]
    );
    return {
      id: input.id,
      roomNo: input.roomNo,
      cleanliness: input.cleanliness,
      shift: input.shift,
      inspector: "巡检员",
      particleCount: input.particleCount,
      temperature: input.temperature,
      humidity: input.humidity,
      pressure: input.pressure,
      deviceStatus: "运行正常",
      note: input.note,
      status: input.reviewed ? "reviewed" : "submitted",
      thresholdVersionId: threshold.id,
      thresholdLabel: threshold.label,
      judgment,
      version: input.reviewed ? 2 : 1,
      createdAt: input.createdAt,
      updatedAt: input.reviewed ? input.createdAt + hour : input.createdAt,
      reviewedBy: input.reviewed ? "厂务工程师" : undefined,
      reviewedAt: input.reviewed ? input.createdAt + hour : undefined,
    };
  };

  const records: InspectionRecord[] = [
    mk({
      id: "seed-rec-1",
      roomNo: "CR-1201",
      cleanliness: "ISO 5",
      shift: "早班",
      particleCount: 4100,
      temperature: 22.5,
      humidity: 46,
      pressure: 12,
      note: "0.5um粒子超限，已通知厂务",
      createdAt: now - 6 * hour,
    }),
    mk({
      id: "seed-rec-2",
      roomNo: "CR-2107",
      cleanliness: "ISO 6",
      shift: "早班",
      particleCount: 12000,
      temperature: 22.1,
      humidity: 47,
      pressure: 15,
      note: "压差15Pa，温湿度正常",
      createdAt: now - 5 * hour,
      reviewed: true,
    }),
    mk({
      id: "seed-rec-3",
      roomNo: "Y-0302",
      cleanliness: "黄光区",
      shift: "中班",
      particleCount: 80000,
      temperature: 22.8,
      humidity: 49,
      pressure: 8,
      note: "湿度接近上限",
      createdAt: now - 2 * hour,
    }),
  ];

  const audits: AuditEntry[] = [
    {
      id: "seed-audit-1",
      ts: threshold.publishedAt,
      actor: "厂务工程师",
      action: "发布阈值版本",
      detail: `阈值版本 ${threshold.label} 已发布，仅影响之后新建的巡检记录`,
    },
    ...records.map((r, i) => ({
      id: `seed-audit-${i + 2}`,
      ts: r.createdAt,
      actor: r.inspector,
      action: "新建巡检记录",
      recordId: r.id,
      detail: `记录版本 v1 · 阈值版本 ${r.thresholdLabel} · 班次 ${r.shift} · 判定 ${r.judgment.overall}`,
    })),
    {
      id: "seed-audit-5",
      ts: now - 4 * hour,
      actor: "厂务工程师",
      action: "复核通过",
      recordId: "seed-rec-2",
      detail: "记录版本 v2 · 阈值版本 v1.0 · 判定 正常；复核后记录锁定，不可再修改",
    },
  ];

  return { thresholds: [threshold], records, audits };
}
