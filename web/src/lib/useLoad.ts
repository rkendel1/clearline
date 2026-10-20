import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Loaded<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => void; set: (v: T | null) => void }

/** Run `fn` on mount and whenever `deps` change; stale responses are discarded. */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fnRef.current(ac.signal).then(
      (d) => { if (!ac.signal.aborted) { setData(d); setError(null); setLoading(false); } },
      (e) => { if (ac.signal.aborted) return; setError(e instanceof ApiError ? e : new ApiError(0, 'client_error', String(e?.message ?? e))); setLoading(false); },
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, set: setData };
}

/** Run an action with busy/error state. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    setBusy(true); setError(null);
    try { return await fnRef.current(...a); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'client_error', String((e as Error)?.message ?? e))); return undefined; }
    finally { setBusy(false); }
  }, []);
  return { run, busy, error, clear: () => setError(null) };
}
