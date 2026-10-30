import { useState } from 'react';
import type { ImportedPart } from '../viewer/importers.ts';

export interface PendingImport {
  file: File;
  parts: ImportedPart[];
}

interface Props {
  pending: PendingImport;
  onImport(parts: ImportedPart[], combine: boolean): void;
  onCancel(): void;
}

/** Shown when a file holds several objects (e.g. a 3MF plate with a few pots). */
export function ImportDialog({ pending, onImport, onCancel }: Props) {
  const [chosen, setChosen] = useState(() => pending.parts.map(() => true));
  const [combine, setCombine] = useState(false);
  const selected = pending.parts.filter((_, i) => chosen[i]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{pending.file.name}</h2>
        <p>This file contains {pending.parts.length} objects. Pick the ones to import.</p>
        <ul className="checklist">
          {pending.parts.map((p, i) => (
            <li key={i}>
              <label>
                <input type="checkbox" checked={chosen[i]} onChange={(e) => setChosen(chosen.map((c, j) => (j === i ? e.target.checked : c)))} />
                {p.name} <span className="muted">({(p.positions.length / 9).toLocaleString()} triangles)</span>
              </label>
            </li>
          ))}
        </ul>
        <label className="inline">
          <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} /> Combine into one model
        </label>
        <div className="row end">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={selected.length === 0} onClick={() => onImport(selected, combine)}>
            Import {combine || selected.length === 1 ? '1 model' : `${selected.length} models`}
          </button>
        </div>
      </div>
    </div>
  );
}
