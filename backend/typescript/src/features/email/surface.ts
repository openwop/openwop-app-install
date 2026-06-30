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
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listTemplates, getTemplate, renderTemplate, createTemplate, createCampaign } from './emailService.js';
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
      const orgId = str(args.orgId);
      const createdBy = scope.runId ?? 'workflow';
      const base = optStr(args.idemBase) ?? `${scope.runId ?? 'run'}`;
      const name = str(args.name) || 'Campaign email';
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
        const tpl = await createTemplate({ tenantId, orgId, name: `${name} · Email ${position}`, subject, body, createdBy, templateId: `tpl:${base}:email-${position}` });
        const cmp = await createCampaign({ tenantId, orgId, templateId: tpl.templateId, createdBy, campaignId: `cmp:${base}:email-${position}`, ...(stage ? { stage } : {}) });
        templateIds.push(tpl.templateId);
        campaignIds.push(cmp.campaignId);
      }
      return { campaignIds, templateIds, steps: templateIds.length };
    },

    listTemplates: async (args) => {
      const tpls = await listTemplates(tenantId, str(args.orgId));
      return { templates: tpls.map(project) };
    },
    getTemplate: async (args) => {
      const t = await getTemplate(tenantId, str(args.orgId), str(args.templateId));
      return { template: t ? project(t) : null };
    },
    render: async (args) => {
      const t = await getTemplate(tenantId, str(args.orgId), str(args.templateId));
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
