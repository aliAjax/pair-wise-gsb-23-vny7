import { useSyncExternalStore } from "react";
import type { AuditEntry, DB, Draft, InspectionRecord, ThresholdVersion } from "./types";
import { CLEAN_LEVELS } from "./types";
import { buildNextThreshold, judge, limitsFor, uid } from "./domain";

const STORAGE_KEY = "hxwl-cleanroom-db-v1";
const CHANNEL = "hxwl-cleanroom-inspection";

/* ---------------- 种子数据 ---------------- */

function seedThresholds(): ThresholdVersion[] {
  return [
    {
      version: 1,
      label: "v1.0",
      effectiveAt: "2026-01-01T08:00:00.000Z",
      publishedBy: "系统初始化",
      note: "初始当班阈值：按 ISO 14644 洁净等级与洁净室压差/温湿度规范设定。",
      active: true,
      limits: [
        { class: "ISO 5", particleLimit: 3520, pressureMin: 10, tempMin: 18, tempMax: 26, humidityMin: 40, humidityMax: 60 },
        { class: "ISO 6", particleLimit: 35200, pressureMin: 10, tempMin: 18, tempMax: 26, humidityMin: 40, humidityMax: 60 },
        { class: "ISO 7", particleLimit: 352000, pressureMin: 10, tempMin: 18, tempMax: 26, humidityMin: 40, humidityMax: 60 },
        { class: "黄光区", particleLimit: 352000, pressureMin: 10, tempMin: 18, tempMax: 26, humidityMin: 40, humidityMax: 60 },
      ],
    },
  ];
}

function seedRecords(thresholds: ThresholdVersion[]): InspectionRecord[] {
  const t1 = thresholds[0];
  const mk = (
    partial: Partial<InspectionRecord> & {
      recordNo: string;
      roomNo: string;
      cleanLevel: string;
      particleCount: number;
      temperature: number;
      humidity: number;
      pressureDiff: number;
      equipmentStatus: string;
      handlingNote: string;
      createdBy: string;
      createdAt: string;
      status: InspectionRecord["status"];
    },
  ): InspectionRecord => {
    const limits = limitsFor(t1, partial.cleanLevel);
    const judgment = judge(
      limits,
      {
        particleCount: partial.particleCount,
        temperature: partial.temperature,
        humidity: partial.humidity,
        pressureDiff: partial.pressureDiff,
      },
      t1.version,
    );
    return {
      id: uid(),
      version: 1,
      thresholdVersion: t1.version,
      reviewedBy: partial.status === "reviewed" ? "厂务工程师" : undefined,
      reviewedAt: partial.status === "reviewed" ? partial.createdAt : undefined,
      submittedAt: partial.status !== "draft" ? partial.createdAt : undefined,
      ...partial,
      judgment,
      updatedAt: partial.createdAt,
    } as InspectionRecord;
  };

  return [
    mk({
      recordNo: "CR-1201",
      roomNo: "CR-1201",
      cleanLevel: "ISO 5",
      particleCount: 3680,
      temperature: 22.4,
      humidity: 52,
      pressureDiff: 12,
      equipmentStatus: "异常",
      handlingNote: "0.5μm粒子超限，已通知厂务，待停机检查高效过滤器。",
      createdBy: "巡检员",
      createdAt: "2026-09-20T09:12:00.000Z",
      status: "reviewed",
    }),
    mk({
      recordNo: "CR-2107",
      roomNo: "CR-2107",
      cleanLevel: "ISO 6",
      particleCount: 28600,
      temperature: 23.1,
      humidity: 55,
      pressureDiff: 15,
      equipmentStatus: "正常",
      handlingNote: "压差15Pa，温湿度正常，巡检无异常。",
      createdBy: "巡检员",
      createdAt: "2026-09-22T10:30:00.000Z",
      status: "reviewed",
    }),
    mk({
      recordNo: "Y-0302",
      roomNo: "Y-0302",
      cleanLevel: "黄光区",
      particleCount: 302000,
      temperature: 24.8,
      humidity: 59,
      pressureDiff: 12,
      equipmentStatus: "关注",
      handlingNote: "湿度接近上限（59%RH），建议关注除湿负载。",
      createdBy: "巡检员",
      createdAt: "2026-09-28T15:45:00.000Z",
      status: "submitted",
    }),
  ];
}

function seedAudit(records: InspectionRecord[]): AuditEntry[] {
  const entries: AuditEntry[] = [
    {
      id: uid(),
      ts: "2026-01-01T08:00:00.000Z",
      actor: "系统初始化",
      action: "threshold.published",
      detail: "初始阈值版本 v1.0 发布，当班阈值生效。",
    },
  ];
  for (const r of records) {
    entries.push({
      id: uid(),
      ts: r.createdAt,
      actor: r.createdBy,
      action: "record.created",
      recordId: r.id,
      recordNo: r.recordNo,
      fromVersion: 0,
      toVersion: 1,
      detail: `新建巡检记录，按阈值 v${r.thresholdVersion} 判定：${r.judgment.level}`,
    });
    if (r.status !== "draft") {
      entries.push({
        id: uid(),
        ts: r.submittedAt ?? r.createdAt,
        actor: r.createdBy,
        action: "record.submitted",
        recordId: r.id,
        recordNo: r.recordNo,
        fromVersion: 1,
        toVersion: 1,
        detail: "提交复核。",
      });
    }
    if (r.status === "reviewed") {
      entries.push({
        id: uid(),
        ts: r.reviewedAt ?? r.createdAt,
        actor: r.reviewedBy ?? "厂务工程师",
        action: "record.review_approved",
        recordId: r.id,
        recordNo: r.recordNo,
        fromVersion: 1,
        toVersion: 1,
        detail: "厂务工程师复核通过，记录锁定不可修改。",
      });
    }
  }
  return entries.sort((a, b) => a.ts.localeCompare(b.ts));
}

function seedDB(): DB {
  const thresholds = seedThresholds();
  const records = seedRecords(thresholds);
  return { thresholds, records, audit: seedAudit(records), drafts: {} };
}

/* ---------------- 持久化 ---------------- */

let db: DB = loadDB();
const listeners = new Set<() => void>();
const channel =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;

function loadDB(): DB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DB;
      if (parsed && Array.isArray(parsed.thresholds) && Array.isArray(parsed.records)) {
        return { ...parsed, drafts: parsed.drafts ?? {} };
      }
    }
  } catch {
    // 损坏则重建
  }
  const seeded = seedDB();
  // 首次加载即持久化种子数据，确保只浏览后关闭页面也能恢复
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  } catch {
    // 存储不可用时静默降级为内存态
  }
  return seeded;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // 存储不可用时静默降级为内存态
  }
  channel?.postMessage({ type: "db-changed", at: Date.now() });
  listeners.forEach((l) => l());
}

channel?.addEventListener("message", () => {
  // 其他标签页写入后，以 localStorage 为准重载
  db = loadDB();
  listeners.forEach((l) => l());
});

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      db = loadDB();
      listeners.forEach((l) => l());
    }
  });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDB(): DB {
  return useSyncExternalStore(
    subscribe,
    () => db,
    () => db,
  );
}

/* ---------------- 审计 ---------------- */

function pushAudit(entry: Omit<AuditEntry, "id" | "ts"> & { ts?: string }) {
  db.audit.push({ id: uid(), ts: entry.ts ?? new Date().toISOString(), ...entry });
}

/* ---------------- 阈值发布 ---------------- */

export function publishThreshold(input: {
  note: string;
  limits: ThresholdVersion["limits"];
  actor: string;
}): { ok: true; version: number } | { ok: false; error: string } {
  const current = db.thresholds.find((t) => t.active) ?? db.thresholds[db.thresholds.length - 1];
  const next = buildNextThreshold(current, { note: input.note, limits: input.limits }, input.actor);
  db.thresholds = db.thresholds.map((t) => ({ ...t, active: false })).concat(next);
  pushAudit({
    actor: input.actor,
    action: "threshold.published",
    detail: `发布阈值 ${next.label}，仅对之后新建的巡检记录生效；历史记录仍按 v${current.version} 判定。`,
  });
  persist();
  return { ok: true, version: next.version };
}

/* ---------------- 记录保存（乐观锁） ---------------- */

export interface SaveInput {
  id?: string;
  form: Record<string, string>;
  baseVersion: number | null;
  actor: string;
  submit: boolean;
}

export type SaveResult =
  | { ok: true; record: InspectionRecord }
  | { ok: false; reason: "conflict"; current: InspectionRecord }
  | { ok: false; reason: "not_found" };

function formToValues(form: Record<string, string>) {
  const num = (k: string): number | "" => {
    const v = form[k];
    if (v === undefined || v === "") return "";
    const n = Number(v);
    return Number.isFinite(n) ? n : "";
  };
  return {
    particleCount: num("particleCount"),
    temperature: num("temperature"),
    humidity: num("humidity"),
    pressureDiff: num("pressureDiff"),
  };
}

export function saveRecord(input: SaveInput): SaveResult {
  const active = db.thresholds.find((t) => t.active) ?? db.thresholds[db.thresholds.length - 1];
  const values = formToValues(input.form);
  const cleanLevel = input.form.cleanLevel || CLEAN_LEVELS[1];
  const limits = limitsFor(active, cleanLevel);
  const judgment = judge(limits, values, active.version);
  const now = new Date().toISOString();

  if (input.id) {
    const existing = db.records.find((r) => r.id === input.id);
    if (!existing) {
      return { ok: false, reason: "not_found" };
    }
    // 乐观锁：baseVersion 与当前版本不一致即冲突，绝不覆盖对方结果
    if (existing.version !== input.baseVersion) {
      pushAudit({
        actor: input.actor,
        action: "record.conflict",
        recordId: existing.id,
        recordNo: existing.recordNo,
        fromVersion: input.baseVersion ?? undefined,
        toVersion: existing.version,
        detail: `提交时检测到版本冲突：编辑基线 v${input.baseVersion ?? "?"}，当前已为 v${existing.version}（${existing.updatedAt} ${existing.createdBy} 保存）。已保留提交方草稿，未覆盖对方结果。`,
      });
      persist();
      return { ok: false, reason: "conflict", current: existing };
    }
    // 已复核通过的记录锁定，后端拒绝任何修改
    if (existing.status === "reviewed") {
      return { ok: false, reason: "conflict", current: existing };
    }

    // 阈值版本快照不变：编辑重判仍按记录创建时的当班阈值版本，
    // 发布新阈值只影响之后新建的记录，历史记录永远按原版本显示判定。
    const recordThreshold =
      db.thresholds.find((t) => t.version === existing.thresholdVersion) ?? active;
    const limits = limitsFor(recordThreshold, cleanLevel);
    const judgment = judge(limits, values, recordThreshold.version);

    const nextStatus: InspectionRecord["status"] = input.submit ? "submitted" : existing.status;
    const updated: InspectionRecord = {
      ...existing,
      roomNo: input.form.roomNo.trim() || existing.roomNo,
      cleanLevel,
      particleCount: values.particleCount,
      temperature: values.temperature,
      humidity: values.humidity,
      pressureDiff: values.pressureDiff,
      equipmentStatus: input.form.equipmentStatus || existing.equipmentStatus,
      handlingNote: input.form.handlingNote ?? "",
      status: nextStatus,
      version: existing.version + 1,
      // 阈值版本快照不变：历史记录永远按创建时的当班阈值版本判定
      thresholdVersion: existing.thresholdVersion,
      judgment,
      updatedAt: now,
      submittedAt: input.submit ? existing.submittedAt ?? now : existing.submittedAt,
    };
    db.records = db.records.map((r) => (r.id === existing.id ? updated : r));
    pushAudit({
      actor: input.actor,
      action: "record.updated",
      recordId: updated.id,
      recordNo: updated.recordNo,
      fromVersion: existing.version,
      toVersion: updated.version,
      detail: `保存修改 v${existing.version} → v${updated.version}，按阈值 v${updated.thresholdVersion} 重新判定：${judgment.level}。`,
    });
    if (input.submit && existing.status === "draft") {
      pushAudit({
        actor: input.actor,
        action: "record.submitted",
        recordId: updated.id,
        recordNo: updated.recordNo,
        fromVersion: existing.version,
        toVersion: updated.version,
        detail: "草稿提交复核。",
      });
    }
    // 保存成功，清除该记录的草稿
    delete db.drafts[`record:${updated.id}`];
    persist();
    return { ok: true, record: updated };
  }

  // 新建：快照当前当班阈值版本
  const record: InspectionRecord = {
    id: uid(),
    recordNo: input.form.roomNo.trim() || `CR-${Date.now()}`,
    roomNo: input.form.roomNo.trim(),
    cleanLevel,
    particleCount: values.particleCount,
    temperature: values.temperature,
    humidity: values.humidity,
    pressureDiff: values.pressureDiff,
    equipmentStatus: input.form.equipmentStatus || "正常",
    handlingNote: input.form.handlingNote ?? "",
    status: input.submit ? "submitted" : "draft",
    version: 1,
    thresholdVersion: active.version,
    judgment,
    createdBy: input.actor,
    createdAt: now,
    updatedAt: now,
    submittedAt: input.submit ? now : undefined,
  };
  db.records = [record, ...db.records];
  pushAudit({
    actor: input.actor,
    action: "record.created",
    recordId: record.id,
    recordNo: record.recordNo,
    fromVersion: 0,
    toVersion: 1,
    detail: `新建巡检记录，按当班阈值 v${active.version} 判定：${judgment.level}（阈值版本随记录快照，发布新阈值不影响本记录）。`,
  });
  if (input.submit) {
    pushAudit({
      actor: input.actor,
      action: "record.submitted",
      recordId: record.id,
      recordNo: record.recordNo,
      fromVersion: 1,
      toVersion: 1,
      detail: "提交复核。",
    });
  }
  delete db.drafts["new"];
  persist();
  return { ok: true, record };
}

/* ---------------- 复核（厂务工程师） ---------------- */

export function reviewRecord(input: {
  id: string;
  approve: boolean;
  actor: string;
  baseVersion?: number;
  comment?: string;
}): { ok: true } | { ok: false; reason: string; conflict?: boolean } {
  const existing = db.records.find((r) => r.id === input.id);
  if (!existing) return { ok: false, reason: "记录不存在" };
  if (existing.status === "reviewed") {
    return { ok: false, reason: "该记录已复核通过并锁定，不能重复复核" };
  }
  if (input.baseVersion !== undefined && existing.version !== input.baseVersion) {
    pushAudit({
      actor: input.actor,
      action: "record.conflict",
      recordId: existing.id,
      recordNo: existing.recordNo,
      fromVersion: input.baseVersion,
      toVersion: existing.version,
      detail: `复核时检测到记录已被他人修改（v${input.baseVersion} → v${existing.version}），已阻止本次复核。`,
    });
    persist();
    return { ok: false, reason: `记录已被他人修改至 v${existing.version}，请刷新后再复核`, conflict: true };
  }
  const now = new Date().toISOString();
  if (input.approve) {
    const updated: InspectionRecord = {
      ...existing,
      status: "reviewed",
      version: existing.version + 1,
      reviewedBy: input.actor,
      reviewedAt: now,
      updatedAt: now,
    };
    db.records = db.records.map((r) => (r.id === existing.id ? updated : r));
    pushAudit({
      actor: input.actor,
      action: "record.review_approved",
      recordId: existing.id,
      recordNo: existing.recordNo,
      fromVersion: existing.version,
      toVersion: updated.version,
      detail: `厂务工程师复核通过${input.comment ? `（备注：${input.comment}）` : ""}，记录锁定，不可再修改。`,
    });
  } else {
    const updated: InspectionRecord = {
      ...existing,
      status: "draft",
      version: existing.version + 1,
      updatedAt: now,
    };
    db.records = db.records.map((r) => (r.id === existing.id ? updated : r));
    pushAudit({
      actor: input.actor,
      action: "record.review_rejected",
      recordId: existing.id,
      recordNo: existing.recordNo,
      fromVersion: existing.version,
      toVersion: updated.version,
      detail: `复核退回修改${input.comment ? `（原因：${input.comment}）` : ""}，记录回到草稿可重新编辑。`,
    });
  }
  persist();
  return { ok: true };
}

/* ---------------- 草稿（中途关闭可恢复） ---------------- */

export function saveDraft(key: string, form: Record<string, string>, baseVersion: number | null) {
  const draft: Draft = { key, form, baseVersion, savedAt: new Date().toISOString() };
  db.drafts = { ...db.drafts, [key]: draft };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    channel?.postMessage({ type: "draft-changed", at: Date.now() });
  } catch {
    // 静默
  }
  // 不触发 listeners，避免输入时整树重渲染
}

export function getDraft(key: string): Draft | undefined {
  return db.drafts[key];
}

export function discardDraft(key: string) {
  if (!(key in db.drafts)) return;
  const next = { ...db.drafts };
  delete next[key];
  db.drafts = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    channel?.postMessage({ type: "draft-changed", at: Date.now() });
  } catch {
    // 静默
  }
  listeners.forEach((l) => l());
}

/** 供 UI 在冲突/远程更新后刷新内存中的 db 引用 */
export function reloadFromStorage() {
  db = loadDB();
  listeners.forEach((l) => l());
}
