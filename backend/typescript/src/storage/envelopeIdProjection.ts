/**
 * Supply the envelope's `nodeId` / `runId` INTO the payload on a major-2 read,
 * for the types whose corpus `$def` requires them there (ADR 0702).
 *
 * **Why this is needed at all.** `spec/v2/run-event-payloads.schema.json` is
 * validated payload-object-alone — the corpus's own scenarios compile the `$def`
 * and call `validate({...payload})`, with no envelope merge anywhere (see
 * `voice-event-payloads-shape.test.ts`). So `outputChunk`'s
 * `required: [nodeId, runId, chunk, isLast]` binds the PAYLOAD, and this host's
 * `{chunk, isLast}` does not satisfy it. The envelope carrying those ids is
 * irrelevant to a validator that never sees the envelope.
 *
 * MEASURED (`scripts/audit-event-payloads.mjs`, full backend suite): six
 * host-emitted types were missing a required `nodeId` — `output.chunk`,
 * `interrupt.resolved`, `node.started`, `node.completed`, `node.suspended`,
 * `approval.overridden` — and `output.chunk` was missing `runId` too. Across the
 * whole corpus **22 defs require `nodeId` and 3 require `runId`**, so this is a
 * class, not six call sites. Fixing it at six emit sites would have left the
 * other sixteen waiting to be discovered one at a time.
 *
 * **Why a READ projection rather than changing the writers.**
 *
 * - It repairs HISTORY. Every row already written gets the ids, including the
 *   ~1273 era-2 rows this host may not rewrite (`persistence.md`: "A host MUST
 *   NOT rewrite era-2 rows in place"). A writer fix would only ever help events
 *   written after the deploy.
 * - It cannot affect replay or fork. Nothing persisted changes, so a fork's
 *   copied prefix is byte-identical to its parent's and both sides project the
 *   same way — the argument `projectV2OwnerEcho` already makes in this file for
 *   the owner block.
 * - It is scoped to `contract === 2`, which is the only place the v2 `$def`
 *   governs. A major-1 read is untouched.
 *
 * **What it will NOT do**: add a key to a payload whose def does not declare it.
 * Every def here is `additionalProperties: false`, so injecting `nodeId` into a
 * type that does not declare it would turn a valid payload into an invalid one —
 * the mirror of the defect being fixed. The type sets below are derived FROM the
 * schema's own `required` lists, never hand-listed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateRepoSchemasDir } from '../host/_repoPath.js';

interface PayloadsDoc {
  $defs?: Record<string, { required?: unknown } & Record<string, unknown>>;
}

let cached: { nodeId: ReadonlySet<string>; runId: ReadonlySet<string> } | null = null;

/**
 * Types whose `$def` lists `nodeId` / `runId` in `required`, derived from the
 * vendored schema at first use and cached like the codemap beside it.
 */
export function typesRequiringEnvelopeIds(): { nodeId: ReadonlySet<string>; runId: ReadonlySet<string> } {
  if (cached !== null) return cached;
  const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'run-event.schema.json');
  const doc = JSON.parse(readFileSync(join(dir, 'v2', 'run-event-payloads.schema.json'), 'utf8')) as PayloadsDoc;
  const defs = doc.$defs ?? {};
  const index = (defs['_typeIndex'] as { properties?: Record<string, { $ref?: string }> } | undefined)?.properties ?? {};
  const nodeId = new Set<string>();
  const runId = new Set<string>();
  for (const [type, entry] of Object.entries(index)) {
    const ref = typeof entry?.$ref === 'string' ? entry.$ref.replace(/^#\/\$defs\//, '') : undefined;
    const def = ref === undefined ? undefined : defs[ref];
    const required = Array.isArray(def?.required) ? (def.required as unknown[]) : [];
    if (required.includes('nodeId')) nodeId.add(type);
    if (required.includes('runId')) runId.add(type);
  }
  if (nodeId.size === 0) {
    // Fail LOUD, the same argument as `orgsFromDeclaration` (ADR 0687): an empty
    // set here is not "no type needs this", it is "the schema was unreadable",
    // and letting it read as the former silently disables the projection while
    // every check still passes.
    throw new Error('run-event-payloads.schema.json named no type requiring nodeId — the payload schema is unreadable');
  }
  cached = { nodeId, runId };
  return cached;
}

/**
 * Project one event's payload for a major-2 read.
 *
 * Returns the payload UNCHANGED (same reference) when there is nothing to add,
 * so the common case allocates nothing and a caller can cheaply tell whether
 * anything happened. An id already present is never overwritten: the payload's
 * own value wins, because a producer that set it deliberately knows something
 * the envelope does not.
 */
export function projectEnvelopeIds(
  type: string,
  payload: unknown,
  envelope: { runId: string; nodeId?: string },
): unknown {
  const { nodeId: wantsNode, runId: wantsRun } = typesRequiringEnvelopeIds();
  const needsNode = wantsNode.has(type) && envelope.nodeId !== undefined;
  const needsRun = wantsRun.has(type);
  if (!needsNode && !needsRun) return payload;
  // Only an object payload has room for a key. A `null` or scalar payload is a
  // different defect and not this function's to mask — returning it
  // unchanged lets the validator report it honestly.
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const addNode = needsNode && p['nodeId'] === undefined;
  const addRun = needsRun && p['runId'] === undefined;
  if (!addNode && !addRun) return payload;
  return {
    ...p,
    ...(addNode ? { nodeId: envelope.nodeId } : {}),
    ...(addRun ? { runId: envelope.runId } : {}),
  };
}
