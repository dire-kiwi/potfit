// What a model's /live stream carries: changes the agent (or a revert) made to the model, its
// threads' status, checkpoints, reviews and the screenshot review loop.

import type { LiveEvent } from '../../shared/types.ts';

export class Live {
  private listeners = new Map<string, Set<(e: LiveEvent) => void>>();

  emit(modelId: string, event: LiveEvent) {
    for (const fn of this.listeners.get(modelId) ?? []) {
      try {
        fn(event);
      } catch {
        // A broken connection's writer; it unsubscribes when it closes.
      }
    }
  }

  subscribe(modelId: string, fn: (e: LiveEvent) => void): () => void {
    let set = this.listeners.get(modelId);
    if (!set) this.listeners.set(modelId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(modelId);
    };
  }
}
