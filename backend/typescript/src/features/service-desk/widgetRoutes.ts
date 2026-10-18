/**
 * ADR 0422 P5 — the PUBLIC widget-ticketing lane (its own security posture):
 *  - tenant resolves ONLY via the minted `publicIntakeKey` (random, shown to
 *    the operator in the intake config; never enumerable);
 *  - BOTH the `service-desk` toggle AND the `service-desk.widget` sub-toggle
 *    must be on — anything else is a 404 (no existence leak, fail-closed);
 *  - the visitor session is a server-minted HMAC token (`sdv2.<id>.<sig>`, a
 *    labelled sub-key of the house session secret, signed over the TENANT and
 *    the visitor id — ADR 0878 D3a) scoping the caller to ONE visitor thread in
 *    ONE tenant — a forged/foreign token is a 404;
 *  - every public read REDACTS internal notes (customer sees inbound/outbound
 *    only) and strips author/internal ids;
 *  - visitor input is untrusted DATA: length-capped, never interpreted; the
 *    global per-IP rate budget applies (public POSTs ride the same
 *    middleware as every route).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../../middleware/cookieSession.js';
import type { Response } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { ownerPublicRuntimeLapsed } from '../../host/publicLapse.js';
import { getIntakeConfig } from './intake.js';
import { createTicket, getTicket, ticketIdFor } from './tickets.js';
import type { Ticket } from './ticketTypes.js';
import { sendError } from '../../middleware/errorEnvelope.js';

const MAX_BODY = 4000;

interface PublicKeyRow { key: string; tenantId: string }
export const publicIntakeKeys = new DurableCollection<PublicKeyRow>(
  'service-desk:public-key',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

export async function mintPublicIntakeKey(tenantId: string): Promise<string> {
  // One active key per tenant (re-mint replaces): drop any prior rows for the
  // tenant via the tenant index, then mint fresh.
  for (const prior of await publicIntakeKeys.listForTenantIndexed(tenantId)) {
    await publicIntakeKeys.delete(prior.key);
  }
  const key = `sdk_${randomUUID().replace(/-/g, '')}`;
  await publicIntakeKeys.put({ key, tenantId });
  return key;
}

export async function tenantForIntakeKey(key: string): Promise<string | null> {
  if (!/^sdk_[0-9a-f]{32}$/.test(key)) return null;
  const row = await publicIntakeKeys.get(key);
  return row?.tenantId ?? null;
}

// ── visitor session tokens ──────────────────────────────────────────────────

/**
 * ADR 0878 D3a (SD2-S3) — the key. This was `OPENWOP_SESSION_SECRET ?? ''`: unset,
 * the HMAC key was the empty string and anyone could mint a valid token. Now a
 * LABELLED sub-key of `readSessionSecret()` — the house resolver, which fails closed
 * in production and uses the stable per-process fallback elsewhere — so a visitor
 * token and a session cookie never share a key. Throws when the secret cannot be
 * resolved; the routes answer that with the uniform 404.
 */
function visitorKey(): Buffer {
  return createHmac('sha256', readSessionSecret()).update('service-desk-visitor/v2').digest();
}

/** Signed over the tenant as well as the id: a token minted on one tenant's widget
 *  is not a session on another's. */
function sign(tenantId: string, visitorId: string): string {
  return createHmac('sha256', visitorKey()).update(`sd-visitor|${tenantId}|${visitorId}`).digest('hex').slice(0, 32);
}

export function mintVisitorToken(tenantId: string): { visitorId: string; token: string } {
  const visitorId = randomUUID().replace(/-/g, '').slice(0, 20);
  return { visitorId, token: `sdv2.${visitorId}.${sign(tenantId, visitorId)}` };
}

/** The visitor id a token proves for THIS tenant, else null. An `sdv1` token (the
 *  pre-ADR-0878 shape, tenant-unbound and possibly empty-keyed) never verifies. */
export function verifyVisitorToken(token: unknown, tenantId: string): string | null {
  if (typeof token !== 'string' || !tenantId) return null;
  const m = /^sdv2\.([0-9a-f]{20})\.([0-9a-f]{32})$/.exec(token);
  if (!m) return null;
  let expectedSig: string;
  try { expectedSig = sign(tenantId, m[1]!); } catch { return null; }
  const expected = Buffer.from(expectedSig);
  const got = Buffer.from(m[2]!);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return m[1]!;
}

// ── the public projection (internal notes NEVER leak) ───────────────────────

function publicView(t: Ticket): Record<string, unknown> {
  return {
    ticketId: t.ticketId,
    subject: t.subject,
    status: t.status,
    messages: t.messages
      .filter((m) => m.direction !== 'internal')
      .map((m) => ({ direction: m.direction, body: m.body, at: m.at })),
  };
}

/**
 * ADR 0820 §8.2 / architect #5 — a VISITOR lane: the tenant comes from the intake
 * key (the resource), never the caller. So it reads the two TOGGLES only
 * (`resolveToggle`, ratchet-listed opt-outs), not `resolveOne`. Service desk is
 * sold in the Support bundle; with `resolveOne` here an unpaid owner's widget
 * would 404 its visitors, and an entitlement-read fault would 404 EVERY tenant's
 * widget (the ADR 0819 A2 class). The ADR 0176 shopper exemption keeps visitors
 * off the owner's plan; the owner's plan is enforced on the operator routes.
 * The owner-lapse policy (ADR 0820 §7) is applied below via `ownerPublicRuntimeLapsed`.
 */
async function widgetEnabled(tenantId: string): Promise<boolean> {
  const main = await resolveToggle('service-desk', { tenantId }).catch(() => null);
  if (main?.enabled !== true) return false;
  const sub = await resolveToggle('service-desk.widget', { tenantId }).catch(() => null);
  if (sub?.enabled !== true) return false;
  // ADR 0820 §7 — the visitor lane reads the toggle only (resolveToggle, #4421); the owner's
  // plan bites here, through the lapse policy (off unless the grace knob is set).
  return !(await ownerPublicRuntimeLapsed('service-desk', tenantId));
}

export function registerServiceDeskWidgetRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const PUB = '/host/openwop-app/public-service-desk/:intakeKey';
  const notFound = (res: Response): void => {
    sendError(res, 404, 'not_found', 'Not found.');
  };

  // A visitor sends a message: first call mints the session; later calls
  // (with the token) append to the SAME visitor thread.
  app.post(`${PUB}/messages`, async (req, res, next) => {
    try {
      const tenantId = await tenantForIntakeKey(String(req.params.intakeKey ?? ''));
      if (!tenantId || !(await widgetEnabled(tenantId))) { notFound(res); return; }
      const cfg = await getIntakeConfig(tenantId);
      if (!cfg) { notFound(res); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.body === 'string' ? body.body.trim().slice(0, MAX_BODY) : '';
      if (!text) { sendError(res, 422, 'validation_error', 'Field `body` is required.'); return; }

      const known = verifyVisitorToken(body.visitorToken, tenantId);
      let session: { visitorId: string; token: string };
      try {
        session = known ? { visitorId: known, token: String(body.visitorToken) } : mintVisitorToken(tenantId);
      } catch {
        notFound(res); return; // no session secret on this host — the uniform 404, never a 500
      }
      const { ticket } = await createTicket({
        tenantId,
        orgId: cfg.defaultOrgId,
        subject: `Widget: ${text.slice(0, 80)}`,
        channel: 'widget',
        ...(cfg.slaHoursByPriority ? { slaHoursByPriority: cfg.slaHoursByPriority } : {}),
        externalKey: `widget:${session.visitorId}`,
        replyChannel: { kind: 'widget' }, // ADR 0878 D3 — a reply is read on this thread
        firstMessage: {
          // Content-position id: a network retry of the same POST dedupes; a
          // deliberate identical re-send appends (position advances).
          messageId: `w:${session.visitorId}:${await messageSeq(tenantId, session.visitorId)}`,
          body: text,
          author: 'visitor',
          direction: 'inbound',
        },
        createdBy: 'system:service-desk-widget',
      });
      res.status(201).json({ visitorToken: session.token, ticket: publicView(ticket) });
    } catch (err) { next(err); }
  });

  // The visitor reads their OWN thread (token-scoped; internal notes redacted).
  app.get(`${PUB}/thread`, async (req, res, next) => {
    try {
      const tenantId = await tenantForIntakeKey(String(req.params.intakeKey ?? ''));
      if (!tenantId || !(await widgetEnabled(tenantId))) { notFound(res); return; }
      // The header keeps the token out of URLs and access logs; `?token=` stays for
      // existing callers.
      const headerToken = req.get('x-visitor-token');
      const visitorId = verifyVisitorToken(headerToken ?? req.query.token, tenantId);
      if (!visitorId) { notFound(res); return; }
      const ticket = await getTicket(tenantId, ticketIdFor(tenantId, `widget:${visitorId}`));
      if (!ticket) { notFound(res); return; }
      res.json({ ticket: publicView(ticket) });
    } catch (err) { next(err); }
  });
}

/** Next message position for the visitor's thread (idempotent under retry:
 *  the position derives from the CURRENT thread length, so an immediate
 *  network retry that lost its response re-lands on the same id). */
async function messageSeq(tenantId: string, visitorId: string): Promise<number> {
  const existing = await getTicket(tenantId, ticketIdFor(tenantId, `widget:${visitorId}`));
  return (existing?.messages.length ?? 0) + 1;
}
