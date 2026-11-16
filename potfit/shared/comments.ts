/**
 * Comments the user leaves on text in a Codex run's result (its summary, a
 * review finding, ...). They are anchored to a text block of the result card
 * by `field` and character offsets, and go to Codex with the next feedback.
 */
export interface RunComment {
  id: string;
  /** Which text block of the result card, e.g. "summary" or "finding.2.detail". */
  field: string;
  /** Character offsets of the commented text in the block, end exclusive. */
  start: number;
  end: number;
  /** The commented text, to send along and to notice if the block changes. */
  quote: string;
  text: string;
  createdAt: string;
  /** When it went to Codex with feedback; null until then. */
  sentAt: string | null;
}

export const MAX_COMMENTS = 200;

/** Validate comments sent by the client. Throws an Error naming the problem. */
export function parseComments(value: unknown): RunComment[] {
  if (!Array.isArray(value)) throw new Error('comments must be an array');
  if (value.length > MAX_COMMENTS) throw new Error(`at most ${MAX_COMMENTS} comments per run`);
  return value.map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const str = (k: string, max: number) => {
      const v = o[k];
      if (typeof v !== 'string' || v.length > max) throw new Error(`comment ${i}: ${k} must be a string of at most ${max} characters`);
      return v;
    };
    const start = o.start, end = o.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
      throw new Error(`comment ${i}: start and end must be integers with 0 <= start < end`);
    }
    const text = str('text', 5000);
    if (!text.trim()) throw new Error(`comment ${i}: text is empty`);
    const sentAt = o.sentAt ?? null;
    if (sentAt !== null && typeof sentAt !== 'string') throw new Error(`comment ${i}: sentAt must be a string or null`);
    return {
      id: str('id', 100),
      field: str('field', 100),
      start: start as number,
      end: end as number,
      quote: str('quote', 5000),
      text,
      createdAt: str('createdAt', 40),
      sentAt: sentAt as string | null,
    };
  });
}

/** Unsent comments written into feedback for Codex: the quoted text, then the comment. */
export function commentsAsFeedback(comments: RunComment[]): string {
  return comments.map((c) => `> ${c.quote.replace(/\s+/g, ' ').trim()}\n${c.text.trim()}`).join('\n\n');
}

/** Feedback text with the unsent comments appended. */
export function feedbackWithComments(feedback: string, comments: RunComment[]): string {
  const text = feedback.trim();
  if (comments.length === 0) return text;
  const block = `Comments on your earlier replies:\n\n${commentsAsFeedback(comments)}`;
  return text ? `${text}\n\n${block}` : block;
}

export interface Segment {
  start: number;
  end: number;
  /** Ids of the ranges covering this piece of text, in the order given. */
  ids: string[];
}

/**
 * Split `length` characters at every range boundary so overlapping
 * highlights can be drawn as flat spans. Ranges are clamped to the text.
 */
export function segments(length: number, ranges: { id: string; start: number; end: number }[]): Segment[] {
  const live = ranges
    .map((r) => ({ ...r, start: Math.max(0, Math.min(length, r.start)), end: Math.max(0, Math.min(length, r.end)) }))
    .filter((r) => r.end > r.start);
  const cuts = [...new Set([0, length, ...live.flatMap((r) => [r.start, r.end])])].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i], end = cuts[i + 1];
    out.push({ start, end, ids: live.filter((r) => r.start <= start && r.end >= end).map((r) => r.id) });
  }
  return out;
}

