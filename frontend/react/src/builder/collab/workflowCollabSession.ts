/**
 * ADR 0481 — the workflow room client (the builder's `useCollab` mirror).
 *
 * When enabled it provisions a Yjs `Doc` + `WebsocketProvider` against the
 * workflow lane of the shared collab transport
 * (`/host/openwop-app/workflow-collab/:workflowId` — the ADR 0481 resource
 * beside the canvas lane), runs the backend seeder election (`claim-seed` —
 * the CAS winner seeds the room from the loaded builder store snapshot), and
 * attaches the store adapter (`workflowCollabAdapter`) so builder mutations,
 * remote edits, per-user undo, and the `definition` derive scalar all flow.
 *
 * Auth mirrors the canvas client: the session cookie is host-scoped, so the
 * cross-origin WS upgrade carries a short-lived ticket minted over the
 * same-origin `/api` (`?ticket=`); same-origin postures fall back cookie-only.
 *
 * `probeWorkflowCollabAvailable` is the toolbar's visibility probe: the ticket
 * route answers a uniform 404 unless BOTH collab toggles are on AND the
 * workflow is room-eligible — a miss hides the affordance silently. Cached
 * per workflowId (definitive HTTP answers only; network errors retry).
 *
 * BUNDLE: `yjs`/`y-websocket`/`y-protocols`/`collabDocBinding` are dynamically
 * imported only when a session starts — they never enter an eager chunk (the
 * collabDocBinding bundle rule; type-only imports erase).
 */
import { useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { config, authedHeaders, fetchOpts } from '../../client/config.js';
import type { CollabDocBinding } from '../../canvas/collabDocBinding.js';
import { WORKFLOW_COLLAB_SHAPE } from './workflowCollabShape.js';
import { attachWorkflowCollabAdapter, type WorkflowCollabAdapter } from './workflowCollabAdapter.js';

type Dict = Record<string, unknown>;

const ticketUrl = (workflowId: string): string =>
  `${config.baseUrl}/host/openwop-app/workflow-collab/${encodeURIComponent(workflowId)}/ticket`;

const availabilityCache = new Map<string, Promise<boolean>>();

/** One probe per workflowId, cached. 404 (toggle off / ineligible) ⇒ false —
 *  the affordance hides silently; a thrown fetch (offline) also answers false
 *  but is NOT cached, so a later mount re-probes. */
export function probeWorkflowCollabAvailable(workflowId: string): Promise<boolean> {
  const cached = availabilityCache.get(workflowId);
  if (cached) return cached;
  const probe = (async () => {
    const resp = await fetch(
      ticketUrl(workflowId),
      fetchOpts({ method: 'POST', headers: authedHeaders(), signal: AbortSignal.timeout(10_000) }),
    );
    return resp.ok;
  })().catch(() => {
    availabilityCache.delete(workflowId);
    return false;
  });
  availabilityCache.set(workflowId, probe);
  return probe;
}

export interface WorkflowCollabLive {
  active: true;
  /** 'connecting' until first sync + seed election complete; 'failed' when no
   *  first sync landed inside the window (the provider keeps retrying — a
   *  late sync still goes live; leaving + rejoining re-provisions). */
  status: 'connecting' | 'live' | 'failed';
  /** Live socket status (y-websocket auto-reconnects; this reflects it). */
  connected: boolean;
  awareness: Awareness;
  /** Per-user Y.UndoManager verbs (live only; no-ops before). */
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
}
export type WorkflowCollabState = { active: false } | WorkflowCollabLive;

const OFF: WorkflowCollabState = { active: false };

/** No first sync inside this window ⇒ `failed` (covers a cold Cloud Run start). */
const FIRST_SYNC_TIMEOUT_MS = 20_000;

export function useWorkflowCollabSession({ workflowId, enabled }: {
  workflowId: string;
  enabled: boolean;
}): WorkflowCollabState {
  const [state, setState] = useState<WorkflowCollabState>(OFF);

  useEffect(() => {
    if (!enabled || !workflowId) {
      setState(OFF);
      return;
    }
    let disposed = false;
    let teardown: (() => void) | null = null;

    void (async () => {
      // ONE deadline bounds ticket mint AND first sync (the UX-B2 discipline).
      const failDeadline = Date.now() + FIRST_SYNC_TIMEOUT_MS;
      const [Y, { WebsocketProvider }, { Awareness }, { createCollabDocBinding }] = await Promise.all([
        import('yjs'), import('y-websocket'), import('y-protocols/awareness'),
        import('../../canvas/collabDocBinding.js'),
      ]);
      if (disposed) return;
      // Cross-origin upgrade credential; a failed mint degrades to cookie-only.
      let ticket: string | null = null;
      try {
        const resp = await fetch(
          ticketUrl(workflowId),
          fetchOpts({ method: 'POST', headers: authedHeaders(), signal: AbortSignal.timeout(10_000) }),
        );
        if (resp.ok) ticket = ((await resp.json()) as { ticket?: string }).ticket ?? null;
      } catch { /* cookie fallback */ }
      if (disposed) return;
      const ydoc = new Y.Doc();
      const awareness = new Awareness(ydoc);
      // Direct-to-backend absolute ws(s) URL (the /api CDN can't proxy a WS
      // upgrade; a relative base resolves against the page origin).
      const httpBase = new URL(config.sseBaseUrl || config.baseUrl, window.location.href).toString().replace(/\/$/, '');
      const wsBase = httpBase.replace(/^http/, 'ws');
      const provider = new WebsocketProvider(
        `${wsBase}/host/openwop-app/workflow-collab`, workflowId, ydoc,
        { awareness, connect: true, ...(ticket ? { params: { ticket } } : {}) },
      );
      let binding: CollabDocBinding<Dict> | null = null;
      let adapter: WorkflowCollabAdapter | null = null;
      let offStack: (() => void) | null = null;
      let goingLive = false;
      const failTimer = setTimeout(() => {
        if (!disposed) setState((s) => (s.active && s.status === 'connecting' ? { ...s, status: 'failed' } : s));
      }, Math.max(0, failDeadline - Date.now()));
      const onSync = (isSynced: boolean): void => {
        if (disposed || !isSynced || goingLive) return;
        goingLive = true;
        void (async () => {
          // Seeder election — the backend CAS is the authority; the winner
          // writes the loaded working copy into the fresh room.
          let seed = false;
          try {
            const url = `${config.baseUrl}/host/openwop-app/workflow-collab/${encodeURIComponent(workflowId)}/claim-seed`;
            const resp = await fetch(url, fetchOpts({ method: 'POST', headers: authedHeaders() }));
            if (resp.ok) seed = ((await resp.json()) as { seed?: boolean }).seed === true;
          } catch { /* a failed election leaves the room unseeded for a retry */ }
          if (disposed) return;
          clearTimeout(failTimer);
          binding = createCollabDocBinding<Dict>(ydoc, WORKFLOW_COLLAB_SHAPE);
          adapter = attachWorkflowCollabAdapter(binding, { seed });
          if (!adapter) {
            // code-H1 (FE half) — joiner blank-wipe bailout: the election said
            // another client seeded, yet the synced room is EMPTY (no nodes,
            // edges, or name). Applying it would materialize a blank doc over
            // the user's real workflow — fail the session without touching the
            // store; leaving + rejoining re-provisions.
            binding.destroy();
            binding = null;
            setState((s) => (s.active ? { ...s, status: 'failed' } : s));
            return;
          }
          offStack = adapter.onStackChanged(() => {
            if (disposed || !adapter) return;
            const a = adapter;
            setState((s) => (s.active ? { ...s, canUndo: a.canUndo(), canRedo: a.canRedo() } : s));
          });
          setState((s) => (s.active ? { ...s, status: 'live', canUndo: false, canRedo: false } : s));
        })();
      };
      provider.on('sync', onSync);
      const onStatus = ({ status }: { status: string }): void => {
        if (!disposed) setState((s) => (s.active ? { ...s, connected: status === 'connected' } : s));
      };
      provider.on('status', onStatus);
      setState({
        active: true,
        status: 'connecting',
        connected: false,
        awareness,
        undo: () => adapter?.undo(),
        redo: () => adapter?.redo(),
        canUndo: false,
        canRedo: false,
      });
      teardown = () => {
        clearTimeout(failTimer);
        provider.off('sync', onSync);
        provider.off('status', onStatus);
        offStack?.();
        try {
          adapter?.destroy(); // resumes autosave + one catch-up sync + stack clear
        } finally {
          // A throwing final flush (code-M4) must not leak the socket/doc.
          binding?.destroy();
          provider.destroy(); // closes the socket + awareness cleanup
          ydoc.destroy();
        }
      };
    })();

    return () => {
      disposed = true;
      teardown?.();
      setState(OFF);
    };
  }, [workflowId, enabled]);

  return state;
}
