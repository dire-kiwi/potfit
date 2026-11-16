import { UP_AXES, type FitMetrics, type FitSettings, type PotModel, type PotTransform, type ReferencePot, type UpAxis, type Vec3 } from '../../shared/types.ts';
import type { ScaleLock } from '../viewer/PotViewer.ts';
import { NumberField } from './NumberField.tsx';

export const mm = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : Number.isFinite(v) ? `${v.toFixed(digits)} mm` : '∞';
/** Thin walls or floors may not print; 1.2 mm is a common FDM minimum. */
export function thicknessClass(m: FitMetrics): string {
  const thinnest = Math.min(m.wallThickness?.min ?? Infinity, m.floorThickness ?? Infinity);
  return thinnest < 0.8 ? 'bad' : thinnest < 1.2 ? 'warn' : '';
}

function scaleWithLock(prev: Vec3, axis: keyof Vec3, value: number, lock: ScaleLock): Vec3 {
  if (lock === 'uniform') {
    const k = value / prev[axis];
    return { x: prev.x * k, y: prev.y * k, z: prev.z * k };
  }
  if (lock === 'round' && axis !== 'y') return { ...prev, x: value, z: value };
  return { ...prev, [axis]: value };
}


/** The fit goals: clearance, scaling, rim offset and floor gap. */
export function FitGoals({ model, onFit, locked }: { model: PotModel; onFit(patch: Partial<FitSettings>): void; locked: boolean }) {
  const fit = model.fit;
  const props = { onFit };
  return (
    <fieldset className="plain" disabled={locked}>
        <label className="field">
          <span title="Diametral: the radial gap is half of this">Clearance (⌀)</span>
          <NumberField value={fit.clearance} min={0} step={0.5} digits={2} onChange={(v) => props.onFit({ clearance: v })} />
          <em>mm</em>
        </label>
        <label className="field">
          <span>Scaling</span>
          <select value={fit.scaleMode} onChange={(e) => props.onFit({ scaleMode: e.target.value as FitSettings['scaleMode'] })}>
            <option value="uniform">Keep proportions</option>
            <option value="radial-height">Width and height separately</option>
          </select>
        </label>
        <label className="field">
          <span title="How far the reference pot's rim stands above the outer pot's rim">Rim proud by</span>
          <NumberField
            value={fit.topOffset}
            step={0.5}
            digits={2}
            allowEmpty
            placeholder="sit on floor"
            onChange={(v) => props.onFit({ topOffset: Number.isNaN(v) ? null : v })}
          />
          <em>mm</em>
        </label>
        <label className="field">
          <span>Floor gap</span>
          <NumberField value={fit.floorGap} min={0} step={0.5} digits={2} onChange={(v) => props.onFit({ floorGap: v })} />
          <em>mm</em>
        </label>
        <p className="hint">Leave "rim proud by" empty to sit the pot on the floor at the smallest scale that clears the walls.</p>
    </fieldset>
  );
}

/** The placement: up axis, spin, position and scale, by number. */
export function Placement(props: {
  model: PotModel;
  metrics: FitMetrics | null;
  locked: boolean;
  scaleLock: ScaleLock;
  canUndo: boolean;
  canRedo: boolean;
  onScaleLock(lock: ScaleLock): void;
  onTransform(t: PotTransform): void;
  onDetectOrientation(): void;
  onUndo(): void;
  onRedo(): void;
}) {
  const { model, metrics, locked, scaleLock } = props;
  const t = model.transform;
  const fit = model.fit;
  const setPos = (axis: keyof Vec3, v: number) => props.onTransform({ ...t, position: { ...t.position, [axis]: v } });
  const setScale = (axis: keyof Vec3, v: number) => v > 0 && props.onTransform({ ...t, scale: scaleWithLock(t.scale, axis, v, scaleLock) });
  return (
    <>
      <div className="row tight end">
        <button className="small" disabled={!props.canUndo || locked} onClick={props.onUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
        <button className="small" disabled={!props.canRedo || locked} onClick={props.onRedo} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
      </div>
        {locked && <p className="hint">The agent is working; manual edits are paused.</p>}
        <div className="grid3">
          <span className="label">Up axis</span>
          <select disabled={locked} value={t.up} onChange={(e) => props.onTransform({ ...t, up: e.target.value as UpAxis })}>
            {UP_AXES.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button className="small" disabled={locked} onClick={props.onDetectOrientation} title="Detect the up axis and re-centre at scale 1">
            Detect
          </button>
          <span className="label">Spin °</span>
          <NumberField disabled={locked} value={t.spin} step={5} digits={2} onChange={(v) => props.onTransform({ ...t, spin: v })} />
          <span />
        </div>
        <div className="xyz">
          <span className="label">Position</span>
          {(['x', 'y', 'z'] as const).map((a) => (
            <label key={a}>
              <em>{a}</em>
              <NumberField disabled={locked} value={t.position[a]} step={0.5} digits={3} onChange={(v) => setPos(a, v)} />
            </label>
          ))}
          <span className="label">Scale</span>
          {(['x', 'y', 'z'] as const).map((a) => (
            <label key={a}>
              <em>{a}</em>
              <NumberField disabled={locked} value={t.scale[a]} min={0.001} step={0.01} digits={5} onChange={(v) => setScale(a, v)} />
            </label>
          ))}
        </div>
        <label className="field">
          <span>Scale lock</span>
          <select value={scaleLock} onChange={(e) => props.onScaleLock(e.target.value as ScaleLock)}>
            <option value="uniform">Uniform (x = y = z)</option>
            <option value="round">Round (x = z)</option>
            <option value="free">Free</option>
          </select>
        </label>
        <div className="row">
          <button
            className="small"
            disabled={locked || !metrics?.cavityCenterOffset}
            onClick={() => {
              const o = metrics!.cavityCenterOffset!;
              props.onTransform({ ...t, position: { ...t.position, x: t.position.x - o.x, z: t.position.z - o.z } });
            }}
          >
            Centre on cavity
          </button>
          <button
            className="small"
            disabled={locked || metrics?.floorGap === null || metrics?.floorGap === undefined}
            onClick={() => props.onTransform({ ...t, position: { ...t.position, y: t.position.y + metrics!.floorGap! - fit.floorGap } })}
            title="Move the pot vertically so the reference pot rests on the cavity floor"
          >
            Seat on floor
          </button>
        </div>
    </>
  );
}

/** Measurements of the fit, in full. */
export function Measurements({ model, references, metrics, metricsError }: { model: PotModel; references: ReferencePot[]; metrics: FitMetrics | null; metricsError: string | null }) {
  const fit = model.fit;
  const ref = references.find((r) => r.id === fit.referenceId) ?? null;
  const gapClass = !metrics ? '' : metrics.interferes ? 'bad' : metrics.minRadialGap < metrics.requiredRadialGap - 0.05 ? 'warn' : 'ok';
  const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 0.5;
  const props = { metricsError };
  return (
    <>
        {!ref && <p className="hint">Choose a nursery pot to measure the fit.</p>}
        {props.metricsError && <p className="error">{props.metricsError}</p>}
        {ref && metrics && (
          <>
            <dl className="metrics">
              <dt>Narrowest gap</dt>
              <dd className={gapClass}>
                {mm(metrics.minRadialGap)} <small>at y {metrics.minRadialGapAt.toFixed(1)} · need {mm(metrics.requiredRadialGap)}</small>
              </dd>
              <dt>Gap at base / rim</dt>
              <dd>
                {mm(metrics.bottomRadialGap)} / {mm(metrics.rimRadialGap)}
              </dd>
              <dt>Rim proud by</dt>
              <dd className={fit.topOffset === null ? '' : near(metrics.topOffset, fit.topOffset) ? 'ok' : 'warn'}>
                {mm(metrics.topOffset)} {fit.topOffset !== null && <small>target {mm(fit.topOffset)}</small>}
              </dd>
              <dt>Floor gap</dt>
              <dd className={metrics.floorGap === null ? '' : metrics.floorGap < -0.1 ? 'bad' : near(metrics.floorGap, fit.floorGap) ? 'ok' : 'warn'}>
                {mm(metrics.floorGap)} <small>target {mm(fit.floorGap)}</small>
              </dd>
              <dt>Fits</dt>
              <dd className={metrics.clearanceOk ? 'ok' : metrics.interferes ? 'bad' : 'warn'}>
                {metrics.interferes ? 'No: reference passes through the wall' : metrics.clearanceOk ? 'Yes' : 'Tighter than the clearance'}
              </dd>
              <dt>Wall / floor</dt>
              <dd className={thicknessClass(metrics)}>
                {metrics.wallThickness ? `${mm(metrics.wallThickness.min)} thinnest` : '–'} · floor {mm(metrics.floorThickness)}
              </dd>
              <dt>Outer size</dt>
              <dd>
                ⌀{metrics.size.x.toFixed(1)} × {metrics.size.z.toFixed(1)} × {metrics.size.y.toFixed(1)} mm
              </dd>
            </dl>
            {metrics.warnings.length > 0 && (
              <ul className="warnings">
                {metrics.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </>
        )}
    </>
  );
}
