export function OverhangSelector({ value, onChange, disabled = false }: {
  value: boolean; onChange(value: boolean): void; disabled?: boolean;
}) {
  return <label className="field">
    <span>Overhangs</span>
    <select value={value ? 'avoid' : 'allow'} disabled={disabled} onChange={e => onChange(e.target.value === 'avoid')}>
      <option value="avoid">Avoid overhangs (no supports)</option>
      <option value="allow">Allow overhangs (supports OK)</option>
    </select>
  </label>;
}
