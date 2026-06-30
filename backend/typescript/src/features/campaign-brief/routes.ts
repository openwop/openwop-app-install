/**
 * Campaign Brief routes (ADR 0156) — host-extension under
 * /v1/host/openwop-app/campaign-brief/*.
 *
 * Gating, fail-closed (ADR 0006), mirroring the brand/priority-matrix per-entity
 * org gate: toggle `campaign-brief` ON → RBAC in the entity's org (read =
 * workspace:read, a miss → uniform 404; write = workspace:write).
 *
 * Phase 1 mounts the persona routes; Phase 2 adds the brief routes.
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import {
  listPersonas, getPersona, createPersona, updatePersona, deletePersona,
} from './personaService.js';
import {
  listBriefs, getBrief, createBrief, updateBrief, deleteBrief, validateBrief,
} from './briefService.js';
import { BUYER_STAGES, CAMPAIGN_CHANNELS, type CampaignBrief, type Persona } from './types.js';

const TOGGLE_ID = 'campaign-brief';
const LABEL = 'Campaign Brief';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

export async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  return access.scopes.includes(scope);
}

export async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await hasOrgScope(req, orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

async function loadPersonaScoped(req: Request, scope: Scope): Promise<Persona> {
  const persona = await getPersona(tenantOf(req), req.params.personaId);
  if (!persona || !(await hasOrgScope(req, persona.orgId, 'workspace:read'))) {
    throw new OpenwopError('not_found', 'Persona not found.', 404, { personaId: req.params.personaId });
  }
  if (scope !== 'workspace:read') await requireOrgScopeFor(req, persona.orgId, scope);
  return persona;
}

async function readablePersonas(req: Request, orgId?: string, brandId?: string): Promise<Persona[]> {
  const all = await listPersonas(tenantOf(req), orgId, brandId);
  const readable = new Map<string, boolean>();
  const out: Persona[] = [];
  for (const p of all) {
    let ok = readable.get(p.orgId);
    if (ok === undefined) { ok = await hasOrgScope(req, p.orgId, 'workspace:read'); readable.set(p.orgId, ok); }
    if (ok) out.push(p);
  }
  return out;
}

export function registerCampaignBriefRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/campaign-brief';

  // ── static vocabulary ──
  app.get(`${BASE}/buyer-stages`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json({ buyerStages: BUYER_STAGES, channels: CAMPAIGN_CHANNELS });
    } catch (err) { next(err); }
  });

  // ── personas ──
  app.get(`${BASE}/personas`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = typeof req.query.orgId === 'string' && req.query.orgId.length > 0 ? req.query.orgId : undefined;
      const brandId = typeof req.query.brandId === 'string' && req.query.brandId.length > 0 ? req.query.brandId : undefined;
      res.json({ personas: await readablePersonas(req, orgId, brandId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/personas`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const persona = await createPersona(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', body);
      res.status(201).json({ persona });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/personas/:personaId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json({ persona: await loadPersonaScoped(req, 'workspace:read') });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/personas/:personaId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const persona = await loadPersonaScoped(req, 'workspace:write');
      const updated = await updatePersona(tenantOf(req), persona.id, (req.body ?? {}) as Record<string, unknown>);
      if (!updated) throw new OpenwopError('not_found', 'Persona not found.', 404, { personaId: persona.id });
      res.json({ persona: updated });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/personas/:personaId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const persona = await loadPersonaScoped(req, 'workspace:write');
      await deletePersona(tenantOf(req), persona.id);
      res.json({ deleted: true, personaId: persona.id });
    } catch (err) { next(err); }
  });

  // ── briefs (ADR 0156 Phase 2) ──
  const loadBriefScoped = async (req: Request, scope: Scope): Promise<CampaignBrief> => {
    const brief = await getBrief(tenantOf(req), req.params.briefId);
    if (!brief || !(await hasOrgScope(req, brief.orgId, 'workspace:read'))) {
      throw new OpenwopError('not_found', 'Brief not found.', 404, { briefId: req.params.briefId });
    }
    if (scope !== 'workspace:read') await requireOrgScopeFor(req, brief.orgId, scope);
    return brief;
  };

  app.get(`${BASE}/briefs`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = typeof req.query.orgId === 'string' && req.query.orgId.length > 0 ? req.query.orgId : undefined;
      const all = await listBriefs(tenantOf(req), orgId);
      const out: CampaignBrief[] = [];
      const readable = new Map<string, boolean>();
      for (const b of all) {
        let ok = readable.get(b.orgId);
        if (ok === undefined) { ok = await hasOrgScope(req, b.orgId, 'workspace:read'); readable.set(b.orgId, ok); }
        if (ok) out.push(b);
      }
      res.json({ briefs: out });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/briefs`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const brief = await createBrief(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', body);
      res.status(201).json({ brief });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/briefs/:briefId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json({ brief: await loadBriefScoped(req, 'workspace:read') });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/briefs/:briefId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:write');
      const updated = await updateBrief(tenantOf(req), brief.id, (req.body ?? {}) as Record<string, unknown>);
      if (!updated) throw new OpenwopError('not_found', 'Brief not found.', 404, { briefId: brief.id });
      res.json({ brief: updated });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/briefs/:briefId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:write');
      await deleteBrief(tenantOf(req), brief.id);
      res.json({ deleted: true, briefId: brief.id });
    } catch (err) { next(err); }
  });

  // Validate completeness + compute the enabled channel set (drives 0158 fan-out).
  app.post(`${BASE}/briefs/:briefId/validate`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:read');
      res.json(validateBrief(brief));
    } catch (err) { next(err); }
  });
}
