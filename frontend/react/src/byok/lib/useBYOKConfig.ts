/**
 * BYOK config — what provider + model + credentialRef is the user
 * currently using? Persisted to localStorage (Phase 1; Phase 2 moves
 * to BE-backed user prefs). The credentialRef VALUE never lives in
 * localStorage — only the ref name. Plaintext keys live exclusively
 * in the BE's in-memory secretResolver.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ProviderId } from './providers.js';
import { listStoredRefs } from './byokClient.js';

export interface BYOKActiveConfig {
  provider: ProviderId;
  model: string;
  credentialRef: string;
}

const LS_KEY = 'openwop-app.byok.activeConfig';

function readLs(): BYOKActiveConfig | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BYOKActiveConfig;
    if (!parsed.provider || !parsed.model || !parsed.credentialRef) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLs(cfg: BYOKActiveConfig | null): void {
  if (cfg === null) {
    localStorage.removeItem(LS_KEY);
    return;
  }
  // Whitelist the exact non-secret fields before persisting. The credential
  // VALUE must never reach localStorage (threat-model-secret-leakage); a
  // future field added to BYOKActiveConfig cannot smuggle a secret through
  // here, and a caller passing an over-wide object can't either.
  const safe: BYOKActiveConfig = {
    provider: cfg.provider,
    model: cfg.model,
    credentialRef: cfg.credentialRef,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(safe));
}

/** Test-only export of the persistence whitelist (threat-model-secret-leakage
 *  invariant). Not part of the hook's public API. */
export { writeLs as __persistConfigForTest };

export interface UseBYOKConfigResult {
  /** Active config from localStorage, validated against BE's stored refs. */
  config: BYOKActiveConfig | null;
  /** Whether the active config's credentialRef is actually present on the BE. */
  isValid: boolean;
  /** All credentialRefs currently stored on the BE. */
  storedRefs: readonly string[];
  /** Update + persist the active config (also re-syncs storedRefs). */
  setConfig: (cfg: BYOKActiveConfig | null) => Promise<void>;
  /** Force a re-fetch of storedRefs (e.g., after storing or deleting a key).
   *  Pass `{ background: true }` for a QUIET refresh that does NOT toggle
   *  `isLoading` — used by the tab-visibility re-sync so returning to the tab
   *  doesn't flip the whole chat surface back to the loading card (a jarring
   *  full repaint). */
  refresh: (opts?: { background?: boolean }) => Promise<void>;
  /** True while we're loading storedRefs from the BE. */
  isLoading: boolean;
  /** Any fetch error talking to the BE. */
  error: string | null;
}

export function useBYOKConfig(): UseBYOKConfigResult {
  const [config, setConfigState] = useState<BYOKActiveConfig | null>(readLs);
  const [storedRefs, setStoredRefs] = useState<readonly string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    // A background refresh refetches silently — it must NOT flip `isLoading`,
    // since the surface gate (`if (isLoading) return <BackendStatusCard>`)
    // would otherwise unmount the live chat and flash the loading card every
    // time the user returns to the tab.
    if (!background) {
      setIsLoading(true);
      setError(null);
    }
    try {
      const refs = await listStoredRefs();
      setStoredRefs(refs);
      // A recovered background refresh clears a prior gating error.
      if (background) setError(null);
    } catch (err) {
      // A background failure must NOT blank the live surface — leave the
      // gating error untouched so a transient tab-return blip is invisible.
      // The next foreground action surfaces any real outage.
      if (!background) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!background) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setConfig = useCallback(async (cfg: BYOKActiveConfig | null) => {
    writeLs(cfg);
    setConfigState(cfg);
    await refresh();
  }, [refresh]);

  // Managed providers (server-held key, `managed:*` sentinel) bypass
  // the storedRefs check — the BE owns the key, and signed-in tenants'
  // /byok/secrets only lists their tenant-scoped BYOK refs. Authority
  // for "is this actually usable?" stays with the BE: a missing
  // managed row surfaces as `managed_unavailable` at dispatch time.
  const isValid =
    config !== null &&
    (config.credentialRef.startsWith('managed:') || storedRefs.includes(config.credentialRef));

  return { config, isValid, storedRefs, setConfig, refresh, isLoading, error };
}
