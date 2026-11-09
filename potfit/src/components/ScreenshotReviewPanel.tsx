import { useState } from 'react';
import type { ScreenshotReview } from '../../shared/types.ts';
import { ImagePicker, type PickedImage } from './ImagePicker.tsx';

/** The iterative screenshot review: a target picture, instructions, and the rounds so far. */
export function ScreenshotReviewPanel({ state, onStart, onCancel, onOpenReview, disabled }: {
  state: ScreenshotReview | null;
  disabled: boolean;
  onStart(images: PickedImage[], prompt: string): Promise<void>;
  onCancel(): Promise<void>;
  /** Open a reviewer's conversation in the dock. */
  onOpenReview(reviewId: string): void;
}) {
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const running = state?.status === 'running';
  return (
    <div className="screenshot-review">
      <p className="hint">
        Add one target picture. Each round, three independent reviewers compare it with fresh renders, then Claude adjusts the model with their findings.
        It stops when all three approve, or after 20 rounds, and carries on if you close the page.
      </p>
      {!running && (
        <>
          <label className="field stacked">
            <span>Instructions (optional)</span>
            <textarea rows={2} value={prompt} disabled={disabled || sending} placeholder="What should the reviewers and the worker focus on or keep?" onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <ImagePicker images={images} onChange={(next) => setImages(next.slice(-1))} max={1} disabled={disabled || sending} />
          <button
            disabled={disabled || sending || images.length !== 1}
            onClick={async () => {
              setSending(true);
              setError('');
              try {
                await onStart(images, prompt.trim());
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSending(false);
              }
            }}
          >
            Start screenshot review
          </button>
        </>
      )}
      {state && (
        <div className="loop-state">
          {state.prompt && <blockquote>{state.prompt}</blockquote>}
          <p>
            <strong>Round {state.round}/20</strong> · {state.phase}
            {running && <span className="spinner" />}
          </p>
          {running && <button className="small danger" onClick={() => onCancel().catch((e) => setError((e as Error).message))}>Cancel the loop</button>}
          {state.error && <p className="error">{state.error}</p>}
          {state.rounds
            .slice()
            .reverse()
            .map((round) => (
              <details key={round.round} open={round.round === state.round}>
                <summary>Round {round.round}{round.workerAdjusted ? ' · adjusted' : ''}</summary>
                {round.reviews.map((review) => (
                  <button key={review.reviewId} className={`review-line verdict-${review.result.verdict}`} onClick={() => onOpenReview(review.reviewId)} title="Open this reviewer's conversation">
                    <strong>{review.focus}</strong> · {review.result.verdict}
                    <span className="muted">{review.result.summary}</span>
                  </button>
                ))}
              </details>
            ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
