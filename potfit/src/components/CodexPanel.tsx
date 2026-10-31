import { useState } from 'react';
import { useThreadState } from './thread-state.ts';
import { CodexControls, type CodexControlsProps } from './CodexControls.tsx';
import type { CodexRun, FitGoals, PotModel, ServerStatus } from '../../shared/types.ts';
import { ImagePicker, type PickedImage } from './ImagePicker.tsx';
import { Elapsed, LogView, type LogEntry } from './RunLog.tsx';

interface Props extends CodexControlsProps {
  status: ServerStatus | null;
  model: PotModel;
  hasReference: boolean;
  /** The fit, design or feedback run in progress, if any. */
  activeRun: CodexRun | null;
  /** A review is running; fitting has to wait for it. */
  reviewRunning: boolean;
  /** Fit, design and feedback runs, oldest first. */
  runs: CodexRun[];
  logs: Record<string, LogEntry[]>;
  /** Drafts live in the app so a review can hand its suggestion over. */
  instructions: string;
  feedback: string;
  onInstructions(text: string): void;
  onFeedback(text: string): void;
  onStart(mode: CodexRun['kind'], message: string, attachments: PickedImage[]): Promise<void>;
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

const QUICK_DESIGN_FEEDBACK = [
  'Make it look more like the reference images.',
  'Simpler, with fewer details.',
  'Bolder, chunkier details.',
  'Make it print without supports.',
  'Thicker walls.',
  'Make it shorter and wider.',
];

const KIND_LABEL: Record<CodexRun['kind'], string> = {
  fit: 'Fit',
  feedback: 'Feedback',
  review: 'Review',
  design: 'Design',
  'design-feedback': 'Feedback',
};

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

function RateRow({ run, onRate, onRevert, good, revertTitle }: { run: CodexRun; onRate: Props['onRate']; onRevert: Props['onRevert']; good: string; revertTitle: string }) {
  return (
    <div className="row">
      <button className={`small ${run.rating === 'accepted' ? 'primary' : ''}`} onClick={() => onRate(run, run.rating === 'accepted' ? null : 'accepted')}>
        👍 {good}
      </button>
      <button className={`small ${run.rating === 'rejected' ? 'danger' : ''}`} onClick={() => onRate(run, run.rating === 'rejected' ? null : 'rejected')}>
        👎 Not right
      </button>
      <button className="small" onClick={() => onRevert(run)} title={revertTitle}>
        Revert
      </button>
    </div>
  );
}

function DesignResultCard({ run, onRate, onRevert }: { run: CodexRun; onRate: Props['onRate']; onRevert: Props['onRevert'] }) {
  const d = run.design;
  if (run.status === 'cancelled') return <p className="hint">Cancelled.</p>;
  if (run.status === 'error' && !d) return <p className="error">Codex failed: {run.error}</p>;
  if (!d) return null;
  const r = run.designReport;
  return (
    <div className="result">
      {run.status === 'error' && <p className="error">{run.error} The previous design is still in place.</p>}
      {d.title && <p><strong>{d.title}</strong></p>}
      <p>{d.summary}</p>
      <p className="muted">
        Confidence {d.confidence}
        {r && ` · ${r.size.x.toFixed(0)} × ${r.size.y.toFixed(0)} × ${r.size.z.toFixed(0)} mm · ${r.volume.toFixed(0)} cm³`}
        {run.metrics && typeof run.metrics.minRadialGap === 'number' && ` · narrowest gap ${run.metrics.minRadialGap.toFixed(2)} mm`}
      </p>
      {d.warnings.length > 0 && (
        <ul className="warnings">
          {d.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {run.status === 'done' && <RateRow run={run} onRate={onRate} onRevert={onRevert} good="Good design" revertTitle="Go back to the design from before this run" />}
    </div>
  );
}

function ResultCard({ run, onRate, onRevert }: { run: CodexRun; onRate: Props['onRate']; onRevert: Props['onRevert'] }) {
  if (run.kind === 'design' || run.kind === 'design-feedback') return <DesignResultCard run={run} onRate={onRate} onRevert={onRevert} />;
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
      {run.meshEdit && (
        <p className="muted">
          Edited the mesh: {run.meshEdit.trianglesBefore.toLocaleString()} → {run.meshEdit.trianglesAfter.toLocaleString()} triangles.
        </p>
      )}
      {run.result.warnings.length > 0 && (
        <ul className="warnings">
          {run.result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <RateRow
        run={run}
        onRate={onRate}
        onRevert={onRevert}
        good="Good fit"
        revertTitle={run.meshEdit ? 'Put the mesh, the pot and the fit settings back to how they were before this run' : 'Put the pot and fit settings back to how they were before this run'}
      />
    </div>
  );
}

export function CodexPanel(props: Props) {
  const { status, model, activeRun, runs, logs, instructions, feedback } = props;
  const setInstructions = props.onInstructions;
  const setFeedback = props.onFeedback;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestLogOpen, setLatestLogOpen] = useThreadState(model.id, 'latestLogOpen', false);
  const [openRun, setOpenRun] = useThreadState<string | null>(model.id, 'openRun', null);
  const [feedbackImages, setFeedbackImages] = useThreadState<PickedImage[]>(model.id, 'feedbackImages', []);
  const [newImages, setNewImages] = useThreadState<PickedImage[]>(model.id, 'newImages', []);

  // Designed pots talk to the design agent; imported ones to the fitting agent.
  const designing = !!model.design;
  const thread = designing ? (model.design?.threadId ?? null) : model.codexThreadId;
  const newMode: CodexRun['kind'] = designing ? 'design' : 'fit';
  const feedbackMode: CodexRun['kind'] = designing ? 'design-feedback' : 'feedback';
  const available = status?.codex.available ?? false;
  const latest = runs.at(-1) ?? null;
  const canFeedback = !!thread && !activeRun;
  const blocked = sending || !available || props.reviewRunning;
  const history = runs.slice(0, -1).reverse();
  const quick = designing ? QUICK_DESIGN_FEEDBACK : QUICK_FEEDBACK;

  const start = async (mode: CodexRun['kind'], message: string, images: PickedImage[]) => {
    setSending(true);
    setError(null);
    try {
      await props.onStart(mode, message, images);
      if (mode === feedbackMode) {
        setFeedback('');
        setFeedbackImages([]);
      } else {
        setNewImages([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="panel codex">
      <header>
        <h2>{designing ? 'Codex designer' : 'Codex'}</h2>
        <span className="row">
          {status?.blender?.available && (
            <span className="chip ok" title={designing ? 'Codex can make parts for the design in Blender' : 'Codex can edit the mesh in Blender'}>
              {status.blender.version}
            </span>
          )}
          <span className={`chip ${available ? 'ok' : 'bad'}`} title={status?.codex.error ?? status?.codex.version ?? ''}>
            {status === null ? '…' : available ? status.codex.version : 'not available'}
          </span>
        </span>
      </header>
      <CodexControls settings={props.settings} onSettings={props.onSettings} status={status} disabled={blocked || !!activeRun} />
      {!available && status && <p className="error">The server could not run the codex CLI: {status.codex.error}</p>}

      {activeRun ? (
        <div className="active-run">
          <div className="row spread">
            <span>
              <span className="spinner" /> {activeRun.kind === 'fit' ? 'Fitting' : activeRun.kind === 'design' ? 'Designing' : 'Revising'}{' '}
              <Elapsed since={activeRun.startedAt} />
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
                Last {latest.kind === 'fit' ? 'fit' : latest.kind === 'design' ? 'design' : 'revision'}{' '}
                <span className="muted">{new Date(latest.startedAt).toLocaleString()}</span>
              </h3>
              {latest.message && <blockquote>{latest.message}</blockquote>}
              <ResultCard run={latest} onRate={props.onRate} onRevert={props.onRevert} />
              <details
                open={latestLogOpen}
                onToggle={(e) => {
                  const open = (e.target as HTMLDetailsElement).open;
                  setLatestLogOpen(open);
                  if (open && !logs[latest.id]) props.onLoadLog(latest);
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
                {quick.map((q) => (
                  <button key={q} className="chip-button" onClick={() => setFeedback(feedback ? `${feedback} ${q}` : q)}>
                    {q}
                  </button>
                ))}
              </div>
              <textarea
                rows={3}
                value={feedback}
                placeholder={
                  designing
                    ? 'Tell Codex what to change. Screenshots of both views and any images you add go with it.'
                    : 'Tell Codex what to change. Your manual moves are sent along with this.'
                }
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && feedback.trim() && !blocked) start(feedbackMode, feedback, feedbackImages);
                }}
              />
              <ImagePicker images={feedbackImages} onChange={setFeedbackImages} compact disabled={blocked} />
              <div className="row">
                <button className="primary" disabled={!feedback.trim() || blocked} onClick={() => start(feedbackMode, feedback, feedbackImages)}>
                  Send feedback
                </button>
              </div>
            </div>
          )}

          <div className="new-fit">
            <h3>{thread ? 'Start over' : designing ? 'Design with Codex' : 'Fit with Codex'}</h3>
            <textarea
              rows={2}
              value={instructions}
              placeholder={
                designing
                  ? 'What to design. Leave empty to work from the original description and images.'
                  : 'Optional instructions, e.g. keep the proportions, leave 2 mm under the pot.'
              }
              onChange={(e) => setInstructions(e.target.value)}
            />
            {designing && <ImagePicker images={newImages} onChange={setNewImages} compact disabled={blocked} />}
            <div className="row">
              <button
                className={thread ? '' : 'primary'}
                disabled={blocked || !props.hasReference}
                onClick={() => start(newMode, instructions, newImages)}
                title={props.hasReference ? 'Start a new Codex session for this model' : 'Choose a reference pot first'}
              >
                {thread ? 'New Codex session' : designing ? 'Design with Codex' : 'Fit with Codex'}
              </button>
              {thread && (
                <button className="small link" disabled={blocked} onClick={props.onNewSession} title="Forget the current conversation">
                  Clear conversation
                </button>
              )}
            </div>
          </div>
        </>
      )}
      {props.reviewRunning && !activeRun && <p className="hint">A review is running; Codex can start again when it finishes.</p>}
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
                  <span className={`dot ${r.status}`} /> {KIND_LABEL[r.kind]} · {new Date(r.startedAt).toLocaleTimeString()}
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
