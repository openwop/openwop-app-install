/**
 * Real-time collaboration transport (ADR 0335 Phase 1 — the DORMANT auth boundary).
 *
 * A WebSocket `upgrade` handler for the host-extension path
 * `/v1/host/openwop-app/canvas-collab/:canvasId` (non-normative — no OpenWOP
 * wire, no RFC per the ADR wire verdict; renamed from `document-collab` while
 * dormant, ADR 0359 D1 — any registered collab-capable canvas type, not just
 * canvas.document). This first increment does AUTH ONLY —
 * NO Yjs sync, NO Postgres LISTEN/NOTIFY, NO persistence yet — so it adds zero
 * DB/socket load until the CRDT layer arrives, and proves the security boundary
 * in isolation (the ADR's mandated "before any code" review).
 *
 * A raw upgrade BYPASSES the Express middleware chain, so this replicates what it
 * skips (the load-bearing findings from the /architect review):
 *   1. Origin allowlist (`originPolicy`) — CORS does NOT govern WebSockets, so
 *      this is the CSWSH (cross-site WebSocket hijacking) defense.
 *   2. `?ticket=` (cross-origin prod; minted over `/api`) or `__session` →
 *      tenant (authn; the cookie is the same identity as HTTP).
 *   3. `realtime-collab` toggle gate (per tenant; OFF ⇒ advertises nothing).
 *   4. `getCanvasForTenant` — tenant + type authorization (uniform 404, no
 *      cross-tenant document join, no existence leak).
 *   5. Per-tenant connection cap (flood + the pg-connection amplifier later).
 * Every failure rejects the HTTP upgrade (never completes the handshake for an
 * unauthorized socket) and fails closed.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { base64urlDecode, base64urlEncode, readSessionSecret, verifySession } from '../../middleware/cookieSession.js';
import { originPolicy } from '../../middleware/cors.js';
import { getCanvasForTenant, type CanvasRecordView } from '../canvasSurface.js';
import { resolveSubjectAccess, levelSatisfies } from '../subjectAccess.js';
import { resolveCallerUser } from '../../features/users/usersGuards.js';
import { resolveOne } from '../featureToggles/service.js';
import { DurableCollection } from '../hostExtPersistence.js';
import { requireFeatureEnabled, toggleSubjectOf } from '../../features/featureRoute.js';
import { tenantOf } from '../requestSubject.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { joinCollabRoom, initCollabFanout, pruneCollabSnapshot, startCollabUpdateSweep, startCollabLeaseHeartbeat, hasLiveRoomGlobal, hasCollabSnapshot, applyExternalState, notifyExternalCanvasWrite, listLiveRooms, setSeedClaimRestorer } from './collabRoom.js';
import { requireSuperadmin } from '../superadmin.js';
import { collabCanvasType } from './collabRegistry.js';
import { onCanvasDeleted, onCanvasStateWrite } from '../canvasLifecycle.js';
import type { BackendFeature } from '../../features/types.js';

const log = createLogger('host.collab');

export const COLLAB_TOGGLE_ID = 'realtime-collab';
const COOKIE_NAME = process.env.OPENWOP_SESSION_COOKIE_NAME || '__session';
// The optional `/api` prefix mirrors the Express strip (index.ts) — a raw
// upgrade BYPASSES that middleware, so proxied posture (Firebase `/api`
// rewrite; the dev-server `/api` proxy) reaches here un-stripped (the
// ADR 0359 Phase 7 e2e finding).
//
// `/v1` is OPTIONAL: ADR 0671 moved the SPA to the canonical, version-agnostic
// `/host/<org>/…` root (RFC 0181). The Express negotiator rewrites that onto the
// `/v1` twin, but a raw upgrade never reaches Express, so this matcher must take
// both spellings itself. It took only `/v1` from #3796 until this fix, and every
// SPA collab socket hung un-upgraded ("Reconnecting…"; collab.spec red).
const PATH_RE = /^(?:\/api)?(?:\/v1)?\/host\/openwop-app\/(canvas-collab|workflow-collab)\/([^/?#]+)/;
/** Per-tenant concurrent-connection cap on this instance (flood guard).
 *  Env-tunable (ADR 0359 OQ-4, closed with the residuals pass) — six collab-
 *  capable types share the budget, so a busy tenant may legitimately need more.
 *  NOTE: 0/absent/invalid all fall back to 25 — "0 = unlimited" is deliberately
 *  not expressible (an uncapped flood guard is no guard). */
const MAX_CONNS_PER_TENANT = Number(process.env.OPENWOP_COLLAB_MAX_CONNS_PER_TENANT) > 0
  ? Number(process.env.OPENWOP_COLLAB_MAX_CONNS_PER_TENANT)
  : 25;

/**
 * Toggle carrier (registered via the standard feature loop so it re-registers on
 * every boot + test setup and shows in the admin toggle list). The TRANSPORT is
 * this host module; the feature has no routes (the WS attaches to the http.Server
 * in `main()`, post-listen — see `attachCollabWebSocket`).
 */
// ── Phase 2b — seeder election ─────────────────────────────────────────────
// A fresh collab room's Y.Doc is empty; ONE client must seed it from the
// host.canvas document (else the doc appears blank), and only one, or the seed
// content duplicates. Elect the seeder with an insert-if-absent CAS (correct
// across the ≤5 instances) — the winner gets `{seed:true}` and seeds; the rest
// receive the seeded content via normal sync.
// ADR 0359 grade pass (DATA-B3): rows carry the tenant so account/tenant
// teardown's purge matches them (the composite id embeds it, but tenant ids
// themselves contain ':' — an explicit field beats parsing).
interface CollabSeedClaim { id: string; tenantId?: string; claimedBy: string; at: string }
const seedClaims = new DurableCollection<CollabSeedClaim>('collab:seedclaim', (c) => c.id, undefined, (c) => c.tenantId ?? 'untenanted');

/** Insert-if-absent CAS; true iff THIS caller won the election for the canvas. */
export async function claimCollabSeed(tenantId: string, canvasId: string, claimedBy: string): Promise<boolean> {
  return seedClaims.compareAndSwap(null, { id: `${tenantId}:${canvasId}`, tenantId, claimedBy, at: new Date().toISOString() });
}

/** Test-only: clear seed claims. */
export function __resetCollabSeedClaims(): Promise<void> { return seedClaims.__clear(); }

/** ADR 0481 (code-review H1) — delete a room's seed claim (the workflow
 *  deletion hook needs it: a stale consumed claim over an empty snapshot
 *  bricks every future room for a recreated id — seed:false forever, and
 *  unlike the canvas lane there is no invalidation heal path). */
export async function deleteCollabSeedClaim(tenantId: string, roomId: string): Promise<void> {
  await seedClaims.delete(`${tenantId}:${roomId}`);
}

/** ADR 0610 collab-lane / SLC-1 — the collab lane (ticket-mint / claim-seed / WS
 *  upgrade) is the SIBLING door of the REST `loadCanvas` choke, which ADR 0610
 *  gated on `resolveSubjectAccess`. A project/user-owned canvas is membership-scoped;
 *  the tenant + canvas-type + toggle gate is NOT sufficient. Consult the ONE
 *  `host/subjectAccess.ts` seam — READ minimum to JOIN a room (write is org-scoped
 *  per ADR 0054, so a `workspace:write` holder resolves 'write' ≥ 'read'). Null ⇒
 *  not membership-scoped ⇒ the tenant gate stands. **`caller` MUST be the canonical
 *  `User.userId`** — which is ITSELF `user:<hash>` (`usersService.userIdFor`). The
 *  seam prefixes it ONCE MORE (`user:${User.userId}`) to match stored member refs +
 *  org subjects, so pass it UN-stripped, exactly as REST `loadCanvas(user.userId)`
 *  does; a bare hash matches nothing and denies every legitimate joiner. */
async function collabCanvasReadable(tenantId: string, canvas: CanvasRecordView, caller: string | undefined): Promise<boolean> {
  if (!canvas.ownerSubject) return true;
  const level = await resolveSubjectAccess(tenantId, canvas.ownerSubject, caller);
  return level === null || levelSatisfies(level, 'read');
}
/** Fallback for tenant-less deletion paths (boot seeds): field-match scan of
 *  the tiny claims store. */
export async function deleteCollabSeedClaimsAnyTenant(roomId: string): Promise<void> {
  for (const c of await seedClaims.list()) {
    if (c.id.endsWith(`:${roomId}`)) await seedClaims.delete(c.id);
  }
}

// Grade pass 3 (F1) — a live room that survives a store invalidation restores
// its seed claim so a later opener can't win a SECOND seed into the non-empty
// room. Registered here (this module owns the collection; collabRoom importing
// it would cycle).
setSeedClaimRestorer(async (tenantId, canvasId) => {
  await seedClaims.compareAndSwap(null, { id: `${tenantId}:${canvasId}`, tenantId, claimedBy: 'invalidation-survivor', at: new Date().toISOString() });
});

export const collaborationFeature: BackendFeature = {
  id: COLLAB_TOGGLE_ID,
  registerRoutes: ({ app }) => {
    // Data hygiene (ADR 0335 grading) — a deleted canvas.document has no reachable
    // collab surface; prune its durable snapshot + seeder claim (transient
    // collab:update rows self-prune after 30 s). Mirrors comments' onCanvasDeleted.
    onCanvasDeleted('collab', async ({ tenantId, canvasId, canvasTypeId }) => {
      // ADR 0359 D1 — any collab-capable type prunes (registry-gated; deletes
      // are idempotent so a never-joined canvas is a cheap no-op pair).
      if (!collabCanvasType(canvasTypeId)) return;
      await pruneCollabSnapshot(canvasId);
      await seedClaims.delete(`${tenantId}:${canvasId}`);
    });
    // ADR 0359 Phase 6 / D6 — never two silent authorities. Every EXTERNAL
    // host.canvas write (editor CAS, AI authoring, run write, restore) flows
    // through these hooks:
    //  - live room + element shape ⇒ APPLY the write into the room (server-
    //    origin whole-doc replace, fanned to every client + instance);
    //  - live `canvas.document` room (no generic apply for an XmlFragment) ⇒
    //    typed 409 `canvas_room_live` — the OQ-3 fallback, honest not silent;
    //  - NO live room but a durable CRDT snapshot ⇒ INVALIDATE the store
    //    (snapshot + seed claim): host.canvas is the authority again and the
    //    next session's seeder election re-seeds from it.
    // Collab's own derive writes bypass with `source: 'collab'`.
    // Liveness is CROSS-INSTANCE (ADR 0359 grade pass B1): the lease store, not
    // this process's room map — a room live on another of the ≤5 instances must
    // still veto / receive the apply, and must never be invalidated under.
    onCanvasStateWrite('collab', {
      before: async ({ canvasId, canvasTypeId }) => {
        const entry = collabCanvasType(canvasTypeId);
        if (entry && !entry.shape && await hasLiveRoomGlobal(canvasId)) {
          throw new OpenwopError('canvas_room_live', 'This document is in a live collaboration session; changes cannot be applied externally until it ends.', 409, { canvasId });
        }
      },
      after: async ({ tenantId, canvasId, canvasTypeId, state }) => {
        const entry = collabCanvasType(canvasTypeId);
        if (!entry) return;
        if (entry.shape && await hasLiveRoomGlobal(canvasId)) {
          applyExternalState(canvasId, entry.shape, state); // local fast-path (no-op if the room lives elsewhere)
          await notifyExternalCanvasWrite(canvasId);        // peers re-read host.canvas and apply
          return;
        }
        if (!(await hasLiveRoomGlobal(canvasId)) && await hasCollabSnapshot(canvasId)) {
          await pruneCollabSnapshot(canvasId);
          await seedClaims.delete(`${tenantId}:${canvasId}`);
          log.info('collab store invalidated by external write', { canvasId, canvasTypeId });
        }
      },
    });
    // Grade-pass CODE-7 — operator introspection: THIS instance's live rooms
    // (lifecycle metadata only, never content). Superadmin, like the other
    // admin surfaces; per-instance by design (each instance reports its own
    // rooms; the lease store is the cross-instance view).
    app.get('/v1/host/openwop-app/canvas-collab/_debug', (req, res, next) => {
      try {
        requireSuperadmin(req, 'The collaboration debug surface');
        res.json({ instanceRooms: listLiveRooms() });
      } catch (err) { next(err); }
    });
    // The seeder-election HTTP verb (the WS transport itself is on the
    // http.Server, attached in main()). Gated by the realtime-collab toggle +
    // the canvas type's OWN toggle + tenant-scoped canvas authorization
    // (uniform 404 for every miss — ADR 0359 architect HIGH-1).
    // Ticket mint (ADR 0359 correction — prod cross-origin WS auth). Same
    // uniform gate chain as claim-seed; the response hands the caller a
    // short-lived, canvas+tenant-scoped upgrade credential for the direct
    // backend origin, where the app-origin session cookie cannot follow.
    app.post('/v1/host/openwop-app/canvas-collab/:canvasId/ticket', (req, res, next) => {
      void (async () => {
        try {
          await requireFeatureEnabled(req, COLLAB_TOGGLE_ID, 'Real-time collaboration');
          const tenantId = tenantOf(req);
          const canvasId = req.params.canvasId ?? '';
          const canvas = await getCanvasForTenant(tenantId, canvasId);
          const entry = canvas ? collabCanvasType(canvas.canvasTypeId) : undefined;
          if (!canvas || !entry) throw new OpenwopError('not_found', 'canvas not found', 404, {});
          const typeAssignment = await resolveOne(entry.toggleId, toggleSubjectOf(req));
          if (!typeAssignment?.enabled) throw new OpenwopError('not_found', 'canvas not found', 404, {});
          // ADR 0458 grade-pass B1 — a type may declare an extra authorization
          // predicate (the challenge-outline's `host:kicktodo:manage`); the room
          // credential is refused for a member who lacks it.
          if (entry.authorize) await entry.authorize(req);
          // ADR 0610 collab-lane / SLC-1 — a member gate over the project/user owner.
          // resolveCallerUser().userId is the canonical User.userId (=user:<hash>),
          // un-stripped as the seam expects. Uniform 404.
          const caller = (await resolveCallerUser(req)).userId;
          if (!(await collabCanvasReadable(tenantId, canvas, caller))) throw new OpenwopError('not_found', 'canvas not found', 404, {});
          res.json({ ticket: mintCollabTicket(tenantId, canvasId, Date.now(), req.principal?.principalId) });
        } catch (err) { next(err); }
      })();
    });
    app.post('/v1/host/openwop-app/canvas-collab/:canvasId/claim-seed', (req, res, next) => {
      void (async () => {
        try {
          await requireFeatureEnabled(req, COLLAB_TOGGLE_ID, 'Real-time collaboration');
          const tenantId = tenantOf(req);
          const canvasId = req.params.canvasId ?? '';
          const canvas = await getCanvasForTenant(tenantId, canvasId);
          const entry = canvas ? collabCanvasType(canvas.canvasTypeId) : undefined;
          if (!canvas || !entry) throw new OpenwopError('not_found', 'canvas not found', 404, {});
          // The type's OWN toggle — same UNIFORM body as the misses above (the
          // WS path is strictly uniform; a distinct "feature off" envelope
          // would make the two 404s distinguishable).
          const typeAssignment = await resolveOne(entry.toggleId, toggleSubjectOf(req));
          if (!typeAssignment?.enabled) throw new OpenwopError('not_found', 'canvas not found', 404, {});
          // B1 — the same per-type predicate gates the seeder-election verb.
          if (entry.authorize) await entry.authorize(req);
          // ADR 0610 collab-lane / SLC-1 — same member gate as ticket-mint.
          const caller = (await resolveCallerUser(req)).userId;
          if (!(await collabCanvasReadable(tenantId, canvas, caller))) throw new OpenwopError('not_found', 'canvas not found', 404, {});
          const seed = await claimCollabSeed(tenantId, canvasId, req.principal?.principalId ?? tenantId);
          res.json({ seed });
        } catch (err) { next(err); }
      })();
    });
  },
  toggleDefault: {
    id: COLLAB_TOGGLE_ID,
    label: 'Real-time collaboration',
    description:
      'Real-time multiplayer co-editing (Yjs CRDT) for collab-capable canvas types, behind a self-hosted WebSocket sync service. OFF by default — a cross-cutting infrastructure program (ADR 0335 transport, ADR 0359 chassis-core standardization); a type is live only when BOTH this toggle and the type’s own toggle are on.',
    category: 'Documents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'realtime-collab',
  },
};

/**
 * Cross-origin WS auth (ADR 0359 correction, prod posture): the socket targets
 * the DIRECT backend origin (Firebase Hosting rewrites cannot proxy a WS
 * upgrade), where the SPA's host-scoped `__session` cookie never travels. A
 * short-lived HMAC ticket — minted over the same-origin `/api` by the route
 * below, carried in the provider's `?ticket=` param — hands the authenticated
 * tenant across origins instead. Stateless by design: multi-instance (no
 * consume table); scoped to ONE canvas + tenant; expiry bounds a log-leaked
 * token. Signed with the session secret under a distinct prefix so a ticket
 * can never replay as a session cookie (nor vice versa).
 */
const TICKET_PREFIX = 'owp-collab-ticket.v1';
/** Long enough that y-websocket's static-params auto-reconnect keeps working
 *  across mid-session drops; an expired ticket needs the UI Retry (fresh
 *  provision ⇒ fresh mint). */
const TICKET_TTL_MS = 2 * 60 * 60 * 1000;

export function mintCollabTicket(tenantId: string, canvasId: string, now: number = Date.now(), principalId?: string): string {
  const payload: Record<string, unknown> = { t: tenantId, c: canvasId, exp: now + TICKET_TTL_MS };
  if (principalId) payload.u = principalId; // attribution only — authz stays tenant-scoped
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', readSessionSecret()).update(`${TICKET_PREFIX}.${payloadB64}`).digest();
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

/** Null on ANY defect (shape, signature, expiry, canvas mismatch) — fail
 *  closed, with a reason-CLASS log per branch (never the ticket bytes) so a
 *  canary operator can tell "expired" from "tampered" in the logs. */
export function verifyCollabTicket(ticket: string, canvasId: string, now: number = Date.now()): { tenantId: string; principalId?: string } | null {
  const reject = (reason: string): null => { log.warn('collab ticket rejected', { reason, canvasId }); return null; };
  const dot = ticket.indexOf('.');
  if (dot <= 0) return reject('shape');
  const payloadB64 = ticket.slice(0, dot);
  const expected = createHmac('sha256', readSessionSecret()).update(`${TICKET_PREFIX}.${payloadB64}`).digest();
  let provided: Buffer;
  try { provided = base64urlDecode(ticket.slice(dot + 1)); } catch { return reject('shape'); }
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) return reject('signature');
  try {
    const p = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as { t?: unknown; c?: unknown; exp?: unknown; u?: unknown };
    if (typeof p.t !== 'string' || !p.t) return reject('shape');
    if (p.c !== canvasId) return reject('canvas-mismatch');
    if (typeof p.exp !== 'number' || p.exp < now) return reject('expired');
    return { tenantId: p.t, ...(typeof p.u === 'string' && p.u ? { principalId: p.u } : {}) };
  } catch { return reject('shape'); }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Reject the upgrade with an HTTP status — never complete the handshake for an
 *  unauthorized socket. */
function deny(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const connsByTenant = new Map<string, number>();

function releaseConn(tenantId: string): void {
  const n = (connsByTenant.get(tenantId) ?? 1) - 1;
  if (n <= 0) connsByTenant.delete(tenantId); else connsByTenant.set(tenantId, n);
}

/**
 * Attach the collaboration WebSocket upgrade handler to the http.Server. Called
 * from `main()` after `app.listen()` (which returns the Server createApp does not
 * expose); tests attach it to their own `app.listen(0)` server.
 */
export function attachCollabWebSocket(server: Server): void {
  // Phase 1b-ii — subscribe this instance to the cross-instance fan-out channel
  // (idempotent; reuses the storage pub/sub — one multiplexed LISTEN on Postgres).
  void initCollabFanout();
  // ADR 0359 Phase 1 — sweep writer-crash-orphaned collab:update rows (the
  // 30 s self-prune is best-effort; a crashed writer leaves the row forever).
  startCollabUpdateSweep();
  // ADR 0359 grade pass (B1) — cross-instance room-liveness heartbeat.
  startCollabLeaseHeartbeat();
  // maxPayload bounds a single frame (DoS guard) — generous for a Yjs update,
  // finite for an adversarial one. Env-tunable (grade-pass CODE-6): the initial
  // sync-step-2 carries the FULL document state, so a canvas whose encoded
  // state exceeds the cap would silently never finish syncing; an operator can
  // raise the cap without a code change if a legitimate doc hits it.
  const maxPayload = Number(process.env.OPENWOP_COLLAB_MAX_PAYLOAD_BYTES) > 0
    ? Number(process.env.OPENWOP_COLLAB_MAX_PAYLOAD_BYTES)
    : 4 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true, maxPayload });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const m = PATH_RE.exec(req.url ?? '');
    if (!m) return; // not our path — leave it for any other handler (none today)
    void authorizeAndUpgrade(wss, req, socket, head, m[1] as 'canvas-collab' | 'workflow-collab', decodeURIComponent(m[2]!));
  });
}

async function authorizeAndUpgrade(
  wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer,
  kind: 'canvas-collab' | 'workflow-collab', resourceId: string,
): Promise<void> {
  try {
    // ADR 0481 — the room id is NAMESPACED per resource kind ('wf:' for
    // workflows) so the two kinds can never collide in the room map, leases,
    // snapshots, seed claims, or ticket scopes.
    const roomId = kind === 'workflow-collab' ? `wf:${resourceId}` : resourceId;
    // 1. Origin (CSWSH). Browsers always send Origin on a WS handshake.
    if (!originPolicy().allowed(req.headers.origin)) return deny(socket, 403, 'forbidden origin');
    // 2. Authn — a collab ticket (the cross-origin prod posture) or the same
    //    signed session cookie as HTTP (same-origin dev/proxy posture).
    //    Tickets verify against the NAMESPACED room id.
    const ticket = new URL(req.url ?? '', 'http://collab.invalid').searchParams.get('ticket');
    const ticketTenant = ticket ? verifyCollabTicket(ticket, roomId) : null;
    const session = ticketTenant ?? verifySession(readCookie(req.headers.cookie, COOKIE_NAME) ?? '');
    if (!session) return deny(socket, 401, 'unauthenticated');
    // 3. Toggle gate (per tenant). OFF ⇒ the surface does not exist.
    const assignment = await resolveOne(COLLAB_TOGGLE_ID, { tenantId: session.tenantId });
    if (!assignment?.enabled) return deny(socket, 404, 'not found');
    if (kind === 'workflow-collab') {
      // ADR 0481 — the workflow lane: its own toggle + ownership eligibility
      // (uniform 404 like the canvas chain; reserved/chain-backed refused).
      const { WORKFLOW_COLLAB_TOGGLE_ID, workflowCollabEligible } = await import('./workflowCollabResource.js');
      const wfAssignment = await resolveOne(WORKFLOW_COLLAB_TOGGLE_ID, { tenantId: session.tenantId });
      if (!wfAssignment?.enabled) return deny(socket, 404, 'not found');
      if (!(await workflowCollabEligible(session.tenantId, resourceId))) return deny(socket, 404, 'not found');
      const claimedW = (connsByTenant.get(session.tenantId) ?? 0) + 1;
      connsByTenant.set(session.tenantId, claimedW);
      if (claimedW > MAX_CONNS_PER_TENANT) {
        releaseConn(session.tenantId);
        return deny(socket, 429, 'too many connections');
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          log.info('collab socket opened', { tenantId: session.tenantId, roomId, resource: 'workflow', auth: ticketTenant ? 'ticket' : 'cookie' });
          void joinCollabRoom(ws, roomId, { tenantId: session.tenantId, resource: 'workflow' });
          ws.on('close', () => releaseConn(session.tenantId));
        });
      } catch (err) {
        releaseConn(session.tenantId);
        throw err;
      }
      return;
    }
    const canvasId = resourceId;
    // 4. Authorization — tenant + collab-capable type (ADR 0359 registry).
    //    Uniform 404 (no cross-tenant join / leak; pack/unknown types absent).
    const canvas = await getCanvasForTenant(session.tenantId, canvasId);
    const entry = canvas ? collabCanvasType(canvas.canvasTypeId) : undefined;
    if (!canvas || !entry) return deny(socket, 404, 'not found');
    // 4b. The type's OWN toggle (architect HIGH-1) — the socket is the boundary,
    //     not the UI: collab ON + (say) slides OFF must not open a slides room.
    const typeAssignment = await resolveOne(entry.toggleId, { tenantId: session.tenantId });
    if (!typeAssignment?.enabled) return deny(socket, 404, 'not found');
    // 4c. ADR 0610 collab-lane / SLC-1 — a project/user-owned canvas is
    //     membership-scoped: gate the room join on the subjectAccess seam (the WS
    //     SIBLING of the REST loadCanvas choke). Defense-in-depth even on the ticket
    //     path (a ticket minted before this gate shipped must not open the room).
    //     The caller is the canonical `User.userId` — which is ITSELF `user:<hash>`,
    //     the exact value the mint gate (`resolveCallerUser().userId`), the cookie
    //     path (`session.userId`), and the REST `loadCanvas(user.userId)` all pass.
    //     `resolveProjectAccess` prefixes it ONCE MORE (`user:${User.userId}`) to
    //     match stored member refs, so it MUST NOT be stripped — a bare hash matches
    //     no member ref and no org subject, denying every legitimate joiner. The
    //     ticket carries `principalId` (= `User.userId` for a cookie-derived mint).
    const wsCaller: string | undefined = ticketTenant
      ? ticketTenant.principalId
      : ('userId' in session ? session.userId : undefined);
    if (!(await collabCanvasReadable(session.tenantId, canvas, wsCaller))) return deny(socket, 404, 'not found');
    // 5. Per-tenant connection cap — increment-then-check (grade-pass CODE-5:
    //    the old read→compare→set-in-callback raced concurrent upgrades, which
    //    all read the same count and each wrote +1). The counter is claimed
    //    BEFORE the handshake; the close handler (and the deny path) release it.
    const claimed = (connsByTenant.get(session.tenantId) ?? 0) + 1;
    connsByTenant.set(session.tenantId, claimed);
    if (claimed > MAX_CONNS_PER_TENANT) {
      releaseConn(session.tenantId);
      return deny(socket, 429, 'too many connections');
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        log.info('collab socket opened', {
          tenantId: session.tenantId, canvasId,
          auth: ticketTenant ? 'ticket' : 'cookie',
          ...(ticketTenant?.principalId ? { principalId: ticketTenant.principalId } : {}),
        });
      // Phase 1b-i — join the (schema-agnostic) Yjs room: sync handshake + relay
      // + debounced snapshot persistence. Cross-instance fan-out is 1b-ii; the
      // meta feeds the Phase 6 host.canvas derive (tenant + type).
      void joinCollabRoom(ws, canvasId, { tenantId: session.tenantId, canvasTypeId: canvas.canvasTypeId });
        ws.on('close', () => releaseConn(session.tenantId));
      });
    } catch (err) {
      releaseConn(session.tenantId); // a failed handshake must not strand the claim
      throw err;
    }
  } catch (err) {
    log.error('collab upgrade failed', { error: err instanceof Error ? err.message : String(err) });
    try { deny(socket, 500, 'internal error'); } catch { socket.destroy(); }
  }
}

/** Test-only: clear the per-tenant connection counters. */
export function __resetCollabConns(): void { connsByTenant.clear(); }
