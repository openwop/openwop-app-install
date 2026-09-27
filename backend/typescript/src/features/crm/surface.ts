/**
 * CRM workflow surface (ADR 0014 Phase 4) — `ctx.features.crm`, the SECOND
 * reference feature surface, proving the FeatureModule pattern generalizes beyond
 * KB. A THIN adapter over `crmEntitiesService` / `contactsService` / `convertService`
 * (the source of truth shared with the REST face). Tenant comes from the run
 * scope — NEVER from node args (CTI-1); `orgId` is node-supplied for org-scoped
 * entities and the SERVICE enforces the tenant+org key — a cross-tenant id is not
 * found. Reads back `role:action` pack nodes (recorded → replay-served); the
 * 13 write verbs back `role:"side-effect"` nodes (ADR 0627 D1) — the
 * classification, not the id, is what keeps a `mode:'replay'` fork from
 * re-executing them.
 *
 * NOTE: only CTI-1-safe org-scoped reads are exposed. `contactsService.getContact`
 * (by id, no tenant guard) is deliberately NOT surfaced directly — every mutation
 * below that touches an existing contact re-verifies `tenantId` + `!mergedInto`
 * itself (mirrors the tenant guard `routes.ts` applies before every contact PATCH).
 *
 * MUTATIONS (ADR 0208 §2): every write below calls the SAME service function the
 * HTTP routes call, then `crmMutated` with actor `run:<runId>` — so caps, link
 * validation, custom-field validation, status derivation, host events, and audit
 * apply identically whether a human or an agent/workflow made the change.
 * Idempotency: every creation verb accepts an optional deterministic id (ADR
 * 0162 pattern); the pack node layer supplies `<prefix>:${runId}:${nodeId}` when
 * the caller omits one. That id is a PER-RUN dedupe key (a retried node in the
 * same run converges), NOT a cross-run fork guard — a fork has its own runId.
 * The fork guard is the pack's `role:"side-effect"` classification (ADR 0627 D1).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { HostEventOrigin } from '../../host/hostEventDispatcher.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { filterVisibleCrmRecords } from '../../host/crmRecordVisibility.js';
import { OpenwopError } from '../../types.js';
import { requireString as requireStr } from '../featureRoute.js';
import {
  listCompanies,
  getCompany,
  listDeals,
  getDeal,
  listTasks,
  createCompany as crmCreateCompany,
  createDeal as crmCreateDeal,
  updateDeal as crmUpdateDeal,
  createTask as crmCreateTask,
  updateTask as crmUpdateTask,
  createActivity as crmCreateActivity,
  makeLinkValidators,
} from './crmEntitiesService.js';
import {
  createContact as ctCreateContact,
  getContact as ctGetContact,
  updateContact as ctUpdateContact,
  findContactByEmail as ctFindContactByEmail,
  parseStage,
} from './contactsService.js';
import { convertContact as svcConvertContact } from './convertService.js';
import { createBookingLink as svcCreateBookingLink, type BookingLinkStatus } from './entities/bookingLinks.js';
import { listBookings as svcListBookings, type BookingStatus } from './entities/bookings.js';
import { requestSignature as svcRequestSignature, getSignatureStatus as svcGetSignatureStatus } from './signService.js';
import { resolveSegmentMembers, segmentVocabulary, validateSegmentDraft, createSegment } from './segmentsService.js';
import { suppressionSummary as svcSuppressionSummary } from './suppressionService.js';
import {
  getGmailSync as gsGetGmailSync,
  advanceGmailSyncCursor as gsAdvanceGmailSyncCursor,
  appendGmailActivity as gsAppendGmailActivity,
  markGmailSyncStatus as gsMarkGmailSyncStatus,
  recordGmailSyncScan as gsRecordGmailSyncScan,
  GMAIL_SYNC_UNSETTLED_MAX,
  type GmailSyncUnsettled,
} from './gmailSyncService.js';

/** Internal metadata stripped from surface outputs — a workflow node's output is
 *  recorded in the durable event log, so it carries the entity's display fields,
 *  not the host's identity/attribution columns (the KB surface already returns
 *  projected shapes). */
const INTERNAL = new Set(['tenantId', 'orgId', 'createdBy', 'updatedBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const projectOne = (o: object | null): Record<string, unknown> | null => (o ? project(o) : null);

export function buildCrmSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  // ADR 0272 P4 — the run owner's durable principal is the visibility viewer for
  // run-context CRM reads (re-stamped on :fork, so filtered reads are replay-safe
  // w.r.t. the viewer). Absent for system runs ⇒ unfiltered (no human ⇒ no
  // territory scoping). Closes the surface read-leak the P4 review flagged.
  const viewer = scope.actingUserId;
  // The acting principal for every mutation this surface performs — a run,
  // never a human — so audit + host events attribute agent/workflow writes
  // distinctly from HTTP-route writes (ADR 0208 §2/§3).
  const actor = `run:${scope.runId ?? 'unknown'}`;
  // ADR 0627 D2 / ADR 0617 D1a — every lifecycle event a surface verb causes is
  // emitted INSIDE the entity service with this `{ actor, origin }`: the audit
  // row keeps the run actor, and the dispatcher's self-trigger guard skips a
  // binding on the emitting run's own workflow / chain lineage (a chain that
  // creates a contact must not start a second run of itself via
  // `host.crm.contact.created`).
  const origin: HostEventOrigin = {
    ...(scope.runId ? { runId: scope.runId } : {}),
    ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
    ...(scope.chainId ? { chainId: scope.chainId } : {}),
  };
  const emit = { actor, origin } as const;

  /** Tenant-guarded contact fetch (mirrors `routes.ts`'s inline guard before
   *  every contact PATCH — `getContact` itself carries no tenant check).
   *  Refuses a tombstoned (merged-away) contact — "guard tombstoned contacts". */
  async function loadOwnedContact(contactId: string) {
    const c = await ctGetContact(contactId);
    if (!c || c.tenantId !== tenantId || c.mergedInto) {
      throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId });
    }
    return c;
  }

  /** Link validators bound to this scope's tenant(+org) — CRMGAP-11's shared
   *  `crmEntitiesService.makeLinkValidators` (was a local duplicate). */
  const linkValidators = (orgId: string) => makeLinkValidators(tenantId, orgId);

  /** ADR 0272 Wave 2 — a linked deal/company (on a new activity/task) must be
   *  visible to the run owner, else a uniform 404 (closes the existence oracle +
   *  the write to an unseen record's timeline). No-op for system runs (no viewer). */
  const assertLinkVisible = async (orgId: string, links: { dealId?: string; companyId?: string }): Promise<void> => {
    if (viewer === undefined) return;
    if (links.dealId) {
      const d = await getDeal(tenantId, orgId, links.dealId);
      const vis = d ? await filterVisibleCrmRecords({ tenantId, orgId, target: 'deal', callerSubject: viewer, rows: [d], idOf: (x) => x.dealId }) : [];
      if (!d || vis.length === 0) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: links.dealId });
    }
    if (links.companyId) {
      const c = await getCompany(tenantId, orgId, links.companyId);
      const vis = c ? await filterVisibleCrmRecords({ tenantId, orgId, target: 'company', callerSubject: viewer, rows: [c], idOf: (x) => x.companyId }) : [];
      if (!c || vis.length === 0) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: links.companyId });
    }
  };

  return {
    // ── Reads (unchanged) ──────────────────────────────────────────────────
    listCompanies: async (args) => {
      const companies = await listCompanies(tenantId, str(args.orgId), optStr(args.q), viewer);
      return { companies: companies.map(project) };
    },
    getCompany: async (args) => {
      const company = await getCompany(tenantId, str(args.orgId), str(args.companyId));
      if (company && viewer !== undefined) {
        const vis = await filterVisibleCrmRecords({ tenantId, orgId: str(args.orgId), target: 'company', callerSubject: viewer, rows: [company], idOf: (c) => c.companyId });
        if (vis.length === 0) return { company: projectOne(null) };
      }
      return { company: projectOne(company) };
    },
    listDeals: async (args) => {
      const filter: { pipelineId?: string; stageId?: string; companyId?: string; q?: string } = {};
      if (optStr(args.pipelineId)) filter.pipelineId = str(args.pipelineId);
      if (optStr(args.stageId)) filter.stageId = str(args.stageId);
      if (optStr(args.companyId)) filter.companyId = str(args.companyId);
      if (optStr(args.q)) filter.q = str(args.q);
      const deals = await listDeals(tenantId, str(args.orgId), filter, viewer);
      return { deals: deals.map(project) };
    },
    getDeal: async (args) => {
      const deal = await getDeal(tenantId, str(args.orgId), str(args.dealId));
      // single-get honors visibility too (returns not-found when out of scope)
      if (deal && viewer !== undefined) {
        const vis = await filterVisibleCrmRecords({ tenantId, orgId: str(args.orgId), target: 'deal', callerSubject: viewer, rows: [deal], idOf: (d) => d.dealId });
        if (vis.length === 0) return { deal: projectOne(null) };
      }
      return { deal: projectOne(deal) };
    },
    listTasks: async (args) => {
      const filter: { status?: string; dealId?: string } = {};
      if (optStr(args.status)) filter.status = str(args.status);
      if (optStr(args.dealId)) filter.dealId = str(args.dealId);
      const tasks = await listTasks(tenantId, str(args.orgId), filter);
      return { tasks: tasks.map(project) };
    },

    /** ADR 0211 §2 — a saved segment's LIVE membership, evaluated against the
     *  tenant rolodex on every call (never materialized). Tenant-guarded
     *  (`resolveSegmentMembers` 404s a foreign/missing segmentId). */
    // ADR 0265 / CDP-C — the segment-author copilot's closed-world grounding: the
    // legal vocabulary + a non-throwing validate for its draft→validate loop.
    segmentVocabulary: async () => ({ ...segmentVocabulary() }),
    validateSegment: async (args) => ({ ...validateSegmentDraft(args.filters) }),
    listSegmentMembers: async (args) => {
      const members = await resolveSegmentMembers(tenantId, requireStr(args.segmentId, 'segmentId'));
      return { members: members.map(project) };
    },
    // ADR 0265 / CDP-C — the segment-author copilot's PERSIST leg (the draft→
    // validate→persist trio, mirroring workflow-author). Closed-world gate: the
    // draft is re-validated server-side and a NON-valid draft is refused WITHOUT
    // a write (fail-closed, structured errors — never persist a bad segment).
    // A saved segment is a filter; it is inert until wired to activation
    // (journeys/reverse-ETL, separately consent-gated per the CDP Gate-0 order).
    persistSegment: async (args) => {
      const check = validateSegmentDraft(args.filters);
      if (!check.valid) return { success: false, errors: check.errors };
      const segment = await createSegment({
        tenantId,
        name: requireStr(args.name, 'name'),
        filters: check.filters,
        createdBy: actor,
        ...(optStr(args.segmentId) ? { segmentId: optStr(args.segmentId)! } : {}),
        ...emit,
      });
      return { success: true, segment: { segmentId: segment.segmentId, name: segment.name, filters: segment.filters } };
    },

    /** ADR 0251 — suppression-cause analytics (counts by reason + source, no
     *  addresses). A pure read projection; chat-drivable via the CRM node. */
    suppressionSummary: async () => ({ summary: await svcSuppressionSummary(tenantId) }),

    // ── Mutations (ADR 0208 §2) ─────────────────────────────────────────────

    /** Idempotent by `contactId` (ADR 0162) — a re-run/fork supplying the same
     *  explicit id returns the existing row unchanged rather than duplicating. */
    createContact: async (args) => {
      const contact = await ctCreateContact({
        tenantId,
        name: requireStr(args.name, 'name'),
        ...(optStr(args.email) ? { email: optStr(args.email) } : {}),
        ...(optStr(args.company) ? { company: optStr(args.company) } : {}),
        ...(parseStage(args.stage, { required: false }) ? { stage: parseStage(args.stage, { required: false }) } : {}),
        ...(optStr(args.owner) ? { owner: optStr(args.owner) } : {}),
        // CRM-2 — first-class attributes; the service validates fail-closed + upserts phone.
        ...(optStr(args.title) ? { title: optStr(args.title) } : {}),
        ...(optStr(args.address) ? { address: optStr(args.address) } : {}),
        ...(optStr(args.leadSource) ? { leadSource: optStr(args.leadSource) } : {}),
        ...(optStr(args.phone) ? { phone: optStr(args.phone) } : {}),
        ...(optStr(args.contactId) ? { contactId: optStr(args.contactId) } : {}),
        ...emit,
      });
      return { success: true, contact: project(contact) };
    },

    /** Tombstone-guarded (mergedInto refused, mirrors `routes.ts`). */
    updateContactStage: async (args) => {
      const contactId = requireStr(args.contactId, 'contactId');
      const stage = parseStage(args.stage, { required: true });
      await loadOwnedContact(contactId);
      const updated = await ctUpdateContact(contactId, { stage }, emit);
      return { success: true, contact: projectOne(updated) };
    },

    /** Tombstone-guarded. */
    updateContactOwner: async (args) => {
      const contactId = requireStr(args.contactId, 'contactId');
      const owner = requireStr(args.owner, 'owner');
      await loadOwnedContact(contactId);
      const updated = await ctUpdateContact(contactId, { owner }, emit);
      return { success: true, contact: projectOne(updated) };
    },

    /** ADR 0209 §3 lead conversion — `convertService.convertContact` already
     *  guards the tombstone + is idempotent-by-outcome (a re-convert finds the
     *  existing open deal rather than creating a duplicate). */
    convertContact: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const contactId = requireStr(args.contactId, 'contactId');
      const result = await svcConvertContact({
        tenantId,
        orgId,
        contactId,
        actor,
        ...(optStr(args.companyName) ? { companyName: optStr(args.companyName) } : {}),
        ...(optStr(args.pipelineId) ? { pipelineId: optStr(args.pipelineId) } : {}),
        ...(optStr(args.dealTitle) ? { dealTitle: optStr(args.dealTitle) } : {}),
        origin,
      });
      // Wave 2 MEDIUM 1 — a convert that MATCHED a pre-existing company/deal must
      // not project that record's content back to a viewer who cannot see it
      // (get-or-create-by-name would otherwise be a cross-territory read oracle).
      // Newly-CREATED records are always returned (the caller just made them).
      const companyVisible = viewer === undefined || result.created.company
        || (await filterVisibleCrmRecords({ tenantId, orgId, target: 'company', callerSubject: viewer, rows: [result.company], idOf: (c) => c.companyId })).length > 0;
      const dealVisible = viewer === undefined || result.created.deal
        || (await filterVisibleCrmRecords({ tenantId, orgId, target: 'deal', callerSubject: viewer, rows: [result.deal], idOf: (d) => d.dealId })).length > 0;
      return {
        success: true,
        contact: project(result.contact),
        company: companyVisible ? project(result.company) : null,
        deal: dealVisible ? project(result.deal) : null,
        created: result.created,
      };
    },

    /** Idempotent by `companyId` (ADR 0162). */
    createCompany: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const company = await crmCreateCompany({
        tenantId,
        orgId,
        name: requireStr(args.name, 'name'),
        ...(optStr(args.domain) ? { domain: optStr(args.domain) } : {}),
        // CRM-2 — the service validates fail-closed; forward numeric firmographics as-is.
        ...(typeof args.size === 'number' ? { size: args.size } : {}),
        ...(typeof args.revenue === 'number' ? { revenue: args.revenue } : {}),
        createdBy: actor,
        ...(optStr(args.companyId) ? { companyId: optStr(args.companyId) } : {}),
        ...emit,
      });
      return { success: true, company: project(company) };
    },

    /** Idempotent by `dealId` (ADR 0162). Link validators enforce the same
     *  org/tenant scoping the org routes rely on. */
    createDeal: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const deal = await crmCreateDeal({
        tenantId,
        orgId,
        title: requireStr(args.title, 'title'),
        ...(typeof args.amount === 'number' && Number.isFinite(args.amount) ? { amount: args.amount } : {}),
        ...(optStr(args.companyId) ? { companyId: optStr(args.companyId) } : {}),
        ...(optStr(args.contactId) ? { contactId: optStr(args.contactId) } : {}),
        ...(optStr(args.pipelineId) ? { pipelineId: optStr(args.pipelineId) } : {}),
        ...(optStr(args.stageId) ? { stageId: optStr(args.stageId) } : {}),
        ...(optStr(args.closeDate) ? { closeDate: optStr(args.closeDate) } : {}),
        createdBy: actor,
        ...linkValidators(orgId),
        ...(optStr(args.dealId) ? { dealId: optStr(args.dealId) } : {}),
        ...emit,
      });
      return { success: true, deal: project(deal) };
    },

    /** `crmEntitiesService.updateDeal` already tenant+org-guards (returns null
     *  on a miss) — same guard the routes rely on. ADR 0627 D2: `stage-changed`
     *  and `won`/`lost` are decided INSIDE `updateDeal` on the landed row (a
     *  move to the same stage, or onto a stage the deal already won on, is not
     *  a transition — this verb used to re-emit both unconditionally). */
    moveDealStage: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const dealId = requireStr(args.dealId, 'dealId');
      const stageId = requireStr(args.stageId, 'stageId');
      // Wave 2 — territory-scoped WRITE: a run may only move a deal its owner can see.
      if (viewer !== undefined) {
        const deal = await getDeal(tenantId, orgId, dealId);
        const vis = deal ? await filterVisibleCrmRecords({ tenantId, orgId, target: 'deal', callerSubject: viewer, rows: [deal], idOf: (d) => d.dealId }) : [];
        if (!deal || vis.length === 0) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId });
      }
      const updated = await crmUpdateDeal(tenantId, orgId, dealId, { stageId }, linkValidators(orgId), actor, { origin });
      if (!updated) throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId });
      return { success: true, deal: project(updated) };
    },

    /** Idempotent by `taskId` (ADR 0162). */
    createTask: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      await assertLinkVisible(orgId, { ...(optStr(args.dealId) ? { dealId: optStr(args.dealId) } : {}) });
      const task = await crmCreateTask({
        tenantId,
        orgId,
        title: requireStr(args.title, 'title'),
        ...(optStr(args.dueDate) ? { dueDate: optStr(args.dueDate) } : {}),
        ...(optStr(args.dealId) ? { dealId: optStr(args.dealId) } : {}),
        createdBy: actor,
        validators: linkValidators(orgId),
        ...(optStr(args.taskId) ? { taskId: optStr(args.taskId) } : {}),
        ...emit,
      });
      return { success: true, task: project(task) };
    },

    /** `crmEntitiesService.updateTask` tenant+org-guards via `getTask` — same
     *  guard the routes rely on. */
    completeTask: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const taskId = requireStr(args.taskId, 'taskId');
      const updated = await crmUpdateTask(tenantId, orgId, taskId, { status: 'done' }, emit); // `completed` iff the status flipped — inside the service
      if (!updated) throw new OpenwopError('not_found', 'Task not found.', 404, { taskId });
      return { success: true, task: project(updated) };
    },

    /** Append-only — idempotent by `activityId` (ADR 0162). */
    logActivity: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const kind = requireStr(args.kind, 'kind');
      await assertLinkVisible(orgId, { ...(optStr(args.dealId) ? { dealId: optStr(args.dealId) } : {}), ...(optStr(args.companyId) ? { companyId: optStr(args.companyId) } : {}) });
      const activity = await crmCreateActivity({
        tenantId,
        orgId,
        // crmCreateActivity validates `kind` against ACTIVITY_KINDS itself.
        kind: kind as Parameters<typeof crmCreateActivity>[0]['kind'],
        body: requireStr(args.body, 'body'),
        ...(optStr(args.dealId) ? { dealId: optStr(args.dealId) } : {}),
        ...(optStr(args.contactId) ? { contactId: optStr(args.contactId) } : {}),
        ...(optStr(args.companyId) ? { companyId: optStr(args.companyId) } : {}),
        createdBy: actor,
        validators: linkValidators(orgId),
        ...(optStr(args.activityId) ? { activityId: optStr(args.activityId) } : {}),
        ...emit,
      });
      return { success: true, activity: project(activity) };
    },

    // ── Booking links (ADR 0402 §a) ─────────────────────────────────────────

    /** Idempotent by `bookingLinkId` (ADR 0162) — a re-run/fork supplying the
     *  same deterministic id returns the existing link unchanged. The public
     *  slot-claim path is NOT node-driven (a visitor action), so no claim verb. */
    createBookingLink: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const link = await svcCreateBookingLink({
        tenantId,
        orgId,
        ownerUserId: optStr(args.ownerUserId) ?? (viewer ?? actor),
        title: requireStr(args.title, 'title'),
        ...(optStr(args.description) ? { description: optStr(args.description) } : {}),
        ...(optStr(args.status) ? { status: optStr(args.status) as BookingLinkStatus } : {}),
        timezone: requireStr(args.timezone, 'timezone'),
        weeklyHours: args.weeklyHours,
        durations: args.durations,
        ...(typeof args.bufferBeforeMin === 'number' ? { bufferBeforeMin: args.bufferBeforeMin } : {}),
        ...(typeof args.bufferAfterMin === 'number' ? { bufferAfterMin: args.bufferAfterMin } : {}),
        ...(typeof args.minNoticeMin === 'number' ? { minNoticeMin: args.minNoticeMin } : {}),
        ...(typeof args.maxAdvanceDays === 'number' ? { maxAdvanceDays: args.maxAdvanceDays } : {}),
        ...(optStr(args.videoLink) ? { videoLink: optStr(args.videoLink) } : {}),
        ...(optStr(args.location) ? { location: optStr(args.location) } : {}),
        createdBy: actor,
        ...(optStr(args.slug) ? { slug: optStr(args.slug) } : {}),
        ...(optStr(args.bookingLinkId) ? { bookingLinkId: optStr(args.bookingLinkId) } : {}),
        ...emit,
      });
      return { success: true, bookingLink: project(link) };
    },

    /** Org-scoped read of a link's bookings (or all bookings in the org). */
    listBookings: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const filter: { bookingLinkId?: string; status?: BookingStatus } = {};
      if (optStr(args.bookingLinkId)) filter.bookingLinkId = optStr(args.bookingLinkId);
      if (optStr(args.status) === 'confirmed' || optStr(args.status) === 'cancelled') filter.status = optStr(args.status) as BookingStatus;
      const bookings = await svcListBookings(tenantId, orgId, filter);
      return { bookings: bookings.map(project) };
    },

    // ── E-signature (ADR 0402 §b) ───────────────────────────────────────────

    /** Request signatures on a commerce quote / document. Idempotent by
     *  `signRequestId` (ADR 0162) — a fork/re-run returns the existing request
     *  without re-minting signer tokens or re-emailing. The signing base URL
     *  comes from the configured public origin (no request in a run context). */
    requestSignature: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const target = (args.target ?? {}) as { kind?: unknown; id?: unknown };
      const signersIn = Array.isArray(args.signers) ? args.signers : [];
      const signers = signersIn.map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        return {
          email: requireStr(o.email, 'signers[].email'),
          ...(optStr(o.name) ? { name: optStr(o.name) } : {}),
          ...(typeof o.order === 'number' ? { order: o.order } : {}),
        };
      });
      const req = await svcRequestSignature({
        tenantId,
        orgId,
        target: { kind: requireStr(target.kind, 'target.kind'), id: requireStr(target.id, 'target.id') },
        signers,
        createdBy: actor,
        origin, // ADR 0617 D1a (review S3) — the run's `created` must not re-trigger its own binding
        baseUrl: process.env.OPENWOP_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') ?? '',
        ...(optStr(args.signRequestId) ? { signRequestId: optStr(args.signRequestId) } : {}),
      });
      // The sign SERVICE owns the lifecycle emits (created/signed/completed/…),
      // since most fire from public signer actions — so no double-emit here.
      const status = await svcGetSignatureStatus(tenantId, orgId, req.signRequestId);
      return { success: true, signRequest: status };
    },

    /** Status of a sign request (signers + audit + certificate URL). */
    getSignatureStatus: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const status = await svcGetSignatureStatus(tenantId, orgId, requireStr(args.signRequestId, 'signRequestId'));
      return { signRequest: status };
    },

    // ── Gmail inbox sync (ADR 0252 §5) ──────────────────────────────────────

    /** The gmail-sync node's read of its opt-in row — tenant-guarded (a
     *  foreign/missing syncId resolves `sync: null`, never a throw, so the
     *  node can fail gracefully rather than crash the run). */
    getGmailSyncForRun: async (args) => {
      const syncId = requireStr(args.syncId, 'syncId');
      const sync = await gsGetGmailSync(tenantId, syncId);
      // `status` / `pausedReason` ride out so the node can REFUSE a paused or
      // needs-reconsent sync itself (ADR 0627 D5(c)) — the scheduler fires the
      // workflow directly, bypassing `syncGmailNow`'s guard.
      return {
        sync: sync
          ? {
              orgId: sync.orgId,
              connectionId: sync.connectionId,
              cursor: sync.cursor ?? null,
              status: sync.status,
              pausedReason: sync.pausedReason ?? null,
              scan: sync.scan ?? null,
              unsettled: sync.unsettled ?? {},
            }
          : null,
      };
    },

    /** ADR 0627 D5(c) — the run's SELF-STOP: `paused` (reason `capped`, the
     *  only run-lane reason) or `needs-reconsent` (the pinned connection was
     *  refused at the broker). Disables the scheduler job in the same step.
     *  Closed-world on both fields; a foreign/missing syncId is a 404. */
    markGmailSyncRunStatus: async (args) => {
      const syncId = requireStr(args.syncId, 'syncId');
      const status = requireStr(args.status, 'status');
      if (status !== 'paused' && status !== 'needs-reconsent') {
        throw new OpenwopError('validation_error', 'status must be `paused` or `needs-reconsent`.', 400, { field: 'status' });
      }
      const pausedReason = optStr(args.pausedReason);
      if (status === 'paused' && pausedReason !== 'capped') {
        throw new OpenwopError('validation_error', 'a run-lane pause must carry pausedReason `capped`.', 400, { field: 'pausedReason' });
      }
      const updated = await gsMarkGmailSyncStatus(tenantId, syncId, status, status === 'paused' ? 'capped' : undefined);
      if (!updated) throw new OpenwopError('not_found', 'Gmail sync not found.', 404, { syncId });
      return { success: true, status: updated.status };
    },

    /** ADR 0627 D5 (review SHOULD-1/-3) — persist the pass's scan state:
     *  `scan` (a window `{ before, newest }` of ISO dates, or null to close it),
     *  `unsettled` (messageId → { passes ≥ 1, at? ISO }, ≤ GMAIL_SYNC_UNSETTLED_MAX
     *  ids) and `released` (ids the node stopped holding for — each is logged at
     *  warn by the service). Closed-world on every field. */
    recordGmailSyncScan: async (args) => {
      const syncId = requireStr(args.syncId, 'syncId');
      const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
      let scan: { before: string; newest: string } | null | undefined;
      if (args.scan === null) scan = null;
      else if (args.scan !== undefined) {
        const w = args.scan as { before?: unknown; newest?: unknown };
        if (typeof w !== 'object' || !isIso(w.before) || !isIso(w.newest)) {
          throw new OpenwopError('validation_error', 'scan must be null or { before: ISO, newest: ISO }.', 400, { field: 'scan' });
        }
        scan = { before: w.before, newest: w.newest };
      }
      let unsettled: Record<string, GmailSyncUnsettled> | undefined;
      if (args.unsettled !== undefined) {
        const raw = args.unsettled as Record<string, { passes?: unknown; at?: unknown }>;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new OpenwopError('validation_error', 'unsettled must be an object keyed by messageId.', 400, { field: 'unsettled' });
        const ids = Object.keys(raw);
        if (ids.length > GMAIL_SYNC_UNSETTLED_MAX) throw new OpenwopError('validation_error', `unsettled holds at most ${GMAIL_SYNC_UNSETTLED_MAX} messages.`, 400, { field: 'unsettled', max: GMAIL_SYNC_UNSETTLED_MAX });
        unsettled = {};
        for (const id of ids) {
          const e = raw[id] ?? {};
          if (!id || typeof e !== 'object' || !Number.isInteger(e.passes) || (e.passes as number) < 1 || (e.at !== undefined && !isIso(e.at))) {
            throw new OpenwopError('validation_error', 'each unsettled entry is { passes: integer ≥ 1, at?: ISO }.', 400, { field: 'unsettled', messageId: id });
          }
          unsettled[id] = { passes: e.passes as number, ...(isIso(e.at) ? { at: e.at } : {}) };
        }
      }
      const released = Array.isArray(args.released) ? args.released.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
      const updated = await gsRecordGmailSyncScan(tenantId, syncId, { ...(scan !== undefined ? { scan } : {}), ...(unsettled !== undefined ? { unsettled } : {}), released });
      if (!updated) throw new OpenwopError('not_found', 'Gmail sync not found.', 404, { syncId });
      return { success: true };
    },

    /** Advance a sync's time cursor after a pass. */
    advanceGmailSyncCursor: async (args) => {
      const syncId = requireStr(args.syncId, 'syncId');
      const cursor = requireStr(args.cursor, 'cursor');
      const updated = await gsAdvanceGmailSyncCursor(tenantId, syncId, cursor);
      if (!updated) throw new OpenwopError('not_found', 'Gmail sync not found.', 404, { syncId });
      return { success: true };
    },

    /** Tenant-wide email → contact match (ADR 0252 §2 — never creates; no by-
     *  email index exists, so this bounds to `listContacts` + an in-memory find). */
    findContactByEmail: async (args) => {
      const email = requireStr(args.email, 'email');
      const contact = await ctFindContactByEmail(tenantId, email);
      return { contactId: contact ? contact.contactId : null };
    },

    /** Append a metadata-only Gmail email activity (ADR 0252 §1) — idempotent
     *  by deterministic id, never throws on a bridge failure, and returns the
     *  TYPED outcome (`logged | duplicate | capped | failed`, ADR 0627 D5(b)) the
     *  node keys its cursor + self-pause on (see `gmailSyncService.appendGmailActivity`). */
    logGmailActivity: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const contactId = requireStr(args.contactId, 'contactId');
      const messageId = requireStr(args.messageId, 'messageId');
      const threadId = requireStr(args.threadId, 'threadId');
      const direction = requireStr(args.direction, 'direction');
      if (direction !== 'in' && direction !== 'out') {
        throw new OpenwopError('validation_error', 'direction must be `in` or `out`.', 400, { field: 'direction' });
      }
      const at = requireStr(args.at, 'at');
      // Real link validators (contact must exist) + the cap enforced inside
      // appendGmailActivity — the surfaced verb is no more privileged than the
      // routed logActivity path (ADR 0252 §6 hardening; code-review MEDIUM-4).
      // `origin` (ADR 0617 D1a) — the run's own binding on `activity.logged` is skipped.
      const outcome = await gsAppendGmailActivity(tenantId, orgId, { contactId, messageId, threadId, direction, at }, actor, linkValidators(orgId), { origin });
      return { success: outcome === 'logged' || outcome === 'duplicate', outcome };
    },
  };
}
