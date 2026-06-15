/**
 * Consent feature routes (host-extension, ADR 0020).
 *   Public (unauthed):  /v1/host/openwop-app/public-consent/:orgId[/:subjectKey]
 *   Authed (org-scoped, RBAC):  /v1/host/openwop-app/consent/orgs/:orgId/*
 * The public prefix is on PUBLIC_PATH_PREFIXES (auth.ts). Consent is TENANT-scoped
 * (a visitor's choices apply across the tenant's orgs); the public path resolves
 * org→tenant and gates on the org-tenant's `consent` toggle (uniform 404).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg } from '../../host/accessControlService.js';
import {
  recordConsent, getConsent, listConsent, getPolicy, setPolicy, deleteSubject, type DefaultMode,
} from './consentService.js';

const FEATURE = { toggleId: 'consent', label: 'Consent' };
const ORG = '/v1/host/openwop-app/consent/orgs/:orgId';
const PUB = '/v1/host/openwop-app/public-consent';

type Scope = 'workspace:read' | 'workspace:write';

export function registerConsentRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // org → tenant, gated on the org-tenant's `consent` toggle (uniform 404).
  const resolvePublicTenant = async (orgId: string): Promise<string> => {
    const notFound = (): never => { throw new OpenwopError('not_found', 'Not found.', 404, {}); };
    const org = await getOrg(orgId);
    if (!org) return notFound();
    const a = await resolveOne(FEATURE.toggleId, { tenantId: org.tenantId });
    if (!a || !a.enabled) return notFound();
    return org.tenantId;
  };

  // ───────────────────────── public record + read ─────────────────────────────
  app.post(`${PUB}/:orgId`, async (req, res, next) => {
    try {
      const tenantId = await resolvePublicTenant(req.params.orgId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const region = optionalString(body.region);
      const rec = await recordConsent({
        tenantId,
        subjectKey: requireString(body.subjectKey, 'subjectKey'),
        categories: body.categories,
        ...(region ? { region } : {}),
        source: 'public',
      });
      res.status(201).json({ ok: true, categories: rec.categories });
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/:orgId/:subjectKey`, async (req, res, next) => {
    try {
      const tenantId = await resolvePublicTenant(req.params.orgId);
      const rec = await getConsent(tenantId, req.params.subjectKey);
      if (rec) { res.json({ recorded: true, categories: rec.categories, ...(rec.region ? { region: rec.region } : {}) }); return; }
      const policy = await getPolicy(tenantId);
      res.json({ recorded: false, defaultMode: policy?.defaultMode ?? 'opt-in', categories: { necessary: true, analytics: false, marketing: false } });
    } catch (err) { next(err); }
  });

  // ───────────────────────── authed policy + records + data-subject ───────────
  app.get(`${ORG}/policy`, async (req, res, next) => {
    try {
      const { user } = await authz(req, 'workspace:read');
      res.json({ policy: (await getPolicy(user.tenantId)) ?? { tenantId: user.tenantId, regulatedRegions: [], defaultMode: 'opt-in' as DefaultMode } });
    } catch (err) { next(err); }
  });

  app.put(`${ORG}/policy`, async (req, res, next) => {
    try {
      const { user } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const input: { regulatedRegions?: string[]; defaultMode?: DefaultMode } = {};
      if (Array.isArray(body.regulatedRegions)) input.regulatedRegions = body.regulatedRegions.filter((r): r is string => typeof r === 'string');
      if (body.defaultMode === 'opt-in' || body.defaultMode === 'opt-out') input.defaultMode = body.defaultMode;
      res.json({ policy: await setPolicy(user.tenantId, input) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/records`, async (req, res, next) => {
    try { const { user } = await authz(req, 'workspace:read'); res.json({ records: await listConsent(user.tenantId) }); }
    catch (err) { next(err); }
  });

  app.get(`${ORG}/subjects/:subjectKey`, async (req, res, next) => {
    try { const { user } = await authz(req, 'workspace:read'); res.json({ record: await getConsent(user.tenantId, req.params.subjectKey) }); }
    catch (err) { next(err); }
  });

  app.delete(`${ORG}/subjects/:subjectKey`, async (req, res, next) => {
    try {
      const { user } = await authz(req, 'workspace:write');
      // GDPR erasure: idempotent — purges the consent record + fans out to every
      // registered feature eraser (Analytics events, …). No 404; erasing a subject
      // with no consent record still purges downstream data.
      const result = await deleteSubject(user.tenantId, req.params.subjectKey);
      res.status(200).json({ ok: true, ...result });
    } catch (err) { next(err); }
  });
}
