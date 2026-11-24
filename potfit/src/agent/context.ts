// What the dock's components (the composer and potfit's tool cards, which agent-threads draws
// with only the tool call) need from the app.

import { createContext, useContext } from 'react';
import { ACCEPTED_EXTENSIONS, importFile } from '../viewer/importers.ts';
import type { RunComment } from '../../shared/comments.ts';
import { writeBinarySTL } from '../../shared/stl.ts';
import type { AgentSettings, Checkpoint, ModelVersion, PotModel, Review, ServerStatus } from '../../shared/types.ts';

export interface PotAgent {
  model: PotModel;
  status: ServerStatus | null;
  settings: AgentSettings;
  onSettings(settings: AgentSettings): void;
  /** Checkpoints by id, as they are now (reverted, rated). */
  checkpoints: Record<string, Checkpoint>;
  onRevert(checkpoint: Checkpoint): Promise<void>;
  onRate(checkpoint: Checkpoint, rating: Checkpoint['rating']): void;
  /** The model's versions by id, and going to one. */
  versions: Record<string, ModelVersion>;
  onCheckout(version: ModelVersion): Promise<void>;
  /** Reviews by id, as they are now (commented on). */
  reviews: Record<string, Review>;
  /** Keep the user's comments on a result card's text (the whole new list). */
  onCheckpointComments(checkpoint: Checkpoint, comments: RunComment[]): void;
  onReviewComments(review: Review, comments: RunComment[]): void;
  /** Comments on the model's results the agent hasn't had; they go with the next message in the model's thread. */
  pendingComments: RunComment[];
  /** Mark comments as sent to the agent. */
  commentsSent(ids: string[]): void;
  /** Put text in the model's thread's composer (a review's suggestion). */
  onUseFeedback(text: string): void;
  /** The main composer's draft, kept per model while the page is open. */
  draft: string;
  setDraft(text: string): void;
  /** Save pending edits, then screenshot the views (as data URLs), for a message to the agent. */
  prepareSend(): Promise<{ view: string; section: string } | null>;
  /** Something other than the user is driving the thread (the screenshot loop). */
  lockedBy: string | null;
  openThread(threadId: string): void;
}

export const PotAgentContext = createContext<PotAgent | null>(null);

export function usePotAgent(): PotAgent {
  const ctx = useContext(PotAgentContext);
  if (!ctx) throw new Error('usePotAgent needs a PotAgentContext');
  return ctx;
}

/** A data URL as an agent-threads image attachment, shrunk to at most `max` px as a JPEG. */
export async function imageAttachment(name: string, dataUrl: string, max = 1280) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = canvas.toDataURL('image/jpeg', 0.85);
  return { kind: 'image' as const, name, media_type: 'image/jpeg', data: jpeg.slice(jpeg.indexOf(',') + 1) };
}

/** Files the composer takes as meshes for reference. */
export const isMeshFile = (f: File) => ACCEPTED_EXTENSIONS.includes(f.name.slice(f.name.lastIndexOf('.')).toLowerCase());

/** The largest mesh a message takes (the API's request limit is 64 MB, and base64 adds a third). */
const MAX_MESH_BYTES = 40 * 1024 * 1024;

export interface PickedMesh {
  /** The file the user picked. */
  name: string;
  triangles: number;
  /** A binary STL of all its objects, as base64. */
  data: string;
}

/** Any mesh file the app imports, as one binary STL for an attachment. */
export async function readMesh(file: File): Promise<PickedMesh> {
  const parts = await importFile(file);
  const positions = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0));
  let at = 0;
  for (const p of parts) {
    positions.set(p.positions, at);
    at += p.positions.length;
  }
  if (!positions.length) throw new Error(`${file.name} has no triangles`);
  const stl = writeBinarySTL(positions, `potfit reference: ${file.name}`);
  if (stl.byteLength > MAX_MESH_BYTES) throw new Error(`${file.name} is too big to attach (${Math.round(stl.byteLength / 1048576)} MB as an STL; at most 40 MB)`);
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([stl as Uint8Array<ArrayBuffer>]));
  });
  return { name: file.name, triangles: positions.length / 9, data: url.slice(url.indexOf(',') + 1) };
}

/** A mesh as an attachment: potfit's server saves it in the agent's refs/ and only tells Claude it's there. */
export const meshAttachment = (m: PickedMesh) => ({ kind: 'file' as const, name: m.name, media_type: 'model/stl', data: m.data });

const CONTEXT = /\n*<potfit-context>([\s\S]*?)<\/potfit-context>\s*$/;
/** A message's own text, and the context potfit added to it. */
export function splitContext(text: string): { text: string; context: string | null } {
  const m = CONTEXT.exec(text);
  return m ? { text: text.slice(0, m.index), context: m[1].trim() } : { text, context: null };
}
