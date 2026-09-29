import { useState } from "react";
import type { AuditEntry, InspectionRecord, Role } from "../types";
import { STATUS_LABEL } from "../types";
import { fmtTime } from "../domain";

interface Props {
  record: InspectionRecord;
  role: Role;
  activeThresholdVersion: number;
  audit: AuditEntry[];
  onEdit: (record: InspectionRecord) => void;
  onReview: (record: InspectionRecord, approve: boolean, comment: string) => void;
}

const JUDGMENT_CLASS: Record<string, string> = {
  正常: "jd-ok",
  关注: "jd-watch",
  异常: "jd-danger",
};

const ACTION_LABEL: Record<AuditEntry["action"], string> = {
  "record.created": "新建",
  "record.updated": "保存修改",
  "record.submitted": "提交复核",
  "record.review_approved": "复核通过",
  "record.review_rejected": "退回修改",
  "record.conflict": "版本冲突",
  "threshold.published": "阈值发布",
};

export default function RecordCard({
  record,
  role,
  activeThresholdVersion,
  audit,
  onEdit,
  onReview,
}: Props) {
  const [showAudit, setShowAudit] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");

  const locked = record.status === "reviewed";
  const canReview = role === "厂务工程师" && record.status === "submitted";
  const staleThreshold = record.thresholdVersion < activeThresholdVersion;

  return (
    <article className={`record-card-v2 ${locked ? "locked" : ""}`}>
      <div className="record-main">
        <div className="record-head">
          <h3>{record.recordNo}</h3>
          <span className={`judgment-badge ${JUDGMENT_CLASS[record.judgment.level]}`}>
            {record.judgment.level}
          </span>
          <span className={`status-badge st-${record.status}`}>{STATUS_LABEL[record.status]}</span>
        </div>

        <div className="record-tags">
          <span className="tag">{record.cleanLevel}</span>
          <span className="tag">房间 {record.roomNo}</span>
          <span className="tag tag-version" title="记录版本：每次保存 +1，用于并发冲突检测">
            记录 v{record.version}
          </span>
          <span
            className="tag tag-threshold"
            title="阈值版本：新建/编辑时按当班阈值快照，历史记录永不重判"
          >
            阈值 v{record.thresholdVersion}
          </span>
          {staleThreshold && (
            <span className="tag tag-stale" title="该记录按发布时的阈值版本判定，保持历史结果不变">
              历史阈值（当前 v{activeThresholdVersion}）
            </span>
          )}
        </div>

        <dl className="record-specs">
          <div>
            <dt>粒子计数</dt>
            <dd>
              {record.particleCount === "" ? "—" : `${record.particleCount.toLocaleString()} /m³`}
            </dd>
          </div>
          <div>
            <dt>温度</dt>
            <dd>{record.temperature === "" ? "—" : `${record.temperature} ℃`}</dd>
          </div>
          <div>
            <dt>湿度</dt>
            <dd>{record.humidity === "" ? "—" : `${record.humidity} %RH`}</dd>
          </div>
          <div>
            <dt>静压差</dt>
            <dd>{record.pressureDiff === "" ? "—" : `${record.pressureDiff} Pa`}</dd>
          </div>
          <div>
            <dt>设备状态</dt>
            <dd>{record.equipmentStatus || "—"}</dd>
          </div>
          <div>
            <dt>创建人</dt>
            <dd>
              {record.createdBy} · {fmtTime(record.createdAt)}
            </dd>
          </div>
        </dl>

        {record.handlingNote && <p className="record-note">备注：{record.handlingNote}</p>}

        {record.judgment.reasons.length > 0 && (
          <ul className="judgment-reasons">
            {record.judgment.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}

        {locked && (
          <p className="lock-hint">
            🔒 已于 {fmtTime(record.reviewedAt)} 由 {record.reviewedBy} 复核通过并锁定，不可修改。
          </p>
        )}
      </div>

      <div className="record-actions">
        {!locked && (
          <button onClick={() => onEdit(record)}>
            {record.status === "draft" ? "继续编辑" : "编辑记录"}
          </button>
        )}
        {canReview && !rejecting && (
          <button className="primary-action" onClick={() => onReview(record, true, "")}>
            复核通过
          </button>
        )}
        {canReview && (
          <button onClick={() => setRejecting((v) => !v)}>退回修改</button>
        )}
        <button onClick={() => setShowAudit((v) => !v)}>
          审计轨迹 {showAudit ? "▲" : "▼"}
        </button>
      </div>

      {rejecting && (
        <div className="reject-box">
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="退回原因（必填）"
          />
          <button
            className="primary-action"
            onClick={() => {
              if (!comment.trim()) return;
              onReview(record, false, comment.trim());
              setRejecting(false);
              setComment("");
            }}
          >
            确认退回
          </button>
        </div>
      )}

      {showAudit && (
        <div className="audit-trail">
          <h4>审计轨迹（{audit.length}）</h4>
          {audit.length === 0 && <p className="muted">暂无审计记录</p>}
          <ol>
            {audit
              .slice()
              .reverse()
              .map((a) => (
                <li key={a.id}>
                  <span className="audit-time">{fmtTime(a.ts)}</span>
                  <span className="audit-actor">{a.actor}</span>
                  <span className="audit-action">{ACTION_LABEL[a.action] ?? a.action}</span>
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
    </article>
  );
}
