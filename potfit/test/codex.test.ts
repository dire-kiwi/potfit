import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResult, unwrapShell } from '../server/codex.ts';

test('shell wrappers are removed from commands', () => {
  assert.equal(unwrapShell("/usr/bin/bash -lc 'echo hi'"), 'echo hi');
  assert.equal(unwrapShell(`/usr/bin/bash -lc "./pot-tool check --transform '{\\"up\\":\\"+Z\\"}'"`), `./pot-tool check --transform '{"up":"+Z"}'`);
  assert.equal(unwrapShell('ls -la'), 'ls -la');
});

const transform = { up: '+Z', spin: 0, position: { x: 0, y: -1, z: 0 }, scale: { x: 1, y: 1, z: 1 } };

test('results are validated', () => {
  const r = parseResult(JSON.stringify({ transform, fit: { clearance: 4, scaleMode: 'uniform', topOffset: null, floorGap: 1 }, summary: 's', warnings: ['w'], confidence: 'high' }));
  assert.equal(r.confidence, 'high');
  assert.deepEqual(r.fit, { clearance: 4, scaleMode: 'uniform', topOffset: null, floorGap: 1 });
  assert.throws(() => parseResult(JSON.stringify({ transform: { ...transform, up: 'up' } })), /invalid transform/);
  assert.throws(() => parseResult('no json here'), /JSON/);
});

test('missing or malformed goals are ignored rather than failing the run', () => {
  assert.equal(parseResult(JSON.stringify({ transform, summary: 's' })).fit, null);
  assert.equal(parseResult(JSON.stringify({ transform, fit: { clearance: -1, scaleMode: 'uniform', topOffset: 0, floorGap: 0 } })).fit, null);
});

test('JSON wrapped in prose is still found', () => {
  assert.equal(parseResult(`Here you go:\n${JSON.stringify({ transform, summary: 'ok' })}`).summary, 'ok');
});
