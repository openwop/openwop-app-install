/**
 * ADR 0873 D1 — a feature's offline declaration. Data, not code.
 *
 * A feature declares it in a data-only sibling of the module the registry
 * imports, `src/features/<dir>/offline.ts`:
 *
 *   import type { FeatureOffline } from '../../sw/offlineTypes.js';
 *   export const offline: FeatureOffline = { navigations: ['/books'] };
 *
 * and sets the same object on its `FrontendFeature` (`offline`). The build reads
 * the file (it cannot evaluate React route modules); the runtime reads the field.
 * `src/sw/__tests__/offlineDeclarations.test.ts` pins the two together, so keep
 * the file to `import type` only. `scripts/gen-service-worker.mjs` holds every
 * rule; no feature writes worker code.
 */
export interface FeatureOffline {
  /** Route paths that get the cached shell when the network is unreachable. A
   *  path covers itself and everything below it. Each must be under a path this
   *  feature owns (a `routes[].path`, or one its `publicRoutes[].match` accepts),
   *  and none may touch a Cloud Run rewrite (D4). Literal paths only. */
  navigations: string[];
  /** Extra non-hashed build-output files to precache beyond the shell and the
   *  feature's chunk graph (D6), e.g. marks and fonts under `public/`. Exact
   *  paths; globs are not allowed. */
  precache?: string[];
  /** Same-origin static paths only (never a navigation, never D4). `match` is a
   *  Firebase-style glob. */
  runtime?: { match: string; strategy: 'swr' | 'network-first'; maxEntries: number }[];
  /** D12. Absent = 'fail-closed' (the default). */
  entitlement?: 'fail-closed' | 'last-known';
}
