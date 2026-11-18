/**
 * The run admission preflight ADR (D3.2) — which OTHER features a node type
 * reads through `ctx.features.<id>`, beyond its own (`feature.<id>.nodes.*`
 * implies `<id>`).
 *
 * Two sources, merged:
 *  1. the node pack manifest's `x-requiresFeatureSurfaces` /
 *     `x-optionalFeatureSurfaces` (RFC 0138 `x-` hatch; `nodeFeatureSurfaceMap`);
 *  2. this HOST table, for the vendored packs' current reads.
 *
 * Correction to the ADR's D3.2 ("a node-level declaration in node pack
 * manifests"): the declarations start HERE, not in the manifests, because
 * every manifest edit is a pack version bump, a `packPins` + steward-manifest
 * change and a registry publish that needs the user's approval. The manifest
 * hatch is read too, so a pack can move its own declaration into its manifest
 * later and this table shrinks. The census ratchet
 * (`test/run-preflight-feature-census.test.ts`) accepts either source.
 *
 * `required` is only for reads verified to fail the step when the feature is
 * off (the surface throws `host_capability_disabled`, or the node fails typed).
 * A pack-wide `<pack>.*` entry is for reads whose required-ness has not been
 * reviewed per node: it is always `optional`, so it never refuses a run; it
 * exists so the census can tell a declared read from a new, undeclared one.
 */
import { nodeFeatureSurfaceMap } from './nodeCatalogBuilder.js';
import type { NodeFeatureDecl } from './runPreflight.js';

export interface NodeFeatureEntry { required?: readonly string[]; optional?: readonly string[] }

export const NODE_FEATURE_REQUIREMENTS: Readonly<Record<string, NodeFeatureEntry>> = {
  // ── feature.campaign-channels.nodes, reviewed per node (packs/feature.campaign-channels.nodes/index.mjs)
  // generate: ensureBrief() throws without campaign-brief; brand voice and KB
  // grounding are try/catch legs (strict grounding fails typed on its own).
  'feature.campaign-channels.nodes.generate': { required: ['campaign-brief'], optional: ['brand', 'kb'] },
  // CC-CHAN-3: skips cleanly with reason feature_disabled when Creative Briefs is off.
  'feature.campaign-channels.nodes.create-creative-briefs': { optional: ['creative-briefs'] },
  'feature.campaign-channels.nodes.publish-landing-page': { required: ['cms'], optional: ['campaign-brief'] },
  'feature.campaign-channels.nodes.publish-email-sequence': { required: ['email'], optional: ['campaign-brief'] },
  // Documents only on the no-ad-account fallback; trackedUrl only with a landing URL.
  'feature.campaign-channels.nodes.publish-ad-variants': { optional: ['documents', 'campaign-brief'] },
  'feature.campaign-channels.nodes.publish-creative-briefs': { required: ['documents'], optional: ['campaign-brief'] },
  'feature.campaign-channels.nodes.publish-social-posts': { required: ['documents'], optional: ['campaign-brief'] },
  // attachAssets is best-effort.
  'feature.campaign-channels.nodes.render-concepts': { required: ['media'], optional: ['campaign-orchestration'] },

  // ── pack-wide, required-ness not yet reviewed per node: optional, never refuses.
  'feature.agent-knowledge.nodes.*': { optional: ['agentKnowledge'] },
  'feature.campaign-brief.nodes.*': { optional: ['brand', 'kb'] },
  'feature.campaign-orchestration.nodes.*': { optional: ['campaign-brief'] },
  'feature.commerce.buyer.nodes.*': { optional: ['commerce'] },
  'feature.creative-briefs.nodes.*': { optional: ['creative'] },
  'feature.csm.nodes.*': { optional: ['crm'] },
  'feature.notebooks.nodes.*': { optional: ['documents'] },
  'feature.podcasts.nodes.*': { optional: ['documents', 'notebooks'] },
  'feature.production.nodes.*': { optional: ['campaign-brief'] },
  'feature.strategy.nodes.*': { optional: ['documents'] },
};

/** `feature.x.nodes.y` → `feature.x.nodes` (pack names may contain dots). */
export function nodePackOf(typeId: string): string | null {
  return /^(.+?\.nodes)\./.exec(typeId)?.[1] ?? null;
}

/** The merged declaration for one BARE typeId (manifest + host table). */
export function nodeFeatureDecl(typeId: string): NodeFeatureDecl | undefined {
  const pack = nodePackOf(typeId);
  const sources = [
    nodeFeatureSurfaceMap().get(typeId),
    NODE_FEATURE_REQUIREMENTS[typeId],
    pack ? NODE_FEATURE_REQUIREMENTS[`${pack}.*`] : undefined,
  ].filter((x): x is NodeFeatureEntry => x !== undefined);
  if (sources.length === 0) return undefined;
  const required = new Set<string>();
  const optional = new Set<string>();
  for (const s of sources) {
    for (const id of s.required ?? []) required.add(id);
    for (const id of s.optional ?? []) optional.add(id);
  }
  for (const id of required) optional.delete(id);
  return { required: [...required], optional: [...optional] };
}
