import type { Command, ItemPage, Snapshot, ThreadEvent } from '@dire-kiwi/agent-threads-react';
import type {
  AgentSettings,
  Checkpoint,
  FitSettings,
  LiveEvent,
  ParamValues,
  PotModel,
  PotTransform,
  ReferenceInput,
  ReferencePot,
  Review,
  ScreenshotReview,
  ServerStatus,
  ThreadState,
} from '../shared/types.ts';

async function request<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface ModelPatchBody {
  avoidOverhangs?: boolean;
  name?: string;
  transform?: PotTransform;
  fit?: Partial<FitSettings>;
}

/** A picture sent to the server, as a data URL. */
export interface ImageBody {
  name: string;
  dataUrl: string;
}

export const api = {
  status: () => request<ServerStatus>('GET', '/api/status'),

  references: () => request<ReferencePot[]>('GET', '/api/references'),
  createReference: (input: ReferenceInput) => request<ReferencePot>('POST', '/api/references', input),
  updateReference: (id: string, input: ReferenceInput) => request<ReferencePot>('PUT', `/api/references/${id}`, input),
  deleteReference: (id: string) => request<void>('DELETE', `/api/references/${id}`),

  models: () => request<PotModel[]>('GET', '/api/models'),
  model: (id: string) => request<{ model: PotModel; threads: ThreadState[] }>('GET', `/api/models/${id}`),
  uploadModel: (name: string, sourceFile: string, stl: Uint8Array) =>
    request<PotModel>('POST', `/api/models?${new URLSearchParams({ name, sourceFile })}`, undefined, new Blob([stl as BlobPart])),
  patchModel: (id: string, patch: ModelPatchBody) => request<PotModel>('PATCH', `/api/models/${id}`, patch),
  deleteModel: (id: string) => request<void>('DELETE', `/api/models/${id}`),
  meshUrl: (id: string) => `/api/models/${id}/mesh.stl`,
  exportUrl: (id: string) => `/api/models/${id}/export.stl`,
  /** An image the agent rendered, or a design's reference image, by its path in the model's directory. */
  fileUrl: (id: string, path: string) => `/api/models/${id}/files/${path}`,

  createDesign: (body: AgentSettings & { name: string; description: string; avoidOverhangs: boolean; images: ImageBody[]; fit: Partial<FitSettings>; agent: boolean }) =>
    request<{ model: PotModel }>('POST', '/api/designs', body),
  buildDesign: (id: string, body: { params?: ParamValues; script?: string }) => request<PotModel>('POST', `/api/models/${id}/design/build`, body),
  async designScript(id: string): Promise<string> {
    const res = await fetch(`/api/models/${id}/design/script`);
    if (!res.ok) throw new Error(`Could not load the script (${res.status})`);
    return res.text();
  },
  designScriptUrl: (id: string) => `/api/models/${id}/design/script`,
  designImageUrl: (id: string, name: string) => `/api/models/${id}/design/refs/${encodeURIComponent(name)}`,

  /** The model's fitting or design thread, made if it hasn't one. */
  agent: (id: string, settings: AgentSettings) => request<ThreadState>('POST', `/api/models/${id}/agent`, settings),
  newSession: (id: string) => request<void>('POST', `/api/models/${id}/agent/new-session`),
  checkpoints: (id: string) => request<Checkpoint[]>('GET', `/api/models/${id}/checkpoints`),
  revertCheckpoint: (id: string, cid: string) => request<{ model: PotModel; checkpoint: Checkpoint; meshChanged: boolean }>('POST', `/api/models/${id}/checkpoints/${cid}/revert`),
  rateCheckpoint: (id: string, cid: string, rating: Checkpoint['rating']) => request<Checkpoint>('PATCH', `/api/models/${id}/checkpoints/${cid}`, { rating }),
  reviews: (id: string) => request<Review[]>('GET', `/api/models/${id}/reviews`),
  startReview: (id: string, settings: AgentSettings, images: ImageBody[]) => request<Review>('POST', `/api/models/${id}/reviews`, { ...settings, images }),
  cancelReview: (id: string, rid: string) => request<Review>('POST', `/api/models/${id}/reviews/${rid}/cancel`),
  screenshotReview: (id: string) => request<ScreenshotReview | null>('GET', `/api/models/${id}/screenshot-review`),
  startScreenshotReview: (id: string, images: ImageBody[], settings: AgentSettings, prompt: string) =>
    request<ScreenshotReview>('POST', `/api/models/${id}/screenshot-review`, { images, prompt, ...settings }),
  cancelScreenshotReview: (id: string) => request<{ cancelled: boolean }>('POST', `/api/models/${id}/screenshot-review/cancel`),

  /** What changes on the model while it's open. Returns how to stop. */
  live(id: string, onEvent: (e: LiveEvent) => void): () => void {
    const source = new EventSource(`/api/models/${id}/live`);
    source.onmessage = (m) => onEvent(JSON.parse(m.data) as LiveEvent);
    return () => source.close();
  },

  // agent-threads: a thread's events over SSE, commands over POST.
  threadStream: (tid: string) => new EventSource(`/api/threads/${tid}/stream`),
  threadEvents: (tid: string, after: number) => request<ThreadEvent[]>('GET', `/api/threads/${tid}/events?after=${after}`),
  threadItems: (tid: string, before: number) => request<ItemPage>('GET', `/api/threads/${tid}/items?before=${before}&limit=200`),
  command: (command: Command) => request<void>('POST', `/api/threads/${command.thread_id}/commands`, command),
};

export type { Snapshot };
