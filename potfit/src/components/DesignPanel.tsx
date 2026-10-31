import { useEffect, useRef, useState } from 'react';
import type { CodexRun, DesignParam, DesignReport, ParamValues, PotModel, ReferencePot } from '../../shared/types.ts';
import { api } from '../api.ts';
import { NumberField } from './NumberField.tsx';

interface Props {
  model: PotModel;
  references: ReferencePot[];
  /** What Codex is doing to the model, if anything; nothing can be rebuilt meanwhile. */
  lockedBy: CodexRun['kind'] | null;
  building: boolean;
  /** Rebuild with new values or a new script; resolves once the new mesh is shown. */
  onBuild(body: { params?: ParamValues; script?: string }): Promise<void>;
}

const mm = (v: number, d = 1) => `${v.toFixed(d)} mm`;

/** Whether the model's reference pot or goals differ from what the cavity was built for. */
function staleTarget(model: PotModel, references: ReferencePot[]): string | null {
  const b = model.design?.builtFor;
  if (!b) return null;
  const f = model.fit;
  const ref = references.find((r) => r.id === f.referenceId);
  if (!ref) return null;
  const changes: string[] = [];
  if (b.referenceId !== f.referenceId || b.reference.topOD !== ref.topOD || b.reference.bottomOD !== ref.bottomOD || b.reference.height !== ref.height) {
    changes.push(`the nursery pot (built for ${b.reference.name})`);
  }
  if (b.clearance !== f.clearance) changes.push(`clearance (built for ${b.clearance} mm)`);
  if (b.topOffset !== f.topOffset) changes.push(`rim offset (built for ${b.topOffset === null ? 'level' : `${b.topOffset} mm`})`);
  if (b.floorGap !== f.floorGap) changes.push(`floor gap (built for ${b.floorGap} mm)`);
  return changes.length ? changes.join(', ') : null;
}

function ParamControl({ name, spec, value, disabled, onChange }: { name: string; spec: DesignParam; value: ParamValues[string]; disabled: boolean; onChange(v: ParamValues[string]): void }) {
  if (spec.type === 'boolean') {
    return (
      <label className="param check" title={spec.help}>
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {spec.label}
      </label>
    );
  }
  if (spec.type === 'choice') {
    return (
      <label className="param" title={spec.help}>
        <span>{spec.label}</span>
        <select value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }
  const n = typeof value === 'number' ? value : spec.value;
  const clampTo = (v: number) => Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
  const step = spec.step ?? (spec.max !== null && spec.min !== null ? (spec.max - spec.min) / 100 : 1);
  return (
    <label className="param" title={spec.help}>
      <span>
        {spec.label}
        {spec.unit && <em> {spec.unit}</em>}
      </span>
      {spec.min !== null && spec.max !== null && (
        <input type="range" min={spec.min} max={spec.max} step={step} value={n} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      )}
      <NumberField value={n} step={step} digits={4} disabled={disabled} onChange={(v) => Number.isFinite(v) && onChange(clampTo(v))} title={name} />
    </label>
  );
}

function ReportSummary({ report, avoidOverhangs }: { report: DesignReport; avoidOverhangs: boolean }) {
  const s = report.size;
  return (
    <>
      <dl className="metrics">
        <dt>Size</dt>
        <dd>
          {s.x.toFixed(1)} × {s.y.toFixed(1)} × {s.z.toFixed(1)} mm
        </dd>
        <dt>Material</dt>
        <dd>
          {report.volume.toFixed(1)} cm³ <small>about {Math.round(report.volume * 1.24)} g PLA solid</small>
        </dd>
        <dt>Overhangs</dt>
        <dd className={report.overhangArea > 25 && avoidOverhangs ? 'warn' : 'ok'}>
          {report.overhangArea > 25 ? `${Math.round(report.overhangArea)} mm² over 45°` : 'None to support'}
          {report.overhangs.length > 0 && report.overhangArea > 25 && (
            <small>
              {' '}
              worst {mm(report.overhangs[0].zMin, 0)}–{mm(report.overhangs[0].zMax, 0)}, {report.overhangs[0].side}
            </small>
          )}
        </dd>
        <dt>Pieces</dt>
        <dd className={report.components === 1 ? 'ok' : 'bad'}>{report.components === 1 ? 'One solid piece' : `${report.components} separate pieces`}</dd>
      </dl>
      {report.notes.length > 0 && (
        <ul className="notes">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {report.warnings.length > 0 && (
        <ul className="warnings">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function DesignPanel({ model, references, lockedBy, building, onBuild }: Props) {
  const design = model.design!;
  const [values, setValues] = useState<ParamValues>(design.params);
  const [error, setError] = useState<string | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [scriptDraft, setScriptDraft] = useState('');
  const [scriptOpen, setScriptOpen] = useState(false);
  const draftDirty = useRef(false);
  const timer = useRef<number | null>(null);
  const pending = useRef<ParamValues>({});

  // Follow the model when it is rebuilt elsewhere (Codex, revert, a script edit).
  useEffect(() => setValues(design.params), [design.params]);
  useEffect(() => setScript(null), [design.builtAt]);
  useEffect(() => {
    if (!scriptOpen || script !== null) return;
    let stale = false;
    api
      .designScript(model.id)
      .then((text) => {
        if (stale) return;
        setScript(text);
        // Keep an edit in progress.
        if (!draftDirty.current) setScriptDraft(text);
      })
      .catch((err) => !stale && setError((err as Error).message));
    return () => {
      stale = true;
    };
  }, [scriptOpen, script, model.id]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const editScript = (text: string) => {
    draftDirty.current = true;
    setScriptDraft(text);
  };
  const resetDraft = (text: string) => {
    draftDirty.current = false;
    setScriptDraft(text);
  };

  const build = async (body: { params?: ParamValues; script?: string }) => {
    setError(null);
    try {
      await onBuild(body);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  // Rebuild shortly after the last change, so dragging a slider builds once.
  const change = (key: string, v: ParamValues[string]) => {
    setValues((cur) => ({ ...cur, [key]: v }));
    pending.current = { ...pending.current, [key]: v };
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const params = pending.current;
      pending.current = {};
      void build({ params });
    }, 350);
  };

  const stale = staleTarget(model, references);
  const disabled = !!lockedBy || building;
  const specs = Object.entries(design.paramSpec);

  return (
    <section className="panel design">
      <header>
        <h2>Design</h2>
        {building && (
          <span className="muted">
            <span className="spinner" /> Building…
          </span>
        )}
      </header>
      {design.description && <blockquote className="description">{design.description}</blockquote>}
      {design.images.length > 0 && (
        <div className="ref-images">
          {design.images.map((n) => (
            <a key={n} href={api.designImageUrl(model.id, n)} target="_blank" rel="noreferrer" title={n}>
              <img src={api.designImageUrl(model.id, n)} alt={n} />
            </a>
          ))}
        </div>
      )}
      {stale && (
        <div className="notice">
          <p>The cavity was built for different fit settings: {stale}.</p>
          <button className="small primary" disabled={disabled} onClick={() => void build({})}>
            Rebuild for the current settings
          </button>
        </div>
      )}
      {design.buildError && design.buildError !== error && <p className="error">The last build failed: {design.buildError}</p>}
      {lockedBy && <p className="hint">{lockedBy === 'review' ? 'A review is running; settings can change when it finishes.' : 'Codex is working on this design.'}</p>}

      {specs.length > 0 ? (
        <div className="params">
          {specs.map(([key, spec]) => (
            <ParamControl key={key} name={key} spec={spec} value={values[key]} disabled={disabled} onChange={(v) => change(key, v)} />
          ))}
        </div>
      ) : (
        <p className="hint">This design has no settings to adjust.</p>
      )}
      {error && <p className="error">{error}</p>}
      {design.report && <ReportSummary report={design.report} avoidOverhangs={model.avoidOverhangs !== false} />}

      <details className="script" open={scriptOpen} onToggle={(e) => setScriptOpen(e.currentTarget.open)}>
        <summary>Design script</summary>
        {script === null ? (
          <p className="hint">Loading…</p>
        ) : (
          <>
            <textarea className="code" rows={16} spellCheck={false} value={scriptDraft} disabled={disabled} onChange={(e) => editScript(e.target.value)} />
            <div className="row">
              <button
                className="small primary"
                disabled={disabled || scriptDraft === script}
                onClick={async () => {
                  if (await build({ script: scriptDraft })) resetDraft(scriptDraft);
                }}
              >
                Save and rebuild
              </button>
              <button className="small" disabled={scriptDraft === script} onClick={() => resetDraft(script)}>
                Discard changes
              </button>
              <a className="button small" href={api.designScriptUrl(model.id)} download={`${model.name.replace(/[^\w-]+/g, '-')}.mjs`}>
                Download
              </a>
            </div>
            <p className="hint">The script only replaces the current one if it builds.</p>
          </>
        )}
      </details>
    </section>
  );
}
