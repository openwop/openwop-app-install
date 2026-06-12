/**
 * Email workflow surface (ADR 0014) — `ctx.features.email`, a THIN read adapter
 * over `emailService` (list/get templates for a copywriter agent + render node).
 * Tenant from the run scope; org-scoped reads project out internal columns.
 * Read-only in v1 — the campaign `send` (fan-out + provider dispatch) is a
 * deliberate follow-on, not exposed as a workflow node.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listTemplates, getTemplate, renderTemplate } from './emailService.js';

const INTERNAL = new Set(['tenantId', 'createdBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

export function buildEmailSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
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
