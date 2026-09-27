/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1, port map E5) — the Email Copywriter's REAL
 * chat tools (the ADR 0308 deliverable-tool precedent, the ADR 0358 app-builder
 * `get-design`/`render` shape applied to email copywriting).
 *
 * The audit finding: the copywriter agent pack allowlisted node typeIds
 * (`openwop:feature.email.nodes.list-templates|render`) that NO host registrant
 * projects into the chat tool loop, so `filterTools` silently dropped them
 * (`agentDispatch.ts`) and the agent chatted on the generic baseline with zero
 * email tools — it could neither read existing drafts nor persist the copy it
 * wrote. These two tools make the exchange real, and are gated exactly like the
 * email HTTP routes (`routes.ts` `authz`: per-tenant `email` toggle → org RBAC):
 *
 *  - `openwop:email.get-campaign` — the model READS a DRAFT campaign (+ the
 *    template it references), or lists the org's drafts + templates, so it
 *    grounds in what exists before authoring (read-before-write). A read tool:
 *    it fails EMPTY without an acting user (tenant rows never leak to a system
 *    turn), and fails EMPTY (not error) on a missing id.
 *  - `openwop:email.save-draft` — the model PERSISTS the copy it drafted into a
 *    DRAFT template + DRAFT campaign through the owning `emailService`
 *    (`createTemplate`/`createCampaign`, both idempotent on deterministic ids),
 *    or updates the copy of an existing DRAFT campaign's template. It NEVER
 *    sends: `sendCampaign` (the consent-gated, suppression-checked fan-out)
 *    stays a deliberate human page action / the campaign-channels workflow path.
 *    A write tool: closed-world validation → typed `isError` the agent loop
 *    feeds back as its repair loop, never success-with-empty.
 *
 * Clean `openwop:email.*` ids (the documents/app-builder convention), NOT the
 * node-typeId-shaped ids the pack used to allowlist: the old ids never resolved,
 * so nothing depends on them, and the node-projection namespace stays
 * unambiguous.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { checkTenantEntitlement } from '../../host/entitlementSeam.js';
import { resolveReadOrgScope, resolveActionOrgScope, toolEmpty } from '../../host/agentToolKit.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { createHash } from 'node:crypto';
import {
  listTemplates, getTemplate, createTemplate, updateTemplate,
  listCampaigns, getCampaign, createCampaign,
  type EmailBodyFormat, type EmailTemplate, type Campaign,
} from './emailService.js';
import { CONTACT_STAGES, type ContactStage } from '../crm/contactsService.js';

export const EMAIL_GET_CAMPAIGN_TOOL_ID = 'openwop:email.get-campaign';
export const EMAIL_SAVE_DRAFT_TOOL_ID = 'openwop:email.save-draft';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed —
 *  the same `email` toggle `authorizeOrgScope` enforces on the HTTP routes. */
async function emailEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne('email', { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/** The same org resolution + RBAC the email routes enforce via `authorizeOrgScope`
 *  (explicit `orgId`, else the workspace's sole org; several orgs ⇒ the model must
 *  name one). Mirrors the app-builder tool's `resolveOrgScope` (ADR 0358). */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  // ADR 0655 D7 (EMWF-9) — the SHARED toolkit (the predicate the routes use) instead of a
  // hand-rolled copy, plus the route's ADR 0419 entitlement gate: a narrowed plan 402s the
  // HTTP routes, so the copywriter agent must refuse too. Reads fail EMPTY, writes fail typed.
  try { await checkTenantEntitlement(scope.tenantId, 'email'); }
  catch { return needed === 'workspace:read' ? toolEmpty('Email is not included in this workspace\'s plan.') : toolError('not_entitled', 'Email is not included in this workspace\'s plan.'); }
  if (needed === 'workspace:read') {
    const r = await resolveReadOrgScope(scope, { featureId: 'email', featureLabel: 'Email' }, orgIdInput);
    if (r.kind === 'ok') return { orgId: r.orgId, actingUserId: scope.actingUserId! };
    if (r.kind === 'error') return r.result;
    return toolEmpty(r.note);
  }
  const r = await resolveActionOrgScope(scope, { featureId: 'email', featureLabel: 'Email' }, orgIdInput);
  if ('error' in r) return r.error;
  return { orgId: r.orgId, actingUserId: r.actingUserId };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const parseFormat = (v: unknown): EmailBodyFormat | undefined => (v === 'markdown' ? 'markdown' : v === 'text' ? 'text' : undefined);

/** Strip tenant-internal fields before the copy reaches the model. */
function projectTemplate(t: EmailTemplate): Record<string, unknown> {
  return { templateId: t.templateId, name: t.name, subject: t.subject, body: t.body, ...(t.format ? { format: t.format } : {}), updatedAt: t.updatedAt };
}
function projectCampaign(c: Campaign): Record<string, unknown> {
  return { campaignId: c.campaignId, templateId: c.templateId, status: c.status, audience: c.audience, updatedAt: c.updatedAt };
}

export function registerEmailAgentTools(): void {
  // ── The app-state read path: the model READS a draft (+ its template) or the
  //    org's drafts/templates before authoring (read-before-write). ──────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: EMAIL_GET_CAMPAIGN_TOOL_ID,
      description:
        'Read an existing email DRAFT campaign and the template it references, so you can match house style and '
        + 'refine copy that already exists instead of blind-authoring. Pass `campaignId` for one campaign (returns '
        + '{ campaign, template }); omit it to list this org\'s draft campaigns + templates for grounding '
        + '(returns { campaigns, templates }). Read-only — it never sends and never edits.',
      inputSchema: {
        type: 'object',
        properties: {
          campaignId: { type: 'string', description: 'A specific draft campaign id (omit to list the org\'s drafts + templates).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
      },
    },
    async run(input, scope) {
      // Read tool: a disabled feature OR a system turn (no acting user) both fail
      // EMPTY, not typed — the model just sees no campaigns and the loop is not
      // derailed. The write path (save-draft) keeps the typed feature_disabled.
      if (!scope.actingUserId || !(await emailEnabled(scope.tenantId, scope.actingUserId))) {
        return { content: JSON.stringify({ campaigns: [], templates: [] }) };
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const campaignId = str(input.campaignId);
      if (campaignId) {
        const campaign = await getCampaign(scope.tenantId, gate.orgId, campaignId);
        if (!campaign) return { content: JSON.stringify({ campaign: null, template: null }) };
        const template = await getTemplate(scope.tenantId, gate.orgId, campaign.templateId);
        return { content: JSON.stringify({ campaign: projectCampaign(campaign), template: template ? projectTemplate(template) : null }) };
      }
      const [campaigns, templates] = await Promise.all([
        listCampaigns(scope.tenantId, gate.orgId),
        listTemplates(scope.tenantId, gate.orgId),
      ]);
      return {
        content: JSON.stringify({
          campaigns: campaigns.filter((c) => c.status === 'draft').map(projectCampaign),
          templates: templates.map(projectTemplate),
        }),
      };
    },
  });

  // ── The deliverable path: validate → persist the copy as a DRAFT → return a
  //    real reference. NEVER sends (that is the consent-gated human/workflow
  //    path). ───────────────────────────────────────────────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: EMAIL_SAVE_DRAFT_TOOL_ID,
      description:
        'Persist the copy you drafted into a DRAFT email campaign the user can review and send. To CREATE a new '
        + 'draft, pass `subject` + `body` (+ optional `name`, `format` "markdown"|"text", and audience `stage`) — '
        + 'this writes a draft template + a draft campaign and returns { campaignId, templateId, created:true }. To '
        + 'UPDATE the copy of an existing draft, also pass its `campaignId` (from get-campaign). Use '
        + '{{contact.name|email|company}} merge fields where personal. This NEVER sends — a human reviews and sends. '
        + 'On a validation error, fix the reported issues and call again.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'The subject line (≤ ~60 chars; may use {{contact.*}} merge fields).' },
          body: { type: 'string', description: 'The email body copy (may use {{contact.*}} merge fields).' },
          name: { type: 'string', description: 'A human label for the campaign/template (new drafts only; defaults from the subject).' },
          format: { type: 'string', enum: ['text', 'markdown'], description: 'Body authoring mode (default text).' },
          stage: { type: 'string', enum: [...CONTACT_STAGES], description: 'Audience filter — the CRM contact stage this campaign targets (new drafts only).' },
          campaignId: { type: 'string', description: 'An existing DRAFT campaign to update the copy of (omit to create a new draft).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['subject', 'body'],
      },
    },
    async run(input, scope) {
      if (!(await emailEnabled(scope.tenantId, scope.actingUserId))) {
        return toolError('feature_disabled', 'Email Marketing is not enabled for this workspace — tell the user you cannot save email drafts here.');
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;

      // Closed-world validation → typed defects the loop feeds back (never
      // success-with-empty).
      const defects: string[] = [];
      const subject = str(input.subject);
      const body = str(input.body);
      if (!subject) defects.push('`subject` is required and must be a non-empty string.');
      if (!body) defects.push('`body` is required and must be a non-empty string.');
      if (input.format !== undefined && parseFormat(input.format) === undefined) defects.push('`format` must be "text" or "markdown".');
      const stageRaw = str(input.stage);
      const stage: ContactStage | undefined = stageRaw && CONTACT_STAGES.includes(stageRaw as ContactStage) ? (stageRaw as ContactStage) : undefined;
      if (stageRaw && !stage) defects.push(`\`stage\` must be one of: ${CONTACT_STAGES.join(', ')}.`);
      if (defects.length || !subject || !body) {
        return toolError('validation_error', 'The draft was not saved — fix these and call save-draft again.', { defects });
      }
      const format = parseFormat(input.format);

      // UPDATE an existing draft's copy (draft-only — never rewrite a campaign
      // that is sending/sent: its recipients already saw the old copy).
      const campaignId = str(input.campaignId);
      if (campaignId) {
        const campaign = await getCampaign(scope.tenantId, gate.orgId, campaignId);
        if (!campaign) return toolError('not_found', `Draft campaign '${campaignId}' not found in this workspace.`);
        if (campaign.status !== 'draft') return toolError('campaign_not_draft', `Campaign '${campaignId}' is ${campaign.status}, not a draft — its copy can no longer be edited.`);
        const updated = await updateTemplate(scope.tenantId, gate.orgId, campaign.templateId, { subject, body, ...(str(input.name) ? { name: str(input.name)! } : {}), ...(format ? { format } : {}) });
        if (!updated) return toolError('not_found', `The template for campaign '${campaignId}' is missing — cannot update its copy.`);
        return { content: JSON.stringify({ campaignId: campaign.campaignId, templateId: updated.templateId, updated: true, note: 'Draft copy updated. Tell the user what changed and that they can review and send it.' }) };
      }

      // CREATE a new draft — one draft template + one draft campaign, through
      // the owning service (idempotent on deterministic ids so a loop retry
      // never mints duplicates).
      const name = str(input.name) ?? subject.slice(0, 60);
      const idem = createHash('sha256').update(`${gate.orgId}\u0000${subject}\u0000${body}`).digest('hex').slice(0, 12);
      const base = `${scope.runId ?? 'agent'}:${idem}`;
      const createdBy = scope.actingUserId ?? gate.actingUserId;
      const tpl = await createTemplate({ tenantId: scope.tenantId, orgId: gate.orgId, name, subject, body, createdBy, templateId: `tpl:agent:${base}`, ...(format ? { format } : {}) });
      const cmp = await createCampaign({ tenantId: scope.tenantId, orgId: gate.orgId, templateId: tpl.templateId, createdBy, campaignId: `cmp:agent:${base}`, ...(stage ? { stage } : {}) });
      return { content: JSON.stringify({ campaignId: cmp.campaignId, templateId: tpl.templateId, created: true, note: 'Draft campaign created (not sent). Tell the user the campaign name and that they can review and send it.' }) };
    },
  });
}
