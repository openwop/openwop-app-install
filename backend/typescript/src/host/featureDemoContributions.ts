/**
 * ADR 1031 — feature contributions to the demo / example-data program.
 *
 * The host's demo lists (`EXAMPLE_DATA_SEEDERS`, `DEMO_FEATURE_TOGGLE_IDS`,
 * `ACKNOWLEDGED_UNSEEDED`) are hand-kept arrays in host modules. A feature that
 * lives outside this repo (an adopter's `src/adopter/features/<id>/`) cannot
 * edit them, so it DECLARES its part on `BackendFeature.demo` and
 * `registerBackendFeatures` records it here at boot — the same "feature
 * declares, boot consumes" shape as `registerFeatureDependencies`.
 *
 * A registry module rather than a read of `BACKEND_FEATURES`: the seeding
 * modules would otherwise import the whole feature graph, and the feature graph
 * already imports them.
 *
 * Empty in openwop-app today — no first-party feature declares `demo` yet.
 */
import type { ExampleDataSeeder } from './exampleDataSeeders.js';
import type { FeatureDemoContribution } from '../features/types.js';

const byFeature = new Map<string, FeatureDemoContribution>();

/** Record one feature's contribution. Re-registering a feature replaces it (hot reload). */
export function registerFeatureDemo(featureId: string, demo: FeatureDemoContribution): void {
  byFeature.set(featureId, demo);
}

/** Feature-contributed seeders, in registration (registry) order. */
export function featureDemoSeeders(): ExampleDataSeeder[] {
  return [...byFeature.values()].flatMap((d) => [...(d.seeders ?? [])]);
}

/** Feature-contributed demo toggles, deduplicated, in registration order. */
export function featureDemoToggleIds(): string[] {
  return [...new Set([...byFeature.values()].flatMap((d) => [...(d.enableToggles ?? [])]))];
}

/**
 * Compose the host seeders with the feature-contributed ones. A feature seeder
 * whose id collides with another seeder throws: the example-data route selects
 * steps by id, so a duplicate would make one of them unreachable.
 */
export function composeExampleDataSeeders(host: readonly ExampleDataSeeder[]): ExampleDataSeeder[] {
  const contributed = featureDemoSeeders();
  if (contributed.length === 0) return [...host];
  const seen = new Set(host.map((s) => s.id));
  for (const s of contributed) {
    if (seen.has(s.id)) throw new Error(`duplicate example-data seeder id '${s.id}' (ADR 1031) — a feature's demo.seeders must not reuse a host or another feature's seeder id`);
    seen.add(s.id);
  }
  return [...host, ...contributed];
}

/** Test seam. */
export function clearFeatureDemoContributions(): void {
  byFeature.clear();
}
