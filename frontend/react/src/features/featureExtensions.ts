/**
 * ADR 1031 P2 — the reader for feature declarations that only LAZY surfaces use:
 * dashboard tiles (`dashboard/allTiles.ts`), review renderers
 * (`chat/reviews/reviewArtifactRenderers.tsx`), review-card sections
 * (`chat/reviews/ReviewCard.tsx`), chat run-header workflow names
 * (`chat/hooks/chatSession/useTurnTransport.ts`) and card-owned BYOK ref prefixes
 * (`byok/KeysPage.tsx`).
 *
 * A feature declares them on `FrontendFeature.lazyExtensions`
 * (`() => import('./extensions.js').then((m) => m.extensions)`), so its entry-chunk cost is that one line;
 * the declarations, their lazy wrappers and their matchers load with the surfaces
 * that read them. This module is imported only by those (lazy) surfaces, and its
 * top-level await resolves every composed feature's extension chunk once, before
 * any of them evaluates, so the accessors below stay synchronous. The registry
 * starts those fetches right after the first paint, so the await normally finds
 * them loaded. A chunk that fails to load contributes nothing: no renderer, no
 * section, no name (the host default), no prefix (the ref stays listed).
 *
 * The sync `FrontendFeature.dashboardTiles` / `reviewArtifactRenderers` fields
 * (ADR 1031 P1) still work and come first, in registry order.
 */
import { i18n } from '../i18n/index.js';
import {
  applyFeatureNavMessages,
  FRONTEND_FEATURES,
  type FeatureLazyExtensions,
  type FeatureReviewArtifactRenderer,
  type FeatureReviewCardSection,
  type FrontendFeature,
} from './registry.js';
import type { DashboardTileDef } from './dashboard/tileTypes.js';

/** Each feature with its loaded lazy declarations, in registry order. */
export async function loadFeatureExtensions(
  features: readonly FrontendFeature[] = FRONTEND_FEATURES,
): Promise<Array<{ feature: FrontendFeature; ext: FeatureLazyExtensions }>> {
  return Promise.all(features.map(async (feature) => ({
    feature,
    ext: feature.lazyExtensions ? await feature.lazyExtensions().catch((): FeatureLazyExtensions => ({})) : {},
  })));
}

const LOADED = await loadFeatureExtensions();

// Lazy nav copy (ADR 1031 P2): merged into `nav` exactly as the eager `navMessages`
// are (same prefix rule, no overwrite), before any surface that imports this module
// renders — the admin rail imports it for that reason.
applyFeatureNavMessages(
  LOADED.map(({ feature, ext }) => ({ id: feature.id, ...(ext.navMessages ? { navMessages: ext.navMessages } : {}) })),
  (locale, messages) => i18n.addResourceBundle(locale, 'nav', messages, true, false),
);

/** ADR 1031 — dashboard tiles, appended to the host's by `dashboard/allTiles.ts`. */
export function featureDashboardTiles(): DashboardTileDef[] {
  return LOADED.flatMap(({ feature, ext }) => [...(feature.dashboardTiles ?? []), ...(ext.dashboardTiles ?? [])]);
}

/** ADR 1031 — review renderers; the ADR 0459 registry registers them on first lookup. */
export function featureReviewArtifactRenderers(): FeatureReviewArtifactRenderer[] {
  return LOADED.flatMap(({ feature, ext }) => [...(feature.reviewArtifactRenderers ?? []), ...(ext.reviewArtifactRenderers ?? [])]);
}

/** ADR 1031 P2 — review-card sections, rendered after the host's own. */
export function featureReviewCardSections(): FeatureReviewCardSection[] {
  return LOADED.flatMap(({ ext }) => [...(ext.reviewCardSections ?? [])]);
}

/** ADR 1031 P2 — a feature's display name for `workflowId` in `lng`, falling back
 *  to its `en` name (as the catalog lookup falls back to `en`); '' when none. */
export function featureWorkflowName(workflowId: string, lng: string): string {
  for (const { ext } of LOADED) {
    const n = ext.chatWorkflowNames?.[lng]?.[workflowId] ?? ext.chatWorkflowNames?.en?.[workflowId];
    if (n) return n;
  }
  return '';
}

/** ADR 1031 P2 — BYOK ref prefixes owned by a feature's card. */
export function featureCardOwnedCredentialRefPrefixes(): string[] {
  return LOADED.flatMap(({ ext }) => [...(ext.cardOwnedCredentialRefPrefixes ?? [])]);
}
