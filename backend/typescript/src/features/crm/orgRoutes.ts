/**
 * CRM org-scoped routes (ADR 0008) — the formal Orgs + RBAC surface added
 * AROUND the preserved tenant-scoped contacts. Companies / Deals / Pipelines
 * (Phase 1); Tasks / Activities (Phase 2); custom fields + import (Phase 3).
 *
 * Surface under /v1/host/openwop-app/crm/orgs/:orgId. Every route is gated by the
 * media-style `authorize()` (toggle on `crm` + the caller's RFC 0049 scope in
 * the path org): read → workspace:read, write → workspace:write; a non-member
 * fails closed (403); an org outside the caller's tenant 404s.
 *
 * @see docs/adr/0008-crm-full-port.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import { filterVisibleCrmRecords, type CrmVisibilityTarget } from '../../host/crmRecordVisibility.js';
import type { User } from '../users/usersService.js';
import type { Scope } from '../../host/accessControlService.js';
import { crmMutated } from './emit.js';
import { createContact, getContact, listContacts } from './contactsService.js';
import {
  assertUnderCap,
  MAX_PER_ORG_ENTITIES,
  createFieldDef,
  deleteFieldDef,
  listContactFieldDefs,
  listFieldDefs,
  makeLinkValidators,
  validateCustomFields,
  resolveContactCustomFields,
  ORG_CUSTOM_ENTITIES,
  type CustomEntity,
  type CustomFieldRefResolvers,
  type FieldDef,
  type FieldType,
} from './crmEntitiesService.js';
import {
  createActivity,
  createCompany,
  createDeal,
  createPipeline,
  createTask,
  deleteCompany,
  deleteDeal,
  deletePipeline,
  deleteTask,
  getCompany,
  getDeal,
  getOrCreateDefaultPipeline,
  getStageHistory,
  getTask,
  listActivities,
  listCompanies,
  listDeals,
  listPipelines,
  listTasks,
  updateCompany,
  updateDeal,
  updatePipeline,
  updateTask,
  type ActivityKind,
  type LinkValidators,
  type TaskStatus,
} from './crmEntitiesService.js';
import { findDuplicateCompanies, mergeCompanies, unmergeCompanies } from './crmMergeService.js';
import { listCompanyMergeEvents } from './crmCompanyMergeEventsService.js';
import { computePipelineReport } from './reportService.js';
import { customFieldColumns, toCsv } from './csvExport.js';

const TOGGLE_ID = 'crm';

/**
 * CRM-1 — `tenantId` is the tenant the gate AUTHORIZED in (the ACTIVE workspace
 * tenant), and it is the ONLY tenant these handlers may read or write in.
 *
 * This interface used to declare `{ user, orgId }` only. `authorizeOrgScope`
 * returns `tenantId` as well, so the correct value was present at runtime and
 * TYPE-ERASED at the door — every one of the 89 handlers below then reached for
 * `ctx.user.tenantId`, which is the caller's HOME tenant
 * (`users/usersGuards.ts` returns the canonical home-tenant user for every real
 * signed-in caller). In a personal workspace the two coincide, which is why every
 * test passed. In a shared `ws:` workspace they do not: the gate authorized
 * against `ws:xyz` and the handler then read and wrote the caller's PRIVATE
 * partition, so every member saw an invisible personal copy of the org's CRM and
 * every create filed a row tagged with one tenant carrying an `orgId` owned by
 * another. Keeping the field is what makes the correct source reachable —
 * and the ADR 0508 ratchet (`test/orgscope-tenant-source-ratchet.test.ts`) now
 * holds this module at zero re-derivations.
 */
interface Ctx {
  user: User;
  orgId: string;
  tenantId: string;
}

/** Toggle + org-scoped RBAC gate (the shared `authorizeOrgScope`) + the ADR 0419
 *  plan/bundle entitlement (CRM is a sellable-bundle feature). This ONE choke
 *  covers every authed org-scoped CRM route; no-op until PLAN_FEATURES narrows. */
const authorize = async (req: Request, scope: Scope): Promise<Ctx> => {
  const ctx = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: 'CRM' }, scope);
  await checkEntitlement(req, TOGGLE_ID);
  return ctx;
};

/** ADR 0272 P4 — single-record READ visibility. Returns `true` iff the caller may
 *  see `row` (a no-op ⇒ true unless the territories resolver is registered + the
 *  record is out of the caller's territories). Callers 404 on false (uniform, no
 *  existence disclosure). WRITE paths never call this — writes stay org-scoped. */
async function callerCanSee<T>(target: CrmVisibilityTarget, tenantId: string, orgId: string, viewer: string, row: T, idOf: (r: T) => string): Promise<boolean> {
  const visible = await filterVisibleCrmRecords({ tenantId, orgId, target, callerSubject: viewer, rows: [row], idOf });
  return visible.length > 0;
}

/** ADR 0272 Wave 2 — a linked `dealId`/`companyId` (on a new activity/task/deal)
 *  must be VISIBLE to the caller, else a UNIFORM 404 (same message the read path
 *  gives) — closing both the existence oracle (was a distinguishing "Linked …
 *  not found in this org") and the write-to-an-unseen-timeline. Contacts are
 *  tenant-scoped (not territory-scoped), so they are never gated here. No-op when
 *  territories is off (callerCanSee → allow-all). */
async function assertLinkedVisible(tenantId: string, orgId: string, viewer: string, links: { dealId?: string; companyId?: string }): Promise<void> {
  if (links.dealId) {
    const d = await getDeal(tenantId, orgId, links.dealId);
    if (!d || !(await callerCanSee('deal', tenantId, orgId, viewer, d, (x) => x.dealId))) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: links.dealId });
  }
  if (links.companyId) {
    const c = await getCompany(tenantId, orgId, links.companyId);
    if (!c || !(await callerCanSee('company', tenantId, orgId, viewer, c, (x) => x.companyId))) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: links.companyId });
  }
}

/** Link validators bound to this ctx's tenant/org (CRMGAP-11 — the shared
 *  `crmEntitiesService.makeLinkValidators`). */
const linkValidators = (ctx: Ctx): LinkValidators => makeLinkValidators(ctx.tenantId, ctx.orgId);

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `reference`-field resolvers bound to this org (ADR 0213 §1) — company/deal
 *  existence is checked IN THE ORG (cross-org refs 404-equivalent → rejected);
 *  a tombstoned company is refused even though `getCompany` itself doesn't
 *  filter tombstones (that's a deliberate `listCompanies`-only behavior — see
 *  `crmEntitiesService.tombstoneCompany`'s doc comment). Contacts stay tenant-wide. */
function refResolvers(ctx: Ctx): CustomFieldRefResolvers {
  return {
    company: async (id) => {
      const cmp = await getCompany(ctx.tenantId, ctx.orgId, id);
      return cmp !== null && !cmp.mergedInto;
    },
    deal: async (id) => (await getDeal(ctx.tenantId, ctx.orgId, id)) !== null,
    contact: async (id) => {
      const ct = await getContact(id);
      return ct !== null && ct.tenantId === ctx.tenantId && !ct.mergedInto;
    },
  };
}

/** Validate a customFields map against the org's field defs (Phase 3). On create
 *  (`requireAll`) every required field must be present; on patch, absent ⇒ leave.
 *  `defs` (CRMGAP-6): a bulk caller (the import route) passes its ONE pre-loop
 *  `listFieldDefs` fetch here instead of paying it again per row. */
async function resolveCustomFields(ctx: Ctx, entityType: CustomEntity, raw: unknown, requireAll: boolean, defs?: FieldDef[]): Promise<Record<string, string | number | boolean> | undefined> {
  if (raw === undefined && !requireAll) return undefined;
  const provided = isFieldMap(raw) ? raw : {};
  return validateCustomFields(ctx.tenantId, ctx.orgId, entityType, provided, { requireAll, ...(defs ? { defs } : {}), refResolvers: refResolvers(ctx) });
}

export function registerCrmOrgRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/crm/orgs/:orgId';

  // ── Pipelines ──
  app.get(`${BASE}/pipelines`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      await getOrCreateDefaultPipeline(ctx.tenantId, ctx.orgId); // ensure one exists
      res.json({ pipelines: await listPipelines(ctx.tenantId, ctx.orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/pipelines`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { name?: unknown; stages?: unknown };
      const name = requireString(body.name, 'name');
      const stages = Array.isArray(body.stages)
        ? body.stages.map((s) => ({ name: requireString((s as { name?: unknown })?.name, 'stage.name'), probability: num((s as { probability?: unknown })?.probability) ?? 0 }))
        : [];
      const pipeline = await createPipeline(ctx.tenantId, ctx.orgId, name, stages, undefined, { actor: ctx.user.userId }); // ADR 0627 D2 — events fire inside the services
      res.status(201).json(pipeline);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/pipelines/:pipelineId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { name?: unknown; stages?: unknown };
      const patch: { name?: string; stages?: Array<{ stageId?: string; name: string; probability?: number }> } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (Array.isArray(body.stages)) {
        patch.stages = body.stages.map((s) => {
          const o = (s ?? {}) as { stageId?: unknown; name?: unknown; probability?: unknown };
          return { ...(typeof o.stageId === 'string' ? { stageId: o.stageId } : {}), name: requireString(o.name, 'stage.name'), probability: num(o.probability) ?? 0 };
        });
      }
      const updated = await updatePipeline(ctx.tenantId, ctx.orgId, req.params.pipelineId, patch, { actor: ctx.user.userId });
      if (!updated) throw new OpenwopError('not_found', 'Pipeline not found.', 404, { pipelineId: req.params.pipelineId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/pipelines/:pipelineId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deletePipeline(ctx.tenantId, ctx.orgId, req.params.pipelineId, { actor: ctx.user.userId });
      if (!ok) throw new OpenwopError('not_found', 'Pipeline not found.', 404, { pipelineId: req.params.pipelineId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Companies ──
  app.get(`${BASE}/companies`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      // ADR 0272 P4: pass the caller as viewer → territory-scoped visibility
      // (a no-op unless the territories resolver is registered + active).
      res.json({ companies: await listCompanies(ctx.tenantId, ctx.orgId, optionalString(req.query.q), ctx.user.userId) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/companies`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const customFields = await resolveCustomFields(ctx, 'company', body.customFields, true);
      const company = await createCompany({
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        name: requireString(body.name, 'name'),
        domain: body.domain,
        industry: body.industry,
        // CRM-2 — the service validates fail-closed; pass raw values through.
        size: body.size,
        revenue: body.revenue,
        tags: body.tags,
        ...(customFields ? { customFields } : {}),
        createdBy: ctx.user.userId,
      });
      res.status(201).json(company);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/companies/:companyId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const c = await getCompany(ctx.tenantId, ctx.orgId, req.params.companyId);
      if (!c || !(await callerCanSee('company', ctx.tenantId, ctx.orgId, ctx.user.userId, c, (x) => x.companyId))) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: req.params.companyId });
      res.json(c);
    } catch (err) {
      next(err);
    }
  });

  // Duplicate review (ADR 0209 §1) — exact-key groups only; read scope.
  app.get(`${BASE}/duplicates`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const entityType = optionalString(req.query.entityType);
      if (entityType !== 'company') {
        throw new OpenwopError('validation_error', 'entityType must be `company`.', 400, { field: 'entityType' });
      }
      res.json(await findDuplicateCompanies(ctx.tenantId, ctx.orgId));
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/companies/:companyId/merge`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { sourceCompanyId?: unknown };
      const sourceCompanyId = requireString(body.sourceCompanyId, 'sourceCompanyId');
      // Wave 2 — a caller may only merge companies they can both see.
      const survivor = await getCompany(ctx.tenantId, ctx.orgId, req.params.companyId);
      const source = await getCompany(ctx.tenantId, ctx.orgId, sourceCompanyId);
      if (!survivor || !source
        || !(await callerCanSee('company', ctx.tenantId, ctx.orgId, ctx.user.userId, survivor, (x) => x.companyId))
        || !(await callerCanSee('company', ctx.tenantId, ctx.orgId, ctx.user.userId, source, (x) => x.companyId))) {
        throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: req.params.companyId });
      }
      const merged = await mergeCompanies(ctx.tenantId, ctx.orgId, req.params.companyId, sourceCompanyId, ctx.user.userId);
      res.json(merged);
    } catch (err) {
      next(err);
    }
  });

  // GEN-7 — company merge audit + reversal (org-scoped sibling of the contact
  // `/crm/merge-events` + `/unmerge`).
  app.get(`${BASE}/company-merge-events`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const events = (await listCompanyMergeEvents(ctx.tenantId)).filter((e) => e.orgId === ctx.orgId);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/company-merge-events/:id/unmerge`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const result = await unmergeCompanies(ctx.tenantId, ctx.orgId, req.params.id, { actor: ctx.user.userId });
      res.json({ unmerged: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/companies/:companyId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const existing = await getCompany(ctx.tenantId, ctx.orgId, req.params.companyId); // Wave 2 — write-scope
      if (!existing || !(await callerCanSee('company', ctx.tenantId, ctx.orgId, ctx.user.userId, existing, (x) => x.companyId))) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: req.params.companyId });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateCompany>[3] = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if ('domain' in body) patch.domain = body.domain === null ? null : optionalString(body.domain) ?? null;
      if ('industry' in body) patch.industry = body.industry === null ? null : optionalString(body.industry) ?? null;
      // CRM-2 — null clears; a value goes to the service to validate. A non-number/non-null is ignored.
      if ('size' in body) patch.size = body.size === null ? null : typeof body.size === 'number' ? body.size : undefined;
      if ('revenue' in body) patch.revenue = body.revenue === null ? null : typeof body.revenue === 'number' ? body.revenue : undefined;
      if (body.tags !== undefined) patch.tags = body.tags;
      const cf = await resolveCustomFields(ctx, 'company', 'customFields' in body ? body.customFields : undefined, false);
      if (cf !== undefined) patch.customFields = cf;
      const updated = await updateCompany(ctx.tenantId, ctx.orgId, req.params.companyId, patch, { actor: ctx.user.userId });
      if (!updated) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: req.params.companyId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/companies/:companyId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const existing = await getCompany(ctx.tenantId, ctx.orgId, req.params.companyId); // Wave 2 — write-scope
      if (!existing || !(await callerCanSee('company', ctx.tenantId, ctx.orgId, ctx.user.userId, existing, (x) => x.companyId))) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: req.params.companyId });
      const ok = await deleteCompany(ctx.tenantId, ctx.orgId, req.params.companyId, { actor: ctx.user.userId });
      if (!ok) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: req.params.companyId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Deals ──
  app.get(`${BASE}/deals`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const deals = await listDeals(
        ctx.tenantId,
        ctx.orgId,
        {
          ...(optionalString(req.query.pipelineId) ? { pipelineId: String(req.query.pipelineId) } : {}),
          ...(optionalString(req.query.stageId) ? { stageId: String(req.query.stageId) } : {}),
          ...(optionalString(req.query.companyId) ? { companyId: String(req.query.companyId) } : {}),
          ...(optionalString(req.query.q) ? { q: String(req.query.q) } : {}),
        },
        ctx.user.userId, // ADR 0272 P4 — viewer for territory-scoped visibility
      );
      res.json({ deals });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/deals`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Wave 2 — a new deal may link a companyId, but only one the caller can see.
      await assertLinkedVisible(ctx.tenantId, ctx.orgId, ctx.user.userId, { ...(optionalString(body.companyId) ? { companyId: String(body.companyId) } : {}) });
      const customFields = await resolveCustomFields(ctx, 'deal', body.customFields, true);
      const deal = await createDeal({
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        title: requireString(body.title, 'title'),
        ...(optionalString(body.pipelineId) ? { pipelineId: String(body.pipelineId) } : {}),
        ...(optionalString(body.stageId) ? { stageId: String(body.stageId) } : {}),
        ...(num(body.amount) !== undefined ? { amount: num(body.amount) } : {}),
        currency: body.currency,
        ...(optionalString(body.companyId) ? { companyId: String(body.companyId) } : {}),
        ...(optionalString(body.contactId) ? { contactId: String(body.contactId) } : {}),
        ...(optionalString(body.owner) ? { owner: String(body.owner) } : {}),
        ...(body.closeDate !== undefined ? { closeDate: body.closeDate } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(customFields ? { customFields } : {}),
        createdBy: ctx.user.userId,
        actor: ctx.user.userId,
        ...linkValidators(ctx),
      });
      res.status(201).json(deal);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/deals/:dealId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const d = await getDeal(ctx.tenantId, ctx.orgId, req.params.dealId);
      if (!d || !(await callerCanSee('deal', ctx.tenantId, ctx.orgId, ctx.user.userId, d, (x) => x.dealId))) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      res.json(d);
    } catch (err) {
      next(err);
    }
  });

  // Stage history (ADR 0210 §1) — newest first; read scope.
  app.get(`${BASE}/deals/:dealId/stage-history`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const d = await getDeal(ctx.tenantId, ctx.orgId, req.params.dealId);
      if (!d || !(await callerCanSee('deal', ctx.tenantId, ctx.orgId, ctx.user.userId, d, (x) => x.dealId))) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      res.json({ history: await getStageHistory(ctx.tenantId, ctx.orgId, req.params.dealId) });
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/deals/:dealId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      // ADR 0272 P4/Wave 2 — territory-scoped WRITE: you can only edit a deal you
      // can see (404 otherwise, uniform). No-op unless territories is active.
      const existing = await getDeal(ctx.tenantId, ctx.orgId, req.params.dealId);
      if (!existing || !(await callerCanSee('deal', ctx.tenantId, ctx.orgId, ctx.user.userId, existing, (x) => x.dealId))) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateDeal>[3] = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (optionalString(body.pipelineId)) patch.pipelineId = String(body.pipelineId);
      if (optionalString(body.stageId)) patch.stageId = String(body.stageId);
      if ('amount' in body) patch.amount = body.amount === null ? null : num(body.amount) ?? null;
      if ('currency' in body) patch.currency = body.currency === null ? null : optionalString(body.currency) ?? null;
      if ('companyId' in body) patch.companyId = body.companyId === null ? null : optionalString(body.companyId) ?? null;
      if ('contactId' in body) patch.contactId = body.contactId === null ? null : optionalString(body.contactId) ?? null;
      if ('owner' in body) patch.owner = body.owner === null ? null : optionalString(body.owner) ?? null;
      if ('closeDate' in body) patch.closeDate = body.closeDate;
      if ('status' in body) patch.status = body.status;
      const cf = await resolveCustomFields(ctx, 'deal', 'customFields' in body ? body.customFields : undefined, false);
      if (cf !== undefined) patch.customFields = cf;
      // ADR 0627 D2 — `updated` / `stage-changed` / `won|lost` are decided on the
      // LANDED row inside `updateDeal` (a re-PATCH of the same stage/status is
      // not a transition — this handler used to re-emit `won` on every PATCH).
      const updated = await updateDeal(ctx.tenantId, ctx.orgId, req.params.dealId, patch, linkValidators(ctx), ctx.user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/deals/:dealId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const existing = await getDeal(ctx.tenantId, ctx.orgId, req.params.dealId); // Wave 2 — write-scope
      if (!existing || !(await callerCanSee('deal', ctx.tenantId, ctx.orgId, ctx.user.userId, existing, (x) => x.dealId))) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      const ok = await deleteDeal(ctx.tenantId, ctx.orgId, req.params.dealId, { actor: ctx.user.userId });
      if (!ok) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // The ONE pipeline report (ADR 0210 §3) — one fetch, no dashboard fan-out.
  app.get(`${BASE}/reports/pipeline`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const pipelineId = optionalString(req.query.pipelineId);
      res.json(await computePipelineReport(ctx.tenantId, ctx.orgId, pipelineId, Date.now(), ctx.user.userId));
    } catch (err) {
      next(err);
    }
  });

  // ── CSV export (ADR 0210 §5) ──
  app.get(`${BASE}/export`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const entityType = optionalString(req.query.entityType);
      const date = new Date().toISOString().slice(0, 10);
      let csv: string;
      if (entityType === 'companies') {
        // ADR 0272 P4 — export honors territory-scoped visibility (pass the caller
        // as viewer), else a scoped rep could export every org record via CSV.
        const rows = await listCompanies(ctx.tenantId, ctx.orgId, undefined, ctx.user.userId);
        const columns = ['companyId', 'name', 'domain', 'industry', 'tags', 'createdBy', 'createdAt', 'updatedAt', ...customFieldColumns(rows)];
        csv = toCsv(columns, rows);
      } else if (entityType === 'deals') {
        const rows = await listDeals(ctx.tenantId, ctx.orgId, {}, ctx.user.userId);
        const columns = [
          'dealId', 'title', 'pipelineId', 'stageId', 'amount', 'currency', 'companyId', 'contactId', 'owner', 'closeDate', 'status', 'createdBy', 'createdAt', 'updatedAt',
          ...customFieldColumns(rows),
        ];
        csv = toCsv(columns, rows);
      } else if (entityType === 'tasks') {
        const rows = await listTasks(ctx.tenantId, ctx.orgId);
        const columns = ['taskId', 'title', 'status', 'dueDate', 'assignee', 'dealId', 'contactId', 'companyId', 'createdBy', 'createdAt', 'updatedAt'];
        csv = toCsv(columns, rows);
      } else if (entityType === 'activities') {
        const rows = await listActivities(ctx.tenantId, ctx.orgId);
        const columns = ['activityId', 'kind', 'body', 'dealId', 'contactId', 'companyId', 'createdBy', 'createdAt'];
        csv = toCsv(columns, rows);
      } else {
        throw new OpenwopError('validation_error', 'entityType must be one of: companies, deals, tasks, activities.', 400, { field: 'entityType' });
      }
      const exportEntity = ({ companies: 'company', deals: 'deal', tasks: 'task', activities: 'activity' } as const)[entityType as 'companies' | 'deals' | 'tasks' | 'activities'];
      crmMutated({ entity: exportEntity, verb: 'exported', tenantId: ctx.tenantId, orgId: ctx.orgId, actor: ctx.user.userId, entityId: entityType });
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="crm-${entityType}-${date}.csv"`);
      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  });

  // ── Tasks (Phase 2) ──
  app.get(`${BASE}/tasks`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      res.json({
        tasks: await listTasks(ctx.tenantId, ctx.orgId, {
          ...(optionalString(req.query.status) ? { status: String(req.query.status) } : {}),
          ...(optionalString(req.query.dealId) ? { dealId: String(req.query.dealId) } : {}),
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/tasks`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      await assertLinkedVisible(ctx.tenantId, ctx.orgId, ctx.user.userId, {
        ...(optionalString(body.dealId) ? { dealId: String(body.dealId) } : {}),
        ...(optionalString(body.companyId) ? { companyId: String(body.companyId) } : {}),
      });
      const task = await createTask({
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        title: requireString(body.title, 'title'),
        ...(typeof body.status === 'string' ? { status: body.status as TaskStatus } : {}),
        dueDate: body.dueDate,
        assignee: body.assignee,
        ...(optionalString(body.dealId) ? { dealId: String(body.dealId) } : {}),
        ...(optionalString(body.contactId) ? { contactId: String(body.contactId) } : {}),
        ...(optionalString(body.companyId) ? { companyId: String(body.companyId) } : {}),
        createdBy: ctx.user.userId,
        validators: linkValidators(ctx),
      });
      res.status(201).json(task);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/tasks/:taskId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const t = await getTask(ctx.tenantId, ctx.orgId, req.params.taskId);
      if (!t) throw new OpenwopError('not_found', 'Task not found.', 404, { taskId: req.params.taskId });
      res.json(t);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/tasks/:taskId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateTask>[3] = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.status === 'string') patch.status = body.status as TaskStatus;
      if ('dueDate' in body) patch.dueDate = body.dueDate === null ? null : optionalString(body.dueDate) ?? null;
      if ('assignee' in body) patch.assignee = body.assignee === null ? null : optionalString(body.assignee) ?? null;
      const updated = await updateTask(ctx.tenantId, ctx.orgId, req.params.taskId, patch, { actor: ctx.user.userId }); // `completed` iff the status flipped — inside the service
      if (!updated) throw new OpenwopError('not_found', 'Task not found.', 404, { taskId: req.params.taskId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/tasks/:taskId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deleteTask(ctx.tenantId, ctx.orgId, req.params.taskId, { actor: ctx.user.userId });
      if (!ok) throw new OpenwopError('not_found', 'Task not found.', 404, { taskId: req.params.taskId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Activities (Phase 2) — append-only timeline ──
  app.get(`${BASE}/activities`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      res.json({
        activities: await listActivities(ctx.tenantId, ctx.orgId, {
          ...(optionalString(req.query.dealId) ? { dealId: String(req.query.dealId) } : {}),
          ...(optionalString(req.query.contactId) ? { contactId: String(req.query.contactId) } : {}),
          ...(optionalString(req.query.companyId) ? { companyId: String(req.query.companyId) } : {}),
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/activities`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      await assertLinkedVisible(ctx.tenantId, ctx.orgId, ctx.user.userId, {
        ...(optionalString(body.dealId) ? { dealId: String(body.dealId) } : {}),
        ...(optionalString(body.companyId) ? { companyId: String(body.companyId) } : {}),
      });
      const activity = await createActivity({
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        kind: requireString(body.kind, 'kind') as ActivityKind,
        body: requireString(body.body, 'body'),
        ...(optionalString(body.dealId) ? { dealId: String(body.dealId) } : {}),
        ...(optionalString(body.contactId) ? { contactId: String(body.contactId) } : {}),
        ...(optionalString(body.companyId) ? { companyId: String(body.companyId) } : {}),
        createdBy: ctx.user.userId,
        validators: linkValidators(ctx),
      });
      res.status(201).json(activity);
    } catch (err) {
      next(err);
    }
  });

  // ── Custom field definitions (Phase 3) ──
  app.get(`${BASE}/fields`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const entityType = optionalString(req.query.entityType) as CustomEntity | undefined;
      res.json({ fields: await listFieldDefs(ctx.tenantId, ctx.orgId, entityType) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/fields`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const entityType = requireString(body.entityType, 'entityType') as CustomEntity;
      if (!ORG_CUSTOM_ENTITIES.includes(entityType)) {
        throw new OpenwopError('validation_error', `entityType must be one of: ${ORG_CUSTOM_ENTITIES.join(', ')}`, 400, { field: 'entityType' });
      }
      const def = await createFieldDef({
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        entityType,
        key: requireString(body.key, 'key'),
        label: requireString(body.label, 'label'),
        type: requireString(body.type, 'type') as FieldType,
        required: body.required === true,
        options: body.options,
        refEntityType: body.refEntityType,
        actor: ctx.user.userId,
      });
      res.status(201).json(def);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/fields/:defId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deleteFieldDef(ctx.tenantId, ctx.orgId, req.params.defId, { actor: ctx.user.userId });
      if (!ok) throw new OpenwopError('not_found', 'Field not found.', 404, { defId: req.params.defId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── CSV/JSON import (Phase 3) ──
  // Body: { entityType: 'company'|'contact', rows: object[], mapping?: {srcCol→field}, dedupeBy?: field }.
  // CSV is parsed to `rows` client-side. Companies land in this org; contacts in
  // the tenant rolodex. Returns a per-row summary (created / skipped / errors).
  app.post(`${BASE}/import`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { entityType?: unknown; rows?: unknown; mapping?: unknown; dedupeBy?: unknown };
      const entityType = requireString(body.entityType, 'entityType');
      if (entityType !== 'company' && entityType !== 'contact') {
        throw new OpenwopError('validation_error', 'entityType must be `company` or `contact`.', 400, { field: 'entityType' });
      }
      if (!Array.isArray(body.rows)) throw new OpenwopError('validation_error', '`rows` must be an array of objects.', 400, { field: 'rows' });
      if (body.rows.length > 1000) throw new OpenwopError('validation_error', 'Import is limited to 1000 rows.', 413, { max: 1000 });
      const mapping = (typeof body.mapping === 'object' && body.mapping !== null ? body.mapping : {}) as Record<string, string>;
      const dedupeBy = optionalString(body.dedupeBy);
      const mapRow = (row: Record<string, unknown>): Record<string, unknown> => {
        if (Object.keys(mapping).length === 0) return row;
        const out: Record<string, unknown> = {};
        for (const [src, dst] of Object.entries(mapping)) out[dst] = row[src];
        return out;
      };

      const seen = new Set<string>();
      if (dedupeBy) {
        const existing = entityType === 'company'
          ? (await listCompanies(ctx.tenantId, ctx.orgId)).map((cmp) => fieldOf(cmp, dedupeBy))
          : (await listContacts(ctx.tenantId)).map((ct) => fieldOf(ct, dedupeBy));
        for (const v of existing) if (typeof v === 'string' && v) seen.add(v.toLowerCase());
      }

      // CRMGAP-6: hoist the per-row O(n) work OUT of the loop — field defs and
      // the entity-cap count are each read ONCE before the loop, not once per
      // row (a 1000-row import previously paid a full field-def AND a full
      // company-count re-scan per row: O(rows × existing-rows)).
      const companyFieldDefs = entityType === 'company' ? await listFieldDefs(ctx.tenantId, ctx.orgId, 'company') : undefined;
      const contactFieldDefs = entityType === 'contact' ? await listContactFieldDefs(ctx.tenantId) : undefined;
      let companyCount = entityType === 'company' ? (await listCompanies(ctx.tenantId, ctx.orgId)).length : 0;

      let created = 0;
      let skipped = 0;
      const errors: Array<{ index: number; message: string }> = [];
      for (let i = 0; i < body.rows.length; i++) {
        const raw = body.rows[i];
        if (typeof raw !== 'object' || raw === null) { errors.push({ index: i, message: 'row is not an object' }); continue; }
        const row = mapRow(raw as Record<string, unknown>);
        try {
          if (dedupeBy) {
            const key = typeof row[dedupeBy] === 'string' ? String(row[dedupeBy]).toLowerCase() : '';
            if (key && seen.has(key)) { skipped++; continue; }
            if (key) seen.add(key);
          }
          if (entityType === 'company') {
            if (typeof row.name !== 'string' || !row.name.trim()) { errors.push({ index: i, message: 'name is required' }); continue; }
            // The running count (seeded once above) stands in for the per-call
            // full-collection cap check `createCompany` normally does itself
            // (`skipCapCheck` below) — same threshold/message, checked O(1).
            assertUnderCap(companyCount, MAX_PER_ORG_ENTITIES, 'companies');
            // Honor the org's custom-field defs on import too (code-review #2) —
            // a row missing a required field becomes a per-row error, not a
            // silent bypass of the validation the direct create enforces.
            const customFields = await resolveCustomFields(ctx, 'company', row.customFields, true, companyFieldDefs);
            // ADR 0627 D2 — per-row SILENT; the ONE `imported` event below carries `count`.
            await createCompany({
              tenantId: ctx.tenantId, orgId: ctx.orgId, name: row.name, domain: row.domain, industry: row.industry, tags: row.tags,
              ...(customFields ? { customFields } : {}), createdBy: ctx.user.userId, skipCapCheck: true, silent: true,
            });
            companyCount++;
          } else {
            if (typeof row.name !== 'string' || !row.name.trim()) { errors.push({ index: i, message: 'name is required' }); continue; }
            // Contact defs are tenant-scoped (ADR 0213 §2) — honor them on import
            // the same way the direct create/routes path does (code-review #2 precedent).
            const customFields = await resolveContactCustomFields(ctx.tenantId, row.customFields, true, contactFieldDefs);
            // ADR 0627 D2 — per-row SILENT (a 1000-row import must not start 1000
            // `route-new-lead` runs); the ONE `contact.imported` below carries `count`.
            await createContact({ tenantId: ctx.tenantId, name: row.name, ...(typeof row.email === 'string' ? { email: row.email } : {}), ...(typeof row.company === 'string' ? { company: row.company } : {}), ...(customFields ? { customFields } : {}), silent: true });
          }
          created++;
        } catch (e) {
          errors.push({ index: i, message: e instanceof Error ? e.message : 'failed' });
        }
      }
      // ONE event for the whole batch (not per-row) — the ADR 0627 D2 batch lane:
      // the per-row creates above are silent, and `count` says how many rows this
      // single event stands for (entityId keeps the legacy `import:<n>` shape).
      crmMutated({
        entity: entityType,
        verb: 'imported',
        tenantId: ctx.tenantId,
        actor: ctx.user.userId,
        entityId: `import:${created}`,
        count: created,
        ...(entityType === 'company' ? { orgId: ctx.orgId } : {}),
      });
      res.json({ entityType, created, skipped, errors });
    } catch (err) {
      next(err);
    }
  });
}

/** A custom-fields map of scalar values (validated against defs in Phase 3). */
function isFieldMap(v: unknown): v is Record<string, string | number | boolean> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => ['string', 'number', 'boolean'].includes(typeof x));
}

/** A typed top-level field accessor for the import dedupe path (CRMGAP-6) — a
 *  caller-supplied `dedupeBy` field name can't be narrowed to `keyof T`
 *  statically, so this walks `row`'s own entries instead of an `as unknown as
 *  Record<string, unknown>` cast. */
function fieldOf(row: object, key: string): unknown {
  return Object.entries(row).find(([k]) => k === key)?.[1];
}
