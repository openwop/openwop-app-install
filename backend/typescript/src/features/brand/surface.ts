/**
 * Brand workflow surface (ADR 0155, Phase 3) — the typed `ctx.features.brand` a
 * workflow node calls. Generation (the LLM compliance leg) stays in the NODE where
 * the run-scoped provider lives; the surface exposes only reads + the PURE
 * deterministic scorer + the voice resolver.
 *
 * ADR 0891 D1 (BR2WF-1): the by-id methods take no `orgId`, so the seam's org floor
 * never fired for them and a run acting for an org-A member read org B's brand. They
 * now apply the SAME predicate to the brand's own org (the service-desk
 * `readableTicket` shape), and an org-less list is filtered to the orgs the run's
 * person may read. A run with no person stays tenant-trusted (the seam convention).
 * D2: a run records a brand without person ids.
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 * @see docs/adr/0891-brand-run-floor-voice-fence-and-erasure.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { assertRunScopeOrg, runOrgScopeFilter, runOrgScopeSubject } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { getBrand, listBrands, resolveEffectiveBrandRules } from './brandService.js';
import { getAppBrand } from '../../host/systemBrand.js';
import { scoreComplianceDeterministic, resolveVoice } from './scoring.js';
import { BRAND_CHANNELS, type Brand, type BrandChannel } from './types.js';

const asChannel = (v: unknown): BrandChannel | undefined =>
  typeof v === 'string' && (BRAND_CHANNELS as readonly string[]).includes(v) ? (v as BrandChannel) : undefined;

/** BRAND-CODE-4 grade fix (ADR 0354 P3) — the parent-cascaded bans the brand's OWN list
 *  doesn't already carry, so the surface ops (and every pack composing them —
 *  the channels pack + feature.brand.nodes compliance-check) see the SAME
 *  effective rules the ads-dispatch checker enforces. */
async function extraBannedFor(tenantId: string, brand: Brand): Promise<string[]> {
  const effective = await resolveEffectiveBrandRules(tenantId, brand.id);
  if (!effective) return [];
  return effective.bannedPhrases.filter((p) => !brand.keyPhrases.bannedPhrases.includes(p));
}

/** ADR 0891 D2 — what a run may record about a brand: everything a generator or a
 *  branch reads, minus the person ids (`createdBy`, `governance.allowedEditors`). A
 *  node output is replayed on `:fork`, and erasure does not rewrite run history. */
export function projectBrandForRun(brand: Brand): Omit<Brand, 'createdBy' | 'governance'> & { governance: Omit<Brand['governance'], 'allowedEditors'> } {
  const { createdBy: _createdBy, governance, ...rest } = brand;
  const { allowedEditors: _editors, ...gov } = governance;
  return { ...rest, governance: gov };
}

/**
 * ADR 0891 D1 — the brand, if the run's person may read its org (and it is in
 * `orgId` when the caller names one). An authz refusal reads as absent, the same
 * answer as an unknown id; anything else (storage) is rethrown.
 */
async function readableBrand(scope: BundleScope, brandId: string, orgId: string | undefined): Promise<Brand | null> {
  const brand = brandId ? await getBrand(scope.tenantId, brandId) : null;
  if (!brand) return null;
  if (orgId !== undefined && brand.orgId !== orgId) return null;
  try {
    await assertRunScopeOrg(scope, brand.orgId, 'workspace:read');
  } catch (err) {
    if (err instanceof OpenwopError && (err.code === 'not_found' || err.code === 'forbidden_scope')) return null;
    throw err;
  }
  return brand;
}

export function buildBrandSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** List the brands the run may read. A named `orgId` is gated by the seam floor;
     *  without one, the list keeps only the orgs the run's person may read. */
    listBrands: async (args) => {
      const orgId = optStr(args.orgId);
      let brands = await listBrands(tenantId, orgId);
      const subject = runOrgScopeSubject(scope);
      if (!orgId && subject) {
        const allowed = await runOrgScopeFilter(tenantId, subject, brands.map((b) => b.orgId), 'workspace:read', { cause: !scope.actingUserId });
        brands = brands.filter((b) => allowed.has(b.orgId));
      }
      return { brands: brands.map(projectBrandForRun) };
    },

    /** Get one brand by id — null when absent, in another tenant, or unreadable. */
    getBrand: async (args) => {
      const brand = await readableBrand(scope, str(args.brandId), optStr(args.orgId));
      return { brand: brand ? projectBrandForRun(brand) : null };
    },

    /** The effective white-label app identity (ADR 0170) — the installation's
     *  reserved `brand:host-app`. Host-global (the same data `/public-brand` exposes
     *  publicly), so a workflow or the Brand Steward can read the live app identity. */
    getAppIdentity: async () => ({ identity: (await getAppBrand()).identity ?? {} }),

    /** Render a brand's voice into a prompt-injectable block (effective —
     *  parent-cascaded bans included in the NEVER-use list). */
    resolveVoice: async (args) => {
      const brand = await readableBrand(scope, str(args.brandId), optStr(args.orgId));
      if (!brand) return { voice: null };
      const extraBannedPhrases = await extraBannedFor(tenantId, brand);
      return { voice: resolveVoice(brand, { channel: asChannel(args.channel), register: optStr(args.register), ...(typeof args.personaId === 'string' && args.personaId ? { personaId: args.personaId } : {}), ...(extraBannedPhrases.length ? { extraBannedPhrases } : {}) }) };
    },

    /** Deterministic compliance score for `content` (the LLM leg is the node's).
     *  Scores over EFFECTIVE rules — a parent brand's bans flag here exactly as
     *  they do at the ads-dispatch gate. */
    checkComplianceDeterministic: async (args) => {
      const brand = await readableBrand(scope, str(args.brandId), optStr(args.orgId));
      if (!brand) return { report: null };
      const extraBannedPhrases = await extraBannedFor(tenantId, brand);
      return { report: scoreComplianceDeterministic(str(args.content), brand, { channel: asChannel(args.channel), ...(extraBannedPhrases.length ? { extraBannedPhrases } : {}) }) };
    },
  };
}
