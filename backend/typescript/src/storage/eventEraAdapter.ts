/**
 * THE SEAT — `spec/v2/core/persistence.md` §"The seat":
 *
 *   "The adapter MUST sit at the storage boundary every reader passes through —
 *    the storage interface's event-list method, not a wrapper some call sites
 *    bypass."
 *
 * This host's storage interface (`storage/storage.ts`) has exactly one event-list
 * method, `listEvents`, and exactly two event writers, `appendEvent` and
 * `appendEventsBatch`. Every read of the `events` table in the whole backend goes
 * through `listEvents` — poll, SSE (buffered replay and gap fetch), fork, replay
 * divergence, the debug bundle, the summary/analytics folds: 35 call sites across
 * 23 modules, and the only other statements that touch the table are
 * `SELECT MAX(sequence)` and the retention `DELETE`, neither of which reads a
 * `type`. So the adapter is installed ON those three methods.
 *
 * It is installed by DECORATING the Storage object inside `openStorage()`
 * (storage/index.ts), which is the sole constructor of a Storage in the running
 * host. Not by editing the two backends: sqlite and Postgres would then carry two
 * copies of the era rules and could drift, and the decorator makes bypass
 * structurally impossible rather than merely unlikely — there is no unwrapped
 * Storage for a call site to reach.
 *
 * It also stamps the era. `insertRun` is the single storage-interface method
 * every run-creation path funnels into (24 of them; 21 through
 * `host/runInsert.ts` and 3 deliberate direct callers), so stamping HERE is what
 * makes persistence.md's "a host with more than one creation path MUST begin
 * stamping 3 on ALL of them in the same change" true by construction instead of
 * by inspection. A creation path added tomorrow inherits the stamp.
 *
 * WHAT IT DOES NOT DO: it never rewrites a stored row. An era-2 log stays era-2
 * bytes forever; the translation is a read projection, and the era column of an
 * existing run is never restamped by an append.
 */

import { payloadAuditEnabled, recordPayloadSample } from './eventPayloadAudit.js';
import { projectV2Payload, stampV2SchemaVersion } from './v2PayloadProjection.js';
// ADR 0722 E — the audit sample is the FULL wire: storage projection, then the
// transport's bound-id projection (ADR 0723). Recording the copy before binding
// made every bound id a `must match pattern` error (188 of the 797 wire errors).
import { projectV2RunIds } from '../host/v2Ids.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Storage } from './storage.js';
import type { EventRecord } from '../types.js';
import {
  ERA_V1,
  EVENT_LOG_SCHEMA_VERSION,
  eraOf,
  toContractVocabulary,
  toStorageVocabulary,
  type ContractMajor,
} from './eventEra.js';

/**
 * The protocol contract the CURRENT request is being served under, parked for
 * the whole request by `protocolVersionMiddleware`. A read taken inside a
 * request inherits it with no call-site change, which is the property §"The
 * seat" is really asking for: a v2 route cannot forget to ask for translation.
 *
 * `listEvents(runId, { contract })` overrides it for the one read that escapes
 * the request's async context — the SSE gap fetch, whose continuation is
 * scheduled from the APPENDER's context, not the reader's.
 */
const contractContext = new AsyncLocalStorage<ContractMajor>();

export function runUnderContract<T>(contract: ContractMajor, fn: () => T): T {
  return contractContext.run(contract, fn);
}

/**
 * ADR 0650 — the contract a BACKGROUND WORKER reads the event seat under.
 *
 * A request's contract is set by the negotiator (`protocolVersion.ts`,
 * `runUnderContract(major, next)`). Every other reader — daemons, sweepers, the
 * webhook worker, the executor when it resumes a run from a timer — used to get
 * here by falling through `currentContract()`'s `?? 1`: an ambient default that
 * no worker chose and no test could tell apart from a request that forgot to
 * negotiate. It is now a NAMED value every worker enters explicitly
 * (`runUnderWorkerContract(tick)`), so December's flip is one constant and the
 * set of readers it flips is enumerated by `test/worker-contract-explicit`.
 *
 * It is `1` today because every worker was written against the v1 vocabulary
 * the seat translates to under major 1; flipping it is a decision about those
 * readers, not about the wire (ADR 0642 § atomicity does not bind it).
 */
export const WORKER_CONTRACT: ContractMajor = 1;

/** Enter the event seat as a background worker — the ONLY intended non-request caller. */
export function runUnderWorkerContract<T>(fn: () => T): T {
  return contractContext.run(WORKER_CONTRACT, fn);
}

/** The ambient contract. `?? 1` is the fallback for a caller that entered
 *  NEITHER a negotiated request nor `runUnderWorkerContract` — it should be
 *  unreachable; the test/worker-contract-explicit ratchet keeps the worker
 *  side of that true, and the negotiator the request side. */
export function currentContract(): ContractMajor {
  return contractContext.getStore() ?? 1;
}

/**
 * Per-run era cache. The era is fixed at creation and never changes, so a hit is
 * always correct; the cap keeps a long-lived process bounded and a miss is only
 * one indexed `getRun`.
 */
const ERA_CACHE_MAX = 4096;
const eraCache = new Map<string, number>();
/**
 * The run's tenant, remembered by the SAME `getRun` that `eraFor` already makes.
 *
 * `projectV2OwnerEcho` needs a tenant to stamp the legacy subject on a
 * `run.started` whose payload carries no owner at all (identity.md §1.2), and the
 * payload cannot supply one. Reading the run a second time for it would double a
 * per-read lookup; this rides the existing one. Bounded and cleared with the era
 * cache, since the two are populated and invalidated together.
 */
const tenantCache = new Map<string, string>();

function rememberEra(runId: string, era: number): number {
  if (eraCache.size >= ERA_CACHE_MAX) {
    const oldest = eraCache.keys().next();
    if (!oldest.done) eraCache.delete(oldest.value);
  }
  eraCache.set(runId, era);
  return era;
}

/** Test seam — the era cache is keyed on run id, which fixtures reuse. */
export function resetEraCache(): void {
  eraCache.clear();
  tenantCache.clear();
}

async function eraFor(inner: Storage, runId: string): Promise<number> {
  const hit = eraCache.get(runId);
  // BOTH caches must be warm before taking the fast path. Checking only the era
  // meant a run whose era was already cached skipped the `getRun` below, so the
  // tenant was never remembered and the legacy-subject stamp silently did
  // nothing on exactly the reads that had been served once already — which is
  // every read after the first.
  if (hit !== undefined && tenantCache.has(runId)) return hit;
  const run = await inner.getRun(runId);
  if (run !== null && typeof run.tenantId === 'string') tenantCache.set(runId, run.tenantId);
  // A run that is gone has no log to read either; ERA_V1 is the conservative
  // reading (translate rather than pass through) and is unreachable in practice.
  return rememberEra(runId, run === null ? ERA_V1 : eraOf(run));
}

/**
 * Wrap `inner` so the era rules hold on every call.
 *
 * The wrapper is a PLAIN OBJECT carrying its own copy of every backend method
 * plus the four era-aware ones — deliberately not a `Proxy`. A Proxy with only a
 * `get` trap forwards reads but sends WRITES straight to the target, so a test
 * that swaps a method on the storage it was handed (`storage.insertRun = …`,
 * which several do to emulate a crash mid-transaction) installs its stub on the
 * INNER object while reads still resolve to the wrapper's override — and the
 * override's own call to `inner.insertRun` then re-enters the stub forever.
 * Measured, not theorised: it stack-overflowed five legs of
 * `idempotent-run-admission.test.ts`. An own-property object behaves like the
 * object every caller thinks it has.
 */
export function withEventEra(inner: Storage): Storage {
  const overrides: Partial<Storage> = {
    async insertRun(run, opts) {
      // §"The era key": a v2 host MUST stamp 3 on EVERY run it creates. A caller
      // may not choose the era — the value is this host's one constant, and the
      // only reason `??` appears is so a re-insert of an already-stamped record
      // (the tenant-migration path) keeps its own era rather than being
      // restamped.
      const stamped = { ...run, eventLogSchemaVersion: run.eventLogSchemaVersion ?? EVENT_LOG_SCHEMA_VERSION };
      await inner.insertRun(stamped, opts);
      rememberEra(stamped.runId, eraOf(stamped));
    },

    async appendEvent(input) {
      // §"The writer rule": the run's era fixes the log's vocabulary for the
      // run's lifetime, so the STORED spelling is the run's era spelling. The
      // RETURNED record keeps the caller's spelling: the in-process fan-out
      // (SSE fast path, webhooks, the cost emitter) is v1-vocabulary machinery
      // and this method is not the place to change what it sees.
      if (payloadAuditEnabled()) {
        recordPayloadSample(input.type, input.payload, projectV2RunIds(projectV2Payload(input.type, input.payload, { runId: input.runId, ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) }, tenantCache.get(input.runId)), tenantCache.get(input.runId) ?? 'default'), tenantCache.get(input.runId));
      }
      const era = await eraFor(inner, input.runId);
      const stored = await inner.appendEvent({ ...input, type: toStorageVocabulary(input.type, era) });
      return { ...stored, type: input.type };
    },

    async appendEventsBatch(inputs) {
      if (inputs.length === 0) return [];
      const eras = new Map<string, number>();
      if (payloadAuditEnabled()) {
        for (const e of inputs) recordPayloadSample(e.type, e.payload, projectV2RunIds(projectV2Payload(e.type, e.payload, { runId: e.runId, ...(e.nodeId !== undefined ? { nodeId: e.nodeId } : {}) }, tenantCache.get(e.runId)), tenantCache.get(e.runId) ?? 'default'), tenantCache.get(e.runId));
      }
      for (const e of inputs) {
        if (!eras.has(e.runId)) eras.set(e.runId, await eraFor(inner, e.runId));
      }
      const stored = await inner.appendEventsBatch(
        inputs.map((e) => ({ ...e, type: toStorageVocabulary(e.type, eras.get(e.runId) ?? ERA_V1) })),
      );
      return stored.map((r, i) => ({ ...r, type: inputs[i]?.type ?? r.type }));
    },

    // ADR 0754 — the caller names the v1 type; the row is stored in its run's era
    // vocabulary (the same translation `appendEvent` applies), and is returned
    // under the caller's name — `getArtifact` reads it as a v1 payload.
    async findFirstEventByPayload(runId, type, payloadKey, payloadValue) {
      const era = await eraFor(inner, runId);
      const row = await inner.findFirstEventByPayload(runId, toStorageVocabulary(type, era), payloadKey, payloadValue);
      return row ? { ...row, type } : null;
    },

    async listEvents(runId, opts) {
      const rows = await inner.listEvents(runId, opts);
      const contract = opts?.contract ?? currentContract();
      const era = await eraFor(inner, runId);
      // `events.md` §"The envelope" — `schemaVersion` is REQUIRED on a major-2
      // `RunEventDoc` and OPTIONAL in the v1 schema, so it is supplied on the
      // major-2 read and ONLY there. Supplying it on the v1 read would be an
      // additive but real change to a wire `versioning.md` §1.2 says stays
      // unchanged through the overlap. A producer that already set the field
      // keeps its value.
      if (contract === 2) {
        return rows.map((row: EventRecord) => {
          const type = toContractVocabulary(row.type, era, contract);
          return {
            ...row,
            type,
            schemaVersion: stampV2SchemaVersion({ schemaVersion: row.schemaVersion }).schemaVersion,
            // RFC 0170 §A.1 / `events.md` §Payloads — `run.started` echoes the
            // SAME closed owner block the snapshot carries, so the two are
            // projected by one function (`host/runOwner.ts`). The persisted
            // payload is the v1 block and is never rewritten; this is the read
            // projection, which is also what keeps a fork's translated prefix
            // byte-equivalent to its parent's (both sides project identically).
            // ADR 0722 — ONE composed projection for every major-2 egress
            // channel (`storage/v2PayloadProjection.ts`). It used to be composed
            // inline here while the webhook fan-out projected nothing but the
            // type; see that module's header for what that cost.
            payload: projectV2Payload(type, row.payload, { runId: row.runId, ...(row.nodeId !== undefined ? { nodeId: row.nodeId } : {}) }, tenantCache.get(runId)),
          };
        });
      }
      // Nothing to do when the stored vocabulary already IS the contract's.
      // Short-circuited rather than mapped-to-itself so the v1 read of a
      // pre-cut run is the same array object shape it has always been.
      if (era < 3) return rows;
      return rows.map((row: EventRecord) => {
        const type = toContractVocabulary(row.type, era, contract);
        // `sequence` verbatim (including 0), `eventId`, `timestamp`,
        // `causationId`, `nodeId`, `payload` untouched — §"The reader rule".
        return type === row.type ? row : { ...row, type };
      });
    },
  };

  // `...inner` copies every backend method, so a method added to `Storage` later
  // is carried without touching this file; `...overrides` then shadows exactly
  // the four this adapter owns. `this` inside a copied method resolves to the
  // wrapper (the sqlite `updateRun` reaches `this.getRun` that way), which is the
  // wrapper's copy of the same function — the behaviour it had before.
  return { ...inner, ...overrides };
}
