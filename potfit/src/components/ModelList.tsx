import { useRef, useState } from 'react';
import type { PotModel } from '../../shared/types.ts';
import { ACCEPTED_EXTENSIONS } from '../viewer/importers.ts';

// Phone file pickers can grey out model files they have no file type for
// (iOS does for some), so touch devices list every file and the importer
// turns down the rest.
const ACCEPT = matchMedia('(pointer: coarse)').matches ? undefined : ACCEPTED_EXTENSIONS.join(',');

interface Props {
  models: PotModel[];
  selectedId: string | null;
  busy: string | null;
  onSelect(id: string): void;
  onFiles(files: File[]): void;
  onNewDesign(): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
}

export function ModelList({ models, selectedId, busy, onSelect, onFiles, onNewDesign, onRename, onDelete }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <section
      className={`panel models ${dragging ? 'dropping' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFiles([...e.dataTransfer.files]);
      }}
    >
      <header>
        <h2>Pot models</h2>
        <div className="row tight">
          <button className="small" onClick={onNewDesign} disabled={!!busy} title="Design a new pot from a description or pictures">
            + Design
          </button>
          <button className="small" onClick={() => input.current?.click()} disabled={!!busy}>
            + Import
          </button>
        </div>
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept={ACCEPT}
          onChange={(e) => {
            onFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </header>
      {busy && <p className="hint busy">{busy}</p>}
      {models.length === 0 && !busy && <p className="hint">Drop an STL, 3MF, OBJ, GLB or PLY file here, use Import, or design a new pot.</p>}
      <ul className="list">
        {models.map((m) => (
          <li key={m.id} className={m.id === selectedId ? 'active' : ''}>
            <button className="item" onClick={() => onSelect(m.id)}>
              <strong>{m.name}</strong>
              <span>
                {m.sourceFile} · {m.triangleCount >= 10000 ? `${Math.round(m.triangleCount / 1000)}k` : m.triangleCount} triangles
              </span>
            </button>
            <button
              className="icon"
              title="Rename"
              onClick={() => {
                const name = prompt('Model name', m.name);
                if (name && name.trim()) onRename(m.id, name.trim());
              }}
            >
              ✎
            </button>
            <button
              className="icon"
              title="Delete"
              onClick={() => {
                if (confirm(`Delete model "${m.name}" and its Codex history?`)) onDelete(m.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
