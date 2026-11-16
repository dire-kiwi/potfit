// Once, on the first start after potfit moved from Codex to agent-threads on Claude Code: delete
// what only Codex used. Models keep their mesh, placement, goals, design script, parts, reference
// images and params. Writes data/migrated-codex.json when it's done, so it doesn't run again;
// running it again after it stopped part way is harmless.

import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER = 'migrated-codex.json';
const DESIGN_LEFTOVERS = ['AGENTS.md', 'pot-tool', 'blender', 'failed.mjs'];

export async function migrateFromCodex(dataDir: string): Promise<{ models: number; runs: number } | null> {
  const marker = join(dataDir, MARKER);
  if (existsSync(marker)) return null;
  const modelsDir = join(dataDir, 'models');
  let models = 0;
  let runs = 0;
  for (const id of await readdir(modelsDir).catch(() => [] as string[])) {
    const dir = join(modelsDir, id);
    const file = join(dir, 'model.json');
    if (!existsSync(file)) continue;
    runs += (await readdir(join(dir, 'runs')).catch(() => [] as string[])).length;
    await rm(join(dir, 'runs'), { recursive: true, force: true });
    await rm(join(dir, 'codex'), { recursive: true, force: true });
    await rm(join(dir, 'screenshot-review.json'), { force: true });
    for (const f of DESIGN_LEFTOVERS) await rm(join(dir, 'design', f), { force: true });
    const model = JSON.parse(await readFile(file, 'utf8'));
    delete model.codexThreadId;
    if (model.design) delete model.design.threadId;
    await writeFile(`${file}.tmp`, JSON.stringify(model, null, 2));
    await rename(`${file}.tmp`, file);
    models++;
  }
  await writeFile(marker, JSON.stringify({ migratedAt: new Date().toISOString(), models, runsRemoved: runs }, null, 2) + '\n');
  return { models, runs };
}
