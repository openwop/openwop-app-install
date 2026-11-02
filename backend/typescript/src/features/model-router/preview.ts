/**
 * ADR 1016 D6 — "which model would this message get?"
 *
 * Runs the SAME pure `routeTurn` the chat exchange runs, over the workspace's
 * stored config, for a message an admin types. No model call, no I/O beyond the
 * config read, nothing written. It answers even while routing is disabled, so a
 * config can be checked BEFORE it is switched on (production had 0 configs and
 * 0 routed runs on 2026-10-31, with no way to tell whether a config would apply).
 *
 * `provider` is the provider of the conversation being imagined: a rule only
 * applies to conversations whose key belongs to its provider (ADR 1016 D4), so
 * the answer depends on it.
 */
import { OpenwopError } from '../../types.js';
import { getRouterConfig } from './configService.js';
import { isRoutableProvider, listedModelCapabilities } from './routableProviders.js';
import { routeTurn, type RoutingTarget, type TurnFeatures } from './routeTurn.js';

/** Bound the text an admin can submit for a preview (it is only measured). */
const MAX_PREVIEW_CHARS = 200_000;

export interface RoutePreview {
  /** Whether routing is switched on for the workspace right now. */
  enabled: boolean;
  /** What the message would be routed to, or `null` = it keeps the conversation's own model. */
  decision: { target: RoutingTarget; reason: 'rule' | 'fallback' | 'cooldown'; ruleIndex?: number } | null;
  /** `no_config` · `no_match` (no eligible rule and no eligible fallback) · `routed`. */
  why: 'no_config' | 'no_match' | 'routed';
}

function parse(body: unknown): { text: string; provider: string; hasAttachment: boolean; conversationKind?: string } {
  const b = (body ?? {}) as { text?: unknown; provider?: unknown; hasAttachment?: unknown; conversationKind?: unknown };
  if (typeof b.text !== 'string' || b.text.length > MAX_PREVIEW_CHARS) {
    throw new OpenwopError('validation_error', `\`text\` MUST be a string of at most ${MAX_PREVIEW_CHARS} characters.`, 400, { field: 'text' });
  }
  if (typeof b.provider !== 'string' || !isRoutableProvider(b.provider)) {
    throw new OpenwopError('validation_error', '`provider` MUST be a routable provider.', 400, { field: 'provider' });
  }
  if (b.hasAttachment !== undefined && typeof b.hasAttachment !== 'boolean') {
    throw new OpenwopError('validation_error', '`hasAttachment` MUST be a boolean.', 400, { field: 'hasAttachment' });
  }
  if (b.conversationKind !== undefined && b.conversationKind !== 'group' && b.conversationKind !== 'workspace' && b.conversationKind !== 'channel') {
    throw new OpenwopError('validation_error', '`conversationKind` MUST be one of group | workspace | channel.', 400, { field: 'conversationKind' });
  }
  return {
    text: b.text,
    provider: b.provider,
    hasAttachment: b.hasAttachment === true,
    ...(typeof b.conversationKind === 'string' ? { conversationKind: b.conversationKind } : {}),
  };
}

export async function previewRoute(tenantId: string, body: unknown): Promise<RoutePreview> {
  const input = parse(body);
  const stored = await getRouterConfig(tenantId);
  if (!stored) return { enabled: false, decision: null, why: 'no_config' };
  // The feature vector the exchange builds (`resolveTurnModelRoute`), with the
  // imagined conversation's provider as the one it can dispatch.
  const features: TurnFeatures = {
    tokenEstimate: Math.ceil(input.text.length / 4),
    dispatchProvider: input.provider,
    ...(input.conversationKind ? { conversationKind: input.conversationKind } : {}),
    ...(input.hasAttachment ? { hasAttachment: true } : {}),
  };
  const decision = routeTurn(features, stored.config, listedModelCapabilities, 0);
  return { enabled: stored.enabled, decision, why: decision ? 'routed' : 'no_match' };
}
