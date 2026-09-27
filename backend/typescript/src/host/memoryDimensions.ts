/**
 * RFC 0080 — the reconciled memory-capability model (§A) and the degraded
 * projection it requires on the agent inventory (§C).
 *
 * ONE module derives BOTH halves. That is the whole point of the RFC, and it is
 * also what RFC 0080's own `Updated:` field records as the reason the reference
 * adopter's implementation is trustworthy: *"single source of truth
 * `host/memoryDimensions.ts` drives BOTH the advertisement and the
 * projection"*. Two derivations would be two claims about one subsystem, and
 * the failure mode is silent — a host that advertises `long-term-durability`
 * while its projection stamps agents as lacking it (or the reverse) is lying to
 * a consumer in a way no schema catches.
 *
 * The construction that makes the drift IMPOSSIBLE rather than merely detected:
 * `satisfiedMemoryDimensions()` reads the dimensions off `memoryCapability()` —
 * the very object `routes/discovery.ts` puts on the wire — instead of
 * re-testing the same env vars. A future PR that advertises `memory.search` or
 * `memory.retention` moves the dimension set with it, with no edit here.
 *
 * WHERE THIS SITS. It is the sibling of `host/agentCapabilities.ts`, which owns
 * the RFC 0072 §C `degraded[]` field. Deliberately NOT merged into it: that
 * module's vocabulary is host-SURFACE keys (`host.memory`, `host.kvStorage`)
 * matched against `listHostSurfaces()`; this one's is the CLOSED eight-name
 * RFC 0080 §A dimension enum from `agent-inventory-response.schema.json`.
 * Different vocabularies, different wire fields, different specs. They compose
 * at the one place that needs both — `routes/agents.ts` `toEntry`.
 *
 * @see RFCS/0080-agent-memory-capability-reconciliation.md §A / §C
 * @see spec/v1/agent-memory.md §"Memory capability model"
 * @see schemas/agent-inventory-response.schema.json (`degradedMemoryDimensions`)
 * @see docs/adr/0041-subject-memory.md §H51
 */

import { resolveBackendId, MEMORY_BACKEND } from './surfaceBackends.js';

/**
 * The CLOSED RFC 0080 §A dimension vocabulary — byte-identical to the
 * `degradedMemoryDimensions` enum in `agent-inventory-response.schema.json`.
 *
 * NOT the `memoryShape` keys (RFC 0080 UQ2 resolved it that way explicitly), and
 * NOT the `agents.memoryBackends` values: the dimension is
 * `long-term-durability` while the backend id is `long-term`, a distinction the
 * schema calls deliberate so "a degraded-dimension list and a backend list never
 * collide on the wire".
 *
 * Pinned against the corpus schema by `test/memory-dimensions.test.ts`, which
 * reads the enum out of `@openwop/openwop-conformance` rather than restating it
 * — a hand-copied restatement agrees with a drift for as long as the drift
 * exists.
 */
export const MEMORY_DIMENSIONS = [
  'read',
  'write',
  'search',
  'long-term-durability',
  'compaction',
  'attribution',
  'replay-snapshot',
  'retention',
] as const;

export type MemoryDimension = (typeof MEMORY_DIMENSIONS)[number];

/** The RFC 0003 `AgentManifest.memoryShape` descriptor, as the inventory sees it. */
export interface MemoryShapeLike {
  scratchpad?: boolean | undefined;
  conversation?: boolean | undefined;
  longTerm?: boolean | undefined;
}

/** The RFC 0080 §C projection fields on an inventory entry. Both OPTIONAL:
 *  §C-1 says absent ⇒ memory fully satisfied. */
export interface MemoryDegradedProjection {
  memoryDegraded?: true;
  degradedMemoryDimensions?: MemoryDimension[];
}

/**
 * Does `listMemoryEntries` honour RFC 0004 §A's run-start snapshot rule
 * (*"`list` MUST return the snapshot of entries visible at run start"*)?
 *
 * **No — and that is why the §A `replay-snapshot` derivation is not the bare
 * formula.** §A derives the dimension as `memoryBackends: ["long-term"]` +
 * `multiAgent.executionModel.version >= 2`, both of which this host CAN satisfy
 * (the durable memory tier plus any phase-2 boot). But
 * `host/inMemorySurfaces.ts listMemoryEntries` filters by TTL, tag, recency and
 * the RFC 0113 budget — never by a run-start logical timestamp — so a mid-run
 * write by another run IS visible to the calling run. Deriving the dimension
 * from the formula alone would advertise a replay determinism this host does not
 * provide, on a boot that merely sets two env vars.
 *
 * The `executionModel.version` term is deliberately NOT consulted below: the
 * conjunction is already false here, and reading it would duplicate
 * `routes/discovery.ts`'s phase ladder as a second source of truth for a term
 * that cannot change the answer.
 *
 * Ratcheted by `test/memory-dimensions.test.ts`, which derives the absence FROM
 * THE SOURCE: implement the snapshot and that test goes red until this constant
 * flips. A bare `false` with a comment would rot silently.
 *
 * Typed `boolean` rather than left as the `false` literal so the conjunction
 * below stays a real runtime test instead of narrowing to dead code.
 */
const LIST_HONORS_RUN_START_SNAPSHOT: boolean = false;

/**
 * Is this host's RFC 0004 memory a CROSS-RUN DURABLE store?
 *
 * The `long-term-durability` dimension is advertised by
 * `capabilities.agents.memoryBackends` including `"long-term"`. Read from the
 * surface seam rather than hard-coded, exactly as `effectiveImplementation`
 * computes the surface `implementation` tags — the default `memory` backend is
 * process-local (its own surface note says "restarts wipe state") and only a
 * registered real backend (`OPENWOP_SURFACE_MEMORY=durable`, or a global
 * `OPENWOP_SURFACE_BACKEND`) survives a restart. Deriving the claim from the
 * thing that makes it true is what keeps it from going stale when the tier
 * changes.
 *
 * Moved here from `routes/discovery.ts` (H49 authored it there) so "is memory
 * durable" has ONE owner that both the `memoryBackends` advert and the §C
 * projection read.
 */
export function longTermMemoryDurable(): boolean {
  return resolveBackendId('memory') !== MEMORY_BACKEND;
}

/** The `capabilities.memory` family, exactly as `/.well-known/openwop` serves it. */
export interface MemoryCapability {
  supported: boolean;
  writable?: boolean;
  search?: { supported: boolean; modes?: readonly ('semantic' | 'filter')[] };
  attribution?: { supported: boolean; emitsWriteEvents: boolean };
  compaction?: { supported: boolean; trigger: 'both' };
  distillation?: { supported: boolean };
  retention?: { ttl?: boolean; forget?: boolean };
  injectionBudget?: { supported: boolean; tokenCounter: 'chars' };
}

/**
 * Build the `capabilities.memory` advertisement.
 *
 * `supported: true` (H51). RFC 0080 §A/§B: the flag advertises the HOST-INTERNAL
 * four-op `MemoryAdapter` plus the SR-1-redacted read side — NOT a portable
 * client query path (§B adds no `GET /v1/memory`). All four ops are wired in
 * `host/inMemorySurfaces.ts`: `list` = `listMemoryEntries`, `get` =
 * `getMemoryEntry`, `put` = `writeMemoryEntry`/`writeMemoryEntryRedacted`,
 * `delete` = `removeMemoryEntry`; the agent-facing port
 * (`host/subjectMemory.ts createSubjectMemoryPort`) exposes read+write and
 * `host/agentDispatch.ts` really drives both. H49 landed the three invariants
 * the flag binds a host to — CTI-1 (`isWellFormedMemoryRef`, fail-closed), SR-1
 * (`writeMemoryEntryRedacted`, the write-time redaction §A's `put` requires) and
 * TTL (expired entries never surface). Before H49 the flag was honestly `false`;
 * between H49 and H51 it was a NAMED under-claim, held back only because §C was
 * unimplemented. It is neither now.
 *
 * `writable` is OMITTED, not set. RFC 0080 UQ1 resolved absence as WRITABLE (the
 * RFC 0004 four-op default), and the RFC's own positive example omits it. Three
 * reasons this matters beyond style: this host genuinely writes and deletes, so
 * `writable: false` would be a false statement; `lib/profiles.ts isMemory()`
 * WITHHOLDS the derived `openwop-memory` profile from a `writable: false` host;
 * and under §A an unsatisfied `write` dimension would stamp EVERY agent with a
 * `memoryShape` as degraded — manufacturing a non-vacuous degraded branch out of
 * an untrue claim, which is exactly the fabrication RFC 0080's amended
 * acceptance criterion commends the first adopter for refusing.
 *
 * `search` and `retention` stay OMITTED and therefore honestly unsatisfied
 * below. Ranking here is recency-only, so per RFC 0113 `rank:"relevance"` is not
 * offered. TTL and delete-by-subject DO exist (`notExpired`,
 * `clearSubjectMemory`), so `retention` is an available honesty flip — with its
 * own blast radius, tracked as residue in ADR 0041 §H51 rather than smuggled in
 * here.
 */
export function memoryCapability(): MemoryCapability {
  const compactionEnabled = process.env.OPENWOP_TEST_TRIGGER_COMPACTION === 'true';
  return {
    supported: true,
    // RFC 0057 — the host attributes its host-internal writes via the
    // content-free `memory.written` event, independent of the adapter contract.
    attribution: { supported: true, emitsWriteEvents: true },
    // RFC 0012 — the host distills its internal longTerm entries into one
    // SR-1-redacted archive + emits `memory.compacted`, but the ONLY trigger is
    // the `/v1/test/memory/{seed,compact}` seam. Advertise compaction ONLY when
    // that seam is reachable, never on a default deploy.
    ...(compactionEnabled ? { compaction: { supported: true, trigger: 'both' as const } } : {}),
    // RFC 0113 — the memory read (`GET /v1/host/openwop-app/memory`) honours a
    // `tokenBudget` bounding the cumulative SIZE of the returned set
    // (over-budget entries omitted whole, never truncated). The unit is content
    // CHARS, declared honestly as `tokenCounter: "chars"`.
    injectionBudget: { supported: true, tokenCounter: 'chars' as const },
  };
}

/**
 * The §A dimensions this host satisfies RIGHT NOW, on the tier it is booted on.
 *
 * Read OFF the advertisement rather than re-derived from the same env vars, so
 * the advertised model and the projected model cannot disagree by construction.
 * The one dimension with no advertised source — `replay-snapshot`, which §A
 * derives — is handled explicitly above.
 */
export function satisfiedMemoryDimensions(): ReadonlySet<MemoryDimension> {
  const mem = memoryCapability();
  const satisfied = new Set<MemoryDimension>();

  // read / write — the RFC 0004 four-op contract, gated by `memory.supported`.
  // `writable: false` withdraws only the write half (§A: "a read-only host sets
  // `memory.writable: false`").
  if (mem.supported) {
    satisfied.add('read');
    if (mem.writable !== false) satisfied.add('write');
  }
  if (mem.search?.supported === true) satisfied.add('search');
  // long-term-durability — the ONE dimension that moves with the deployed tier,
  // and the one every `memoryShape.longTerm` agent depends on.
  if (longTermMemoryDurable()) satisfied.add('long-term-durability');
  if (mem.compaction?.supported === true || mem.distillation?.supported === true) {
    satisfied.add('compaction');
  }
  if (mem.attribution?.supported === true) satisfied.add('attribution');
  if (LIST_HONORS_RUN_START_SNAPSHOT && satisfied.has('long-term-durability')) {
    satisfied.add('replay-snapshot');
  }
  if (mem.retention?.ttl === true || mem.retention?.forget === true) satisfied.add('retention');

  return satisfied;
}

/**
 * The §A dimensions an agent's `memoryShape` REQUESTS.
 *
 * The mapping is the one `agent-inventory-response.schema.json` states
 * normatively: *"`longTerm`⇒`long-term-durability`,
 * `scratchpad`/`conversation`⇒`write`+`read` as applicable"*. `longTerm`
 * carries `read`+`write` too — RFC 0004 §A binds `memoryBackends` to the
 * four-op adapter, and a durable store you can neither read nor write is not a
 * capability an agent could be said to have received.
 *
 * This is why only THREE of the eight names can ever reach the wire from this
 * projection: `search`, `compaction`, `attribution`, `replay-snapshot` and
 * `retention` are not requestable through a `memoryShape`, and inventing a
 * mapping for them would be this host asserting a §C contract the spec does not
 * define. They stay in the model (§A is a model of the host, not of one agent)
 * and out of the projection.
 *
 * STRICT `=== true`. A pack's `memoryShape` reaches here through
 * `packs/agentLoader.ts`, which casts raw JSON, so a malformed
 * `{ longTerm: "yes" }` is reachable. A non-boolean is not a declaration — it is
 * an RFC 0003 §C manifest defect that `agent-manifest.schema.json` rejects at
 * publish/install time (the §D *reject* lane, disjoint from this §C *degrade*
 * lane). Treating a truthy string as a request would let a malformed manifest
 * author a degraded-dimension list on the wire.
 */
export function requestedMemoryDimensions(shape: MemoryShapeLike | undefined): MemoryDimension[] {
  if (!shape || typeof shape !== 'object') return [];
  const requested = new Set<MemoryDimension>();
  if (shape.scratchpad === true || shape.conversation === true || shape.longTerm === true) {
    requested.add('read');
    requested.add('write');
  }
  if (shape.longTerm === true) requested.add('long-term-durability');
  return closeAndOrderDimensions(requested);
}

/**
 * RFC 0080 §C — the degraded projection for ONE inventory entry.
 *
 * Returns `{}` (both fields ABSENT) when memory is fully satisfied: §C-1 says
 * *"Absent ⇒ memory fully satisfied"*, and absence is the shape the RFC's own
 * back-compat paragraph is written around. `memoryDegraded: false` would also
 * validate, but it says "this host computed the projection and found nothing",
 * a distinction §C does not draw and no consumer can act on.
 *
 * §C-1 also makes the pair an iff: a stamped entry MUST carry a NON-EMPTY
 * `degradedMemoryDimensions`. That holds structurally here — the stamp is
 * emitted only from a non-empty `unmet`, and `unmet` is a subset of
 * `MEMORY_DIMENSIONS` because the requested set is built from that union type.
 * Closed-world by construction, not by validation.
 *
 * PURE and deterministic — a read-only function of (memoryShape, host model),
 * as RFC 0080's acceptance amendment characterises it. No clock, no I/O, no
 * per-caller state, so the inventory stays replay-stable and two callers on one
 * boot always agree.
 */
export function projectMemoryDegradation(shape: MemoryShapeLike | undefined): MemoryDegradedProjection {
  const satisfied = satisfiedMemoryDimensions();
  const unmet = requestedMemoryDimensions(shape).filter((d) => !satisfied.has(d));
  if (unmet.length === 0) return {};
  return { memoryDegraded: true, degradedMemoryDimensions: unmet };
}

/**
 * CLOSE and order. Two jobs, and the first one is load-bearing.
 *
 * **Close** — filtering `MEMORY_DIMENSIONS` (rather than spreading `dims`) is
 * what makes the §A enum closed in PRACTICE and not merely by convention: a name
 * the mapper somehow collected but the spec does not define cannot reach the
 * wire, whatever a cast or a future edit does upstream. Measured, not assumed —
 * sabotage C3 made `requestedMemoryDimensions` emit `longTerm` and the bad name
 * never left this function; only disabling this filter too (C3b) let the corpus
 * scenario see it. Exported so that closure has a behavioral test rather than
 * resting on the mapper staying careful.
 *
 * **Order** — the §A declaration order, never alphabetical, so an inventory diffs
 * cleanly across deploys.
 *
 * Do NOT "simplify" this to `[...dims]`. It would preserve the ordering job for
 * most inputs and silently drop the closure.
 */
export function closeAndOrderDimensions(dims: ReadonlySet<MemoryDimension>): MemoryDimension[] {
  return MEMORY_DIMENSIONS.filter((d) => dims.has(d));
}
