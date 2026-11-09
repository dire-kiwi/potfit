// Which tool calls an agent may make. potfit's own tools are allowed (each thread is only given its
// role's). Claude's file tools are kept to the thread's working directory (and a few files of
// potfit's it may read), the shell is off, and anything else asks the user (fitters and designers)
// or is denied (reviewers, which run with permission mode dont_ask).

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PermissionContext, PermissionDecision, PermissionQuery } from '@dire-kiwi/agent-threads-node';

export const NO_SHELL = "There's no shell in potfit. Use potfit's tools instead: get_state, check_fit, render_views, run_blender and the rest.";

/** The real path of `p`, or of its nearest existing parent with the rest appended (for new files). */
export function realish(p: string): string {
  let dir = resolve(p);
  const rest: string[] = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    rest.unshift(basename(dir));
    dir = parent;
  }
  try {
    dir = realpathSync(dir);
  } catch {
    // Not readable: compare as it is.
  }
  return join(dir, ...rest);
}

export function inside(path: string, root: string): boolean {
  const rel = relative(realish(root), realish(path));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep));
}

/** The file or directory a Claude file tool names, resolved against the thread's cwd. */
function targetOf(q: PermissionQuery, cwd: string): string {
  const input = (q.input ?? {}) as Record<string, unknown>;
  const p = input.file_path ?? input.notebook_path ?? input.path;
  return typeof p === 'string' && p ? resolve(cwd, p) : cwd;
}

export interface PolicyOptions {
  /** Files and directories outside the workspace the agent may read (potfit_bpy, potlib, manifold's types). */
  readable: string[];
}

export function potfitPolicy(opts: PolicyOptions) {
  return (q: PermissionQuery, ctx: PermissionContext): PermissionDecision => {
    const role = ctx.metadata.role;
    const reviewer = role === 'review';
    const cwd = ctx.thread.cwd;
    if (!cwd) return { deny: 'This thread has no working directory.' };
    // Claude Code's own bookkeeping: loading deferred tools' schemas.
    if (q.name === 'ToolSearch') return 'allow';
    switch (q.kind) {
      case 'app':
        return 'allow';
      case 'read':
      case 'search': {
        const pattern = (q.input as { pattern?: unknown } | null)?.pattern;
        // An absolute (or upward) glob reaches outside the directory it's given.
        if (q.name === 'Glob' && typeof pattern === 'string' && (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..'))) {
          return { deny: 'Glob patterns are relative to your working directory.' };
        }
        const target = targetOf(q, cwd);
        if (inside(target, cwd) || opts.readable.some((r) => inside(target, r))) return 'allow';
        return { deny: `Only files in your working directory (${cwd}) can be read.` };
      }
      case 'edit': {
        if (reviewer) return { deny: 'Reviewers only look; they change nothing.' };
        const target = targetOf(q, cwd);
        if (!inside(target, cwd)) return { deny: `Only files in your working directory (${cwd}) can be changed.` };
        const rel = relative(realish(cwd), realish(target));
        if (role === 'fit' && rel === 'mesh.stl') return { deny: "mesh.stl is the model's mesh; change it with apply_mesh_edit." };
        if (role === 'design' && (rel === 'refs' || rel.startsWith(`refs${sep}`))) return { deny: "refs/ holds the user's reference images; leave them as they are." };
        if (role === 'design' && (rel === '.applied' || rel.startsWith(`.applied${sep}`))) return { deny: '.applied/ is the design as the user last saw it; apply_design keeps it.' };
        return 'allow';
      }
      case 'shell':
        return { deny: NO_SHELL };
      case 'web':
        return reviewer ? { deny: "Reviewers don't use the web." } : 'allow';
      case 'subagent':
      case 'todo':
        return 'allow';
      case 'mcp':
        return { deny: 'potfit has no other MCP servers.' };
      default:
        return reviewer ? 'deny' : 'ask';
    }
  };
}
