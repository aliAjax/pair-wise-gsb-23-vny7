import type { AuditEntry, InspectionRecord, ThresholdVersion } from "./types";
import { buildSeed } from "./domain";

const DB_NAME = "hxwl-cleanroom-inspection";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
        if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "id" });
        if (!db.objectStoreNames.contains("thresholds")) db.createObjectStore("thresholds", { keyPath: "id" });
        if (!db.objectStoreNames.contains("audits")) db.createObjectStore("audits", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const values = await asPromise(tx.objectStore(store).getAll() as IDBRequest<T[]>);
  await txDone(tx);
  return values;
}

export async function putValue(store: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
}

export async function deleteValue(store: string, key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

/* ---------- 种子数据（同事务内判空，避免多标签页重复写入） ---------- */

let seedPromise: Promise<void> | null = null;

export function ensureSeed(): Promise<void> {
  if (!seedPromise) seedPromise = doSeed();
  return seedPromise;
}

async function doSeed(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["thresholds", "records", "audits"], "readwrite");
  const count = await asPromise(tx.objectStore("thresholds").count());
  if (count === 0) {
    const seed = buildSeed();
    for (const t of seed.thresholds) tx.objectStore("thresholds").put(t);
    for (const r of seed.records) tx.objectStore("records").put(r);
    for (const a of seed.audits) tx.objectStore("audits").put(a);
  }
  await txDone(tx);
}

/* ---------- 乐观锁写入：版本检查与写入在同一事务，跨页面也不会覆盖 ---------- */

export type SaveResult =
  | { ok: true; record: InspectionRecord }
  | { ok: false; reason: "conflict" | "locked"; latest: InspectionRecord }
  | { ok: false; reason: "missing" };

/**
 * 保存记录。expectedVersion 为提交方基于的记录版本（新建为 0）。
 * 若库中版本已前进（其他页面已保存）或记录已复核锁定，则拒绝写入并返回最新记录。
 */
export async function saveRecord(
  incoming: InspectionRecord,
  expectedVersion: number,
  audit: AuditEntry
): Promise<SaveResult> {
  const db = await openDb();
  const tx = db.transaction(["records", "audits"], "readwrite");
  const store = tx.objectStore("records");
  const existing = (await asPromise(store.get(incoming.id))) as InspectionRecord | undefined;

  if (expectedVersion === 0) {
    if (existing) return { ok: false, reason: "conflict", latest: existing };
  } else {
    if (!existing) return { ok: false, reason: "missing" };
    if (existing.status === "reviewed") return { ok: false, reason: "locked", latest: existing };
    if (existing.version !== expectedVersion) return { ok: false, reason: "conflict", latest: existing };
  }

  const toSave: InspectionRecord = {
    ...incoming,
    // 以库中现状为准，保留创建信息与复核状态
    ...(existing
      ? {
          createdAt: existing.createdAt,
          status: existing.status,
          reviewedBy: existing.reviewedBy,
          reviewedAt: existing.reviewedAt,
        }
      : {}),
    version: expectedVersion + 1,
    updatedAt: Date.now(),
  };
  store.put(toSave);
  tx.objectStore("audits").put(audit);
  await txDone(tx);
  return { ok: true, record: toSave };
}

export type ReviewResult =
  | { ok: true; record: InspectionRecord }
  | { ok: false; reason: "conflict" | "already-reviewed"; latest: InspectionRecord }
  | { ok: false; reason: "missing" };

/** 复核通过：同样做版本检查，通过后记录锁定 */
export async function reviewRecord(
  id: string,
  expectedVersion: number,
  reviewer: string,
  audit: AuditEntry
): Promise<ReviewResult> {
  const db = await openDb();
  const tx = db.transaction(["records", "audits"], "readwrite");
  const store = tx.objectStore("records");
  const existing = (await asPromise(store.get(id))) as InspectionRecord | undefined;

  if (!existing) return { ok: false, reason: "missing" };
  if (existing.status === "reviewed") return { ok: false, reason: "already-reviewed", latest: existing };
  if (existing.version !== expectedVersion) return { ok: false, reason: "conflict", latest: existing };

  const toSave: InspectionRecord = {
    ...existing,
    status: "reviewed",
    reviewedBy: reviewer,
    reviewedAt: Date.now(),
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
  store.put(toSave);
  tx.objectStore("audits").put(audit);
  await txDone(tx);
  return { ok: true, record: toSave };
}

/** 发布新阈值版本（旧版本与历史记录判定不受影响） */
export async function publishThreshold(threshold: ThresholdVersion, audit: AuditEntry): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["thresholds", "audits"], "readwrite");
  tx.objectStore("thresholds").put(threshold);
  tx.objectStore("audits").put(audit);
  await txDone(tx);
}
