#!/usr/bin/env node
// Build a design script in a child process. The server runs this under Node's
// permission model (read-only access to the code and the script, writes only
// to --out, no network or subprocesses), because the script is code Codex
// wrote.
//
//   node tools/build-cli.ts --script design.mjs --input input.json --out dir
//
// input.json is a DesignInput. Writes dir/design.stl (design frame, +Z up),
// dir/pieces/<name>.stl for each separate piece, and dir/result.json
// ({ report, paramSpec, params }); errors go to stderr with exit code 1.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeBinarySTL } from '../shared/stl.ts';
import { buildDesign } from './design-build.ts';

const { values } = parseArgs({ options: { script: { type: 'string' }, input: { type: 'string' }, out: { type: 'string' } } });
if (!values.script || !values.input || !values.out) {
  process.stderr.write('usage: build-cli.ts --script <design.mjs> --input <input.json> --out <dir>\n');
  process.exit(2);
}

try {
  const input = JSON.parse(readFileSync(resolve(values.input), 'utf8'));
  const out = await buildDesign(resolve(values.script), input);
  writeFileSync(join(values.out, 'design.stl'), writeBinarySTL(out.positions, 'potfit design'));
  const names = Object.keys(out.pieces);
  if (names.length) mkdirSync(join(values.out, 'pieces'));
  for (const name of names) writeFileSync(join(values.out, 'pieces', `${name}.stl`), writeBinarySTL(out.pieces[name], `potfit design piece: ${name}`));
  writeFileSync(join(values.out, 'result.json'), JSON.stringify({ report: out.report, paramSpec: out.paramSpec, params: out.params }));
} catch (e) {
  process.stderr.write(`${(e as Error).message ?? e}\n`);
  process.exit(1);
}
