import { useState } from "react";
import type { Role, ThresholdVersion } from "../types";
import { CLEAN_LEVELS } from "../types";
import { fmtTime, getActiveThreshold } from "../domain";
import { publishThreshold } from "../store";

interface Props {
  thresholds: ThresholdVersion[];
  role: Role;
  actor: string;
  onToast: (msg: string) => void;
}

export default function ThresholdPanel({ thresholds, role, actor, onToast }: Props) {
  const canPublish = role === "厂务工程师";
  const active = getActiveThreshold(thresholds);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [limits, setLimits] = useState(
    CLEAN_LEVELS.map((c) => {
      const prev = active.limits.find((l) => l.class === c);
      return (
        prev ?? {
          class: c,
          particleLimit: c === "ISO 5" ? 3520 : c === "ISO 6" ? 35200 : 352000,
          pressureMin: 10,
          tempMin: 18,
          tempMax: 26,
          humidityMin: 40,
          humidityMax: 60,
        }
      );
    }),
  );

  const setLimit = (cls: string, field: string, value: string) => {
    setLimits((ls) =>
      ls.map((l) => (l.class === cls ? { ...l, [field]: value === "" ? 0 : Number(value) } : l)),
    );
  };

  const handlePublish = () => {
    if (!note.trim()) {
      onToast("请填写本次阈值调整说明");
      return;
    }
    const res = publishThreshold({
      note: note.trim(),
      limits: limits.map((l) => ({ ...l })),
      actor,
    });
    if (res.ok) {
      onToast(`已发布阈值 v${res.version}，仅对之后新建的巡检记录生效`);
      setOpen(false);
      setNote("");
    }
  };

  return (
    <section className="panel threshold-panel">
      <div className="section-heading">
        <div>
          <p>当班阈值</p>
          <h2>
            阈值版本管理
            <span className="active-tag">当前 {active.label} 生效中</span>
          </h2>
        </div>
        {canPublish && (
          <button className="primary-action" onClick={() => setOpen((v) => !v)}>
            {open ? "收起发布表单" : "发布新阈值版本"}
          </button>
        )}
      </div>

      {!canPublish && (
        <p className="role-hint">仅厂务工程师可发布新阈值版本；新版本只影响之后新建的记录。</p>
      )}

      <div className="threshold-list">
        {thresholds
          .slice()
          .reverse()
          .map((t) => (
            <article key={t.version} className={`threshold-card ${t.active ? "active" : ""}`}>
              <header>
                <strong>
                  {t.label}
                  {t.active && <em className="current-badge">当班</em>}
                </strong>
                <span className="muted">
                  {fmtTime(t.effectiveAt)} · {t.publishedBy} 发布
                </span>
              </header>
              <p className="threshold-note">{t.note}</p>
              <div className="threshold-limits">
                {t.limits.map((l) => (
                  <div key={l.class} className="limit-chip">
                    <strong>{l.class}</strong>
                    <span>粒子 ≤ {l.particleLimit.toLocaleString()}/m³</span>
                    <span>压差 ≥ {l.pressureMin}Pa</span>
                    <span>
                      温度 {l.tempMin}–{l.tempMax}℃
                    </span>
                    <span>
                      湿度 {l.humidityMin}–{l.humidityMax}%RH
                    </span>
                  </div>
                ))}
              </div>
            </article>
          ))}
      </div>

      {open && canPublish && (
        <div className="publish-form">
          <h3>发布新版本 v{active.version + 1}.0</h3>
          <p className="muted">
            发布后：新建巡检记录按新版本判定；历史记录保留原阈值版本与判定结果，不受影响。判定规则：达到上限（≥）即判异常。
          </p>
          <label>
            <span>调整说明（必填）</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：ISO 5 粒子上限收紧至 3000/m³"
            />
          </label>
          <div className="limit-edit-grid">
            {limits.map((l) => (
              <fieldset key={l.class}>
                <legend>{l.class}</legend>
                <label>
                  <span>粒子上限 (/m³)</span>
                  <input
                    type="number"
                    value={l.particleLimit}
                    onChange={(e) => setLimit(l.class, "particleLimit", e.target.value)}
                  />
                </label>
                <label>
                  <span>压差下限 (Pa)</span>
                  <input
                    type="number"
                    value={l.pressureMin}
                    onChange={(e) => setLimit(l.class, "pressureMin", e.target.value)}
                  />
                </label>
                <label>
                  <span>温度下限 (℃)</span>
                  <input
                    type="number"
                    value={l.tempMin}
                    onChange={(e) => setLimit(l.class, "tempMin", e.target.value)}
                  />
                </label>
                <label>
                  <span>温度上限 (℃)</span>
                  <input
                    type="number"
                    value={l.tempMax}
                    onChange={(e) => setLimit(l.class, "tempMax", e.target.value)}
                  />
                </label>
                <label>
                  <span>湿度下限 (%RH)</span>
                  <input
                    type="number"
                    value={l.humidityMin}
                    onChange={(e) => setLimit(l.class, "humidityMin", e.target.value)}
                  />
                </label>
                <label>
                  <span>湿度上限 (%RH)</span>
                  <input
                    type="number"
                    value={l.humidityMax}
                    onChange={(e) => setLimit(l.class, "humidityMax", e.target.value)}
                  />
                </label>
              </fieldset>
            ))}
          </div>
          <div className="form-actions">
            <button className="primary-action" onClick={handlePublish}>
              确认发布 v{active.version + 1}.0
            </button>
            <button onClick={() => setOpen(false)}>取消</button>
          </div>
        </div>
      )}
    </section>
  );
}
