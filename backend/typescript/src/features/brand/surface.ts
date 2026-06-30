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
import { getBrand, listBrands } from './brandService.js';
import { getAppBrand } from '../../host/systemBrand.js';
import { scoreComplianceDeterministic, resolveVoice } from './scoring.js';
import { BRAND_CHANNELS, type BrandChannel } from './types.js';

const asChannel = (v: unknown): BrandChannel | undefined =>
  typeof v === 'string' && (BRAND_CHANNELS as readonly string[]).includes(v) ? (v as BrandChannel) : undefined;

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

    /** Render a brand's voice into a prompt-injectable block. */
    resolveVoice: async (args) => {
      const brand = await getBrand(tenantId, str(args.brandId));
      if (!brand) return { voice: null };
      return { voice: resolveVoice(brand, { channel: asChannel(args.channel), register: optStr(args.register) }) };
    },

    /** Deterministic compliance score for `content` (the LLM leg is the node's). */
    checkComplianceDeterministic: async (args) => {
      const brand = await getBrand(tenantId, str(args.brandId));
      if (!brand) return { report: null };
      return { report: scoreComplianceDeterministic(str(args.content), brand, { channel: asChannel(args.channel) }) };
    },
  };
}
