/**
 * Boot-eager triggers for the CORE-page walkthrough action packs (ADR 0378 P4).
 * The pages themselves are lazy routes, so registering from the page module
 * would leave a walkthrough launched from /walkthroughs with an unregistered
 * actionId (needs-update) until the user happened to visit the page. Each pack
 * stays its own lazy CHUNK (nothing lands in the entry bundle); this module
 * only fires the imports at boot. Feature-packaged surfaces (campaign-brief)
 * keep registering from their own routes module instead.
 */
export function registerCoreWalkthroughPacks(): void {
  // P4 continuation — the remaining core-routed P0 render-case spotlights,
  // one lazy chunk for the whole set.
  void Promise.all([import('./pageSpotlight.js'), import('./corePageSpotlights.js')]).then(([m, spec]) => {
    for (const [actionId, route, anchor] of spec.CORE_PAGE_SPOTLIGHTS) m.registerPageSpotlight(actionId, route, anchor);
  });
  void import('../agents/walkthroughActions.js').then((m) => m.registerAgentsWalkthroughActions());
  void import('../builder/walkthroughActions.js').then((m) => m.registerWorkflowsWalkthroughActions());
  void import('../runs/walkthroughActions.js').then((m) => m.registerRunsWalkthroughActions());
  void import('../byok/walkthroughActions.js').then((m) => m.registerKeysWalkthroughActions());
}
