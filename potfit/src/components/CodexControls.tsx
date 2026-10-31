import { useId } from 'react';
import { REASONING_EFFORTS, type CodexSettings, type ReasoningEffort, type ServerStatus } from '../../shared/types.ts';

export interface CodexControlsProps {
  settings: CodexSettings;
  onSettings(settings: CodexSettings): void;
  status: ServerStatus | null;
}

export function CodexControls({ settings, onSettings, status, disabled }: CodexControlsProps & { disabled?: boolean }) {
  const id = useId();
  const models = status?.codex.models ?? [];
  const selected = models.find((m) => m.id === settings.model);
  const customModel = settings.model === '' || (!!settings.model && !selected);
  const efforts = selected?.efforts.length ? selected.efforts : REASONING_EFFORTS;
  const defaultModel = status?.codex.defaultModel;
  return (
    <fieldset className="codex-controls" disabled={disabled}>
      <legend>Codex settings</legend>
      <label className="field">
        <span>Model</span>
        <select value={customModel ? 'custom' : settings.model || ''} onChange={(e) => {
          onSettings({ model: e.target.value === 'custom' ? '' : e.target.value || null, effort: null });
        }}>
          <option value="">{defaultModel ? `Server default (${defaultModel})` : 'Codex default'}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          <option value="custom">Custom model…</option>
        </select>
      </label>
      {customModel && <label className="field">
        <span>Model ID</span>
        <input value={settings.model ?? ''} maxLength={200} placeholder="Enter a Codex model ID" onChange={(e) => onSettings({ ...settings, model: e.target.value })} />
      </label>}
      <label className="field">
        <span>Reasoning effort</span>
        <select value={settings.effort ?? ''} aria-describedby={id} onChange={(e) => onSettings({ ...settings, effort: (e.target.value || null) as ReasoningEffort | null })}>
          <option value="">Codex default</option>
          {/* Retain a saved selection if the server's catalog has changed. */}
          {settings.effort && !efforts.includes(settings.effort) && <option value={settings.effort}>{settings.effort} (not in catalog)</option>}
          {efforts.map((effort) => <option key={effort} value={effort}>{effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1)}</option>)}
        </select>
      </label>
      <p id={id} className="hint">Applies to the next run, including feedback and reviews. Higher effort can take longer. Custom models must support the selected effort.</p>
    </fieldset>
  );
}
