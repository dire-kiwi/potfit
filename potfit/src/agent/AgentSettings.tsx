import { AGENT_EFFORTS, type AgentEffort, type AgentSettings, type ServerStatus } from '../../shared/types.ts';

const effortLabel = (e: string) => (e === 'xhigh' ? 'Extra high' : e[0].toUpperCase() + e.slice(1));

/** Claude model and reasoning effort. `compact` for the composer's toolbar. */
export function AgentSettingsControls({ settings, onChange, status, disabled, compact }: {
  settings: AgentSettings;
  onChange(settings: AgentSettings): void;
  status: ServerStatus | null;
  disabled?: boolean;
  compact?: boolean;
}) {
  const models = status?.claude.models ?? [];
  const known = models.some((m) => m.id === settings.model);
  const custom = settings.model === '' || (!!settings.model && !known);
  const defaultModel = status?.claude.defaultModel;
  const defaultEffort = status?.claude.defaultEffort;
  const model = (
    <select aria-label="Claude model" title="Claude model" value={custom ? 'custom' : (settings.model ?? '')} disabled={disabled}
      onChange={(e) => onChange({ ...settings, model: e.target.value === 'custom' ? '' : e.target.value || null })}>
      <option value="">{defaultModel ? `Default (${defaultModel})` : 'Default model'}</option>
      {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      <option value="custom">Custom…</option>
    </select>
  );
  const effort = (
    <select aria-label="Reasoning effort" title="Reasoning effort" value={settings.effort ?? ''} disabled={disabled}
      onChange={(e) => onChange({ ...settings, effort: (e.target.value || null) as AgentEffort | null })}>
      <option value="">{defaultEffort ? `Default (${defaultEffort})` : compact ? 'Effort' : 'Default effort'}</option>
      {AGENT_EFFORTS.map((e) => <option key={e} value={e}>{effortLabel(e)}</option>)}
    </select>
  );
  const customInput = custom && (
    <input className="model-id" aria-label="Model ID" value={settings.model ?? ''} maxLength={200} placeholder="claude-… model ID" disabled={disabled}
      onChange={(e) => onChange({ ...settings, model: e.target.value })} />
  );
  if (compact) return <span className="agent-settings compact">{model}{customInput}{effort}</span>;
  return (
    <div className="agent-settings">
      <label className="field"><span>Claude model</span>{model}</label>
      {customInput && <label className="field"><span>Model ID</span>{customInput}</label>}
      <label className="field"><span>Effort</span>{effort}</label>
    </div>
  );
}
