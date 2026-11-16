import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { segments, type RunComment } from '../../shared/comments.ts';

/**
 * Comments on the text of a result card, Google Docs style: select text and
 * a popup offers "Comment", which turns into the comment box in place. The
 * comment saves when you click away and is dropped on Escape. Saved comments
 * show as highlights with bubbles beside them in the card's margin.
 */

type Anchor = Pick<RunComment, 'field' | 'start' | 'end' | 'quote'>;
const DRAFT = 'draft';

interface Ctx {
  comments: RunComment[];
  draft: Anchor | null;
  active: string | null;
  setActive(id: string | null): void;
}
const CommentsCtx = createContext<Ctx | null>(null);

/** A block of text that can be commented on. `field` names it within the card. */
export function CText({ field, text }: { field: string; text: string }) {
  const ctx = useContext(CommentsCtx);
  if (!ctx) return <>{text}</>;
  const ranges = ctx.comments.filter((c) => c.field === field);
  const all = ctx.draft?.field === field ? [...ranges, { ...ctx.draft, id: DRAFT }] : ranges;
  return (
    <span data-field={field}>
      {segments(text.length, all).map((s) => {
        const piece = text.slice(s.start, s.end);
        if (s.ids.length === 0) return piece;
        const cls = ['cmark', s.ids.includes(DRAFT) && 'draft', ctx.active && s.ids.includes(ctx.active) && 'active'].filter(Boolean).join(' ');
        const id = s.ids.find((i) => i !== DRAFT);
        return (
          <mark key={s.start} className={cls} data-c={s.ids.join(' ')} onClick={id ? () => ctx.setActive(id) : undefined}>
            {piece}
          </mark>
        );
      })}
    </span>
  );
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** The selected text, if it lies within one commentable block of `root`. */
function readSelection(root: HTMLElement): (Anchor & { top: number; left: number }) | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const blockOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('[data-field]') ?? null;
  const block = blockOf(range.startContainer);
  if (!block || block !== blockOf(range.endContainer) || block.closest('.commentable') !== root) return null;
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const text = block.textContent ?? '';
  let start = before.toString().length;
  let end = start + range.toString().length;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return null;
  const r = range.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  return {
    field: block.dataset.field!,
    start,
    end,
    quote: text.slice(start, end),
    top: r.bottom - box.top + 6,
    left: Math.max(0, Math.min(r.left - box.left, box.width - 240)),
  };
}

/**
 * A comment text box that saves when you click or tab away (or press
 * Ctrl/Cmd+Enter) and cancels on Escape. Unmounting it also saves.
 */
function CommentEditor({ initial, onSave, onCancel, children }: { initial: string; onSave(text: string): void; onCancel(): void; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(initial);
  const latest = useRef({ text, onSave, onCancel, done: false });
  latest.current = { ...latest.current, text, onSave, onCancel };
  const finish = (save: boolean) => {
    const l = latest.current;
    if (l.done) return;
    l.done = true;
    if (save) l.onSave(l.text);
    else l.onCancel();
  };
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' });
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) finish(true);
    };
    document.addEventListener('pointerdown', down, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      finish(true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={box} className="comment-editor">
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder="Comment"
        onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            finish(true);
          }
        }}
        onBlur={(e) => {
          // Tabbing away saves; switching windows (no related target) doesn't.
          if (e.relatedTarget && !box.current?.contains(e.relatedTarget as Node)) finish(true);
        }}
      />
      <div className="row spread tight">
        <span className="muted">Saves when you click away · Esc cancels</span>
        {children}
      </div>
    </div>
  );
}

function Bubble({ comment, open, top, onOpen, onClose, onChange, onDelete, measure }: {
  comment: RunComment;
  open: boolean;
  top: number | undefined;
  onOpen(): void;
  onClose(): void;
  onChange(text: string): void;
  onDelete(): void;
  measure(el: HTMLDivElement | null): void;
}) {
  return (
    <div
      ref={measure}
      className={`comment-bubble${open ? ' open' : ''}${comment.sentAt ? ' sent' : ''}`}
      style={{ top: top ?? 0, visibility: top === undefined ? 'hidden' : undefined }}
      title={open ? undefined : `“${comment.quote}”`}
      onClick={open ? undefined : onOpen}
    >
      {open ? (
        <CommentEditor
          initial={comment.text}
          onSave={(text) => {
            if (!text.trim()) onDelete();
            else if (text !== comment.text) onChange(text);
            onClose();
          }}
          onCancel={onClose}
        >
          <button className="small link danger-text" onClick={onDelete}>
            Delete
          </button>
        </CommentEditor>
      ) : (
        <>
          <div className="comment-text">{comment.text}</div>
          {comment.sentAt && <div className="muted">Sent to Claude</div>}
        </>
      )}
    </div>
  );
}

/**
 * A result card whose `CText` blocks can be commented on. Comments are
 * kept by the caller (`onChange` gets the whole new list).
 */
export function Commentable({ comments, onChange, className, children }: {
  comments: RunComment[];
  onChange(comments: RunComment[]): void;
  className?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<(Anchor & { top: number; left: number }) | null>(null);
  const [writing, setWriting] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [tops, setTops] = useState<Record<string, number>>({});
  const [height, setHeight] = useState(0);
  const bubbles = useRef(new Map<string, HTMLDivElement>());
  // Editors save on unmount, after this render's props may be stale.
  const current = useRef({ comments, onChange });
  current.current = { comments, onChange };
  const update = (next: (cs: RunComment[]) => RunComment[]) => current.current.onChange(next(current.current.comments));

  // Offer "Comment" for a selection once the pointer is up (not mid-drag).
  // Pressing the popup itself (which may clear the selection on touch) keeps it.
  const popup = useRef<HTMLDivElement>(null);
  const writingRef = useRef(writing);
  writingRef.current = writing;
  const onPopup = useRef(false);
  useEffect(() => {
    let pressed = false;
    const check = () => {
      if (!writingRef.current && !onPopup.current && root.current) setPick(readSelection(root.current));
    };
    const down = (e: PointerEvent) => {
      pressed = true;
      onPopup.current = !!popup.current?.contains(e.target as Node);
    };
    const up = () => {
      pressed = false;
      setTimeout(check);
    };
    const changed = () => {
      if (!pressed) check();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('selectionchange', changed);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('selectionchange', changed);
    };
  }, []);

  // Line each bubble up with its highlight, pushing it down past the one above.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const layout = () => {
      const box = el.getBoundingClientRect();
      const placed = comments
        .map((c) => ({ id: c.id, mark: el.querySelector(`mark[data-c~="${c.id}"]`) }))
        .map(({ id, mark }) => ({ id, top: mark ? mark.getBoundingClientRect().top - box.top : Infinity }))
        .sort((a, b) => a.top - b.top);
      const next: Record<string, number> = {};
      let y = 0;
      for (const p of placed) {
        const top = Math.max(Number.isFinite(p.top) ? p.top : y, y);
        next[p.id] = top;
        y = top + (bubbles.current.get(p.id)?.offsetHeight ?? 40) + 6;
      }
      setTops((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setHeight(y);
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    for (const b of bubbles.current.values()) ro.observe(b);
    return () => ro.disconnect();
  }, [comments, active]);

  const close = () => {
    writingRef.current = false;
    onPopup.current = false;
    setWriting(false);
    setPick(null);
  };

  return (
    <CommentsCtx.Provider value={{ comments, draft: writing ? pick : null, active, setActive }}>
      <div ref={root} className={`commentable ${className ?? ''}${comments.length ? ' has-comments' : ''}`} style={{ minHeight: height || undefined }}>
        {children}
        {comments.length > 0 && (
          <div className="comment-rail">
            {comments.map((c) => (
              <Bubble
                key={c.id}
                comment={c}
                open={active === c.id}
                top={tops[c.id]}
                measure={(b) => (b ? bubbles.current.set(c.id, b) : bubbles.current.delete(c.id))}
                onOpen={() => setActive(c.id)}
                onClose={() => setActive((a) => (a === c.id ? null : a))}
                onChange={(text) => update((cs) => cs.map((x) => (x.id === c.id ? { ...x, text } : x)))}
                onDelete={() => {
                  update((cs) => cs.filter((x) => x.id !== c.id));
                  setActive(null);
                }}
              />
            ))}
          </div>
        )}
        {pick && (
          <div ref={popup} className="comment-popup" style={{ top: pick.top, left: pick.left }}>
            {writing ? (
              <CommentEditor
                initial=""
                onSave={(text) => {
                  const { top: _t, left: _l, ...anchor } = pick;
                  if (text.trim()) update((cs) => [...cs, { ...anchor, id: newId(), text: text.trim(), createdAt: new Date().toISOString(), sentAt: null }]);
                  close();
                }}
                onCancel={close}
              />
            ) : (
              <button
                className="small"
                // Keep the selection: a click would otherwise clear it first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  writingRef.current = true;
                  setWriting(true);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                💬 Comment
              </button>
            )}
          </div>
        )}
      </div>
    </CommentsCtx.Provider>
  );
}
