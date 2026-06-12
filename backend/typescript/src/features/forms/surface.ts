/**
 * Forms workflow surface (ADR 0014) — `ctx.features.forms`, a THIN read adapter
 * over `formsService`. Tenant comes from the run scope; org-scoped reads are
 * tenant+org-guarded by the service (CTI-1) and project out internal/attribution
 * columns. Read-only in v1 (a submit/mutation node is a follow-on, mirroring the
 * CRM surface).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listForms, getForm, listSubmissions } from './formsService.js';

const FORM_INTERNAL = new Set(['tenantId', 'createdBy']);
const SUB_INTERNAL = new Set(['tenantId', 'orgId']);
function project(o: object, drop: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!drop.has(k)) out[k] = v;
  return out;
}

export function buildFormsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listForms: async (args) => {
      const forms = await listForms(tenantId, str(args.orgId));
      return { forms: forms.map((f) => project(f, FORM_INTERNAL)) };
    },
    getSubmissions: async (args) => {
      // getForm enforces tenant+org; absent/cross-tenant form ⇒ empty (no probe).
      const form = await getForm(tenantId, str(args.orgId), str(args.formId));
      if (!form) return { submissions: [] };
      const subs = await listSubmissions(tenantId, str(args.orgId), str(args.formId));
      return { submissions: subs.map((s) => project(s, SUB_INTERNAL)) };
    },
  };
}
