// How the thread draws potfit's tools: result cards for the changes the agent applies (with
// Revert and a rating), thumbnails of its renders, review verdicts, design build reports. And
// user messages without the context potfit adds to them.

import { useState } from 'react';
import { UserMessage, type Item, type ToolBodyProps, type ToolCallItem, type ToolRenderer, type ToolRowProps } from '@dire-kiwi/agent-threads-react';
import type { Checkpoint, DesignReport, FitMetrics, Review } from '../../shared/types.ts';
import { api } from '../api.ts';
import { splitContext, usePotAgent } from './context.ts';

const mm = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v.toFixed(2)} mm`);
const structured = (call: ToolCallItem) => (call.result?.structured ?? null) as Record<string, any> | null;

function MetricsLine({ m }: { m: FitMetrics }) {
  const gap = m.interferes ? 'bad' : m.minRadialGap < m.requiredRadialGap - 0.05 ? 'warn' : 'ok';
  const wall = m.wallThickness ? (m.wallThickness.min < 0.8 ? 'bad' : m.wallThickness.min < 1.2 ? 'warn' : 'ok') : '';
  return (
    <div className="metric-chips">
      <span className={gap}>gap {mm(m.minRadialGap)}</span>
      <span>rim {mm(m.topOffset)}</span>
      <span>floor {mm(m.floorGap)}</span>
      {m.wallThickness && <span className={wall}>wall {mm(m.wallThickness.min)}</span>}
      <span>⌀{m.size.x.toFixed(0)}×{m.size.y.toFixed(0)}</span>
      {m.interferes && <span className="bad">interferes</span>}
    </div>
  );
}

const KIND_TITLE: Record<Checkpoint['kind'], string> = { fit: 'Fit applied', 'mesh-edit': 'Mesh edited', design: 'Design applied' };

/** apply_fit, apply_mesh_edit and apply_design: what changed, with Revert and a rating. */
function ResultRow({ call }: ToolRowProps) {
  const ctx = usePotAgent();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = structured(call);
  // (Results saved before the text moved into them were the checkpoint itself.)
  const first = (s?.checkpoint ?? (s?.kind ? s : undefined)) as Checkpoint | undefined;
  if (!first) {
    const failed = call.status === 'failed' || call.status === 'denied' || call.status === 'cancelled';
    return (
      <div className={`result-card pending ${failed ? 'failed' : ''}`}>
        <div className="result-head">{failed ? `${call.name.replace(/_/g, ' ')} didn't apply` : 'Applying…'}</div>
        {failed && call.result?.content && <p className="result-text">{call.result.content}</p>}
      </div>
    );
  }
  const cp = ctx.checkpoints[first.id] ?? first;
  const report = cp.designReport as DesignReport | null;
  return (
    <div className={`result-card potfit-ui ${cp.revertedAt ? 'reverted' : ''}`}>
      <div className="result-head">
        <strong>{cp.title || KIND_TITLE[cp.kind]}</strong>
        <span className={`pill ${cp.confidence === 'high' ? 'ok' : cp.confidence === 'low' ? 'warn' : ''}`}>{cp.confidence} confidence</span>
        {cp.revertedAt && <span className="pill">reverted</span>}
      </div>
      {cp.summary && <p className="result-text">{cp.summary}</p>}
      {cp.metrics && <MetricsLine m={cp.metrics} />}
      {cp.meshEdit && <p className="muted small">{cp.meshEdit.trianglesBefore.toLocaleString()} → {cp.meshEdit.trianglesAfter.toLocaleString()} triangles</p>}
      {report && <p className="muted small">{report.triangles.toLocaleString()} triangles · {report.components} piece{report.components === 1 ? '' : 's'} · overhangs {report.overhangArea.toFixed(0)} mm²</p>}
      {cp.warnings.length > 0 && <ul className="warnings">{cp.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <div className="result-actions">
        <button className="small" disabled={busy || !!cp.revertedAt || !!ctx.lockedBy} title="Put the model back as it was before this change"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await ctx.onRevert(cp);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}>
          ↶ Revert
        </button>
        <button className={`small ${cp.rating === 'accepted' ? 'on' : ''}`} title="Good" onClick={() => ctx.onRate(cp, cp.rating === 'accepted' ? null : 'accepted')}>👍</button>
        <button className={`small ${cp.rating === 'rejected' ? 'on' : ''}`} title="Not right" onClick={() => ctx.onRate(cp, cp.rating === 'rejected' ? null : 'rejected')}>👎</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** render_views: the pictures the agent looked at. */
function RendersBody({ call }: ToolBodyProps) {
  const ctx = usePotAgent();
  const files = (structured(call)?.files ?? []) as string[];
  if (!files.length) return <p className="muted small">{call.result?.content ?? 'Rendering…'}</p>;
  return (
    <div className="render-thumbs">
      {files.map((f) => (
        <a key={f} href={api.fileUrl(ctx.model.id, f)} target="_blank" rel="noreferrer">
          <img src={api.fileUrl(ctx.model.id, f)} alt={f.split('/').pop()} loading="lazy" />
        </a>
      ))}
    </div>
  );
}

const VERDICT: Record<string, string> = { pass: 'Pass', concerns: 'Concerns', fail: 'Fail' };

/** submit_review: the verdict, its findings, and its suggestion for the fitter. */
function ReviewRow({ call }: ToolRowProps) {
  const ctx = usePotAgent();
  const review = structured(call)?.review as Review | undefined;
  const r = review?.result;
  if (!r) return <div className="result-card pending"><div className="result-head">{call.status === 'failed' ? 'Review not accepted' : 'Submitting the review…'}</div></div>;
  return (
    <div className={`result-card potfit-ui verdict-${r.verdict}`}>
      <div className="result-head">
        <strong>Review: {VERDICT[r.verdict]}</strong>
        {review?.focus && <span className="pill">{review.focus}</span>}
      </div>
      <p className="result-text">{r.summary}</p>
      {review?.metrics && <MetricsLine m={review.metrics} />}
      {r.findings.length > 0 && (
        <ul className="findings">
          {r.findings.map((f, i) => (
            <li key={i} className={f.severity}>
              <strong>{f.title}</strong> {f.detail}
            </li>
          ))}
        </ul>
      )}
      {r.feedbackForFitter && (
        <div className="suggestion">
          <span className="muted small">Suggested feedback</span>
          <p>{r.feedbackForFitter}</p>
          <button className="small" onClick={() => ctx.onUseFeedback(r.feedbackForFitter)}>Use as feedback</button>
        </div>
      )}
    </div>
  );
}

/** build_design: the report, in short. */
function BuildBody({ call }: ToolBodyProps) {
  const report = structured(call)?.report as DesignReport | undefined;
  if (!report) return <pre className="tool-text">{call.result?.content ?? ''}</pre>;
  return (
    <div className="build-report">
      <div className="metric-chips">
        <span>{report.size.x.toFixed(1)} × {report.size.y.toFixed(1)} × {report.size.z.toFixed(1)} mm</span>
        <span>{report.triangles.toLocaleString()} triangles</span>
        <span className={report.components === 1 ? 'ok' : 'bad'}>{report.components} piece{report.components === 1 ? '' : 's'}</span>
        <span className={report.overhangArea > 25 ? 'warn' : 'ok'}>overhangs {report.overhangArea.toFixed(0)} mm²</span>
      </div>
      {report.metrics && <MetricsLine m={report.metrics} />}
      {report.warnings.length > 0 && <ul className="warnings">{report.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
    </div>
  );
}

const label = (l: string, summary?: (call: ToolCallItem) => string) => ({
  meta: (call: ToolCallItem) => ({ label: l, ...(summary ? { summary: summary(call) } : {}) }),
});
const input = (call: ToolCallItem) => (call.input ?? {}) as Record<string, any>;

export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  get_state: label('Read the model'),
  list_reference_pots: label('Nursery pots'),
  analyze_mesh: label('Analysed the mesh'),
  solve_fit: label('Solved the fit', (c) => [input(c).clearance !== undefined && `clearance ${input(c).clearance}`, input(c).topOffset !== undefined && `rim ${input(c).topOffset}`, input(c).floorGap !== undefined && `floor ${input(c).floorGap}`].filter(Boolean).join(', ')),
  check_fit: label('Checked the fit'),
  render_views: { ...label('Rendered', (c) => [...(input(c).sections ?? [0, 90]).map((a: number) => `section ${a}°`), input(c).shaded !== false && 'shaded views'].filter(Boolean).join(', ')), Body: RendersBody },
  export_placed_mesh: label('Exported for Blender', (c) => input(c).out ?? 'placed.stl'),
  run_blender: label('Ran Blender', (c) => input(c).script ?? ''),
  build_design: { ...label('Built the design'), Body: BuildBody },
  apply_fit: { Row: ResultRow, alone: true },
  apply_mesh_edit: { Row: ResultRow, alone: true },
  apply_design: { Row: ResultRow, alone: true },
  submit_review: { Row: ReviewRow, alone: true },
};

/** A user message without potfit's context block, which shows as a small chip instead. */
function PotUserMessage({ item }: { item: Extract<Item, { type: 'user_message' }> }) {
  const { text, context } = splitContext(item.text);
  return (
    <div className="pot-user">
      <UserMessage item={{ ...item, text }} />
      {context && (
        <details className="context-chip">
          <summary>{item.attachments?.some((a) => a.name?.startsWith('view-')) ? 'with the views and the model as it is' : 'with the model as it is'}</summary>
          <pre>{context}</pre>
        </details>
      )}
    </div>
  );
}

export function renderItem(item: Item) {
  if (item.type === 'user_message' && item.text.includes('<potfit-context>')) return <PotUserMessage item={item} />;
  return undefined;
}
