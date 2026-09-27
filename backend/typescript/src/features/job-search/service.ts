/**
 * ADR 0539 D0 — the ONE job-search vertical: one package, one toggle, one bundle.
 *
 * Every module of this package (`domain/`, `boards/`, `agent/`, `attestation/`,
 * `autopilot/`, `lifecycle/`) gates on THIS toggle. Four toggles were considered
 * and rejected: `isSellableBundleFeature` gates entitlement per FEATURE id, so a
 * buyer could hold one and not another and get a product that half-works.
 *
 * @see docs/adr/0539-job-search-vertical-strategy.md
 */

/** The single toggle id for the whole vertical. Stable — it is also the bundle's
 *  only member in `distributions/bundles.json`, and the `feature.job-search.*`
 *  pack namespace. */
export const JOB_SEARCH_TOGGLE = 'job-search';

/** Human label, reused by the toggle registry and the marketplace card. */
export const JOB_SEARCH_LABEL = 'Job search';
