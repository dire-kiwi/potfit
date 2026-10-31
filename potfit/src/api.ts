import type {
  CodexEvent,
  CodexSettings,
  CodexRun,
  FitSettings,
  ParamValues,
  PotModel,
  PotTransform,
  ReferenceInput,
  ReferencePot,
  ServerStatus,
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
  name?: string;
  transform?: PotTransform;
  fit?: Partial<FitSettings>;
  resetCodex?: boolean;
}

export interface CodexImage {
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
  model: (id: string) => request<{ model: PotModel; activeRun: CodexRun | null }>('GET', `/api/models/${id}`),
  uploadModel: (name: string, sourceFile: string, stl: Uint8Array) =>
    request<PotModel>('POST', `/api/models?${new URLSearchParams({ name, sourceFile })}`, undefined, new Blob([stl as BlobPart])),
  patchModel: (id: string, patch: ModelPatchBody) => request<PotModel>('PATCH', `/api/models/${id}`, patch),
  deleteModel: (id: string) => request<void>('DELETE', `/api/models/${id}`),
  meshUrl: (id: string) => `/api/models/${id}/mesh.stl`,
  exportUrl: (id: string) => `/api/models/${id}/export.stl`,

  runs: (id: string) => request<CodexRun[]>('GET', `/api/models/${id}/runs`),
  startRun: (id: string, body: CodexSettings & { mode: CodexRun['kind']; message: string; images: CodexImage[]; attachments?: CodexImage[] }) =>
    request<CodexRun>('POST', `/api/models/${id}/runs`, body),

  createDesign: (body: CodexSettings & { name: string; description: string; images: CodexImage[]; fit: Partial<FitSettings>; codex: boolean }) =>
    request<{ model: PotModel; run: CodexRun | null }>('POST', '/api/designs', body),
  buildDesign: (id: string, body: { params?: ParamValues; script?: string }) => request<PotModel>('POST', `/api/models/${id}/design/build`, body),
  revertDesign: (id: string, runId: string) => request<PotModel>('POST', `/api/models/${id}/design/revert`, { runId }),
  async designScript(id: string): Promise<string> {
    const res = await fetch(`/api/models/${id}/design/script`);
    if (!res.ok) throw new Error(`Could not load the script (${res.status})`);
    return res.text();
  },
  designScriptUrl: (id: string) => `/api/models/${id}/design/script`,
  designImageUrl: (id: string, name: string) => `/api/models/${id}/design/refs/${encodeURIComponent(name)}`,
  cancelRun: (id: string) => request<{ cancelled: boolean }>('POST', `/api/models/${id}/runs/cancel`),
  /** Undo a fit run that edited the mesh. */
  revertRun: (id: string, runId: string) => request<PotModel>('POST', `/api/models/${id}/runs/${runId}/revert`),
  rateRun: (id: string, runId: string, rating: CodexRun['rating']) => request<CodexRun>('PATCH', `/api/models/${id}/runs/${runId}`, { rating }),

  /** Stream a run's events (replayed from the start). Returns a function that stops listening. */
  runEvents(id: string, runId: string, onEvent: (e: CodexEvent) => void, onEnd: () => void): () => void {
    const source = new EventSource(`/api/models/${id}/runs/${runId}/events`);
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        source.close();
        onEnd();
      }
    };
    source.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as CodexEvent | { type: 'end' };
      if (e.type === 'end') return close();
      onEvent(e);
      if (e.type === 'result') close();
    };
    source.onerror = () => {
      // The server ends the stream when the run finishes; don't let EventSource reconnect.
      if (source.readyState !== EventSource.OPEN) close();
    };
    return () => {
      closed = true;
      source.close();
    };
  },
};
