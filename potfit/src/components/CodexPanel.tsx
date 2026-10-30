import { useState } from 'react';
import type { CodexRun, FitGoals, PotModel, ServerStatus } from '../../shared/types.ts';
import { Elapsed, LogView, type LogEntry } from './RunLog.tsx';

interface Props {
  status: ServerStatus | null;
  model: PotModel;
  hasReference: boolean;
  /** The fit or feedback run in progress, if any. */
  activeRun: CodexRun | null;
  /** A review is running; fitting has to wait for it. */
  reviewRunning: boolean;
  /** Fit and feedback runs, oldest first. */
  runs: CodexRun[];
  logs: Record<string, LogEntry[]>;
  /** Drafts live in the app so a review can hand its suggestion over. */
  instructions: string;
  feedback: string;
  onInstructions(text: string): void;
  onFeedback(text: string): void;
  onStart(mode: 'fit' | 'feedback', message: string): Promise<void>;
  onCancel(): void;
  onRate(run: CodexRun, rating: CodexRun['rating']): void;
  onRevert(run: CodexRun): void;
  onLoadLog(run: CodexRun): void;
  onNewSession(): void;
}

const QUICK_FEEDBACK = [
  'Too loose: tighten the fit.',
  'Too tight: give it more clearance.',
  'Sit the nursery pot lower.',
  'Sit the nursery pot higher.',
  'Keep the original proportions.',
  'The pot is upside down or on its side.',
];

const GOAL_LABELS: Record<keyof FitGoals, string> = { clearance: 'clearance', scaleMode: 'scaling', topOffset: 'rim proud by', floorGap: 'floor gap' };
const goal = (k: keyof FitGoals, v: FitGoals[keyof FitGoals]) =>
  k === 'scaleMode' ? (v === 'uniform' ? 'keep proportions' : 'width and height separately') : v === null ? 'none' : `${v} mm`;

/** "clearance 5 mm → 4 mm" for each goal Codex changed. */
function goalChanges(run: CodexRun): string[] {
  const after = run.result?.fit;
  if (!after || !run.fitBefore) return [];
  return (Object.keys(GOAL_LABELS) as (keyof FitGoals)[])
    .filter((k) => after[k] !== run.fitBefore[k])
    .map((k) => `${GOAL_LABELS[k]} ${goal(k, run.fitBefore[k])} → ${goal(k, after[k])}`);
}

function ResultCard({ run, onRate, onRevert }: { run: CodexRun; onRate: Props['onRate']; onRevert: Props['onRevert'] }) {
  if (run.status === 'error') return <p className="error">Codex failed: {run.error}</p>;
  if (run.status === 'cancelled') return <p className="hint">Cancelled.</p>;
  if (!run.result) return null;
  const m = run.metrics;
  const s = run.result.transform.scale;
  const changes = goalChanges(run);
  return (
    <div className="result">
      <p>{run.result.summary}</p>
      <p className="muted">
        Confidence {run.result.confidence} · scale {s.x === s.y && s.y === s.z ? s.x.toFixed(4) : `${s.x.toFixed(4)} / ${s.y.toFixed(4)} / ${s.z.toFixed(4)}`}
        {m && typeof m.minRadialGap === 'number' && ` · narrowest gap ${m.minRadialGap.toFixed(2)} mm`}
        {m && typeof m.topOffset === 'number' && ` · rim proud ${m.topOffset.toFixed(2)} mm`}
      </p>
      {changes.length > 0 && <p className="muted">Updated fit settings: {changes.join(', ')}.</p>}
      {run.result.warnings.length > 0 && (
        <ul className="warnings">
          {run.result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className={`small ${run.rating === 'accepted' ? 'primary' : ''}`} onClick={() => onRate(run, run.rating === 'accepted' ? null : 'accepted')}>
          👍 Good fit
        </button>
        <button className={`small ${run.rating === 'rejected' ? 'danger' : ''}`} onClick={() => onRate(run, run.rating === 'rejected' ? null : 'rejected')}>
          👎 Not right
        </button>
        <button className="small" onClick={() => onRevert(run)} title="Put the pot and fit settings back to how they were before this run">
          Revert
        </button>
      </div>
    </div>
  );
}

export function CodexPanel(props: Props) {
  const { status, model, activeRun, runs, logs, instructions, feedback } = props;
  const setInstructions = props.onInstructions;
  const setFeedback = props.onFeedback;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const available = status?.codex.available ?? false;
  const latest = runs.at(-1) ?? null;
  const canFeedback = !!model.codexThreadId && !activeRun;
  const blocked = sending || !available || props.reviewRunning;
  const history = runs.slice(0, -1).reverse();

  const start = async (mode: 'fit' | 'feedback', message: string) => {
    setSending(true);
    setError(null);
    try {
      await props.onStart(mode, message);
      if (mode === 'feedback') setFeedback('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="panel codex">
      <header>
        <h2>Codex</h2>
        <span className={`chip ${available ? 'ok' : 'bad'}`} title={status?.codex.error ?? status?.codex.version ?? ''}>
          {status === null ? '…' : available ? status.codex.version : 'not available'}
        </span>
      </header>
      {!available && status && <p className="error">The server could not run the codex CLI: {status.codex.error}</p>}

      {activeRun ? (
        <div className="active-run">
          <div className="row spread">
            <span>
              <span className="spinner" /> {activeRun.kind === 'fit' ? 'Fitting' : 'Revising'} <Elapsed since={activeRun.startedAt} />
            </span>
            <button className="small danger" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
          <LogView entries={logs[activeRun.id] ?? []} live />
        </div>
      ) : (
        <>
          {latest && (
            <div className="latest">
              <h3>
                Last {latest.kind === 'fit' ? 'fit' : 'revision'} <span className="muted">{new Date(latest.startedAt).toLocaleString()}</span>
              </h3>
              {latest.message && <blockquote>{latest.message}</blockquote>}
              <ResultCard run={latest} onRate={props.onRate} onRevert={props.onRevert} />
              <details
                onToggle={(e) => {
                  if ((e.target as HTMLDetailsElement).open && !logs[latest.id]) props.onLoadLog(latest);
                }}
              >
                <summary>What Codex did</summary>
                <LogView entries={logs[latest.id] ?? []} live={false} />
              </details>
            </div>
          )}

          {canFeedback && (
            <div className="feedback">
              <h3>Feedback</h3>
              <div className="chips">
                {QUICK_FEEDBACK.map((q) => (
                  <button key={q} className="chip-button" onClick={() => setFeedback(feedback ? `${feedback} ${q}` : q)}>
                    {q}
                  </button>
                ))}
              </div>
              <textarea
                rows={3}
                value={feedback}
                placeholder="Tell Codex what to change. Your manual moves are sent along with this."
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && feedback.trim() && !blocked) start('feedback', feedback);
                }}
              />
              <div className="row">
                <button className="primary" disabled={!feedback.trim() || blocked} onClick={() => start('feedback', feedback)}>
                  Send feedback
                </button>
              </div>
            </div>
          )}

          <div className="new-fit">
            <h3>{model.codexThreadId ? 'Start over' : 'Fit with Codex'}</h3>
            <textarea
              rows={2}
              value={instructions}
              placeholder="Optional instructions, e.g. keep the proportions, leave 2 mm under the pot."
              onChange={(e) => setInstructions(e.target.value)}
            />
            <div className="row">
              <button
                className={model.codexThreadId ? '' : 'primary'}
                disabled={blocked || !props.hasReference}
                onClick={() => start('fit', instructions)}
                title={props.hasReference ? 'Start a new Codex session for this model' : 'Choose a reference pot first'}
              >
                {model.codexThreadId ? 'New Codex session' : 'Fit with Codex'}
              </button>
              {model.codexThreadId && (
                <button className="small link" onClick={props.onNewSession} title="Forget the current conversation">
                  Clear conversation
                </button>
              )}
            </div>
          </div>
        </>
      )}
      {props.reviewRunning && !activeRun && <p className="hint">A review is running; fitting can start when it finishes.</p>}
      {error && <p className="error">{error}</p>}

      {history.length > 0 && (
        <div className="history">
          <h3>History</h3>
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
                  <span className={`dot ${r.status}`} /> {r.kind === 'fit' ? 'Fit' : 'Feedback'} · {new Date(r.startedAt).toLocaleTimeString()}
                  {r.rating === 'accepted' ? ' 👍' : r.rating === 'rejected' ? ' 👎' : ''}
                  {r.message && <span className="muted"> · {r.message.slice(0, 60)}</span>}
                </button>
                {openRun === r.id && (
                  <div className="history-detail">
                    <ResultCard run={r} onRate={props.onRate} onRevert={props.onRevert} />
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
