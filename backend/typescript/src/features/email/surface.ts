/**
 * Email workflow surface (ADR 0014) — `ctx.features.email`, a thin adapter over
 * `emailService`. Reads (list/get/render) for the copywriter agent + render node.
 * The ONE write — `createDraftCampaign` (ADR 0162) — turns a Campaign Studio
 * email-sequence draft into real, sendable entities: one `draft` template + one
 * `draft` campaign PER email step (the Campaign model holds a single templateId, so
 * a step = a campaign — nothing is orphaned, every step is independently sendable).
 * It NEVER calls `sendCampaign`: the send (fan-out + provider dispatch, consent gate)
 * stays a deliberate human action. Tenant comes from the run scope (never args) — the
 * cross-tenant isolation guard; org is node-supplied (the service enforces the key).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { campaignForRun } from '../../host/campaignRefs.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
// ADR 0655 D4 (EMWF-4 — the ANLWF-2 class): a missing `orgId` is a typed refusal, never
// a coerced `''` that lists nobody's templates as success-with-empty.
import { requireString } from '../featureRoute.js';
import { listTemplates, getTemplate, renderTemplate, createTemplate, createCampaign, draftRowId } from './emailService.js';
import { submitForReview } from './sendApproval.js';
import { runOrgScopeSubject } from '../../host/accessControlService.js';
import { CONTACT_STAGES, type ContactStage } from '../crm/contactsService.js';

/** First non-empty string in a possibly-mixed array (subject-line variants). */
function firstStr(v: unknown): string {
  return Array.isArray(v) ? str(v.find((x) => typeof x === 'string' && x.length > 0)) : '';
}

const INTERNAL = new Set(['tenantId', 'createdBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

export function buildEmailSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // Publish an email-sequence draft (ADR 0162): one draft template + one draft
    // campaign per email step. Idempotent — deterministic ids keyed on `idemBase`
    // (the publish node passes runId:nodeId), so a replay/fork reuses the existing
    // entities. Never sends. Returns the created ids for the agent to reference.
    createDraftCampaign: async (args) => {
      const orgId = requireString(args.orgId, 'orgId');
      const createdBy = scope.runId ?? 'workflow';
      const base = optStr(args.idemBase) ?? `${scope.runId ?? 'run'}`;
      const name = str(args.name) || 'Campaign email';
      const sourceBriefId = optStr(args.sourceBriefId); // ADR 0245 — provenance to the source MarketingCampaign brief
      // ADR 0941 P2 — the back-link comes from the RUN (its host-written tag), else
      // from the brief through the campaign owner; never from a free argument. A
      // campaign of another org does not link (the send is this org's).
      // A provenance read: a storage hiccup leaves the send unlinked, never fails the publish.
      const mc = await campaignForRun((id) => hostExtStorage().getRun(id), tenantId, scope.runId, sourceBriefId).catch(() => null);
      const marketingCampaignId = mc && mc.orgId === orgId ? mc.campaignId : undefined;
      const stageRaw = str(args.stage);
      const stage: ContactStage | undefined = CONTACT_STAGES.includes(stageRaw as ContactStage) ? (stageRaw as ContactStage) : undefined;
      const emails = Array.isArray(args.emails) ? (args.emails as Array<Record<string, unknown>>) : [];
      const templateIds: string[] = [];
      const campaignIds: string[] = [];
      for (let idx = 0; idx < emails.length; idx++) {
        const e = emails[idx] ?? {};
        const position = Number.isInteger(e.position) ? (e.position as number) : idx + 1;
        const subject = firstStr(e.subjectLines) || `${name} ${position}`;
        const body = str(e.body);
        // ADR 0848 D1 — tenant-qualified ids (the legacy id only when this workspace owns it).
        const templateId = await draftRowId('template', tenantId, orgId, 'tpl:', `${base}:email-${position}`);
        const campaignId = await draftRowId('campaign', tenantId, orgId, 'cmp:', `${base}:email-${position}`);
        const tpl = await createTemplate({ tenantId, orgId, name: `${name} · Email ${position}`, subject, body, createdBy, templateId });
        const cmp = await createCampaign({ tenantId, orgId, templateId: tpl.templateId, createdBy, campaignId, ...(stage ? { stage } : {}), ...(sourceBriefId ? { sourceBriefId } : {}), ...(marketingCampaignId ? { marketingCampaignId } : {}) });
        templateIds.push(tpl.templateId);
        campaignIds.push(cmp.campaignId);
      }
      return { campaignIds, templateIds, steps: templateIds.length };
    },

    // ADR 0905 D5 — a run may SUBMIT a campaign for send review; it can never approve
    // or send (there is no send or approve method on this surface, by design). The
    // submit is idempotent: a resubmit while `in_review` repins the ONE open row, so a
    // `branch` fork that re-runs it converges; a `replay` fork serves the recorded
    // outcome (the node is classified `side-effect`).
    submitForReview: async (args) => {
      const orgId = requireString(args.orgId, 'orgId');
      const campaignId = requireString(args.campaignId, 'campaignId');
      const { campaign, approval } = await submitForReview(tenantId, orgId, campaignId, scope.actingUserId, scope.actingUserId ? undefined : runOrgScopeSubject(scope));
      return { campaignId: campaign.campaignId, status: campaign.status, approvalId: approval.approvalId, templateVersion: campaign.review?.pin.templateVersion ?? null };
    },

    listTemplates: async (args) => {
      const tpls = await listTemplates(tenantId, requireString(args.orgId, 'orgId'));
      return { templates: tpls.map(project) };
    },
    getTemplate: async (args) => {
      const t = await getTemplate(tenantId, requireString(args.orgId, 'orgId'), requireString(args.templateId, 'templateId'));
      return { template: t ? project(t) : null };
    },
    render: async (args) => {
      const t = await getTemplate(tenantId, requireString(args.orgId, 'orgId'), requireString(args.templateId, 'templateId'));
      if (!t) return { rendered: null };
      const c = (args.contact ?? {}) as Record<string, unknown>;
      const rendered = renderTemplate(t, {
        ...(typeof c.name === 'string' ? { name: c.name } : {}),
        ...(typeof c.email === 'string' ? { email: c.email } : {}),
        ...(typeof c.company === 'string' ? { company: c.company } : {}),
      });
      return { rendered };
    },
  };
}
