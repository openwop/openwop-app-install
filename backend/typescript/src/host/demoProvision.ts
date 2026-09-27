/**
 * Demo-tenant feature provisioning (ADR 0292, DG-SEED-7).
 *
 * The demo seeders are toggle-gated and NEVER flip a toggle themselves — a
 * seeder that finds its feature off skips honestly (the SEEDING.md invariant).
 * That is correct product behavior, but it means a fresh tenant shows only the
 * always-on surfaces; CRM / commerce / merchandising / CDP / territories stay
 * empty until their features are enabled.
 *
 * This module is the ONE place allowed to enable those features, and only as an
 * explicit, superadmin-gated "provision this demo tenant" action — the flip
 * lives in the provisioning orchestration, above the pure seeders, not inside
 * them. It writes a PER-TENANT override (`tenantOverrides[tenantId] = 'on'`), so
 * it never changes the global default for other tenants.
 */

import { enableTenantOverride } from './featureToggles/service.js';

/**
 * The feature toggles the 10-phase demo program's seeders gate on. Kept in sync
 * with the `resolveOne(...)` / `gate(...)` calls in the `demo*Seed.ts` modules
 * (+ the commerce/campaign/advisory showcases). Enabling this set for a tenant
 * lets every demo seeder run instead of skipping. Always-on surfaces (people,
 * media, agents, projects, brand, CMS, workflows) are deliberately absent — they
 * need no toggle.
 */
export const DEMO_FEATURE_TOGGLE_IDS: readonly string[] = [
  'app-builder',
  // Job-search vertical (ADR 0539) — seeded by `demo-job-search`
  'job-search',
  // CRM + sales org
  'crm',
  'territories',
  // Commerce + merchandising
  'commerce',
  'promotions',
  'discovery',
  'recommendations',
  // CDP + consent + data platform
  'cdp',
  'analytics',
  'consent',
  'destination-sync',
  'campaign-journeys',
  // Content + marketing
  'forms',
  'email',
  'documents',
  'campaign-brief',
  'campaign-orchestration',
  'campaign-connectors',
  'creative-briefs',
  // Strategy / planning / success
  'strategy',
  'priority-matrix',
  'advisory-board',
  'csm',
  // Guided walkthroughs — the two sample walkthroughs are seeded demo data
  // (ADR 0435, the `demo-walkthroughs` step), so the toggle must be on for the
  // demo tenant to see them at all.
  'walkthroughs',
  // Sales channel + production (demo-dealers / -sales-commissions / -sales-maps / -production)
  'dealers',
  'sales-commissions',
  'sales-maps',
  'production',
] as const;

export interface DemoProvisionResult {
  /** Toggles newly enabled for this tenant by this call. */
  enabled: string[];
  /** Toggles already enabled for this tenant (no change). */
  alreadyOn: string[];
  /** Ids in the demo set with no registered toggle (skipped). */
  unknown: string[];
}

/**
 * Enable every demo feature for `tenantId` via a per-tenant override. Idempotent:
 * a toggle already enabled for the tenant is left untouched. Returns which
 * toggles it changed so the caller can report + audit.
 */
export async function provisionDemoFeatures(
  tenantId: string,
  actor: string,
): Promise<DemoProvisionResult> {
  const enabled: string[] = [];
  const alreadyOn: string[] = [];
  const unknown: string[] = [];

  // `enableTenantOverride` is a compare-and-swap loop (SEED-RS-3): a naive
  // get→merge→save would lose updates when two tenants are provisioned against
  // the same shared toggle config concurrently. CAS makes each per-tenant
  // override land atomically without a lost write.
  for (const id of DEMO_FEATURE_TOGGLE_IDS) {
    const result = await enableTenantOverride(id, tenantId, actor);
    if (result === 'enabled') enabled.push(id);
    else if (result === 'already-on') alreadyOn.push(id);
    else unknown.push(id);
  }

  return { enabled, alreadyOn, unknown };
}
