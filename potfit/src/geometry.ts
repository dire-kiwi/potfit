import type { MeshAnalysis, ReferenceDims, SolveOptions, SolveResult } from '../shared/fit.ts';
import type { FitMetrics, FitSettings, PotTransform } from '../shared/types.ts';
import type { GeometryRequest } from './worker/geometry.worker.ts';

/** Promise wrapper around the geometry worker. Requests run in order. */
export class GeometryClient {
  private worker = new Worker(new URL('./worker/geometry.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error !== undefined) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
  }

  private call<T>(req: GeometryRequest, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, req }, transfer);
    });
  }

  /** Hands the worker its own copy of the mesh. */
  load(positions: Float32Array) {
    const copy = positions.slice();
    return this.call<boolean>({ type: 'load', positions: copy }, [copy.buffer]);
  }

  check(transform: PotTransform, ref: ReferenceDims, fit: FitSettings) {
    return this.call<FitMetrics>({ type: 'check', transform, ref, fit });
  }

  solve(ref: ReferenceDims, opts: SolveOptions) {
    return this.call<SolveResult>({ type: 'solve', ref, opts });
  }

  analyze() {
    return this.call<{ analysis: MeshAnalysis; initial: PotTransform }>({ type: 'analyze' });
  }

  dispose() {
    this.worker.terminate();
  }
}
