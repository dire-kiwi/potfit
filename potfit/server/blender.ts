// Blender, which Codex can run headless to edit meshes (fit workspaces) and
// make parts for designs (design workspaces).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface ToolStatus {
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface BlenderOption {
  bin: string;
  /** Checked once, when the server starts. */
  status: Promise<ToolStatus>;
}

/** "Blender 4.3.2" if `bin` runs, from the first line of `blender --version`. */
export async function blenderVersion(bin: string): Promise<ToolStatus> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['--version'], { timeout: 30000 });
    const line = stdout.split('\n').find((l) => /^Blender \d/.test(l.trim()));
    if (!line) return { available: false, version: null, error: `${bin} --version did not print a Blender version` };
    return { available: true, version: line.trim(), error: null };
  } catch (e) {
    return { available: false, version: null, error: (e as Error).message };
  }
}

/**
 * The workspace's ./blender: headless Blender with tools/blender (potfit_bpy)
 * on Python's path, so `./blender -P script.py -- args`.
 */
export function blenderWrapper(bin: string, helpers: string): string {
  return `#!/bin/sh\nexec "${bin}" -b --factory-startup -noaudio --python-expr "import sys; sys.path.insert(0, '${helpers}')" "$@"\n`;
}
