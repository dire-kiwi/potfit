import type { FitMetrics, FitSettings } from '../../shared/types.ts';
import { thicknessClass } from '../components/FitPanel.tsx';

const n = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits));

/** The fit's key numbers over the viewer, always in sight. */
export function Hud({ metrics, fit }: { metrics: FitMetrics | null; fit: FitSettings }) {
  if (!metrics) return <div className="hud muted">Measuring…</div>;
  const gap = metrics.interferes ? 'bad' : metrics.minRadialGap < metrics.requiredRadialGap - 0.05 ? 'warn' : 'ok';
  const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 0.5;
  return (
    <div className="hud" aria-label="Measurements">
      <span className={gap} title={`Narrowest radial gap; ${n(metrics.requiredRadialGap, 2)} mm needed`}>
        <i>gap</i> <b>{n(metrics.minRadialGap, 2)}</b>
      </span>
      <span className={fit.topOffset === null ? '' : near(metrics.topOffset, fit.topOffset) ? 'ok' : 'warn'} title="How far the nursery pot's rim stands above the pot's rim">
        <i>rim</i> <b>{metrics.topOffset !== null && metrics.topOffset > 0 ? '+' : ''}{n(metrics.topOffset)}</b>
      </span>
      <span className={metrics.floorGap === null ? '' : metrics.floorGap < -0.1 ? 'bad' : near(metrics.floorGap, fit.floorGap) ? 'ok' : 'warn'} title="Gap under the nursery pot">
        <i>floor</i> <b>{n(metrics.floorGap)}</b>
      </span>
      <span className={thicknessClass(metrics)} title="Thinnest wall">
        <i>wall</i> <b>{n(metrics.wallThickness?.min)}</b>
      </span>
      <span title="Outer size, mm">
        <i>size</i> <b>{n(metrics.size.x, 0)}×{n(metrics.size.z, 0)}×{n(metrics.size.y, 0)}</b>
      </span>
      {metrics.interferes && <span className="bad"><b>interferes</b></span>}
    </div>
  );
}
