/**
 * BYOK config — which provider + model + credentialRef is this WORKSPACE using?
 *
 * ADR 0517 rewrote the ownership of this answer. It used to be a bare
 * `localStorage` key, read synchronously, with validity inferred client-side by
 * checking the ref against a fetched list. Three properties of that design
 * combined into a live defect:
 *
 *   1. the pointer lived in ONE browser profile while the key lived on the
 *      server, so losing `localStorage` (second browser, private window, cleared
 *      site data, Safari ITP's 7-day eviction) orphaned a perfectly good key;
 *   2. validity was inferred from `storedRefs.includes(ref)`, so ANY reason the
 *      ref list came back without the ref — most importantly a lapsed session
 *      falling back to a fresh `anon:` tenant that cannot see workspace secrets —
 *      read as "no key" rather than "not logged in";
 *   3. the wizard those two conditions opened always minted a NEW ref
 *      (`byok:<provider>:${Date.now()}`), so each false prompt created a
 *      duplicate secret instead of re-binding the existing one.
 *
 * A real workspace accumulated seven `byok:google:*` rows across five weeks.
 *
 * The rules now:
 *   - the SERVER owns the pointer and owns the `valid` verdict;
 *   - `localStorage` is a first-paint CACHE and a one-way migration source, never
 *     an authority;
 *   - a failed refresh NEVER downgrades a working surface (it holds the last good
 *     state and reports `error`), because the failure modes above were all "a
 *     transient absence was read as a deliberate one";
 *   - "no config" while ANONYMOUS is reported as `session-expired`, distinct from
 *     `needs-key`, so the UI offers sign-in instead of a duplicate-minting wizard;
 *   - an existing stored key for the chosen provider is ADOPTED rather than
 *     re-asked.
 *
 * The credential VALUE never appears here — only ref names.
 *
 * @see docs/adr/0517-byok-active-config-durability.md
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from './providers.js';
import { listStoredRefs, getActiveConfig, putActiveConfig, clearActiveConfig } from './byokClient.js';
import { useStorageSubject } from '../../platform/useStorageSubject.js';

export interface BYOKActiveConfig {
  provider: ProviderId;
  model: string;
  credentialRef: string;
}

/**
 * What the surface should render. Replaces the old `!config || !isValid` boolean
 * soup, which could not tell a signed-out user from a key-less one.
 */
export type BYOKStatus =
  /** The first server round-trip has not settled. */
  | 'loading'
  /** A usable binding is present. */
  | 'ready'
  /** Genuinely no key for this workspace — the honest first-run wizard. */
  | 'needs-key'
  /** Signed out. The workspace's keys still exist; they are just not visible to
   *  an anonymous session. Offer sign-in, NEVER the key wizard. */
  | 'session-expired'
  /** The backend could not be reached. Never a reason to ask for a key again. */
  | 'error';

const LS_KEY = 'openwop-app.byok.activeConfig';

/** How long to let the silent re-auth handshake land before believing an
 *  `anonymous` answer that the auth layer contradicts. One short wait, once. */
const RE_AUTH_GRACE_MS = 1200;

/** The managed-provider sentinel — names no stored secret (the host holds the key). */
export function isManagedRef(ref: string): boolean {
  return ref.startsWith('managed:');
}

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
  try {
    if (cfg === null) {
      localStorage.removeItem(LS_KEY);
      return;
    }
    // Whitelist the exact non-secret fields before caching. The credential VALUE
    // must never reach localStorage (threat-model-secret-leakage); a future field
    // added to BYOKActiveConfig cannot smuggle a secret through here, and a caller
    // passing an over-wide object can't either.
    const safe: BYOKActiveConfig = {
      provider: cfg.provider,
      model: cfg.model,
      credentialRef: cfg.credentialRef,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(safe));
  } catch {
    // A full or blocked quota (private browsing) must not break the surface —
    // the cache is an optimization; the server is the authority.
  }
}

/** Test-only export of the persistence whitelist (threat-model-secret-leakage
 *  invariant). Not part of the hook's public API. */
export { writeLs as __persistConfigForTest };

/**
 * The stored refs belonging to `provider`, best candidate FIRST.
 *
 * Since ADR 0517 refs are minted deterministically as `byok:<provider>`, so that
 * re-storing a key OVERWRITES rather than accumulating. History left
 * `byok:<provider>:<epoch-ms>` rows behind, so both shapes are matched and the
 * newest timestamped ref wins when no canonical one exists. The boundary check is
 * exact-or-colon-delimited so `byok:google` cannot capture `byok:google-vertex`.
 *
 * Mirrors `host/chatByokConfig.ts#refsForProvider` — kept in both places
 * deliberately: the server ENFORCES the binding, the client only PROPOSES one.
 */
export function refsForProvider(refs: readonly string[], provider: string): string[] {
  const base = `byok:${provider}`;
  const mine = refs.filter((r) => r === base || r.startsWith(`${base}:`));
  // Canonical bare ref first, then timestamped refs newest-first.
  return [
    ...mine.filter((r) => r === base),
    ...mine.filter((r) => r !== base).sort().reverse(),
  ];
}

/** The single ref this provider should bind to, or null when it has none stored. */
export function preferredRefForProvider(refs: readonly string[], provider: string): string | null {
  return refsForProvider(refs, provider)[0] ?? null;
}

export interface UseBYOKConfigResult {
  /** The active binding, or null. Server-owned; cache-seeded for first paint. */
  config: BYOKActiveConfig | null;
  /** What the surface should render. Prefer this over the booleans below. */
  status: BYOKStatus;
  /** Back-compat: `status === 'ready'`. */
  isValid: boolean;
  /** Back-compat: `status === 'loading'`. */
  isLoading: boolean;
  /** All credentialRefs stored for this workspace — the adoption pool. */
  storedRefs: readonly string[];
  /** Persist the active binding (server-first; cache follows). */
  setConfig: (cfg: BYOKActiveConfig | null) => Promise<void>;
  /** Re-fetch. `{ background: true }` keeps the current surface mounted. */
  refresh: (opts?: { background?: boolean }) => Promise<void>;
  /** Backend error text, if the last foreground fetch failed. */
  error: string | null;
  /** ADR 0711 option B — false when `config` is the effective managed DEFAULT rather
   *  than a binding somebody chose. Without this the surface presents a fallback as a
   *  selection. Defaults to true, so an older server (which omits the field) and every
   *  cache-seeded first paint read as "chosen", which is the prior behaviour. */
  stored: boolean;
}

export function useBYOKConfig(): UseBYOKConfigResult {
  // Cache-seeded so a returning user's chat paints immediately instead of
  // flashing a wizard while the round-trip lands. The server verdict below
  // either confirms it or replaces it.
  const [config, setConfigState] = useState<BYOKActiveConfig | null>(readLs);
  const [storedRefs, setStoredRefs] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<BYOKStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  // Whether THIS browser has ever held a binding. The session-expiry branch needs
  // "the user had a key before" without treating the cache as an authority.
  // A ref, not state: it must not participate in render or re-trigger effects.
  const hadCachedConfig = useRef<boolean>(readLs() !== null);
  // The live config, readable from a stable callback without making `refresh`
  // depend on it (a changing `refresh` identity would re-run every consumer's
  // visibility effect and re-enter the heal path).
  const configRef = useRef<BYOKActiveConfig | null>(config);
  configRef.current = config;

  // ADR 0517 Phase E — the auth layer's own view, so a backend session that has merely
  // not caught up yet is never mistaken for a user who signed out. Read through
  // a ref for the same reason as `configRef`: `refresh` must keep a stable
  // identity or every consumer's visibility effect re-runs.
  const subjectState = useStorageSubject();
  const subjectRef = useRef(subjectState.status);
  subjectRef.current = subjectState.status;
  // One grace retry per mount. Bounded on purpose: if the handshake genuinely
  // failed, the honest answer is the sign-in card, not an indefinite spinner.
  const reAuthWaited = useRef(false);
  // The grace wait below resolves ~1.2s later, by which time the surface may be
  // gone (route change, tab close). Refreshing then is at best wasted work and at
  // worst a setState into a dead tree, so the wait checks before continuing.
  const mounted = useRef(true);
  const refreshRef = useRef<((opts?: { background?: boolean }) => Promise<void>) | null>(null);
  const [stored, setStored] = useState(true);

  const refresh = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    if (!background) setError(null);
    try {
      const [envelope, refs] = await Promise.all([getActiveConfig(), listStoredRefs()]);
      setStoredRefs(refs);
      setError(null);

      // 1. The server has a binding it vouches for. Done — render it.
      if (envelope.config && envelope.valid) {
        const cfg = envelope.config as BYOKActiveConfig;
        setConfigState(cfg);
        // ADR 0711 option B — CACHE ONLY A CHOSEN BINDING. `stored: false` is the
        // effective managed default the host would dispatch on anyway, not a
        // selection. Writing it to localStorage would launder a fallback into a
        // user's choice: it would then survive as a "cached binding" after the
        // operator set a real one, and the heal path below would re-PUT it — which
        // for a plain member now 403s. Absent `stored` means an older server, where
        // every reported config really was stored.
        setStored(envelope.stored !== false);
        if (envelope.stored !== false) {
          writeLs(cfg);
          hadCachedConfig.current = true;
        }
        setStatus('ready');
        return;
      }

      // 2. No server binding (or one whose key is gone). Try to HEAL before ever
      //    asking the user for a key again. Two sources, in order of confidence:
      //    the server's own stale pointer, then this browser's cached one.
      const candidate = envelope.config ?? configRef.current;
      if (candidate) {
        const ref = isManagedRef(candidate.credentialRef)
          ? candidate.credentialRef
          : (refs.includes(candidate.credentialRef)
            ? candidate.credentialRef
            : preferredRefForProvider(refs, candidate.provider));
        if (ref) {
          // This is also the one-way MIGRATION for every user who predates the
          // server-side pointer: their localStorage binding is promoted on first
          // load and never depends on this browser again.
          const healed: BYOKActiveConfig = { ...candidate, credentialRef: ref };
          try {
            await putActiveConfig(healed);
            setConfigState(healed);
            writeLs(healed);
            hadCachedConfig.current = true;
            setStatus('ready');
            return;
          } catch {
            // The server refused the binding (the ref vanished between the list
            // and the PUT, or validation changed). Fall through to the honest
            // states below rather than painting a binding it won't stand behind.
          }
        }
      }

      // 3. Nothing to heal. Distinguish "signed out" from "no key" — the whole
      //    point of fix D. An anonymous session cannot see the workspace's
      //    secrets, so asking for a key here would mint a duplicate under a
      //    throwaway tenant, which is precisely the reported bug.
      setConfigState(null);
      if (envelope.anonymous && hadCachedConfig.current) {
        // ADR 0517 Phase E — before declaring the session gone, check whether the auth
        // layer disagrees. Firebase persists across the 24h backend cookie, and
        // `reconcileRestoredSession` (ADR 0434 P2) silently re-promotes the
        // backend session from the restored ID token on page load. If that
        // handshake is still in flight, the backend legitimately answers
        // `anonymous:true` for a user who is about to be signed in again — and
        // showing them a sign-in wall would be the same false alarm as the key
        // wizard, one layer up. So when the two disagree, wait for the handshake
        // ONCE rather than believing the earlier answer.
        if (subjectRef.current === 'user' && !reAuthWaited.current) {
          reAuthWaited.current = true;
          await new Promise((r) => setTimeout(r, RE_AUTH_GRACE_MS));
          if (!mounted.current) return;
          await refreshRef.current?.({ background });
          return;
        }
        setStatus('session-expired');
        // Deliberately NOT clearing the cache: it is the evidence that this
        // browser had a working binding, and it is what heals the surface the
        // moment the user signs back in.
        return;
      }
      writeLs(null);
      hadCachedConfig.current = false;
      setStatus('needs-key');
    } catch (err) {
      // A fetch failure is NEVER evidence that the key is gone. Hold the last
      // good surface and report the outage. This inverts the old behaviour,
      // where an empty or failed list read as "no key".
      if (background) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  refreshRef.current = refresh;

  // Set TRUE on every mount, not just at ref creation. React 18 StrictMode runs
  // effect → cleanup → effect, so a cleanup-only version leaves `mounted` false
  // FOREVER after the first cycle — and then the grace retry below always bails
  // out, silently disabling the whole Phase E re-auth heal. Same hazard on any
  // legitimate remount (route change back into the chat).
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /**
   * ADR 0517 Phase E — read only once the auth layer has SETTLED, and re-read whenever
   * the identity changes.
   *
   * Two bugs this closes, both of which produced a confident wrong surface:
   *
   *  - Reading during the boot window raced `reconcileRestoredSession`. The
   *    backend answered for whichever session existed at that instant, so a
   *    returning signed-in user could be told their session had ended a beat
   *    before it was silently restored.
   *  - Never re-reading on an identity change meant the restoration, when it did
   *    land, changed nothing on screen. The user sat looking at a sign-in card
   *    they no longer needed, and clicking it was the only way out.
   *
   * `useStorageSubject` is the app's canonical settled signal (ADR 0434 / IDN-3)
   * and carries its own 5s watchdog, so `pending` cannot hang the surface.
   */
  const subjectKey = subjectState.status === 'user' ? subjectState.subject : subjectState.status;
  useEffect(() => {
    if (subjectState.status === 'pending') return;
    reAuthWaited.current = false; // a new identity gets its own grace retry
    void refresh();
  }, [refresh, subjectKey, subjectState.status]);

  /**
   * Re-read the adoption pool after a mutation. A failure LEAVES THE PREVIOUS
   * LIST IN PLACE, rather than substituting an empty one. Writing empty on a
   * failed read is the precise conflation this whole ADR removes: it makes the UI
   * say "you have no keys" when the truth is "we did not hear back", and the
   * wizard would then find nothing to adopt and mint a duplicate.
   */
  const syncStoredRefs = useCallback(async () => {
    try {
      setStoredRefs(await listStoredRefs());
    } catch {
      // Keep the last known list. It is stale at worst; empty would be a lie.
    }
  }, []);

  const setConfig = useCallback(async (cfg: BYOKActiveConfig | null) => {
    if (cfg === null) {
      await clearActiveConfig();
      // Nothing is stored any more; the next GET will report the effective default.
      setStored(false);
      writeLs(null);
      setConfigState(null);
      hadCachedConfig.current = false;
      setStatus('needs-key');
      await syncStoredRefs();
      return;
    }
    // Server first: if it refuses the binding we must NOT paint a chat that
    // cannot dispatch. The throw propagates to the caller's error surface.
    const saved = await putActiveConfig(cfg);
    const persisted = (saved.config ?? cfg) as BYOKActiveConfig;
    // A binding the user just CHOSE is stored by definition. Without this the flag kept
    // whatever the last GET reported, so the path "managed default → Change → save your own
    // key" left `stored:false` and rendered the not-chosen marker on the binding they had
    // just picked — the exact honesty inversion the marker exists to prevent, running
    // backwards. Trust the server's own answer when it gives one.
    setStored(saved.stored !== false);
    writeLs(persisted);
    setConfigState(persisted);
    hadCachedConfig.current = true;
    setStatus('ready');
    await syncStoredRefs();
  }, [syncStoredRefs]);

  return {
    config,
    status,
    isValid: status === 'ready',
    isLoading: status === 'loading',
    storedRefs,
    setConfig,
    refresh,
    error,
    stored,
  };
}
