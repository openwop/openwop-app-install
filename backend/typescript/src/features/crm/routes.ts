/**
 * CRM feature routes (host-extension, best-effort — ADR 0001 §4).
 *
 * Surface under /v1/host/openwop-app/crm:
 *   GET    /contacts            list the caller's contacts
 *   POST   /contacts            create a contact
 *   GET    /contacts/:id        one contact
 *   PATCH  /contacts/:id        update
 *   DELETE /contacts/:id        remove
 *   POST   /contacts/:id/triage start a triage run for the contact
 *
 * TOGGLE-GATED (backend authority — ADR §3.4): every route resolves the
 * caller's `crm` assignment server-side; when the feature is off (or beta and
 * the caller isn't in the cohort) the surface 404s, so a disabled feature is
 * indistinguishable from a non-existent one. The client cannot bypass this.
 *
 * REPLAY-SAFE VARIANT STAMP (ADR §3.4/§3.5 — corrected from the annotation
 * surface): triage stamps the resolved variant + bindings into
 * `run.metadata.featureVariant` at creation. run.metadata is copied by
 * `POST /v1/runs/{runId}:fork` (the fork spreads the source run), so the stamp
 * is read VERBATIM on replay/fork — never recomputed. (Annotations live in a
 * side table that fork does NOT copy, so they would be the wrong home.)
 */

import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { insertRunWithStartContext } from '../../host/runInsert.js';
import { resolveLaunchWorkflow } from '../../host/resolveLaunchDefinition.js';
import { OpenwopError } from '../../types.js';
import type { RunRecord } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { executeRun } from '../../executor/executor.js';
import { getEventLog } from '../../executor/eventLog.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { ResolvedAssignment, ToggleSubject } from '../../host/featureToggles/types.js';
import { authorizeOrgScope, requireString, requireTenantScope } from '../featureRoute.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import { computeLeadScore } from './leadScoreService.js';
import { crmMutated } from './emit.js';
import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  parseStage,
  setContactTriage,
  updateContact,
  addContactIdentifier,
  removeContactIdentifier,
} from './contactsService.js';
import { findDuplicateContacts, mergeContacts, unmergeContacts } from './crmMergeService.js';
import { matchCandidates } from './matchCandidatesService.js';
import { listMergeEvents } from './crmMergeEventsService.js';
import { createContactMergeApproval } from '../../host/approvalService.js';
import { convertContact } from './convertService.js';
import { toCsv, customFieldColumns } from './csvExport.js';
import {
  createContactFieldDef,
  deleteContactFieldDef,
  listContactFieldDefs,
  resolveContactCustomFields,
  type FieldType,
} from './crmEntitiesService.js';
import {
  listSegments,
  getSegment,
  createSegment,
  updateSegment,
  deleteSegment,
  resolveSegmentMembers,
  segmentEstimate,
  segmentInsights,
  segmentOverlap,
} from './segmentsService.js';
import { listSuppressions, addSuppression, removeSuppression, suppressionSummary, type SuppressionReason } from './suppressionService.js';

const log = createLogger('features.crm');

/** The CRM toggle id — matches the feature id + the `feature.crm.*` packs. */
const TOGGLE_ID = 'crm';

function subjectOf(req: Request): ToggleSubject {
  const subject: ToggleSubject = { tenantId: req.tenantId ?? 'default' };
  if (req.principal?.principalId) subject.userId = req.principal.principalId;
  return subject;
}

/** Resolve the caller's CRM assignment; 404 when the feature isn't enabled for
 *  them (backend authority — a disabled feature has no surface). */
async function requireEnabled(req: Request): Promise<ResolvedAssignment> {
  const assignment = await resolveOne(TOGGLE_ID, subjectOf(req));
  if (!assignment || !assignment.enabled) {
    throw new OpenwopError('not_found', 'CRM is not enabled for this tenant.', 404, { feature: TOGGLE_ID });
  }
  // ADR 0419 — CRM is a sellable-bundle feature; gate on the plan/bundle entitlement
  // at this shared choke (every tenant-scoped CRM route funnels through it). No-op
  // until an operator narrows PLAN_FEATURES with billing on. PUBLIC booking/sign
  // routes never reach here (they don't call requireEnabled — the ADR 0176 shopper
  // exemption). See convert below for the one handler that bypasses this.
  // ADR 0627 D3 (CRM-6): this is the READ gate only — every tenant-lane MUTATOR
  // additionally calls `requireTenantScope(req, 'workspace:write')` (the default
  // membership role is `viewer`, whose scopes are read-only).
  await checkEntitlement(req, TOGGLE_ID);
  return assignment;
}

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

/** The caller's principal id — mirrors `routes/hostEvents.ts`'s `principalOf`. */
const principalOf = (req: Request): string => req.principal?.principalId ?? 'anonymous';

/**
 * CFP-1 — the req-less org-scope predicate shared by the sales-ops chat tools
 * (agentTools.ts) and the org-scoped routes. Mirrors the RBAC core of
 * `requireOrgScope` (featureRoute.ts): a subject holds `scope` in `orgId` iff
 * `resolveEffectiveAccess` (the SAME primitive the routes resolve through)
 * grants it. Fail-closed — an absent subject or a cross-tenant/foreign org
 * resolves to zero scopes (no membership under this tenant) ⇒ `false`. So the
 * agent tool and the HTTP route can never drift on who may read/write an org
 * (the campaign-intel `orgScopeGranted` precedent).
 */
export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

// requireString/parseStage: CRMGAP-11 — shared with orgRoutes.ts/surface.ts,
// imported above (`../featureRoute.js` / `./contactsService.js`) rather than
// duplicated here.

function patchString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new OpenwopError('validation_error', `Field \`${field}\` MUST be a string, null, or omitted.`, 400, { field });
  }
  return value;
}

export function registerCrmRoutes(deps: RouteDeps): void {
  const { app, storage, hostSuite } = deps;

  // ── Suppression list (ADR 0217 / C3) — the tenant-wide do-not-contact
  //    overlay every marketing egress subtracts. Tenant-level like contacts. ──
  app.get('/v1/host/openwop-app/crm/suppressions', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ suppressions: await listSuppressions(tenantOf(req)) });
    } catch (err) { next(err); }
  });
  // ADR 0251 — suppression-cause analytics (a projection over the SAME rows, no
  //   parallel read model; counts + timestamps only, no addresses).
  app.get('/v1/host/openwop-app/crm/suppressions/summary', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ summary: await suppressionSummary(tenantOf(req)) });
    } catch (err) { next(err); }
  });
  app.post('/v1/host/openwop-app/crm/suppressions', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = requireString(body.email, 'email');
      const reason = (typeof body.reason === 'string' ? body.reason : 'manual') as SuppressionReason;
      const actor = req.userId ?? req.principal?.principalId ?? 'unknown';
      const entry = await addSuppression(tenantOf(req), email, reason, actor, typeof body.note === 'string' ? body.note : undefined);
      res.status(201).json({ suppression: entry });
    } catch (err) { next(err); }
  });
  app.delete('/v1/host/openwop-app/crm/suppressions/:email', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      // ADR 0655 D10 (EM-UX-23) — an OPERATOR may lift a bounce/complaint/unsubscribe
      // row with an explicit `?force=true` (the service refuses otherwise): the D3
      // preference page now REFUSES a suppressed recipient's re-grant and tells them
      // to ask the sender, so the sender needs a door. Attested + logged.
      const force = req.query.force === 'true';
      const removed = await removeSuppression(tenantOf(req), req.params.email, { force });
      if (removed && force) log.info('suppression released by operator (forced)', { tenantId: tenantOf(req), actor: req.userId ?? req.principal?.principalId ?? 'unknown' });
      res.json({ removed });
    } catch (err) { next(err); }
  });

  app.get('/v1/host/openwop-app/crm/contacts', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ contacts: await listContacts(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0297 D3 — explainable lead score, computed on read (no stored score).
  app.get('/v1/host/openwop-app/crm/contacts/:contactId/score', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const tenantId = tenantOf(req);
      const contact = await getContact(req.params.contactId);
      if (!contact || contact.tenantId !== tenantId) throw new OpenwopError('not_found', 'Contact not found.', 404, {});
      const orgId = typeof req.query.orgId === 'string' && req.query.orgId ? req.query.orgId : undefined;
      res.json(await computeLeadScore(tenantId, contact.contactId, orgId));
    } catch (err) { next(err); }
  });

  app.post('/v1/host/openwop-app/crm/contacts', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const body = (req.body ?? {}) as { name?: unknown; email?: unknown; company?: unknown; stage?: unknown; owner?: unknown; customFields?: unknown; title?: unknown; address?: unknown; leadSource?: unknown; phone?: unknown };
      const customFields = await resolveContactCustomFields(tenantOf(req), body.customFields, true);
      const contact = await createContact({
        tenantId: tenantOf(req),
        name: requireString(body.name, 'name'),
        stage: parseStage(body.stage),
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(typeof body.company === 'string' ? { company: body.company } : {}),
        ...(typeof body.owner === 'string' && body.owner ? { owner: body.owner } : {}),
        // CRM-2 — the service validates fail-closed + upserts phone as an identifier.
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.leadSource !== undefined ? { leadSource: body.leadSource } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(customFields ? { customFields } : {}),
        actor: principalOf(req), // ADR 0627 D2 — `contact.created` fires inside the service
      });
      res.status(201).json(contact);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/openwop-app/crm/contacts/:id', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const contact = await getContact(req.params.id);
      if (!contact || contact.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: req.params.id });
      }
      res.json(contact);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/openwop-app/crm/contacts/:id', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const existing = await getContact(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: req.params.id });
      }
      const body = (req.body ?? {}) as { name?: unknown; email?: unknown; company?: unknown; stage?: unknown; owner?: unknown; customFields?: unknown; title?: unknown; address?: unknown; leadSource?: unknown; phone?: unknown };
      const customFields = await resolveContactCustomFields(tenantOf(req), 'customFields' in body ? body.customFields : undefined, false);
      const updated = await updateContact(req.params.id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        email: patchString(body.email, 'email'),
        company: patchString(body.company, 'company'),
        stage: parseStage(body.stage),
        owner: patchString(body.owner, 'owner'),
        // CRM-2 — pass through when the key is present (the service validates + null-clears).
        ...('title' in body ? { title: body.title } : {}),
        ...('address' in body ? { address: body.address } : {}),
        ...('leadSource' in body ? { leadSource: body.leadSource } : {}),
        ...('phone' in body ? { phone: body.phone } : {}),
        ...(customFields !== undefined ? { customFields } : {}),
      }, { actor: principalOf(req) }); // ADR 0627 D2 — `contact.updated` (+ `changed`) fires inside the service
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/crm/contacts/:id', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const existing = await getContact(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: req.params.id });
      }
      await deleteContact(req.params.id, { actor: principalOf(req) });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Contact identifiers (ADR 0263 / CDP-A) — non-email external ids the customer
  // resolves by. crm owns the contact mutation; the `cdp` package only READS the
  // resulting index. Tenant-guarded via the service (returns null → 404).
  app.post('/v1/host/openwop-app/crm/contacts/:id/identifiers', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const body = (req.body ?? {}) as { type?: unknown; value?: unknown; source?: unknown };
      const updated = await addContactIdentifier(req.params.id, tenantOf(req), {
        type: requireString(body.type, 'type'),
        value: requireString(body.value, 'value'),
        ...(typeof body.source === 'string' && body.source ? { source: body.source } : {}),
      }, { actor: principalOf(req) });
      if (!updated) throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: req.params.id });
      res.status(201).json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/crm/contacts/:id/identifiers', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const type = requireString(req.query.type, 'type');
      const value = requireString(req.query.value, 'value');
      const updated = await removeContactIdentifier(req.params.id, tenantOf(req), type, value, { actor: principalOf(req) });
      if (!updated) throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: req.params.id });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // Duplicate review (ADR 0209 §1) — exact-key groups only; read scope (requireEnabled).
  app.get('/v1/host/openwop-app/crm/duplicates', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
      if (entityType !== 'contact') {
        throw new OpenwopError('validation_error', 'entityType must be `contact`.', 400, { field: 'entityType' });
      }
      res.json(await findDuplicateContacts(tenantOf(req)));
    } catch (err) {
      next(err);
    }
  });

  // Probabilistic match candidates (ADR 0264 / CDP-B) — read-only steward review
  // surface. PROPOSES only (scored likely-dupes beyond exact email); never merges.
  app.get('/v1/host/openwop-app/crm/match-candidates', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json(await matchCandidates(tenantOf(req)));
    } catch (err) {
      next(err);
    }
  });

  // Merge-event audit (ADR 0264 / CDP-B) — what each contact merge did.
  app.get('/v1/host/openwop-app/crm/merge-events', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ events: await listMergeEvents(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  // Propose a merge for steward review (ADR 0264 / CDP-B) — queues a contact-merge
  // approval instead of merging directly; a steward decides via the ApprovalsInbox.
  app.post('/v1/host/openwop-app/crm/contacts/:id/merge-proposal', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const sourceContactId = requireString((req.body as { sourceContactId?: unknown })?.sourceContactId, 'sourceContactId');
      const survivorId = req.params.id;
      const survivor = await getContact(survivorId);
      const source = await getContact(sourceContactId);
      if (!survivor || survivor.tenantId !== tenantOf(req) || !source || source.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Contact not found.', 404, {});
      }
      const approval = await createContactMergeApproval({
        tenantId: tenantOf(req), survivorContactId: survivorId, sourceContactId,
        proposal: `Merge ${source.name} → ${survivor.name}`,
      });
      res.status(201).json(approval);
    } catch (err) {
      next(err);
    }
  });

  // Reverse a merge (ADR 0264 / CDP-B) — restore the source contact + its refs.
  app.post('/v1/host/openwop-app/crm/merge-events/:id/unmerge', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const result = await unmergeContacts(tenantOf(req), req.params.id, { actor: principalOf(req) });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/crm/contacts/:id/merge', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const body = (req.body ?? {}) as { sourceContactId?: unknown };
      const sourceContactId = requireString(body.sourceContactId, 'sourceContactId');
      const merged = await mergeContacts(tenantOf(req), req.params.id, sourceContactId, principalOf(req)); // ADR 0627 D2 — `contact.merged` fires inside the service
      res.json(merged);
    } catch (err) {
      next(err);
    }
  });

  // Lead conversion (ADR 0209 §3) — org write scope, gated the SAME way
  // orgRoutes gates its :orgId routes (`authorizeOrgScope`); the target org is
  // body-supplied here (this surface has no :orgId path segment), so it's
  // staged into `req.params.orgId` before reusing the shared gate — one
  // definition of the cross-tenant/RBAC guard, never a second copy.
  app.post('/v1/host/openwop-app/crm/contacts/:id/convert', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { orgId?: unknown; companyName?: unknown; pipelineId?: unknown; dealTitle?: unknown };
      const orgId = requireString(body.orgId, 'orgId');
      (req.params as Record<string, string>).orgId = orgId;
      const ctx = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: 'CRM' }, 'workspace:write');
      await checkEntitlement(req, TOGGLE_ID); // ADR 0419 — bypasses requireEnabled (inline authz)
      const result = await convertContact({
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        contactId: req.params.id,
        actor: ctx.user.userId,
        ...(typeof body.companyName === 'string' && body.companyName ? { companyName: body.companyName } : {}),
        ...(typeof body.pipelineId === 'string' && body.pipelineId ? { pipelineId: body.pipelineId } : {}),
        ...(typeof body.dealTitle === 'string' && body.dealTitle ? { dealTitle: body.dealTitle } : {}),
      }); // ADR 0627 D2 — `converted` + the minted company/deal `created` fire inside convertService
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // CSV export (ADR 0210 §5) — tenant-scoped contacts rolodex.
  app.get('/v1/host/openwop-app/crm/export', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
      if (entityType !== 'contacts') {
        throw new OpenwopError('validation_error', 'entityType must be `contacts`.', 400, { field: 'entityType' });
      }
      const rows = await listContacts(tenantOf(req));
      const columns = ['contactId', 'name', 'email', 'company', 'stage', 'owner', 'createdAt', 'updatedAt', ...customFieldColumns(rows)];
      const csv = toCsv(columns, rows);
      crmMutated({ entity: 'contact', verb: 'exported', tenantId: tenantOf(req), actor: principalOf(req), entityId: 'contacts' });
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="crm-contacts-${date}.csv"`);
      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  });

  // Read a triage run's provenance stamp (variant + bindings + crm block).
  // DELIBERATELY NOT toggle-gated (ADR 0001 §3.4/§3.5): a historical run's
  // provenance is readable regardless of the feature's CURRENT state — this is
  // exactly the decoupling that keeps replay/fork honest, and
  // `test/feature-replay-fork.test.ts` is its witness (toggle OFF ⇒ the stamp
  // still reads; a fork still resolves the recorded variant). ADR 0627 D3's
  // first cut swapped this for `requireEnabled` and turned that witness red;
  // the D3 sentence is RETRACTED in the ADR's correction note. Entitlement
  // (ADR 0419) still applies — a plan that never bought CRM has no stamps to
  // read. Tenant-scoped + CRM-stamped; a viewer holds `runs:read`, so no write
  // scope. The stamp lives in host-internal run.metadata, NOT on the normative
  // RunSnapshot wire.
  app.get('/v1/host/openwop-app/crm/runs/:runId', async (req, res, next) => {
    try {
      await checkEntitlement(req, TOGGLE_ID); // ADR 0419 — entitlement only; the toggle half is deliberately absent (see above)
      const run = await storage.getRun(req.params.runId);
      const metadata = (run?.metadata ?? {}) as { featureVariant?: { feature?: string }; crm?: unknown };
      // Tenant-scoped AND CRM-specific: only a CRM-stamped run resolves here, so
      // this endpoint can't be used to read arbitrary runs' metadata.
      if (!run || run.tenantId !== tenantOf(req) || metadata.featureVariant?.feature !== TOGGLE_ID) {
        throw new OpenwopError('not_found', 'CRM run not found.', 404, { runId: req.params.runId });
      }
      res.json({
        runId: run.runId,
        status: run.status,
        featureVariant: metadata.featureVariant,
        crm: metadata.crm ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  // Start a triage run for a contact, stamping the resolved variant + bindings
  // into run.metadata (replay-safe). The variant's bindings select the triage
  // node a fuller workflow would dispatch; the run itself executes the
  // configured triage workflow (default openwop-app.uppercase) so observability
  // / replay / fork are inherited from the standard run pipeline.
  app.post('/v1/host/openwop-app/crm/contacts/:id/triage', async (req, res, next) => {
    try {
      const assignment = await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6) — triage spawns a run
      const tenantId = tenantOf(req);
      const contact = await getContact(req.params.id);
      if (!contact || contact.tenantId !== tenantId) {
        throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: req.params.id });
      }
      const body = (req.body ?? {}) as { workflowId?: unknown };
      const workflowId =
        (typeof body.workflowId === 'string' && body.workflowId.length > 0 ? body.workflowId : undefined) ??
        process.env.OPENWOP_CRM_TRIAGE_WORKFLOW_ID ??
        'openwop-app.uppercase';

      // Resolve the triage workflow up front — refuse with 422 rather than
      // leaving a dangling pending run that can never execute.
      // ADR 0474 P1b (review F3) — triage launches are production: published-when-present.
      const wf = await resolveLaunchWorkflow(hostSuite.workflowCatalog, tenantId, workflowId);
      if (!wf) {
        throw new OpenwopError('workflow_not_found', `Triage workflow not found: ${workflowId}`, 422, { workflowId });
      }

      const runId = randomUUID();
      const now = new Date().toISOString();
      // THE STAMP — readable verbatim on replay/fork (ADR §3.4/§3.5).
      const featureVariant: Record<string, unknown> = { feature: TOGGLE_ID, variant: assignment.variant };
      if (assignment.bindings) featureVariant.bindings = assignment.bindings;
      const run: RunRecord = {
        runId,
        workflowId,
        tenantId,
        status: 'pending',
        inputs: { contact: { contactId: contact.contactId, stage: contact.stage, company: contact.company ?? null } },
        metadata: { crm: { contactId: contact.contactId, stage: contact.stage }, featureVariant },
        configurable: {},
        createdAt: now,
        updatedAt: now,
      };
      await insertRunWithStartContext(storage, run, { definition: wf.definition });
      await getEventLog().append({
        runId,
        type: 'openwop-app.crm.contact-triaged',
        payload: { contactId: contact.contactId, variant: assignment.variant },
      });
      // B3a (gap-analysis §5B): denormalized last-triage stamp for list sort /
      // run linking. Route-side fact, written at dispatch — run.metadata stays
      // the provenance SSoT, so replay/fork are untouched.
      await setContactTriage(contact.contactId, tenantId, { variant: assignment.variant, runId, at: now });
      setImmediate(() => {
        executeRun(storage, run, wf.definition, { policyResolver: hostSuite.providerPolicyResolver }).catch((err) => {
          log.error('crm_triage_dispatch_failed', { runId, error: err instanceof Error ? err.message : String(err) });
        });
      });

      res.status(202).json({
        runId,
        variant: assignment.variant,
        bindings: assignment.bindings ?? null,
        workflowId,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Contact custom-field defs (ADR 0213 §2) — TENANT-scoped, no :orgId
  // segment (mirrors orgRoutes.ts's org `/fields` but keyed by tenant only —
  // see `FieldDef.orgId`'s doc comment for the `CONTACT_FIELD_DEF_ORG` sentinel). ──
  app.get('/v1/host/openwop-app/crm/fields', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ fields: await listContactFieldDefs(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/crm/fields', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const body = (req.body ?? {}) as Record<string, unknown>;
      const def = await createContactFieldDef({
        tenantId: tenantOf(req),
        key: requireString(body.key, 'key'),
        label: requireString(body.label, 'label'),
        type: requireString(body.type, 'type') as FieldType,
        required: body.required === true,
        options: body.options,
        refEntityType: body.refEntityType,
        actor: principalOf(req),
      });
      res.status(201).json(def);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/crm/fields/:defId', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const ok = await deleteContactFieldDef(tenantOf(req), req.params.defId, { actor: principalOf(req) });
      if (!ok) throw new OpenwopError('not_found', 'Field not found.', 404, { defId: req.params.defId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Saved segments (ADR 0211 §2) — TENANT-scoped, contacts-only v1;
  // evaluated at READ (`resolveSegmentMembers`), never materialized. ──
  app.get('/v1/host/openwop-app/crm/segments', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ segments: await listSegments(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/crm/segments', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const body = (req.body ?? {}) as { name?: unknown; filters?: unknown; watchEntries?: unknown };
      const segment = await createSegment({
        tenantId: tenantOf(req),
        name: requireString(body.name, 'name'),
        filters: body.filters ?? [],
        createdBy: principalOf(req),
        ...(typeof body.watchEntries === 'boolean' ? { watchEntries: body.watchEntries } : {}),
        actor: principalOf(req),
      });
      res.status(201).json(segment);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/openwop-app/crm/segments/:segmentId', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const segment = await getSegment(tenantOf(req), req.params.segmentId);
      if (!segment) throw new OpenwopError('not_found', 'Segment not found.', 404, { segmentId: req.params.segmentId });
      res.json(segment);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/openwop-app/crm/segments/:segmentId', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const body = (req.body ?? {}) as { name?: unknown; filters?: unknown; watchEntries?: unknown };
      const patch: { name?: string; filters?: unknown; watchEntries?: boolean } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (body.filters !== undefined) patch.filters = body.filters;
      if (typeof body.watchEntries === 'boolean') patch.watchEntries = body.watchEntries;
      const updated = await updateSegment(tenantOf(req), req.params.segmentId, patch, { actor: principalOf(req) });
      if (!updated) throw new OpenwopError('not_found', 'Segment not found.', 404, { segmentId: req.params.segmentId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/crm/segments/:segmentId', async (req, res, next) => {
    try {
      await requireEnabled(req);
      await requireTenantScope(req, 'workspace:write'); // ADR 0627 D3 (CRM-6)
      const ok = await deleteSegment(tenantOf(req), req.params.segmentId, { actor: principalOf(req) });
      if (!ok) throw new OpenwopError('not_found', 'Segment not found.', 404, { segmentId: req.params.segmentId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Read-only: a segment's LIVE membership (evaluated against the current
  // rolodex on every call — never a stale materialized snapshot).
  app.get('/v1/host/openwop-app/crm/segments/:segmentId/members', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ members: await resolveSegmentMembers(tenantOf(req), req.params.segmentId) });
    } catch (err) {
      next(err);
    }
  });

  // Audience insights (ADR 0265 / CDP-C) — read-time projections, no materialization.
  app.get('/v1/host/openwop-app/crm/segments/:segmentId/estimate', async (req, res, next) => {
    try { await requireEnabled(req); res.json(await segmentEstimate(tenantOf(req), req.params.segmentId)); } catch (err) { next(err); }
  });

  app.get('/v1/host/openwop-app/crm/segments/:segmentId/insights', async (req, res, next) => {
    try { await requireEnabled(req); res.json(await segmentInsights(tenantOf(req), req.params.segmentId)); } catch (err) { next(err); }
  });

  app.get('/v1/host/openwop-app/crm/segments-overlap', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const a = requireString(req.query.a, 'a');
      const b = requireString(req.query.b, 'b');
      res.json(await segmentOverlap(tenantOf(req), a, b));
    } catch (err) { next(err); }
  });
}
