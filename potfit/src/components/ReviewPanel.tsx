import { useState } from 'react';
import { CodexControls, type CodexControlsProps } from './CodexControls.tsx';
import { transformsEqual } from '../../shared/transform.ts';
import type { CodexRun, PotModel, ReviewResult, ServerStatus } from '../../shared/types.ts';
import { Elapsed, LogView, type LogEntry } from './RunLog.tsx';

interface Props extends CodexControlsProps {
  status: ServerStatus | null;
  model: PotModel;
  hasReference: boolean;
  /** The review in progress, if any. */
  activeRun: CodexRun | null;
  /** A fit is running; reviewing has to wait for it. */
  fitRunning: boolean;
  /** Review runs, oldest first. */
  reviews: CodexRun[];
  logs: Record<string, LogEntry[]>;
  onStart(): Promise<void>;
  onCancel(): void;
  onLoadLog(run: CodexRun): void;
  /** Put the reviewer's suggestion into the fitting agent's feedback box. */
  onUseFeedback(text: string): void;
}

const VERDICT: Record<ReviewResult['verdict'], { label: string; cls: string }> = {
  pass: { label: 'Pass', cls: 'ok' },
  concerns: { label: 'Concerns', cls: 'warn' },
  fail: { label: 'Fail', cls: 'bad' },
};

/** Whether the model's fit has changed since `run` reviewed it. */
function isStale(run: CodexRun, model: PotModel): boolean {
  const { fitBefore: f } = run;
  return (
    !transformsEqual(run.transformBefore, model.transform) ||
    f.referenceId !== model.fit.referenceId ||
    f.clearance !== model.fit.clearance ||
    f.scaleMode !== model.fit.scaleMode ||
    f.topOffset !== model.fit.topOffset ||
    f.floorGap !== model.fit.floorGap
  );
}

function ReviewCard({ run, model, onUseFeedback }: { run: CodexRun; model: PotModel; onUseFeedback: Props['onUseFeedback'] }) {
  if (run.status === 'error') return <p className="error">The review failed: {run.error}</p>;
  if (run.status === 'cancelled') return <p className="hint">Cancelled.</p>;
  const review = run.review;
  if (!review) return null;
  const v = VERDICT[review.verdict];
  const m = run.metrics;
  return (
    <div className="result review-card">
      <div className="row spread tight">
        <span className={`verdict ${v.cls}`}>{v.label}</span>
        <span className="muted">{new Date(run.startedAt).toLocaleString()}</span>
      </div>
      {isStale(run, model) && <p className="hint">The fit has changed since this review.</p>}
      <p>{review.summary}</p>
      {review.findings.length > 0 && (
        <ul className="findings">
          {review.findings.map((f, i) => (
            <li key={i}>
              <span className={`severity ${f.severity}`}>{f.severity}</span> <strong>{f.title}</strong>
              {f.detail && <div className="muted">{f.detail}</div>}
            </li>
          ))}
        </ul>
      )}
      {m && (
        <p className="muted">
          Measured: narrowest gap {typeof m.minRadialGap === 'number' ? `${m.minRadialGap.toFixed(2)} mm` : '–'}
          {m.wallThickness && ` · thinnest wall ${m.wallThickness.min.toFixed(2)} mm`}
          {typeof m.floorThickness === 'number' && ` · floor ${m.floorThickness.toFixed(2)} mm`}
        </p>
      )}
      {review.feedbackForFitter && (
        <div className="suggestion">
          <div className="muted">Suggested feedback for the fitter</div>
          <blockquote>{review.feedbackForFitter}</blockquote>
          <button className="small" onClick={() => onUseFeedback(review.feedbackForFitter)}>
            Use as feedback
          </button>
        </div>
      )}
    </div>
  );
}

export function ReviewPanel(props: Props) {
  const { status, model, activeRun, reviews, logs } = props;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const available = status?.codex.available ?? false;
  const latest = reviews.at(-1) ?? null;
  const history = reviews.slice(0, -1).reverse();

  const start = async () => {
    setSending(true);
    setError(null);
    try {
      await props.onStart();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="panel review">
      <header>
        <h2>Review</h2>
      </header>
      <p className="hint">
        A separate Codex session checks the fit as it stands now. It sees only the placed pot, the reference pot and the goals, not how the fit was made.
      </p>

      <CodexControls settings={props.settings} onSettings={props.onSettings} status={status} disabled={sending || !available || !!activeRun || props.fitRunning} />
      {activeRun ? (
        <div className="active-run">
          <div className="row spread">
            <span>
              <span className="spinner" /> Reviewing <Elapsed since={activeRun.startedAt} />
            </span>
            <button className="small danger" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
          <LogView entries={logs[activeRun.id] ?? []} live />
        </div>
      ) : (
        <>
          <div className="row">
            <button
              className={latest ? '' : 'primary'}
              disabled={sending || !available || !props.hasReference || props.fitRunning}
              onClick={start}
              title={props.hasReference ? 'Start an independent review of the current fit' : 'Choose a reference pot first'}
            >
              {latest ? 'Review again' : 'Review this fit'}
            </button>
          </div>
          {props.fitRunning && <p className="hint">Codex is fitting; review once it is done.</p>}
          {latest && (
            <div className="latest">
              <ReviewCard run={latest} model={model} onUseFeedback={props.onUseFeedback} />
              <details
                onToggle={(e) => {
                  if ((e.target as HTMLDetailsElement).open && !logs[latest.id]) props.onLoadLog(latest);
                }}
              >
                <summary>What the reviewer did</summary>
                <LogView entries={logs[latest.id] ?? []} live={false} />
              </details>
            </div>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}

      {history.length > 0 && (
        <div className="history">
          <h3>Earlier reviews</h3>
          <ul>
            {history.map((r) => (
              <li key={r.id}>
                <button
                  className="item"
                  onClick={() => {
                    const next = openRun === r.id ? null : r.id;
                    setOpenRun(next);
                    if (next && !logs[r.id]) props.onLoadLog(r);
                  }}
                >
                  <span className={`dot ${r.status}`} /> {r.review ? VERDICT[r.review.verdict].label : r.status} · {new Date(r.startedAt).toLocaleTimeString()}
                  {r.review?.summary && <span className="muted"> · {r.review.summary.slice(0, 60)}</span>}
                </button>
                {openRun === r.id && (
                  <div className="history-detail">
                    <ReviewCard run={r} model={model} onUseFeedback={props.onUseFeedback} />
                    <LogView entries={logs[r.id] ?? []} live={false} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
