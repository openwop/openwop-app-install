/**
 * Record every event payload this host WRITES, so it can be validated against
 * the corpus `$def` the codemap points at (ADR 0702).
 *
 * **Why this exists, measured.** On 2026-09-15 this host emitted `output.chunk`
 * as `{chunk, isLast}` and `interrupt.resolved` as `{interruptId, kind}`. Both
 * defs are `additionalProperties: false` and both list keys those payloads do
 * not carry — `outputChunk` requires `{nodeId, runId, chunk, isLast}`. The full
 * major-2 conformance lane was EXIT=0, 490 files, 0 red on that commit, and it
 * ran twice that day: once in CI, once as the deploy-day certify.
 *
 * Nothing went red because no scenario validates a REAL event from this host
 * against the def its own `_typeIndex` names. `myndhyve-1` measured the general
 * shape on the corpus side: 31 of 355 scenarios apply Ajv at all, and those
 * validate hand-written literals, which are correct by construction. The suite
 * is structurally good at catching a wrong VALUE and blind to a missing
 * REQUIRED KEY — and both defects above are the second kind.
 *
 * So: a green bundle does not mean payload-shaped. This is the missing axis.
 *
 * **What it costs.** One comparison per append when the audit is off, hoisted
 * to module load. It is off everywhere except `scripts/audit-event-payloads.mjs`.
 *
 * **What it deliberately does NOT do.** It does not validate. Recording and
 * judging are separated on purpose: the recorder runs inside 15,000 tests where
 * a throw would be attributed to whatever test happened to trigger it, and the
 * judgement needs the whole population to compute a denominator. The number that
 * matters most is not the violation count — it is how many types the suite never
 * produced a sample for at all, which only a full run can answer.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hoisted at module load, so the hot path is one reference comparison. Set to a
 * directory to enable; every other value (including empty) disables.
 */
const AUDIT_DIR = (() => {
  const v = process.env['OPENWOP_PAYLOAD_AUDIT'];
  if (v === undefined || v === '') return undefined;
  try {
    mkdirSync(v, { recursive: true });
    return v;
  } catch {
    // A recorder that cannot write must not take the suite down with it. The
    // aggregator fails loudly on an EMPTY sample set instead, which is the
    // honest place for it: zero samples means the recorder did not run, and
    // that must never read as "nothing to report".
    return undefined;
  }
})();

/** Per-process, so 15,000 tests write bounded output. Keyed type + shape. */
const seen = new Set<string>();
const SAMPLE_FILE = AUDIT_DIR === undefined ? '' : join(AUDIT_DIR, `samples-${process.pid}.jsonl`);

/** A stable key for "this type, with this exact set of top-level keys". */
function shapeKey(type: string, payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    const kind = payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload;
    return `${type} <${kind}>`;
  }
  return `${type} ${Object.keys(payload).sort().join(',')}`;
}

/**
 * Called from the two event writers in `eventEraAdapter.ts` — the documented
 * single seat for every event write in this backend.
 *
 * Records the FIRST payload seen for each (type, key-set) combination. Distinct
 * key sets matter: a type emitted from four call sites with four different
 * optional-field combinations is four chances to be missing a required key, and
 * collapsing them to one sample would hide three of them.
 */
export function recordPayloadSample(type: string, payload: unknown, wire?: unknown, tenant?: string): void {
  if (AUDIT_DIR === undefined) return;
  const key = shapeKey(type, payload);
  if (seen.has(key)) return;
  seen.add(key);
  try {
    // `tenant` (ADR 0726) lets the audit tell an `anon:` run — whose bound ids
    // stay bare BY DECISION (ADR 0704) — from a projection that failed.
    appendFileSync(SAMPLE_FILE, `${JSON.stringify({ type, payload, wire: wire ?? payload, origin: originOf(), ...(tenant !== undefined ? { tenant } : {}) })}\n`);
  } catch {
    /* best-effort — never fail an append because the audit could not write */
  }
}

/**
 * Where did this append come from — host code, or a test appending a fixture
 * directly?
 *
 * WITHOUT THIS THE WHOLE AUDIT IS UNUSABLE, and the first version did not have
 * it. The samples come from the test suite, and a test that seeds
 * `{type: 'run.started', payload: {}}` produces a payload missing every required
 * key — indistinguishable, in the output, from host code emitting a short
 * payload. MEASURED on the first full run: `run.started` showed 130 violations
 * and `run.started :: workflowId` as a missing required property, which is not
 * plausible host behaviour and was the tell.
 *
 * A number that mixes "what this host writes" with "what a fixture spelled" is
 * not a measurement of either. So tag each sample with the first stack frame
 * outside the storage layer, and let the aggregator split on it.
 *
 * Cost is irrelevant — this runs only under the audit flag, once per distinct
 * (type, key-set).
 */
const PLUMBING = /eventPayloadAudit|eventEraAdapter|executor\/eventLog|storage\/(sqlite|postgres|memory|storage)/;

function originOf(): string {
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n').slice(2)) {
    // Skip this module and the adapter that calls it; the first frame below
    // them is the actual writer.
    // Skip the event-log PLUMBING, not just this module. Every append reaches
    // the adapter through `executor/eventLog.ts` and the storage backends, so a
    // two-name skip list returns `eventLog.ts` for 100% of samples — which is
    // true and tells you nothing. The frame worth reporting is the first one
    // above the plumbing: the feature that decided to emit.
    if (PLUMBING.test(line)) continue;
    const m = /\(?((?:\/|file:)[^):]+)/.exec(line);
    if (!m) continue;
    const path = m[1];
    if (path.includes('/node_modules/')) continue;
    // Return the FILE, not a category. The first version returned
    // 'host' | 'test' and it was useless: 1319 of 1326 samples came back 'host',
    // because a test that drives an HTTP route makes host code do the emitting,
    // and the conformance seed seam — which exists to plant arbitrary fixture
    // payloads — lives in `src/` like everything else. A two-value category
    // cannot separate "this host's behaviour" from "a fixture's spelling" when
    // both are emitted by the same module.
    //
    // The file name can: `routes/conformanceSeams.ts` and
    // `aiProviders/aiProvidersHost.ts` are obviously different answers, and the
    // aggregator groups on it rather than guessing for you.
    const cwd = process.cwd();
    return path.replace(/^file:\/\//, '').replace(`${cwd}/`, '').replace(/^.*\/backend\/typescript\//, '');
  }
  return 'unknown';
}

/** Is the recorder active? Exported so a test can prove the seam is wired. */
export function payloadAuditEnabled(): boolean {
  return AUDIT_DIR !== undefined;
}
