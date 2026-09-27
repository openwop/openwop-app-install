/**
 * kicktodo-integrations REST (ADR 0421 P1/P3) — consent CRUD + feed minting
 * under the KickTodo prefix (toggle-gated), plus the PUBLIC tokenized ICS
 * feed (auth-bypassed via PUBLIC_PATH_PREFIXES; tenant derived from the
 * TOKEN; uniform 404).
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { requireFeatureEnabled } from '../featureRoute.js';
import {
  grantConsent,
  revokeConsent,
  listConsents,
  mintFeedToken,
  renderFeed,
  putWearableRule,
  ingestWearableMetric,
  ConsentRequiredError,
  FeedDeniedError,
  RuleError,
  CONSENT_KINDS,
  type ConsentKind,
} from './integrationService.js';
import { isCalendarTransportConfigured, CalendarUnavailableError } from './calendarWriteService.js';
import { setCalendarSyncEnabled } from './calendarSyncService.js';
import {
  linkWearableProvider,
  unlinkWearableProvider,
  listWearableLinksForSubject,
} from './wearableLinkService.js';
import {
  registerWearableWebhook,
  revokeWearableWebhook,
  ingestWearableWebhook,
  WebhookDeniedError,
  WebhookUnauthorizedError,
} from './wearableWebhookService.js';

export const KICKTODO_INTEGRATIONS_PREFIX = '/v1/host/openwop-app/kicktodo/integrations';
/** The PUBLIC feed path (PUBLIC_PATH_PREFIXES entry — auth-bypassed). */
export const KICKTODO_FEED_PUBLIC_PREFIX = '/public/kicktodo/feed';
/** ADR 0462 P2 — the PUBLIC wearable webhook path (PUBLIC_PATH_PREFIXES entry).
 *  The token IS the tenant/provider capability; the provider posts here. */
export const KICKTODO_WEARABLE_WEBHOOK_PUBLIC_PREFIX = '/public/kicktodo/wearable-webhook';

type Handler = (req: Request, res: Response) => Promise<void>;

function subjectOf(req: Request): string {
  const s = callerSubject(req);
  if (!s) throw new OpenwopError('unauthenticated', 'An identified caller is required.', 401);
  return s;
}

async function gate(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'kicktodo-integrations', 'KickTodo Integrations');
}

function parseKind(v: unknown): ConsentKind {
  if (typeof v !== 'string' || !(CONSENT_KINDS as readonly string[]).includes(v)) {
    throw new OpenwopError('validation_error', 'Field `kind` must be a valid consent kind.', 400, { validKinds: CONSENT_KINDS });
  }
  return v as ConsentKind;
}

export const KICKTODO_INTEGRATIONS_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: Handler }> = [
  {
    // ADR 0438 A6 / B20 — the HONEST calendar-write transport state for the admin
    // console. A deployment-global boolean (no tenant/PII), so any authenticated
    // caller may read it; the UI shows "connected" only when it is truly wired.
    method: 'get',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/calendar-status`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req); // KTEXP2-3 — require an identified caller locally, not just global authN
      res.json({ transportConfigured: isCalendarTransportConfigured() });
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/consents`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ consents: await listConsents(tenantOf(req), subjectOf(req)) });
    },
  },
  {
    // ADR 0421 P2 / ADR 0466 — arm/disarm the OPT-IN daily calendar-sync for one
    // enrollment (the schedule binding that ignites the calendar-write lane).
    // A REST write with the acting human (setup opt-ins stay route-level, never a
    // chat tool). Owner-checked in the service; honest 409 when arming without a
    // live `calendar-write` consent or without a configured transport.
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/calendar-sync/schedule`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.enrollmentId !== 'string' || !b.enrollmentId.trim() || typeof b.enabled !== 'boolean') {
        throw new OpenwopError('validation_error', 'Fields `enrollmentId` (string) and `enabled` (boolean) are required.', 400);
      }
      try {
        const ok = await setCalendarSyncEnabled(tenantOf(req), b.enrollmentId, subjectOf(req), b.enabled);
        if (!ok && b.enabled) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
        res.json({ enrollmentId: b.enrollmentId, enabled: b.enabled, scheduled: ok });
      } catch (err) {
        if (err instanceof ConsentRequiredError) throw new OpenwopError('conflict', err.message, 409, { kind: err.kind });
        if (err instanceof CalendarUnavailableError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/consents`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json(await grantConsent(tenantOf(req), subjectOf(req), parseKind(b.kind), typeof b.connectionId === 'string' ? b.connectionId : undefined));
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/consents/revoke`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      await revokeConsent(tenantOf(req), subjectOf(req), parseKind(b.kind));
      res.json({ revoked: true });
    },
  },
  {
    // Mint the feed token — the RAW value appears exactly once in this response.
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/feed-token`,
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json({ token: await mintFeedToken(tenantOf(req), subjectOf(req)), feedPath: KICKTODO_FEED_PUBLIC_PREFIX });
      } catch (err) {
        if (err instanceof ConsentRequiredError) throw new OpenwopError('conflict', err.message, 409, { kind: err.kind });
        throw err;
      }
    },
  },
  {
    // ADR 0462 Phase 1 — the participant links a wearable PROVIDER account under
    // their own session (the ONLY moment we can bind the provider's user id to the
    // opaque subject). Fail-closed on a live `wearable-evidence` consent.
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/wearable-link`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.provider !== 'string' || !b.provider.trim() || typeof b.providerUserId !== 'string' || !b.providerUserId.trim()) {
        throw new OpenwopError('validation_error', 'Fields `provider` and `providerUserId` are required.', 400);
      }
      try {
        res.json(await linkWearableProvider(tenantOf(req), subjectOf(req), b.provider, b.providerUserId));
      } catch (err) {
        if (err instanceof ConsentRequiredError) throw new OpenwopError('conflict', err.message, 409, { kind: err.kind });
        throw err;
      }
    },
  },
  {
    // Unlink — ownership-checked in the service (only the caller's own binding).
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/wearable-unlink`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.provider !== 'string' || typeof b.providerUserId !== 'string') {
        throw new OpenwopError('validation_error', 'Fields `provider` and `providerUserId` are required.', 400);
      }
      await unlinkWearableProvider(tenantOf(req), subjectOf(req), b.provider, b.providerUserId);
      res.json({ unlinked: true });
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/wearable-links`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ links: await listWearableLinksForSubject(tenantOf(req), subjectOf(req)) });
    },
  },
  {
    // ADR 0462 P2 — register the tenant's provider webhook; the RAW token is returned
    // ONCE (give it to the provider). Honest 409 when the provider isn't configured.
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/wearable-webhook-register`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.provider !== 'string' || !b.provider.trim()) {
        throw new OpenwopError('validation_error', 'Field `provider` is required.', 400);
      }
      try {
        res.json({ token: await registerWearableWebhook(tenantOf(req), b.provider), webhookPath: KICKTODO_WEARABLE_WEBHOOK_PUBLIC_PREFIX });
      } catch (err) {
        if (err instanceof WebhookDeniedError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    },
  },
  {
    // grade-data 0462-D1 — revoke the tenant's active webhook token(s) for a provider.
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/wearable-webhook-revoke`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.provider !== 'string' || !b.provider.trim()) {
        throw new OpenwopError('validation_error', 'Field `provider` is required.', 400);
      }
      await revokeWearableWebhook(tenantOf(req), b.provider);
      res.json({ revoked: true });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/wearable-rules`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.enrollmentId !== 'string' || typeof b.stableActivityId !== 'string' || typeof b.metric !== 'string' || typeof b.threshold !== 'number') {
        throw new OpenwopError('validation_error', 'Fields `enrollmentId`, `stableActivityId`, `metric`, `threshold` are required.', 400);
      }
      try {
        res.json(await putWearableRule(tenantOf(req), subjectOf(req), {
          enrollmentId: b.enrollmentId, stableActivityId: b.stableActivityId, metric: b.metric, threshold: b.threshold,
        }));
      } catch (err) {
        if (err instanceof RuleError) throw new OpenwopError('validation_error', err.message, 422);
        if (err instanceof FeedDeniedError) throw new OpenwopError('not_found', err.message, 404);
        throw err;
      }
    },
  },
  {
    // Wearable ingest (the connected device/provider posts on the OWNER's
    // behalf via their session; provider-webhook lanes ride Connections later).
    method: 'post',
    path: `${KICKTODO_INTEGRATIONS_PREFIX}/wearable-ingest`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.metric !== 'string' || typeof b.value !== 'number' || !Number.isFinite(b.value)) {
        throw new OpenwopError('validation_error', 'Fields `metric` and numeric `value` are required.', 400);
      }
      try {
        res.json({ converted: await ingestWearableMetric(tenantOf(req), subjectOf(req), b.metric, b.value) });
      } catch (err) {
        if (err instanceof ConsentRequiredError) throw new OpenwopError('conflict', err.message, 409, { kind: err.kind });
        throw err;
      }
    },
  },
];

export function registerKicktodoIntegrationsRoutes(deps: RouteDeps): void {
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_INTEGRATIONS_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }
  // The PUBLIC ICS feed: token IS the capability; uniform 404; no auth.
  app.get(`${KICKTODO_FEED_PUBLIC_PREFIX}/:token`, async (req, res, next) => {
    try {
      const ics = await renderFeed(req.params.token);
      res.setHeader('content-type', 'text/calendar; charset=utf-8');
      res.send(ics);
    } catch (err) {
      if (err instanceof FeedDeniedError) {
        next(new OpenwopError('not_found', 'Not found.', 404));
        return;
      }
      next(err);
    }
  });
  // ADR 0462 P2 — the PUBLIC wearable webhook: the provider posts a signed push; the
  // token IS the tenant/provider capability. Signature verified before any work;
  // uniform 401 (bad sig) / 404 (unknown token) / 200 with a silent ingested count.
  app.post(`${KICKTODO_WEARABLE_WEBHOOK_PUBLIC_PREFIX}/:token`, async (req, res, next) => {
    try {
      const payload = req.body ?? {};
      const out = await ingestWearableWebhook(req.params.token, {
        payload,
        rawBody: JSON.stringify(payload),
        headers: req.headers as Record<string, string | undefined>,
      });
      res.json(out);
    } catch (err) {
      if (err instanceof WebhookUnauthorizedError) { next(new OpenwopError('unauthenticated', 'Unauthorized.', 401)); return; }
      if (err instanceof WebhookDeniedError) { next(new OpenwopError('not_found', 'Not found.', 404)); return; }
      next(err);
    }
  });
}
