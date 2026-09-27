/**
 * Brand workflow surface (ADR 0155, Phase 3) — the typed `ctx.features.brand` a
 * workflow node calls. Tenant comes from the run scope; the surface is
 * tenant-trusted (per-org RBAC is the route layer's job — the documents/strategy
 * precedent). Generation (the LLM compliance leg) stays in the NODE where the
 * run-scoped provider lives; the surface exposes only reads + the PURE
 * deterministic scorer + the voice resolver.
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
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

export function buildBrandSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** List the tenant's brands (optionally narrowed to one org). */
    listBrands: async (args) => ({ brands: await listBrands(tenantId, optStr(args.orgId)) }),

    /** Get one brand by id (tenant-scoped; foreign tenant → null). */
    getBrand: async (args) => ({ brand: (await getBrand(tenantId, str(args.brandId))) ?? null }),

    /** The effective white-label app identity (ADR 0170) — the installation's
     *  reserved `brand:host-app`. Host-global (the same data `/public-brand` exposes
     *  publicly), so a workflow or the Brand Steward can read the live app identity. */
    getAppIdentity: async () => ({ identity: (await getAppBrand()).identity ?? {} }),

    /** Render a brand's voice into a prompt-injectable block (effective —
     *  parent-cascaded bans included in the NEVER-use list). */
    resolveVoice: async (args) => {
      const brand = await getBrand(tenantId, str(args.brandId));
      if (!brand) return { voice: null };
      const extraBannedPhrases = await extraBannedFor(tenantId, brand);
      return { voice: resolveVoice(brand, { channel: asChannel(args.channel), register: optStr(args.register), ...(typeof args.personaId === 'string' && args.personaId ? { personaId: args.personaId } : {}), ...(extraBannedPhrases.length ? { extraBannedPhrases } : {}) }) };
    },

    /** Deterministic compliance score for `content` (the LLM leg is the node's).
     *  Scores over EFFECTIVE rules — a parent brand's bans flag here exactly as
     *  they do at the ads-dispatch gate. */
    checkComplianceDeterministic: async (args) => {
      const brand = await getBrand(tenantId, str(args.brandId));
      if (!brand) return { report: null };
      const extraBannedPhrases = await extraBannedFor(tenantId, brand);
      return { report: scoreComplianceDeterministic(str(args.content), brand, { channel: asChannel(args.channel), ...(extraBannedPhrases.length ? { extraBannedPhrases } : {}) }) };
    },
  };
}
