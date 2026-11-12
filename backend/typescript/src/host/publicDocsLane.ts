/**
 * The public docs lane's ONE serve gate (ADR 1057 D1; ADR 0392). It moved here
 * from `features/docs/docsService.ts` so the three readers that must agree on it
 * can all reach it without one feature importing another's internals:
 *   - the docs nav / `llms.txt` reads (`features/docs`),
 *   - the `/docs` + `/docs/:slug` crawler doors (`features/docs`),
 *   - the sitemap and the `/p/<docs slug>` admission (`features/publishing`).
 * If the sitemap used any other predicate it could list a URL the door 404s.
 *
 * A PUBLIC lane: the tenant comes from the resource (the org), never the request,
 * so the toggle is read through `resolveToggle` (the ADR 0819 §1 opt-out — ADR
 * 0419 never paywalls a visitor on the operator's plan), then the ADR 0820 §7
 * owner-lapse policy (off unless `OPENWOP_BILLING_PUBLIC_LAPSE_GRACE_DAYS` is set).
 */
import { getOrg } from './accessControlService.js';
import { resolveToggle } from './featureToggles/service.js';
import { ownerPublicRuntimeLapsed } from './publicLapse.js';

/** The org's tenant when its public docs lane is open, else null (an unknown org,
 *  the `docs` toggle off, or a lapsed owner — one uniform answer, so a caller
 *  reveals nothing about which orgs exist). */
export async function publicDocsTenant(orgId: string): Promise<string | null> {
  const org = await getOrg(orgId);
  if (!org) return null;
  const assignment = await resolveToggle('docs', { tenantId: org.tenantId });
  if (!assignment?.enabled) return null;
  return (await ownerPublicRuntimeLapsed('docs', org.tenantId)) ? null : org.tenantId;
}
