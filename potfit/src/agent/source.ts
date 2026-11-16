// A thread's ThreadSource over potfit's SSE stream (agent-threads' docs/transport.md): each
// snapshot on the stream (one per connection, so after EventSource reconnects too) makes a new source.

import { useEffect, useState } from 'react';
import type { ThreadEvent, ThreadSource } from '@dire-kiwi/agent-threads-react';
import { api } from '../api.ts';

export function useThreadSource(threadId: string | null): ThreadSource | null {
  const [source, setSource] = useState<ThreadSource | null>(null);
  useEffect(() => {
    setSource(null);
    if (!threadId) return;
    const es = api.threadStream(threadId);
    const listeners = new Set<(e: ThreadEvent) => void>();
    es.addEventListener('event', (m) => {
      const event = JSON.parse((m as MessageEvent).data) as ThreadEvent;
      for (const fn of listeners) fn(event);
    });
    es.addEventListener('snapshot', (m) =>
      setSource({
        snapshot: JSON.parse((m as MessageEvent).data),
        subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
        resync: (seq) => api.threadEvents(threadId, seq),
        loadEarlier: (before) => api.threadItems(threadId, before),
      }),
    );
    return () => es.close();
  }, [threadId]);
  return source;
}
