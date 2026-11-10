/**
 * ADR 1048 D5 — a pack node that NO build classified is served on a replay fork,
 * never re-executed. The regression witness for the runtime fail-open.
 *
 * WRITTEN FIRST, against the pre-ADR-1048 code (openwop-app-88's ask, Book AI's
 * P49). The fixture is the case every build-time snapshot misses: a dispatchable
 * pack whose nodes are not in `MANIFEST_DECLARED_TYPE_IDS` — exactly a registry
 * install, a break-glass pack, or an adopter pack the upstream build never saw.
 * Its `insert` node declares `role: "side-effect"` and writes a record whose id
 * it MINTS (the shape of KickTodo's `create-candidate` / `propose-plan-change`).
 *
 * MEASURED on the base (256dbc874, before the fix), recorded in ADR 1048 §Context:
 * the replay fork did NOT fail `replay_source_missing` (88's expectation). It
 * completed, the node RE-EXECUTED, and a SECOND record with a NEW id was written.
 * `isSideEffectingNode` returned false for every fixture node, so the ADR 0341
 * fast path never engaged; the record write goes through no ADR 0531 guarded
 * seam, so the backstop never fired either. Silent duplicate.
 *
 * The fixture pack is operator-trusted (a verifying install marker), the
 * registry case. The adopter-tier half of the same property lives in
 * `adr1048-adopter-pack-attestation.test.ts`.
 *
 * Red when (sabotage, ADR 1048 §Sabotage S10): the runtime manifest floor in
 * `packs/tarballLoader.ts` is deleted — the side-effect and unknown-role nodes
 * re-execute and the record count reaches 2.
 *
 * Double guard (recorded): the `insert` row declares `role: "side-effect"` AND
 * `capabilities: ["side-effectful"]`, so removing only the role line in
 * `classifyUnbuiltPackNode` leaves it served by the capability line. Breaking
 * both reds the row; the role line alone is witnessed by the floor-table case
 * in `adr1048-adopter-pack-attestation.test.ts` (`{ role: 'side-effect' }`, no caps).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun } from '../src/executor/executor.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadPackRevocations, __clearPackRevocations } from '../src/host/packRevocations.js';
import { __resetPackTrustCachesForTests } from '../src/host/packTrust.js';
import { loadPackFromManifest } from '../src/packs/tarballLoader.js';
import { openStorage } from '../src/storage/index.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const PACK = 'vendor.fixture1048.registry';
const T = (n: string): string => `${PACK}.${n}`;

/** The records the fixture's nodes "insert". Global so the pack module (imported
 *  through a file URL) and this test share it. */
interface Inserted { node: string; recordId: string }
const store = (): Inserted[] => {
  const g = globalThis as { __adr1048Inserted?: Inserted[] };
  g.__adr1048Inserted ??= [];
  return g.__adr1048Inserted;
};

let root: string;
let storage: Storage;

function writeRegistryPack(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: PACK,
    version: '1.0.0',
    runtime: { format: 'esm', entry: './index.mjs' },
    nodes: [
      { typeId: T('insert'), version: '1.0.0', role: 'side-effect', capabilities: ['side-effectful'] },
      { typeId: T('unknown-role'), version: '1.0.0', role: 'transform' },
      { typeId: T('no-role'), version: '1.0.0' },
      { typeId: T('pure'), version: '1.0.0', role: 'pure' },
    ],
  }, null, 2));
  const body = (node: string): string =>
    `async (ctx) => { const id = crypto.randomUUID(); (globalThis.__adr1048Inserted ??= []).push({ node: ${JSON.stringify(node)}, recordId: id }); return { status: 'success', outputs: { recordId: id } }; }`;
  writeFileSync(join(dir, 'index.mjs'), [
    `export const nodes = {`,
    `  ${JSON.stringify(T('insert'))}: ${body('insert')},`,
    `  ${JSON.stringify(T('unknown-role'))}: ${body('unknown-role')},`,
    `  ${JSON.stringify(T('no-role'))}: ${body('no-role')},`,
    `  ${JSON.stringify(T('pure'))}: ${body('pure')},`,
    // Exported but declared NOWHERE in pack.json — no declaration is the
    // strongest "nobody classified this" there is.
    `  ${JSON.stringify(T('undeclared'))}: ${body('undeclared')},`,
    `};`,
    '',
  ].join('\n'));
  const hash = (f: string): string => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  writeFileSync(join(dir, '.openwop-installed.json'), JSON.stringify({
    name: PACK, version: '1.0.0', integrity: 'sha256-fixture', publicKeyRef: 'fixture',
    registry: 'https://packs.example.test', installedAt: new Date(0).toISOString(),
    contentHashes: { 'pack.json': hash('pack.json'), 'index.mjs': hash('index.mjs') },
  }));
}

async function newRun(workflowId: string, extra: Partial<RunRecord> = {}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-1048-${randomUUID()}`, workflowId, tenantId: 'demo', status: 'pending',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now, ...extra,
  };
  await storage.insertRun(run);
  return run;
}

const oneNode = (typeId: string): WorkflowDefinition => ({
  workflowId: `wf.1048.${typeId}`,
  nodes: [{ nodeId: 'n1', typeId, config: {} }],
  edges: [],
});

async function nodeOutput(runId: string): Promise<unknown> {
  const events = await storage.listEvents(runId);
  const done = events.find((e) => e.type === 'node.completed' && e.nodeId === 'n1');
  return (done?.payload as { outputs?: { recordId?: unknown } } | undefined)?.outputs?.recordId;
}

/** Live run, then a `mode:'replay'` fork of it. Returns the inserts each caused. */
async function liveThenReplay(typeId: string): Promise<{ live: Inserted[]; replay: Inserted[]; liveId: unknown; replayId: unknown; replayStatus: string }> {
  const def = oneNode(typeId);
  const before = store().length;
  const src = await newRun(def.workflowId);
  expect((await executeRun(storage, src, def)).status).toBe('completed');
  const afterLive = store().length;
  const fork = await newRun(def.workflowId, { parentRunId: src.runId, forkMode: 'replay' });
  const replayed = await executeRun(storage, fork, def, { replayInvocationsFromRunId: src.runId });
  return {
    live: store().slice(before, afterLive),
    replay: store().slice(afterLive),
    liveId: await nodeOutput(src.runId),
    replayId: await nodeOutput(fork.runId),
    replayStatus: replayed.status,
  };
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  initHostExtPersistence(storage);
  root = mkdtempSync(join(tmpdir(), 'owp-1048-replay-'));
  initInMemorySurfaces({ dataDir: join(root, 'data') });
  __resetPackTrustCachesForTests();
  await __clearPackRevocations();
  await loadPackRevocations();
  writeRegistryPack(join(root, PACK));
  expect(await loadPackFromManifest(join(root, PACK)), 'non-vacuity: the fixture pack must dispatch').not.toBeNull();
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  __resetPackTrustCachesForTests();
});

describe('ADR 1048 D5 — a replay fork never re-fires a pack node no build classified', () => {
  it.each([
    ['insert', 'role side-effect (+ side-effectful)'],
    ['unknown-role', 'role outside the closed taxonomy'],
    ['no-role', 'no role at all'],
    ['undeclared', 'exported but absent from pack.json'],
  ])('%s (%s): the fork serves the recorded record id and inserts nothing', async (node) => {
    const r = await liveThenReplay(T(node));
    expect(r.live.length, 'non-vacuity: the live run inserted exactly one record').toBe(1);
    expect(r.replayStatus).toBe('completed');
    expect(r.replay, 'the replay fork must not insert a second record').toEqual([]);
    expect(r.replayId, 'the fork reproduces the SOURCE run\'s record id').toBe(r.liveId);
  });

  it('pure: a pure node still re-executes live on the fork (the floor classifies more, not everything)', async () => {
    const r = await liveThenReplay(T('pure'));
    expect(r.live.length).toBe(1);
    expect(r.replay.length, 'a pure node keeps re-execute semantics').toBe(1);
  });
});
