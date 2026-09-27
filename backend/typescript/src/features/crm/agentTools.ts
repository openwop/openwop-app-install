/**
 * CRM chat tools (CFP-1 repair; ADR 0308 D2 seam) — the sales-ops + segment-
 * author personas' REAL grounding + governed writes over the CRM surface.
 *
 * Born of the CHAT-FIRST-PORT-AUDIT #1 finding (docs/chat-first-port/
 * d1-crm-csm.md): the `feature.crm.agents` pack allowlisted node typeIds
 * (`openwop:feature.crm.nodes.{list-companies,get-company,list-deals,get-deal,
 * list-tasks,log-activity,create-task,list-segment-members,persist-segment}`)
 * that NO host registrant provided, so `compileAgentTools` silently dropped
 * them and both personas ran in the ONE chat with zero tools — answering CRM
 * questions from hallucinated data. These nodes are SURFACE-backed (they
 * require `ctx.features.crm`), not pure compute, so the node-projection lane
 * (`PROJECTABLE_COMPUTE_NODE_TYPE_IDS`) is the wrong lane by construction — that
 * lane stays reserved for the two PURE segment nodes (`segment-vocabulary`,
 * `validate-segment`, which resolve there). This bridges the CRM SURFACE into
 * chat via the sanctioned `registerFeatureAgentTool` seam, the same path
 * campaign-intel / goals / app-builder use.
 *
 * Authority parity: every tool builds `ctx.features.crm` (buildCrmSurface) — the
 * SAME adapter the routes and workflow nodes call, so agent/route/node writes
 * are indistinguishable to the audit trail. Org-scoped tools share the routes'
 * `orgScopeGranted` predicate (routes.ts) — the SAME `resolveEffectiveAccess`
 * check; reads need `workspace:read`, writes `workspace:write`. Read tools FAIL
 * EMPTY without an acting user (the goals / kicktodo precedent — a scheduled/
 * system turn with no human principal must not enumerate a workspace's book of
 * business); action tools FAIL TYPED. Invalid MODEL input is a TYPED error the
 * agent loop repairs from (never success-with-empty). Toggle honesty lives in
 * each `run` (per-tenant dynamic; disabled ⇒ typed `feature_disabled`). Segment
 * persist rides the surface's closed-world re-validate-then-persist gate (a
 * non-valid draft is refused WITHOUT a write). Governed high-blast-radius writes
 * (create contact/company/deal, move stage, convert lead) are DELIBERATELY not
 * here — those ride the crm-ops chain behind a human approval gate (ADR 0208
 * §2), unchanged.
 *
 * @see docs/chat-first-port/d1-crm-csm.md
 * @see docs/adr/0208-crm-governed-writes.md
 * @see docs/adr/0265-cdp-segment-author.md
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { toolFailLog } from '../../host/agentToolKit.js';
import { createLogger } from '../../observability/logger.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { assertTenantScope, type Scope } from '../../host/accessControlService.js';
import { checkTenantEntitlement } from '../../host/entitlementSeam.js';
import { OpenwopError } from '../../types.js';
import { buildCrmSurface } from './surface.js';
import { ensureContact } from './contactsService.js';
import { orgScopeGranted } from './routes.js';

const TOGGLE_ID = 'crm';
const log = createLogger('crm.agent-tools');

/** ADR 0470 — the anon lead-intake tool id. */
export const CRM_LEAD_CAPTURE_TOOL_ID = 'openwop:crm.lead.capture';
/** A pragmatic email shape gate (not an RFC 5322 validator — that over-rejects real
 *  addresses). Requires a local part, an `@`, a dotted domain, no spaces. The tool
 *  fails TYPED on a miss so the agent asks the visitor to re-enter. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CRM_LIST_COMPANIES_TOOL_ID = 'openwop:feature.crm.nodes.list-companies';
export const CRM_GET_COMPANY_TOOL_ID = 'openwop:feature.crm.nodes.get-company';
export const CRM_LIST_DEALS_TOOL_ID = 'openwop:feature.crm.nodes.list-deals';
export const CRM_GET_DEAL_TOOL_ID = 'openwop:feature.crm.nodes.get-deal';
export const CRM_LIST_TASKS_TOOL_ID = 'openwop:feature.crm.nodes.list-tasks';
export const CRM_LOG_ACTIVITY_TOOL_ID = 'openwop:feature.crm.nodes.log-activity';
export const CRM_CREATE_TASK_TOOL_ID = 'openwop:feature.crm.nodes.create-task';
export const CRM_LIST_SEGMENT_MEMBERS_TOOL_ID = 'openwop:feature.crm.nodes.list-segment-members';
export const CRM_PERSIST_SEGMENT_TOOL_ID = 'openwop:feature.crm.nodes.persist-segment';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const isResult = <T extends object>(v: T | ToolResult): v is ToolResult => 'content' in v;

/** CFPT-5 — the default row cap for the unbounded list reads. These surface
 *  methods return the WHOLE org slice; a large workspace could blow the model's
 *  context window with one call, so the tool bounds the array it hands back. */
const LIST_CAP = 50;

/** Slice a list-read result's named array to at most `LIST_CAP` rows, stamping
 *  `truncated:true` when rows were dropped so the model knows the view is partial
 *  (and can narrow with a filter). Non-array / already-bounded results pass through. */
function capList<T extends Record<string, unknown>>(result: T, key: keyof T & string): T & { truncated?: boolean } {
  const rows = result[key];
  if (!Array.isArray(rows) || rows.length <= LIST_CAP) return result;
  return { ...result, [key]: rows.slice(0, LIST_CAP), truncated: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant + per-user, dynamic,
 *  fail-closed — resolves against the SAME `{tenantId, userId}` subject the
 *  routes' `subjectOf` builds, so a beta/cohort narrowing can't drift. */
async function crmEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne(TOGGLE_ID, { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/**
 * The shared org-scope gate every org-scoped CRM tool runs first. Returns the
 * narrowed `{ orgId, actingUserId }` on success, or a `ToolResult` the caller
 * returns verbatim:
 *  - toggle off ⇒ typed `feature_disabled`;
 *  - no acting user ⇒ `onNoUser` (reads pass an EMPTY result; writes a typed error);
 *  - missing `orgId` ⇒ typed `org_required` (invalid model input);
 *  - not authorized ⇒ typed `forbidden_scope` (via the routes' predicate).
 */
async function orgGate(
  scope: BundleScope,
  orgIdInput: unknown,
  opts: { scope: Scope; onNoUser: ToolResult },
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  if (!(await crmEnabled(scope.tenantId, scope.actingUserId))) {
    return toolError('feature_disabled', 'CRM is not enabled for this workspace — tell the user you cannot read or update CRM here.');
  }
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return opts.onNoUser; // no human principal.
  const orgId = str(orgIdInput);
  if (!orgId) return toolError('org_required', 'Pass the `orgId` of the workspace whose CRM to read or update.');
  if (!(await orgScopeGranted(scope.tenantId, actingUserId, orgId, opts.scope))) {
    return toolError('forbidden_scope', 'The user does not have that access to the organization.', { requiredScope: opts.scope, orgId });
  }
  return { orgId, actingUserId };
}

/** Tenant-scoped gate for the segment tools (segments are tenant-wide, no org —
 *  the segment routes are tenant-scoped). ADR 0627 D3 (CRM-6): the SAME
 *  predicate the tenant-lane routes run — toggle, the ADR 0419 entitlement, an
 *  acting user, and `workspace:write` via the req-less `assertTenantScope`
 *  (ADR 0617 D2). `personalTenant` is the REQUEST's `personalTenantOf(req)` —
 *  the same source of truth `isOwnPersonalWorkspace` reads on the HTTP lane —
 *  stamped on `run.metadata.personalTenant` at run creation (`routes/runs.ts`)
 *  and threaded onto the tool scope by the conversation tool loop exactly like
 *  `actingUserId`. It is honoured ONLY for a `user:`/`anon:`-shaped tenant
 *  (USERS-19, inside `assertTenantScope`), so a member of a shared `ws:`
 *  workspace is judged by their membership scopes. Review S2 of the D3 build:
 *  the first cut RE-DERIVED it from `getUser(actingUserId)?.tenantId`, and an
 *  anon session's principal is `session:<sid>` with no user row — so the two
 *  segment tools refused the caller inside their OWN `anon:<sid>` sandbox while
 *  the HTTP lane granted it. Never re-derive: read what the request stamped. */
async function tenantGate(scope: BundleScope, onNoUser: ToolResult): Promise<{ actingUserId: string } | ToolResult> {
  if (!(await crmEnabled(scope.tenantId, scope.actingUserId))) {
    return toolError('feature_disabled', 'CRM is not enabled for this workspace — tell the user you cannot author segments here.');
  }
  if (!scope.actingUserId) return onNoUser;
  try {
    await checkTenantEntitlement(scope.tenantId, TOGGLE_ID);
    await assertTenantScope(scope.tenantId, scope.actingUserId, 'workspace:write', { ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) });
  } catch (err) {
    return surfaceError(err);
  }
  return { actingUserId: scope.actingUserId };
}

/** Map an OpenwopError thrown by the surface (not_found / validation) to a typed
 *  tool error the agent loop can act on; anything else is a generic failure. */
function surfaceError(err: unknown): ToolResult {
  if (err instanceof OpenwopError) return toolError(err.code, err.message, err.details ?? undefined);
  return toolFailLog(log, 'openwop:crm', err); // CFPT-6 — log the unexpected failure, return typed tool_failed
}

export function registerCrmAgentTools(): void {
  // ── Reads (org-scoped, workspace:read; fail EMPTY without a user) ──────────

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_LIST_COMPANIES_TOOL_ID,
      description:
        "List an organization's CRM companies from ACTUAL app state. Use it before answering questions about accounts; "
        + 'never invent a company name or domain. Optional `q` filters by name. Returns { companies } (capped at 50 rows; '
        + '`truncated:true` when the org has more — narrow with `q`). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization whose companies to list.' },
          q: { type: 'string', description: 'Optional case-insensitive name filter.' },
        },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await orgGate(scope, input.orgId, { scope: 'workspace:read', onNoUser: { content: JSON.stringify({ companies: [] }) } });
      if (isResult(gate)) return gate;
      try {
        return { content: JSON.stringify(capList(await buildCrmSurface(scope).listCompanies!({ orgId: gate.orgId, ...(str(input.q) ? { q: str(input.q) } : {}) }), 'companies')) };
      } catch (err) { return surfaceError(err); }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_GET_COMPANY_TOOL_ID,
      description:
        'Fetch one CRM company by id. Use it to ground an answer about a specific account. Returns { company } (null when '
        + 'absent or out of the user\'s territory). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization the company belongs to.' },
          companyId: { type: 'string', description: 'The company id.' },
        },
        required: ['orgId', 'companyId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await orgGate(scope, input.orgId, { scope: 'workspace:read', onNoUser: { content: JSON.stringify({ company: null }) } });
      if (isResult(gate)) return gate;
      const companyId = str(input.companyId);
      if (!companyId) return toolError('validation_error', 'Pass the `companyId` to fetch.', { field: 'companyId' });
      try {
        return { content: JSON.stringify(await buildCrmSurface(scope).getCompany!({ orgId: gate.orgId, companyId })) };
      } catch (err) { return surfaceError(err); }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_LIST_DEALS_TOOL_ID,
      description:
        "List an organization's CRM deals from ACTUAL app state, optionally filtered by pipeline, stage, company, or a name "
        + 'query. Use it before answering pipeline/deal questions; never invent an amount or stage. Returns { deals } (capped at '
        + '50 rows; `truncated:true` when more exist — narrow with a filter). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization whose deals to list.' },
          pipelineId: { type: 'string', description: 'Optional — scope to one pipeline.' },
          stageId: { type: 'string', description: 'Optional — scope to one stage.' },
          companyId: { type: 'string', description: 'Optional — scope to one company.' },
          q: { type: 'string', description: 'Optional case-insensitive title filter.' },
        },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await orgGate(scope, input.orgId, { scope: 'workspace:read', onNoUser: { content: JSON.stringify({ deals: [] }) } });
      if (isResult(gate)) return gate;
      const args: Record<string, unknown> = { orgId: gate.orgId };
      for (const k of ['pipelineId', 'stageId', 'companyId', 'q'] as const) if (str(input[k])) args[k] = str(input[k]);
      try {
        return { content: JSON.stringify(capList(await buildCrmSurface(scope).listDeals!(args), 'deals')) };
      } catch (err) { return surfaceError(err); }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_GET_DEAL_TOOL_ID,
      description:
        'Fetch one CRM deal by id (stage, amount, owner, links). Use it to ground an answer about a specific deal. Returns '
        + '{ deal } (null when absent or out of territory). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization the deal belongs to.' },
          dealId: { type: 'string', description: 'The deal id.' },
        },
        required: ['orgId', 'dealId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await orgGate(scope, input.orgId, { scope: 'workspace:read', onNoUser: { content: JSON.stringify({ deal: null }) } });
      if (isResult(gate)) return gate;
      const dealId = str(input.dealId);
      if (!dealId) return toolError('validation_error', 'Pass the `dealId` to fetch.', { field: 'dealId' });
      try {
        return { content: JSON.stringify(await buildCrmSurface(scope).getDeal!({ orgId: gate.orgId, dealId })) };
      } catch (err) { return surfaceError(err); }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_LIST_TASKS_TOOL_ID,
      description:
        "List an organization's CRM tasks, optionally by status (open/doing/done) or linked deal. Use it to see follow-ups "
        + 'before answering or drafting one. Returns { tasks } (capped at 50 rows; `truncated:true` when more exist — narrow '
        + 'with `status` or `dealId`). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization whose tasks to list.' },
          status: { type: 'string', description: 'Optional status filter (e.g. open, doing, done).' },
          dealId: { type: 'string', description: 'Optional — scope to one deal.' },
        },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await orgGate(scope, input.orgId, { scope: 'workspace:read', onNoUser: { content: JSON.stringify({ tasks: [] }) } });
      if (isResult(gate)) return gate;
      const args: Record<string, unknown> = { orgId: gate.orgId };
      for (const k of ['status', 'dealId'] as const) if (str(input[k])) args[k] = str(input[k]);
      try {
        return { content: JSON.stringify(capList(await buildCrmSurface(scope).listTasks!(args), 'tasks')) };
      } catch (err) { return surfaceError(err); }
    },
  });

  // ── Assistive writes (org-scoped, workspace:write; fail TYPED without a user) ─

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_LOG_ACTIVITY_TOOL_ID,
      description:
        "Append a note/call/email/meeting to a deal, contact, or company's timeline (append-only — you cannot edit or "
        + 'remove a logged activity). Confirm back to the user what you recorded. Returns { success, activity }.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization the record belongs to.' },
          kind: { type: 'string', description: 'One of note, call, email, meeting.' },
          body: { type: 'string', description: 'The activity body text.' },
          dealId: { type: 'string', description: 'Optional — the deal to append to.' },
          contactId: { type: 'string', description: 'Optional — the contact to append to.' },
          companyId: { type: 'string', description: 'Optional — the company to append to.' },
        },
        required: ['orgId', 'kind', 'body'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await orgGate(scope, input.orgId, { scope: 'workspace:write', onNoUser: toolError('acting_user_required', 'Logging an activity needs a human-initiated turn.') });
      if (isResult(gate)) return gate;
      const kind = str(input.kind);
      const body = str(input.body);
      if (!kind) return toolError('validation_error', 'Pass the activity `kind` (note, call, email, or meeting).', { field: 'kind' });
      if (!body) return toolError('validation_error', 'Pass the activity `body`.', { field: 'body' });
      const args: Record<string, unknown> = { orgId: gate.orgId, kind, body };
      for (const k of ['dealId', 'contactId', 'companyId'] as const) if (str(input[k])) args[k] = str(input[k]);
      try {
        return { content: JSON.stringify(await buildCrmSurface(scope).logActivity!(args)) };
      } catch (err) { return surfaceError(err); }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_CREATE_TASK_TOOL_ID,
      description:
        'Draft a follow-up task (title, optional due date, optional linked deal). Confirm back to the user what you drafted. '
        + 'Returns { success, task }.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization to create the task in.' },
          title: { type: 'string', description: 'The task title.' },
          dueDate: { type: 'string', description: 'Optional ISO due date.' },
          dealId: { type: 'string', description: 'Optional — the deal to link the task to.' },
        },
        required: ['orgId', 'title'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await orgGate(scope, input.orgId, { scope: 'workspace:write', onNoUser: toolError('acting_user_required', 'Creating a task needs a human-initiated turn.') });
      if (isResult(gate)) return gate;
      const title = str(input.title);
      if (!title) return toolError('validation_error', 'Pass the task `title`.', { field: 'title' });
      const args: Record<string, unknown> = { orgId: gate.orgId, title };
      for (const k of ['dueDate', 'dealId'] as const) if (str(input[k])) args[k] = str(input[k]);
      try {
        return { content: JSON.stringify(await buildCrmSurface(scope).createTask!(args)) };
      } catch (err) { return surfaceError(err); }
    },
  });

  // ── ADR 0470 — anonymous lead capture (ANON-EXCLUSIVE; the non-deliverable
  //    write that makes the ADR 0469 anon write tier real) ─────────────────────

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_LEAD_CAPTURE_TOOL_ID,
      description:
        'Capture an anonymous website visitor as a CRM lead so a HUMAN can follow up. Call this ONLY after the visitor has '
        + 'VOLUNTARILY given their email AND you have told them a person from the team may follow up. Pass their `email` '
        + '(required); include `name` and a short `note` of what they want ONLY if they gave them. Do NOT invent any detail, and '
        + 'NEVER promise or imply a price, discount, refund, availability, or any commitment — this tool ONLY records contact '
        + 'details for a human to follow up. On success, tell the visitor their details were passed to the team and roughly when '
        + 'to expect a reply. Returns { success }.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: "The visitor's email address (required, must be a real address they gave you)." },
          name: { type: 'string', description: "The visitor's name — ONLY if they provided it (optional)." },
          note: { type: 'string', description: 'A short note of what the visitor wants help with — ONLY from what they said (optional).' },
        },
        required: ['email'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // ANON-EXCLUSIVE (ADR 0470 boundary): authenticated contact-creation stays on
      // the ADR 0208 governed CRM-write chain (a human-approval gate). This tool would
      // otherwise let a signed-in agent bypass that, so it runs ONLY without an acting
      // user — the INVERSE of the ADR 0308 deliverable gate. On the anon path
      // (`actingUserId` undefined) it is itself gated by the ADR 0469 hold/auto tier.
      if (scope.actingUserId) {
        return toolError('use_governed_write', 'Creating a CRM contact from a signed-in turn goes through the governed CRM write, not this tool.');
      }
      if (!(await crmEnabled(scope.tenantId, undefined))) {
        return toolError('feature_disabled', 'CRM is not enabled for this workspace — you cannot capture a lead here.');
      }
      const email = str(input.email);
      if (!email || !EMAIL_RE.test(email)) {
        return toolError('validation_error', 'Ask the visitor for a valid email address (name@example.com) before capturing their details.', { field: 'email' });
      }
      const name = str(input.name);
      try {
        // `actor` is the audit row's principal — the widget lane has no human, so
        // it is named as the lane (the `public:guest` / `system:<lane>` shape).
        const contact = await ensureContact({ tenantId: scope.tenantId, email, ...(name ? { name } : {}), leadSource: 'anon-widget', actor: 'public:anon-widget' });
        if (!contact) return toolError('validation_error', 'A valid email is required to capture a lead.', { field: 'email' });
        // Result boundary: opaque `contactId` + success ONLY — NEVER echo the email or
        // any PII back to the model/visitor (RFC 0048 / the anon no-PII-echo posture).
        return { content: JSON.stringify({ success: true, contactId: contact.contactId, message: 'Lead captured — a team member will follow up.' }) };
      } catch (err) { return surfaceError(err); }
    },
  });

  // ── Segment author (tenant-scoped; the draft→validate→persist trio's last two
  //    legs — vocabulary + validate are the PURE projected nodes) ─────────────

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_LIST_SEGMENT_MEMBERS_TOOL_ID,
      description:
        "Preview a SAVED segment's live membership (evaluated at read against the tenant rolodex; never materialized). Use it "
        + "to sanity-check a segment's reach before or after saving. Returns { members } (capped at 50 rows; `truncated:true` "
        + 'when the segment reaches more). Read-only.',
      inputSchema: {
        type: 'object',
        properties: { segmentId: { type: 'string', description: 'The saved segment id to preview.' } },
        required: ['segmentId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await tenantGate(scope, { content: JSON.stringify({ members: [] }) });
      if (isResult(gate)) return gate;
      const segmentId = str(input.segmentId);
      if (!segmentId) return toolError('validation_error', 'Pass the saved `segmentId` to preview.', { field: 'segmentId' });
      try {
        return { content: JSON.stringify(capList(await buildCrmSurface(scope).listSegmentMembers!({ segmentId }), 'members')) };
      } catch (err) { return surfaceError(err); }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CRM_PERSIST_SEGMENT_TOOL_ID,
      description:
        'Save a VALIDATED customer segment (`{ name, filters }`). The host RE-VALIDATES closed-world and REFUSES an invalid '
        + 'draft WITHOUT writing (returns { success:false, errors } — fix the draft from `segment-vocabulary` and retry). '
        + 'Only call this after the user explicitly confirms. A saved segment is an inert filter until wired to activation. '
        + 'Returns { success, segment } | { success:false, errors }.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A clear, human-readable segment name.' },
          filters: {
            type: 'array',
            description: 'The validated filter set: [{ field, op, value }, …] — every field/op from segment-vocabulary.',
            items: { type: 'object', additionalProperties: true },
          },
          segmentId: { type: 'string', description: 'Optional explicit `seg:`-prefixed id (idempotent overwrite).' },
        },
        required: ['name', 'filters'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await tenantGate(scope, toolError('acting_user_required', 'Saving a segment needs a human-initiated turn.'));
      if (isResult(gate)) return gate;
      const name = str(input.name);
      if (!name) return toolError('validation_error', 'Pass a segment `name`.', { field: 'name' });
      if (!Array.isArray(input.filters)) return toolError('validation_error', '`filters` MUST be an array of { field, op, value }.', { field: 'filters' });
      try {
        const out = await buildCrmSurface(scope).persistSegment!({ name, filters: input.filters, ...(str(input.segmentId) ? { segmentId: str(input.segmentId) } : {}) });
        // The surface's closed-world gate returns { success:false, errors } for an
        // invalid draft WITHOUT writing — surface it as isError so the agent loop
        // repairs (the draft→validate→persist error-feedback contract).
        return { content: JSON.stringify(out), ...(out.success === false ? { isError: true } : {}) };
      } catch (err) { return surfaceError(err); }
    },
  });
}
