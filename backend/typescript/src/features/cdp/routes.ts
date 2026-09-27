/**
 * CDP feature routes (host-extension — ADR 0263 / CDP-A).
 *
 * Surface under /v1/host/openwop-app/cdp:
 *   GET /identity/resolve?type=&value=   golden record for any identifier
 *
 * TOGGLE-GATED (backend authority) via the SHARED `requireFeatureEnabled` choke;
 * off ⇒ 404 (a disabled feature has no surface). Reads are tenant-scoped via the
 * composing service (never a cross-tenant leak).
 *
 * § ADR 0419 §Correction (2026-07-19) — this package used to roll its OWN
 * `resolveOne`-based gate, which bypassed the ADR 0419 central entitlement choke
 * inside `requireFeatureEnabled`. Because `cdp` is in the SELLABLE
 * `customer-data-platform` bundle, that made the bundle a dishonest paywall the
 * moment an operator priced it. The local gate was pure duplication — its subject
 * shape and 404 body were identical to the shared helper's — so it is deleted
 * rather than patched.
 *
 * §Boundary: this package READS the crm-owned identifier index; contact
 * mutations (incl. identifier CRUD) live in the crm routes — cdp owns no store.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireString, requireFeatureEnabled } from '../featureRoute.js';
import { resolveIdentityWithAccess } from './identityService.js';
import { registerEventSchema, listEventSchemas, validateEvent } from './eventSchemaService.js';
import { listGovernanceDecisionsWithBound } from '../../host/governanceDecisionLog.js';
import { listMergeEvents } from '../crm/crmMergeEventsService.js';
import { collectEvent, collectEventBatch, listCollectedEvents } from './collectService.js';
import { importCsv, type ImportOptions } from './csvImportService.js';
import { resolveEffectiveAccess, ACT_AS_HEADER } from '../../host/accessControlService.js';
import { verifyChain, getAuditHead } from '../../host/auditChainService.js';

const TOGGLE_ID = 'cdp';

/** Admin gate (ADR 0301 / CDP-F) — audit-chain verification is a governance
 *  read reserved for tenant admins/owners. Resolves the acting member (or the
 *  tenant-owner principal when no act-as header is present, per the app's
 *  single-tenant-owner model) and requires an admin|owner role. */
async function requireAdmin(req: Request): Promise<void> {
  const actingMember = req.header(ACT_AS_HEADER);
  const access = await resolveEffectiveAccess(
    req.tenantId ?? 'default',
    actingMember ? { memberId: actingMember.trim() } : {},
  );
  if (!(access.roles.includes('admin') || access.roles.includes('owner'))) {
    throw new OpenwopError('forbidden', 'Audit-chain verification requires an admin role.', 403, {});
  }
}

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

/** Shared toggle choke + the ADR 0419 entitlement gate. `'CDP'` as the label
 *  keeps the 404 body byte-identical to the former local gate. */
async function requireEnabled(req: Request): Promise<void> {
  await requireFeatureEnabled(req, TOGGLE_ID, 'CDP');
}

export function registerCdpRoutes({ app }: RouteDeps): void {
  app.get('/v1/host/openwop-app/cdp/identity/resolve', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const type = requireString(req.query.type, 'type');
      const value = requireString(req.query.value, 'value');
      // ADR 0268 / CDP-F — label-based access: a `crm.contact` is classified
      // confidential-pii, so a caller WITHOUT a pii-read grant (a programmatic
      // API-key principal, until a `pii:read` scope rides the principal) gets a
      // MASKED golden record; interactive user sessions get the full record.
      // XCH-HOLE-6: resolve + access + governance log live in the ONE shared
      // helper the agent tool also calls — route and tool cannot drift.
      const hasPiiGrant = req.principal?.principalId?.startsWith('apikey:') !== true;
      const resolved = await resolveIdentityWithAccess(tenantOf(req), type, value, hasPiiGrant);
      if (!resolved) {
        throw new OpenwopError('not_found', 'No customer resolves to that identifier.', 404, { type });
      }
      // R2 CDP-G5 (promoted) — pass `masked` THROUGH (the Segment PII-Access
      // convention: masked values render AS masked, never silently
      // pseudonymized). The agent tool has always returned it; the route
      // dropping it was a route/tool asymmetry an apikey caller couldn't see.
      res.json({ ...resolved.record, masked: resolved.masked });
    } catch (err) {
      next(err);
    }
  });

  // Event schema registry (ADR 0269 / CDP-G) — versioned per-tenant event contracts.
  app.get('/v1/host/openwop-app/cdp/event-schemas', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ schemas: await listEventSchemas(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/cdp/event-schemas', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as { eventType?: unknown; schema?: unknown };
      const record = await registerEventSchema(tenantOf(req), requireString(body.eventType, 'eventType'), body.schema);
      res.status(201).json(record);
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/cdp/event-schemas/:eventType/validate', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as { payload?: unknown };
      const result = await validateEvent(tenantOf(req), req.params.eventType, body.payload);
      res.status(result.valid ? 200 : 422).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Event collection (ADR 0269 / CDP-G) — schema-validated ingest + PII tagging.
  app.post('/v1/host/openwop-app/cdp/collect', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const b = (req.body ?? {}) as { eventType?: unknown; payload?: unknown; dedupeKey?: unknown };
      // GEN-2g — optional client dedupe key for at-most-once ingest (bounded len).
      const dedupeKey = typeof b.dedupeKey === 'string' && b.dedupeKey.length > 0 && b.dedupeKey.length <= 128 ? b.dedupeKey : undefined;
      const result = await collectEvent(tenantOf(req), requireString(b.eventType, 'eventType'), b.payload, dedupeKey);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Batch ingest (ADR 0269 batch-import follow-on) — the same schema-enforced collect
  // path, per row, capped + best-effort. 200 with a per-row summary (mixed accept/reject).
  app.post('/v1/host/openwop-app/cdp/collect/batch', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const b = (req.body ?? {}) as { events?: unknown };
      res.status(200).json(await collectEventBatch(tenantOf(req), b.events));
    } catch (err) {
      next(err);
    }
  });

  // Batch/CSV import (ADR 0298) — parse a CSV body → ≤100-row chunks → the SAME
  // collectEventBatch path (schema validation + PII tagging + per-row outcome reused,
  // never reimplemented). Whole-import 10k-row hard cap; parse errors → 400 fail-closed;
  // per-row failures surfaced without sinking the import. 200 with an aggregate summary.
  app.post('/v1/host/openwop-app/cdp/collect/import', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const b = (req.body ?? {}) as { csv?: unknown; eventType?: unknown; eventTypeColumn?: unknown; dedupKeyField?: unknown };
      const opts: ImportOptions = {
        ...(typeof b.eventType === 'string' ? { eventType: b.eventType } : {}),
        ...(typeof b.eventTypeColumn === 'string' ? { eventTypeColumn: b.eventTypeColumn } : {}),
        ...(typeof b.dedupKeyField === 'string' ? { dedupKeyField: b.dedupKeyField } : {}),
      };
      res.status(200).json(await importCsv(tenantOf(req), typeof b.csv === 'string' ? b.csv : '', opts));
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/openwop-app/cdp/collected-events', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      res.json({ events: await listCollectedEvents(tenantOf(req), limit), limit });
    } catch (err) {
      next(err);
    }
  });

  // R3 (the R2 "deferred SAFELY" merge-history audit) — the read half over the
  // COMPLETE history ADR 0264 has recorded all along (recordMergeEvent at
  // crmMergeService.ts:161). Disclosed bound, newest-first; unmerged events
  // stay listed (unmergedAt is the audit trail, not a deletion).
  app.get('/v1/host/openwop-app/cdp/merge-events', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const events = await listMergeEvents(tenantOf(req), limit);
      res.json({ events, limit });
    } catch (err) {
      next(err);
    }
  });

  // Unified governance decision log (ADR 0268 / CDP-F) — consent/purpose/firewall/
  // retention/masking decisions in one queryable stream, tenant-filtered.
  app.get('/v1/host/openwop-app/cdp/governance-decisions', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      // R2 CD-SP-2 / CDP-G4 — escalating tenant read + an `exhaustive` flag so
      // the UI can disclose a bounded read instead of presenting it as complete.
      const { rows, exhaustive } = await listGovernanceDecisionsWithBound(tenantOf(req), { limit });
      res.json({ decisions: rows, limit, exhaustive });
    } catch (err) {
      next(err);
    }
  });

  // Tamper-evident audit hash-chain verification (ADR 0301 / CDP-F) — admin-gated,
  // tenant-scoped: walks the tenant's consent/governance-decision chain and reports
  // whether it is intact (and, if not, the first broken seq).
  app.get('/v1/host/openwop-app/cdp/audit-chain/verify', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireAdmin(req);
      const tenantId = tenantOf(req);
      const [result, head] = await Promise.all([verifyChain(tenantId), getAuditHead(tenantId)]);
      res.json({ ...result, length: head ? head.seq : 0 });
    } catch (err) {
      next(err);
    }
  });
}
