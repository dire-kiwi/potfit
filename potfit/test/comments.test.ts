import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedbackWithComments, parseComments, segments, type RunComment } from '../shared/comments.ts';

const comment = (over: Partial<RunComment> = {}): RunComment => ({
  id: 'a1', field: 'summary', start: 4, end: 9, quote: 'quick', text: 'Too slow', createdAt: '2026-11-16T00:00:00.000Z', sentAt: null, ...over,
});

test('segments split text at every highlight boundary, overlaps included', () => {
  assert.deepEqual(segments(10, [{ id: 'a', start: 2, end: 6 }, { id: 'b', start: 4, end: 8 }]), [
    { start: 0, end: 2, ids: [] },
    { start: 2, end: 4, ids: ['a'] },
    { start: 4, end: 6, ids: ['a', 'b'] },
    { start: 6, end: 8, ids: ['b'] },
    { start: 8, end: 10, ids: [] },
  ]);
  // Ranges past the end are clamped; empty ones ignored.
  assert.deepEqual(segments(5, [{ id: 'a', start: 3, end: 50 }, { id: 'b', start: 9, end: 12 }]), [
    { start: 0, end: 3, ids: [] },
    { start: 3, end: 5, ids: ['a'] },
  ]);
  assert.deepEqual(segments(0, []), []);
});

test('parseComments keeps valid comments and rejects bad ones', () => {
  assert.deepEqual(parseComments([comment()]), [comment()]);
  assert.deepEqual(parseComments([{ ...comment(), sentAt: undefined, extra: 1 }]), [comment()]);
  for (const bad of [
    { start: 5, end: 5 },
    { start: -1 },
    { start: 1.5 },
    { text: '  ' },
    { text: 42 },
    { id: 'x'.repeat(101) },
    { sentAt: 3 },
  ]) {
    assert.throws(() => parseComments([{ ...comment(), ...bad }]), Error, JSON.stringify(bad));
  }
  assert.throws(() => parseComments('nope'));
  assert.throws(() => parseComments(Array.from({ length: 201 }, () => comment())));
});

test('feedback quotes each commented passage before the comment', () => {
  const cs = [comment(), comment({ id: 'b', quote: 'lazy\n  dog', text: 'Rename it ' })];
  assert.equal(feedbackWithComments('', []), '');
  assert.equal(feedbackWithComments(' Tighter. ', []), 'Tighter.');
  assert.equal(
    feedbackWithComments('Tighter.', cs),
    'Tighter.\n\nComments on your earlier replies:\n\n> quick\nToo slow\n\n> lazy dog\nRename it',
  );
  assert.ok(feedbackWithComments('', cs).startsWith('Comments on your earlier replies:'));
});
