/**
 * Run-event payloads must satisfy `schemas/run-event-payloads.schema.json`.
 *
 * WHY THIS EXISTS. That schema was referenced in ~6 source files — and validated
 * in ZERO. `node.started` shipped `payload: {}` against a `$defs/nodeStarted`
 * that requires `nodeId` + `typeId`, and nothing was red: in-repo nothing
 * compiled the schema, and upstream conformance COUNTS `node.started` events
 * (`cap-breach.test.ts`) without checking their payloads. Citing a schema in a
 * comment enforces nothing (`REP-1`, docs/steward/RUN-EVENT-PAYLOAD-CONFORMANCE.md).
 *
 * This drives a REAL run through `executeRun` and validates every emitted event
 * against its `$defs` entry, rather than asserting hand-built payload literals —
 * a literal would only prove the literal, and the defect was in the emission.
 *
 * Mapping is the schema's own documented convention: `$defs[event.type]` with
 * dotted event types in camelCase (`node.started` → `nodeStarted`). An event with
 * no `$defs` match is TOLERATED, per the schema description ("Unknown event types
 * MUST be tolerated").
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { corpusSchema } from './support/corpusSchema.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { executeRun } from '../src/executor/executor.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { setRuntimeCapabilities } from '../src/executor/runtimeCapabilities.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { detectAndRecordReplayDivergence } from '../src/executor/replayDivergence.js';
import type { EventRecord, RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

// From the PACKAGE, not the vendored copy (RFC 0145 G2) — see test/support/corpusSchema.ts.
const SCHEMA = corpusSchema('run-event-payloads.schema.json') as { $defs: Record<string, object> };

/**
 * `nodeId` in a payload is carried on the EventRecord ENVELOPE instead
 * ({eventId, runId, type, nodeId, payload, …}), and the host applies that
 * consistently across the `node.` and `interrupt.` events — see the `capBreached.nodeId`
 * note at `executor.ts`. That is ONE systematic envelope-vs-payload decision, not
 * a family of bugs, and whether an envelope field satisfies a payload `required`
 * is a question for the corpus (tracked as `REP-4`), not something to settle
 * unilaterally here. So `nodeId` is exempted — and ONLY `nodeId`. Every other
 * required field must actually be in the payload.
 */
const ENVELOPE_CARRIED = new Set(['nodeId']);

/**
 * Event types a real run is KNOWN to emit and validate here. Grow-only: adding a
 * scenario that reaches a new event type should add it. This is coverage, NOT a
 * conformance claim — `run-event-payloads.schema.json` defines 114 `$defs`, 99 of
 * them with `required` lists, and the ones absent below are simply UNTESTED, not
 * verified. See docs/steward/RUN-EVENT-PAYLOAD-CONFORMANCE.md § Status.
 */
const COVERED_EVENT_TYPES = [
  'run.started',
  'run.completed',
  'run.failed',
  'node.started',
  'node.completed',
  'node.failed',
  'node.suspended',
] as const;

const camel = (eventType: string): string =>
  eventType.split('.').map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join('');

// Register the WHOLE document so a `$defs` entry's internal `$ref`s (e.g.
// `_errorObject`) still resolve — compiling a spread-out fragment loses that
// context and throws at compile time rather than reporting a violation.
const ajv = new Ajv2020({ strict: false, allErrors: true });
// RFC 0165 §B — `runStarted.owner.subject` is `$ref: subject.schema.json`
// (resolved against the payloads schema's `$id`); register it so the
// `run.started` owner echo validates for real rather than failing to compile.
ajv.addSchema(corpusSchema('subject.schema.json') as object);
ajv.addSchema(SCHEMA, 'runEventPayloads');

/** Validate one event, treating envelope-carried fields as satisfied. */
function violationsFor(event: { type: string; nodeId?: string; payload: unknown }): string[] {
  const key = camel(event.type);
  const def = SCHEMA.$defs[key] as { required?: string[] } | undefined;
  if (!def) return []; // unknown event type — MUST be tolerated
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const missing = (def.required ?? []).filter((k) => !ENVELOPE_CARRIED.has(k) && !(k in payload));

  // Also validate through the registered document so a WRONG-TYPED present field
  // is caught, not just an absent one. Required-field errors are reported via
  // `missing` above (which applies the envelope exemption), so they are dropped
  // here to avoid double-reporting the exempted ones.
  const validate = ajv.getSchema(`runEventPayloads#/$defs/${key}`);
  const typeErrors: string[] = [];
  if (validate) {
    validate(payload);
    for (const e of validate.errors ?? []) {
      if (e.keyword === 'required') continue;
      typeErrors.push(`${e.instancePath} ${e.message}`);
    }
  }

  return [...missing.map((k) => `missing required '${k}'`), ...typeErrors];
}

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  setRuntimeCapabilities([]);
  const dataDir = mkdtempSync(join(tmpdir(), 'openwop-test-'));
  configureSecretResolver({ storage, dataDir });
  // The node loop builds a host-surface bundle for every node it runs.
  initInMemorySurfaces({ dataDir });
  // A node that actually RUNS. The unregistered-typeId path fails at
  // `registry.resolve` BEFORE `node.started` is appended, so a run built on it
  // never exercises the event this file exists to pin.
  getNodeRegistry().register({
    typeId: 'test.payload-conformance-noop',
    version: '1.0.0',
    async execute() {
      return { status: 'success', outputs: { output: 'ok' } };
    },
  });
  // Reaches `node.suspended` + the interrupt lifecycle, which the success and
  // failure paths never touch.
  getNodeRegistry().register({
    typeId: 'test.payload-conformance-suspend',
    version: '1.0.0',
    async execute() {
      return { status: 'suspended', interrupt: { kind: 'approval', data: { why: 'coverage' } } };
    },
  });
});

/** Run one definition and return everything it emitted. */
async function eventsFrom(workflowId: string, typeId: string): Promise<readonly { type: string; nodeId?: string; payload: unknown }[]> {
  const run = await newRun(workflowId);
  const definition: WorkflowDefinition = { workflowId, nodes: [{ nodeId: 'n1', typeId }] };
  await executeRun(storage, run, definition);
  return storage.listEvents(run.runId);
}

async function newRun(workflowId: string): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-${Math.random().toString(36).slice(2, 10)}`,
    workflowId,
    tenantId: 'demo',
    status: 'pending',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

describe('run-event payloads conform to run-event-payloads.schema.json', () => {
  it('the vendored schema is present and defines nodeStarted', () => {
    // A missing/renamed schema would make every assertion below vacuous — the
    // failure mode is a green run that validated nothing.
    expect(SCHEMA.$defs?.['nodeStarted'], 'run-event-payloads.schema.json lacks $defs/nodeStarted').toBeDefined();
  });

  it('every event emitted by a real run validates against its $defs', async () => {
    // Three paths, because one run only ever exercises one lifecycle. The
    // success path was the original leg; the failure and suspend paths were
    // added to widen $defs coverage (REP-2 residue).
    const scenarios: [string, string][] = [
      ['wf.test.payload-success', 'test.payload-conformance-noop'],
      ['wf.test.payload-failure', 'no.such.node.type'],
      ['wf.test.payload-suspend', 'test.payload-conformance-suspend'],
    ];

    const covered = new Set<string>();
    for (const [workflowId, typeId] of scenarios) {
      const events = await eventsFrom(workflowId, typeId);
      expect(events.length, `${workflowId} emitted no events — that leg would be vacuous`).toBeGreaterThan(0);
      for (const e of events) {
        if (!SCHEMA.$defs[camel(e.type)]) continue;
        covered.add(e.type);
        expect(violationsFor(e), `${workflowId} / ${e.type}: ${violationsFor(e).join('; ')}`).toEqual([]);
      }
    }

    // Coverage ratchet, grow-only. Without it a refactor that stopped emitting
    // an event would make this file QUIETER and still green — the failure mode
    // is "validated nothing", which reads identically to "everything conformed".
    for (const t of COVERED_EVENT_TYPES) {
      expect(covered.has(t), `${t} is no longer emitted by any scenario — coverage shrank`).toBe(true);
    }
  });

  it('replay.diverged names the run it diverged FROM (REP-3)', async () => {
    // Not reachable from `executeRun` above (that run does not diverge), and the
    // existing replay-divergence test only covers the pure comparator — so this
    // payload shipped unvalidated. It omitted BOTH required fields, and
    // `sourceRunId` has no envelope carrier: the envelope's `runId` is the
    // REPLAY run, so the event announced a divergence without saying from what.
    const src: EventRecord[] = [
      { eventId: 'a1', runId: 'src-1', sequence: 0, type: 'run.started', payload: {}, timestamp: '2026-01-01T00:00:00.000Z' },
      { eventId: 'a2', runId: 'src-1', sequence: 1, type: 'node.started', nodeId: 'n1', payload: {}, timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    const rep: EventRecord[] = [
      { eventId: 'b1', runId: 'rep-1', sequence: 0, type: 'run.started', payload: {}, timestamp: '2026-01-01T00:00:00.000Z' },
      { eventId: 'b2', runId: 'rep-1', sequence: 1, type: 'node.failed', nodeId: 'n1', payload: {}, timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    const appended: { type: string; payload: unknown }[] = [];

    const result = await detectAndRecordReplayDivergence(
      { listEvents: async (runId) => (runId === 'src-1' ? src : rep) },
      { append: async (e) => { appended.push(e as { type: string; payload: unknown }); } },
      'src-1',
      'rep-1',
      0,
    );

    expect(result.diverged, 'the fixture did not diverge — nothing was emitted to validate').toBe(true);
    const diverged = appended.find((e) => e.type === 'replay.diverged');
    expect(diverged, 'no replay.diverged event was appended').toBeDefined();

    expect(violationsFor({ type: 'replay.diverged', payload: diverged!.payload })).toEqual([]);
    const p = diverged!.payload as Record<string, unknown>;
    expect(p['sourceRunId']).toBe('src-1');
    expect(p['atSequence']).toBe(1);
    // Canonically `divergencePoint` is a RunEventType STRING (RFC 0027 §F); this
    // host emitted a numeric index under that name. Dropped rather than retained
    // — a colliding field is worse than an absent one.
    expect(p['divergencePoint'], 'the numeric divergencePoint collision came back').toBeUndefined();
  });

  it('node.started carries typeId, which has no envelope carrier (REP-1)', async () => {
    const run = await newRun('wf.test.node-started-typeid');
    const definition: WorkflowDefinition = {
      workflowId: 'wf.test.node-started-typeid',
      nodes: [{ nodeId: 'n1', typeId: 'test.payload-conformance-noop' }],
    };
    await executeRun(storage, run, definition);

    const events = await storage.listEvents(run.runId);
    const started = events.filter((e) => e.type === 'node.started');
    // If the executor stops emitting node.started for this path the assertion
    // below would pass over an empty list.
    expect(started.length, 'no node.started event was emitted').toBeGreaterThan(0);
    for (const e of started) {
      expect((e.payload as { typeId?: string }).typeId, 'node.started payload lost typeId').toBe('test.payload-conformance-noop');
    }
  });
});
