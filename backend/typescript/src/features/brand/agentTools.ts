/**
 * Brand Steward chat tools (CFP-1 / CHAT-FIRST-PORT-AUDIT #1; the ADR 0308 seam,
 * the `creative-briefs.list` precedent). The Brand Steward is a READ/advise
 * persona: it explains a workspace's brand voice and audits content for
 * compliance — so all three tools are reads/pure computes, registered via
 * `registerFeatureAgentTool` and pack-allowlisted onto the Steward ONLY.
 *
 * Before CFP-1 the pack allowlisted raw `feature.brand.nodes.*` typeIds that no
 * provider projects into a conversational tool, so the agent resolved ZERO tools
 * and fell back to a bare narrating completion (`conversationToolLoop.ts:304`).
 * These tools make the persona real.
 *
 * Authority parity (hard rule #1): every tool shares the brand ROUTES' predicate
 * — `orgScopeGranted(... 'workspace:read')` in the brand's own org (the
 * no-existence-leak `loadBrandScoped` shape). Brand is always-on/core (ADR 0170)
 * so there is NO feature-toggle gate — the RBAC IS the authority, exactly as the
 * routes have it. READ tools fail EMPTY without an acting user.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { orgScopeGranted } from './routes.js';
import { getBrand, listBrands, resolveEffectiveBrandRules } from './brandService.js';
import { resolveVoice, scoreComplianceDeterministic } from './scoring.js';
import { BRAND_CHANNELS, type Brand, type BrandChannel } from './types.js';

export const BRAND_LIST_TOOL_ID = 'openwop:brand.list-brands';
export const BRAND_RESOLVE_VOICE_TOOL_ID = 'openwop:brand.resolve-voice';
export const BRAND_COMPLIANCE_CHECK_TOOL_ID = 'openwop:brand.compliance-check';

type ToolResult = { content: string; isError?: boolean };

function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true };
}

const asChannel = (v: unknown): BrandChannel | undefined =>
  typeof v === 'string' && (BRAND_CHANNELS as readonly string[]).includes(v) ? (v as BrandChannel) : undefined;

/** The parent-cascaded bans the brand's own list doesn't already carry — the SAME
 *  effective rules the surface + the ads-dispatch checker see (brand/surface.ts). */
async function extraBannedFor(tenantId: string, brand: Brand): Promise<string[]> {
  const effective = await resolveEffectiveBrandRules(tenantId, brand.id);
  if (!effective) return [];
  return effective.bannedPhrases.filter((p) => !brand.keyPhrases.bannedPhrases.includes(p));
}

/**
 * Load a brand and gate the acting user on `workspace:read` in the brand's org —
 * the `loadBrandScoped` route shape (a caller without read gets a uniform
 * not-found, no existence leak). Returns null when absent, unreadable, or there
 * is no acting user.
 */
async function readableBrand(tenantId: string, actingUserId: string | undefined, brandId: string): Promise<Brand | null> {
  if (!actingUserId) return null;
  const brand = await getBrand(tenantId, brandId);
  if (!brand) return null;
  if (!(await orgScopeGranted(tenantId, actingUserId, brand.orgId, 'workspace:read'))) return null;
  return brand;
}

export function registerBrandAgentTools(): void {
  // ── list-brands ──────────────────────────────────────────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: BRAND_LIST_TOOL_ID,
      description:
        'List the brands in the workspace you can read: id, name, org, formality, and how many approved/banned phrases each '
        + 'carries. Use it to find the RIGHT brand before resolving its voice or auditing content. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Narrow to one organization (optional).' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope): Promise<ToolResult> {
      const actingUserId = scope.actingUserId;
      if (!actingUserId) {
        return { content: JSON.stringify({ brands: [], note: 'No acting user on this turn — brand access is resolved per signed-in user.' }) };
      }
      const orgFilter = typeof input.orgId === 'string' && input.orgId.trim() ? input.orgId.trim() : undefined;
      const all = await listBrands(scope.tenantId, orgFilter);
      // Per-org readability filter — the routes' `readableBrands` shape.
      const readable = new Map<string, boolean>();
      const out: Brand[] = [];
      for (const b of all) {
        let ok = readable.get(b.orgId);
        if (ok === undefined) { ok = await orgScopeGranted(scope.tenantId, actingUserId, b.orgId, 'workspace:read'); readable.set(b.orgId, ok); }
        if (ok) out.push(b);
      }
      return {
        content: JSON.stringify({
          brands: out.map((b) => ({
            brandId: b.id,
            name: b.name,
            orgId: b.orgId,
            status: b.status,
            formalityLevel: b.voiceProfile.formalityLevel,
            approvedPhraseCount:
              b.keyPhrases.approvedTaglines.length + b.keyPhrases.valuePropositions.length + b.keyPhrases.productDescriptors.length,
            bannedPhraseCount: b.keyPhrases.bannedPhrases.length,
          })),
        }),
      };
    },
  });

  // ── resolve-voice ────────────────────────────────────────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: BRAND_RESOLVE_VOICE_TOOL_ID,
      description:
        'Render a brand\'s voice into the exact guidance a generator should follow — formality, channel tone, approved '
        + 'phrases, and the NEVER-use (banned) list (parent-brand bans included). Pass a `channel` '
        + `(${BRAND_CHANNELS.join(', ')}) for the channel-specific rule. Ground brand advice in this instead of guessing. Read-only.`,
      inputSchema: {
        type: 'object',
        properties: {
          brandId: { type: 'string', description: 'The brand to resolve (from list-brands).' },
          channel: { type: 'string', enum: [...BRAND_CHANNELS], description: 'Apply this channel\'s voice rule (optional).' },
          register: { type: 'string', description: 'Apply a named tone register over the base voice (optional).' },
          personaId: { type: 'string', description: 'Prefer this persona\'s channel rule when one exists (optional).' },
        },
        required: ['brandId'],
        additionalProperties: false,
      },
    },
    async run(input, scope): Promise<ToolResult> {
      const brandId = typeof input.brandId === 'string' ? input.brandId.trim() : '';
      if (!brandId) return toolError('validation_error', '`brandId` is required.');
      const brand = await readableBrand(scope.tenantId, scope.actingUserId, brandId);
      if (!brand) return { content: JSON.stringify({ voice: null, note: 'Brand not found, or you lack read access to it.' }) };
      const extraBannedPhrases = await extraBannedFor(scope.tenantId, brand);
      const register = typeof input.register === 'string' && input.register.trim() ? input.register.trim() : undefined;
      const personaId = typeof input.personaId === 'string' && input.personaId.trim() ? input.personaId.trim() : undefined;
      const voice = resolveVoice(brand, {
        ...(asChannel(input.channel) ? { channel: asChannel(input.channel) } : {}),
        ...(register ? { register } : {}),
        ...(personaId ? { personaId } : {}),
        ...(extraBannedPhrases.length ? { extraBannedPhrases } : {}),
      });
      return { content: JSON.stringify({ brandId: brand.id, brandName: brand.name, voice }) };
    },
  });

  // ── compliance-check ───────────────────────────────────────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: BRAND_COMPLIANCE_CHECK_TOOL_ID,
      description:
        'Score a piece of content against a brand\'s deterministic guardrails (0–100): banned-phrase hits, formality '
        + 'register mismatch, and per-channel length. A banned phrase caps the score. Returns the score, pass/fail, and '
        + 'each specific issue so you can report concrete fixes. (The tone/LLM half of the blended score is the workflow '
        + 'node\'s; this is the deterministic guardrail pass.) Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          brandId: { type: 'string', description: 'The brand to audit against (from list-brands).' },
          content: { type: 'string', description: 'The content to score.' },
          channel: { type: 'string', enum: [...BRAND_CHANNELS], description: 'Apply this channel\'s length/voice rule (optional).' },
        },
        required: ['brandId', 'content'],
        additionalProperties: false,
      },
    },
    async run(input, scope): Promise<ToolResult> {
      const brandId = typeof input.brandId === 'string' ? input.brandId.trim() : '';
      const content = typeof input.content === 'string' ? input.content : '';
      if (!brandId) return toolError('validation_error', '`brandId` is required.');
      if (!content.trim()) return toolError('validation_error', '`content` is required.');
      const brand = await readableBrand(scope.tenantId, scope.actingUserId, brandId);
      if (!brand) return { content: JSON.stringify({ report: null, note: 'Brand not found, or you lack read access to it.' }) };
      const extraBannedPhrases = await extraBannedFor(scope.tenantId, brand);
      const report = scoreComplianceDeterministic(content, brand, {
        ...(asChannel(input.channel) ? { channel: asChannel(input.channel) } : {}),
        ...(extraBannedPhrases.length ? { extraBannedPhrases } : {}),
      });
      return { content: JSON.stringify({ brandId: brand.id, brandName: brand.name, report }) };
    },
  });
}
