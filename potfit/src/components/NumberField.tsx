import { useEffect, useState } from 'react';

interface Props {
  value: number | null;
  onChange(value: number): void;
  step?: number;
  min?: number;
  digits?: number;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  /** Allow clearing the field, reporting NaN. */
  allowEmpty?: boolean;
}

const format = (v: number | null, digits: number) => (v === null || !Number.isFinite(v) ? '' : String(Number(v.toFixed(digits))));

/** A numeric input that edits as text and commits on blur, Enter or the arrow keys. */
export function NumberField({ value, onChange, step = 1, min, digits = 3, disabled, placeholder, title, allowEmpty }: Props) {
  const [text, setText] = useState(format(value, digits));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(format(value, digits));
  }, [value, digits, focused]);

  const commit = (raw: string) => {
    if (raw.trim() === '' && allowEmpty) {
      onChange(NaN);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || (min !== undefined && n < min)) {
      setText(format(value, digits));
      return;
    }
    if (n !== value) onChange(n);
  };

  return (
    <input
      className="number"
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      title={title}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit(text);
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit(text);
          (e.target as HTMLInputElement).select();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const base = Number.isFinite(Number(text)) && text.trim() !== '' ? Number(text) : value ?? 0;
          const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
          let n = base + (e.key === 'ArrowUp' ? step : -step) * mult;
          if (min !== undefined) n = Math.max(min, n);
          n = Number(n.toFixed(digits));
          setText(String(n));
          onChange(n);
        }
      }}
    />
  );
}
