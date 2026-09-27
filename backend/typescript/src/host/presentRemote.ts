/**
 * Present-mode phone remote (ADR 0328 Phase 4 / research C3) — the host side of
 * the chassis present page's zero-install QR remote.
 *
 * Capability model: a STATELESS HMAC token (the `runStreamToken` pattern —
 * domain-prefixed, signed with the ONE session secret, verifiable on any
 * instance, no store) minted only behind the canvas factory's
 * `authorizeOrgScope(workspace:read)` gate. The capability it grants is
 * deliberately small and documented: read ONE canvas's present OUTLINE (frame
 * names + speaker notes + skip flags) and publish/subscribe the ephemeral
 * navigation channel for that canvas. Notes exposure is the point — the
 * controller page shows the presenter their notes on the phone.
 *
 * Transport: the ONE host-ext pub/sub (`publishHostExtEvent`) carries the
 * nav payloads directly — unlike run-event ticks there is no durable log to
 * re-fetch from, and losing a control signal on reconnect is harmless (the
 * presenter re-publishes position). SSE fan-out rides the ONE
 * `openSseChannel` owner (heartbeats, caps, teardown).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import { readSessionSecret } from '../middleware/cookieSession.js';
import { publishHostExtEvent, subscribeHostExtEvent } from './hostExtPersistence.js';

const log = createLogger('host.presentRemote');

/** Long enough for a talk + hallway overrun; short enough to bound a leaked
 *  QR photo. The presenter can always mint a fresh one. */
const TTL_SECONDS = 4 * 3600;
const PREFIX = 'presentremote:v1:';

/** Sign over the encoded claims blob — field-delimiter ambiguity is
 *  impossible by construction (grade pass 2026-07-10 N1: signing the raw
 *  `tenant:canvas` concatenation let (a:b, c) and (a, b:c) collide). */
function sign(claimsB64: string, exp: number): string {
  return createHmac('sha256', readSessionSecret())
    .update(`${PREFIX}${claimsB64}:${exp}`)
    .digest('base64url');
}

export interface PresentRemoteClaims { tenantId: string; canvasId: string; exp: number }

/** Mint a remote-control capability for one canvas. Caller MUST have passed
 *  the org/tenant gate for the canvas already (the factory mint route). */
export function mintPresentRemoteToken(tenantId: string, canvasId: string, nowMs: number = Date.now()): { token: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
  // JSON claims — tenant ids contain colons (`org:…`), so no delimiter parsing.
  const claims = Buffer.from(JSON.stringify({ t: tenantId, c: canvasId })).toString('base64url');
  const token = `v1.${claims}.${exp}.${sign(claims, exp)}`;
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Parse + verify. Returns the claims, or null (uniform — the routes 404). */
export function verifyPresentRemoteToken(token: string, nowMs: number = Date.now()): PresentRemoteClaims | null {
  const reject = (reason: string): null => { log.debug('present_remote_token_rejected', { reason }); return null; };
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return reject('malformed');
  let tenantId = '', canvasId = '';
  try {
    const raw = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { t?: unknown; c?: unknown };
    if (typeof raw.t !== 'string' || !raw.t || typeof raw.c !== 'string' || !raw.c) return reject('malformed');
    tenantId = raw.t;
    canvasId = raw.c;
  } catch { return reject('malformed'); }
  const exp = Number(parts[2]);
  if (!Number.isInteger(exp)) return reject('malformed');
  if (exp <= Math.floor(nowMs / 1000)) return reject('expired');
  const a = Buffer.from(parts[3]!);
  const b = Buffer.from(sign(parts[1]!, exp));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reject('bad_signature');
  return { tenantId, canvasId, exp };
}

// ── The per-type present OUTLINE projection. ────────────────────────────────

export interface PresentOutlineFrame { name: string; notes?: string; skip?: boolean }
export interface PresentOutline { title: string; frames: PresentOutlineFrame[] }

type OutlineProvider = (state: Record<string, unknown>) => PresentOutline;
const outlineProviders = new Map<string, OutlineProvider>();

/** A canvas type registers how its doc projects to the phone controller's
 *  outline (frame names + notes + skip). Absent = the type has no present
 *  remote (the routes 404). */
export function registerPresentOutlineProvider(canvasTypeId: string, provider: OutlineProvider): void {
  outlineProviders.set(canvasTypeId, provider);
}

export function presentOutlineFor(canvasTypeId: string, state: Record<string, unknown>): PresentOutline | null {
  const p = outlineProviders.get(canvasTypeId);
  return p ? p(state) : null;
}

// ── The ephemeral nav channel (cross-instance via the ONE pub/sub). ─────────

export interface PresentNavEvent {
  kind: 'command' | 'position';
  /** command: what the remote asks for. */
  action?: 'next' | 'prev' | 'goto' | 'blank';
  index?: number;
  /** position: the presenter's authoritative current frame. */
  current?: number;
}

const channelOf = (c: PresentRemoteClaims): string => `hostext:present:nav:${c.tenantId}:${c.canvasId}`;

/** Publish a nav event. Best-effort: a bus hiccup drops a control signal, it
 *  never breaks the request. */
export async function publishPresentNav(claims: PresentRemoteClaims, ev: PresentNavEvent): Promise<void> {
  try {
    await publishHostExtEvent(channelOf(claims), JSON.stringify(ev));
  } catch (err) {
    log.debug('present_nav_publish_failed', { canvasId: claims.canvasId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Test-only (SL-5) — live present-nav subscription count, so the SSE route's
 *  teardown (the #1594 B3 onClose-before-await fix) is assertable over real
 *  HTTP instead of unit-reasoned. */
let liveSubscriptions = 0;
export function __presentNavSubscriberCountForTests(): number { return liveSubscriptions; }

/** Subscribe to a canvas's nav events. Resolves to the unsubscribe. */
export async function subscribePresentNav(claims: PresentRemoteClaims, onEvent: (ev: PresentNavEvent) => void): Promise<() => Promise<void>> {
  const unsubscribe = await subscribeHostExtEvent(channelOf(claims), (payload: string) => {
    try {
      const ev = JSON.parse(payload) as PresentNavEvent;
      if (ev && (ev.kind === 'command' || ev.kind === 'position')) onEvent(ev);
    } catch { /* malformed — ignore */ }
  });
  liveSubscriptions += 1;
  let done = false;
  return async () => {
    if (!done) { done = true; liveSubscriptions -= 1; }
    await unsubscribe();
  };
}
