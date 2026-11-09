import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AGENT_EFFORTS } from '../shared/types.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { cloneTransform, transformsEqual } from '../shared/transform.ts';
import type { AgentSettings, Checkpoint, FitMetrics, FitSettings, LiveEvent, ParamValues, PotModel, PotTransform, ReferencePot, Review, ScreenshotReview, ServerStatus, ThreadState } from '../shared/types.ts';
import { AgentDock } from './agent/AgentDock.tsx';
import { PotAgentContext, imageAttachment, type PotAgent } from './agent/context.ts';
import { api, type ModelPatchBody } from './api.ts';
import { DesignDialog } from './components/DesignDialog.tsx';
import type { PickedImage } from './components/ImagePicker.tsx';
import { ImportDialog, type PendingImport } from './components/ImportDialog.tsx';
import { GeometryClient } from './geometry.ts';
import { Hud } from './steps/Hud.tsx';
import { STEPS, Stepper, type StepId, type StepState } from './steps/Stepper.tsx';
import { ExportStep, FitStep, ModelStep, PotStep, ReviewStep } from './steps/Steps.tsx';
import { importFile, type ImportedPart } from './viewer/importers.ts';
import { PotViewer, type GizmoMode, type ScaleLock } from './viewer/PotViewer.ts';

const LAST_MODEL_KEY = 'potfit.model';
const SETTINGS_KEY = 'potfit.agentSettings';

/** On a phone one of the side panels shows under the views, or neither (`view`). */
type MobileTab = 'steps' | 'view' | 'agent';
type ViewMode = 'split' | '3d' | 'section';

const prefersLight = () => matchMedia('(prefers-color-scheme: light)').matches;

export function App() {
  const [settings, setSettings] = useState<AgentSettings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
      return { model: typeof saved?.model === 'string' ? saved.model : null, effort: AGENT_EFFORTS.includes(saved?.effort) ? saved.effort : null };
    } catch {
      return {};
    }
  });
  const changeSettings = useCallback((next: AgentSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Settings still work if browser storage is unavailable.
    }
  }, []);
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
  const [threads, setThreads] = useState<Record<string, ThreadState>>({});
  const [checkpoints, setCheckpoints] = useState<Record<string, Checkpoint>>({});
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loop, setLoop] = useState<ScreenshotReview | null>(null);
  const [startingLoop, setStartingLoop] = useState(false);
  const [dockThread, setDockThread] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [designing, setDesigning] = useState(false);
  const [building, setBuilding] = useState(false);
  const [gizmo, setGizmo] = useState<GizmoMode>('translate');
  const [scaleLock, setScaleLock] = useState<ScaleLock>('uniform');
  const [sectionAngle, setSectionAngle] = useState(0);
  const [cutaway, setCutaway] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem('potfit.viewMode') as ViewMode) || 'split');
  const [step, setStep] = useState<StepId>('model');
  const [tab, setTab] = useState<MobileTab>('steps');
  const [light, setLight] = useState(prefersLight);
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

  const reference = references.find((r) => r.id === model?.fit.referenceId) ?? null;
  const mainThread = model?.threadId ? threads[model.threadId] : undefined;
  const agentBusy = !!mainThread && (mainThread.status === 'running' || mainThread.status === 'waiting');
  const loopRunning = loop?.status === 'running';
  const locked = agentBusy || building || loopRunning || startingLoop;
  const lockReason = loopRunning || startingLoop ? 'The screenshot review is driving the agent; cancel it to take over.' : null;
  const agentAvailable = status?.claude.available ?? false;

  const fail = (e: unknown) => setError((e as Error).message ?? String(e));

  // ------------------------------------------------------------ saving

  const saving = useRef<Promise<void>>(Promise.resolve());
  const flushSave = useCallback(async () => {
    const p = pendingSave.current;
    if (p) {
      pendingSave.current = null;
      clearTimeout(p.timer);
      saving.current = saving.current.catch(() => undefined).then(async () => {
        const saved = await api.patchModel(p.id, p.patch);
        setModels((ms) => ms.map((m) => (m.id === saved.id ? saved : m)));
      });
    }
    try {
      await saving.current;
      return true;
    } catch (e) {
      fail(e);
      return false;
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

  const stepHistory = useCallback(
    (from: 'past' | 'future') => {
      const m = modelRef.current;
      const h = history.current;
      const target = h[from].at(-1);
      if (!m || locked || !target) return;
      const current = cloneTransform(m.transform);
      history.current = from === 'past' ? { past: h.past.slice(0, -1), future: [...h.future, current] } : { past: [...h.past, current], future: h.future.slice(0, -1) };
      bumpHistory();
      setTransform(target);
    },
    [locked, setTransform],
  );
  const undo = useCallback(() => stepHistory('past'), [stepHistory]);
  const redo = useCallback(() => stepHistory('future'), [stepHistory]);

  const updateFit = (patch: Partial<FitSettings>) => {
    if (!model || locked) return;
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

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: light)');
    const on = () => setLight(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => viewer.current?.setTheme(light ? 'light' : 'dark'), [light]);
  useEffect(() => viewer.current?.setGizmoMode(gizmo), [gizmo]);
  useEffect(() => viewer.current?.setScaleLock(scaleLock), [scaleLock]);
  useEffect(() => viewer.current?.setSectionAngle(sectionAngle), [sectionAngle]);
  useEffect(() => viewer.current?.setCutaway(cutaway), [cutaway]);
  useEffect(() => viewer.current?.setEditable(!locked), [locked]);
  useEffect(() => viewer.current?.setTransform(model?.transform ?? null), [model?.transform]);
  useEffect(() => {
    viewer.current?.setReference(reference, model?.fit.clearance ?? 0);
  }, [reference, model?.fit.clearance]);
  useEffect(() => {
    localStorage.setItem('potfit.viewMode', viewMode);
  }, [viewMode]);
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

  /** What the server says changed on the open model (the agent applied something, a review ended...). */
  const onLive = useCallback(
    (e: LiveEvent) => {
      switch (e.type) {
        case 'model': {
          setModels((ms) => ms.map((x) => (x.id === e.model.id ? e.model : x)));
          const cur = modelRef.current;
          if (cur?.id !== e.model.id) return;
          if (e.meshChanged) {
            showRebuilt(e.model).catch(fail);
            return;
          }
          // The agent's change can be undone like a manual one.
          if (!transformsEqual(cur.transform, e.model.transform)) {
            history.current = { past: [...history.current.past.slice(-99), cloneTransform(cur.transform)], future: [] };
            bumpHistory();
          }
          setModel(e.model);
          return;
        }
        case 'thread':
          setThreads((ts) => ({ ...ts, [e.thread.id]: e.thread }));
          return;
        case 'checkpoint':
          setCheckpoints((cs) => ({ ...cs, [e.checkpoint.id]: e.checkpoint }));
          return;
        case 'review':
          setReviews((rs) => [...rs.filter((r) => r.id !== e.review.id), e.review].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
          return;
        case 'loop':
          setLoop(e.state);
          return;
      }
    },
    [showRebuilt],
  );

  useEffect(() => {
    modelRef.current = null;
    setModel(null);
    setPositions(null);
    setMetrics(null);
    setCheckpoints({});
    setReviews([]);
    setLoop(null);
    setDockThread(null);
    history.current = { past: [], future: [] };
    bumpHistory();
    viewer.current?.setMesh(null);
    if (!selectedId) {
      setStep('model');
      return;
    }
    localStorage.setItem(LAST_MODEL_KEY, selectedId);
    let cancelled = false;
    const off = api.live(selectedId, (e) => {
      if (!cancelled) onLive(e);
    });
    (async () => {
      try {
        setBusy('Loading model…');
        const [{ model: m, threads: ts }, buf, cps, rvs, lp] = await Promise.all([
          api.model(selectedId),
          fetch(api.meshUrl(selectedId)).then((r) => {
            if (!r.ok) throw new Error(`Could not load the mesh (${r.status})`);
            return r.arrayBuffer();
          }),
          api.checkpoints(selectedId),
          api.reviews(selectedId),
          api.screenshotReview(selectedId),
        ]);
        if (cancelled) return;
        const pos = parseSTL(buf);
        meshReady.current = geometry.load(pos);
        setModel(m);
        setPositions(pos);
        setThreads((all) => ({ ...all, ...Object.fromEntries(ts.map((t) => [t.id, t])) }));
        setCheckpoints(Object.fromEntries(cps.map((c) => [c.id, c])));
        setReviews(rvs);
        setLoop(lp);
        setStep(!m.fit.referenceId ? 'pot' : m.design ? 'model' : 'fit');
        viewer.current?.setMesh(pos);
        viewer.current?.setTransform(m.transform);
        frameOnLoad.current = true;
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
      off();
    };
  }, [selectedId, geometry, onLive]);

  // Every model gets its agent thread when it's opened (no process runs until a message is sent).
  const modelId = model?.id;
  const hasThread = !!model?.threadId;
  useEffect(() => {
    if (!modelId || hasThread || !agentAvailable) return;
    let stale = false;
    api
      .agent(modelId, settings)
      .then((t) => {
        if (stale || modelRef.current?.id !== modelId) return;
        setThreads((ts) => ({ ...ts, [t.id]: t }));
        setModel((m) => (m ? { ...m, threadId: t.id } : m));
      })
      .catch(fail);
    return () => {
      stale = true;
    };
  }, [modelId, hasThread, agentAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const selectModel = async (id: string) => {
    await flushSave();
    setSelectedId(id);
  };

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
    if (last) setSelectedId(last.id);
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

  /** Save pending edits, then screenshot both views for the agent. */
  const prepareSend = useCallback(async () => {
    if (!(await flushSave())) throw new Error("Couldn't save your edits, so nothing was sent.");
    return viewer.current?.capture() ?? null;
  }, [flushSave]);

  /** Fit with Claude: the model's thread gets a message with the views, and the dock shows it. */
  const startFit = async (instructions: string) => {
    const m = modelRef.current;
    if (!m) return;
    try {
      const thread = m.threadId ? { id: m.threadId } : await api.agent(m.id, settings);
      const shots = await prepareSend();
      const attachments = shots ? [await imageAttachment('view-3d.jpg', shots.view), await imageAttachment('view-section.jpg', shots.section)] : [];
      await api.command({ type: 'send', thread_id: thread.id, text: instructions.trim() || 'Fit the pot to the nursery pot.', attachments });
      setDockThread(null);
      setTab('agent');
    } catch (e) {
      fail(e);
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

  const startReview = async () => {
    const m = modelRef.current;
    if (!m) return;
    try {
      const shots = await prepareSend();
      const images = shots ? [{ name: 'view-section', dataUrl: shots.section }, { name: 'view-3d', dataUrl: shots.view }] : [];
      const review = await api.startReview(m.id, settings, images);
      setReviews((rs) => [...rs.filter((r) => r.id !== review.id), review]);
      setDockThread(review.threadId);
      setTab('agent');
    } catch (e) {
      fail(e);
    }
  };

  const startLoop = async (images: PickedImage[], prompt: string) => {
    const m = modelRef.current;
    if (!m) return;
    setStartingLoop(true);
    try {
      if (!(await flushSave())) throw new Error('Could not save model edits. Screenshot review was not started.');
      setLoop(await api.startScreenshotReview(m.id, images, settings, prompt));
    } finally {
      setStartingLoop(false);
    }
  };

  const openReview = (reviewId: string) => {
    const r = reviews.find((x) => x.id === reviewId);
    if (r) {
      setDockThread(r.threadId);
      setTab('agent');
    }
  };

  const agentContext: PotAgent | null = model && {
    model,
    status,
    settings,
    onSettings: changeSettings,
    checkpoints,
    onRevert: async (cp) => {
      // The model comes back over /live, mesh and all.
      const { checkpoint } = await api.revertCheckpoint(cp.modelId, cp.id);
      setCheckpoints((cs) => ({ ...cs, [checkpoint.id]: checkpoint }));
    },
    onRate: (cp, rating) => {
      api
        .rateCheckpoint(cp.modelId, cp.id, rating)
        .then((saved) => setCheckpoints((cs) => ({ ...cs, [saved.id]: saved })))
        .catch(fail);
    },
    onUseFeedback: (text) => {
      setDrafts((d) => ({ ...d, [model.id]: text }));
      setDockThread(null);
      setTab('agent');
    },
    draft: drafts[model.id] ?? '',
    setDraft: (text) => setDrafts((d) => ({ ...d, [model.id]: text })),
    prepareSend,
    lockedBy: lockReason,
    openThread: (id) => setDockThread(id === model.threadId ? null : id),
  };

  // ------------------------------------------------------------ steps

  const latestReview = reviews.filter((r) => !r.focus && r.result).at(-1);
  const reviewCurrent = !!latestReview && !!model && transformsEqual(latestReview.transform, model.transform);
  const stepStates: Record<StepId, StepState> = {
    pot: reference ? 'done' : 'todo',
    model: model ? 'done' : 'todo',
    fit: !metrics ? 'todo' : metrics.interferes ? 'bad' : metrics.clearanceOk ? 'done' : 'warn',
    review: !reviewCurrent ? 'todo' : latestReview!.result!.verdict === 'pass' ? 'done' : latestReview!.result!.verdict === 'fail' ? 'bad' : 'warn',
    export: 'todo',
  };

  const stepBody = (() => {
    switch (step) {
      case 'pot':
        return (
          <PotStep
            references={references}
            model={model}
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
            onNext={() => setStep(model ? 'fit' : 'model')}
          />
        );
      case 'model':
        return (
          <ModelStep
            model={model}
            models={models}
            references={references}
            busy={busy}
            lockedBy={agentBusy ? 'Claude is working on this design.' : loopRunning ? 'The screenshot review is running.' : null}
            building={building}
            onBuild={buildDesign}
            onSelect={(id) => void selectModel(id)}
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
        );
      case 'fit':
        return model ? (
          <FitStep
            model={model}
            reference={reference}
            metrics={metrics}
            locked={locked}
            busy={busy}
            agentAvailable={agentAvailable && !lockReason}
            agentBusy={agentBusy}
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
            onAgentFit={startFit}
            onOverhangs={(avoidOverhangs) => {
              setModel({ ...model, avoidOverhangs });
              scheduleSave(model.id, { avoidOverhangs });
            }}
          />
        ) : null;
      case 'review':
        return model ? (
          <ReviewStep
            model={model}
            reviews={reviews}
            loop={loop}
            settings={settings}
            onSettings={changeSettings}
            status={status}
            canReview={!!reference && agentAvailable}
            loopDisabled={!reference || !agentAvailable || agentBusy || building || startingLoop}
            onReview={startReview}
            onOpenReview={openReview}
            onStartLoop={startLoop}
            onCancelLoop={async () => {
              await api.cancelScreenshotReview(model.id);
            }}
          />
        ) : null;
      case 'export':
        return model ? <ExportStep model={model} references={references} metrics={metrics} metricsError={metricsError} exportUrl={api.exportUrl(model.id)} locked={locked} /> : null;
    }
  })();

  return (
    <div className={`app tab-${tab}`}>
      <header className="topbar">
        <div className="brand">
          <svg className="logo" viewBox="0 0 24 24" aria-hidden>
            <path d="M3 6h18l-2.4 14.2a1.5 1.5 0 0 1-1.5 1.3H6.9a1.5 1.5 0 0 1-1.5-1.3Z" fill="var(--accent)" />
            <path d="M2 4.5h20v3H2z" rx="1" fill="var(--accent-strong)" />
            <path d="M8 2.5c1.5 1.5 1 3-0.2 4M12 1.5c1.2 1.6 0.8 3.4 0 5M16 2.5c-1.5 1.5-1 3 0.2 4" stroke="var(--sage)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </svg>
          potfit
        </div>
        <button className="model-switch" onClick={() => { setStep('model'); setTab('steps'); }} title="Your models">
          <span className="model-name">{model?.name ?? (busy ? 'Loading…' : 'Choose a model')}</span>
          <span className="caret">▾</span>
        </button>
        <Stepper step={step} states={stepStates} enabled={(s) => s === 'pot' || s === 'model' || !!model} onStep={(s) => { setStep(s); setTab('steps'); }} />
        <div className="status" title={status ? `${status.claude.available ? status.claude.version : `Claude Code: ${status.claude.error}`}\n${status.blender.available ? status.blender.version : 'Blender not installed: no mesh edits or Blender parts'}` : ''}>
          <span className={`dot ${status?.claude.available ? 'ok' : status ? 'bad' : ''}`} /> Claude
          <span className={`dot ${status?.blender.available ? 'ok' : 'off'}`} /> Blender
        </div>
      </header>

      <aside className="steps-panel">
        <div className="step-title">
          <span className="step-number">{STEPS.findIndex((s) => s.id === step) + 1}</span>
          <h2>{STEPS.find((s) => s.id === step)!.title}</h2>
        </div>
        {stepBody}
      </aside>

      <main className="stage">
        <div className="viewer-toolbar">
          <div className="segmented" title="Gizmo (W move, E scale, Q off)">
            {(['translate', 'scale', 'off'] as const).map((m) => (
              <button key={m} className={gizmo === m ? 'on' : ''} onClick={() => setGizmo(m)} disabled={locked && m !== 'off'}>
                {m === 'translate' ? 'Move' : m === 'scale' ? 'Scale' : 'View'}
              </button>
            ))}
          </div>
          <div className="segmented view-modes">
            {(['split', '3d', 'section'] as const).map((m) => (
              <button key={m} className={viewMode === m ? 'on' : ''} onClick={() => setViewMode(m)}>
                {m === 'split' ? 'Split' : m === '3d' ? '3D' : 'Section'}
              </button>
            ))}
          </div>
          <label className="inline angle" title="Section plane angle">
            ∠
            <input type="range" min={0} max={180} step={5} value={sectionAngle} onChange={(e) => setSectionAngle(Number(e.target.value))} />
            <span className="muted">{sectionAngle}°</span>
          </label>
          <label className="inline" title="Cut the 3D view along the section plane">
            <input type="checkbox" checked={cutaway} onChange={(e) => setCutaway(e.target.checked)} /> Cut
          </label>
          <button className="small" onClick={() => viewer.current?.frameAll()} title="Frame (F)">
            Frame
          </button>
        </div>
        <div className={`views mode-${viewMode}`}>
          <div className="view main">
            <div className="view-label">3D</div>
            <div className="canvas-host" ref={mainEl} />
          </div>
          <div className="view section">
            <div className="view-label">Section · {sectionAngle ? `${sectionAngle}°` : 'side on'}</div>
            <div className="canvas-host" ref={sectionEl} />
            <div className="legend">
              <span className="sw cut" /> wall <span className="sw ref" /> nursery pot <span className="sw env" /> clearance
            </div>
          </div>
          {!model && !busy && (
            <div className="empty">
              <p>Import a pot model, design a new one, or pick one from your models.</p>
              <button className="primary" onClick={() => { setStep('model'); setTab('steps'); }}>Get started</button>
            </div>
          )}
        </div>
        {model && reference && <Hud metrics={metrics} fit={model.fit} />}
        {agentBusy && <div className="working-banner"><span className="spinner" /> Claude is working on the model; manual edits are paused.</div>}
        {error && (
          <div className="toast" role="alert" onClick={() => setError(null)}>
            {error} <span className="muted">(dismiss)</span>
          </div>
        )}
      </main>

      <aside className="dock-panel">
        {model && agentContext ? (
          <PotAgentContext.Provider value={agentContext}>
            <AgentDock
              model={model}
              threads={threads}
              reviews={reviews}
              selected={dockThread}
              onSelect={setDockThread}
              available={agentAvailable}
              onStartOver={() => api.newSession(model.id).catch(fail)}
            />
          </PotAgentContext.Provider>
        ) : (
          <div className="dock-empty">
            <h3>Claude</h3>
            <p>Open a model to fit, design or review it with Claude.</p>
          </div>
        )}
      </aside>

      <nav className="mobile-tabs">
        <button className={tab === 'steps' ? 'on' : ''} onClick={() => setTab('steps')}>
          Steps
        </button>
        <button className={tab === 'view' ? 'on' : ''} onClick={() => setTab('view')}>
          View
        </button>
        <button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}>
          Claude
          {agentBusy && <span className="spinner" title="Claude is working" />}
        </button>
      </nav>

      {designing && (
        <DesignDialog
          settings={settings}
          onSettings={changeSettings}
          status={status}
          references={references}
          referenceId={model?.fit.referenceId ?? null}
          agentAvailable={agentAvailable}
          onCancel={() => setDesigning(false)}
          onCreated={async (m) => {
            setDesigning(false);
            await flushSave();
            setModels(await api.models().catch(() => [m]));
            setSelectedId(m.id);
            setTab('agent');
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
