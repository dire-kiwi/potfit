// Where the user writes to the agent: agent-threads' Composer behaviour (a message starts a turn,
// or steers the running one; the stop button interrupts), plus what potfit adds: screenshots of the
// views, pictures, quick phrases, the user's comments on results, and the Claude model and effort for the thread.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCommand, useInterrupt, useSetOptions, useThreadState } from '@dire-kiwi/agent-threads-react';
import { feedbackWithComments } from '../../shared/comments.ts';
import type { AgentSettings } from '../../shared/types.ts';
import { ImagePicker, imageFiles, readImage, type PickedImage } from '../components/ImagePicker.tsx';
import { ACCEPTED_EXTENSIONS } from '../viewer/importers.ts';
import { AgentSettingsControls } from './AgentSettings.tsx';
import { imageAttachment, isMeshFile, meshAttachment, readMesh, usePotAgent, type PickedMesh } from './context.ts';

const QUICK_FIT = ['Sit it a bit lower.', 'Leave 2 mm under it for drainage.', 'Make it a snugger fit.', 'Fill the space under the nursery pot.'];
const QUICK_DESIGN = ['Make it taller.', 'Simplify the details.', 'Thicker walls.', 'Make it print without supports.'];

export function PotComposer({ role, mine }: {
  role: 'fit' | 'design' | 'review';
  /** The model's own thread, whose draft the app can fill in (Use as feedback). */
  mine: boolean;
}) {
  const ctx = usePotAgent();
  const thread = useThreadState((s) => s.snapshot.thread);
  const command = useCommand();
  const interrupt = useInterrupt();
  const setOptions = useSetOptions();
  const [localDraft, setLocalDraft] = useState('');
  const text = mine ? ctx.draft : localDraft;
  const setText = mine ? ctx.setDraft : setLocalDraft;
  const [pictures, setPictures] = useState<PickedImage[]>([]);
  // Meshes go to the server only: it saves them for the agent and tells Claude where they are.
  const [meshes, setMeshes] = useState<PickedMesh[]>([]);
  const [reading, setReading] = useState(0);
  const [withViews, setWithViews] = useState(role !== 'review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = thread.status === 'running' || thread.status === 'waiting';
  const empty = useThreadState((s) => s.snapshot.items.length === 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [text]);
  useEffect(() => setError(null), [thread.id]);

  // The thread follows the model and effort chosen here.
  const settings: AgentSettings = { model: thread.model ?? null, effort: (thread.effort ?? null) as AgentSettings['effort'] };
  const changeSettings = (next: AgentSettings) => {
    ctx.onSettings(next);
    const options: { model?: string; effort?: string } = {};
    if ((next.model ?? '') !== (thread.model ?? '') && next.model) options.model = next.model;
    if ((next.effort ?? '') !== (thread.effort ?? '') && next.effort) options.effort = next.effort;
    if (Object.keys(options).length) Promise.resolve(setOptions(options)).catch((e: Error) => setError(e.message));
  };

  // Comments on the model's results go with the next message in its own thread.
  const comments = mine ? ctx.pendingComments : [];
  const submit = async () => {
    const typed = text.trim() || (empty && role === 'fit' ? 'Fit the pot to the nursery pot.' : '');
    const sent = feedbackWithComments(typed, comments);
    if (!sent || busy || reading) return;
    setBusy(true);
    setError(null);
    try {
      const attachments = [];
      if (withViews) {
        const shots = await ctx.prepareSend();
        if (shots) attachments.push(await imageAttachment('view-3d.jpg', shots.view), await imageAttachment('view-section.jpg', shots.section));
      }
      for (const p of pictures) attachments.push(await imageAttachment(p.name, p.dataUrl, 1600));
      const sentMeshes = meshes;
      attachments.push(...sentMeshes.map(meshAttachment));
      await command({ type: 'send', text: sent, ...(attachments.length ? { attachments } : {}) });
      if (comments.length) ctx.commentsSent(comments.map((c) => c.id));
      setText('');
      setPictures([]);
      setMeshes((m) => m.filter((x) => !sentMeshes.includes(x)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Pictures and (outside reviews, whose reviewers can't open them) meshes, from the button, a drop or a paste.
  const takesMeshes = role !== 'review';
  const addFiles = async (list: File[]) => {
    const images = imageFiles(list);
    const meshFiles = takesMeshes ? list.filter(isMeshFile) : [];
    if (images.length) {
      const read = await Promise.all(images.map((f) => readImage(f, f.name)));
      setPictures((p) => [...p, ...read].slice(0, 8));
    }
    if (!meshFiles.length) return;
    setError(null);
    setReading((n) => n + 1);
    try {
      for (const f of meshFiles) {
        try {
          const mesh = await readMesh(f);
          setMeshes((m) => [...m, mesh].slice(0, 4));
        } catch (e) {
          setError(`Can't attach ${f.name}: ${(e as Error).message}`);
        }
      }
    } finally {
      setReading((n) => n - 1);
    }
  };
  const droppable = (files: File[]) => files.some((f) => f.type.startsWith('image/') || (takesMeshes && isMeshFile(f)));

  const quick = role === 'design' ? QUICK_DESIGN : role === 'fit' ? QUICK_FIT : [];
  const locked = role !== 'review' && ctx.lockedBy;
  const placeholder = locked
    ? ctx.lockedBy!
    : running
      ? 'Steer it: the agent reads this after its current step…'
      : role === 'review'
        ? 'Ask the reviewer about its review…'
        : empty
          ? role === 'design'
            ? 'Describe the pot you want…'
            : 'Anything to keep in mind? (or just send to fit it)'
          : role === 'design'
            ? 'What should change in the design?'
            : 'What should change in the fit or the shape?';

  return (
    <div className="pot-composer potfit-ui"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files);
        if (!droppable(files)) return;
        e.preventDefault();
        void addFiles(files);
      }}>
      {quick.length > 0 && !locked && (
        <div className="chips">
          {quick.map((q) => (
            <button key={q} type="button" className="chip-button" onClick={() => setText(text ? `${text.trimEnd()} ${q}` : q)}>{q}</button>
          ))}
        </div>
      )}
      {comments.length > 0 && !locked && (
        <p className="hint small">Your {comments.length === 1 ? 'comment' : `${comments.length} comments`} on Claude's results will go with this message.</p>
      )}
      {pictures.length > 0 && <ImagePicker images={pictures} onChange={setPictures} compact />}
      {(meshes.length > 0 || reading > 0) && (
        <div className="mesh-chips">
          {meshes.map((m, i) => (
            <span key={i} className="chip" title={`${m.triangles.toLocaleString()} triangles. Saved for Claude to open with its tools, not sent in the conversation.`}>
              ⬡ {m.name}
              <button type="button" className="icon" title="Remove" onClick={() => setMeshes((list) => list.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
          {reading > 0 && <span className="hint small">Reading the mesh…</span>}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={!!locked}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (!droppable(files)) return;
          e.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-bar">
        <AgentSettingsControls compact settings={settings} onChange={changeSettings} status={ctx.status} disabled={!!locked} />
        <label className="icon-button" title={takesMeshes ? 'Attach pictures, or meshes (STL, 3MF, OBJ, GLB, PLY) for Claude to refer to' : 'Attach pictures'}>
          <input type="file" accept={`image/png,image/jpeg,image/webp${takesMeshes ? `,${ACCEPTED_EXTENSIONS.join(',')}` : ''}`} multiple hidden onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void addFiles(files);
          }} />
          {takesMeshes ? '＋ Attach' : '＋ Picture'}
        </label>
        {role !== 'review' && (
          <label className="inline small" title="Send screenshots of the 3D and section views with the message">
            <input type="checkbox" checked={withViews} onChange={(e) => setWithViews(e.target.checked)} /> Views
          </label>
        )}
        <span className="grow" />
        {running && (
          <button type="button" className="small danger" onClick={() => Promise.resolve(interrupt()).catch((e: Error) => setError(e.message))} title="Stop the agent">
            ■ Stop
          </button>
        )}
        <button type="button" className="primary send" disabled={busy || reading > 0 || !!locked || (!text.trim() && !comments.length && !(empty && role === 'fit'))} onClick={() => void submit()}>
          {busy ? '…' : running ? 'Steer' : empty && role === 'fit' && !text.trim() ? 'Fit it' : 'Send'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
