// The docked agent thread: the model's fitter or designer, or one of its reviews, drawn with
// agent-threads' <Thread> and potfit's composer and tool cards.

import { Thread } from '@dire-kiwi/agent-threads-react';
import type { PotModel, Review, ThreadState } from '../../shared/types.ts';
import { api } from '../api.ts';
import { PotComposer } from './PotComposer.tsx';
import { TOOL_RENDERERS, renderItem } from './renderers.tsx';
import { useThreadSource } from './source.ts';

const VERDICT_ICON: Record<string, string> = { pass: '✓', concerns: '!', fail: '✗' };

function Empty({ role }: { role: 'fit' | 'design' | 'review' }) {
  if (role === 'review') return <p className="dock-empty">The reviewer hasn't started yet.</p>;
  return (
    <div className="dock-empty">
      <h3>{role === 'design' ? 'Claude designs your pot' : 'Claude fits your pot'}</h3>
      <p>
        {role === 'design'
          ? 'Describe the pot below, attach pictures, and Claude writes a design around the nursery pot, builds it and looks at it.'
          : 'Send a message (or just press Fit it) and Claude analyses the model, solves the fit, checks it in section and applies it. Then give it feedback: it sees your manual moves and the views.'}
      </p>
      <p className="muted small">Each change it applies shows up here with Revert.</p>
    </div>
  );
}

export function AgentDock({ model, threads, reviews, selected, onSelect, onStartOver, available }: {
  model: PotModel;
  threads: Record<string, ThreadState>;
  reviews: Review[];
  /** The thread shown: the model's own (null) or a review's. */
  selected: string | null;
  onSelect(threadId: string | null): void;
  onStartOver(): void;
  available: boolean;
}) {
  const mainId = model.threadId ?? null;
  const threadId = selected ?? mainId;
  const source = useThreadSource(threadId);
  const role = threadId && threadId !== mainId ? 'review' : model.design ? 'design' : 'fit';
  const main = mainId ? threads[mainId] : undefined;
  const working = main && (main.status === 'running' || main.status === 'waiting');
  const running = reviews.filter((r) => r.status === 'running').length;

  return (
    <div className="dock">
      <div className="dock-tabs">
        <button className={selected === null ? 'on' : ''} onClick={() => onSelect(null)}>
          {model.design ? 'Designer' : 'Fitter'}
          {working && <span className="spinner" />}
        </button>
        {reviews.length > 0 && (
          <select className={selected !== null ? 'on' : ''} value={selected ?? ''} onChange={(e) => onSelect(e.target.value || null)} aria-label="Reviews">
            <option value="">{`Reviews · ${reviews.length}${running ? ` (${running} running)` : ''}`}</option>
            {reviews
              .slice()
              .reverse()
              .map((r) => (
                <option key={r.id} value={r.threadId}>
                  {r.result ? VERDICT_ICON[r.result.verdict] : r.status === 'running' ? '…' : '–'} {r.focus ?? 'Review'} · {new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </option>
              ))}
          </select>
        )}
        <span className="grow" />
        {selected === null && mainId && (
          <button className="small link" disabled={!!working} title="The next message starts a new conversation; this one stays above it" onClick={onStartOver}>
            New conversation
          </button>
        )}
      </div>
      {!available && <p className="dock-warning">Claude Code isn't available on the server; see the status in the header.</p>}
      {threadId && source ? (
        <Thread
          key={threadId}
          className="dock-thread"
          source={source}
          onCommand={api.command}
          tools={TOOL_RENDERERS}
          renderItem={renderItem}
          empty={<Empty role={role} />}
          composer={<PotComposer role={role} mine={role !== 'review'} />}
        />
      ) : (
        <div className="dock-loading">{threadId ? 'Connecting…' : <Empty role={role} />}</div>
      )}
    </div>
  );
}
