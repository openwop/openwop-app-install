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
import { OpenwopError } from '../../types.js';
import type { RunRecord } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { executeRun } from '../../executor/executor.js';
import { getEventLog } from '../../executor/eventLog.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { ResolvedAssignment, ToggleSubject } from '../../host/featureToggles/types.js';
import {
  CONTACT_STAGES,
  createContact,
  deleteContact,
  getContact,
  listContacts,
  updateContact,
  type ContactStage,
} from './contactsService.js';

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
  return assignment;
}

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

function parseStage(value: unknown): ContactStage | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (CONTACT_STAGES as readonly string[]).includes(value)) return value as ContactStage;
  throw new OpenwopError('validation_error', `Field \`stage\` MUST be one of ${CONTACT_STAGES.join(', ')}.`, 400, {
    field: 'stage',
    allowed: CONTACT_STAGES,
  });
}

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

  app.get('/v1/host/openwop-app/crm/contacts', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ contacts: await listContacts(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/crm/contacts', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as { name?: unknown; email?: unknown; company?: unknown; stage?: unknown };
      const contact = await createContact({
        tenantId: tenantOf(req),
        name: requireString(body.name, 'name'),
        stage: parseStage(body.stage),
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(typeof body.company === 'string' ? { company: body.company } : {}),
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
      const existing = await getContact(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: req.params.id });
      }
      const body = (req.body ?? {}) as { name?: unknown; email?: unknown; company?: unknown; stage?: unknown };
      const updated = await updateContact(req.params.id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        email: patchString(body.email, 'email'),
        company: patchString(body.company, 'company'),
        stage: parseStage(body.stage),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/crm/contacts/:id', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const existing = await getContact(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: req.params.id });
      }
      await deleteContact(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Read a triage run's provenance stamp (variant + bindings + crm block).
  // DELIBERATELY NOT toggle-gated: a historical run's provenance is readable
  // regardless of the feature's CURRENT state — this is exactly the decoupling
  // that keeps replay/fork honest (ADR §3.4). Tenant-scoped. The stamp lives in
  // host-internal run.metadata, NOT on the normative RunSnapshot wire.
  app.get('/v1/host/openwop-app/crm/runs/:runId', async (req, res, next) => {
    try {
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
      const wf = await hostSuite.workflowCatalog.getWorkflow(workflowId);
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
      await insertRunWithStartContext(storage, run);
      await getEventLog().append({
        runId,
        type: 'host.crm.contact.triaged',
        payload: { contactId: contact.contactId, variant: assignment.variant },
      });
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
}
