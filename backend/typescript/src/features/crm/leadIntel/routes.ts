/**
 * ADR 0954 D3 — the lead-intelligence routes, one client at a time:
 * `/host/openwop-app/crm/clients/:orgId/leads/*`. Host extension, no RFC.
 *
 * Gate, fail-closed: `crm` on (toggle + plan) AND the `crm.lead-intelligence`
 * sub-toggle on, then scope on the exact client org. A client the caller cannot
 * even read is the same 404 as one that does not exist (ADR 0921 D3), and the
 * workspace root is never a client. Models need `workspace:write` AND
 * `host:members:manage` on the client; leads and grades need read / write.
 */
import type { Request, RequestHandler } from 'express';
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../../types.js';
import { resolveEffectiveAccess, type Scope } from '../../../host/accessControlService.js';
import { tombstoneId } from '../../consent/consentService.js';
import { canonicalRequestDigest, idempotencyLeaseMs, type IdempotentEndpoint } from '../../../host/idempotentResponse.js';
import { createLogger } from '../../../observability/logger.js';
import { personalTenantOf } from '../../../host/requestSubject.js';
import { checkEntitlement } from '../../../host/entitlementSeam.js';
import { requireFeatureEnabled, requireOrgScope, tenantOf } from '../../featureRoute.js';
import { resolveCallerUser } from '../../users/usersGuards.js';
import { getContact } from '../contactsService.js';
import { LEAD_INTEL_TOGGLE } from './constants.js';
import { admitLeadDispatch } from './runAdmission.js';
import { getAssessmentForRun } from './assessment.js';
import { latestRoutingPolicy, saveRoutingPolicy } from './routingPolicy.js';
import { getRoutingDecision } from './routing.js';
import { getSlaSettings, saveSlaSettings } from './speedToLead.js';
import { activateModel, listModelVersions, resolveActiveModel, saveModelVersion } from './modelStore.js';
import {
  bindLead, getLeadGrade, getLeadProfile, LEAD_SOURCES, listLeadGrades, listLeadProfiles, type LeadSource,
} from './leadStore.js';
import { explainGrade } from './grading.js';

const BASE = '/host/openwop-app/crm/clients/:orgId/leads';
const GRADE_ENDPOINT = 'POST:/host/openwop-app/crm/clients/:orgId/leads/:contactId/grade' satisfies IdempotentEndpoint;
const QUALIFY_ENDPOINT = 'POST:/host/openwop-app/crm/clients/:orgId/leads/:contactId/qualify' satisfies IdempotentEndpoint;
const ROUTE_ENDPOINT = 'POST:/host/openwop-app/crm/clients/:orgId/leads/:contactId/route' satisfies IdempotentEndpoint;
const log = createLogger('crm.leadIntel');

interface LeadCtx { tenantId: string; orgId: string; userId: string }

/** The one gate every lead-intelligence route passes. */
async function authorizeLeadClient(req: Request, scope: Scope): Promise<LeadCtx> {
  await requireFeatureEnabled(req, 'crm', 'CRM');
  await checkEntitlement(req, 'crm');
  await requireFeatureEnabled(req, LEAD_INTEL_TOGGLE, 'Lead intelligence');
  const tenantId = tenantOf(req);
  const orgId = req.params.orgId ?? '';
  if (!orgId || orgId === tenantId) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId });
  try {
    const { user } = await requireOrgScope(req, scope);
    return { tenantId, orgId, userId: user.userId };
  } catch (err) {
    // A client the caller cannot even read is indistinguishable from none.
    if (err instanceof OpenwopError && err.code === 'forbidden_scope' && scope !== 'workspace:read') {
      const user = await resolveCallerUser(req);
      const canRead = (await resolveEffectiveAccess(tenantId, { subject: user.userId, orgId })).scopes.includes('workspace:read');
      if (canRead) throw err;
    }
    if (err instanceof OpenwopError && (err.code === 'forbidden_scope' || err.code === 'not_found')) {
      throw new OpenwopError('not_found', 'Client not found.', 404, { orgId });
    }
    throw err;
  }
}

/** Models: `workspace:write` and `host:members:manage` on the client. */
async function authorizeModelEditor(req: Request): Promise<LeadCtx> {
  const ctx = await authorizeLeadClient(req, 'workspace:write');
  await requireOrgScope(req, 'host:members:manage');
  return ctx;
}

export function registerLeadIntelRoutes(deps: RouteDeps): void {
  const { app, storage, hostSuite } = deps;

  // ── Leads ──

  app.get(BASE, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeLeadClient(req, 'workspace:read');
      const [profiles, grades] = await Promise.all([listLeadProfiles(tenantId, orgId), listLeadGrades(tenantId, orgId)]);
      const gradeOf = new Map(grades.map((g) => [g.contactId, g]));
      res.json({
        leads: profiles.map((p) => {
          const g = gradeOf.get(p.contactId);
          return { ...p, grade: g?.band !== undefined ? { band: g.band, score: g.score, modelId: g.modelId, modelVersion: g.modelVersion, computedAt: g.computedAt, truncated: g.truncated === true } : null };
        }),
      });
    } catch (err) { next(err); }
  });

  /** Bind a contact of this workspace to this client as a lead. */
  app.post(BASE, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await authorizeLeadClient(req, 'workspace:write');
      const body = (req.body ?? {}) as { contactId?: unknown; source?: unknown };
      const contactId = typeof body.contactId === 'string' ? body.contactId : '';
      const contact = contactId ? await getContact(contactId) : null;
      if (!contact || contact.tenantId !== tenantId || contact.mergedInto) {
        throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId });
      }
      const source = (LEAD_SOURCES as readonly string[]).includes(body.source as string) ? body.source as LeadSource : 'manual';
      const out = await bindLead({ tenantId, orgId, contactId, source, boundBy: userId });
      res.status(out.created ? 201 : 200).json(out);
    } catch (err) { next(err); }
  });

  // ── Routing (ADR 0954 D5) ──

  /** The routing record of one round (who was considered, skipped, chosen). */
  app.get(`${BASE}/sla-settings`, async (req, res, next) => {
    try { const { tenantId, orgId } = await authorizeLeadClient(req, 'workspace:read'); res.json({ settings: await getSlaSettings(tenantId, orgId) }); }
    catch (err) { next(err); }
  });
  app.put(`${BASE}/sla-settings`, async (req, res, next) => {
    try { const { tenantId, orgId, userId } = await authorizeModelEditor(req); res.json({ settings: await saveSlaSettings(tenantId, orgId, req.body, userId) }); }
    catch (err) { next(err); }
  });

  app.get(`${BASE}/:contactId/routing/:epoch`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeLeadClient(req, 'workspace:read');
      const epoch = Number.parseInt(req.params.epoch ?? '', 10);
      const decision = Number.isInteger(epoch) ? await getRoutingDecision(tenantId, orgId, req.params.contactId, epoch) : null;
      if (!decision) throw new OpenwopError('not_found', 'Routing record not found.', 404, {});
      res.json({ decision });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/routing-policy`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeLeadClient(req, 'workspace:read');
      res.json({ policy: await latestRoutingPolicy(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  /** Save a new policy version. Body: `{ expectedVersion, rules }`. */
  app.post(`${BASE}/routing-policy`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await authorizeModelEditor(req);
      const body = (req.body ?? {}) as { expectedVersion?: unknown; rules?: unknown };
      const policy = await saveRoutingPolicy({ tenantId, orgId, expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : -1, rules: body.rules, actor: userId });
      res.status(201).json({ policy });
    } catch (err) { next(err); }
  });

  // Models must precede :contactId/grade: "grade" is also a valid model id.
  // ── Scoring models ──

  app.get(`${BASE}/models/active`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeLeadClient(req, 'workspace:read');
      const m = await resolveActiveModel(tenantId, orgId);
      res.json({ modelId: m.modelId, version: m.version, model: m.content });
    } catch (err) { next(err); }
  });

  const listVersions: RequestHandler = async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeLeadClient(req, 'workspace:read');
      res.json({ versions: await listModelVersions(tenantId, orgId, req.params.modelId ?? '') });
    } catch (err) { next(err); }
  };
  // Explicit versions path also supports a model named "active"; the shorter
  // /models/active URL keeps its established active-selection meaning.
  app.get(`${BASE}/models/:modelId/versions`, listVersions);
  app.get(`${BASE}/models/:modelId`, listVersions);

  /** Save a new version. Body: `{ expectedVersion, model }`. */
  app.post(`${BASE}/models/:modelId`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await authorizeModelEditor(req);
      const body = (req.body ?? {}) as { expectedVersion?: unknown; model?: unknown };
      const saved = await saveModelVersion({
        tenantId, orgId, modelId: req.params.modelId,
        expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : -1,
        content: body.model, actor: userId,
      });
      res.status(201).json({ model: saved });
    } catch (err) { next(err); }
  });

  /** Make one saved version the client's scoring model. Body: `{ version, expected }`. */
  app.post(`${BASE}/models/:modelId/activate`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await authorizeModelEditor(req);
      const body = (req.body ?? {}) as { version?: unknown; expected?: { modelId?: unknown; version?: unknown } | null };
      const version = typeof body.version === 'number' ? body.version : NaN;
      const expected = body.expected && typeof body.expected.modelId === 'string' && typeof body.expected.version === 'number'
        ? { modelId: body.expected.modelId, version: body.expected.version } : null;
      res.json({ active: await activateModel({ tenantId, orgId, modelId: req.params.modelId, version, actor: userId, expected }) });
    } catch (err) { next(err); }
  });

  /** The stored grade beside a live recompute (`?explain=1`) or the projection alone. */
  app.get(`${BASE}/:contactId/grade`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeLeadClient(req, 'workspace:read');
      const contactId = req.params.contactId;
      if (!(await getLeadProfile(tenantId, orgId, contactId))) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
      if (req.query.explain === '1') { res.json(await explainGrade(tenantId, orgId, contactId)); return; }
      res.json({ grade: await getLeadGrade(tenantId, orgId, contactId) });
    } catch (err) { next(err); }
  });

  /** Grade and route share the same frozen admission/response recipe. The
   * route's extra reservation/epoch is on its existing LeadProfile primary. */
  const leadStartHandler = (mode: 'grade' | 'route' | 'qualify'): RequestHandler => {
    const endpoint = mode === 'route' ? ROUTE_ENDPOINT : mode === 'qualify' ? QUALIFY_ENDPOINT : GRADE_ENDPOINT;
    return async (req, res, next) => {
      let held: { tenantId: string; key: string; claimToken: string; requestDigest: string } | undefined;
      try {
        const { tenantId, orgId, userId } = await authorizeLeadClient(req, 'workspace:write');
        const contactId = req.params.contactId;
        if (!(await getLeadProfile(tenantId, orgId, contactId))) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
        const requesterHash = tombstoneId(tenantId, userId);
        const idempotencyKey = req.header('idempotency-key');
        const requestKeyHash = idempotencyKey ? canonicalRequestDigest({ key: idempotencyKey }, endpoint) : undefined;
        if (idempotencyKey) {
          if (idempotencyKey.length > 256) throw new OpenwopError('validation_error', 'Idempotency-Key must be at most 256 characters.', 400, {});
          const requestDigest = canonicalRequestDigest({ orgId, contactId, requesterHash }, endpoint);
          const claim = await storage.claimIdempotentResponse({ tenantId, endpoint, key: idempotencyKey, requestDigest, createdAt: new Date().toISOString(), leaseMs: idempotencyLeaseMs() });
          if (claim.outcome === 'replay') {
            res.status(claim.responseStatus).set('openwop-Idempotent-Replay', 'true').json(JSON.parse(claim.responseBody));
            return;
          }
          if (claim.outcome === 'mismatch') throw new OpenwopError('idempotency_key_mismatch', 'Idempotency-Key was used for different grading work.', 409, {});
          if (claim.outcome === 'in-flight') {
            res.set('Retry-After', '1');
            throw new OpenwopError('idempotency_in_flight', 'This grading request is already in flight. Retry with the same key.', 409, { retryAfter: 1 });
          }
          held = { tenantId, key: idempotencyKey, claimToken: claim.claimToken, requestDigest };
        }
        const response = await admitLeadDispatch({ storage, hostSuite }, {
          mode, tenantId, orgId, contactId, userId, requestKeyHash,
          ...(personalTenantOf(req) ? { personalTenant: personalTenantOf(req) } : {}),
          ...(held ? { responseCommit: { endpoint, key: held.key, claimToken: held.claimToken } } : {}),
        });
        const { runId } = response;
        const responseBody = JSON.stringify(response);
        if (held) {
          // A new insert already completed this atomically. A coalesced existing
          // run still needs this key's response after its frame was verified.
          const complete = () => storage.completeIdempotentResponse({ tenantId, endpoint, key: held!.key, claimToken: held!.claimToken, responseStatus: 202, responseBody, runId, updatedAt: new Date().toISOString() });
          let completed = await complete();
          if (!completed) {
            const check = await storage.claimIdempotentResponse({ tenantId, endpoint, key: held.key, requestDigest: held.requestDigest, createdAt: new Date().toISOString(), leaseMs: idempotencyLeaseMs() });
            if (check.outcome === 'replay') completed = check.responseStatus === 202 && check.responseBody === responseBody;
            else if (check.outcome === 'claimed') { held.claimToken = check.claimToken; completed = await complete(); }
          }
          if (!completed) {
            res.set('Retry-After', '1');
            throw new OpenwopError('idempotency_in_flight', 'The grading response could not be confirmed. Retry with the same key.', 409, { retryAfter: 1 });
          }
        }
        res.status(202).json(response);
      } catch (err) { next(err); }
      finally {
        if (held) await storage.releaseIdempotentResponse({ tenantId: held.tenantId, endpoint, key: held.key, claimToken: held.claimToken }).catch((err: unknown) => {
          log.warn('lead_grade_idempotency_release_failed', { error: err instanceof Error ? err.name : 'unknown' });
        });
      }
    };
  };
  app.post(`${BASE}/:contactId/grade`, leadStartHandler('grade'));
  app.post(`${BASE}/:contactId/route`, leadStartHandler('route'));
  app.post(`${BASE}/:contactId/qualify`, leadStartHandler('qualify'));
  app.get(`${BASE}/:contactId/assessments/:runId`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeLeadClient(req, 'workspace:read');
      const a = await getAssessmentForRun(tenantId, orgId, req.params.contactId, req.params.runId);
      if (!a) throw new OpenwopError('not_found', 'Assessment not found.', 404, {});
      const { tenantId: _tenant, ...assessment } = a;
      res.json({ assessment });
    } catch (err) { next(err); }
  });




}
