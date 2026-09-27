/**
 * CDP workflow surface (ADR 0263 / CDP-A) — `ctx.features.cdp`, read-only.
 *
 * Lets a workflow/agent resolve a customer's golden record by any identifier
 * (the chat-drivable identity lookup). Tenant-scoped from the bundle scope;
 * strips host identity columns from the returned contact (mirrors the crm
 * surface's projection).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { resolveIdentityWithAccess } from './identityService.js';

const INTERNAL = new Set(['tenantId']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

export function buildCdpSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** resolveIdentity({ type, value }) → { resolved: MASKED golden record | null, masked } */
    resolveIdentity: async (args) => {
      // CLNP-3 — through the ONE access helper the route and the agent tool share
      // (XCH-HOLE-6), with NO pii-read grant. The deciding fact is PERSISTENCE, not who
      // is calling: `feature.cdp.nodes.resolve-identity` is `role:"action"`, so this
      // result is recorded into `node.completed` and replay-served to anyone who can
      // read the run. Do NOT "fix" this to honour the session's grant — a clear golden
      // record written to the event log outlives the session that was allowed to see it.
      // `contactId` stays clear (an opaque id), so a workflow can still branch on it.
      const out = await resolveIdentityWithAccess(tenantId, str(args.type), str(args.value), false);
      if (!out) return { resolved: null, masked: false };
      const record = out.record;
      return {
        resolved: { contact: project(record.contact), identifiers: record.identifiers, resolvedBy: record.resolvedBy },
        masked: out.masked,
      };
    },
  };
}
