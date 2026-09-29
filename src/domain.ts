import type {
  Draft,
  InspectionRecord,
  Judgment,
  JudgmentLevel,
  ThresholdLimits,
  ThresholdVersion,
} from "./types";
import { CLEAN_LEVELS } from "./types";

/* ---------------- 阈值版本 ---------------- */

/** 当班阈值 = 当前 active 版本 */
export function getActiveThreshold(thresholds: ThresholdVersion[]): ThresholdVersion {
  const active = thresholds.find((t) => t.active);
  if (active) return active;
  return thresholds[thresholds.length - 1];
}

export function limitsFor(threshold: ThresholdVersion, cleanLevel: string): ThresholdLimits {
  const found = threshold.limits.find((l) => l.class === cleanLevel);
  if (found) return found;
  // 兜底：取最接近的等级，避免新等级未配置时崩溃
  return threshold.limits[0];
}

/* ---------------- 判定引擎 ---------------- */
/* 规则：达到上限（>=）即判异常；接近上限 90% 判关注；压低下限同理。 */

function bump(
  current: JudgmentLevel,
  next: Exclude<JudgmentLevel, "正常">,
  reason: string,
  reasons: string[],
): JudgmentLevel {
  if (next === "异常") {
    reasons.push(reason);
    return "异常";
  }
  if (current === "异常") {
    reasons.push(reason);
    return current;
  }
  reasons.push(reason);
  return "关注";
}

export function judge(
  limits: ThresholdLimits,
  values: {
    particleCount: number | "";
    temperature: number | "";
    humidity: number | "";
    pressureDiff: number | "";
  },
  thresholdVersion: number,
): Judgment {
  const reasons: string[] = [];
  let level: JudgmentLevel = "正常";
  const now = new Date().toISOString();

  if (values.particleCount !== "") {
    const v = Number(values.particleCount);
    const ratio = v / limits.particleLimit;
    if (ratio >= 1) {
      level = bump(
        level,
        "异常",
        `粒子计数 ${v} ≥ 上限 ${limits.particleLimit}（等于上限判异常）`,
        reasons,
      );
    } else if (ratio >= 0.9) {
      level = bump(
        level,
        "关注",
        `粒子计数 ${v} 接近上限 ${limits.particleLimit}（≥90%）`,
        reasons,
      );
    }
  }

  if (values.pressureDiff !== "") {
    const v = Number(values.pressureDiff);
    const ratio = v / limits.pressureMin;
    if (ratio <= 1) {
      level = bump(
        level,
        "异常",
        `静压差 ${v}Pa ≤ 下限 ${limits.pressureMin}Pa（等于下限判异常）`,
        reasons,
      );
    } else if (ratio <= 1.1) {
      level = bump(
        level,
        "关注",
        `静压差 ${v}Pa 接近下限 ${limits.pressureMin}Pa（≤110%）`,
        reasons,
      );
    }
  }

  if (values.temperature !== "") {
    const v = Number(values.temperature);
    if (v >= limits.tempMax) {
      level = bump(level, "异常", `温度 ${v}℃ ≥ 上限 ${limits.tempMax}℃（等于上限判异常）`, reasons);
    } else if (v <= limits.tempMin) {
      level = bump(level, "异常", `温度 ${v}℃ ≤ 下限 ${limits.tempMin}℃`, reasons);
    } else if (v >= limits.tempMax - (limits.tempMax - limits.tempMin) * 0.1) {
      level = bump(level, "关注", `温度 ${v}℃ 接近上限 ${limits.tempMax}℃`, reasons);
    }
  }

  if (values.humidity !== "") {
    const v = Number(values.humidity);
    if (v >= limits.humidityMax) {
      level = bump(
        level,
        "异常",
        `湿度 ${v}%RH ≥ 上限 ${limits.humidityMax}%RH（等于上限判异常）`,
        reasons,
      );
    } else if (v <= limits.humidityMin) {
      level = bump(level, "异常", `湿度 ${v}%RH ≤ 下限 ${limits.humidityMin}%RH`, reasons);
    } else if (v >= limits.humidityMax - (limits.humidityMax - limits.humidityMin) * 0.1) {
      level = bump(level, "关注", `湿度 ${v}%RH 接近上限 ${limits.humidityMax}%RH`, reasons);
    }
  }

  return { level, reasons, thresholdVersion, judgedAt: now };
}

/* ---------------- 阈值版本发布 ---------------- */

export function buildNextThreshold(
  prev: ThresholdVersion,
  draft: { note: string; limits: ThresholdLimits[] },
  actor: string,
): ThresholdVersion {
  return {
    version: prev.version + 1,
    label: `v${prev.version + 1}.0`,
    effectiveAt: new Date().toISOString(),
    publishedBy: actor,
    note: draft.note,
    active: true,
    limits: draft.limits,
  };
}

/* ---------------- 导出摘要（CSV，含记录版本 + 阈值版本） ---------------- */

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportRecordsCsv(records: InspectionRecord[]): void {
  const header = [
    "记录编号",
    "房间编号",
    "洁净等级",
    "粒子计数(0.5μm/粒m³)",
    "温度(℃)",
    "湿度(%RH)",
    "静压差(Pa)",
    "设备状态",
    "处理备注",
    "判定结果",
    "判定依据",
    "记录版本",
    "阈值版本",
    "记录状态",
    "创建人",
    "创建时间",
    "提交时间",
    "复核人",
    "复核时间",
  ];
  const rows = records.map((r) => [
    r.recordNo,
    r.roomNo,
    r.cleanLevel,
    r.particleCount,
    r.temperature,
    r.humidity,
    r.pressureDiff,
    r.equipmentStatus,
    r.handlingNote,
    r.judgment.level,
    r.judgment.reasons.join("；"),
    `v${r.version}`,
    `v${r.thresholdVersion}`,
    r.status === "draft" ? "草稿" : r.status === "submitted" ? "已提交" : "已复核",
    r.createdBy,
    fmtTime(r.createdAt),
    r.submittedAt ? fmtTime(r.submittedAt) : "",
    r.reviewedBy ?? "",
    r.reviewedAt ? fmtTime(r.reviewedAt) : "",
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date()
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "");
  a.href = url;
  a.download = `巡检摘要_${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- 工具 ---------------- */

export function uid(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).toUpperCase();
}

export function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function genRecordNo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `CR${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function emptyDraft(key: string): Draft {
  return { key, form: {}, baseVersion: null, savedAt: new Date().toISOString() };
}

/** 表单是否有实质内容（用于判断是否需要恢复草稿） */
export function formIsDirty(form: Record<string, string>): boolean {
  return Object.entries(form).some(([k, v]) => {
    if (k === "cleanLevel" && v === "ISO 6") return false;
    if (k === "equipmentStatus" && v === "正常") return false;
    return String(v ?? "").trim() !== "";
  });
}

export { CLEAN_LEVELS };
