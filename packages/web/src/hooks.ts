/** Data-loading and formatting helpers shared by the pages. */
import { useCallback, useEffect, useState } from 'react';

export interface Loadable<T> {
  data?: T;
  error?: string;
  loading: boolean;
  /** Re-run the request; the pages hang their "Refresh" button on this. */
  reload: () => void;
}

/**
 * Load something from the gateway once, with a manual reload.
 *
 * `deps` is the dependency list of the loader itself — pass anything the
 * loader closes over. The request is aborted on unmount so a page change
 * cannot land a response on a dead component.
 */
export function useApi<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = []
): Loadable<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    loader(controller.signal)
      .then((data) => {
        if (live) setState({ data, loading: false });
      })
      .catch((err: unknown) => {
        if (!live || controller.signal.aborted) return;
        setState({ error: err instanceof Error ? err.message : String(err), loading: false });
      });
    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  return { ...state, reload };
}

/** USD, at whatever precision the number actually needs (gateway prices are tiny). */
export function usd(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toPrecision(3)}`;
  return `$${value.toFixed(2)}`;
}

/** USD per 1M tokens, as providers publish it. */
export function ratePerMillion(value: number | undefined): string {
  return value === undefined ? 'not published' : `$${value}/1M`;
}

export function tokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString();
}

/** XRP drops are unreadable; RLUSD and other IOUs are already decimal. */
export function amount(value: string, asset: string): string {
  if (asset !== 'XRP') return `${value} ${asset}`;
  const drops = Number(value);
  if (!Number.isFinite(drops)) return `${value} XRP drops`;
  return `${drops / 1_000_000} XRP`;
}

export function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

export function shorten(value: string | undefined, head = 8, tail = 6): string {
  if (value === undefined) return '—';
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Hex-encode a nonce for an XRPL memo, the way the facilitator reads it. */
export function hexMemo(nonce: string): string {
  return Array.from(new TextEncoder().encode(nonce))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}
