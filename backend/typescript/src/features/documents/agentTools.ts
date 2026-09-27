/**
 * ADR 0308 P1/P2 — the agent DELIVERABLE tools: `openwop:documents.draft` and
 * `openwop:email.draft`.
 *
 * Born of a real incident: a board-chat assistant told the user it would "pull
 * a report" and "draft an email" into "our shared document area" — with no tool
 * call and no way to run after the turn ended. These tools make those
 * commitments keepable: the agent composes the content, the tool writes a real
 * DRAFT document through the ONE documents owner (`documentsService` — no
 * parallel store), and the result names the artifact so the agent's sentence is
 * verifiably true.
 *
 * `email.draft` (OQ-1 decided by architect review, 2026-07-07): the email
 * feature has NO one-off message entity (templates → campaigns → send-logs),
 * and vendor-side drafting already has an owner (the `core.email.draft`
 * workflow node — deliberately excluded from chat-tool projection). So an
 * email draft is an `email-draft` KIND of Document (structured To/Subject
 * header + markdown body) — a DISTINCT tool id for allowlist/firewall
 * granularity, same store, same governance. There is deliberately NO send
 * tool: the human reviews the draft and sends via their mail tooling or the
 * `core.email.draft` workflow node.
 *
 * Draft-only · tenant + acting-user scoped · fail-closed:
 *  - the `documents` toggle (the store these WRITE to) is re-checked per call
 *    for the caller's tenant (registration is process-wide; toggles are
 *    per-tenant and dynamic);
 *  - a HUMAN-initiated turn is required (`scope.actingUserId`, the ADR 0024 §4
 *    durable principal) — system runs get a structured refusal, not a write;
 *  - org membership is enforced with the same `resolveEffectiveAccess` scopes
 *    the HTTP routes use (`workspace:write`).
 */
import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { validateAgainstSchema } from '../../aiProviders/aiProvidersHost.js';
import { createDocument, addVersion, getDocumentByIdForTenant, getVersion, listTemplates, getTemplate, assemble } from './documentsService.js';

export const DOCUMENTS_DRAFT_TOOL_ID = 'openwop:documents.draft';
export const EMAIL_DRAFT_TOOL_ID = 'openwop:email.draft';
export const DOCUMENTS_GET_TOOL_ID = 'openwop:documents.get';
export const DOCUMENTS_LIST_TEMPLATES_TOOL_ID = 'openwop:documents.list-templates';
export const DOCUMENTS_GET_TEMPLATE_TOOL_ID = 'openwop:documents.get-template';
export const DOCUMENTS_GENERATE_FROM_TEMPLATE_TOOL_ID = 'openwop:documents.generate-from-template';

/** Structured tool error (the agent loop surfaces `content` verbatim to the model). */
function toolError(error: string, message: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error, message }), isError: true };
}

type ToolResult = { content: string; isError?: boolean };
type ToolError = { content: string; isError: true };
type WriteContext = { orgId: string; actingUserId: string };

/** The shared write gate every documents deliverable/authoring tool shares
 *  (ADR 0308 D2/D3): toggle honesty → acting user → org resolution (never guess
 *  among many) → the SAME org RBAC the HTTP write path enforces
 *  (`featureRoute.requireOrgScope('workspace:write')`). Returns a typed
 *  `ToolError` (verbatim to the model) or the resolved `{orgId, actingUserId}`. */
async function resolveDeliverableWriteContext(
  scope: BundleScope,
  inputOrgId: string | undefined,
): Promise<ToolError | WriteContext> {
  // Toggle honesty: per-tenant, per-call, fail-closed — gated on the store the
  // tool WRITES to.
  const featureOn = await resolveFeatureToggle('documents', scope);
  if (!featureOn) {
    return toolError('feature_disabled', 'The Documents feature is not enabled for this workspace — tell the user you cannot create drafts here.');
  }
  // Deliverables are human-owned: a turn without a durable acting user
  // (system/scheduled runs) must not mint user-facing drafts.
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return toolError('acting_user_required', 'Drafts can only be created from a human-initiated turn.');
  }
  // Org resolution: explicit input, else the workspace's sole org. With
  // several orgs the model must name one — guessing would file the draft
  // into the wrong boundary.
  const orgs = await listOrgs(scope.tenantId);
  const orgId = inputOrgId ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) {
    return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
  }
  if (!orgs.some((o) => o.orgId === orgId)) {
    return toolError('not_found', 'Organization not found in this workspace.');
  }
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes('workspace:write')) {
    return toolError('forbidden_scope', 'The user does not have write access to that organization.');
  }
  return { orgId, actingUserId };
}

type ReadContext = { orgId: string; actingUserId: string };

/** WF-DOC-5 — the shared READ gate (toggle → acting user → org → read scope).
 *  The three read tools each hand-rolled acting-user/org/scope and NONE checked
 *  the `documents` toggle, so a feature-off tenant remained agent-readable via
 *  any allowlisting pack — while the ADR 0315 baseline decision explicitly
 *  leans on "each tool's own toggle checks". Mirror of
 *  `resolveDeliverableWriteContext`, at `workspace:read` (EXACT parity with
 *  `requireOrgScope('workspace:read')` — custom roles don't nest write⊃read). */
async function resolveDocumentsReadContext(
  scope: BundleScope,
  inputOrgId: string | undefined,
  actingUserRefusal: string,
): Promise<ToolError | ReadContext> {
  const featureOn = await resolveFeatureToggle('documents', scope);
  if (!featureOn) {
    return toolError('feature_disabled', 'The Documents feature is not enabled for this workspace — tell the user you cannot read documents here.');
  }
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return toolError('acting_user_required', actingUserRefusal);
  const orgs = await listOrgs(scope.tenantId);
  const orgId = inputOrgId ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\`.`);
  if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes('workspace:read')) {
    return toolError('forbidden_scope', 'The user does not have read access to that organization.');
  }
  return { orgId, actingUserId };
}

/** The `documents.get` half of the read gate: the org comes from the LOOKED-UP
 *  document (not the input), and an out-of-scope org masks as `not_found`
 *  (no cross-org existence leak). Same toggle + acting-user preamble. */
async function resolveDocumentsGetPreamble(scope: BundleScope, actingUserRefusal: string): Promise<ToolError | { actingUserId: string }> {
  const featureOn = await resolveFeatureToggle('documents', scope);
  if (!featureOn) {
    return toolError('feature_disabled', 'The Documents feature is not enabled for this workspace — tell the user you cannot read documents here.');
  }
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return toolError('acting_user_required', actingUserRefusal);
  return { actingUserId };
}

/** The shared deliverable-draft core (ADR 0308 D3): the write gate →
 *  document + first version, agent-provenance-stamped and retry-idempotent. */
async function createDraftDeliverable(
  scope: BundleScope,
  toolId: string,
  input: { title: string; content: string; kind: string; orgId?: string | undefined },
): Promise<ToolResult> {
  const ctx = await resolveDeliverableWriteContext(scope, input.orgId);
  if ('isError' in ctx) return ctx;
  const { orgId, actingUserId } = ctx;

  const producedBy = scope.agentProfileId ? { kind: 'agent' as const, id: scope.agentProfileId } : { kind: 'user' as const, id: actingUserId };
  // Grade-pass fix (GD-0308-1): retries of the IDENTICAL tool call must not mint
  // duplicate drafts. A run-scoped call derives a DETERMINISTIC documentId from
  // its full payload — an exact retry short-circuits in `createDocument` (and
  // `addVersion` dedups on the same key), while a legitimately different draft
  // in the same run (different title/content) hashes to a new id. Surface-direct
  // calls (no runId) keep the random id — there is no retry channel there.
  const draftKey = scope.runId
    ? createHash('sha256').update([scope.runId, toolId, input.kind, orgId, input.title, input.content].join('\u0000')).digest('hex').slice(0, 32)
    : undefined;
  const doc = await createDocument({
    tenantId: scope.tenantId,
    orgId,
    title: input.title,
    kind: input.kind,
    provenance: { producedBy, ...(scope.runId ? { runId: scope.runId } : {}) },
    createdBy: actingUserId,
    ...(draftKey ? { documentId: `doc:${draftKey}` } : {}),
  });
  await addVersion(scope.tenantId, orgId, doc.documentId, {
    content: input.content,
    producedBy,
    ...(draftKey ? { idempotencyKey: draftKey } : {}),
  });
  return {
    content: JSON.stringify({
      documentId: doc.documentId,
      title: doc.title,
      kind: doc.kind,
      status: doc.status,
      location: 'Documents',
      // ADR 0308 P3 — a REAL deep-link (DocumentsPage consumes ?org=&doc= one-shot);
      // also the url to pass to openwop:notifications.notify-me.
      url: `/documents?org=${encodeURIComponent(orgId)}&doc=${encodeURIComponent(doc.documentId)}`,
      note: 'Draft created. Tell the user the exact title and that it is in the Documents area as a draft.',
    }),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** Header fields live on ONE line of the structured draft header — collapse any
 *  model-supplied newlines/runs of whitespace so a multi-line subject can't
 *  break out of the blockquote (or confuse a future send-handoff parser). */
const oneLine = (v: string): string => v.replace(/\s+/g, ' ').trim();

export function registerDocumentsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DOCUMENTS_DRAFT_TOOL_ID,
      description:
        'Create a DRAFT document (report, brief, memo) in the workspace Documents area from markdown you compose. '
        + 'Returns the new documentId + title; tell the user the document title and that it is under Documents. '
        + 'Use this whenever you tell the user you produced a report or document — never claim one exists without calling it. '
        + 'It creates drafts only; it never publishes or shares.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, specific document title.' },
          contentMarkdown: { type: 'string', description: 'The full document body (markdown). Compose it from information you actually have — cited tool results or the conversation; never invent data.' },
          kind: { type: 'string', description: "Optional document kind, e.g. 'report' (default), 'brief', 'memo'." },
          orgId: { type: 'string', description: 'Target organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['title', 'contentMarkdown'],
      },
    },
    async run(input, scope) {
      const title = str(input.title);
      const content = str(input.contentMarkdown);
      if (!title || !content) return toolError('validation_error', '`title` and `contentMarkdown` are required.');
      return createDraftDeliverable(scope, DOCUMENTS_DRAFT_TOOL_ID, {
        title,
        content,
        kind: optStr(input.kind) ?? 'report',
        orgId: optStr(input.orgId),
      });
    },
  });

  // ADR 0308 P2 — the email draft. Never sends; see the module header for the
  // OQ-1 ownership rationale (an `email-draft` Document, not an email entity).
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: EMAIL_DRAFT_TOOL_ID,
      description:
        'Draft an EMAIL for the user to review and send themselves — it is saved as an "email draft" document '
        + 'in the workspace Documents area (To/Subject header + body). This NEVER sends anything. '
        + 'Returns the documentId + title; tell the user the draft title, that it is under Documents, and that '
        + 'sending is theirs to do after review. Use this whenever you tell the user you drafted an email — '
        + 'never claim a draft exists without calling it.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Optional intended recipients, comma-separated (people or teams as the user named them).' },
          subject: { type: 'string', description: 'The email subject line.' },
          bodyMarkdown: { type: 'string', description: 'The email body (markdown). Compose it from information you actually have; never invent facts.' },
          orgId: { type: 'string', description: 'Target organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['subject', 'bodyMarkdown'],
      },
    },
    async run(input, scope) {
      const subject = oneLine(str(input.subject));
      const body = str(input.bodyMarkdown);
      if (!subject || !body) return toolError('validation_error', '`subject` and `bodyMarkdown` are required.');
      const rawTo = optStr(input.to);
      const to = rawTo ? oneLine(rawTo) : undefined;
      // Structured header the human (and a future send-handoff) can read; the
      // body stays plain markdown below it.
      const content = [
        `> **Email draft** — review, then send with your mail tooling.`,
        `>`,
        ...(to ? [`> **To:** ${to}`] : []),
        `> **Subject:** ${subject}`,
        '',
        body,
      ].join('\n');
      return createDraftDeliverable(scope, EMAIL_DRAFT_TOOL_ID, {
        title: subject,
        content,
        kind: 'email-draft',
        orgId: optStr(input.orgId),
      });
    },
  });

  // XCH-DOCS-1 (LLM-EXCHANGE-AUDIT Wave 4) — the READ side documents.draft
  // never had: an agent can now read a document it (or the user) just drafted
  // instead of blind re-authoring, and see which templates exist.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DOCUMENTS_GET_TOOL_ID,
      description:
        'Read ONE workspace document by id: title, kind, and the full markdown body. Use it to review or revise '
        + 'an existing document (including drafts you created) instead of re-authoring from memory. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'The document id (from documents.draft, a listing, or the user).' },
        },
        required: ['documentId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const documentId = str(input.documentId);
      if (!documentId) return toolError('validation_error', '`documentId` is required.');
      // WF-DOC-5 — shared preamble (toggle + acting user); the org check stays
      // below because it derives from the looked-up document.
      const pre = await resolveDocumentsGetPreamble(scope, 'Document reads run on behalf of a signed-in user.');
      if ('isError' in pre) return pre;
      const { actingUserId } = pre;
      const doc = await getDocumentByIdForTenant(scope.tenantId, documentId);
      if (!doc) return toolError('not_found', 'No such document in this workspace.');
      // Same boundary as the HTTP read path: the acting user needs read scope
      // on the document's org (no cross-org existence leak). EXACT scope
      // parity with requireOrgScope('workspace:read') — custom roles don't
      // nest write⊃read (grade-pass finding, 2026-07-15).
      const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId: doc.orgId });
      if (!access.scopes.includes('workspace:read')) {
        return toolError('not_found', 'No such document in this workspace.');
      }
      // The body lives on the CURRENT VERSION, not the record (same read the
      // resolver seam performs).
      const current = doc.currentVersionId
        ? await getVersion(scope.tenantId, doc.orgId, doc.documentId, doc.currentVersionId)
        : null;
      return {
        content: JSON.stringify({
          documentId: doc.documentId,
          title: doc.title,
          kind: doc.kind,
          orgId: doc.orgId,
          status: doc.status,
          content: current?.content ?? '',
          updatedAt: doc.updatedAt,
        }),
      };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: DOCUMENTS_LIST_TEMPLATES_TOOL_ID,
      description:
        'List the workspace\'s document templates (id, name, kind, whether a structured output schema is declared). '
        + 'Check this before generating a templated document so you target a template that actually exists. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Target organization id — only needed when the workspace has more than one organization.' },
          kind: { type: 'string', description: 'Optional template kind filter.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // WF-DOC-5 — the shared read gate (toggle + acting user + org + scope).
      const ctx = await resolveDocumentsReadContext(scope, optStr(input.orgId), 'Template reads run on behalf of a signed-in user.');
      if ('isError' in ctx) return ctx;
      const { orgId } = ctx;
      const templates = await listTemplates(scope.tenantId, orgId, optStr(input.kind));
      return {
        content: JSON.stringify({
          templates: templates.map((t) => ({
            templateId: t.templateId,
            name: t.name,
            ...(t.kind ? { kind: t.kind } : {}),
            hasOutputSchema: !!t.outputSchema,
          })),
        }),
      };
    },
  });

  // C2 (chat-first port) — the READ companion of generate-from-template: an
  // agent reads a template's instructions + required parameters BEFORE authoring
  // (the ADR 0358 read-before-write contract). Reuses the SAME getTemplate seam
  // the node/routes use; same read RBAC as the HTTP path.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: DOCUMENTS_GET_TEMPLATE_TOOL_ID,
      description:
        'Read ONE document template by id: its name, kind, output format, generator instructions (promptBody), '
        + 'and the parameters it requires. Call this before generate-from-template so you author to the template\'s '
        + 'actual instructions and supply every required parameter. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: 'The template id (from documents.list-templates).' },
          orgId: { type: 'string', description: 'Target organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['templateId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const templateId = str(input.templateId);
      if (!templateId) return toolError('validation_error', '`templateId` is required.');
      // WF-DOC-5 — the shared read gate (toggle + acting user + org + scope).
      const ctx = await resolveDocumentsReadContext(scope, optStr(input.orgId), 'Template reads run on behalf of a signed-in user.');
      if ('isError' in ctx) return ctx;
      const { orgId } = ctx;
      const tmpl = await getTemplate(scope.tenantId, orgId, templateId);
      if (!tmpl) return toolError('not_found', 'No such template in this workspace.');
      return {
        content: JSON.stringify({
          templateId: tmpl.templateId,
          name: tmpl.name,
          kind: tmpl.kind,
          outputFormat: tmpl.outputFormat,
          promptBody: tmpl.promptBody,
          parameters: tmpl.parameters,
          hasOutputSchema: !!tmpl.outputSchema,
        }),
      };
    },
  });

  // C2 (chat-first port) — igniting feature.documents.nodes.generate-from-template
  // as a conversational tool. The chat agent IS the author (no nested ctx.callAI
  // like the run-scoped node): it composes the body, and this tool runs the REAL
  // node logic that is deterministic and provider-free — `assemble` VALIDATES the
  // supplied params against the template's required-params contract (a missing
  // param comes back as a typed validation_error → the loop's one bounded repair)
  // and resolves the template's kind/output-format — then persists through the ONE
  // documents owner with the template stamped, exactly as the node does.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DOCUMENTS_GENERATE_FROM_TEMPLATE_TOOL_ID,
      description:
        'Generate a DRAFT document FROM A TEMPLATE: you compose the body (markdown) following the template\'s '
        + 'instructions, and this saves it as a durable draft stamped with the template, its kind, and its output format. '
        + 'First read the template with documents.get-template so you supply every required parameter and follow its '
        + 'instructions. Returns the new documentId + title; tell the user the title and that it is under Documents as a '
        + 'draft. It creates drafts only; it never publishes or sends. A validation error (e.g. a missing required '
        + 'parameter) comes back to you verbatim — fix it and call again.',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: 'The template id to generate from (from documents.list-templates / get-template).' },
          params: { type: 'object', description: 'The template parameters (the `{{name}}` values). Must include every parameter the template marks required.', additionalProperties: true },
          contentMarkdown: { type: 'string', description: 'The full document body you composed (markdown), following the template\'s instructions and parameters. Never invent data.' },
          title: { type: 'string', description: 'Optional document title (defaults to the template name).' },
          orgId: { type: 'string', description: 'Target organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['templateId', 'contentMarkdown'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const templateId = str(input.templateId);
      const content = str(input.contentMarkdown);
      if (!templateId || !content) return toolError('validation_error', '`templateId` and `contentMarkdown` are required.');
      const params: Record<string, unknown> = (input.params && typeof input.params === 'object' && !Array.isArray(input.params))
        ? (input.params as Record<string, unknown>)
        : {};

      const ctx = await resolveDeliverableWriteContext(scope, optStr(input.orgId));
      if ('isError' in ctx) return ctx;
      const { orgId, actingUserId } = ctx;

      const tmpl = await getTemplate(scope.tenantId, orgId, templateId);
      if (!tmpl) return toolError('not_found', 'No such template in this workspace.');
      // Run the REAL node validation: assemble enforces the template's
      // required-params contract (closed-world). A defect is a TYPED error the
      // agent repairs — never success-with-empty.
      let asm: Awaited<ReturnType<typeof assemble>>;
      try {
        asm = await assemble(scope.tenantId, orgId, templateId, params);
      } catch (err) {
        if (err instanceof OpenwopError && err.code === 'validation_error') {
          return toolError('validation_error', err.message);
        }
        throw err;
      }

      // `DOCWF-1` — ENFORCE the template's `outputSchema` on this lane.
      //
      // `FEATURES.md` and this pack both advertise "validates output against a template-owned
      // `outputSchema`", and this tool did not: it read the schema only to report
      // `hasOutputSchema: true` back to the model (`get-template`, above) and then discarded it,
      // persisting `contentMarkdown` verbatim. So the model was TOLD a contract existed and it
      // was never applied — worse than silence, because an agent can reasonably rely on being
      // checked. The node lane that does enforce it has no consumer: no chain in `examples/`
      // references any `feature.documents.nodes.*` typeId, so the enforcing lane was unreachable
      // while the reachable lane had no contract.
      //
      // Shape follows the param check ~20 lines above, which is the precedent in this same
      // function: a defect is a TYPED error carrying the reason, which the agent loop's ONE
      // bounded repair feeds back. Never success-with-empty, and never a silent pass.
      if (asm.outputSchema) {
        let parsed: unknown;
        try {
          // A schema-bound template promises structured output; the model may fence it.
          parsed = JSON.parse(content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
        } catch {
          return toolError(
            'validation_error',
            'This template declares an `outputSchema`, so `contentMarkdown` must be a JSON object matching it. It did not parse as JSON.',
          );
        }
        if (!validateAgainstSchema(parsed, asm.outputSchema)) {
          const required = Array.isArray((asm.outputSchema as { required?: unknown }).required)
            ? ((asm.outputSchema as { required: string[] }).required).join(', ')
            : '(none declared)';
          return toolError(
            'validation_error',
            `The generated content does not satisfy this template's \`outputSchema\`. Required keys: ${required}. Re-generate with every required key present.`,
          );
        }
      }

      const title = optStr(input.title) ?? tmpl.name;
      const producedBy = scope.agentProfileId ? { kind: 'agent' as const, id: scope.agentProfileId } : { kind: 'user' as const, id: actingUserId };
      // Deterministic idempotency (parity with createDraftDeliverable + the
      // node's `${runId}:${nodeId}` key): an exact retry in the same run reuses
      // the same document + version; a different draft hashes anew.
      const draftKey = scope.runId
        ? createHash('sha256').update([scope.runId, DOCUMENTS_GENERATE_FROM_TEMPLATE_TOOL_ID, templateId, orgId, title, content].join('\u0000')).digest('hex').slice(0, 32)
        : undefined;
      const doc = await createDocument({
        tenantId: scope.tenantId,
        orgId,
        title,
        kind: tmpl.kind,
        format: asm.outputFormat,
        templateId,
        provenance: { producedBy, ...(scope.runId ? { runId: scope.runId } : {}) },
        createdBy: actingUserId,
        ...(draftKey ? { documentId: `doc:${draftKey}` } : {}),
      });
      await addVersion(scope.tenantId, orgId, doc.documentId, {
        content,
        producedBy,
        ...(draftKey ? { idempotencyKey: draftKey } : {}),
      });
      return {
        content: JSON.stringify({
          documentId: doc.documentId,
          title: doc.title,
          kind: doc.kind,
          format: doc.format,
          templateId,
          status: doc.status,
          location: 'Documents',
          url: `/documents?org=${encodeURIComponent(orgId)}&doc=${encodeURIComponent(doc.documentId)}`,
          note: 'Draft created from the template. Tell the user the exact title and that it is in the Documents area as a draft.',
        }),
      };
    },
  });
}
