import { useEffect, useRef, useState } from 'react';
import type { CodexItem } from '../../shared/types.ts';

export type LogEntry = { kind: 'item'; item: CodexItem } | { kind: 'log'; level: 'info' | 'error'; text: string };

/** Minutes:seconds since `since`, ticking. */
export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return <span className="muted">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}

/** A Codex run's messages and commands, as streamed from the server. */
export function LogView({ entries, live }: { entries: LogEntry[]; live: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) end.current?.scrollIntoView({ block: 'nearest' });
  }, [entries.length, live]);
  if (entries.length === 0) return <p className="hint">{live ? 'Waiting for Codex…' : 'No log recorded.'}</p>;
  return (
    <div className="log">
      {entries.map((e, i) => {
        if (e.kind === 'log') {
          return (
            <div key={i} className={`log-line ${e.level}`}>
              {e.text}
            </div>
          );
        }
        const it = e.item;
        switch (it.type) {
          case 'agent_message':
            // The final message is the JSON result, shown in the result card instead.
            if (it.text?.trim().startsWith('{')) return null;
            return (
              <div key={it.id} className="log-msg">
                {it.text}
              </div>
            );
          case 'reasoning':
            return (
              <div key={it.id} className="log-reasoning">
                {it.text}
              </div>
            );
          case 'command_execution':
            return (
              <details key={it.id} className={`log-cmd ${it.status}`}>
                <summary>
                  <code>$ {it.command}</code>
                  {it.status === 'in_progress' ? <span className="spinner" /> : it.exitCode ? <span className="badge bad">exit {it.exitCode}</span> : null}
                </summary>
                {it.output && <pre>{it.output}</pre>}
              </details>
            );
          default:
            return (
              <details key={it.id} className="log-other">
                <summary>{it.type}</summary>
                <pre>{typeof it.detail === 'string' ? it.detail : JSON.stringify(it.detail ?? it.text, null, 2)}</pre>
              </details>
            );
        }
      })}
      <div ref={end} />
    </div>
  );
}
