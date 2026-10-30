import { useState } from 'react';
import { DEFAULT_FIT, type CodexRun, type PotModel, type ReferencePot } from '../../shared/types.ts';
import { api } from '../api.ts';
import { ImagePicker, type PickedImage } from './ImagePicker.tsx';
import { NumberField } from './NumberField.tsx';

interface Props {
  references: ReferencePot[];
  /** Reference pot to start with. */
  referenceId: string | null;
  codexAvailable: boolean;
  onCreated(model: PotModel, run: CodexRun | null): void;
  onCancel(): void;
}

/** New pot from a description and/or reference images. */
export function DesignDialog({ references, referenceId, codexAvailable, onCreated, onCancel }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [refId, setRefId] = useState(referenceId ?? references.at(-1)?.id ?? '');
  const [clearance, setClearance] = useState(DEFAULT_FIT.clearance);
  const [topOffset, setTopOffset] = useState<number | null>(DEFAULT_FIT.topOffset);
  const [floorGap, setFloorGap] = useState(DEFAULT_FIT.floorGap);
  const [useCodex, setUseCodex] = useState(codexAvailable);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = !!refId && (!useCodex || description.trim() !== '' || images.length > 0);

  const create = async () => {
    setSending(true);
    setError(null);
    try {
      const { model, run } = await api.createDesign({
        name: name.trim(),
        description: description.trim(),
        images: images.map((i) => ({ name: i.name, dataUrl: i.dataUrl })),
        fit: { referenceId: refId, clearance, topOffset, floorGap },
        codex: useCodex,
      });
      onCreated(model, run);
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal design-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New design</h2>
        <p className="muted">
          Describe the pot, add pictures of pots or characters you like, or both. Codex designs it around the nursery pot, ready to print, and you can
          adjust it afterwards.
        </p>
        <label className="field stacked">
          <span>Description</span>
          <textarea
            rows={4}
            autoFocus
            value={description}
            placeholder="e.g. A round, smiling pot with little arms holding a book and a mug, stubby feet, and a smooth matte look."
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="field stacked">
          <span>Reference images</span>
          <ImagePicker images={images} onChange={setImages} />
        </div>
        <label className="field">
          <span>Name</span>
          <input value={name} placeholder="Codex will suggest one" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Nursery pot</span>
          <select value={refId} onChange={(e) => setRefId(e.target.value)}>
            <option value="">Choose…</option>
            {references.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} (⌀{r.topOD}/⌀{r.bottomOD} × {r.height})
              </option>
            ))}
          </select>
        </label>
        {references.length === 0 && <p className="hint">Add a reference pot on the left first.</p>}
        <div className="grid-fields">
          <label className="field">
            <span title="Diametral: the radial gap is half of this">Clearance (⌀)</span>
            <NumberField value={clearance} min={0} step={0.5} digits={2} onChange={setClearance} />
            <em>mm</em>
          </label>
          <label className="field">
            <span title="How far the nursery pot's rim stands above the new pot's rim">Rim proud by</span>
            <NumberField value={topOffset} step={0.5} digits={2} allowEmpty placeholder="level" onChange={(v) => setTopOffset(Number.isNaN(v) ? null : v)} />
            <em>mm</em>
          </label>
          <label className="field">
            <span>Floor gap</span>
            <NumberField value={floorGap} min={0} step={0.5} digits={2} onChange={setFloorGap} />
            <em>mm</em>
          </label>
        </div>
        <label className="inline">
          <input type="checkbox" checked={useCodex} disabled={!codexAvailable} onChange={(e) => setUseCodex(e.target.checked)} /> Design it with Codex
          {!codexAvailable && <span className="muted"> (Codex isn't available)</span>}
        </label>
        {!useCodex && <p className="hint">Without Codex you get a plain pot with a few settings to adjust.</p>}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!ready || sending} onClick={create}>
            {sending ? 'Creating…' : useCodex ? 'Design it' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
