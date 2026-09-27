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
  listBriefs, getBrief, createBrief, updateBrief, deleteBrief, validateBrief, listBriefVersions, duplicateBrief,
} from './briefService.js';
import { BUYER_STAGES, CAMPAIGN_CHANNELS, type CampaignBrief, type Persona } from './types.js';
import { listVocEvidence, deleteVocEvidence, VOC_SENTIMENTS, type VocSentiment } from './vocService.js';
import { listAngles, deleteAngle, anglesCiting } from './angleService.js';
import { listHooks, getHook, promoteHook, HOOK_STATUSES, type HookStatus } from './hookBankService.js';
import { listTargetingPacks, deleteTargetingPack, targetingCiting, isTargetingPlatform } from './targetingService.js';

const TOGGLE_ID = 'campaign-brief';
const LABEL = 'Campaign Brief';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/**
 * The org-scope predicate the routes gate on — extracted so the chat agent tools
 * (agentTools.ts) share the EXACT same authority as the HTTP routes (CFP-1 hard
 * rule #1: one helper, route + tool both call it). `subject` undefined ⇒ never
 * granted (fail-closed, no anonymous authority).
 */
export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

export async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  return orgScopeGranted(tenantOf(req), actingUserOf(req), orgId, scope);
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
      const updated = await updateBrief(tenantOf(req), brief.id, (req.body ?? {}) as Record<string, unknown>, actingUserOf(req) ?? 'unknown');
      if (!updated) throw new OpenwopError('not_found', 'Brief not found.', 404, { briefId: brief.id });
      res.json({ brief: updated });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/briefs/:briefId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:write');
      await deleteBrief(tenantOf(req), brief.id, actingUserOf(req) ?? 'unknown');
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

  // Duplicate as a fresh draft (C8 "use as template").
  app.post(`${BASE}/briefs/:briefId/duplicate`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:write');
      const name = typeof (req.body ?? {})?.name === 'string' ? (req.body as { name: string }).name : undefined;
      const copy = await duplicateBrief(tenantOf(req), brief.id, actingUserOf(req) ?? 'unknown', name);
      if (!copy) throw new OpenwopError('not_found', 'Brief not found.', 404, { briefId: brief.id });
      res.status(201).json({ brief: copy });
    } catch (err) { next(err); }
  });

  // Revision history (campaign gap plan §5B B4 — the CMS versions precedent).
  app.get(`${BASE}/briefs/:briefId/versions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:read');
      res.json({ versions: await listBriefVersions(tenantOf(req), brief.id) });
    } catch (err) { next(err); }
  });

  // ── ADR 0403 Phase 1 — VOC evidence (quote-level, citation-carrying) ──────
  app.get(`${BASE}/briefs/:briefId/voc`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:read');
      const sentiment = typeof req.query.sentiment === 'string' && (VOC_SENTIMENTS as readonly string[]).includes(req.query.sentiment)
        ? (req.query.sentiment as VocSentiment) : undefined;
      const theme = typeof req.query.theme === 'string' && req.query.theme ? req.query.theme : undefined;
      res.json({ evidence: await listVocEvidence(tenantOf(req), brief.id, { ...(sentiment ? { sentiment } : {}), ...(theme ? { theme } : {}) }) });
    } catch (err) { next(err); }
  });

  // Curation: prune a bad quote (workspace:write; uniform 404 cross-tenant).
  // An angle citing this evidence blocks the delete (409) — a delete must not
  // silently break the "every proofRef resolves" invariant; prune the angle first.
  app.delete(`${BASE}/briefs/:briefId/voc/:evidenceId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:write');
      const evidenceId = requireString(req.params.evidenceId, 'evidenceId');
      const citing = await anglesCiting(tenantOf(req), brief.id, evidenceId);
      if (citing.length > 0) {
        throw new OpenwopError('conflict', 'This evidence is cited by stored angles — delete those angles first.', 409, { evidenceId, citingAngleIds: citing.map((a) => a.id).slice(0, 20) });
      }
      const citingPacks = await targetingCiting(tenantOf(req), brief.id, evidenceId);
      if (citingPacks.length > 0) {
        throw new OpenwopError('conflict', 'This evidence is cited by stored targeting packs — delete those packs first.', 409, { evidenceId, citingPlatforms: citingPacks.map((p) => p.platform) });
      }
      const removed = await deleteVocEvidence(tenantOf(req), brief.id, evidenceId);
      if (!removed) throw new OpenwopError('not_found', 'Evidence not found.', 404, { evidenceId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── ADR 0403 Phase 2 — ad angles + the org hook bank ──────────────────────
  app.get(`${BASE}/briefs/:briefId/angles`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:read');
      res.json({ angles: await listAngles(tenantOf(req), brief.id) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/briefs/:briefId/angles/:angleId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:write');
      const removed = await deleteAngle(tenantOf(req), brief.id, requireString(req.params.angleId, 'angleId'));
      if (!removed) throw new OpenwopError('not_found', 'Angle not found.', 404, { angleId: req.params.angleId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // Hook bank (org-scoped, brief-independent). Uniform 404 when the caller
  // lacks read in the org — the hooks-carry-no-briefId loadHookScoped shape.
  app.get(`${BASE}/hooks`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      if (!(await hasOrgScope(req, orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Not found.', 404);
      }
      const status = typeof req.query.status === 'string' && (HOOK_STATUSES as readonly string[]).includes(req.query.status)
        ? (req.query.status as HookStatus) : undefined;
      res.json({ hooks: await listHooks(tenantOf(req), orgId, { ...(status ? { status } : {}) }) });
    } catch (err) { next(err); }
  });

  // Promotion is the HUMAN gate (candidate→tested→retired) — deliberately a
  // route-only write, never a surface op the agent could call (ADR 0403 P2).
  app.post(`${BASE}/hooks/:hookId/promote`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      const hookId = requireString(req.params.hookId, 'hookId');
      const existing = await getHook(tenantOf(req), orgId, hookId);
      if (!existing || !(await hasOrgScope(req, orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Hook not found.', 404, { hookId });
      }
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const updated = await promoteHook(tenantOf(req), orgId, hookId, requireString(body.status, 'status'), body.metricRef);
      if (!updated) throw new OpenwopError('not_found', 'Hook not found.', 404, { hookId });
      res.json({ hook: updated });
    } catch (err) { next(err); }
  });

  // ── ADR 0403 Phase 3 — targeting packs (read + curation delete) ──────────
  app.get(`${BASE}/briefs/:briefId/targeting`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:read');
      res.json({ packs: await listTargetingPacks(tenantOf(req), brief.id) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/briefs/:briefId/targeting/:platform`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const brief = await loadBriefScoped(req, 'workspace:write');
      const platform = req.params.platform;
      if (!isTargetingPlatform(platform)) throw new OpenwopError('not_found', 'Targeting pack not found.', 404, { platform });
      const removed = await deleteTargetingPack(tenantOf(req), brief.id, platform);
      if (!removed) throw new OpenwopError('not_found', 'Targeting pack not found.', 404, { platform });
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
