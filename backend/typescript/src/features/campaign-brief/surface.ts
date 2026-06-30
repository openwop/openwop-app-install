/**
 * Campaign Brief workflow surface (ADR 0156 Phase 3 / ADR 0014) —
 * `ctx.features['campaign-brief']`. Tenant-trusted reads + the pure context
 * assembler + `validate` + the kernel write the node calls. Generation (the LLM
 * kernel) stays in the node where the run-scoped provider + brand/kb surfaces are.
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { getPersona, listPersonas } from './personaService.js';
import { getBrief, listBriefs, setKernel, validateBrief } from './briefService.js';
import { assembleBriefContextText } from './briefContext.js';
import type { MessagingKernel } from './types.js';

export function buildCampaignBriefSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listPersonas: async (args) => ({ personas: await listPersonas(tenantId, optStr(args.orgId), optStr(args.brandId)) }),
    getPersona: async (args) => ({ persona: (await getPersona(tenantId, str(args.brandId ?? args.personaId))) ?? null }),

    listBriefs: async (args) => ({ briefs: await listBriefs(tenantId, optStr(args.orgId)) }),
    getBrief: async (args) => ({ brief: (await getBrief(tenantId, str(args.briefId))) ?? null }),

    /** Validate completeness + the enabled channel set (drives 0158 fan-out). */
    validateBrief: async (args) => {
      const brief = await getBrief(tenantId, str(args.briefId));
      if (!brief) return { valid: false, issues: [{ field: 'briefId', message: 'Brief not found.' }], enabledChannels: [] };
      return { ...validateBrief(brief) };
    },

    /**
     * Assemble the brief-owned context block (product + audience + messaging) plus
     * the metadata the node needs to add the brand-voice + KB grounding legs.
     */
    assembleContext: async (args) => {
      const brief = await getBrief(tenantId, str(args.briefId));
      if (!brief) return { found: false };
      const personas = (await Promise.all(brief.personaIds.map((id) => getPersona(tenantId, id)))).filter((p): p is NonNullable<typeof p> => p !== null);
      return {
        found: true,
        brief: {
          id: brief.id,
          orgId: brief.orgId,
          brandId: brief.brandId ?? '',
          kbCollectionId: brief.kbCollectionId ?? '',
          productName: brief.productName,
          industryVertical: brief.industryVertical,
        },
        // The kernel (ADR 0156) — channel generators (ADR 0157) echo it.
        kernel: brief.kernel ?? null,
        contextText: assembleBriefContextText(brief, personas),
        ...validateBrief(brief),
      };
    },

    /** Persist a generated kernel (the node calls this after ctx.callAI). */
    setKernel: async (args) => {
      const kernel = args.kernel as MessagingKernel;
      const updated = await setKernel(tenantId, str(args.briefId), kernel);
      return { brief: updated ?? null };
    },
  };
}
