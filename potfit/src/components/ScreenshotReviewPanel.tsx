import { useEffect, useState } from 'react';
import type { CodexSettings, ScreenshotReview } from '../../shared/types.ts';
import { api } from '../api.ts';
import { ImagePicker, type PickedImage } from './ImagePicker.tsx';

export function ScreenshotReviewPanel({ modelId, settings, disabled, onUpdate }: {
  modelId: string; settings: CodexSettings; disabled: boolean;
  onUpdate(state: ScreenshotReview | null): void;
}) {
  const [images, setImages] = useState<PickedImage[]>([]);
  const [state, setState] = useState<ScreenshotReview | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.screenshotReview(modelId);
        if (!stopped) { setState(next); onUpdate(next); setError(''); }
      } catch (e) { if (!stopped) setError((e as Error).message); }
      if (!stopped) timer = setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [modelId, onUpdate]);
  const running = state?.status === 'running';
  return <section className="panel">
    <h2>Iterative screenshot review</h2>
    <p className="hint">Add one target screenshot. Three independent agents compare it with fresh renders, then the worker adjusts the model. Stops when all approve or after 20 review rounds. Continues when you switch models or close this page.</p>
    {!running && <>
      <ImagePicker images={images} onChange={next => setImages(next.slice(-1))} disabled={disabled || sending} />
      <button disabled={disabled || sending || images.length !== 1} onClick={async () => {
        setSending(true); setError('');
        try { const next = await api.startScreenshotReview(modelId, images, settings); setState(next); onUpdate(next); }
        catch (e) { setError((e as Error).message); }
        finally { setSending(false); }
      }}>Start screenshot review</button>
    </>}
    {state && <>
      <p><strong>Round {state.round}/20 · {state.phase}</strong></p>
      {running && <button className="danger" onClick={() => api.cancelRun(modelId).catch(e => setError(e.message))}>Cancel review loop</button>}
      {state.error && <p className="error">{state.error}</p>}
      {state.rounds.slice().reverse().map(round => <details key={round.round} open={round.round === state.round}>
        <summary>Round {round.round}</summary>
        {round.reviews.map(review => <div key={review.runId} className="result">
          <strong>{review.focus} · {review.result.verdict}</strong>
          <p>{review.result.summary}</p>
          {review.result.findings.map((finding, i) => <p key={i}>{finding.title}: {finding.detail}</p>)}
          <p className="muted">{review.result.feedbackForFitter}</p>
        </div>)}
        {round.workerRunId && <p className="hint">Worker adjustment recorded in conversation history.</p>}
      </details>)}
    </>}
    {error && <p className="error">{error}</p>}
  </section>;
}
