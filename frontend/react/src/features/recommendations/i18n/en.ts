/**
 * `recommendations` namespace (ADR 0273 / MERCH-A) — user-facing copy.
 * Feature-self-contained; generic actions (delete/save/cancel) reuse `common:`.
 */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Recommendation placements belong to an organization',
  orgsFailedClause: 'The placement list was never requested',
  orgsRetry: 'Try again',
  rowsFailedTitle: 'Could not load placements',
  rowsFailedBody: 'This is a failed read, not an empty list — it does not mean no placements are configured.',
  eyebrow: 'Business',
  title: 'Recommendations',
  lede: 'Upsell, cross-sell & frequently-bought-together placements across the funnel.',

  notEnabledTitle: 'Recommendations are not enabled',
  notEnabledBody: 'Ask an administrator to turn on the Recommendations feature in Admin → Feature toggles.',
  noPlacementsTitle: 'No placements yet',
  noPlacementsBody: 'Add a placement above to bind a storefront slot (PDP, cart, post-purchase…) to a recommendation source.',

  captionPlacements: 'Placements',
  colSlot: 'Slot',
  colSource: 'Source',
  colSegment: 'Segment',
  colHoldout: 'Holdout',
  colActive: 'Status',
  active: 'Active',
  paused: 'Paused',
  pause: 'Pause',
  activate: 'Activate',
  untargeted: 'Everyone',

  fieldSlot: 'Placement slot',
  fieldSource: 'Recommendation source',
  fieldHoldout: 'Holdout %',
  fieldSegment: 'Segment (optional)',
  fieldAnchor: 'Anchor product id (optional)',
  segmentPlaceholder: 'CRM segment id to target',
  anchorPlaceholder: 'Product id the shopper is viewing',
  fieldPreviewContact: 'Preview as contact (optional)',
  fieldPreviewContactHelp: 'A CRM contact id. Segment-targeted placements only match a real contact, so leave this blank to see what an anonymous shopper gets.',
  previewContactPlaceholder: 'CRM contact id',
  previewUnresolvedSegment: 'A placement targets segment {{ids}}, which no longer resolves — it is being skipped, so those shoppers fall through to the next placement or to nothing.',
  previewHoldoutInert: 'This placement declares a holdout, but this preview carries no shopper session, so the holdout is not being applied here. Live traffic needs a session identity for the control arm to exist.',
  previewSegmentTargeted: 'The {{slot}} slot has an active placement, but it targets a segment — so it only matches a real contact. Enter a contact id above to preview it.',
  previewSegmentNotMatched: 'That contact is not in the segment this slot’s placement targets, so they would see nothing here. Try a contact who is in it, or leave the field blank to see what an anonymous shopper gets.',

  addPlacement: 'Add placement',
  rebuildAffinity: 'Rebuild affinity',
  preview: 'Preview',
  previewTitle: 'Preview a slot',

  previewEmpty: 'No recommendations resolved for this slot yet — add orders or a placement, then rebuild affinity.',
  affinityFreshness: "Affinity data computed {{when}}.",
  previewControl: 'This session is in the holdout control cohort, so it sees no recommendations (by design).',

  slot_pdp: 'Product page',
  slot_cart: 'Cart',
  slot_checkout: 'Checkout',
  slot_post_purchase: 'Post-purchase',
  slot_category: 'Category',
  slot_home: 'Home',
  slot_oos_404: 'Out-of-stock / 404',

  source_bought_together: 'Frequently bought together',
  source_cross_sell: 'Cross-sell',
  source_upsell: 'Upsell',
  source_similar: 'Similar products',
  source_trending: 'Trending',

  toggleActiveLabel: 'Toggle the {{slot}} placement active state',
  deleteRowLabel: 'Delete the {{slot}} placement',
  deleteConfirm: 'Delete the {{slot}} placement?',

  placementAdded: 'Placement added.',
  placementDeleted: 'Placement deleted.',
  affinityRebuilt: 'Affinity rebuilt ({{rows}} products).',
  affinityRebuiltWithRemovals: 'Affinity rebuilt ({{rows}} products; {{removed}} stale entries removed).',
  loadFailed: 'Failed to load placements.',
  addFailed: 'Failed to add the placement.',
  updateFailed: 'Failed to update the placement.',
  deleteFailed: 'Failed to delete the placement.',
  rebuildFailed: 'Failed to rebuild affinity.',
  previewFailed: 'Failed to preview recommendations.',
  previewNoPlacement: "No active placement matches the {{slot}} slot, so this slot shows nothing on the storefront. Add a placement above.",
  previewServedBy: "Served by {{source}}",
  previewVariant: "variant {{variant}}",
  fieldHoldoutHelp: "Share of shoppers who see NO recommendations here, so lift can be measured against them.",
} as const;
