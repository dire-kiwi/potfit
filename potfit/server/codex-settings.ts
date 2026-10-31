import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REASONING_EFFORTS, type CodexModelOption, type CodexSettings, type ReasoningEffort } from '../shared/types.ts';

export class BadRequest extends Error {}

/** Validate API overrides before creating a design or starting a run. */
export function parseCodexSettings(input: Record<string, unknown> | CodexSettings): CodexSettings {
  const model = input.model;
  const effort = input.effort;
  if (model != null && (typeof model !== 'string' || (model.trim() && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model.trim())))) {
    throw new BadRequest('Model must be a model ID of at most 200 characters');
  }
  if (effort != null && effort !== '' && !REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
    throw new BadRequest('Unknown reasoning effort');
  }
  return { model: typeof model === 'string' ? model.trim() || null : null, effort: (effort || null) as ReasoningEffort | null };
}

export function codexSettingsArgs(settings: CodexSettings): string[] {
  return [
    ...(settings.model ? ['-m', settings.model] : []),
    ...(settings.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`] : []),
  ];
}

/** Optional Codex CLI catalog; no login files or network calls are needed. */
export async function codexModels(home = process.env.CODEX_HOME || join(homedir(), '.codex')): Promise<CodexModelOption[]> {
  try {
    return parseCodexModels(JSON.parse(await readFile(join(home, 'models_cache.json'), 'utf8')));
  } catch {
    // Older CLIs and fresh installs may not have a cache. Custom IDs still work.
    return [];
  }
}

export function parseCodexModels(cache: unknown): CodexModelOption[] {
  if (!cache || typeof cache !== 'object' || !('models' in cache) || !Array.isArray(cache.models)) return [];
  const models = new Map<string, CodexModelOption>();
  for (const m of cache.models) {
    if (!m || typeof m !== 'object' || typeof m.slug !== 'string' || m.visibility === 'hide') continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels.map((r: { effort?: unknown } | null) => r?.effort).filter((r: unknown): r is ReasoningEffort => REASONING_EFFORTS.includes(r as ReasoningEffort))
      : [];
    models.set(m.slug, { id: m.slug, name: typeof m.display_name === 'string' ? m.display_name : m.slug, efforts });
  }
  return [...models.values()];
}
