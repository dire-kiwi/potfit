// Runs the shared fit maths off the main thread so dragging stays smooth.

import { analyzeMesh, checkFit, initialTransform, solveFit, type ReferenceDims, type SolveOptions } from '../../shared/fit.ts';
import { computeBounds, type Bounds } from '../../shared/transform.ts';
import type { FitSettings, PotTransform } from '../../shared/types.ts';

export type GeometryRequest =
  | { type: 'load'; positions: Float32Array }
  | { type: 'check'; transform: PotTransform; ref: ReferenceDims; fit: FitSettings }
  | { type: 'solve'; ref: ReferenceDims; opts: SolveOptions }
  | { type: 'analyze' };

let positions: Float32Array | null = null;
let raw: Bounds | null = null;

function handle(req: GeometryRequest): unknown {
  if (req.type === 'load') {
    positions = req.positions;
    raw = computeBounds(positions);
    return true;
  }
  if (!positions || !raw) throw new Error('No mesh loaded');
  switch (req.type) {
    case 'check':
      return checkFit(positions, req.transform, req.ref, req.fit, raw);
    case 'solve':
      return solveFit(positions, req.ref, req.opts, raw);
    case 'analyze': {
      const analysis = analyzeMesh(positions);
      return { analysis, initial: initialTransform(positions, analysis) };
    }
  }
}

self.onmessage = (e: MessageEvent<{ id: number; req: GeometryRequest }>) => {
  const { id, req } = e.data;
  try {
    self.postMessage({ id, result: handle(req) });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
