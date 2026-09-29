import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import type {
  AuditEntry,
  Draft,
  InspectionRecord,
  JudgeLevel,
  RecordFormPayload,
  Role,
  Shift,
  ThresholdRule,
  ThresholdVersion,
} from "./types";
import {
  CLEANLINESS_LEVELS,
  DEVICE_STATUS,
  ROLES,
  SHIFTS,
  activeThreshold,
  judgeMetrics,
} from "./domain";
import * as repo from "./db";

const project = {
  id: "hxwl-09",
  port: 5109,
  title: "半导体洁净室巡检",
  subtitle: "洁净等级阈值版本管理、粒子计数判定、复核锁定与审计追踪",
  stack: "React + Vite + TypeScript + CSS",
};

const ROLE_DESC: Record<Role, string> = {
  巡检员: "录入与提交巡检记录",
  厂务工程师: "复核记录（复核后锁定）、发布阈值版本",
  班组长: "查看记录与导出摘要（只读）",
};

const LEVEL_CLASS: Record<JudgeLevel, string> = { 正常: "ok", 关注: "watch", 异常: "danger" };

const RULE_FIELDS: { key: keyof ThresholdRule; label: string }[] = [
  { key: "particleUpper", label: "粒子上限 个/m³" },
  { key: "tempLower", label: "温度下限 ℃" },
  { key: "tempUpper", label: "温度上限 ℃" },
  { key: "humidityLower", label: "湿度下限 %RH" },
  { key: "humidityUpper", label: "湿度上限 %RH" },
  { key: "pressureLower", label: "压差下限 Pa" },
  { key: "pressureUpper", label: "压差上限 Pa" },
];

interface EditorState {
  draftId: string; // "new" 或记录 id
  baseVersion: number; // 新建为 0
  payload: RecordFormPayload;
  restored: boolean;
}

interface ConflictState {
  kind: "conflict" | "locked";
  latest: InspectionRecord;
}

function fmtTime(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function genRecordId(): string {
  return `REC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

function genAuditId(): string {
  return `A-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function emptyPayload(shift: Shift): RecordFormPayload {
  return {
    roomNo: "",
    cleanliness: "ISO 5",
    shift,
    particleCount: "",
    temperature: "",
    humidity: "",
    pressure: "",
    deviceStatus: "运行正常",
    note: "",
  };
}

function payloadFromRecord(r: InspectionRecord): RecordFormPayload {
  return {
    roomNo: r.roomNo,
    cleanliness: r.cleanliness,
    shift: r.shift,
    particleCount: String(r.particleCount),
    temperature: String(r.temperature),
    humidity: String(r.humidity),
    pressure: String(r.pressure),
    deviceStatus: r.deviceStatus,
    note: r.note,
  };
}

function payloadHasContent(p: RecordFormPayload): boolean {
  return [p.roomNo, p.particleCount, p.temperature, p.humidity, p.pressure, p.note].some(
    (v) => v.trim() !== ""
  );
}

type ParseResult =
  | { ok: true; metrics: { particleCount: number; temperature: number; humidity: number; pressure: number } }
  | { ok: false; errors: string[] };

function parsePayload(p: RecordFormPayload): ParseResult {
  const errors: string[] = [];
  if (!p.roomNo.trim()) errors.push("房间编号不能为空");
  const fields: [string, string][] = [
    ["粒子计数", p.particleCount],
    ["温度", p.temperature],
    ["湿度", p.humidity],
    ["压差", p.pressure],
  ];
  const values: Record<string, number> = {};
  for (const [label, raw] of fields) {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) errors.push(`${label}需为数字`);
    else values[label] = n;
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    metrics: {
      particleCount: values["粒子计数"],
      temperature: values["温度"],
      humidity: values["湿度"],
      pressure: values["压差"],
    },
  };
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function Badge({ level }: { level: JudgeLevel }) {
  return <span className={`badge ${LEVEL_CLASS[level]}`}>{level}</span>;
}

function App() {
  const [ready, setReady] = useState(false);
  const [records, setRecords] = useState<InspectionRecord[]>([]);
  const [thresholds, setThresholds] = useState<ThresholdVersion[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editor, setEditor] = useState<EditorState>({
    draftId: "new",
    baseVersion: 0,
    payload: emptyPayload("早班"),
    restored: false,
  });
  const [role, setRole] = useState<Role>("巡检员");
  const [filter, setFilter] = useState<string>("全部");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showThresholdEditor, setShowThresholdEditor] = useState(false);
  const [thRules, setThRules] = useState<Record<string, ThresholdRule> | null>(null);
  const [thNote, setThNote] = useState("");
  const channelRef = useRef<BroadcastChannel | null>(null);

  const reloadLists = useCallback(async () => {
    const [recs, ths, aus, drs] = await Promise.all([
      repo.getAll<InspectionRecord>("records"),
      repo.getAll<ThresholdVersion>("thresholds"),
      repo.getAll<AuditEntry>("audits"),
      repo.getAll<Draft>("drafts"),
    ]);
    setRecords(recs.sort((a, b) => b.updatedAt - a.updatedAt));
    setThresholds(ths.sort((a, b) => b.publishedAt - a.publishedAt));
    setAudits(aus.sort((a, b) => b.ts - a.ts));
    setDrafts(drs.sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);

  const broadcast = useCallback(() => {
    try {
      channelRef.current?.postMessage("sync");
    } catch {
      /* 不支持 BroadcastChannel 时忽略 */
    }
  }, []);

  // 初始化：种子数据 + 从 IndexedDB 恢复记录 / 草稿 / 审计
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await repo.ensureSeed();
      const [recs, ths, aus, drs] = await Promise.all([
        repo.getAll<InspectionRecord>("records"),
        repo.getAll<ThresholdVersion>("thresholds"),
        repo.getAll<AuditEntry>("audits"),
        repo.getAll<Draft>("drafts"),
      ]);
      if (cancelled) return;
      setRecords(recs.sort((a, b) => b.updatedAt - a.updatedAt));
      setThresholds(ths.sort((a, b) => b.publishedAt - a.publishedAt));
      setAudits(aus.sort((a, b) => b.ts - a.ts));
      setDrafts(drs.sort((a, b) => b.updatedAt - a.updatedAt));
      if (drs.length > 0) {
        const latest = [...drs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        setEditor({ draftId: latest.id, baseVersion: latest.baseVersion, payload: latest.payload, restored: true });
        setNotice(
          `页面恢复：已载入未提交草稿（${latest.id === "new" ? "新建巡检" : "记录编辑"}），已提交记录与审计轨迹已从本地存储恢复`
        );
      }
      setReady(true);
    })().catch((err) => setNotice(`初始化失败：${String(err)}`));
    return () => {
      cancelled = true;
    };
  }, []);

  // 跨标签页同步：其他页面保存后刷新列表（不影响本页草稿）
  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel("hxwl-09-sync");
      ch.onmessage = () => void reloadLists();
      channelRef.current = ch;
    } catch {
      /* 忽略 */
    }
    return () => ch?.close();
  }, [reloadLists]);

  // 表单变更自动保存草稿（防抖 400ms），关闭页面后可恢复
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      if (editor.draftId === "new" && !payloadHasContent(editor.payload)) {
        void repo.deleteValue("drafts", "new").catch(() => {});
        setDrafts((ds) => ds.filter((d) => d.id !== "new"));
        return;
      }
      const draft: Draft = {
        id: editor.draftId,
        baseVersion: editor.baseVersion,
        payload: editor.payload,
        updatedAt: Date.now(),
      };
      void repo
        .putValue("drafts", draft)
        .then(() =>
          setDrafts((ds) => [draft, ...ds.filter((d) => d.id !== draft.id)].sort((a, b) => b.updatedAt - a.updatedAt))
        )
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [editor, ready]);

  // 提示自动消失
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const active = useMemo(() => activeThreshold(thresholds), [thresholds]);
  const editingRecord =
    editor.draftId === "new" ? null : records.find((r) => r.id === editor.draftId) ?? null;
  // 新建记录按当前生效版本判定；编辑历史记录仍按其原阈值版本判定
  const editorThreshold = editingRecord
    ? thresholds.find((t) => t.id === editingRecord.thresholdVersionId) ?? active
    : active;

  const preview = useMemo(() => {
    if (!editorThreshold) return null;
    const parsed = parsePayload(editor.payload);
    if (!parsed.ok) return null;
    const rule = editorThreshold.rules[editor.payload.cleanliness];
    if (!rule) return null;
    return judgeMetrics(parsed.metrics, rule);
  }, [editor.payload, editorThreshold]);

  const filteredRecords = useMemo(
    () => (filter === "全部" ? records : records.filter((r) => r.cleanliness === filter)),
    [records, filter]
  );

  const stats = useMemo(() => {
    const detailOf = (r: InspectionRecord, item: string) => r.judgment.details.find((d) => d.item === item);
    return {
      particleAbnormal: records.filter((r) => detailOf(r, "粒子计数")?.level === "异常").length,
      pressureAbnormal: records.filter((r) => detailOf(r, "压差")?.level === "异常").length,
      tempHumidityShift: records.filter((r) =>
        ["温度", "湿度"].some((it) => (detailOf(r, it)?.level ?? "正常") !== "正常")
      ).length,
      pendingReview: records.filter((r) => r.status === "submitted").length,
    };
  }, [records]);

  const canSubmit = role !== "班组长";
  const canReview = role === "厂务工程师";
  const canPublish = role === "厂务工程师";

  const makeAudit = (action: string, recordId: string | undefined, detail: string): AuditEntry => ({
    id: genAuditId(),
    ts: Date.now(),
    actor: role,
    action,
    recordId,
    detail,
  });

  const roomOf = (id?: string) => records.find((r) => r.id === id)?.roomNo ?? id ?? "";

  const setField = <K extends keyof RecordFormPayload>(key: K, value: RecordFormPayload[K]) =>
    setEditor((e) => ({ ...e, payload: { ...e.payload, [key]: value } }));

  function resetEditorToNew() {
    setEditor((e) => ({ draftId: "new", baseVersion: 0, payload: emptyPayload(e.payload.shift), restored: false }));
  }

  async function handleSubmit() {
    if (busy) return;
    if (!canSubmit) {
      setNotice("班组长为只读角色，不能提交巡检记录");
      return;
    }
    const parsed = parsePayload(editor.payload);
    if (!parsed.ok) {
      setNotice(`表单校验失败：${parsed.errors.join("；")}`);
      return;
    }
    if (!editorThreshold) {
      setNotice("没有已发布的阈值版本，请厂务工程师先发布阈值");
      return;
    }
    const rule = editorThreshold.rules[editor.payload.cleanliness];
    if (!rule) {
      setNotice(`阈值版本 ${editorThreshold.label} 缺少 ${editor.payload.cleanliness} 的限值`);
      return;
    }
    const judgment = judgeMetrics(parsed.metrics, rule);
    const isNew = editor.draftId === "new";
    const now = Date.now();
    const record: InspectionRecord = {
      id: isNew ? genRecordId() : editor.draftId,
      roomNo: editor.payload.roomNo.trim(),
      cleanliness: editor.payload.cleanliness,
      shift: editor.payload.shift,
      inspector: editingRecord?.inspector ?? role,
      ...parsed.metrics,
      deviceStatus: editor.payload.deviceStatus,
      note: editor.payload.note.trim(),
      status: editingRecord?.status ?? "submitted",
      thresholdVersionId: editingRecord?.thresholdVersionId ?? editorThreshold.id,
      thresholdLabel: editingRecord?.thresholdLabel ?? editorThreshold.label,
      judgment,
      version: editingRecord?.version ?? 0,
      createdAt: editingRecord?.createdAt ?? now,
      updatedAt: now,
      reviewedBy: editingRecord?.reviewedBy,
      reviewedAt: editingRecord?.reviewedAt,
    };

    setBusy(true);
    try {
      const audit = makeAudit(
        isNew ? "新建巡检记录" : "更新巡检记录",
        record.id,
        `记录版本 v${editor.baseVersion + 1} · 阈值版本 ${record.thresholdLabel} · 班次 ${record.shift} · 判定 ${judgment.overall}`
      );
      const result = await repo.saveRecord(record, editor.baseVersion, audit);
      if (result.ok) {
        await repo.deleteValue("drafts", editor.draftId).catch(() => {});
        setDrafts((ds) => ds.filter((d) => d.id !== editor.draftId));
        resetEditorToNew();
        setNotice(`已保存：记录版本 v${result.record.version} · 按阈值版本 ${record.thresholdLabel} 判定为 ${judgment.overall}`);
        await reloadLists();
        broadcast();
      } else if (result.reason === "missing") {
        setNotice("该记录已不存在，草稿已保留");
      } else {
        // 版本冲突或已锁定：保留草稿，绝不覆盖对方刚保存的结果
        const locked = result.reason === "locked" || result.latest.status === "reviewed";
        setConflict({ kind: locked ? "locked" : "conflict", latest: result.latest });
        await repo
          .putValue(
            "audits",
            makeAudit(
              locked ? "修改被阻止（记录已复核锁定）" : "版本冲突（提交被阻止）",
              record.id,
              `基于记录版本 v${editor.baseVersion} 提交，最新版本为 v${result.latest.version}；草稿已保留，未覆盖对方结果`
            )
          )
          .catch(() => {});
        await reloadLists();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleReview(record: InspectionRecord) {
    if (busy) return;
    setBusy(true);
    try {
      const audit = makeAudit(
        "复核通过",
        record.id,
        `记录版本 v${record.version + 1} · 阈值版本 ${record.thresholdLabel} · 判定 ${record.judgment.overall}；复核后记录锁定，不可再修改`
      );
      const result = await repo.reviewRecord(record.id, record.version, role, audit);
      if (result.ok) {
        setNotice(`记录 ${record.roomNo} 已复核通过并锁定（记录版本 v${result.record.version}）`);
      } else if (result.reason === "already-reviewed") {
        setNotice(`记录 ${record.roomNo} 已被复核`);
      } else if (result.reason === "conflict") {
        setNotice(`记录 ${record.roomNo} 已被他人修改（最新 v${result.latest.version}），请基于最新版本重试`);
      } else {
        setNotice("该记录已不存在");
      }
      await reloadLists();
      broadcast();
    } finally {
      setBusy(false);
    }
  }

  function handleEditRecord(record: InspectionRecord) {
    if (!canSubmit) {
      setNotice("班组长为只读角色，不能编辑记录");
      return;
    }
    if (record.status === "reviewed") {
      setNotice(`记录 ${record.roomNo} 已由 ${record.reviewedBy} 复核锁定，不能再修改`);
      return;
    }
    setEditor({
      draftId: record.id,
      baseVersion: record.version,
      payload: payloadFromRecord(record),
      restored: false,
    });
    setNotice(`正在编辑记录 ${record.roomNo}（当前版本 v${record.version}），表单内容会自动保存为草稿`);
    document.getElementById("editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleClearDraft() {
    await repo.deleteValue("drafts", editor.draftId).catch(() => {});
    setDrafts((ds) => ds.filter((d) => d.id !== editor.draftId));
    resetEditorToNew();
    setConflict(null);
    setNotice("草稿已清空");
  }

  function handleRestoreDraft(d: Draft) {
    setEditor({ draftId: d.id, baseVersion: d.baseVersion, payload: d.payload, restored: true });
    setNotice(`已恢复草稿（${d.id === "new" ? "新建巡检" : `记录 ${roomOf(d.id)}`}，基于记录版本 v${d.baseVersion}）`);
    document.getElementById("editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleRebase() {
    if (!conflict) return;
    setEditor((e) => ({ ...e, baseVersion: conflict.latest.version }));
    setNotice(`已基于最新版本 v${conflict.latest.version} 继续编辑，你的草稿内容已保留`);
    setConflict(null);
  }

  function openThresholdEditor() {
    if (!active) return;
    setThRules(structuredClone(active.rules));
    setThNote("");
    setShowThresholdEditor(true);
  }

  async function handlePublishThreshold() {
    if (busy || !thRules) return;
    for (const level of CLEANLINESS_LEVELS) {
      const r = thRules[level];
      if (!r) {
        setNotice(`缺少 ${level} 的阈值`);
        return;
      }
      if (RULE_FIELDS.some((f) => !Number.isFinite(r[f.key]))) {
        setNotice(`${level} 的阈值需全部为数字`);
        return;
      }
      if (r.tempLower >= r.tempUpper || r.humidityLower >= r.humidityUpper || r.pressureLower >= r.pressureUpper) {
        setNotice(`${level} 的下限需小于上限`);
        return;
      }
    }
    setBusy(true);
    try {
      const label = `v1.${thresholds.length}`;
      const tv: ThresholdVersion = {
        id: `tv-${Date.now().toString(36)}`,
        label,
        publishedAt: Date.now(),
        publishedBy: role,
        note: thNote.trim() || "厂务发布新阈值版本",
        rules: thRules,
      };
      const audit = makeAudit(
        "发布阈值版本",
        undefined,
        `阈值版本 ${label} 已发布，仅影响之后新建的巡检记录；历史记录仍按原版本判定`
      );
      await repo.publishThreshold(tv, audit);
      setShowThresholdEditor(false);
      setThRules(null);
      setNotice(`阈值版本 ${label} 已发布；新建记录将按 ${label} 判定，历史记录判定不变`);
      await reloadLists();
      broadcast();
    } finally {
      setBusy(false);
    }
  }

  function handleExport() {
    const header = [
      "记录ID", "房间编号", "洁净等级", "班次", "巡检员",
      "粒子计数(个/m³)", "温度(℃)", "湿度(%RH)", "压差(Pa)", "设备状态",
      "综合判定", "判定明细(等于上限判异常)", "状态",
      "记录版本", "阈值版本",
      "复核人", "复核时间", "处理备注", "创建时间", "更新时间",
    ];
    const rows = [...records]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => [
        r.id, r.roomNo, r.cleanliness, r.shift, r.inspector,
        r.particleCount, r.temperature, r.humidity, r.pressure, r.deviceStatus,
        r.judgment.overall,
        r.judgment.details.map((d) => `${d.item}=${d.value}（${d.reason}）→${d.level}`).join("；"),
        r.status === "reviewed" ? "已复核" : "待复核",
        `v${r.version}`,
        r.thresholdLabel,
        r.reviewedBy ?? "",
        r.reviewedAt ? fmtTime(r.reviewedAt) : "",
        r.note,
        fmtTime(r.createdAt),
        fmtTime(r.updatedAt),
      ]);
    const csv = "\ufeff" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `洁净室巡检摘要-${new Date().toLocaleDateString("sv-SE")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    const audit = makeAudit("导出摘要", undefined, `导出 ${rows.length} 条记录（含记录版本与阈值版本）`);
    void repo.putValue("audits", audit).then(reloadLists).then(broadcast).catch(() => {});
    setNotice(`已导出 ${rows.length} 条记录摘要（含记录版本与阈值版本）`);
  }

  if (!ready) {
    return (
      <main className="app-shell">
        <p className="hint">正在从本地存储恢复数据…</p>
      </main>
    );
  }

  const isNew = editor.draftId === "new";

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">{project.id} · port {project.port}</p>
          <h1>{project.title}</h1>
          <p className="subtitle">{project.subtitle}</p>
        </div>
        <div className="stack-card">
          <span>技术栈</span>
          <strong>{project.stack}</strong>
          <span>持久化</span>
          <strong>IndexedDB 本地存储 · 关闭页面后草稿 / 记录 / 审计自动恢复</strong>
        </div>
      </section>

      {notice && (
        <div className="notice">
          <span>{notice}</span>
          <button onClick={() => setNotice("")} aria-label="关闭提示">×</button>
        </div>
      )}

      <section className="metrics-grid">
        <article className="metric-card">
          <span>粒子异常</span>
          <strong>{stats.particleAbnormal}</strong>
          <i className="status-danger" />
        </article>
        <article className="metric-card">
          <span>压差异常</span>
          <strong>{stats.pressureAbnormal}</strong>
          <i className="status-watch" />
        </article>
        <article className="metric-card">
          <span>温湿度偏移</span>
          <strong>{stats.tempHumidityShift}</strong>
          <i className="status-watch" />
        </article>
        <article className="metric-card">
          <span>待复核</span>
          <strong>{stats.pendingReview}</strong>
          <i className="status-ok" />
        </article>
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <h2>当前角色</h2>
          <div className="chips">
            {ROLES.map((r) => (
              <button key={r} className={r === role ? "active" : ""} onClick={() => setRole(r)}>
                {r}
              </button>
            ))}
          </div>
          <p className="hint">{ROLE_DESC[role]}</p>

          <h2>洁净等级筛选</h2>
          <div className="chips muted">
            {["全部", ...CLEANLINESS_LEVELS].map((f) => (
              <button key={f} className={f === filter ? "active" : ""} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>

          <h2>当前生效阈值</h2>
          {active ? (
            <p className="hint">
              {active.label} · {active.publishedBy}
              <br />
              {fmtTime(active.publishedAt)}
              <br />
              新建记录将按此版本判定
            </p>
          ) : (
            <p className="hint">暂无已发布阈值</p>
          )}

          <h2>未提交草稿（{drafts.length}）</h2>
          {drafts.length === 0 ? (
            <p className="hint">无</p>
          ) : (
            drafts.map((d) => (
              <button key={d.id} className="draft-chip" onClick={() => handleRestoreDraft(d)}>
                {d.id === "new" ? "新建巡检" : `记录 ${roomOf(d.id)}`} · 基于 v{d.baseVersion}
                <br />
                <span className="hint">{fmtTime(d.updatedAt)}</span>
              </button>
            ))
          )}
        </aside>

        <section className="panel" id="editor-panel">
          <div className="section-heading">
            <div>
              <p>洁净室巡检</p>
              <h2>{isNew ? "新建巡检记录" : `编辑记录 ${editingRecord?.roomNo ?? roomOf(editor.draftId)}`}</h2>
            </div>
            <div className="heading-actions">
              {!isNew && <button onClick={resetEditorToNew}>取消编辑</button>}
              <button onClick={handleClearDraft}>清空草稿</button>
            </div>
          </div>

          {editor.restored && <p className="hint">已恢复未提交的草稿内容</p>}
          {!isNew && (
            <p className="hint">
              基于记录版本 v{editor.baseVersion} 编辑；若其他页面已保存更新版本，提交时将提示版本冲突且草稿保留
            </p>
          )}
          <p className="hint">
            判定依据：阈值版本 {editorThreshold?.label ?? "—"}
            {editorThreshold && `（${editorThreshold.publishedBy} 发布于 ${fmtTime(editorThreshold.publishedAt)}）`}
            · 规则：测量值 ≥ 上限（含等于）即判异常，达到上限 90% 判关注
          </p>

          <div className="field-grid">
            <label>
              <span>房间编号</span>
              <input
                value={editor.payload.roomNo}
                placeholder="如 CR-1201"
                onChange={(e) => setField("roomNo", e.target.value)}
              />
            </label>
            <label>
              <span>洁净等级</span>
              <select value={editor.payload.cleanliness} onChange={(e) => setField("cleanliness", e.target.value)}>
                {CLEANLINESS_LEVELS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              <span>班次</span>
              <select value={editor.payload.shift} onChange={(e) => setField("shift", e.target.value as Shift)}>
                {SHIFTS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              <span>设备状态</span>
              <select value={editor.payload.deviceStatus} onChange={(e) => setField("deviceStatus", e.target.value)}>
                {DEVICE_STATUS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              <span>粒子计数（≥0.5μm，个/m³）</span>
              <input
                type="number"
                value={editor.payload.particleCount}
                placeholder="如 3200"
                onChange={(e) => setField("particleCount", e.target.value)}
              />
            </label>
            <label>
              <span>温度（℃）</span>
              <input
                type="number"
                step="0.1"
                value={editor.payload.temperature}
                placeholder="如 22.5"
                onChange={(e) => setField("temperature", e.target.value)}
              />
            </label>
            <label>
              <span>湿度（%RH）</span>
              <input
                type="number"
                step="0.1"
                value={editor.payload.humidity}
                placeholder="如 46"
                onChange={(e) => setField("humidity", e.target.value)}
              />
            </label>
            <label>
              <span>压差（Pa）</span>
              <input
                type="number"
                step="0.1"
                value={editor.payload.pressure}
                placeholder="如 12"
                onChange={(e) => setField("pressure", e.target.value)}
              />
            </label>
            <label className="span-2">
              <span>处理备注</span>
              <input
                value={editor.payload.note}
                placeholder="异常情况与处理措施"
                onChange={(e) => setField("note", e.target.value)}
              />
            </label>
          </div>

          {preview && (
            <div className="preview">
              <span className="hint">判定预览（阈值 {editorThreshold?.label}）：</span>
              {preview.details.map((d) => (
                <span key={d.item} className={`badge ${LEVEL_CLASS[d.level]}`} title={`${d.reason}（限值 ${d.limit}）`}>
                  {d.item} {d.level}
                </span>
              ))}
              <span className="hint">综合：</span>
              <Badge level={preview.overall} />
            </div>
          )}

          <button
            className="primary-action"
            disabled={!canSubmit || busy}
            title={canSubmit ? "" : "班组长为只读角色"}
            onClick={handleSubmit}
          >
            {busy ? "提交中…" : isNew ? "提交巡检记录" : `保存修改（将生成 v${editor.baseVersion + 1}）`}
          </button>
        </section>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>阈值版本</p>
            <h2>阈值版本管理</h2>
          </div>
          {canPublish && !showThresholdEditor && (
            <button className="primary-action" onClick={openThresholdEditor}>
              发布新阈值版本
            </button>
          )}
        </div>
        <p className="hint">发布新阈值只影响之后新建的巡检记录；历史记录仍按各自创建时的阈值版本显示判定。</p>

        <div className="threshold-list">
          {thresholds.map((t) => (
            <div key={t.id} className={`threshold-item ${t.id === active?.id ? "current" : ""}`}>
              <strong>{t.label}</strong>
              {t.id === active?.id && <span className="badge ok">当前生效</span>}
              <span className="meta">{t.publishedBy} · {fmtTime(t.publishedAt)}</span>
              <span className="meta">{t.note}</span>
              <span className="meta">关联记录 {records.filter((r) => r.thresholdVersionId === t.id).length} 条</span>
            </div>
          ))}
        </div>

        {showThresholdEditor && thRules && (
          <div className="threshold-editor">
            <h3>新阈值版本 v1.{thresholds.length}（基于 {active?.label} 复制，可修改）</h3>
            <div className="table-scroll">
              <table className="detail-table">
                <thead>
                  <tr>
                    <th>洁净等级</th>
                    {RULE_FIELDS.map((f) => (
                      <th key={f.key}>{f.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CLEANLINESS_LEVELS.map((level) => (
                    <tr key={level}>
                      <td>{level}</td>
                      {RULE_FIELDS.map((f) => {
                        const v = thRules[level]?.[f.key];
                        return (
                          <td key={f.key}>
                            <input
                              type="number"
                              step="any"
                              value={Number.isFinite(v) ? String(v) : ""}
                              onChange={(e) =>
                                setThRules((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        [level]: {
                                          ...prev[level],
                                          [f.key]: e.target.value === "" ? NaN : Number(e.target.value),
                                        },
                                      }
                                    : prev
                                )
                              }
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="threshold-note">
              <span>版本说明</span>
              <input
                value={thNote}
                placeholder="如：ISO 5 粒子上限收紧"
                onChange={(e) => setThNote(e.target.value)}
              />
            </label>
            <div className="heading-actions">
              <button className="primary-action" disabled={busy} onClick={handlePublishThreshold}>
                确认发布（仅影响新记录）
              </button>
              <button onClick={() => { setShowThresholdEditor(false); setThRules(null); }}>取消</button>
            </div>
          </div>
        )}
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p>{filter === "全部" ? "全部记录" : filter}</p>
            <h2>巡检记录（{filteredRecords.length}）</h2>
          </div>
          <button onClick={handleExport}>导出摘要（CSV）</button>
        </div>
        <div className="record-list">
          {filteredRecords.length === 0 && <p className="hint">暂无记录</p>}
          {filteredRecords.map((r, index) => (
            <article key={r.id} className="record-card">
              <div className="record-index">{String(index + 1).padStart(2, "0")}</div>
              <div className="record-main">
                <div className="record-head">
                  <h3>{r.roomNo}</h3>
                  <span className="badge neutral">{r.cleanliness}</span>
                  <Badge level={r.judgment.overall} />
                  {r.status === "reviewed" ? (
                    <span className="badge locked">已复核 · 锁定</span>
                  ) : (
                    <span className="badge neutral">待复核</span>
                  )}
                  <span className="ver">记录 v{r.version} · 阈值 {r.thresholdLabel}</span>
                </div>
                <p>
                  粒子 {r.particleCount} 个/m³ · {r.temperature}℃ · {r.humidity}%RH · 压差 {r.pressure}Pa ·{" "}
                  {r.deviceStatus}
                </p>
                <p className="meta">
                  {r.shift} · {r.inspector} · {fmtTime(r.createdAt)}
                  {r.reviewedBy && ` · 复核：${r.reviewedBy} ${fmtTime(r.reviewedAt)}`}
                </p>
                {r.note && <p className="note">备注：{r.note}</p>}
                {expanded === r.id && (
                  <div className="table-scroll">
                    <table className="detail-table">
                      <thead>
                        <tr>
                          <th>项目</th>
                          <th>测量值</th>
                          <th>限值（阈值 {r.thresholdLabel}）</th>
                          <th>判定依据</th>
                          <th>结果</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.judgment.details.map((d) => (
                          <tr key={d.item}>
                            <td>{d.item}</td>
                            <td>{d.value}</td>
                            <td>{d.limit}</td>
                            <td>{d.reason}</td>
                            <td><Badge level={d.level} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="record-actions">
                <button onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                  {expanded === r.id ? "收起" : "详情"}
                </button>
                {canSubmit && r.status !== "reviewed" && (
                  <button onClick={() => handleEditRecord(r)}>编辑</button>
                )}
                {canReview && r.status === "submitted" && (
                  <button className="primary-action" disabled={busy} onClick={() => handleReview(r)}>
                    复核通过
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>审计轨迹</p>
            <h2>操作审计（{audits.length}）</h2>
          </div>
        </div>
        <div className="audit-list">
          {audits.slice(0, 50).map((a) => (
            <div key={a.id} className="audit-item">
              <span className="audit-time">{fmtTime(a.ts)}</span>
              <span className="audit-actor">{a.actor}</span>
              <span className="audit-action">{a.action}</span>
              <span className="audit-detail">
                {a.recordId ? `[${roomOf(a.recordId)}] ` : ""}
                {a.detail}
              </span>
            </div>
          ))}
        </div>
      </section>

      {conflict && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>{conflict.kind === "locked" ? "记录已锁定" : "版本冲突"}</h2>
            {conflict.kind === "conflict" ? (
              <>
                <p>
                  记录 <strong>{conflict.latest.roomNo}</strong> 刚被其他页面保存为{" "}
                  <strong>v{conflict.latest.version}</strong>（{fmtTime(conflict.latest.updatedAt)}）。
                  你的修改未提交，草稿已保留，不会覆盖对方结果。
                </p>
                <p className="hint">
                  对方版本：判定 {conflict.latest.judgment.overall} · 阈值 {conflict.latest.thresholdLabel} ·{" "}
                  {conflict.latest.status === "reviewed" ? "已复核" : "待复核"}
                </p>
                <div className="modal-actions">
                  <button className="primary-action" onClick={handleRebase}>
                    基于最新版本继续编辑（保留我的内容）
                  </button>
                  <button onClick={handleClearDraft}>放弃我的草稿</button>
                  <button onClick={() => setConflict(null)}>关闭（保留草稿）</button>
                </div>
              </>
            ) : (
              <>
                <p>
                  记录 <strong>{conflict.latest.roomNo}</strong> 已由 {conflict.latest.reviewedBy ?? "厂务工程师"}{" "}
                  复核通过并锁定，不能再修改。你的草稿已保留。
                </p>
                <div className="modal-actions">
                  <button onClick={handleClearDraft}>放弃我的草稿</button>
                  <button onClick={() => setConflict(null)}>关闭（保留草稿）</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
