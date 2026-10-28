/**
 * PACK PINS (ADR 0919) — the ONE place a feature's required pack is pinned to a
 * version. A `BackendFeature` declares only the pack NAMES it requires
 * (`requiredPacks: ['feature.crm.nodes']`); the version is resolved here, lazily,
 * by the code that actually needs it: the boot installer (only for a pack it must
 * install, ADR 0919 correction),
 * the Plugins console (`getFeaturePacks`), the marketplace, and the pin-parity
 * tests.
 *
 * WHY NOT IN THE DESCRIPTOR. Every `createApp()` test references every feature's
 * descriptor at boot (`registerBackendFeatures`), so an edit anywhere inside one
 * re-ran ~1,150 of ~2,640 backend test files under Tracegate (ADR 0880). In the
 * 7 days to 2026-10-18, 20 of the 44 commits that touched a `feature.ts` changed
 * ONLY a pin. Here, a pin bump re-runs only the tests that resolve a pin.
 *
 * Keep this a plain object literal of string literals (`as const`): that is what
 * makes it a constant to Tracegate rather than a module-load statement. One
 * version per pack name: two features requiring the same pack share its pin, as
 * they already did (no pack was ever pinned at two versions).
 *
 * Bumping a pack? Bump its `pack.json`, then its line here. The pin-parity tests
 * (`required-packs-pin-parity.test.ts` and the per-feature ones) fail until both
 * agree.
 */
import type { PackRef } from './types.js';

export const PACK_PINS = {
  'core.openwop.hitl': '1.0.1',
  'core.openwop.mcp': '1.1.3',
  'feature.accessibility.nodes': '1.0.1',
  'feature.advisory-board.nodes': '1.0.1',
  'feature.agent-author.nodes': '1.2.0',
  'feature.agent-knowledge.nodes': '1.5.1',
  'feature.analytics.nodes': '1.1.2',
  'feature.app-builder.artifact-types': '1.1.1',
  'feature.app-builder.nodes': '1.10.1',
  'feature.assistant.nodes': '2.0.1',
  'feature.bi.nodes': '1.0.1',
  'feature.brand.nodes': '1.4.0',
  'feature.cad.nodes': '1.6.1',
  'feature.campaign-brief.nodes': '1.6.0',
  'feature.campaign-channels.nodes': '1.16.0',
  'feature.campaign-connectors.nodes': '1.6.0',
  'feature.campaign-intel.nodes': '1.7.0',
  'feature.campaign-journeys.nodes': '1.9.0',
  'feature.campaign-orchestration.nodes': '1.7.0',
  'feature.campaign-ops.nodes': '1.3.0',
  'feature.campaign-autopilot.nodes': '1.1.0',
  'feature.campaign-playbooks.nodes': '1.0.0',
  'feature.campaign-studio.nodes': '1.0.2',
  'feature.cdp.nodes': '1.1.1',
  'feature.cms.nodes': '1.7.0',
  'feature.code-exec.nodes': '1.2.0',
  'feature.comments.nodes': '1.2.1',
  'feature.commerce-connect.nodes': '1.0.2',
  'feature.commerce.buyer.nodes': '1.2.0',
  'feature.commerce.nodes': '1.5.0',
  'feature.computer-use.nodes': '1.1.2',
  'feature.consent.nodes': '1.2.1',
  'feature.creative-briefs.nodes': '1.4.0',
  'feature.creative-video.nodes': '1.3.0',
  'feature.crm.nodes': '1.15.0',
  'feature.csm.nodes': '1.5.0',
  'feature.dealers.nodes': '1.0.1',
  'feature.destination-sync.nodes': '1.0.1',
  'feature.discovery.nodes': '1.0.1',
  'feature.docs.nodes': '1.0.1',
  'feature.documents.nodes': '1.4.0',
  'feature.drawings.nodes': '1.0.1',
  'feature.email.nodes': '1.3.0',
  'feature.entities.nodes': '1.1.1',
  'feature.evals.nodes': '1.1.0',
  'feature.experiments.nodes': '1.4.0',
  'feature.forms.nodes': '1.2.1',
  'feature.funnels.nodes': '1.5.0',
  'feature.insights-suite.nodes': '1.2.1',
  'feature.interactive-artifacts.nodes': '1.0.1',
  'feature.job-search.nodes': '1.1.1',
  'feature.kb.nodes': '1.3.0',
  'feature.kicktodo.nodes': '1.38.0',
  'feature.marketplace.nodes': '1.1.1',
  'feature.media.nodes': '1.0.1',
  'feature.notebooks.nodes': '1.1.1',
  'feature.orgs.nodes': '1.0.1',
  'feature.podcasts.nodes': '1.2.0',
  'feature.priority-matrix.nodes': '1.5.1',
  'feature.production.nodes': '1.2.0',
  'feature.profiles.nodes': '1.2.0',
  'feature.promotions.nodes': '1.0.1',
  'feature.prompts.nodes': '1.1.2',
  'feature.recommendations.nodes': '1.0.1',
  'feature.sales-commissions.nodes': '1.2.0',
  'feature.service-desk.nodes': '1.1.0',
  'feature.slides.nodes': '1.1.3',
  'feature.strategy.nodes': '1.3.2',
  'feature.territories.nodes': '1.2.1',
  'feature.tool-output-compaction.nodes': '1.2.1',
  'feature.users.nodes': '1.0.2',
  'feature.walkthroughs.nodes': '1.0.1',
  'feature.webinars.nodes': '1.0.2',
  'feature.whatsapp.nodes': '1.0.1',
  'feature.work-selection.nodes': '1.0.1',
  'feature.workflow-author.nodes': '1.1.0',
  'vendor.openwop-app.accessibility.agents': '1.0.1',
  'vendor.openwop-app.agent-author.agents': '1.2.0',
  'vendor.openwop-app.analytics.agents': '1.0.2',
  'vendor.openwop-app.app-builder.agents': '1.3.2',
  'vendor.openwop-app.assistant.agents': '1.0.5',
  'vendor.openwop-app.brand.agents': '1.0.3',
  'vendor.openwop-app.cad.agents': '1.5.2',
  'vendor.openwop-app.campaign-brief.agents': '1.3.3',
  'vendor.openwop-app.campaign-channels.agents': '1.2.2',
  'vendor.openwop-app.campaign-intel.agents': '1.4.0',
  'vendor.openwop-app.campaign-orchestration.agents': '1.4.2',
  'vendor.openwop-app.campaign-studio.agents': '1.1.0',
  'vendor.openwop-app.career-agent.agents': '1.0.1',
  'vendor.openwop-app.cms.agents': '1.1.2',
  'vendor.openwop-app.code-exec.agents': '1.0.1',
  'vendor.openwop-app.comments.agents': '1.0.5',
  'vendor.openwop-app.commerce.agents': '1.2.2',
  'vendor.openwop-app.commerce.buyer.agents': '1.0.4',
  'vendor.openwop-app.computer-use.agents': '1.0.3',
  'vendor.openwop-app.crm.agents': '1.1.2',
  'vendor.openwop-app.csm.agents': '1.3.0',
  'vendor.openwop-app.dealers.agents': '1.0.3',
  'vendor.openwop-app.discovery.agents': '1.0.3',
  'vendor.openwop-app.documents.agents': '1.1.0',
  'vendor.openwop-app.drawings.agents': '1.0.3',
  'vendor.openwop-app.email.agents': '1.1.0',
  'vendor.openwop-app.forms.agents': '1.1.2',
  'vendor.openwop-app.funnels.agents': '1.2.0',
  'vendor.openwop-app.insights-suite.agents': '1.1.2',
  'vendor.openwop-app.interactive-artifacts.agents': '1.0.2',
  'vendor.openwop-app.kb.agents': '1.0.3',
  'vendor.openwop-app.kicktodo.agents': '1.9.4',
  'vendor.openwop-app.marketplace.agents': '1.0.3',
  'vendor.openwop-app.notebooks.agents': '1.0.2',
  'vendor.openwop-app.podcasts.agents': '1.0.2',
  'vendor.openwop-app.priority-matrix.agents': '1.0.2',
  'vendor.openwop-app.production.agents': '1.0.2',
  'vendor.openwop-app.promotions.agents': '1.0.2',
  'vendor.openwop-app.recommendations.agents': '1.0.2',
  'vendor.openwop-app.sales-commissions.agents': '1.0.3',
  'vendor.openwop-app.service-desk.agents': '1.0.2',
  'vendor.openwop-app.slides.agents': '1.1.2',
  'vendor.openwop-app.strategy.agents': '1.0.2',
  'vendor.openwop-app.territories.agents': '1.0.3',
  'vendor.openwop-app.voice.agents': '1.0.1',
  'vendor.openwop-app.whatsapp.agents': '1.0.1',
  'vendor.openwop-app.workflow-author.agents': '1.4.0',
} as const satisfies Readonly<Record<string, string>>;

let resolutions = 0;
/** Test seam (ADR 0919 correction): how many pins have been resolved in this
 *  process. A plain `createApp()` boot with its packs on disk must resolve 0. */
export function pinResolutionCount(): number { return resolutions; }

/** The pinned ref for one required pack. Throws on a name with no pin: a feature
 *  that requires a pack nobody pinned is a configuration error.
 *  CORRECTED (ADR 0919): boot no longer resolves every pin. It resolves only a
 *  pack it must install, so a missing pin on a present pack is caught by
 *  `required-packs-pin-parity.test.ts`, which resolves every feature's pins, and
 *  not at boot. */
export function pinnedPackRef(name: string): PackRef {
  resolutions += 1;
  const version = (PACK_PINS as Readonly<Record<string, string>>)[name];
  if (version === undefined) throw new Error(`pack_pin_missing: ${name} is a requiredPacks name with no entry in features/packPins.ts`);
  return { name, version };
}

/** A feature's required packs with their pins, in declaration order. */
export function featureRequiredPacks(feature: { readonly requiredPacks?: readonly string[] }): PackRef[] {
  return (feature.requiredPacks ?? []).map(pinnedPackRef);
}
