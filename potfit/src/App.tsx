import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { cloneTransform, transformsEqual } from '../shared/transform.ts';
import type { CodexEvent, CodexRun, FitMetrics, FitSettings, ParamValues, PotModel, PotTransform, ReferencePot, ServerStatus } from '../shared/types.ts';
import { api, type ModelPatchBody } from './api.ts';
import { CodexPanel } from './components/CodexPanel.tsx';
import { DesignDialog } from './components/DesignDialog.tsx';
import { DesignPanel } from './components/DesignPanel.tsx';
import { FitPanel } from './components/FitPanel.tsx';
import type { PickedImage } from './components/ImagePicker.tsx';
import { ImportDialog, type PendingImport } from './components/ImportDialog.tsx';
import { ModelList } from './components/ModelList.tsx';
import { ReferencePanel } from './components/ReferencePanel.tsx';
import { ReviewPanel } from './components/ReviewPanel.tsx';
import type { LogEntry } from './components/RunLog.tsx';
import { GeometryClient } from './geometry.ts';
import { importFile, type ImportedPart } from './viewer/importers.ts';
import { PotViewer, type GizmoMode, type ScaleLock } from './viewer/PotViewer.ts';

const LAST_MODEL_KEY = 'potfit.model';

/** On a phone one sidebar shows under the views, or neither (`view`). */
type MobileTab = 'models' | 'view' | 'model';

function addToLog(entries: LogEntry[], e: CodexEvent): LogEntry[] {
  if (e.type === 'item') {
    const i = entries.findIndex((x) => x.kind === 'item' && x.item.id === e.item.id);
    if (i >= 0) {
      const next = entries.slice();
      next[i] = { kind: 'item', item: e.item };
      return next;
    }
    return [...entries, { kind: 'item', item: e.item }];
  }
  if (e.type === 'log') return [...entries, { kind: 'log', level: e.level, text: e.text }];
  if (e.type === 'status' && e.status === 'error' && e.error) return [...entries, { kind: 'log', level: 'error', text: e.error }];
  return entries;
}

export function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [references, setReferences] = useState<ReferencePot[]>([]);
  const [models, setModels] = useState<PotModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(LAST_MODEL_KEY));
  const [model, setModel] = useState<PotModel | null>(null);
  const [positions, setPositions] = useState<Float32Array | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<FitMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [runs, setRuns] = useState<CodexRun[]>([]);
  const [activeRun, setActiveRun] = useState<CodexRun | null>(null);
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});
  const [instructionsDraft, setInstructionsDraft] = useState('');
  const [feedbackDraft, setFeedbackDraft] = useState('');
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [designing, setDesigning] = useState(false);
  const [building, setBuilding] = useState(false);
  const [gizmo, setGizmo] = useState<GizmoMode>('translate');
  const [scaleLock, setScaleLock] = useState<ScaleLock>('uniform');
  const [sectionAngle, setSectionAngle] = useState(0);
  const [cutaway, setCutaway] = useState(false);
  const [tab, setTab] = useState<MobileTab>(() => (localStorage.getItem(LAST_MODEL_KEY) ? 'model' : 'models'));
  // Narrow screens show one view at a time; the other stays laid out so Codex screenshots still work.
  const [shownView, setShownView] = useState<'main' | 'section'>('main');
  // Undo history lives in a ref (it is only read in event handlers); bump re-renders the buttons.
  const history = useRef<{ past: PotTransform[]; future: PotTransform[] }>({ past: [], future: [] });
  const [, bumpHistory] = useReducer((n: number) => n + 1, 0);

  const geometry = useMemo(() => new GeometryClient(), []);
  const mainEl = useRef<HTMLDivElement>(null);
  const sectionEl = useRef<HTMLDivElement>(null);
  const viewer = useRef<PotViewer | null>(null);
  const modelRef = useRef<PotModel | null>(null);
  modelRef.current = model;
  const dragStart = useRef<PotTransform | null>(null);
  const pendingSave = useRef<{ id: string; patch: ModelPatchBody; timer: number } | null>(null);
  const meshReady = useRef<Promise<unknown>>(Promise.resolve());
  const frameOnLoad = useRef(false);
  const unsubscribe = useRef<(() => void) | null>(null);

  const reference = references.find((r) => r.id === model?.fit.referenceId) ?? null;
  // One Codex run per model at a time. Reviews work on a copy of the fit, so
  // only fitting runs pause manual edits.
  const fitRuns = runs.filter((r) => r.kind !== 'review');
  const reviewRuns = runs.filter((r) => r.kind === 'review');
  const fitActive = activeRun && activeRun.kind !== 'review' ? activeRun : null;
  const reviewActive = activeRun && activeRun.kind === 'review' ? activeRun : null;
  const locked = !!fitActive || building;

  const fail = (e: unknown) => setError((e as Error).message ?? String(e));

  // ------------------------------------------------------------ saving

  const flushSave = useCallback(async () => {
    const p = pendingSave.current;
    if (!p) return;
    pendingSave.current = null;
    clearTimeout(p.timer);
    try {
      const saved = await api.patchModel(p.id, p.patch);
      setModels((ms) => ms.map((m) => (m.id === saved.id ? saved : m)));
    } catch (e) {
      fail(e);
    }
  }, []);

  const scheduleSave = useCallback(
    (id: string, patch: ModelPatchBody) => {
      const p = pendingSave.current;
      if (p && p.id !== id) void flushSave();
      const merged = pendingSave.current ? { ...pendingSave.current.patch, ...patch, fit: { ...pendingSave.current.patch.fit, ...patch.fit } } : patch;
      if (pendingSave.current) clearTimeout(pendingSave.current.timer);
      pendingSave.current = { id, patch: merged, timer: window.setTimeout(() => void flushSave(), 500) };
    },
    [flushSave],
  );

  // ------------------------------------------------------------ transforms

  /** Apply a transform; `record` is the transform to return to on undo. */
  const setTransform = useCallback(
    (t: PotTransform, opts: { record?: PotTransform | null; save?: boolean } = {}) => {
      const m = modelRef.current;
      if (!m) return;
      if (opts.record && !transformsEqual(opts.record, t)) {
        history.current = { past: [...history.current.past.slice(-99), cloneTransform(opts.record)], future: [] };
        bumpHistory();
      }
      setModel({ ...m, transform: t });
      if (opts.save !== false) scheduleSave(m.id, { transform: t });
    },
    [scheduleSave],
  );

  const editTransform = useCallback((t: PotTransform) => setTransform(t, { record: modelRef.current?.transform }), [setTransform]);

  const step = useCallback(
    (from: 'past' | 'future') => {
      const m = modelRef.current;
      const h = history.current;
      const target = h[from].at(-1);
      if (!m || locked || !target) return;
      const current = cloneTransform(m.transform);
      history.current =
        from === 'past'
          ? { past: h.past.slice(0, -1), future: [...h.future, current] }
          : { past: [...h.past, current], future: h.future.slice(0, -1) };
      bumpHistory();
      setTransform(target);
    },
    [locked, setTransform],
  );
  const undo = useCallback(() => step('past'), [step]);
  const redo = useCallback(() => step('future'), [step]);

  const updateFit = (patch: Partial<FitSettings>) => {
    if (!model) return;
    setModel({ ...model, fit: { ...model.fit, ...patch } });
    scheduleSave(model.id, { fit: patch });
  };

  // ------------------------------------------------------------ viewer

  useEffect(() => {
    const v = new PotViewer(mainEl.current!, sectionEl.current!, {
      onTransform(t, phase) {
        if (phase === 'start') dragStart.current = modelRef.current ? cloneTransform(modelRef.current.transform) : null;
        else if (phase === 'drag') setTransform(t, { save: false });
        else {
          setTransform(t, { record: dragStart.current });
          dragStart.current = null;
        }
      },
    });
    viewer.current = v;
    // Handy for poking at the scene from the console and for browser tests.
    if (import.meta.env.DEV) (window as unknown as { potfitViewer: PotViewer }).potfitViewer = v;
    return () => {
      v.dispose();
      viewer.current = null;
    };
  }, [setTransform]);

  useEffect(() => viewer.current?.setGizmoMode(gizmo), [gizmo]);
  useEffect(() => viewer.current?.setScaleLock(scaleLock), [scaleLock]);
  useEffect(() => viewer.current?.setSectionAngle(sectionAngle), [sectionAngle]);
  useEffect(() => viewer.current?.setCutaway(cutaway), [cutaway]);
  useEffect(() => viewer.current?.setEditable(!locked), [locked]);
  useEffect(() => viewer.current?.setTransform(model?.transform ?? null), [model?.transform]);
  useEffect(() => {
    viewer.current?.setReference(reference, model?.fit.clearance ?? 0);
  }, [reference, model?.fit.clearance]);
  // Frame a newly loaded model once its reference pot is in the scene too.
  useEffect(() => {
    if (positions && frameOnLoad.current) {
      frameOnLoad.current = false;
      viewer.current?.frameAll();
    }
  }, [positions, reference]);

  // ------------------------------------------------------------ loading

  useEffect(() => {
    api.status().then(setStatus).catch(fail);
    api.references().then(setReferences).catch(fail);
    api.models().then(setModels).catch(fail);
    return () => geometry.dispose();
  }, [geometry]);

  /** Show a rebuilt model: its new mesh and placement. Undo history is for the old mesh, so it goes. */
  const showRebuilt = useCallback(
    async (m: PotModel) => {
      setModels((ms) => ms.map((x) => (x.id === m.id ? m : x)));
      if (modelRef.current?.id !== m.id) return;
      const res = await fetch(api.meshUrl(m.id));
      if (!res.ok) throw new Error(`Could not load the mesh (${res.status})`);
      const pos = parseSTL(await res.arrayBuffer());
      if (modelRef.current?.id !== m.id) return;
      meshReady.current = geometry.load(pos);
      setModel(m);
      setPositions(pos);
      viewer.current?.setMesh(pos);
      viewer.current?.setTransform(m.transform);
      history.current = { past: [], future: [] };
      bumpHistory();
    },
    [geometry],
  );

  const subscribe = useCallback((modelId: string, run: CodexRun) => {
    unsubscribe.current?.();
    setLogs((l) => ({ ...l, [run.id]: [] }));
    unsubscribe.current = api.runEvents(
      modelId,
      run.id,
      (e) => {
        setLogs((l) => ({ ...l, [run.id]: addToLog(l[run.id] ?? [], e) }));
        if (e.type === 'result') {
          const finished = e.run;
          setActiveRun(null);
          setRuns((rs) => [...rs.filter((r) => r.id !== finished.id), finished]);
          // Reviews never change the model, and the user may have been editing
          // it during the review (possibly with a save still pending), so the
          // server's copy must not overwrite what's on screen.
          if (finished.kind === 'review') return;
          // A design run rebuilt the mesh (or recorded why it couldn't).
          if (finished.kind === 'design' || finished.kind === 'design-feedback') {
            api
              .model(modelId)
              .then(({ model: m }) => showRebuilt(m))
              .catch(fail);
            return;
          }
          if (finished.status === 'done' && finished.result && modelRef.current?.id === modelId) {
            setTransform(finished.result.transform, { record: finished.transformBefore, save: false });
          }
          api.model(modelId).then(({ model: m }) => {
            if (modelRef.current?.id === m.id) setModel((cur) => (cur ? { ...cur, codexThreadId: m.codexThreadId, transform: m.transform, fit: m.fit } : m));
            setModels((ms) => ms.map((x) => (x.id === m.id ? m : x)));
          });
        }
      },
      () => undefined,
    );
  }, [setTransform, showRebuilt]);

  useEffect(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    setModel(null);
    setPositions(null);
    setMetrics(null);
    setRuns([]);
    setActiveRun(null);
    setInstructionsDraft('');
    setFeedbackDraft('');
    history.current = { past: [], future: [] };
    bumpHistory();
    viewer.current?.setMesh(null);
    if (!selectedId) return;
    localStorage.setItem(LAST_MODEL_KEY, selectedId);
    let cancelled = false;
    (async () => {
      try {
        setBusy('Loading model…');
        const [{ model: m, activeRun: active }, buf, rs] = await Promise.all([
          api.model(selectedId),
          fetch(api.meshUrl(selectedId)).then((r) => {
            if (!r.ok) throw new Error(`Could not load the mesh (${r.status})`);
            return r.arrayBuffer();
          }),
          api.runs(selectedId),
        ]);
        if (cancelled) return;
        const pos = parseSTL(buf);
        meshReady.current = geometry.load(pos);
        setModel(m);
        setPositions(pos);
        setRuns(rs.filter((r) => r.id !== active?.id));
        viewer.current?.setMesh(pos);
        viewer.current?.setTransform(m.transform);
        frameOnLoad.current = true;
        if (active) {
          setActiveRun(active);
          subscribe(m.id, active);
        }
      } catch (e) {
        if (!cancelled) {
          fail(e);
          if (String((e as Error).message).includes('not found')) {
            localStorage.removeItem(LAST_MODEL_KEY);
            setSelectedId(null);
          }
        }
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, geometry, subscribe]);

  // Without a model the phone's fit tab is empty; show the list instead.
  useEffect(() => {
    if (!selectedId) setTab((t) => (t === 'model' ? 'models' : t));
  }, [selectedId]);

  // Live measurements, computed in the worker.
  useEffect(() => {
    if (!model || !positions || !reference) {
      setMetrics(null);
      return;
    }
    let stale = false;
    const t = model.transform, fit = model.fit;
    const timer = setTimeout(async () => {
      try {
        await meshReady.current;
        const m = await geometry.check(t, reference, fit);
        if (!stale) {
          setMetrics(m);
          setMetricsError(null);
        }
      } catch (e) {
        if (!stale) setMetricsError((e as Error).message);
      }
    }, 60);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [model?.transform, model?.fit, positions, reference, geometry]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'w' || e.key === 'g') setGizmo('translate');
        else if (e.key === 'e' || e.key === 's') setGizmo('scale');
        else if (e.key === 'q' || e.key === 'Escape') setGizmo('off');
        else if (e.key === 'f') viewer.current?.frameAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Save before the tab goes away.
  useEffect(() => {
    const onHide = () => void flushSave();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [flushSave]);

  // ------------------------------------------------------------ actions

  const importParts = async (file: File, parts: ImportedPart[], combine: boolean) => {
    setPendingImport(null);
    const base = file.name.replace(/\.[^.]+$/, '');
    const uploads = combine ? [{ name: base, positions: concatParts(parts) }] : parts;
    let last: PotModel | null = null;
    for (const [i, p] of uploads.entries()) {
      setBusy(`Uploading ${p.name} (${i + 1}/${uploads.length})…`);
      last = await api.uploadModel(p.name, file.name, writeBinarySTL(p.positions, p.name));
    }
    setModels(await api.models());
    if (last) {
      setSelectedId(last.id);
      setTab('model');
    }
  };

  const onFiles = async (files: File[]) => {
    await flushSave();
    try {
      for (const file of files) {
        setBusy(`Reading ${file.name}…`);
        const parts = await importFile(file);
        if (parts.length === 0) throw new Error(`${file.name} has no meshes`);
        if (parts.length > 1) {
          setBusy(null);
          setPendingImport({ file, parts });
          return;
        }
        await importParts(file, parts, false);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const quickFit = async () => {
    if (!model || !reference) return;
    try {
      setBusy('Fitting…');
      await meshReady.current;
      const r = await geometry.solve(reference, {
        up: model.transform.up,
        spin: model.transform.spin,
        mode: model.fit.scaleMode,
        clearance: model.fit.clearance,
        topOffset: model.fit.topOffset,
        floorGap: model.fit.floorGap,
      });
      editTransform(r.transform);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const detectOrientation = async () => {
    try {
      await meshReady.current;
      const { initial } = await geometry.analyze();
      editTransform(initial);
    } catch (e) {
      fail(e);
    }
  };

  const startCodex = async (mode: CodexRun['kind'], message: string, attachments: PickedImage[] = []) => {
    if (!model || !viewer.current) return;
    await flushSave();
    const shots = viewer.current.capture();
    const run = await api.startRun(model.id, {
      mode,
      message,
      images: [
        { name: 'section', dataUrl: shots.section },
        { name: 'view', dataUrl: shots.view },
      ],
      attachments: attachments.map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
    });
    if (run.status === 'running') {
      setActiveRun(run);
      subscribe(model.id, run);
    } else {
      setRuns((rs) => [...rs, run]);
      if (run.error) throw new Error(run.error);
    }
  };

  /** Rebuild the design (new values, a new script, or the current fit settings). Throws on failure. */
  const buildDesign = async (body: { params?: ParamValues; script?: string }) => {
    const m = modelRef.current;
    if (!m) return;
    setBuilding(true);
    try {
      // The server builds for the fit settings it has.
      await flushSave();
      await showRebuilt(await api.buildDesign(m.id, body));
    } catch (e) {
      // A failed rebuild is recorded on the model; show that too.
      api
        .model(m.id)
        .then(({ model: fresh }) => {
          if (modelRef.current?.id === fresh.id) setModel((cur) => (cur ? { ...cur, design: fresh.design } : cur));
        })
        .catch(() => undefined);
      throw e;
    } finally {
      setBuilding(false);
    }
  };

  const revertRun = async (run: CodexRun) => {
    if (!model) return;
    if (run.kind === 'design' || run.kind === 'design-feedback') {
      setBuilding(true);
      try {
        await showRebuilt(await api.revertDesign(model.id, run.id));
      } catch (e) {
        fail(e);
      } finally {
        setBuilding(false);
      }
      return;
    }
    editTransform(run.transformBefore);
    if (run.fitBefore) {
      const { referenceId: _ref, ...goals } = run.fitBefore;
      updateFit(goals);
    }
  };

  const rateRun = async (run: CodexRun, rating: CodexRun['rating']) => {
    try {
      const saved = await api.rateRun(run.modelId, run.id, rating);
      setRuns((rs) => rs.map((r) => (r.id === saved.id ? saved : r)));
    } catch (e) {
      fail(e);
    }
  };

  const loadLog = (run: CodexRun) => {
    setLogs((l) => ({ ...l, [run.id]: [] }));
    api.runEvents(
      run.modelId,
      run.id,
      (e) => setLogs((l) => ({ ...l, [run.id]: addToLog(l[run.id] ?? [], e) })),
      () => undefined,
    );
  };

  const codexPanel = model && (
    <CodexPanel
      status={status}
      model={model}
      hasReference={!!reference}
      activeRun={fitActive}
      reviewRunning={!!reviewActive}
      runs={fitRuns}
      logs={logs}
      instructions={instructionsDraft}
      feedback={feedbackDraft}
      onInstructions={setInstructionsDraft}
      onFeedback={setFeedbackDraft}
      onStart={startCodex}
      onCancel={() => api.cancelRun(model.id).catch(fail)}
      onRate={rateRun}
      onRevert={revertRun}
      onLoadLog={loadLog}
      onNewSession={async () => {
        try {
          const saved = await api.patchModel(model.id, { resetCodex: true });
          setModel({ ...model, codexThreadId: saved.codexThreadId, design: saved.design });
        } catch (e) {
          fail(e);
        }
      }}
    />
  );

  return (
    <div className={`app tab-${tab}`}>
      <aside className="sidebar left">
        <div className="brand">
          <h1>Potfit</h1>
          <span className="muted">scale pots to the pot inside</span>
        </div>
        <ModelList
          models={models}
          selectedId={selectedId}
          busy={busy}
          onSelect={async (id) => {
            await flushSave();
            setSelectedId(id);
            setTab('model');
          }}
          onFiles={onFiles}
          onNewDesign={() => setDesigning(true)}
          onRename={async (id, name) => {
            try {
              const saved = await api.patchModel(id, { name });
              setModels((ms) => ms.map((m) => (m.id === id ? saved : m)));
              if (model?.id === id) setModel({ ...model, name });
            } catch (e) {
              fail(e);
            }
          }}
          onDelete={async (id) => {
            try {
              await api.deleteModel(id);
              setModels((ms) => ms.filter((m) => m.id !== id));
              if (selectedId === id) {
                localStorage.removeItem(LAST_MODEL_KEY);
                setSelectedId(null);
              }
            } catch (e) {
              fail(e);
            }
          }}
        />
        <ReferencePanel
          references={references}
          activeId={model?.fit.referenceId ?? null}
          onUse={(id) => updateFit({ referenceId: id })}
          onCreate={async (input) => {
            const ref = await api.createReference(input);
            setReferences((rs) => [...rs, ref]);
            if (model && !model.fit.referenceId) updateFit({ referenceId: ref.id });
          }}
          onUpdate={async (id, input) => {
            const ref = await api.updateReference(id, input);
            setReferences((rs) => rs.map((r) => (r.id === id ? ref : r)));
          }}
          onDelete={async (id) => {
            await api.deleteReference(id);
            setReferences((rs) => rs.filter((r) => r.id !== id));
          }}
        />
      </aside>

      <main className="stage">
        <div className="toolbar">
          <div className="segmented" title="Gizmo (W move, E scale, Q off)">
            {(['translate', 'scale', 'off'] as const).map((m) => (
              <button key={m} className={gizmo === m ? 'on' : ''} onClick={() => setGizmo(m)} disabled={locked && m !== 'off'}>
                {m === 'translate' ? 'Move' : m === 'scale' ? 'Scale' : 'View only'}
              </button>
            ))}
          </div>
          <label className="inline">
            <input type="checkbox" checked={cutaway} onChange={(e) => setCutaway(e.target.checked)} /> Cut 3D view
          </label>
          <label className="inline">
            Section angle
            <input type="range" min={0} max={180} step={5} value={sectionAngle} onChange={(e) => setSectionAngle(Number(e.target.value))} />
            <span className="muted">{sectionAngle}°</span>
          </label>
          <button className="small" onClick={() => viewer.current?.frameAll()} title="Frame (F)">
            Frame
          </button>
          {error && (
            <div className="toast" onClick={() => setError(null)}>
              {error} <span className="muted">(click to dismiss)</span>
            </div>
          )}
        </div>
        <div className={`views show-${shownView}`}>
          <div className="view main">
            <div className="view-label">3D</div>
            <div className="canvas-host" ref={mainEl} />
          </div>
          <div className="view section">
            <div className="view-label">Section {sectionAngle ? `(${sectionAngle}°)` : '(side on)'}</div>
            <div className="canvas-host" ref={sectionEl} />
            <div className="legend">
              <span className="sw cut" /> cut wall <span className="sw ref" /> reference pot <span className="sw env" /> required clearance
            </div>
          </div>
          <div className="segmented view-switch">
            <button className={shownView === 'main' ? 'on' : ''} onClick={() => setShownView('main')}>
              3D
            </button>
            <button className={shownView === 'section' ? 'on' : ''} onClick={() => setShownView('section')}>
              Section
            </button>
          </div>
          {!model && !busy && <div className="empty">Import a pot model, design a new one, or pick one from the list.</div>}
        </div>
      </main>

      <aside className="sidebar right">
        {model ? (
          <>
            {model.design && (
              <DesignPanel key={model.id} model={model} references={references} lockedBy={activeRun?.kind ?? null} building={building} onBuild={buildDesign} />
            )}
            {model.design && codexPanel}
            <FitPanel
              model={model}
              references={references}
              metrics={metrics}
              metricsError={metricsError}
              locked={locked}
              busy={busy}
              scaleLock={scaleLock}
              canUndo={history.current.past.length > 0}
              canRedo={history.current.future.length > 0}
              onScaleLock={setScaleLock}
              onFit={updateFit}
              onTransform={editTransform}
              onQuickFit={quickFit}
              onDetectOrientation={detectOrientation}
              onUndo={undo}
              onRedo={redo}
              exportUrl={api.exportUrl(model.id)}
            />
            {!model.design && codexPanel}
            <ReviewPanel
              status={status}
              model={model}
              hasReference={!!reference}
              activeRun={reviewActive}
              fitRunning={!!fitActive}
              reviews={reviewRuns}
              logs={logs}
              onStart={() => startCodex('review', '')}
              onCancel={() => api.cancelRun(model.id).catch(fail)}
              onLoadLog={loadLog}
              onUseFeedback={(text) => {
                // Feedback continues the fitting (or design) conversation;
                // without one, it becomes the instructions for a new session.
                if (model.design ? model.design.threadId : model.codexThreadId) setFeedbackDraft(text);
                else setInstructionsDraft(text);
                document.querySelector('.panel.codex')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
          </>
        ) : (
          <section className="panel">
            <p className="hint">Select a model to fit it.</p>
          </section>
        )}
      </aside>

      <nav className="mobile-tabs">
        <button className={tab === 'models' ? 'on' : ''} onClick={() => setTab('models')}>
          Models
        </button>
        <button className={tab === 'view' ? 'on' : ''} onClick={() => setTab('view')}>
          View
        </button>
        <button className={tab === 'model' ? 'on' : ''} onClick={() => setTab('model')}>
          {model?.design ? 'Design' : 'Fit'}
          {activeRun && <span className="spinner" title="Codex is working" />}
        </button>
      </nav>

      {designing && (
        <DesignDialog
          references={references}
          referenceId={model?.fit.referenceId ?? null}
          codexAvailable={status?.codex.available ?? false}
          onCancel={() => setDesigning(false)}
          onCreated={async (m) => {
            setDesigning(false);
            await flushSave();
            setModels(await api.models().catch(() => [m]));
            // Loading the model picks up the design run and streams it.
            setSelectedId(m.id);
            setTab('model');
          }}
        />
      )}
      {pendingImport && (
        <ImportDialog
          pending={pendingImport}
          onCancel={() => setPendingImport(null)}
          onImport={(parts, combine) => importParts(pendingImport.file, parts, combine).catch(fail).finally(() => setBusy(null))}
        />
      )}
    </div>
  );
}

function concatParts(parts: ImportedPart[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p.positions, offset);
    offset += p.positions.length;
  }
  return out;
}
