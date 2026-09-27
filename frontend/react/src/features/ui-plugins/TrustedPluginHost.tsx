/**
 * TrustedPluginHost (ADR 0367 Phase 2) — the T1 MAIN-FRAME mount for an
 * operator-pinned, Ed25519-signed plugin pack.
 *
 * Contract: the trusted entry is an ES module exporting
 * `mount(el: HTMLElement): (() => void) | void` — mount renders into the host
 * element and may return a cleanup. The module is dynamic-imported from the
 * SAME-ORIGIN host API path (`/api/...` via the Firebase rewrite in prod, the
 * vite proxy in dev), so the app's `script-src 'self'` CSP holds — no CSP
 * weakening, no external origin (the backend-as-verifier-and-origin ruling).
 *
 * The host re-verifies signature + revocation at every serve and answers a
 * uniform 404 on any miss — this component treats ANY failure (404, import
 * error, missing/throwing mount) as a designed error state, never a crash.
 */
import { useEffect, useRef, useState } from 'react';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { trustedEntryUrl, type ServedPlugin } from './pluginClient.js';

interface TrustedPluginModule {
  mount?: (el: HTMLElement) => (() => void) | void;
}

export interface TrustedPluginHostProps {
  plugin: ServedPlugin;
  loadingLabel: string;
  errorLabel: string;
  regionLabel?: string;
}


export function TrustedPluginHost({ plugin, loadingLabel, errorLabel, regionLabel }: TrustedPluginHostProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'loading' | 'mounted' | 'error'>('loading');

  const url = trustedEntryUrl(plugin);

  useEffect(() => {
    if (!url || !hostRef.current) {
      setState('error');
      return;
    }
    let cancelled = false;
    let cleanup: (() => void) | void;
    const el = hostRef.current;
    // @vite-ignore — a runtime host URL, deliberately not bundled: the module is
    // served (and signature-verified) by the backend at request time.
    import(/* @vite-ignore */ url)
      .then((mod: TrustedPluginModule) => {
        if (cancelled) return;
        if (typeof mod.mount !== 'function') throw new Error('trusted plugin exports no mount(el)');
        cleanup = mod.mount(el);
        setState('mounted');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch {
        // a throwing cleanup must never take the host page down
      }
      el.replaceChildren();
    };
  }, [url]);

  return (
    <div className="u-gap-2 u-flex u-flex-col">
      {state === 'loading' ? (
        <>
          <Skeleton />
          <span className="sr-only" role="status">{loadingLabel}</span>
        </>
      ) : null}
      {state === 'error' ? <Notice variant="error">{errorLabel}</Notice> : null}
      <div ref={hostRef} role="region" aria-label={regionLabel ?? errorLabel} aria-busy={state === 'loading'} />
    </div>
  );
}
