/**
 * CRM org-scoped routes (ADR 0008) — the formal Orgs + RBAC surface added
 * AROUND the preserved tenant-scoped contacts. Companies / Deals / Pipelines
 * (Phase 1); Tasks / Activities (Phase 2); custom fields + import (Phase 3).
 *
 * Surface under /v1/host/sample/crm/orgs/:orgId. Every route is gated by the
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
import type { User } from '../users/usersService.js';
import type { Scope } from '../../host/accessControlService.js';
import { createContact, getContact, listContacts } from './contactsService.js';
import {
  createFieldDef,
  deleteFieldDef,
  listFieldDefs,
  validateCustomFields,
  CUSTOM_ENTITIES,
  type CustomEntity,
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

const TOGGLE_ID = 'crm';

interface Ctx {
  user: User;
  orgId: string;
}

/** Toggle + org-scoped RBAC gate (the shared `authorizeOrgScope`). */
const authorize = (req: Request, scope: Scope): Promise<Ctx> => authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: 'CRM' }, scope);

/** Link validators bound to a tenant/org — a deal/company is org-scoped, a
 *  contact is the tenant-wide rolodex (contacts stay tenant-scoped, ADR 0008). */
function linkValidators(ctx: Ctx): LinkValidators {
  return {
    validateDeal: async (id) => (await getDeal(ctx.user.tenantId, ctx.orgId, id)) !== null,
    validateCompany: async (id) => (await getCompany(ctx.user.tenantId, ctx.orgId, id)) !== null,
    validateContact: async (id) => {
      const c = await getContact(id);
      return c !== null && c.tenantId === ctx.user.tenantId;
    },
  };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Validate a customFields map against the org's field defs (Phase 3). On create
 *  (`requireAll`) every required field must be present; on patch, absent ⇒ leave. */
async function resolveCustomFields(ctx: Ctx, entityType: CustomEntity, raw: unknown, requireAll: boolean): Promise<Record<string, string | number | boolean> | undefined> {
  if (raw === undefined && !requireAll) return undefined;
  const provided = isFieldMap(raw) ? raw : {};
  return validateCustomFields(ctx.user.tenantId, ctx.orgId, entityType, provided, { requireAll });
}

export function registerCrmOrgRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/sample/crm/orgs/:orgId';

  // ── Pipelines ──
  app.get(`${BASE}/pipelines`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      await getOrCreateDefaultPipeline(ctx.user.tenantId, ctx.orgId); // ensure one exists
      res.json({ pipelines: await listPipelines(ctx.user.tenantId, ctx.orgId) });
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
      res.status(201).json(await createPipeline(ctx.user.tenantId, ctx.orgId, name, stages));
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
      const updated = await updatePipeline(ctx.user.tenantId, ctx.orgId, req.params.pipelineId, patch);
      if (!updated) throw new OpenwopError('not_found', 'Pipeline not found.', 404, { pipelineId: req.params.pipelineId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/pipelines/:pipelineId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deletePipeline(ctx.user.tenantId, ctx.orgId, req.params.pipelineId);
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
      res.json({ companies: await listCompanies(ctx.user.tenantId, ctx.orgId, optionalString(req.query.q)) });
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
        tenantId: ctx.user.tenantId,
        orgId: ctx.orgId,
        name: requireString(body.name, 'name'),
        domain: body.domain,
        industry: body.industry,
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
      const c = await getCompany(ctx.user.tenantId, ctx.orgId, req.params.companyId);
      if (!c) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: req.params.companyId });
      res.json(c);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/companies/:companyId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateCompany>[3] = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if ('domain' in body) patch.domain = body.domain === null ? null : optionalString(body.domain) ?? null;
      if ('industry' in body) patch.industry = body.industry === null ? null : optionalString(body.industry) ?? null;
      if (body.tags !== undefined) patch.tags = body.tags;
      const cf = await resolveCustomFields(ctx, 'company', 'customFields' in body ? body.customFields : undefined, false);
      if (cf !== undefined) patch.customFields = cf;
      const updated = await updateCompany(ctx.user.tenantId, ctx.orgId, req.params.companyId, patch);
      if (!updated) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: req.params.companyId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/companies/:companyId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deleteCompany(ctx.user.tenantId, ctx.orgId, req.params.companyId);
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
      const deals = await listDeals(ctx.user.tenantId, ctx.orgId, {
        ...(optionalString(req.query.pipelineId) ? { pipelineId: String(req.query.pipelineId) } : {}),
        ...(optionalString(req.query.stageId) ? { stageId: String(req.query.stageId) } : {}),
        ...(optionalString(req.query.companyId) ? { companyId: String(req.query.companyId) } : {}),
        ...(optionalString(req.query.q) ? { q: String(req.query.q) } : {}),
      });
      res.json({ deals });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/deals`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const customFields = await resolveCustomFields(ctx, 'deal', body.customFields, true);
      const deal = await createDeal({
        tenantId: ctx.user.tenantId,
        orgId: ctx.orgId,
        title: requireString(body.title, 'title'),
        ...(optionalString(body.pipelineId) ? { pipelineId: String(body.pipelineId) } : {}),
        ...(optionalString(body.stageId) ? { stageId: String(body.stageId) } : {}),
        ...(num(body.amount) !== undefined ? { amount: num(body.amount) } : {}),
        currency: body.currency,
        ...(optionalString(body.companyId) ? { companyId: String(body.companyId) } : {}),
        ...(optionalString(body.contactId) ? { contactId: String(body.contactId) } : {}),
        ...(customFields ? { customFields } : {}),
        createdBy: ctx.user.userId,
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
      const d = await getDeal(ctx.user.tenantId, ctx.orgId, req.params.dealId);
      if (!d) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      res.json(d);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/deals/:dealId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateDeal>[3] = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (optionalString(body.pipelineId)) patch.pipelineId = String(body.pipelineId);
      if (optionalString(body.stageId)) patch.stageId = String(body.stageId);
      if ('amount' in body) patch.amount = body.amount === null ? null : num(body.amount) ?? null;
      if ('currency' in body) patch.currency = body.currency === null ? null : optionalString(body.currency) ?? null;
      if ('companyId' in body) patch.companyId = body.companyId === null ? null : optionalString(body.companyId) ?? null;
      if ('contactId' in body) patch.contactId = body.contactId === null ? null : optionalString(body.contactId) ?? null;
      const cf = await resolveCustomFields(ctx, 'deal', 'customFields' in body ? body.customFields : undefined, false);
      if (cf !== undefined) patch.customFields = cf;
      const updated = await updateDeal(ctx.user.tenantId, ctx.orgId, req.params.dealId, patch, linkValidators(ctx));
      if (!updated) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/deals/:dealId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deleteDeal(ctx.user.tenantId, ctx.orgId, req.params.dealId);
      if (!ok) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: req.params.dealId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Tasks (Phase 2) ──
  app.get(`${BASE}/tasks`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      res.json({
        tasks: await listTasks(ctx.user.tenantId, ctx.orgId, {
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
      const task = await createTask({
        tenantId: ctx.user.tenantId,
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
      const t = await getTask(ctx.user.tenantId, ctx.orgId, req.params.taskId);
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
      const updated = await updateTask(ctx.user.tenantId, ctx.orgId, req.params.taskId, patch);
      if (!updated) throw new OpenwopError('not_found', 'Task not found.', 404, { taskId: req.params.taskId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/tasks/:taskId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deleteTask(ctx.user.tenantId, ctx.orgId, req.params.taskId);
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
        activities: await listActivities(ctx.user.tenantId, ctx.orgId, {
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
      const activity = await createActivity({
        tenantId: ctx.user.tenantId,
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
      res.json({ fields: await listFieldDefs(ctx.user.tenantId, ctx.orgId, entityType) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/fields`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const entityType = requireString(body.entityType, 'entityType') as CustomEntity;
      if (!CUSTOM_ENTITIES.includes(entityType)) {
        throw new OpenwopError('validation_error', `entityType must be one of: ${CUSTOM_ENTITIES.join(', ')}`, 400, { field: 'entityType' });
      }
      const def = await createFieldDef({
        tenantId: ctx.user.tenantId,
        orgId: ctx.orgId,
        entityType,
        key: requireString(body.key, 'key'),
        label: requireString(body.label, 'label'),
        type: requireString(body.type, 'type') as FieldType,
        required: body.required === true,
      });
      res.status(201).json(def);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/fields/:defId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deleteFieldDef(ctx.user.tenantId, ctx.orgId, req.params.defId);
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
          ? (await listCompanies(ctx.user.tenantId, ctx.orgId)).map((cmp) => (cmp as unknown as Record<string, unknown>)[dedupeBy])
          : (await listContacts(ctx.user.tenantId)).map((ct) => (ct as unknown as Record<string, unknown>)[dedupeBy]);
        for (const v of existing) if (typeof v === 'string' && v) seen.add(v.toLowerCase());
      }

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
            // Honor the org's custom-field defs on import too (code-review #2) —
            // a row missing a required field becomes a per-row error, not a
            // silent bypass of the validation the direct create enforces.
            const customFields = await resolveCustomFields(ctx, 'company', row.customFields, true);
            await createCompany({ tenantId: ctx.user.tenantId, orgId: ctx.orgId, name: row.name, domain: row.domain, industry: row.industry, tags: row.tags, ...(customFields ? { customFields } : {}), createdBy: ctx.user.userId });
          } else {
            if (typeof row.name !== 'string' || !row.name.trim()) { errors.push({ index: i, message: 'name is required' }); continue; }
            await createContact({ tenantId: ctx.user.tenantId, name: row.name, ...(typeof row.email === 'string' ? { email: row.email } : {}), ...(typeof row.company === 'string' ? { company: row.company } : {}) });
          }
          created++;
        } catch (e) {
          errors.push({ index: i, message: e instanceof Error ? e.message : 'failed' });
        }
      }
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
