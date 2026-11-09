// What the dock's components (the composer and potfit's tool cards, which agent-threads draws
// with only the tool call) need from the app.

import { createContext, useContext } from 'react';
import type { AgentSettings, Checkpoint, PotModel, ServerStatus } from '../../shared/types.ts';

export interface PotAgent {
  model: PotModel;
  status: ServerStatus | null;
  settings: AgentSettings;
  onSettings(settings: AgentSettings): void;
  /** Checkpoints by id, as they are now (reverted, rated). */
  checkpoints: Record<string, Checkpoint>;
  onRevert(checkpoint: Checkpoint): Promise<void>;
  onRate(checkpoint: Checkpoint, rating: Checkpoint['rating']): void;
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

const CONTEXT = /\n*<potfit-context>([\s\S]*?)<\/potfit-context>\s*$/;
/** A message's own text, and the context potfit added to it. */
export function splitContext(text: string): { text: string; context: string | null } {
  const m = CONTEXT.exec(text);
  return m ? { text: text.slice(0, m.index), context: m[1].trim() } : { text, context: null };
}
