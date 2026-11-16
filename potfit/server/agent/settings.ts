// Which Claude model and reasoning effort a thread runs with.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AGENT_EFFORTS, type AgentEffort, type AgentModelOption, type AgentSettings } from '../../shared/types.ts';
import type { ToolStatus } from '../blender.ts';

export class BadRequest extends Error {}

/** Claude Code's model aliases (`claude --model`), latest first. Any full model ID works too. */
export const CLAUDE_MODELS: AgentModelOption[] = [
  { id: 'fable', name: 'Fable' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
];

/** Validate the model and effort a client asks for. Empty or null means the default. */
export function parseAgentSettings(input: Record<string, unknown> | AgentSettings): AgentSettings {
  const model = input.model;
  const effort = input.effort;
  if (model != null && (typeof model !== 'string' || (model.trim() && !/^[a-zA-Z0-9][a-zA-Z0-9._:\[\]/-]{0,199}$/.test(model.trim())))) {
    throw new BadRequest('Model must be a model ID of at most 200 characters');
  }
  if (effort != null && effort !== '' && !AGENT_EFFORTS.includes(effort as AgentEffort)) throw new BadRequest('Unknown reasoning effort');
  return { model: typeof model === 'string' ? model.trim() || null : null, effort: (effort || null) as AgentEffort | null };
}

/** "2.1.3 (Claude Code)" if `bin` runs. */
export async function claudeVersion(bin: string): Promise<ToolStatus> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['--version'], { timeout: 15000 });
    return { available: true, version: stdout.trim(), error: null };
  } catch (e) {
    return { available: false, version: null, error: (e as Error).message };
  }
}
