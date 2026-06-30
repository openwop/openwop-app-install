/**
 * Brief context assembler (ADR 0156 Phase 3). PURE composition of the
 * brief-owned context (product, audience/personas, messaging) into a
 * prompt-injectable text block. The brand-voice leg (ADR 0155 `resolveVoice`)
 * and the KB grounding leg (ADR 0011 `kb.rag`) are composed IN the kernel node
 * where those run-scoped surfaces live — this stays pure + unit-testable, the
 * ADR 0155 deterministic-in-service / AI-in-node seam.
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

import { FORMALITY_LABELS } from '../brand/types.js';
import type { CampaignBrief, Persona } from './types.js';

const BUYER_STAGE_GUIDANCE: Record<string, string> = {
  unaware: 'The audience is unaware of the problem — lead with the pain, not the product.',
  problem_aware: 'The audience feels the problem — connect it to your solution.',
  solution_aware: 'The audience compares solutions — differentiate against alternatives.',
  product_aware: 'The audience knows the product — handle objections and drive the CTA.',
};

/** Compose the persona section from the brief's personas. */
function personaSection(personas: Persona[]): string {
  if (personas.length === 0) return '';
  const blocks = personas.map((p) => {
    const lines = [`- ${p.name}${p.role ? ` (${p.role})` : ''} — buyer stage: ${p.buyerStage}.`];
    if (BUYER_STAGE_GUIDANCE[p.buyerStage]) lines.push(`  ${BUYER_STAGE_GUIDANCE[p.buyerStage]}`);
    if (p.painPoints.length) lines.push(`  Pain points: ${p.painPoints.join('; ')}`);
    if (p.objections.length) lines.push(`  Objections to overcome: ${p.objections.join('; ')}`);
    if (p.goals.length) lines.push(`  Goals: ${p.goals.join('; ')}`);
    if (p.demographics) lines.push(`  Audience notes: ${p.demographics}`);
    return lines.join('\n');
  });
  return `## Audience\n${blocks.join('\n')}`;
}

/**
 * Build the brief-owned context block (product + audience + messaging). The node
 * prepends the brand voice block and appends the KB grounding.
 */
export function assembleBriefContextText(brief: CampaignBrief, personas: Persona[]): string {
  const parts: string[] = [];
  parts.push(`# Campaign: ${brief.name}`);
  if (brief.objective) parts.push(`Objective: ${brief.objective}`);

  const product: string[] = ['## Product'];
  if (brief.productName) product.push(`Name: ${brief.productName}`);
  if (brief.productDescription) product.push(brief.productDescription);
  if (brief.industryVertical) product.push(`Industry: ${brief.industryVertical}`);
  if (product.length > 1) parts.push(product.join('\n'));

  const audience = personaSection(personas);
  if (audience) parts.push(audience);

  const m = brief.messaging;
  const messaging: string[] = ['## Messaging direction'];
  if (m.primaryValueProp) messaging.push(`Primary value proposition: ${m.primaryValueProp}`);
  if (m.toneOverride) messaging.push(`Tone override: ${m.toneOverride}`);
  if (m.proofPoints.length) messaging.push(`Proof points to include: ${m.proofPoints.join('; ')}`);
  if (m.ctaStrategy) messaging.push(`CTA strategy: ${m.ctaStrategy}`);
  if (messaging.length > 1) parts.push(messaging.join('\n'));

  return parts.join('\n\n');
}

/** The JSON Schema the kernel generation is constrained to (node `responseSchema`). */
export const KERNEL_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'supportingStatement', 'proofPoints', 'primaryCta', 'tone'],
  properties: {
    headline: { type: 'string', minLength: 1, maxLength: 200 },
    supportingStatement: { type: 'string', minLength: 1, maxLength: 500 },
    proofPoints: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
    primaryCta: { type: 'string', minLength: 1, maxLength: 100 },
    secondaryCta: { type: 'string', maxLength: 100 },
    tone: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/** Re-export so the node + UI share one label table. */
export { FORMALITY_LABELS };
