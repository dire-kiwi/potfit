// The model's versions as a tree, from the header: go back to any version and carry on from it (the
// next change starts a new branch), save the model as it is, and rename versions.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { transformsEqual } from '../../shared/transform.ts';
import type { FitSettings, ModelVersion, PotModel } from '../../shared/types.ts';

const KIND_ICON: Record<ModelVersion['kind'], string> = { original: '◆', fit: '⤢', 'mesh-edit': '✂', design: '✦', manual: '✋', saved: '★' };
const KIND_TITLE: Record<ModelVersion['kind'], string> = {
  original: 'Where the history starts',
  fit: 'A fit Claude applied',
  'mesh-edit': 'A mesh edit Claude applied',
  design: 'A design Claude applied',
  manual: 'Your own edits',
  saved: 'Saved by you',
};

const sameFit = (a: FitSettings, b: FitSettings) =>
  a.referenceId === b.referenceId && a.clearance === b.clearance && a.scaleMode === b.scaleMode && a.topOffset === b.topOffset && a.floorGap === b.floorGap;

/** Whether the model has changed since its version (the server checks the files too when it saves). */
export function changedSince(model: PotModel, v: ModelVersion | undefined): boolean {
  if (!v) return false;
  if (!transformsEqual(model.transform, v.transform) || !sameFit(model.fit, v.fit) || model.triangleCount !== v.triangleCount) return true;
  return !!model.design && !!v.design && model.design.builtAt !== v.design.state.builtAt;
}

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function VersionsMenu({ model, versions, lockedBy, onCheckout, onSave, onRename }: {
  model: PotModel;
  versions: ModelVersion[];
  /** Why the model can't change now (Claude is working on it), or null. */
  lockedBy: string | null;
  onCheckout(v: ModelVersion): Promise<void>;
  onSave(): Promise<void>;
  onRename(v: ModelVersion, label: string): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const head = versions.find((v) => v.id === model.versionId);
  const dirty = changedSince(model, head);

  const children = useMemo(() => {
    const map = new Map<string | null, ModelVersion[]>();
    const ids = new Set(versions.map((v) => v.id));
    for (const v of versions) {
      const parent = v.parentId && ids.has(v.parentId) ? v.parentId : null;
      map.set(parent, [...(map.get(parent) ?? []), v]);
    }
    return map;
  }, [versions]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    box.current?.querySelector('.version-row.current')?.scrollIntoView({ block: 'nearest' });
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, editing]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const row = (v: ModelVersion) => {
    const current = v.id === model.versionId;
    return (
      <div key={v.id} className={`version-row ${current ? 'current' : ''}`}>
        <span className="version-dot" title={KIND_TITLE[v.kind]}>{KIND_ICON[v.kind]}</span>
        <span className="version-number">v{v.number}</span>
        {editing === v.id ? (
          <form
            className="version-rename"
            onSubmit={(e) => {
              e.preventDefault();
              const label = String(new FormData(e.currentTarget).get('label') ?? '').trim();
              setEditing(null);
              if (label && label !== v.label) void run(v.id, () => onRename(v, label));
            }}
          >
            <input name="label" defaultValue={v.label} maxLength={80} autoFocus onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
          </form>
        ) : (
          <span className="version-label" title={`${v.label}\n${KIND_TITLE[v.kind]} · ${new Date(v.createdAt).toLocaleString()}`} onDoubleClick={() => setEditing(v.id)}>
            {v.label}
          </span>
        )}
        <span className="version-time muted">{when(v.createdAt)}</span>
        {current && !dirty ? (
          <span className="pill ok">current</span>
        ) : (
          <button className="small" disabled={!!busy || !!lockedBy} title={lockedBy ?? (current ? 'Go back to this version as it was; your edits since are kept as a version' : 'Go back to this version; your next change starts a new branch from it')} onClick={() => run(v.id, () => onCheckout(v))}>
            {busy === v.id ? <span className="spinner" /> : current ? 'Back to it' : 'Go to'}
          </button>
        )}
        <button className="icon small" title="Rename" onClick={() => setEditing(v.id)}>
          ✎
        </button>
      </div>
    );
  };

  /** A run of versions with one child each, then its branches, each indented under the fork. */
  const line = (first: ModelVersion): ReactNode => {
    const chain: ModelVersion[] = [first];
    let kids = children.get(first.id) ?? [];
    while (kids.length === 1) {
      chain.push(kids[0]);
      kids = children.get(kids[0].id) ?? [];
    }
    return (
      <>
        {chain.map((v) => (
          <div key={v.id}>
            {row(v)}
            {v.id === model.versionId && dirty && (
              <div className="version-row unsaved">
                <span className="version-dot">✋</span>
                <span className="version-label">Unsaved changes</span>
                <button className="small" disabled={!!busy || !!lockedBy} title={lockedBy ?? 'Keep the model as it is now as a version'} onClick={() => run('save', onSave)}>
                  {busy === 'save' ? <span className="spinner" /> : 'Save'}
                </button>
              </div>
            )}
          </div>
        ))}
        {kids.length > 1 && (
          <div className="version-forks">
            {kids.map((k) => (
              <div key={k.id} className="version-branch">
                {line(k)}
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="versions" ref={box}>
      <button className={`small version-switch ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Versions of this model">
        ⑂ {head ? `v${head.number}` : 'Versions'}
        {dirty && <span className="version-dirty" title="Changed since this version">•</span>}
      </button>
      {open && (
        <div className="versions-pop" role="dialog" aria-label="Versions">
          <div className="versions-head">
            <strong>Versions</strong>
            <span className="muted small">{versions.length}</span>
          </div>
          <p className="muted small">
            Each change Claude applies is a version. Go back to any of them and carry on: your next change starts a new branch, and the others stay here. Your
            unsaved edits are kept as a version when you switch.
          </p>
          {lockedBy && <p className="callout warn small">{lockedBy}</p>}
          <div className="version-tree">{(children.get(null) ?? []).map((v) => <div key={v.id}>{line(v)}</div>)}</div>
        </div>
      )}
    </div>
  );
}
