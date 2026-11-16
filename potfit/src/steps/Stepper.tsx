// The workflow across the header: nursery pot, model, fit, review, export. A guide, not a wizard:
// any step opens at any time, and each shows whether it's satisfied.

export type StepId = 'pot' | 'model' | 'fit' | 'review' | 'export';
export type StepState = 'todo' | 'done' | 'warn' | 'bad';

export const STEPS: { id: StepId; title: string; short: string }[] = [
  { id: 'pot', title: 'Nursery pot', short: 'Pot' },
  { id: 'model', title: 'Model', short: 'Model' },
  { id: 'fit', title: 'Fit', short: 'Fit' },
  { id: 'review', title: 'Review', short: 'Review' },
  { id: 'export', title: 'Export', short: 'Export' },
];

const MARK: Record<StepState, string | null> = { todo: null, done: '✓', warn: '!', bad: '✗' };

export function Stepper({ step, states, enabled, onStep }: {
  step: StepId;
  states: Record<StepId, StepState>;
  enabled(step: StepId): boolean;
  onStep(step: StepId): void;
}) {
  return (
    <nav className="stepper" aria-label="Workflow">
      {STEPS.map((s, i) => (
        <button key={s.id} className={`step ${s.id === step ? 'on' : ''} ${states[s.id]}`} disabled={!enabled(s.id)} onClick={() => onStep(s.id)} aria-current={s.id === step ? 'step' : undefined}>
          <span className="step-mark">{MARK[states[s.id]] ?? i + 1}</span>
          <span className="step-label">{s.title}</span>
          <span className="step-short">{s.short}</span>
        </button>
      ))}
    </nav>
  );
}
