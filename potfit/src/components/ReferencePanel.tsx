import { useState } from 'react';
import type { ReferenceInput, ReferencePot } from '../../shared/types.ts';

interface Props {
  references: ReferencePot[];
  /** Reference used by the selected model, highlighted in the list. */
  activeId: string | null;
  onUse(id: string): void;
  onCreate(input: ReferenceInput): Promise<void>;
  onUpdate(id: string, input: ReferenceInput): Promise<void>;
  onDelete(id: string): Promise<void>;
}

type Draft = { name: string; topOD: string; bottomOD: string; height: string; notes: string };

const empty: Draft = { name: '', topOD: '', bottomOD: '', height: '', notes: '' };

function toDraft(r: ReferencePot): Draft {
  return { name: r.name, topOD: String(r.topOD), bottomOD: String(r.bottomOD), height: String(r.height), notes: r.notes };
}

function parse(d: Draft): ReferenceInput | string {
  const name = d.name.trim();
  if (!name) return 'Give the pot a name';
  const nums = { topOD: Number(d.topOD), bottomOD: Number(d.bottomOD), height: Number(d.height) };
  for (const [k, v] of Object.entries(nums)) {
    if (!Number.isFinite(v) || v <= 0) return `${k === 'topOD' ? 'Top OD' : k === 'bottomOD' ? 'Bottom OD' : 'Height'} must be a positive number`;
  }
  return { name, ...nums, notes: d.notes.trim() };
}

export function ReferencePanel({ references, activeId, onUse, onCreate, onUpdate, onDelete }: Props) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (id: string | 'new') => {
    setEditing(id);
    setError(null);
    setDraft(id === 'new' ? empty : toDraft(references.find((r) => r.id === id)!));
  };

  const save = async () => {
    const input = parse(draft);
    if (typeof input === 'string') return setError(input);
    setBusy(true);
    try {
      if (editing === 'new') await onCreate(input);
      else if (editing) await onUpdate(editing, input);
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof Draft, label: string, unit?: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        value={draft[key]}
        inputMode={unit ? 'decimal' : undefined}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      {unit && <em>{unit}</em>}
    </label>
  );

  return (
    <section className="panel">
      <header>
        <h2>Reference pots</h2>
        <button className="small" onClick={() => open('new')}>
          + Add
        </button>
      </header>
      {references.length === 0 && editing !== 'new' && <p className="hint">Add the nursery pot your plant lives in: its top and bottom outside diameters and height.</p>}
      <ul className="list">
        {references.map((r) => (
          <li key={r.id} className={r.id === activeId ? 'active' : ''}>
            <button className="item" onClick={() => onUse(r.id)} title="Use for the selected model">
              <strong>{r.name}</strong>
              <span>
                ⌀{r.topOD} / ⌀{r.bottomOD} × {r.height} mm
              </span>
            </button>
            <button className="icon" title="Edit" onClick={() => open(r.id)}>
              ✎
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <div className="form">
          {field('name', 'Name')}
          {field('topOD', 'Top OD', 'mm')}
          {field('bottomOD', 'Bottom OD', 'mm')}
          {field('height', 'Height', 'mm')}
          {field('notes', 'Notes')}
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="primary" disabled={busy} onClick={save}>
              {editing === 'new' ? 'Add pot' : 'Save'}
            </button>
            <button onClick={() => setEditing(null)}>Cancel</button>
            {editing !== 'new' && (
              <button
                className="danger"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(`Delete reference pot "${draft.name}"?`)) return;
                  await onDelete(editing);
                  setEditing(null);
                }}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
