/**
 * The `config.memoryAction` driver — RFC 0004 / RFC 0113 memory probes (H49).
 *
 * WHY THIS SHAPE. The OpenWOP corpus expresses its memory conformance scenarios
 * through a fixture convention rather than a dedicated node type: a
 * `core.identity` node carrying `config.memoryAction`, whose results the host
 * MUST surface as run VARIABLES the scenario reads back off `GET /v1/runs/{id}`.
 * The typeId is PINNED by the vendored fixtures, so this cannot be a new typeId
 * of our own — `core.identity` delegates here when the config key is present
 * (`bootstrap/nodes.ts`), exactly as it already branches on
 * `config.emitDuplicateMessageId`. The probe logic lives in its own module
 * beside the rest of the conformance-node family
 * (`conformanceMockAgent.ts` / `conformanceSideEffectNode.ts` /
 * `conformanceA2aInvokeNode.ts` / `conformanceMcpInvokeNode.ts`).
 *
 * NO PARALLEL MEMORY SYSTEM. Every action drives the host's REAL memory
 * subsystem — `host/inMemorySurfaces.ts` §"RFC 0004 memory" — through the same
 * `writeMemoryEntryRedacted` / `listMemoryEntries` / `getMemoryEntry` /
 * `clearMemoryScope` entry points the HTTP read routes and the executor's
 * run-summary write use. A probe that reimplemented storage, TTL filtering,
 * budgeting or tenant scoping would witness itself instead of the host, which is
 * the failure mode this whole task exists to close.
 *
 * GATED. `identityNode` only delegates when `conformanceNodesEnabled()`, and
 * `implementedMemoryActions()` below — the SINGLE source of truth, consumed by
 * both the dispatch branch and the fixture advert in `host/index.ts` — reads the
 * same switch. So "advertised ⟺ executable" holds under both deploy postures
 * and cannot drift. The gate is on the PROBE, not on the memory subsystem: the
 * probe fabricates entries and (for CTI-1) writes into a synthetic foreign
 * tenant, which is the `mockAiNode` class of demo machinery, while the
 * subsystem itself stays production-real and ungated.
 *
 * FAIL CLOSED. Each handler verifies its own preconditions and returns a TYPED
 * FAILURE when they do not hold, rather than surfacing an empty variable that a
 * scenario might read as success. That matters because two of the five corpus
 * scenarios have blind spots — MEASURED, not assumed (H49 ran each against a
 * deliberately sabotaged probe):
 *
 *   - `agentMemoryCrossTenantIsolation` is vacuous OUTRIGHT. It falls through to
 *     `expect(probe).toBeFalsy()`, and `undefined` is falsy — so a host that
 *     surfaces NOTHING passes. Confirmed: with all five actions reverted to a
 *     pass-through, the other four scenarios went red and this one stayed GREEN.
 *   - `agentMemoryTtlExpiry` is vacuous NARROWLY. It asserts
 *     `Array.isArray(memoryList)` and then loops, so an EMPTY ARRAY passes while
 *     an UNSET variable fails. Confirmed both ways: a pass-through host fails it,
 *     but a host that surfaces `memoryList: []` — an over-aggressive TTL filter,
 *     or a write that silently did nothing — passes it clean.
 *
 * (An earlier draft of this comment claimed the TTL scenario "cannot fail" at
 * all. That was wrong and the sabotage run falsified it; the distinction between
 * unset and empty is the whole of it.)
 *
 * The non-vacuous halves live in `test/conformance-memory-probe.test.ts`: for
 * TTL, that the fresh entry is PRESENT as well as the expired one absent; for
 * CTI-1, a positive control proving the foreign row existed before its absence
 * means anything.
 *
 * @see spec/v1/agent-memory.md §CTI-1, §SR-1, §"TTL semantics", §"Injection budget"
 * @see docs/adr/0041-subject-memory.md §"H49 — the `config.memoryAction` seam"
 */

import {
  writeMemoryEntry,
  writeMemoryEntryRedacted,
  listMemoryEntries,
  getMemoryEntry,
  clearMemoryScope,
  type MemoryRow,
} from '../host/inMemorySurfaces.js';
import { registerRunSecret } from '../byok/ephemeralRunSecrets.js';
import { conformanceNodesEnabled } from './conformanceMockAgent.js';
import { createLogger } from '../observability/logger.js';
import type { NodeContext, NodeOutcome } from '../executor/types.js';

const log = createLogger('bootstrap.conformanceMemoryProbe');

/**
 * The synthetic tenant the CTI-1 probe seeds into. Deliberately carries a
 * character class no real tenant id can (`!`) plus an unmistakable name, so it
 * can never collide with a live tenant, and is asserted un-mintable in
 * `test/conformance-memory-probe.test.ts`. Its rows are dropped in a `finally`.
 */
const CTI1_FOREIGN_TENANT = 'conformance!foreign-tenant';

/** BYOK secret the SR-1 probe falls back to when the fixture names none. The
 *  host pre-provisions this under `OPENWOP_TEST_SEAM_ENABLED` (`src/index.ts`),
 *  which the conformance lane sets. */
const SR1_FALLBACK_SECRET_ID = 'openwop-conformance-canary-secret';

/** Deterministic ISO timestamps so a probe run is byte-stable under replay. */
const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
const at = (offsetSeconds: number): string => new Date(EPOCH + offsetSeconds * 1000).toISOString();

function configOf(ctx: NodeContext): Record<string, unknown> {
  const cfg = ctx.config;
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
}

function stringConfig(ctx: NodeContext, key: string): string | undefined {
  const v = configOf(ctx)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numberConfig(ctx: NodeContext, key: string): number | undefined {
  const v = configOf(ctx)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The memory scope a probe operates on. `AgentRef.memoryRef` per
 * `agent-memory.md` §"`memoryRef` resolution" when the fixture declares an
 * agent; otherwise a deterministic per-node fallback so an agent-less fixture
 * (the CTI-1 one declares no agent) still has a stable scope of its own and can
 * never touch another probe's rows.
 */
function probeScope(ctx: NodeContext): string {
  return ctx.nodeAgent?.memoryRef ?? `conformance/memory-probe/${ctx.nodeId}`;
}

/** Project a stored row into the wire shape `schemas/memory-entry.schema.json`
 *  declares. Explicit rather than a spread so a future internal column cannot
 *  silently reach a scenario as part of a "MemoryEntry". */
function toMemoryEntry(row: MemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    content: row.content,
    tags: row.tags,
    createdAt: row.createdAt,
    ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
  };
}

function setVar(ctx: NodeContext, name: string, value: unknown): void {
  ctx.variables?.set(name, value);
}

function failure(code: string, message: string): NodeOutcome {
  return { status: 'failure', error: { code, message } };
}

/**
 * Resolve the FIRST of `candidates` that the BYOK resolver serves for this
 * run's tenant, returning both the id and the value. Each candidate is resolved
 * at most once — deciding "which id won" by re-resolving would race a rotation
 * and could redact the persisted content against a value that is no longer the
 * one the run actually saw.
 */
async function resolveFirstSecret(
  ctx: NodeContext,
  candidates: readonly string[],
): Promise<{ secretId: string; value: string } | null> {
  const { resolveSecret } = await import('../byok/secretResolver.js');
  const seen = new Set<string>();
  for (const secretId of candidates) {
    if (seen.has(secretId)) continue;
    seen.add(secretId);
    const value = await resolveSecret(secretId, { tenantId: ctx.tenantId });
    if (value) return { secretId, value };
  }
  return null;
}

/**
 * RFC 0057 §B — attribute each probe write on the event log, content-free.
 * This host advertises `memory.attribution.emitsWriteEvents: true`, so a write
 * path that did not emit would make a standing advert false.
 */
async function emitWritten(ctx: NodeContext, memoryRef: string, row: MemoryRow): Promise<void> {
  await ctx.emit('memory.written', {
    memoryRef,
    memoryId: row.id,
    nodeId: ctx.nodeId,
    tags: row.tags,
  });
}

// ── the actions ─────────────────────────────────────────────────────────────

/**
 * `write-then-read` (`conformance-agent-memory-roundtrip`) — RFC 0004 §
 * `MemoryAdapter`. Writes one entry through the host write path, then reads it
 * back through `MemoryAdapter.get` and surfaces the MemoryEntry as
 * `memoryReadback`.
 */
async function writeThenRead(ctx: NodeContext): Promise<NodeOutcome> {
  const memoryRef = probeScope(ctx);
  const written = await writeMemoryEntryRedacted(
    ctx.tenantId,
    memoryRef,
    {
      content: 'conformance round-trip entry: the host resolved this memoryRef and read it back.',
      tags: ['conformance', 'memory-roundtrip'],
      createdAt: at(0),
    },
    ctx.runId,
  );
  await emitWritten(ctx, memoryRef, written);

  // Read back through the ADAPTER, not from the write's return value — the
  // point of the scenario is that resolution works, and echoing the write
  // would pass with a broken read path.
  const readback = await getMemoryEntry(ctx.tenantId, memoryRef, written.id);
  if (!readback) {
    return failure(
      'memory_readback_failed',
      `write-then-read: entry ${written.id} was written to ${memoryRef} but MemoryAdapter.get returned null`,
    );
  }
  setVar(ctx, 'memoryReadback', toMemoryEntry(readback));
  return { status: 'success', outputs: { memoryId: readback.id, memoryRef } };
}

/**
 * `redaction-probe` (`conformance-agent-memory-redaction`) — SR-1. Resolves a
 * BYOK secret, registers it in the run keyring, writes an entry whose content
 * EMBEDS the plaintext, and reads back. The persisted content must carry
 * `[REDACTED:<secretId>]`.
 *
 * The probe asserts the redaction itself and fails typed if the plaintext
 * survived — it must never persist an unredacted secret and report success,
 * and it must never report success on a write that silently did nothing.
 */
async function redactionProbe(ctx: NodeContext): Promise<NodeOutcome> {
  const memoryRef = probeScope(ctx);
  const secretId = stringConfig(ctx, 'byokSecretId') ?? SR1_FALLBACK_SECRET_ID;

  // Try the fixture-named id first, then the host-provisioned canary. A fixture
  // may name a secret id this host does not provision; falling back keeps the
  // SR-1 witness real rather than skipping it, and the FAILURE below keeps it
  // honest when neither resolves. Resolved ONCE per id — re-resolving to decide
  // which id won would race a rotation and could redact against a stale value.
  const resolved = await resolveFirstSecret(ctx, [secretId, SR1_FALLBACK_SECRET_ID]);
  if (!resolved) {
    return failure(
      'credential_unavailable',
      `redaction-probe: neither '${secretId}' nor the host canary '${SR1_FALLBACK_SECRET_ID}' resolved for tenant ${ctx.tenantId}; SR-1 cannot be witnessed without a resolved secret`,
    );
  }
  const { secretId: effectiveSecretId, value } = resolved;

  // Register into the run keyring — the spec's per-run MemorySecretRegistry.
  // This is what makes the write-side redaction see the value at all.
  registerRunSecret(ctx.runId, effectiveSecretId, value);

  const written = await writeMemoryEntryRedacted(
    ctx.tenantId,
    memoryRef,
    {
      content: `conformance SR-1 probe. The run resolved a BYOK secret and this sentence contained it: ${value} — it MUST NOT be persisted.`,
      tags: ['conformance', 'memory-redaction', 'sr-1'],
      createdAt: at(0),
    },
    ctx.runId,
  );
  await emitWritten(ctx, memoryRef, written);

  const readback = await getMemoryEntry(ctx.tenantId, memoryRef, written.id);
  if (!readback) {
    return failure(
      'memory_readback_failed',
      `redaction-probe: entry ${written.id} was written to ${memoryRef} but MemoryAdapter.get returned null`,
    );
  }
  // Fail CLOSED on a redaction miss. Surfacing the variable and letting the
  // scenario decide would mean persisting a live secret to witness that we
  // persist live secrets.
  if (readback.content.includes(value)) {
    return failure(
      'sr1_redaction_failed',
      `redaction-probe: SR-1 violated — the persisted entry under ${memoryRef} still contains the resolved plaintext for '${effectiveSecretId}'`,
    );
  }
  if (!readback.content.includes(`[REDACTED:${effectiveSecretId}]`)) {
    return failure(
      'sr1_marker_missing',
      `redaction-probe: the plaintext is gone but the canonical [REDACTED:${effectiveSecretId}] marker is absent — agent-memory.md §SR-1 requires the marker, not silent stripping`,
    );
  }
  setVar(ctx, 'memoryReadback', toMemoryEntry(readback));
  return { status: 'success', outputs: { memoryId: readback.id, memoryRef } };
}

/**
 * `ttl-probe` (`conformance-agent-memory-ttl`) — §"TTL semantics". Writes one
 * ALREADY-EXPIRED entry and one future-dated entry, then lists.
 *
 * NON-VACUITY. The corpus scenario only checks that any entry it sees carrying
 * `expiresAt` is future-dated, which an empty list satisfies. So the probe
 * itself asserts BOTH halves — the expired id absent AND the fresh id present —
 * and fails typed otherwise. Without the second half, a read path that returned
 * nothing at all would look like correct TTL filtering.
 */
async function ttlProbe(ctx: NodeContext): Promise<NodeOutcome> {
  const memoryRef = probeScope(ctx);
  // Isolate: the assertions below are exact, so a previous run's rows in this
  // scope would make them wrong.
  await clearMemoryScope(ctx.tenantId, memoryRef);

  const expired = await writeMemoryEntryRedacted(
    ctx.tenantId,
    memoryRef,
    {
      content: 'conformance TTL probe: this entry is already expired and MUST NOT surface.',
      tags: ['conformance', 'memory-ttl', 'expired'],
      createdAt: at(0),
      // Absolute, in the past. No relative ttlSeconds can express this.
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
    ctx.runId,
  );
  const fresh = await writeMemoryEntryRedacted(
    ctx.tenantId,
    memoryRef,
    {
      content: 'conformance TTL probe: this entry is live and MUST surface.',
      tags: ['conformance', 'memory-ttl', 'fresh'],
      createdAt: at(1),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    ctx.runId,
  );
  await emitWritten(ctx, memoryRef, expired);
  await emitWritten(ctx, memoryRef, fresh);

  const listed = await listMemoryEntries(ctx.tenantId, memoryRef);
  const ids = listed.map((r) => r.id);
  if (ids.includes(expired.id)) {
    return failure(
      'ttl_expired_entry_surfaced',
      `ttl-probe: entry ${expired.id} is past its expiresAt but MemoryAdapter.list still returned it — agent-memory.md §"TTL semantics" is violated`,
    );
  }
  // The half the corpus scenario cannot check. An empty list is NOT a pass.
  if (!ids.includes(fresh.id)) {
    return failure(
      'ttl_fresh_entry_missing',
      `ttl-probe: the future-dated entry ${fresh.id} did not surface, so the empty/filtered result proves nothing about TTL filtering`,
    );
  }
  setVar(ctx, 'memoryList', listed.map(toMemoryEntry));
  // Suite 1.136.1 (corpus S35) made this scenario TWO-SIDED: it now reads the
  // ids of both written entries and requires fresh ∈ list ∧ expired ∉ list. The
  // host lands them under exactly these names.
  setVar(ctx, 'freshId', fresh.id);
  setVar(ctx, 'expiredId', expired.id);
  return { status: 'success', outputs: { memoryRef, expiredId: expired.id, freshId: fresh.id } };
}

/**
 * `cross-tenant-probe` (`conformance-agent-memory-cross-tenant` v1.1) — CTI-1.
 *
 * THREE-SIDED, and each side is load-bearing. Reading an empty scope returns
 * `[]` on a host with NO isolation whatsoever, so "the cross-tenant read was
 * empty" is on its own worth nothing. Two independent positive controls make it
 * mean something:
 *
 *  1. **OWNER side** (`ownerEntryId` / `ownerProbe`, required by suite 1.136.1 /
 *     corpus S35) — write one entry under the RUN'S OWN tenant at
 *     `agent.memoryRef` and list it back. A non-empty `ownerProbe` proves the
 *     adapter is genuinely being exercised, so an empty cross-tenant read is not
 *     just "this host's reads return nothing".
 *  2. **FOREIGN side** (this host's addition) — seed the probe ref under a
 *     synthetic OTHER tenant and prove that tenant can see its own row. This is
 *     the stronger control for CTI-1 specifically: it proves the row the caller
 *     must not see actually EXISTS, so the caller's empty read is a refusal
 *     rather than an empty store. It is the construction §CTI-1(2) prescribes.
 *  3. **THE INVARIANT** — the same ref read as the running tenant MUST be empty.
 *
 * Any failed precondition is a TYPED FAILURE, never a green with an empty
 * variable. Before S35 the scenario accepted an UNSET `crossTenantProbe`, so a
 * host ignoring `memoryAction` entirely passed a critical-tier invariant
 * vacuously — measured here, fixed upstream in openwop#1062.
 *
 * The owner ref (`agent.memoryRef`) and the foreign ref (`config.probeMemoryRef`)
 * are DIFFERENT scopes in v1.1, so the two sides cannot contaminate each other.
 */
async function crossTenantProbe(ctx: NodeContext): Promise<NodeOutcome> {
  const ownerRef = probeScope(ctx);
  const probeRef = stringConfig(ctx, 'probeMemoryRef') ?? `${ownerRef}/another-tenant`;
  if (ctx.tenantId === CTI1_FOREIGN_TENANT) {
    return failure(
      'cti1_probe_misconfigured',
      `cross-tenant-probe: the running tenant IS the synthetic foreign tenant, so the probe would compare a scope against itself`,
    );
  }
  if (ownerRef === probeRef) {
    return failure(
      'cti1_probe_misconfigured',
      `cross-tenant-probe: the owner ref and the cross-tenant probe ref are the same scope (${ownerRef}), so the owner control and the isolation assertion would contradict each other`,
    );
  }
  try {
    // ── 1. OWNER SIDE (S35 positive control) ────────────────────────────────
    await clearMemoryScope(ctx.tenantId, ownerRef);
    const ownerEntry = await writeMemoryEntryRedacted(
      ctx.tenantId,
      ownerRef,
      {
        content: "conformance CTI-1 owner control: this entry belongs to the run's own tenant and MUST be readable.",
        tags: ['conformance', 'memory-cross-tenant', 'cti-1', 'owner'],
        createdAt: at(0),
      },
      ctx.runId,
    );
    await emitWritten(ctx, ownerRef, ownerEntry);
    const ownerProbe = await listMemoryEntries(ctx.tenantId, ownerRef);
    if (!ownerProbe.some((r) => r.id === ownerEntry.id)) {
      return failure(
        'cti1_owner_entry_not_readable',
        `cross-tenant-probe: the run's own tenant cannot read the entry it just wrote to ${ownerRef}, so an empty cross-tenant read would prove nothing about isolation`,
      );
    }

    // ── 2. FOREIGN SIDE (this host's stronger control) ──────────────────────
    const seeded = await writeMemoryEntry(CTI1_FOREIGN_TENANT, probeRef, {
      content: 'conformance CTI-1 probe: this entry belongs to another tenant and MUST NOT cross the boundary.',
      tags: ['conformance', 'memory-cross-tenant', 'cti-1'],
      createdAt: at(0),
    });
    const foreignSide = await listMemoryEntries(CTI1_FOREIGN_TENANT, probeRef);
    const seedVisibleToItsOwnTenant = foreignSide.some((r) => r.id === seeded.id);
    if (!seedVisibleToItsOwnTenant) {
      return failure(
        'cti1_seed_not_visible_to_owner',
        `cross-tenant-probe: the seeded entry ${seeded.id} is not readable by the tenant that owns it, so an empty cross-tenant read would be an empty store rather than evidence of isolation`,
      );
    }

    // ── 3. THE INVARIANT: same ref, different tenant ⇒ nothing ──────────────
    const crossed = await listMemoryEntries(ctx.tenantId, probeRef);
    const leaked = crossed.filter((r) => r.id === seeded.id);
    if (leaked.length > 0) {
      return failure(
        'cti1_cross_tenant_leak',
        `cross-tenant-probe: CTI-1 violated — tenant ${ctx.tenantId} read ${leaked.length} entr(ies) belonging to another tenant under ${probeRef}`,
      );
    }

    setVar(ctx, 'ownerEntryId', ownerEntry.id);
    setVar(ctx, 'ownerProbe', ownerProbe.map(toMemoryEntry));
    setVar(ctx, 'crossTenantProbe', crossed.map(toMemoryEntry));
    // Host-specific extra: the foreign-side control. Named for what it actually
    // asserts, so it cannot be confused with the corpus's owner-side control.
    setVar(ctx, 'foreignSeedVisibleToItsOwnTenant', seedVisibleToItsOwnTenant);
    return { status: 'success', outputs: { ownerMemoryRef: ownerRef, probeMemoryRef: probeRef, leaked: leaked.length } };
  } finally {
    // Never leave a foreign-tenant row behind. Under the durable memory tier it
    // would outlive the process, and cross-tenant litter in a store is worse
    // than in a Map.
    try {
      await clearMemoryScope(CTI1_FOREIGN_TENANT, probeRef);
    } catch (err) {
      log.warn('cti-1 probe cleanup failed', { err: String(err) });
    }
  }
}

/**
 * `list-budgeted` (`conformance-agent-memory-injection-budget`) — RFC 0113.
 *
 * Seeds a set whose total exceeds the budget AND that contains one entry larger
 * than the WHOLE budget, plus a BYOK-redacted entry (SR-1 re-assertion on the
 * budgeted path) and a cross-tenant seed (CTI-1 re-assertion), then drives the
 * real budgeted read.
 *
 * `recencyOrder` / `relevanceOrder` are deliberately LEFT UNSET. RFC 0113 clause
 * 3: `rank:'relevance'` DELEGATES to `memory.search` semantic (RFC 0080), and a
 * host that does not advertise it "MUST NOT silently fabricate a relevance
 * ranking". This host advertises recency only, so the scenario's relevance leg
 * soft-skips — an omitted variable is honest; a fabricated ordering would be an
 * over-claim.
 */
async function listBudgeted(ctx: NodeContext): Promise<NodeOutcome> {
  const memoryRef = probeScope(ctx);
  const tokenBudget = numberConfig(ctx, 'tokenBudget') ?? 800;
  if (tokenBudget <= 0) {
    return failure('invalid_request', `list-budgeted: config.tokenBudget must be a positive number, got ${tokenBudget}`);
  }
  // Three DISJOINT scopes. The main slice, the lone-over-budget scope, and the
  // cross-tenant scope must not share rows, or each assertion would be reading
  // the others' seed data.
  const loneRef = `${memoryRef}/lone-over-budget`;
  const crossRef = `${memoryRef}/cross-tenant`;
  await clearMemoryScope(ctx.tenantId, memoryRef);
  await clearMemoryScope(ctx.tenantId, loneRef);
  await clearMemoryScope(ctx.tenantId, crossRef);

  const resolved = await resolveFirstSecret(ctx, [SR1_FALLBACK_SECRET_ID]);
  if (!resolved) {
    return failure(
      'credential_unavailable',
      `list-budgeted: the host canary '${SR1_FALLBACK_SECRET_ID}' did not resolve, so the SR-1 re-assertion on the budgeted path cannot be witnessed`,
    );
  }
  registerRunSecret(ctx.runId, resolved.secretId, resolved.value);

  // Seed OLDEST first — the read ranks newest-first, so the LAST write heads the
  // ranked list. RFC 0113 returns a PREFIX, so placement is load-bearing:
  //
  //  - the over-budget entry is seeded OLDEST, i.e. it sorts LAST. An
  //    over-budget entry at the HEAD would terminate the prefix immediately and
  //    the correct answer would be the empty slice — leaving nothing to observe
  //    for SR-1. Its head-position behaviour is witnessed separately, in the
  //    dedicated `loneRef` scope below.
  //  - the SR-1 entry is seeded NEWEST so it is always INSIDE the budgeted
  //    prefix. The re-assertion has to be observable on the RETURNED slice, not
  //    merely present in the store.
  const overBudget = await writeMemoryEntryRedacted(
    ctx.tenantId,
    memoryRef,
    {
      content: 'X'.repeat(tokenBudget + 200),
      tags: ['conformance', 'rfc-0113', 'over-budget'],
      createdAt: at(0),
    },
    ctx.runId,
  );
  // Three mid-size entries at ~30% of the budget each. Together with the SR-1
  // entry the ranked list overflows, so the returned prefix is a STRICT subset
  // of what was seeded and the budget cut is observable rather than incidental
  // — asserted below, because a slice that happened to contain everything would
  // satisfy "within budget" without the budget having done anything.
  const filler: MemoryRow[] = [];
  for (let i = 0; i < 3; i++) {
    filler.push(
      await writeMemoryEntryRedacted(
        ctx.tenantId,
        memoryRef,
        {
          content: `conformance RFC 0113 filler ${i}. `.padEnd(Math.floor(tokenBudget * 0.3), 'f'),
          tags: ['conformance', 'rfc-0113', 'filler'],
          createdAt: at(1 + i),
        },
        ctx.runId,
      ),
    );
  }
  const redacted = await writeMemoryEntryRedacted(
    ctx.tenantId,
    memoryRef,
    {
      content: `conformance RFC 0113 SR-1 re-assertion; the run resolved: ${resolved.value}`,
      tags: ['conformance', 'rfc-0113', 'sr-1'],
      createdAt: at(10),
    },
    ctx.runId,
  );
  for (const row of [overBudget, ...filler, redacted]) await emitWritten(ctx, memoryRef, row);

  const budgeted = await listMemoryEntries(ctx.tenantId, memoryRef, { tokenBudget, rank: 'recency' });
  const total = budgeted.reduce((sum, r) => sum + r.content.length, 0);

  // Fail closed on the normative clauses rather than surfacing values the
  // scenario would have to catch — the host must not report success on a budget
  // it did not honour.
  if (total > tokenBudget) {
    return failure(
      'injection_budget_exceeded',
      `list-budgeted: RFC 0113 clause 1 violated — the returned slice totals ${total} chars against a budget of ${tokenBudget}`,
    );
  }
  if (budgeted.length === 0) {
    return failure(
      'injection_budget_empty_slice',
      `list-budgeted: the budgeted read returned nothing, so "within budget" holds vacuously and the SR-1/ordering assertions would have no subject`,
    );
  }
  // The CUMULATIVE budget must have excluded at least one FILLER.
  //
  // Asserting merely that the slice is smaller than the seeded set would be a
  // guard that CANNOT FAIL: the over-budget entry is excluded under either
  // budget policy (it is 200 chars past the whole budget, so the prefix
  // terminates at it regardless), which makes "slice < seeded" structurally
  // true and therefore worthless. Measured — a sabotage that shrank the fillers
  // to nothing left that version GREEN.
  //
  // Fillers are what distinguish a working CUMULATIVE budget from one that only
  // rejects individually-oversized entries: they each fit alone, and only their
  // running total pushes past the cap. If every filler survives, the budget is
  // not summing.
  const fillerIds = new Set(filler.map((r) => r.id));
  const fillersKept = budgeted.filter((r) => fillerIds.has(r.id)).length;
  if (fillersKept >= filler.length) {
    return failure(
      'injection_budget_did_not_cut',
      `list-budgeted: all ${filler.length} mid-size entries survived a budget of ${tokenBudget} (slice total ${total}), so the cumulative budget excluded nothing and "within budget" holds for the wrong reason`,
    );
  }

  // ── RFC 0113 clause 1, the HEAD case ──────────────────────────────────────
  // "A single entry exceeding the budget on its own MUST be omitted (not
  // truncated mid-entry)." This is the clause the shared `budgetByChars`
  // primitive violated before H49 (its ADR 0148 default keeps a lone first item
  // regardless of size), and it is only observable when the over-budget entry
  // is the ONLY candidate — in the mixed scope above the prefix would terminate
  // at it either way, so that scope cannot witness this clause. Hence a
  // dedicated single-entry scope: the conformant answer here is the EMPTY slice.
  const lone = await writeMemoryEntryRedacted(
    ctx.tenantId,
    loneRef,
    {
      content: 'L'.repeat(tokenBudget + 200),
      tags: ['conformance', 'rfc-0113', 'lone-over-budget'],
      createdAt: at(0),
    },
    ctx.runId,
  );
  await emitWritten(ctx, loneRef, lone);
  const loneRead = await listMemoryEntries(ctx.tenantId, loneRef, { tokenBudget, rank: 'recency' });
  if (loneRead.length > 0) {
    return failure(
      'injection_budget_lone_entry_kept',
      `list-budgeted: RFC 0113 clause 1 violated — an entry of ${lone.content.length} chars was returned alone against a budget of ${tokenBudget}; it MUST be omitted whole`,
    );
  }
  const omittedFromSlice = !budgeted.some((r) => r.id === overBudget.id);
  const overBudgetEntryOmitted = omittedFromSlice && loneRead.length === 0;

  // ── SR-1 on the budgeted path ─────────────────────────────────────────────
  const redactedRow = budgeted.find((r) => r.id === redacted.id);
  if (!redactedRow) {
    return failure(
      'injection_budget_sr1_sample_missing',
      `list-budgeted: the SR-1 entry ${redacted.id} fell outside the budgeted slice, so the redaction re-assertion would have no subject`,
    );
  }
  if (redactedRow.content.includes(resolved.value)) {
    return failure(
      'sr1_redaction_failed',
      'list-budgeted: SR-1 violated on the budgeted path — the returned slice carries resolved plaintext',
    );
  }

  // ── CTI-1 on the budgeted path ────────────────────────────────────────────
  // A scope of its OWN, seeded only by the foreign tenant, so the caller-side
  // read is genuinely empty rather than merely free of the foreign row. Same
  // positive control as the dedicated cross-tenant probe: an unattributable
  // empty read is not evidence of isolation.
  let crossTenant: Record<string, unknown>[] = [];
  try {
    const seeded = await writeMemoryEntry(CTI1_FOREIGN_TENANT, crossRef, {
      content: 'conformance RFC 0113 CTI-1 re-assertion: this row belongs to another tenant.',
      tags: ['conformance', 'rfc-0113', 'cti-1'],
      createdAt: at(20),
    });
    const owner = await listMemoryEntries(CTI1_FOREIGN_TENANT, crossRef, { tokenBudget, rank: 'recency' });
    if (!owner.some((r) => r.id === seeded.id)) {
      return failure(
        'cti1_seed_not_visible_to_owner',
        'list-budgeted: the cross-tenant seed is not readable by its own tenant under the budgeted path, so an empty probe would be vacuous',
      );
    }
    const crossed = await listMemoryEntries(ctx.tenantId, crossRef, { tokenBudget, rank: 'recency' });
    if (crossed.some((r) => r.id === seeded.id)) {
      return failure(
        'cti1_cross_tenant_leak',
        `list-budgeted: CTI-1 violated on the budgeted path — tenant ${ctx.tenantId} read another tenant's entry`,
      );
    }
    crossTenant = crossed.map(toMemoryEntry);
  } finally {
    try {
      await clearMemoryScope(CTI1_FOREIGN_TENANT, crossRef);
    } catch (err) {
      log.warn('rfc-0113 cti-1 cleanup failed', { err: String(err) });
    }
  }

  setVar(ctx, 'budgetedEntries', budgeted.map(toMemoryEntry));
  setVar(ctx, 'budgetedTokenTotal', total);
  setVar(ctx, 'tokenBudget', tokenBudget);
  // The unit this host advertises at `memory.injectionBudget.tokenCounter`.
  setVar(ctx, 'tokenCounter', 'chars');
  setVar(ctx, 'overBudgetEntryId', overBudget.id);
  setVar(ctx, 'overBudgetEntryOmitted', overBudgetEntryOmitted);
  setVar(ctx, 'redactedContentSample', redactedRow.content);
  setVar(ctx, 'crossTenantBudgetedProbe', crossTenant);
  // recencyOrder / relevanceOrder intentionally unset — see the doc comment.
  return { status: 'success', outputs: { memoryRef, budgetedCount: budgeted.length, budgetedTokenTotal: total } };
}

// ── registry ────────────────────────────────────────────────────────────────

type MemoryProbeHandler = (ctx: NodeContext) => Promise<NodeOutcome>;

/**
 * THE source of truth for which `config.memoryAction` values this host drives.
 *
 * `MEMORY_PROBE_ACTIONS` below is DERIVED from these keys and imported by
 * `host/index.ts` for the fixture advert — it is deliberately not restated
 * there. A hand-kept list would be a second source of truth for one fact, and
 * its failure mode is asymmetric and silent: forgetting a handler while keeping
 * the string makes the host ADVERTISE a fixture it cannot run, which is exactly
 * the defect ADR 0533 wrote the gate to prevent.
 */
const HANDLERS: Readonly<Record<string, MemoryProbeHandler>> = {
  'write-then-read': writeThenRead,
  'redaction-probe': redactionProbe,
  'ttl-probe': ttlProbe,
  'cross-tenant-probe': crossTenantProbe,
  'list-budgeted': listBudgeted,
};

/** Derived, never restated — see `HANDLERS`. */
export const MEMORY_PROBE_ACTIONS: ReadonlySet<string> = new Set(Object.keys(HANDLERS));

const NO_ACTIONS: ReadonlySet<string> = new Set<string>();

/**
 * The `config.memoryAction` values this host will actually EXECUTE right now —
 * the ONE function both consumers read.
 *
 *  - `identityNode` (`bootstrap/nodes.ts`) delegates only for these.
 *  - `listLoadedConformanceFixtures` (`host/index.ts`) advertises a memory
 *    fixture only when every action it declares is in here.
 *
 * Reading the same switch from both sides is what makes "advertised ⟺
 * executable" structural rather than conventional. Under a posture where the
 * conformance nodes are off, the probe is inert — so the honest answer is that
 * NO action is implemented, and the fixtures leave the advert with it. The
 * alternative (advertising the fixtures while the branch is inert) is exactly
 * the advertise-and-spuriously-fail defect ADR 0533 wrote the gate to prevent:
 * `isFixtureAdvertised` would pass, the run would reach `completed` having done
 * nothing, and a correctly-configured production host would be reported
 * non-conformant for a fixture it never really offered.
 *
 * NOTE this gates only the PROBE. The memory subsystem it drives
 * (`host/inMemorySurfaces.ts` §"RFC 0004 memory", the SR-1 chokepoint, the
 * CTI-1 ref validation, the RFC 0113 budget) is production-real and ungated —
 * what is gated is the fabrication of probe rows and the synthetic foreign
 * tenant, which is demo machinery of the `mockAiNode` class.
 */
export function implementedMemoryActions(): ReadonlySet<string> {
  return conformanceNodesEnabled() ? MEMORY_PROBE_ACTIONS : NO_ACTIONS;
}

/** True when `core.identity` carries a memory probe. */
export function hasMemoryAction(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const action = (config as Record<string, unknown>)['memoryAction'];
  return typeof action === 'string' && action.length > 0;
}

/**
 * Run the probe named by `config.memoryAction`.
 *
 * An unknown action is a TYPED FAILURE, never a silent pass-through: a fixture
 * naming an action this host does not implement should not reach dispatch at all
 * (the advert filters it), so arriving here means the advert and the handler map
 * have diverged — and reporting `completed` on an empty variable bag is the
 * precise failure mode this whole seam exists to eliminate.
 */
export async function runMemoryProbe(ctx: NodeContext): Promise<NodeOutcome> {
  const action = stringConfig(ctx, 'memoryAction');
  if (action === undefined) {
    return failure('invalid_request', 'memory probe dispatched without a config.memoryAction');
  }
  // Every scenario reads its result off `RunSnapshot.variables`, so a context
  // with no variable bag cannot produce a witness. Failing here is the
  // difference between "the host cannot run this" and the exact defect this
  // seam was built to remove: `completed` with an empty bag, which two of the
  // five corpus scenarios would score as a PASS.
  if (!ctx.variables) {
    return failure(
      'memory_probe_no_variable_bag',
      `memory probe '${action}' has no run variable bag to write to; every memory scenario reads its result from RunSnapshot.variables, so completing here would report success having surfaced nothing`,
    );
  }
  const handler = HANDLERS[action];
  if (!handler) {
    return failure(
      'memory_action_not_implemented',
      `config.memoryAction '${action}' is not implemented by this host; implemented actions: ${[...MEMORY_PROBE_ACTIONS].sort().join(', ')}`,
    );
  }
  log.info('memory probe', { action, nodeId: ctx.nodeId, runId: ctx.runId });
  return handler(ctx);
}
