/**
 * ADR 0718 D3 × ADR 1031 — the duplicate-route-path contract, as a pure function so
 * the rule is testable apart from the manifest it guards (`features.tsx` calls it at
 * import).
 *
 * Two features declaring one path is a collision: one surface is unreachable. The
 * host keeps its own shrink-only `KNOWN_PATH_COLLISIONS` (empty since TST-OAR-2). An
 * ADOPTER composes its features into the same manifest and may claim a host path on
 * purpose. Example: KickTodo's site-tier `kicktodo-engagement` owns `/leaderboard`, and
 * its distribution build ships no `evals`. It records that decision in its OWN file
 * (`src/adopter/chrome/knownPathCollisions.ts`, which upstream never writes), so the
 * guard stays on in every tree and the exception is explicit where its owner can see it.
 *
 * An adopter entry excuses a collision only when:
 *   - it names the path and EXACTLY the colliding owner set (a third claimant is new);
 *   - at least one of those owners is the adopter's own feature (an adopter cannot
 *     excuse two host features colliding: that is upstream's bug to fix);
 *   - it gives a non-empty reason.
 * An entry that excuses nothing (the collision is gone, or the owners changed) is
 * STALE and fails too. Same shrink-only rule as the host list: a waiver cannot
 * outlive its reason.
 */

export interface AdopterKnownPathCollision {
  readonly path: string;
  readonly owners: readonly string[];
  readonly reason: string;
}

export interface PathCollisionVerdict {
  /** Collisions nothing excuses, as `path <- a, b`. */
  readonly unexpected: string[];
  /** Adopter entries that are malformed, stale, or try to excuse a host-only pair. */
  readonly invalidAdopterEntries: string[];
}

const ownerKey = (owners: readonly string[]): string => [...owners].sort().join('\u0000');

export function checkPathCollisions(
  routes: ReadonlyArray<{ readonly path: string; readonly ownerFeatureId?: string }>,
  hostKnown: ReadonlySet<string>,
  adopterKnown: readonly AdopterKnownPathCollision[],
  adopterFeatureIds: ReadonlySet<string>,
): PathCollisionVerdict {
  const byPath = new Map<string, string[]>();
  for (const r of routes) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r.ownerFeatureId ?? '(core)']);
  const collisions = [...byPath.entries()].filter(([, owners]) => owners.length > 1);

  const invalidAdopterEntries: string[] = [];
  const excused = new Set<string>();
  for (const e of adopterKnown) {
    const label = `${e.path} <- ${[...e.owners].join(', ')}`;
    if (!e.reason || !e.reason.trim()) { invalidAdopterEntries.push(`${label}: no reason given`); continue; }
    if (!e.owners.some((o) => adopterFeatureIds.has(o))) {
      invalidAdopterEntries.push(`${label}: no owner is an adopter feature, so this is a host collision to fix upstream`);
      continue;
    }
    const live = collisions.find(([path, owners]) => path === e.path && ownerKey(owners) === ownerKey(e.owners));
    if (!live) { invalidAdopterEntries.push(`${label}: STALE (no such collision now); delete the entry`); continue; }
    excused.add(e.path);
  }

  const unexpected = collisions
    .filter(([path]) => !hostKnown.has(path) && !excused.has(path))
    .map(([path, owners]) => `${path} <- ${owners.join(', ')}`);
  return { unexpected, invalidAdopterEntries };
}

/** Read the adopter's declarations from an eager glob of its optional module. */
export function collectAdopterKnownPathCollisions(modules: Readonly<Record<string, unknown>>): AdopterKnownPathCollision[] {
  const out: AdopterKnownPathCollision[] = [];
  for (const [file, mod] of Object.entries(modules)) {
    const list = (mod as { KNOWN_PATH_COLLISIONS?: unknown } | undefined)?.KNOWN_PATH_COLLISIONS;
    if (!Array.isArray(list)) throw new Error(`${file} must export KNOWN_PATH_COLLISIONS: AdopterKnownPathCollision[] (ADR 0718 × ADR 1031)`);
    for (const e of list as unknown[]) {
      const v = e as Partial<AdopterKnownPathCollision>;
      if (typeof v?.path !== 'string' || !Array.isArray(v.owners) || typeof v.reason !== 'string') {
        throw new Error(`${file}: each KNOWN_PATH_COLLISIONS entry needs { path, owners[], reason } (ADR 0718 × ADR 1031)`);
      }
      out.push({ path: v.path, owners: v.owners.map(String), reason: v.reason });
    }
  }
  return out;
}
