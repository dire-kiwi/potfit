// The step panels on the left: what each step of the workflow needs.

import { useState } from 'react';
import type { AgentSettings, FitMetrics, FitSettings, ParamValues, PotModel, PotTransform, ReferenceInput, ReferencePot, Review, ScreenshotReview, ServerStatus } from '../../shared/types.ts';
import { AgentSettingsControls } from '../agent/AgentSettings.tsx';
import { DesignPanel } from '../components/DesignPanel.tsx';
import { FitGoals, Measurements, Placement, mm } from '../components/FitPanel.tsx';
import type { PickedImage } from '../components/ImagePicker.tsx';
import { ModelList } from '../components/ModelList.tsx';
import { OverhangSelector } from '../components/OverhangSelector.tsx';
import { ReferencePanel } from '../components/ReferencePanel.tsx';
import { ScreenshotReviewPanel } from '../components/ScreenshotReviewPanel.tsx';
import type { ScaleLock } from '../viewer/PotViewer.ts';

function Section({ title, children, open = true, aside }: { title: string; children: React.ReactNode; open?: boolean; aside?: React.ReactNode }) {
  return (
    <details className="step-section" open={open}>
      <summary>
        <span>{title}</span>
        {aside}
      </summary>
      <div className="step-section-body">{children}</div>
    </details>
  );
}

export function PotStep(props: {
  references: ReferencePot[];
  model: PotModel | null;
  onUse(id: string): void;
  onCreate(input: ReferenceInput): Promise<void>;
  onUpdate(id: string, input: ReferenceInput): Promise<void>;
  onDelete(id: string): Promise<void>;
  onNext(): void;
}) {
  return (
    <>
      <p className="lede">The plain pot the plant grows in, by its outer diameters and height. Every fit and design is built around one.</p>
      <ReferencePanel references={props.references} activeId={props.model?.fit.referenceId ?? null} onUse={props.onUse} onCreate={props.onCreate} onUpdate={props.onUpdate} onDelete={props.onDelete} />
      {!props.model && props.references.length > 0 && <p className="hint">Open or import a model, then choose its nursery pot here.</p>}
      <div className="row end">
        <button className="primary" disabled={!props.references.length} onClick={props.onNext}>
          Next: {props.model ? 'fit' : 'model'} →
        </button>
      </div>
    </>
  );
}

export function ModelStep(props: {
  model: PotModel | null;
  models: PotModel[];
  references: ReferencePot[];
  busy: string | null;
  lockedBy: string | null;
  building: boolean;
  onBuild(body: { params?: ParamValues; script?: string }): Promise<void>;
  onSelect(id: string): void;
  onFiles(files: File[]): void;
  onNewDesign(): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
}) {
  const { model } = props;
  return (
    <>
      {model && (
        <div className="model-card">
          <strong>{model.name}</strong>
          <span className="muted small">
            {model.design ? 'Designed in potfit' : `Imported from ${model.sourceFile}`} · {model.triangleCount.toLocaleString()} triangles
          </span>
        </div>
      )}
      {model?.design && <DesignPanel key={model.id} model={model} references={props.references} lockedBy={props.lockedBy} building={props.building} onBuild={props.onBuild} />}
      <Section title="Your models" open={!model?.design}>
        <ModelList models={props.models} selectedId={model?.id ?? null} busy={props.busy} onSelect={props.onSelect} onFiles={props.onFiles} onNewDesign={props.onNewDesign} onRename={props.onRename} onDelete={props.onDelete} />
      </Section>
    </>
  );
}

export function FitStep(props: {
  model: PotModel;
  reference: ReferencePot | null;
  metrics: FitMetrics | null;
  locked: boolean;
  busy: string | null;
  agentAvailable: boolean;
  agentBusy: boolean;
  scaleLock: ScaleLock;
  canUndo: boolean;
  canRedo: boolean;
  onScaleLock(lock: ScaleLock): void;
  onFit(patch: Partial<FitSettings>): void;
  onTransform(t: PotTransform): void;
  onQuickFit(): void;
  onDetectOrientation(): void;
  onUndo(): void;
  onRedo(): void;
  onAgentFit(instructions: string): Promise<void>;
  onOverhangs(avoid: boolean): void;
}) {
  const { model, reference, locked } = props;
  const [instructions, setInstructions] = useState('');
  const [sending, setSending] = useState(false);
  return (
    <>
      {!reference && <p className="callout warn">Choose a nursery pot in step 1 first.</p>}
      <Section title="Goals">
        <FitGoals model={model} onFit={props.onFit} locked={locked} />
        <OverhangSelector value={model.avoidOverhangs !== false} disabled={locked} onChange={props.onOverhangs} />
      </Section>
      {!model.design && (
        <Section title="Fit it">
          <textarea
            rows={2}
            value={instructions}
            disabled={!props.agentAvailable || props.agentBusy}
            placeholder="Anything Claude should know? (optional)"
            onChange={(e) => setInstructions(e.target.value)}
          />
          <div className="row">
            <button
              className="primary"
              disabled={!reference || !props.agentAvailable || props.agentBusy || sending}
              onClick={async () => {
                setSending(true);
                try {
                  await props.onAgentFit(instructions);
                  setInstructions('');
                } finally {
                  setSending(false);
                }
              }}
              title="Claude fits the pot; follow it and give feedback in the panel on the right"
            >
              {props.agentBusy ? 'Claude is working…' : 'Fit with Claude'}
            </button>
            <button onClick={props.onQuickFit} disabled={locked || !reference || !!props.busy} title="Run the built-in solver with these goals">
              Quick fit (no AI)
            </button>
          </div>
          <p className="hint">Then give feedback in the Claude panel: it sees your manual moves and the views, and can edit the shape in Blender.</p>
        </Section>
      )}
      <Section title="Placement" open={!model.design}>
        <Placement
          model={model}
          metrics={props.metrics}
          locked={locked}
          scaleLock={props.scaleLock}
          canUndo={props.canUndo}
          canRedo={props.canRedo}
          onScaleLock={props.onScaleLock}
          onTransform={props.onTransform}
          onDetectOrientation={props.onDetectOrientation}
          onUndo={props.onUndo}
          onRedo={props.onRedo}
        />
        <p className="hint">Or drag the gizmo in either view: W move, E scale, Q view only, F frame.</p>
      </Section>
    </>
  );
}

const VERDICT: Record<string, string> = { pass: 'Pass', concerns: 'Concerns', fail: 'Fail' };

export function ReviewStep(props: {
  model: PotModel;
  reviews: Review[];
  loop: ScreenshotReview | null;
  settings: AgentSettings;
  onSettings(s: AgentSettings): void;
  status: ServerStatus | null;
  canReview: boolean;
  loopDisabled: boolean;
  onReview(): Promise<void>;
  onOpenReview(reviewId: string): void;
  onStartLoop(images: PickedImage[], prompt: string): Promise<void>;
  onCancelLoop(): Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const own = props.reviews.filter((r) => !r.focus);
  return (
    <>
      <Section title="Independent review">
        <p className="hint">A fresh Claude that sees only the result (the placed pot, the nursery pot, the goals and the views), never the fitting conversation.</p>
        <AgentSettingsControls settings={props.settings} onChange={props.onSettings} status={props.status} />
        <button
          className="primary"
          disabled={!props.canReview || starting}
          onClick={async () => {
            setStarting(true);
            try {
              await props.onReview();
            } finally {
              setStarting(false);
            }
          }}
        >
          Review the fit
        </button>
        {own.length > 0 && (
          <ul className="review-list">
            {own
              .slice()
              .reverse()
              .map((r) => {
                const stale = JSON.stringify(r.transform) !== JSON.stringify(props.model.transform);
                return (
                  <li key={r.id}>
                    <button className={`review-line verdict-${r.result?.verdict ?? r.status}`} onClick={() => props.onOpenReview(r.id)}>
                      <strong>{r.result ? VERDICT[r.result.verdict] : r.status === 'running' ? 'Reviewing…' : r.status}</strong>
                      {stale && <span className="pill">out of date</span>}
                      <span className="muted">{r.result?.summary ?? r.error ?? ''}</span>
                      <span className="faint small">{new Date(r.createdAt).toLocaleString()}</span>
                    </button>
                  </li>
                );
              })}
          </ul>
        )}
      </Section>
      <Section title="Iterative screenshot review" open={!!props.loop}>
        <ScreenshotReviewPanel state={props.loop} disabled={props.loopDisabled} onStart={props.onStartLoop} onCancel={props.onCancelLoop} onOpenReview={props.onOpenReview} />
      </Section>
    </>
  );
}

export function ExportStep(props: { model: PotModel; references: ReferencePot[]; metrics: FitMetrics | null; metricsError: string | null; exportUrl: string; locked: boolean }) {
  const { metrics, model } = props;
  const report = model.design?.report;
  const checks = metrics
    ? [
        { ok: !metrics.interferes, warn: !metrics.clearanceOk, text: metrics.interferes ? 'The nursery pot passes through the wall' : metrics.clearanceOk ? 'The nursery pot fits with the clearance' : 'Tighter than the clearance' },
        {
          ok: (metrics.wallThickness?.min ?? Infinity) >= 0.8,
          warn: (metrics.wallThickness?.min ?? Infinity) < 1.2,
          text: `Thinnest wall ${mm(metrics.wallThickness?.min)}, floor ${mm(metrics.floorThickness)}`,
        },
        ...(report ? [{ ok: report.components === 1, warn: false, text: report.components === 1 ? 'One solid piece' : `${report.components} separate pieces` }] : []),
        ...(report ? [{ ok: true, warn: report.overhangArea > 25, text: `Overhangs over 45°: ${report.overhangArea.toFixed(0)} mm²${model.avoidOverhangs === false ? ' (supports accepted)' : ''}` }] : []),
      ]
    : [];
  return (
    <>
      {checks.length > 0 && (
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.text} className={!c.ok ? 'bad' : c.warn ? 'warn' : 'ok'}>
              {c.text}
            </li>
          ))}
        </ul>
      )}
      <a className={`button primary big ${props.locked ? 'disabled' : ''}`} href={props.exportUrl} download>
        ⤓ Export STL
      </a>
      <p className="hint">Z up, standing on z = 0, in millimetres: ready for a slicer.</p>
      <Section title="Measurements">
        <Measurements model={model} references={props.references} metrics={metrics} metricsError={props.metricsError} />
      </Section>
    </>
  );
}
