/**
 * ADR 1048 — the `adopter` trust tier and its floor half, one control per case.
 *
 * Fixtures go through `__setAdopterManifestForTests` (the same rules and the
 * same freeze as the code-anchored file) plus temp pack directories — the
 * `pack-trust-tier.test.ts` pattern. The one case that must NOT use the seam is
 * the env-redirect case (S6): it exercises the real, code-anchored load path.
 *
 * Each case below is a sabotage witness. Recorded in ADR 1048 §Sabotage:
 *   S1  digest mismatch                → `untrusted/no_attestation`
 *   S2  adopter key = a steward key    → whole manifest rejected; steward verdicts unchanged
 *   S3  a `community.openwop.*` key    → rejected (reserved prefix)
 *   S4  pack.json name ≠ its directory → rejected
 *   S5  pins and manifest disagree     → rejected (version, missing, extra)
 *   S6  OPENWOP_LOCAL_PACKS_DIR carries a forged manifest → ignored
 *   S7  revocation over an adopter pack → `revoked`
 *   S8  break-glass never promotes to `adopter`
 *   S11 the adopter-served arm: an adopter floor node is SERVED on a replay fork
 *       and inserts no second record (Book AI's "listed is not served" point)
 *
 * Recorded limits:
 *   - The `JSON.parse` catch in `load()` (unparseable file ⇒ `null` ⇒ `shape`) is
 *     not reachable from a test: the real path reads only this checkout's
 *     code-anchored `packs/`, which no test may write. The case below feeds the
 *     `null` that catch produces through the seam (same rules, same freeze).
 *   - S4's name = directory rule exists twice: the validation rule
 *     (`adopterPackManifest.ts`, probed) and `adopterVerdict`'s `name !== key`
 *     (`packTrust.ts`). The second is unreachable once validation passed — a
 *     renamed `pack.json` also changes the digest — so it is an equivalent mutant.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { locateRepoDir } from '../src/host/_repoPath.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadPackRevocations, revokePack, __clearPackRevocations } from '../src/host/packRevocations.js';
import { classifyPackDir, packTrustSummary, __resetPackTrustCachesForTests, type PackTrustVerdict } from '../src/host/packTrust.js';
import {
  __setAdopterManifestForTests,
  adopterClaimedPackDirs,
  adopterManifestState,
  adopterServedTypeIds,
  type AdopterManifest,
} from '../src/host/adopterPackManifest.js';
import { packContentDigest, listPackEntries } from '../src/packs/packContentDigest.js';
import { loadPackFromManifest } from '../src/packs/tarballLoader.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { classifyUnbuiltPackNode, isSideEffectingNode } from '../src/executor/sideEffects.js';
import { MANIFEST_FAST_PATH_SERVED, MANIFEST_SIDE_EFFECT_FLOOR } from '../src/executor/sideEffectFloor.generated.js';
import { executeRun } from '../src/executor/executor.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const KEY = 'vendor.acme1048.nodes';
const T = (n: string, key = KEY): string => `${key}.${n}`;

let root: string;
let packsDir: string;
let storage: Storage;

interface Inserted { node: string; recordId: string }
const store = (): Inserted[] => {
  const g = globalThis as { __adr1048AdopterInserted?: Inserted[] };
  g.__adr1048AdopterInserted ??= [];
  return g.__adr1048AdopterInserted;
};

/** An adopter pack: `insert` (side-effect, mints a record id) and `draft`
 *  (side-effect, but the adopter's build HOLDS it as ai-invocation-log). */
function writeAdopterPack(dir: string, opts: { name?: string; key?: string; version?: string } = {}): void {
  const key = opts.key ?? KEY;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: opts.name ?? key,
    version: opts.version ?? '1.0.0',
    runtime: { format: 'esm', entry: './index.mjs' },
    nodes: [
      { typeId: T('insert', key), version: '1.0.0', role: 'side-effect', capabilities: ['side-effectful'] },
      { typeId: T('draft', key), version: '1.0.0', role: 'side-effect' },
    ],
  }, null, 2));
  const body = (node: string): string =>
    `async () => { const id = crypto.randomUUID(); (globalThis.__adr1048AdopterInserted ??= []).push({ node: ${JSON.stringify(node)}, recordId: id }); return { status: 'success', outputs: { recordId: id } }; }`;
  writeFileSync(join(dir, 'index.mjs'), `export const nodes = {\n  ${JSON.stringify(T('insert', key))}: ${body('insert')},\n  ${JSON.stringify(T('draft', key))}: ${body('draft')},\n};\n`);
}

/** The manifest `gen-steward-manifest.mjs --adopter` would write for `writeAdopterPack`. */
function manifestFor(dir: string, key = KEY, version = '1.0.0'): AdopterManifest {
  return {
    version: 1,
    packs: {
      [key]: {
        version,
        files: listPackEntries(dir).length,
        digest: packContentDigest(dir),
        declared: [T('draft', key), T('insert', key)],
        served: [T('insert', key)],
        held: { 'ai-invocation-log': [T('draft', key)], 'ai-opaque-not-logged': [], 'deferred-role-semantics': [], 'declared-pure': [] },
        servedUnresolved: [],
      },
    },
  };
}

function seam(manifest: unknown, pins: Record<string, string> = { [KEY]: '1.0.0' }, stewardKeys?: ReadonlySet<string>): void {
  __setAdopterManifestForTests({ manifest, packsDir, pins, ...(stewardKeys ? { stewardKeys } : {}) });
}

function violationCodes(): string[] {
  const s = adopterManifestState();
  return s.status === 'rejected' ? [...new Set(s.violations.map((v) => v.code))].sort() : [];
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  initHostExtPersistence(storage);
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'owp-1048-adopter-'));
  packsDir = join(root, 'packs');
  writeAdopterPack(join(packsDir, KEY));
  __setAdopterManifestForTests(null);
  __resetPackTrustCachesForTests();
  await __clearPackRevocations();
  await loadPackRevocations();
});

afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  __setAdopterManifestForTests(null);
  __resetPackTrustCachesForTests();
  await __clearPackRevocations();
});

afterAll(() => { __setAdopterManifestForTests(null); });

describe('ADR 1048 D2 — the adopter tier', () => {
  it('positive control: a keyed pack whose bytes match is `adopter` and dispatchable', () => {
    seam(manifestFor(join(packsDir, KEY)));
    expect(adopterManifestState().status).toBe('valid');
    const v = classifyPackDir(join(packsDir, KEY), { noCache: true });
    expect(v).toMatchObject({ tier: 'adopter', reason: 'adopter_manifest_digest_match', packName: KEY, dispatchable: true });
    classifyPackDir(join(packsDir, KEY));
    expect(packTrustSummary()).toMatchObject({ adopter: 1, adopterManifestRejected: false });
  });

  it('S1: one flipped byte ⇒ untrusted/no_attestation (not rejected — the manifest is still valid)', () => {
    const m = manifestFor(join(packsDir, KEY));
    seam(m);
    writeFileSync(join(packsDir, KEY, 'index.mjs'), `${readFileSync(join(packsDir, KEY, 'index.mjs'), 'utf8')}// tampered\n`);
    const v = classifyPackDir(join(packsDir, KEY), { noCache: true });
    expect(v).toMatchObject({ tier: 'untrusted', reason: 'no_attestation', dispatchable: false });
  });

  it('S2: an adopter key that shadows a steward key rejects the WHOLE manifest', () => {
    seam(manifestFor(join(packsDir, KEY)), { [KEY]: '1.0.0' }, new Set([KEY]));
    expect(violationCodes()).toEqual(['shadows_steward']);
    expect(classifyPackDir(join(packsDir, KEY), { noCache: true })).toMatchObject({ tier: 'untrusted', reason: 'adopter_manifest_rejected', dispatchable: false });
    expect(packTrustSummary().adopterManifestRejected).toBe(true);
  });

  it('S3: a reserved protocol prefix (community.openwop.*) is rejected', () => {
    const key = 'community.openwop.acme1048';
    writeAdopterPack(join(packsDir, key), { key });
    seam(manifestFor(join(packsDir, key), key), { [key]: '1.0.0' });
    expect(violationCodes()).toEqual(['reserved_prefix']);
    expect(classifyPackDir(join(packsDir, key), { noCache: true })).toMatchObject({ tier: 'untrusted', reason: 'adopter_manifest_rejected', dispatchable: false });
  });

  it('S4: pack.json name ≠ its directory is rejected', () => {
    writeAdopterPack(join(packsDir, KEY), { name: 'vendor.acme1048.other' });
    seam(manifestFor(join(packsDir, KEY)));
    expect(violationCodes()).toEqual(['name_dir_mismatch']);
    expect(classifyPackDir(join(packsDir, KEY), { noCache: true })).toMatchObject({ tier: 'untrusted', reason: 'adopter_manifest_rejected', dispatchable: false });
  });

  it.each([
    ['a version ≠ its pin', { [KEY]: '1.0.1' }, ['pin_version']],
    ['a key with no pin', {}, ['pin_missing']],
    ['a pin with no manifest key', { [KEY]: '1.0.0', 'vendor.acme1048.agents': '1.0.0' }, ['pin_unattested']],
  ])('S5: pins and manifest disagree — %s', (_label, pins, codes) => {
    seam(manifestFor(join(packsDir, KEY)), pins);
    expect(violationCodes()).toEqual(codes);
    expect(classifyPackDir(join(packsDir, KEY), { noCache: true })).toMatchObject({ tier: 'untrusted', reason: 'adopter_manifest_rejected', dispatchable: false });
  });

  it('S7: a revocation wins over `adopter`', async () => {
    seam(manifestFor(join(packsDir, KEY)));
    expect(classifyPackDir(join(packsDir, KEY), { noCache: true }).tier).toBe('adopter');
    await revokePack({ packName: KEY, version: '1.0.0', by: 'test', reason: 'compromised' });
    expect(classifyPackDir(join(packsDir, KEY), { noCache: true })).toMatchObject({ tier: 'revoked', dispatchable: false });
  });

  it('S8: the break-glass relaxes dispatch of an unattested pack but never promotes it to `adopter`', () => {
    const prev = process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED;
    try {
      process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED = 'true';
      seam({ version: 1, packs: {} }, {});
      const v = classifyPackDir(join(packsDir, KEY), { noCache: true });
      expect(v).toMatchObject({ tier: 'untrusted', reason: 'no_attestation', allowedByBreakGlass: true });
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED;
      else process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED = prev;
    }
  });
});

describe('ADR 1048 D3 — the other whole-file rules', () => {
  it.each([
    ['vendor.openwop-app.acme1048', 'an upstream vendor namespace'],
    ['feature.acme1048.nodes', 'a feature.* id'],
    ['acme1048.nodes', 'no vendor.<adopter> namespace'],
  ])('D7 namespace: %s (%s) is rejected', (key) => {
    writeAdopterPack(join(packsDir, key), { key });
    seam(manifestFor(join(packsDir, key), key), { [key]: '1.0.0' });
    expect(violationCodes()).toEqual(['namespace']);
  });

  it('D7: the two grandfathered KickTodo ids pass the namespace rule — by explicit id', () => {
    const key = 'feature.kicktodo.nodes';
    writeAdopterPack(join(packsDir, key), { key });
    const m = manifestFor(join(packsDir, key), key);
    // Upstream still ships `feature.kicktodo.nodes` until ADR 1031 P3, so its real
    // typeIds are upstream's here; the fixture declares its own and an empty steward set.
    for (const t of m.packs[key]!.declared) expect(t.startsWith('feature.kicktodo.nodes.')).toBe(true);
    seam(m, { [key]: '1.0.0' }, new Set());
    expect(violationCodes()).toEqual([]);
    expect(adopterManifestState().status).toBe('valid');
  });

  it('a declared typeId that is an UPSTREAM typeId is rejected', () => {
    const m = manifestFor(join(packsDir, KEY));
    const upstream = [...MANIFEST_SIDE_EFFECT_FLOOR][0]!;
    m.packs[KEY]!.declared.push(upstream);
    seam(m);
    // An upstream id is never in this pack's own namespace, so both codes fire.
    expect(violationCodes()).toEqual(['typeid_namespace', 'typeid_upstream']);
  });

  it.each([
    [{ [`${KEY}.*`]: 'pure' }, 'a wildcard'],
    [{ 'vendor.other.nodes.x': 'served' }, 'another pack\'s typeId'],
    [{ [T('insert')]: 'skip' }, 'an unknown class'],
  ])('replayClass %j (%s) is rejected — per node, own nodes only', (replayClass, _why) => {
    const m = manifestFor(join(packsDir, KEY));
    m.packs[KEY]!.replayClass = replayClass;
    seam(m);
    expect(violationCodes()).toEqual(['replay_class']);
  });

  it('a null manifest (what load() turns an unparseable file into) is REJECTED, never read as absent', () => {
    seam(null);
    expect(adopterManifestState().status).toBe('rejected');
    expect(violationCodes()).toEqual(['shape']);
  });
});

describe('ADR 1048 D1 — the location is code-anchored; no env var moves it (S6)', () => {
  it('a forged manifest in OPENWOP_LOCAL_PACKS_DIR is never read and attests nothing', () => {
    const forged = join(root, 'forged-packs');
    writeAdopterPack(join(forged, KEY));
    writeFileSync(join(forged, '.adopter-manifest.json'), JSON.stringify(manifestFor(join(forged, KEY))));
    writeFileSync(join(forged, '.steward-manifest.json'), JSON.stringify({ version: 1, packs: {} }));
    const prev = process.env.OPENWOP_LOCAL_PACKS_DIR;
    try {
      process.env.OPENWOP_LOCAL_PACKS_DIR = forged;
      __setAdopterManifestForTests(null); // the REAL load path
      const s = adopterManifestState();
      const anchored = locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'packs', '.steward-manifest.json');
      expect(s.source, 'the adopter manifest is read from the code-anchored packs/ dir').toBe(join(anchored, '.adopter-manifest.json'));
      expect(adopterClaimedPackDirs().has(KEY)).toBe(false);
      expect(classifyPackDir(join(forged, KEY), { noCache: true })).toMatchObject({ tier: 'untrusted', reason: 'no_attestation' });
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_LOCAL_PACKS_DIR;
      else process.env.OPENWOP_LOCAL_PACKS_DIR = prev;
    }
  });
});

describe('ADR 1048 D2 invariant — first-party verdicts are identical with or without an adopter manifest', () => {
  it('every steward key keeps its exact tier and reason', () => {
    const anchored = locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'packs', '.steward-manifest.json');
    const keys = Object.keys((JSON.parse(readFileSync(join(anchored, '.steward-manifest.json'), 'utf8')) as { packs: Record<string, unknown> }).packs);
    expect(keys.length).toBeGreaterThan(150);
    const verdicts = (): Record<string, Pick<PackTrustVerdict, 'tier' | 'reason' | 'dispatchable'>> => Object.fromEntries(keys.map((k) => {
      const v = classifyPackDir(join(anchored, k), { noCache: true });
      return [k, { tier: v.tier, reason: v.reason, dispatchable: v.dispatchable }];
    }));
    __setAdopterManifestForTests(null);
    const without = verdicts();
    // A valid adopter manifest, AND a rejected one that tries to claim a steward key.
    seam(manifestFor(join(packsDir, KEY)));
    expect(adopterManifestState().status).toBe('valid');
    const withValid = verdicts();
    const shadow = keys[0]!;
    seam({ ...manifestFor(join(packsDir, KEY)), packs: { ...manifestFor(join(packsDir, KEY)).packs, [shadow]: manifestFor(join(packsDir, KEY)).packs[KEY]! } }, { [KEY]: '1.0.0', [shadow]: '1.0.0' });
    expect(adopterManifestState().status).toBe('rejected');
    const withRejected = verdicts();
    expect(Object.values(without).every((v) => v.tier === 'steward' && v.reason === 'steward_manifest_digest_match')).toBe(true);
    expect(withValid).toEqual(without);
    expect(withRejected).toEqual(without);
  });
});

describe('ADR 1048 D5 — the adopter floor half is SERVED at runtime, not just listed', () => {
  const def = (typeId: string): WorkflowDefinition => ({ workflowId: `wf.1048a.${typeId}`, nodes: [{ nodeId: 'n1', typeId, config: {} }], edges: [] });
  async function newRun(workflowId: string, extra: Partial<RunRecord> = {}): Promise<RunRecord> {
    const now = new Date().toISOString();
    const run: RunRecord = { runId: `run-1048a-${randomUUID()}`, workflowId, tenantId: 'demo', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now, ...extra };
    await storage.insertRun(run);
    return run;
  }
  async function liveThenReplay(typeId: string): Promise<{ live: number; replay: number; same: boolean }> {
    const d = def(typeId);
    const before = store().length;
    const src = await newRun(d.workflowId);
    expect((await executeRun(storage, src, d)).status).toBe('completed');
    const mid = store().length;
    const fork = await newRun(d.workflowId, { parentRunId: src.runId, forkMode: 'replay' });
    expect((await executeRun(storage, fork, d, { replayInvocationsFromRunId: src.runId })).status).toBe('completed');
    const out = async (runId: string): Promise<unknown> => ((await storage.listEvents(runId)).find((e) => e.type === 'node.completed')?.payload as { outputs?: { recordId?: unknown } } | undefined)?.outputs?.recordId;
    return { live: mid - before, replay: store().length - mid, same: (await out(src.runId)) === (await out(fork.runId)) };
  }

  beforeEach(async () => {
    initInMemorySurfaces({ dataDir: join(root, 'data') });
    seam(manifestFor(join(packsDir, KEY)));
    expect(await loadPackFromManifest(join(packsDir, KEY)), 'the adopter pack must dispatch').not.toBeNull();
  });

  it('S11: the adopter-served `insert` is classified by the adopter arm and inserts nothing on a replay fork', async () => {
    expect(adopterServedTypeIds().has(T('insert'))).toBe(true);
    const mod = await getNodeRegistry().resolve(T('insert'));
    // NOT the module flag: the adopter build decided this node, so the runtime
    // floor leaves it alone and the adopter arm is what serves it.
    expect(mod?.sideEffecting).toBeUndefined();
    expect(classifyUnbuiltPackNode(T('insert'), { role: 'side-effect' })).toBeNull();
    expect(isSideEffectingNode(T('insert'), mod)).toBe(true);
    const r = await liveThenReplay(T('insert'));
    expect(r.live).toBe(1);
    expect(r.replay, 'a replay fork of an adopter side-effect node inserts no second record').toBe(0);
    expect(r.same, 'the fork reproduces the source run\'s record id').toBe(true);
  });

  it('an adopter node its build HOLDS (ai-invocation-log) is not reclassified — it stays live', async () => {
    const mod = await getNodeRegistry().resolve(T('draft'));
    expect(mod?.sideEffecting).toBeUndefined();
    expect(isSideEffectingNode(T('draft'), mod)).toBe(false);
    const r = await liveThenReplay(T('draft'));
    expect(r.replay, 'held live: the provider call replays from the invocation log one level down').toBe(1);
  });
});

describe('ADR 1048 D5 — a typeId a build already classified is never reclassified', () => {
  it('an upstream typeId the generator HELD (in the floor, not served) stays live even when a pack re-declares it side-effect', async () => {
    const held = [...MANIFEST_SIDE_EFFECT_FLOOR].find((t) => !MANIFEST_FAST_PATH_SERVED.has(t));
    expect(held, 'non-vacuity: upstream holds at least one floor node back').toBeDefined();
    expect(classifyUnbuiltPackNode(held!, { role: 'side-effect', capabilities: ['side-effectful'] })).toBeNull();
    // Through the real loader: a registry-style pack re-shipping that typeId.
    const name = 'vendor.fixture1048.reship';
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name, version: '1.0.0', runtime: { format: 'esm', entry: './index.mjs' }, nodes: [{ typeId: held, version: '1.0.0', role: 'side-effect', capabilities: ['side-effectful'] }] }));
    writeFileSync(join(dir, 'index.mjs'), `export const nodes = { ${JSON.stringify(held)}: async () => ({ status: 'success', outputs: {} }) };\n`);
    const prev = process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED;
    try {
      process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED = 'true';
      const mod = await loadPackFromManifest(dir);
      expect(mod?.typeId).toBe(held);
      expect(mod?.sideEffecting, 'the runtime floor must not override the build\'s holdback').toBeUndefined();
      expect(isSideEffectingNode(held!, mod)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED;
      else process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED = prev;
    }
  });

  it('the runtime floor table: what an UNKNOWN typeId is classified from its own manifest entry', () => {
    const t = 'vendor.fixture1048.table.x';
    expect(classifyUnbuiltPackNode(t, undefined)).toEqual({ served: true, why: 'no-manifest-entry' });
    expect(classifyUnbuiltPackNode(t, {})).toEqual({ served: true, why: 'role-unknown' });
    expect(classifyUnbuiltPackNode(t, { role: 'transform' })).toEqual({ served: true, why: 'role-unknown' });
    expect(classifyUnbuiltPackNode(t, { role: 'side-effect' })).toEqual({ served: true, why: 'role-side-effect' });
    expect(classifyUnbuiltPackNode(t, { role: 'action', capabilities: ['side-effectful'] })).toEqual({ served: true, why: 'capability-side-effectful' });
    for (const role of ['pure', 'read', 'action']) expect(classifyUnbuiltPackNode(t, { role })).toEqual({ served: false, why: 'live' });
    // The build's ADR 0572 deferred-semantics roles stay live here too.
    expect(classifyUnbuiltPackNode(t, { role: 'gate', capabilities: ['side-effectful'] })).toEqual({ served: false, why: 'live' });
  });
});
