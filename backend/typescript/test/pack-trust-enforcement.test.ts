/**
 * ADR 0555 P0 — enforcement at the loaders, plus the two properties that are
 * easy to get wrong in ways no unit test of the classifier would notice.
 *
 *   1. Untrusted pack code is NEVER IMPORTED. `await import(url)` executes a
 *      module's top level, so "load it but refuse to dispatch" is not a
 *      boundary for ES modules — by the time an `execute()` wrapper could
 *      refuse, the pack has already run. The test proves the top level did not
 *      run, by giving the fixture an observable side effect and asserting its
 *      absence. A positive control (a trusted pack, same fixture) asserts the
 *      side effect DOES happen, so the negative case cannot pass because the
 *      fixture was inert.
 *
 *   2. Revocation does not fail OPEN on a cold boot. The revocation cache is
 *      read synchronously by the classifier; if `loadPackRevocations()` lands
 *      after the first pack load, a revoked pack executes once per instance and
 *      only then starts refusing. That is a real bypass which self-heals in
 *      seconds and is effectively unreproducible from a bug report, so it gets
 *      an explicit test rather than trust in the boot ordering comment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { locateRepoDir } from '../src/host/_repoPath.js';
import { loadPackFromManifest } from '../src/packs/tarballLoader.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { classifyPackDir, __resetPackTrustCachesForTests } from '../src/host/packTrust.js';
import {
  revokePack,
  loadPackRevocations,
  isPackRevoked,
  __clearPackRevocations,
  __resetPackRevocationCacheForTests,
} from '../src/host/packRevocations.js';

let root: string;
let packDir: string;
let sideEffectPath: string;
/** Unique per test file so registering into the module-scope node registry
 *  cannot collide with another test in the same worker. */
const TYPE_ID = 'community.test.enforcement.echo';
const PACK_NAME = 'community.test.enforcement';

function writePack(dir: string, sideEffect: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({
      name: PACK_NAME,
      version: '1.0.0',
      nodes: [{ typeId: TYPE_ID, version: '1.0.0' }],
      runtime: { format: 'esm', entry: './index.mjs' },
    }),
  );
  // The top level writes a file. If the module is imported at all, this exists.
  writeFileSync(
    join(dir, 'index.mjs'),
    `import { writeFileSync } from 'node:fs';\n`
      + `writeFileSync(${JSON.stringify(sideEffect)}, 'imported');\n`
      + `export const nodes = { ${JSON.stringify(TYPE_ID)}: async () => ({ status: 'success', outputs: { ok: true } }) };\n`,
  );
}

function markTrusted(dir: string): void {
  const hash = (f: string) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  writeFileSync(
    join(dir, '.openwop-installed.json'),
    JSON.stringify({
      name: PACK_NAME,
      version: '1.0.0',
      integrity: 'sha256-fixture',
      publicKeyRef: 'fixture',
      registry: 'https://packs.example.test',
      installedAt: new Date(0).toISOString(),
      contentHashes: { 'pack.json': hash('pack.json'), 'index.mjs': hash('index.mjs') },
    }),
  );
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  root = mkdtempSync(join(tmpdir(), 'owp-trust-enforce-'));
  packDir = join(root, PACK_NAME);
  sideEffectPath = join(root, 'IMPORTED.marker');
  writePack(packDir, sideEffectPath);
  __resetPackTrustCachesForTests();
  await __clearPackRevocations();
  await loadPackRevocations();
});

afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  await __clearPackRevocations();
  __resetPackTrustCachesForTests();
});

describe('ADR 0555 P0 — the loader refuses to IMPORT untrusted code', () => {
  it('positive control: a trusted pack IS imported and its node executes', async () => {
    markTrusted(packDir);
    const mod = await loadPackFromManifest(packDir);

    // Without this control, the negative test below would pass even if the
    // fixture never had a working side effect in the first place.
    expect(existsSync(sideEffectPath)).toBe(true);
    expect(mod?.typeId).toBe(TYPE_ID);

    const out = await getNodeRegistry().get(TYPE_ID)!.execute({} as never);
    expect(out.status).toBe('success');
  });

  it('an untrusted pack is NOT imported — its module top level never runs', async () => {
    await loadPackFromManifest(packDir);
    expect(existsSync(sideEffectPath)).toBe(false);
  });

  it('an untrusted pack still resolves its typeIds, failing with the REAL reason', async () => {
    await loadPackFromManifest(packDir);

    // Registering nothing would make the executor report an unknown node type,
    // sending whoever debugs it after a missing pack instead of a rejected one.
    const mod = getNodeRegistry().get(TYPE_ID);
    expect(mod).not.toBeNull();

    const out = await mod!.execute({} as never);
    if (out.status !== 'failure') throw new Error(`expected a typed failure, got ${out.status}`);
    expect(out.error.code).toBe('pack_untrusted');
    expect(out.error.message).toContain('no_attestation');
  });

  it('a REVOKED pack fails with pack_revoked, distinct from pack_untrusted', async () => {
    markTrusted(packDir);
    await revokePack({ packName: PACK_NAME, version: '1.0.0', by: 'test', reason: 'compromised' });
    __resetPackTrustCachesForTests();

    await loadPackFromManifest(packDir);
    expect(existsSync(sideEffectPath)).toBe(false);

    const out = await getNodeRegistry().get(TYPE_ID)!.execute({} as never);
    if (out.status !== 'failure') throw new Error(`expected a typed failure, got ${out.status}`);
    expect(out.error.code).toBe('pack_revoked');
  });
});

describe('ADR 0555 P0 — the agent loader is gated too', () => {
  function addAgent(dir: string): void {
    const manifest = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf-8')) as Record<string, unknown>;
    // agentId must sit in the pack namespace, and modelClass is required
    // (RFC 0003 §B) — otherwise the loader skips the agent for its OWN reasons
    // and the trust gate below would look like it worked when it did not.
    manifest.agents = [{
      agentId: `${PACK_NAME}.agent`,
      persona: 'tester',
      modelClass: 'general',
      systemPrompt: 'hi',
    }];
    writeFileSync(join(dir, 'pack.json'), JSON.stringify(manifest));
  }

  it('registers agents from a trusted pack', () => {
    addAgent(packDir);
    markTrusted(packDir);
    __resetPackTrustCachesForTests();
    expect(loadAgentsFromManifest(packDir).length).toBe(1);
  });

  it('refuses agents from an untrusted pack (this path had NO verification before)', () => {
    addAgent(packDir);
    __resetPackTrustCachesForTests();

    // An agent manifest is not inert data: its systemPrompt steers a model and
    // its toolAllowlist decides which host tools that model may invoke.
    expect(loadAgentsFromManifest(packDir).length).toBe(0);
  });
});

describe('ADR 0555 P0 — revocation must not fail OPEN on a cold boot', () => {
  it('a revoked pack is refused on the FIRST classification after boot', async () => {
    markTrusted(packDir);
    await revokePack({ packName: PACK_NAME, version: '1.0.0', by: 'test', reason: 'compromised' });

    // Simulate a fresh process: the row is durable, but the in-process cache is
    // empty because `loadPackRevocations()` has not run yet.
    __resetPackRevocationCacheForTests();
    __resetPackTrustCachesForTests();
    expect(isPackRevoked(PACK_NAME, '1.0.0')).toBe(false); // cache genuinely cold

    // This is the boot slot in index.ts, which MUST precede any pack load.
    await loadPackRevocations();

    // FIRST classification, not the second.
    expect(classifyPackDir(packDir, { noCache: true }).tier).toBe('revoked');
  });

  it('documents the bypass: classifying BEFORE the load would dispatch a revoked pack', async () => {
    markTrusted(packDir);
    await revokePack({ packName: PACK_NAME, version: '1.0.0', by: 'test', reason: 'compromised' });
    __resetPackRevocationCacheForTests();
    __resetPackTrustCachesForTests();

    // This asserts the FAILURE MODE, so that if someone moves
    // `loadPackRevocations()` below the pack loaders in index.ts, the cost of
    // that move is written down here in executable form rather than discovered
    // in production. A revoked pack WOULD dispatch.
    expect(classifyPackDir(packDir, { noCache: true }).dispatchable).toBe(true);

    await loadPackRevocations();
    expect(classifyPackDir(packDir, { noCache: true }).dispatchable).toBe(false);
  });
});

describe('ADR 0555 P0 — the shipped steward manifest matches the shipped packs', () => {
  it('a real vendored pack classifies steward', () => {
    // Deliberately NOT a synthetic fixture. This asserts the property the whole
    // phase depends on: that the manifest committed in this repo agrees with
    // the packs committed in this repo, so a normal boot classifies the product
    // trusted and the default-ON policy breaks nothing. If this goes red, the
    // manifest drifted and `gen-steward-manifest --check` should have caught it
    // first — that it did not would itself be the finding.
    const repoPacks = locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'packs', '.steward-manifest.json');
    const manifest = JSON.parse(readFileSync(join(repoPacks, '.steward-manifest.json'), 'utf-8')) as {
      packs: Record<string, unknown>;
    };
    const names = Object.keys(manifest.packs);
    expect(names.length).toBeGreaterThan(0);

    const verdict = classifyPackDir(join(repoPacks, names[0]), { noCache: true });
    expect(verdict.tier).toBe('steward');
    expect(verdict.reason).toBe('steward_manifest_digest_match');
    expect(verdict.dispatchable).toBe(true);
  });

  it('every attested pack in the manifest still classifies steward', () => {
    // One pack passing could be luck. The manifest is the product's whole
    // executable surface, so check all of it — a partial drift takes down a
    // subset of features, which is harder to diagnose than a total outage.
    const repoPacks = locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'packs', '.steward-manifest.json');
    const manifest = JSON.parse(readFileSync(join(repoPacks, '.steward-manifest.json'), 'utf-8')) as {
      packs: Record<string, unknown>;
    };
    const notSteward: string[] = [];
    for (const name of Object.keys(manifest.packs)) {
      if (classifyPackDir(join(repoPacks, name), { noCache: true }).tier !== 'steward') notSteward.push(name);
    }
    expect(notSteward).toEqual([]);
  });
});
