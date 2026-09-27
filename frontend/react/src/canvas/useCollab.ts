/**
 * `useCollab` — the chassis real-time-collaboration seam (ADR 0335 Phase 2a).
 *
 * When `enabled` (the `realtime-collab` toggle is on for the tenant AND a
 * persisted `canvasId` exists), it provisions a Yjs `Doc` + a `WebsocketProvider`
 * to the backend collab transport (`/host/openwop-app/canvas-collab/:canvasId`
 * — the Phase 1 auth-boundary WS, generalized to any registered collab-capable
 * type by ADR 0359) + an `Awareness` channel, and returns opaque handles a
 * surface binds via `y-prosemirror` (or the Phase 3 element binding). When
 * disabled it is a no-op returning `{ enabled: false }`, so the single-writer
 * path is untouched. Provisioned by the CHASSIS (`CanvasEditorPage`) since
 * ADR 0359 D2 — surfaces receive the session via `EditorSurfaceProps.collab`.
 *
 * The provider connects DIRECT to the backend origin (`config.sseBaseUrl`, the
 * same `*.run.app` bypass SSE uses — the `/api` CDN cannot proxy a WS upgrade).
 * The session cookie is HOST-SCOPED to the app origin and never travels there,
 * so auth crosses origins via a short-lived ticket minted over the same-origin
 * `/api` and carried in the provider's `?ticket=` param (the WS API can't set
 * headers). Same-origin postures (the dev proxy) still work cookie-only when
 * the mint fails. Phase 1a Origin-checks the upgrade against
 * `OPENWOP_CORS_ORIGINS`.
 *
 * BUNDLE: `yjs`/`y-websocket`/`y-protocols` are **dynamically imported** only when
 * a session starts, so they never enter the entry (or initial doc-editor) chunk.
 */
import { useEffect, useState } from 'react';
import type { Doc as YDoc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { config, authedHeaders, fetchOpts } from '../client/config.js';

export interface CollabSession {
  enabled: true;
  ydoc: YDoc;
  awareness: Awareness;
  /** True once the initial state has synced with the server. */
  synced: boolean;
  /** Live socket status (ADR 0359 Phase 4 — drives the presence chip's
   *  "Live" vs "Reconnecting…"). The provider auto-reconnects; this only
   *  reflects it honestly. */
  connected: boolean;
  /** ADR 0359 grade pass (UX-B2): TERMINAL-ish provisioning failure — no
   *  first sync within the timeout. The provider keeps retrying underneath,
   *  and a late sync clears it, but the UI must stop showing an infinite
   *  spinner and offer an explicit Retry (bump `attempt`). */
  failed: boolean;
  /** The backend seeder election (ADR 0335 2b, chassis-owned since ADR 0359 D2):
   *  single-flight POST to `claim-seed`; resolves true iff THIS client won and
   *  must seed the fresh room from the loaded host.canvas doc (the surface /
   *  binding applies the content — the chassis only owns the election +
   *  transport URL). Repeat calls return the same promise. */
  claimSeed: () => Promise<boolean>;
}
export type CollabState = { enabled: false } | CollabSession;

const DISABLED: CollabState = { enabled: false };

/** No first sync within this window ⇒ `failed` (the UI swaps its spinner for
 *  an error + Retry). Generous: covers a cold Cloud Run start. */
const FIRST_SYNC_TIMEOUT_MS = 20_000;

export function useCollab({ canvasId, enabled, attempt = 0 }: { canvasId: string | undefined; enabled: boolean; attempt?: number }): CollabState {
  const [state, setState] = useState<CollabState>(DISABLED);

  useEffect(() => {
    if (!enabled || !canvasId) { setState(DISABLED); return; }
    let disposed = false;
    let teardown: (() => void) | null = null;

    void (async () => {
      // UX-B2 honesty: ONE deadline bounds the whole provision — ticket mint
      // AND first sync. The fail timer below is armed with whatever is left,
      // so a slow mint can never stretch total time-to-feedback past the
      // advertised ceiling.
      const failDeadline = Date.now() + FIRST_SYNC_TIMEOUT_MS;
      const [Y, { WebsocketProvider }, { Awareness }] = await Promise.all([
        import('yjs'), import('y-websocket'), import('y-protocols/awareness'),
      ]);
      if (disposed) return;
      // Cross-origin upgrade credential (see the header note). Best-effort:
      // a failed mint falls back to the cookie-only connect.
      let ticket: string | null = null;
      try {
        const mintUrl = `${config.baseUrl}/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}/ticket`;
        // Bounded: the mint runs BEFORE the provider (and its `failed` ceiling)
        // exists — a hung mint must degrade to the cookie path, not stall the
        // whole provision behind the chassis spinner (UX-B2).
        const resp = await fetch(mintUrl, fetchOpts({ method: 'POST', headers: authedHeaders(), signal: AbortSignal.timeout(10_000) }));
        if (resp.ok) ticket = ((await resp.json()) as { ticket?: string }).ticket ?? null;
      } catch { /* cookie fallback */ }
      if (disposed) return;
      const ydoc = new Y.Doc();
      const awareness = new Awareness(ydoc);
      // Direct-to-backend, http(s)→ws(s); the room name (canvasId) is appended by
      // the provider as the final path segment. A RELATIVE base (the dev-server
      // `/api` proxy posture) resolves against the page origin — the provider
      // needs an absolute ws(s) URL (the Phase 7 e2e finding).
      const httpBase = new URL(config.sseBaseUrl || config.baseUrl, window.location.href).toString().replace(/\/$/, '');
      const wsBase = httpBase.replace(/^http/, 'ws');
      const provider = new WebsocketProvider(
        `${wsBase}/host/openwop-app/canvas-collab`, canvasId, ydoc,
        { awareness, connect: true, ...(ticket ? { params: { ticket } } : {}) },
      );
      // UX-B2 — the infinite-spinner ceiling: without a first sync inside the
      // window, surface `failed` (cleared by a late sync; Retry re-provisions).
      const failTimer = setTimeout(() => {
        if (!disposed) setState((s) => (s.enabled && !s.synced ? { ...s, failed: true } : s));
      }, Math.max(0, failDeadline - Date.now()));
      const onSync = (isSynced: boolean) => {
        if (disposed) return;
        if (isSynced) clearTimeout(failTimer);
        setState((s) => (s.enabled ? { ...s, synced: isSynced, failed: isSynced ? false : s.failed } : s));
      };
      provider.on('sync', onSync);
      const onStatus = ({ status }: { status: string }) => {
        if (!disposed) setState((s) => (s.enabled ? { ...s, connected: status === 'connected' } : s));
      };
      provider.on('status', onStatus);
      // Single-flight seeder election (the CAS on the backend is the authority;
      // this guard only avoids duplicate POSTs from one client).
      let seedPromise: Promise<boolean> | null = null;
      const claimSeed = (): Promise<boolean> => {
        seedPromise ??= (async () => {
          try {
            const url = `${config.baseUrl}/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}/claim-seed`;
            const resp = await fetch(url, fetchOpts({ method: 'POST', headers: authedHeaders() }));
            if (!resp.ok) return false;
            const { seed } = await resp.json() as { seed: boolean };
            return seed === true;
          } catch {
            return false; // best-effort — a failed election leaves the room unseeded for a retry
          }
        })();
        return seedPromise;
      };
      setState({ enabled: true, ydoc, awareness, synced: false, connected: false, failed: false, claimSeed });
      teardown = () => {
        clearTimeout(failTimer);
        provider.off('sync', onSync);
        provider.off('status', onStatus);
        provider.destroy();      // closes the socket + awareness cleanup
        ydoc.destroy();
      };
    })();

    return () => { disposed = true; teardown?.(); setState(DISABLED); };
    // `attempt` re-provisions the whole session (the UX-B2 Retry).
  }, [canvasId, enabled, attempt]);

  return state;
}
