/**
 * `spec/v2/core/runs.md` §Snapshot — "`getRun` returns
 * `schemas/v2/run-snapshot.schema.json` … the object is CLOSED."
 *
 * v1's `RunSnapshot` is `additionalProperties: true` and this host uses that:
 * it carries nine host-extension fields on the snapshot (`parentRunId`,
 * `parentSeq`, `forkMode`, `parentNodeId`, `inputs`, `removalAt`, `pinned`,
 * `costUsd`, `costByNode`) plus `childRuns` and `interrupt` added by the route.
 * v2 closed the object and registered no vendor seat on it, so under major 2
 * every one of them MUST come off the wire or the snapshot fails its own
 * schema.
 *
 * THE ALLOWLIST IS READ FROM THE ARTIFACT, NEVER RETYPED. The set is the
 * `properties` keys of the vendored `schemas/v2/run-snapshot.schema.json`, so a
 * corpus bump that adds a field moves this filter with it. A literal copy would
 * be correct on the day it was written and drift on the first bump — the same
 * discipline `middleware/protocolVersion.ts` applies to the v2 error registry.
 *
 * WHAT THIS COSTS, STATED. `parentRunId` and `inputs` are not host extensions in
 * spirit — the v1 wire carries them, `:fork` ancestry is read off the first and
 * RFC 0022 §A's input projection off the second — but v2's closed snapshot
 * declares neither, so a major-2 caller cannot see them. Reported upstream
 * rather than smuggled through `metadata`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from './_repoPath.js';

let cached: ReadonlySet<string> | undefined;

/** The `properties` of `schemas/v2/run-snapshot.schema.json`, or `null` when the corpus is absent. */
function v2SnapshotFields(): ReadonlySet<string> | null {
  if (cached !== undefined) return cached.size > 0 ? cached : null;
  try {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const doc = JSON.parse(readFileSync(join(dir, 'v2', 'run-snapshot.schema.json'), 'utf8')) as {
      properties?: Record<string, unknown>;
    };
    cached = new Set(Object.keys(doc.properties ?? {}));
  } catch {
    // A deploy without the vendored corpus still serves major 1 correctly; the
    // v2 snapshot then goes out unfiltered, which is what it did yesterday.
    cached = new Set<string>();
  }
  return cached.size > 0 ? cached : null;
}

/** Test seam — the artifact is read once per process. */
export function resetV2SnapshotFieldsCache(): void {
  cached = undefined;
}

/** Drop every key the closed v2 `RunSnapshot` does not declare. */
export function closeV2Snapshot<T extends object>(snapshot: T): T {
  const fields = v2SnapshotFields();
  if (fields === null) return snapshot;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (fields.has(k)) out[k] = v;
  }
  return out as T;
}
