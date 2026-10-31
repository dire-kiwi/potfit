import { useState, type Dispatch, type SetStateAction } from 'react';

const threads = new Map<string, Map<string, unknown>>();
/** UI-only state outlives a panel unmount; run history itself is stored by the server. */
export function useThreadState<T>(modelId: string, key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  let values = threads.get(modelId);
  if (!values) { values = new Map(); threads.set(modelId, values); }
  const cache = values;
  const [value, setValue] = useState<T>(() => cache.has(key) ? cache.get(key) as T : initial);
  return [value, next => setValue(current => {
    const result = typeof next === 'function' ? (next as (v: T) => T)(current) : next;
    cache.set(key, result);
    return result;
  })];
}
