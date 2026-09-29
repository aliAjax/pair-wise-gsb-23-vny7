import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import type { Draft, InspectionRecord, Role } from "./types";
import { CLEAN_LEVELS, EMPTY_FORM, EQUIPMENT_STATUS, STATUS_LABEL } from "./types";
import {
  exportRecordsCsv,
  fmtTime,
  formIsDirty,
  getActiveThreshold,
  judge,
  limitsFor,
} from "./domain";
import {
  discardDraft,
  getDraft,
  reviewRecord,
  saveDraft,
  saveRecord,
  useDB,
} from "./store";
import ThresholdPanel from "./components/ThresholdPanel";
import RecordCard from "./components/RecordCard";

const ROLES: Role[] = ["巡检员", "厂务工程师", "班组长"];

interface ConflictState {
  current: InspectionRecord;
}

export default function App() {
  const db = useDB();
  const { thresholds, records, audit, drafts } = db;

  const [role, setRole] = useState<Role>("巡检员");
  const actor = role;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>(EMPTY_FORM);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<Draft | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [levelFilter, setLevelFilter] = useState<string>("全部");
  const [statusFilter, setStatusFilter] = useState<string>("全部");
  const [showThresholds, setShowThresholds] = useState(false);
  const [showAuditLog, setShowAuditLog] = useState(false);

  const activeThreshold = getActiveThreshold(thresholds);
  const previewThreshold = editingRecord
    ? thresholds.find((t) => t.version === editingRecord.thresholdVersion) ?? activeThreshold
    : activeThreshold;

  /* 自动保存草稿（防抖）：中途关闭页面也能恢复 */
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    if (!formIsDirty(form)) return;
    const key = editingId ? `record:${editingId}` : "new";
    const t = window.setTimeout(() => {
      saveDraft(key, form, baseVersion);
    }, 600);
    return () => window.clearTimeout(t);
  }, [form, editingId, baseVersion]);

  /* 启动时提示恢复未提交草稿 */
  useEffect(() => {
    const newDraft = getDraft("new");
    if (newDraft && formIsDirty(newDraft.form)) {
      setDraftPrompt(newDraft);
    }
  }, []);

  /* 编辑中的记录被其他标签页改动 */
  const editingRecord = editingId ? records.find((r) => r.id === editingId) : undefined;
  const remoteChanged =
    editingRecord !== undefined &&
    baseVersion !== null &&
    editingRecord.version !== baseVersion &&
    conflict === null;

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3600);
  };

  /* ---------- 编辑器操作 ---------- */

  const startNew = () => {
    setEditingId(null);
    setBaseVersion(null);
    setConflict(null);
    const d = getDraft("new");
    if (d && formIsDirty(d.form)) {
      setDraftPrompt(d);
      return;
    }
    setForm(EMPTY_FORM);
  };

  const startEdit = (record: InspectionRecord) => {
    if (record.status === "reviewed") {
      showToast("该记录已复核通过并锁定，不能修改");
      return;
    }
    setEditingId(record.id);
    setBaseVersion(record.version);
    setConflict(null);
    const draftKey = `record:${record.id}`;
    const d = getDraft(draftKey);
    if (d && formIsDirty(d.form)) {
      setDraftPrompt(d);
      return;
    }
    setForm({
      roomNo: record.roomNo,
      cleanLevel: record.cleanLevel,
      particleCount: record.particleCount === "" ? "" : String(record.particleCount),
      temperature: record.temperature === "" ? "" : String(record.temperature),
      humidity: record.humidity === "" ? "" : String(record.humidity),
      pressureDiff: record.pressureDiff === "" ? "" : String(record.pressureDiff),
      equipmentStatus: record.equipmentStatus,
      handlingNote: record.handlingNote,
    });
  };

  const restoreDraft = (d: Draft) => {
    setForm({ ...EMPTY_FORM, ...d.form });
    setBaseVersion(d.baseVersion);
    if (d.key === "new") {
      setEditingId(null);
    } else {
      setEditingId(d.key.replace(/^record:/, ""));
    }
    setDraftPrompt(null);
    showToast("已恢复未提交草稿");
  };

  const discardCurrentDraft = (d: Draft) => {
    discardDraft(d.key);
    setDraftPrompt(null);
    if (d.key === "new") setForm(EMPTY_FORM);
    showToast("已丢弃草稿");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setBaseVersion(null);
    setForm(EMPTY_FORM);
    setConflict(null);
  };

  /* ---------- 保存（乐观锁） ---------- */

  const handleSave = (submit: boolean) => {
    if (!form.roomNo.trim()) {
      showToast("请填写房间编号");
      return;
    }
    const draftKey = editingId ? `record:${editingId}` : "new";
    // 提交前先把当前表单落盘，冲突时草稿也不丢
    saveDraft(draftKey, form, baseVersion);

    const res = saveRecord({
      id: editingId ?? undefined,
      form,
      baseVersion,
      actor,
      submit,
    });

    if (res.ok) {
      showToast(
        submit
          ? `已提交复核（记录 v${res.record.version}，阈值 v${res.record.thresholdVersion}）`
          : `草稿已保存（记录 v${res.record.version}）`,
      );
      setEditingId(null);
      setBaseVersion(null);
      setForm(EMPTY_FORM);
      setConflict(null);
      return;
    }

    if (res.reason === "not_found") {
      showToast("记录不存在，可能已被删除");
      return;
    }

    // 版本冲突：保住草稿，绝不覆盖对方结果
    setConflict({ current: res.current });
    setEditingId(res.current.id);
    setBaseVersion(res.current.version);
  };

  const loadRemoteVersion = (record?: InspectionRecord) => {
    const c = record ?? conflict?.current;
    if (!c) return;
    setForm({
      roomNo: c.roomNo,
      cleanLevel: c.cleanLevel,
      particleCount: c.particleCount === "" ? "" : String(c.particleCount),
      temperature: c.temperature === "" ? "" : String(c.temperature),
      humidity: c.humidity === "" ? "" : String(c.humidity),
      pressureDiff: c.pressureDiff === "" ? "" : String(c.pressureDiff),
      equipmentStatus: c.equipmentStatus,
      handlingNote: c.handlingNote,
    });
    setBaseVersion(c.version);
    setConflict(null);
    showToast("已载入对方保存的最新版本，您的草稿仍保留在本地可恢复");
  };

  /* ---------- 复核 ---------- */

  const handleReview = (record: InspectionRecord, approve: boolean, comment: string) => {
    const res = reviewRecord({
      id: record.id,
      approve,
      actor,
      baseVersion: record.version,
      comment,
    });
    if (res.ok) {
      showToast(approve ? "复核通过，记录已锁定" : "已退回修改");
    } else {
      showToast(res.reason);
    }
  };

  /* ---------- 实时预判定（按当班阈值版本） ---------- */

  const preview = useMemo(() => {
    if (!formIsDirty(form)) return null;
    const values = {
      particleCount: form.particleCount === "" ? ("" as const) : Number(form.particleCount),
      temperature: form.temperature === "" ? ("" as const) : Number(form.temperature),
      humidity: form.humidity === "" ? ("" as const) : Number(form.humidity),
      pressureDiff: form.pressureDiff === "" ? ("" as const) : Number(form.pressureDiff),
    };
    const limits = limitsFor(previewThreshold, form.cleanLevel || CLEAN_LEVELS[1]);
    return judge(limits, values, previewThreshold.version);
  }, [form, previewThreshold]);

  /* ---------- 筛选与指标 ---------- */

  const filtered = records.filter((r) => {
    if (levelFilter !== "全部" && r.cleanLevel !== levelFilter) return false;
    if (statusFilter !== "全部" && r.status !== statusFilter) return false;
    return true;
  });

  const metrics = useMemo(() => {
    let particle = 0;
    let pressure = 0;
    let env = 0;
    let pending = 0;
    for (const r of records) {
      if (r.judgment.level === "异常" && r.judgment.reasons.some((x) => x.includes("粒子")))
        particle += 1;
      if (r.judgment.level === "异常" && r.judgment.reasons.some((x) => x.includes("压差")))
        pressure += 1;
      if (
        r.judgment.level === "异常" &&
        r.judgment.reasons.some((x) => x.includes("温度") || x.includes("湿度"))
      )
        env += 1;
      if (r.status !== "reviewed") pending += 1;
    }
    return { particle, pressure, env, pending };
  }, [records]);

  const auditFor = (id: string) => audit.filter((a) => a.recordId === id);

  const editingLocked = editingRecord?.status === "reviewed";

  return (
    <main className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · port 5109</p>
          <h1>半导体洁净室巡检</h1>
          <p className="subtitle">
            按当班阈值版本判定，阈值版本随记录快照；发布新阈值只影响之后的新记录，历史记录保留原判定。
            并发编辑乐观锁防覆盖，草稿与审计轨迹本地持久化，关闭页面后可恢复。
          </p>
        </div>
        <div className="stack-card">
          <span>当班阈值版本</span>
          <strong>{activeThreshold.label}</strong>
          <span className="muted">
            {fmtTime(activeThreshold.effectiveAt)} · {activeThreshold.publishedBy} 发布
          </span>
          <button className="link-btn" onClick={() => setShowThresholds((v) => !v)}>
            {showThresholds ? "收起阈值版本" : "查看 / 发布阈值版本"}
          </button>
        </div>
      </section>

      <section className="metrics-grid">
        <article className="metric-card">
          <span>粒子异常</span>
          <strong>{metrics.particle}</strong>
          <i className="status-danger" />
        </article>
        <article className="metric-card">
          <span>压差异常</span>
          <strong>{metrics.pressure}</strong>
          <i className="status-watch" />
        </article>
        <article className="metric-card">
          <span>温湿度偏移</span>
          <strong>{metrics.env}</strong>
          <i className="status-watch" />
        </article>
        <article className="metric-card">
          <span>待处理（未复核）</span>
          <strong>{metrics.pending}</strong>
          <i className="status-ok" />
        </article>
      </section>

      {showThresholds && (
        <ThresholdPanel
          thresholds={thresholds}
          role={role}
          actor={actor}
          onToast={showToast}
        />
      )}

      <section className="workspace">
        <aside className="panel narrow">
          <h2>角色</h2>
          <div className="chips">
            {ROLES.map((r) => (
              <button
                key={r}
                className={r === role ? "chip-active" : ""}
                onClick={() => setRole(r)}
              >
                {r}
              </button>
            ))}
          </div>

          <h2>洁净等级筛选</h2>
          <div className="chips muted">
            {["全部", ...CLEAN_LEVELS].map((c) => (
              <button
                key={c}
                className={c === levelFilter ? "chip-active" : ""}
                onClick={() => setLevelFilter(c)}
              >
                {c}
              </button>
            ))}
          </div>

          <h2>状态筛选</h2>
          <div className="chips muted">
            {["全部", "draft", "submitted", "reviewed"].map((s) => (
              <button
                key={s}
                className={s === statusFilter ? "chip-active" : ""}
                onClick={() => setStatusFilter(s)}
              >
                {s === "全部" ? "全部" : STATUS_LABEL[s as keyof typeof STATUS_LABEL]}
              </button>
            ))}
          </div>

          <h2>数据恢复</h2>
          <p className="muted small">
            草稿、记录与审计轨迹保存在本浏览器（localStorage），中途关闭页面后可在此恢复。
          </p>
          <button
            onClick={() => {
              const keys = Object.keys(drafts);
              if (keys.length === 0) {
                showToast("暂无未提交草稿");
                return;
              }
              const d = drafts[keys[0]];
              setDraftPrompt(d);
            }}
          >
            恢复未提交草稿（{Object.keys(drafts).length}）
          </button>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>{editingId ? `编辑记录 ${editingRecord?.recordNo ?? ""}` : "新建巡检"}</p>
              <h2>巡检录入</h2>
            </div>
            <button className="primary-action" onClick={startNew}>
              新增记录
            </button>
          </div>

          {draftPrompt && (
            <div className="banner banner-draft">
              <strong>检测到未提交草稿</strong>
              <span>
                保存于 {fmtTime(draftPrompt.savedAt)}（
                {draftPrompt.key === "new" ? "新建记录" : `记录 ${draftPrompt.key.replace(/^record:/, "")}`}
                ，基线 v{draftPrompt.baseVersion ?? "?"}）
              </span>
              <div className="banner-actions">
                <button className="primary-action" onClick={() => restoreDraft(draftPrompt)}>
                  恢复草稿
                </button>
                <button onClick={() => discardCurrentDraft(draftPrompt)}>丢弃</button>
              </div>
            </div>
          )}

          {conflict && (
            <div className="banner banner-conflict">
              <strong>⚠ 版本冲突：对方已保存更新版本</strong>
              <span>
                该记录当前为 v{conflict.current.version}（{fmtTime(conflict.current.updatedAt)} 由{" "}
                {conflict.current.createdBy} 保存），您的编辑基线为 v{baseVersion ?? "?"}。
                为避免覆盖对方刚保存的结果，本次提交已被阻止，您的草稿已保留。
              </span>
              <div className="banner-actions">
                <button className="primary-action" onClick={() => loadRemoteVersion()}>
                  载入对方最新版本
                </button>
                <button
                  onClick={() => {
                    setConflict(null);
                    setEditingId(conflict.current.id);
                  }}
                >
                  保留草稿继续编辑
                </button>
              </div>
            </div>
          )}

          {remoteChanged && !conflict && (
            <div className="banner banner-remote">
              <strong>↻ 该记录已在其他页面被修改</strong>
              <span>
                当前最新为 v{editingRecord?.version}，您正在编辑 v{baseVersion ?? "?"}
                。提交时将进行版本校验，不会覆盖对方结果；您的草稿已自动保存。
              </span>
              <div className="banner-actions">
                <button onClick={() => loadRemoteVersion(editingRecord)}>刷新为最新版本</button>
              </div>
            </div>
          )}

          {editingLocked && (
            <div className="banner banner-locked">
              <strong>🔒 记录已复核通过并锁定</strong>
              <span>该记录不可修改。如需变更，请由厂务工程师退回修改后再编辑。</span>
            </div>
          )}

          <div className="field-grid">
            <label>
              <span>房间编号 *</span>
              <input
                value={form.roomNo}
                disabled={editingLocked}
                onChange={(e) => setForm((f) => ({ ...f, roomNo: e.target.value }))}
                placeholder="如 CR-1201"
              />
            </label>
            <label>
              <span>洁净等级</span>
              <select
                value={form.cleanLevel}
                disabled={editingLocked}
                onChange={(e) => setForm((f) => ({ ...f, cleanLevel: e.target.value }))}
              >
                {CLEAN_LEVELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>粒子计数（0.5μm，粒/m³）</span>
              <input
                type="number"
                value={form.particleCount}
                disabled={editingLocked}
                onChange={(e) => setForm((f) => ({ ...f, particleCount: e.target.value }))}
                placeholder={`上限 ${limitsFor(previewThreshold, form.cleanLevel).particleLimit.toLocaleString()}，等于上限即异常`}
              />
            </label>
            <label>
              <span>温度（℃）</span>
              <input
                type="number"
                value={form.temperature}
                disabled={editingLocked}
                onChange={(e) => setForm((f) => ({ ...f, temperature: e.target.value }))}
                placeholder="18–26"
              />
            </label>
            <label>
              <span>相对湿度（%RH）</span>
              <input
                type="number"
                value={form.humidity}
                disabled={editingLocked}
                onChange={(e) => setForm((f) => ({ ...f, humidity: e.target.value }))}
                placeholder="40–60"
              />
            </label>
            <label>
              <span>静压差（Pa）</span>
              <input
                type="number"
                value={form.pressureDiff}
                disabled={editingLocked}
                onChange={(e) => setForm((f) => ({ ...f, pressureDiff: e.target.value }))}
                placeholder="≥10"
              />
            </label>
            <label>
              <span>设备状态</span>
              <select
                value={form.equipmentStatus}
                disabled={editingLocked}
                onChange={(e) => setForm((f) => ({ ...f, equipmentStatus: e.target.value }))}
              >
                {EQUIPMENT_STATUS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>处理备注</span>
              <input
                value={form.handlingNote}
                disabled={editingLocked}
                onChange={(e) => setForm((f) => ({ ...f, handlingNote: e.target.value }))}
                placeholder="异常情况与处理措施"
              />
            </label>
          </div>

          {preview && (
            <div className={`preview-box preview-${preview.level}`}>
              预判定（按阈值 {previewThreshold.label}
              {editingRecord ? `，记录快照版本 v${editingRecord.thresholdVersion}` : "，当班阈值"}）：
              <strong>{preview.level}</strong>
              {preview.reasons.length > 0 && <span> — {preview.reasons.join("；")}</span>}
            </div>
          )}

          <div className="form-actions">
            <button
              className="primary-action"
              disabled={editingLocked}
              onClick={() => handleSave(true)}
            >
              提交复核
            </button>
            <button disabled={editingLocked} onClick={() => handleSave(false)}>
              保存草稿
            </button>
            {(editingId || formIsDirty(form)) && !editingLocked && (
              <button onClick={cancelEdit}>取消</button>
            )}
            {editingId && (
              <span className="muted small">
                正在编辑记录 v{baseVersion ?? "?"}，保存后版本 +1
              </span>
            )}
          </div>
        </section>
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p>巡检记录</p>
            <h2>
              近期记录（{filtered.length}）
              <span className="muted small">
                每条记录带记录版本与阈值版本；历史记录按发布时阈值判定
              </span>
            </h2>
          </div>
          <div className="form-actions">
            <button onClick={() => setShowAuditLog((v) => !v)}>
              {showAuditLog ? "收起全局审计" : "全局审计轨迹"}
            </button>
            <button onClick={() => exportRecordsCsv(filtered)}>导出摘要（CSV）</button>
          </div>
        </div>

        {showAuditLog && (
          <div className="audit-trail global-audit">
            <h4>全局审计轨迹（最近 30 条）</h4>
            <ol>
              {audit
                .slice()
                .reverse()
                .slice(0, 30)
                .map((a) => (
                  <li key={a.id}>
                    <span className="audit-time">{fmtTime(a.ts)}</span>
                    <span className="audit-actor">{a.actor}</span>
                    <span className="audit-action">
                      {a.action === "record.created"
                        ? "新建"
                        : a.action === "record.updated"
                          ? "保存修改"
                          : a.action === "record.submitted"
                            ? "提交复核"
                            : a.action === "record.review_approved"
                              ? "复核通过"
                              : a.action === "record.review_rejected"
                                ? "退回修改"
                                : a.action === "record.conflict"
                                  ? "版本冲突"
                                  : "阈值发布"}
                    </span>
                    {a.recordNo && <span className="audit-record">{a.recordNo}</span>}
                    {a.fromVersion !== undefined && a.toVersion !== undefined && (
                      <span className="audit-versions">
                        v{a.fromVersion} → v{a.toVersion}
                      </span>
                    )}
                    <span className="audit-detail">{a.detail}</span>
                  </li>
                ))}
            </ol>
          </div>
        )}

        <div className="record-list-v2">
          {filtered.length === 0 && <p className="muted">当前筛选条件下暂无记录</p>}
          {filtered.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              role={role}
              activeThresholdVersion={activeThreshold.version}
              audit={auditFor(record.id)}
              onEdit={startEdit}
              onReview={handleReview}
            />
          ))}
        </div>
      </section>

      <footer className="app-footer muted">
        数据存储于本浏览器 localStorage：草稿自动保存（停止输入 0.6s 后），记录与审计轨迹持久化，关闭页面后可从左侧「数据恢复」还原。
      </footer>
    </main>
  );
}
