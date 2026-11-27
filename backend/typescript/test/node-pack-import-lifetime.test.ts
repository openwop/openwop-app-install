/** Process import lifetime: cold/no-op success, truthful refusal, no hot activation claim. */
import { it, expect, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadPackFromManifest } from '../src/packs/tarballLoader.js';
import { installPackFromRegistry, verifyInstalledPack, V2_SIGNING_SCHEME } from '../src/packs/registryInstaller.js';
import { translateInstallError } from '../src/packs/installLane.js';
import { invalidatePackTrustVerdict } from '../src/host/packTrust.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { assertNodePackReplaceable, PackRestartRequiredError } from '../src/packs/nodePackImportLifetime.js';
import type { NodeContext, NodeModule } from '../src/executor/types.js';
import { attestPackDir } from './setup/attestPackFixture.js';

const TYPE = 'vendor.test.importlifetime.probe';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(entry = normalEntry(), version = '1.0.0') {
  const root = mkdtempSync(join(tmpdir(), 'node-import-lifetime-')), dir = join(root, 'real');
  mkdirSync(join(dir, 'schemas'), { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: 'vendor.test.importlifetime', kind: 'node', version, engines: { openwop: '>=1.0.0 <3.0.0' }, nodes: [{ typeId: TYPE, version: '1.0.0', role: 'pure' }],
    runtime: { format: 'esm', entry: './index.mjs' },
  }));
  writeFileSync(join(dir, 'index.mjs'), entry);
  writeFileSync(join(dir, 'schemas/value.mjs'), "export const value = 'old-helper';\n");
  attestPackDir(dir);
  return { root, dir, close: () => rmSync(root, { recursive: true, force: true }) };
}
function normalEntry() {
  return "import { value } from './schemas/value.mjs';\nexport const nodes = { '" + TYPE + "': async () => ({ status: 'success', outputs: { value } }) };\n";
}
async function loaded(dir: string): Promise<NodeModule> {
  expect(verifyInstalledPack(dir), 'fixture is genuinely attested before import').toBeNull();
  const module = await loadPackFromManifest(dir);
  if (!module) throw new Error('fixture loader returned no executable module');
  expect(module.packOrigin?.tier, 'real trust gate admitted this fixture').toBe('operator-trusted');
  return module;
}
async function value(module: NodeModule) {
  const ctx: NodeContext = {
    runId: 'node-import-lifetime', nodeId: 'probe', tenantId: 'node-import-lifetime', inputs: {},
    config: {}, configurable: {}, secrets: {}, attempt: 1,
    emit: async () => { throw new Error('unexpected fixture event'); },
  };
  return module.execute(ctx);
}
const success = (v: string) => ({ status: 'success', outputs: { value: v } });

it('signed normal installer preserves imported bytes, allows unchanged no-op and maps startup action safely', async () => {
  const pack = 'vendor.test.importlifetime', registry = 'https://node-import-lifetime.invalid', keyId = 'node-import-lifetime-fixture';
  const original = fixture(), candidate = fixture("export const nodes = { '" + TYPE + "': async () => ({status:'success',outputs:{value:'new-entry'}}) };\n", '1.1.0');
  const root = mkdtempSync(join(tmpdir(), 'signed-node-import-lifetime-')), packDir = join(root, 'packs');
  const key = generateKeyPairSync('ed25519'), publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const hits: string[] = [];
  const bundles = new Map<string, { tgz: Buffer; manifest: Buffer; signature: Buffer; integrity: string }>();
  let undo: (() => void) | undefined;
  try {
    mkdirSync(packDir);
    for (const [version, source] of [['1.0.0', original.dir], ['1.1.0', candidate.dir]] as const) {
      const archive = join(root, version + '.tgz');
      const tar = spawnSync('tar', ['-czf', archive, '-C', source, 'pack.json', 'index.mjs', 'schemas'], { encoding: 'utf8' });
      expect(tar.status, 'real tar positive before installer assertions: ' + tar.stderr).toBe(0);
      const tgz = readFileSync(archive), manifest = readFileSync(join(source, 'pack.json'));
      bundles.set(version, { tgz, manifest, signature: sign(null, manifest, key.privateKey),
        integrity: 'sha256-' + createHash('sha256').update(tgz).digest('base64') });
    }
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET') throw new Error('unexpected fixture write fetch');
      hits.push(url);
      const ok = (body: string | Uint8Array) => new Response(body, { status: 200 });
      if (url === registry + '/.well-known/openwop-registry.json') return ok(JSON.stringify({
        signingKeys: [{ keyId, permittedNamespaces: ['vendor.*'] }],
        endpoints: { publicKey: '/keys/{keyId}.pub',
          versionManifest: '/v1/packs/{name}/-/{version}.json',
          v2: { versionManifest: '/v2/packs/{name}/-/{version}.json', versionTarball: '/v2/packs/{name}/-/{version}.tgz', versionSignature: '/v2/packs/{name}/-/{version}.sig' } },
      }));
      if (url === registry + '/keys/' + keyId + '.pub') return ok(publicPem);
      for (const [version, bundle] of bundles) {
        const base = registry + '/v2/packs/' + pack + '/-/' + version;
        if (url === base + '.json') return ok(JSON.stringify({ name: pack, version, integrity: bundle.integrity, signing: { keyId, scheme: V2_SIGNING_SCHEME } }));
        if (url === base + '.tgz') return ok(new Uint8Array(bundle.tgz));
        if (url === base + '.sig') return ok(new Uint8Array(bundle.signature));
      }
      throw new Error('unadmitted fixture fetch; never forwarded');
    });
    undo = () => spy.mockRestore();
    const candidateRoot = join(root, 'candidate-packs'); mkdirSync(candidateRoot);
    expect(await installPackFromRegistry({ name: pack, version: '1.1.0' }, { packDir: candidateRoot, registry })).toEqual({ installed: true });
    const coldCandidate = await loaded(join(candidateRoot, pack));
    expect(coldCandidate.version).toBe('1.1.0');
    expect(await value(coldCandidate), 'genuine signed candidate executes before the refusal control').toEqual(success('new-entry'));
    expect(await installPackFromRegistry({ name: pack, version: '1.0.0' }, { packDir, registry })).toEqual({ installed: true });
    expect(hits).toContain(registry + '/v2/packs/' + pack + '/-/1.0.0.sig');
    const installed = join(packDir, pack), imported = await loaded(installed);
    expect(await value(imported)).toEqual(success('old-helper'));
    const before = hash(join(installed, 'index.mjs')), requests = hits.length;
    expect(await installPackFromRegistry({ name: pack, version: '1.0.0' }, { packDir, registry }))
      .toEqual({ installed: false, reason: 'already_installed' });
    expect(hits).toHaveLength(requests);
    const refusal: unknown = await installPackFromRegistry({ name: pack, version: '1.1.0' }, { packDir, registry }).then(() => null, error => error);
    expect(refusal).toBeInstanceOf(PackRestartRequiredError);
    expect(hash(join(installed, 'index.mjs'))).toBe(before);
    expect(verifyInstalledPack(installed)).toBeNull();
    expect(getNodeRegistry().get(TYPE)).toBe(imported);
    expect(imported.version).toBe('1.0.0');
    expect(await value(imported)).toEqual(success('old-helper'));
    const mapped = translateInstallError(refusal, pack, '1.1.0');
    expect(mapped.httpStatus).toBe(409); expect(mapped.code).toBe('conflict');
    expect(mapped.details).toEqual({ packName: pack, version: '1.1.0', reason: 'pack_restart_required' });
    expect(mapped.message).toContain('Configure the desired version for startup and restart');
    expect(mapped.message).not.toContain(root); expect(mapped.message).not.toContain(registry);
  } finally { undo?.(); rmSync(root, { recursive: true, force: true }); original.close(); candidate.close(); }
});

it.each([['entry', false], ['relative-helper', true]] as const)('%s change cannot relabel cached code through lexical/realpath aliases; cold new path works', async (changed, entryStable) => {
  const f = fixture(), alias = join(f.root, 'alias');
  try {
    symlinkSync(f.dir, alias, 'dir');
    const old = await loaded(alias);
    expect(await value(old)).toEqual(success('old-helper'));
    expect(await value(await loaded(f.dir)), 'unchanged tree reload is supported').toEqual(success('old-helper'));
    const entryBefore = hash(join(f.dir, 'index.mjs'));
    if (changed === 'relative-helper') writeFileSync(join(f.dir, 'schemas/value.mjs'), "export const value = 'new-helper';\n");
    else writeFileSync(join(f.dir, 'index.mjs'), "export const nodes = { '" + TYPE + "': async () => ({status:'success',outputs:{value:'new-helper'}}) };\n");
    attestPackDir(f.dir);
    invalidatePackTrustVerdict(f.dir); invalidatePackTrustVerdict(alias);
    expect(verifyInstalledPack(f.dir)).toBeNull();
    expect(hash(join(f.dir, 'index.mjs')) === entryBefore, 'relative-helper control changes only the imported helper, not the entry').toBe(entryStable);
    const cold = join(f.root, 'cold');
    cpSync(f.dir, cold, { recursive: true });
    const current = await loaded(cold);
    expect(await value(current), 'changed bytes are valid and execute on a new path').toEqual(success('new-helper'));
    const anotherAlias = join(f.root, 'new-alias');
    symlinkSync(f.dir, anotherAlias, 'dir');
    for (const path of [f.dir, alias, anotherAlias]) {
      await expect(loadPackFromManifest(path)).rejects.toBeInstanceOf(PackRestartRequiredError);
      expect(() => assertNodePackReplaceable(path)).toThrow(PackRestartRequiredError);
    }
    const unimported = join(f.root, 'unimported');
    cpSync(f.dir, unimported, { recursive: true });
    rmSync(alias); symlinkSync(unimported, alias, 'dir');
    expect(verifyInstalledPack(alias), 'retarget is a valid tree but the lexical import path remains owned').toBeNull();
    await expect(loadPackFromManifest(alias)).rejects.toBeInstanceOf(PackRestartRequiredError);
    expect(() => assertNodePackReplaceable(alias)).toThrow(PackRestartRequiredError);
    expect(getNodeRegistry().get(TYPE), 'refused reload never overwrites current registration').toBe(current);
    expect(await value(old), 'retained original has truthful old identity/code').toEqual(success('old-helper'));
  } finally { f.close(); }
});

async function pendingImport(mutate: boolean) {
  const { existsSync, watch } = await import('node:fs');
  const { packContentDigest } = await import('../src/packs/packContentDigest.js');
  const f = fixture(), control = join(f.root, 'control');
  mkdirSync(control);
  const enteredPath = join(control, 'entered'), releasePath = join(control, 'release'), countPath = join(control, 'count');
  const statePath = join(f.dir, 'schemas/pending-state.json');
  const promises: Array<Promise<NodeModule | null>> = [];
  let cancelEntered: (() => void) | undefined;
  const release = () => { writeFileSync(releasePath, 'release'); };
  const entries = () => existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
  try {
    // These files are outside the attested tree. Only the native entry writes
    // entry/count; neither Vitest's module registry nor a copied gate is used.
    const entry = [
      "import { existsSync, readFileSync, writeFileSync, watch } from 'node:fs';",
      "import { value } from './schemas/value.mjs';",
      'const control = ' + JSON.stringify(control) + ';',
      'const enteredPath = ' + JSON.stringify(enteredPath) + ';',
      'const releasePath = ' + JSON.stringify(releasePath) + ';',
      'const countPath = ' + JSON.stringify(countPath) + ';',
      "const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;",
      "writeFileSync(countPath, String(count + 1)); writeFileSync(enteredPath, 'entered');",
      'await new Promise((resolve, reject) => {',
      // fs.watch alone can miss a coalesced FSEvents event on macOS; a short poll is the bounded fallback.
      '  const stop = () => { clearInterval(poll); watcher.close(); };',
      '  const check = () => { if (existsSync(releasePath)) { stop(); resolve(); } };',
      '  const watcher = watch(control, check);',
      '  const poll = setInterval(check, 25);',
      "  watcher.on('error', error => { stop(); reject(error); });",
      '  check();', // Release may have arrived before watch subscribed.
      '});',
      "export const nodes = { '" + TYPE + "': async () => ({status:'success',outputs:{value}}) };",
      '',
    ].join('\n');
    writeFileSync(join(f.dir, 'index.mjs'), entry);
    // Change a real attested member, without invalidating an in-flight import dependency.
    writeFileSync(statePath, '{"state":1}\n');
    attestPackDir(f.dir);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ state: 1 });
    const digestBefore = packContentDigest(f.dir);
    const entered = new Promise<void>((resolve, reject) => {
      let closed = false;
      const close = () => { if (!closed) { closed = true; clearInterval(poll); watcher.close(); } };
      const check = () => { if (existsSync(enteredPath)) { close(); resolve(); } };
      const watcher = watch(control, check);
      // Bounded fallback: a missed fs.watch event must not hang the test until its timeout.
      const poll = setInterval(check, 25);
      watcher.on('error', error => { close(); reject(error); });
      cancelEntered = () => { close(); resolve(); };
      check(); // Entry may have signalled before watch subscribed.
    });
    const previous = getNodeRegistry().get(TYPE);
    const first = loadPackFromManifest(f.dir); promises.push(first);
    await Promise.race([entered, first.then(() => { throw new Error('import settled before real top-level entered'); })]);
    expect(readFileSync(enteredPath, 'utf8'), 'signal came from the actual native entry').toBe('entered');
    expect(packContentDigest(f.dir), 'control handshake never mutates the attested pack tree').toBe(digestBefore);
    expect(entries(), 'actual pack top-level reached pending import').toBe(1);
    expect(getNodeRegistry().get(TYPE)).toBe(previous);
    expect(() => assertNodePackReplaceable(f.dir), 'pending imports already exclude replacement').toThrow(PackRestartRequiredError);
    const second = loadPackFromManifest(f.dir); promises.push(second);
    if (mutate) {
      writeFileSync(statePath, '{"state":2}\n');
      attestPackDir(f.dir); invalidatePackTrustVerdict(f.dir);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ state: 2 });
      expect(packContentDigest(f.dir), 'actual included member changed the claimed whole-tree digest').not.toBe(digestBefore);
      expect(verifyInstalledPack(f.dir), 'changed tree is validly re-attested before release').toBeNull();
    }
    release();
    const outcomes = await Promise.allSettled(promises);
    expect(entries(), 'same unchanged import identity executes top-level only once').toBe(1);
    return outcomes;
  } finally {
    release();
    cancelEntered?.();
    await Promise.allSettled(promises);
    f.close();
  }
}
it('concurrent identical pending imports complete normally while retaining ownership', async () => {
  const outcomes = await pendingImport(false);
  expect(outcomes).toMatchObject([{ status: 'fulfilled' }, { status: 'fulfilled' }]);
  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled' || !outcome.value) throw new Error('real pending import did not yield a module');
    expect(await value(outcome.value)).toEqual(success('old-helper'));
  }
});
it('an observed tree change while import is pending refuses registration after await', async () => {
  const outcomes = await pendingImport(true);
  expect(outcomes).toEqual([
    { status: 'rejected', reason: expect.any(PackRestartRequiredError) },
    { status: 'rejected', reason: expect.any(PackRestartRequiredError) },
  ]);
});
it('failed imports retain path ownership; changed replacement is refused instead of relabeling a cached rejection', async () => {
  const f = fixture("throw new Error('fixture-import-failed-node-lifetime');\n");
  try {
    await expect(loadPackFromManifest(f.dir)).rejects.toThrow('fixture-import-failed-node-lifetime');
    expect(() => assertNodePackReplaceable(f.dir)).toThrow(PackRestartRequiredError);
    writeFileSync(join(f.dir, 'index.mjs'), normalEntry()); attestPackDir(f.dir); invalidatePackTrustVerdict(f.dir);
    expect(verifyInstalledPack(f.dir)).toBeNull();
    await expect(loadPackFromManifest(f.dir)).rejects.toBeInstanceOf(PackRestartRequiredError);
  } finally { f.close(); }
});

it('identical tree bytes cannot rebind an imported lexical alias to a different real root', async () => {
  const { realpathSync } = await import('node:fs');
  const { packContentDigest } = await import('../src/packs/packContentDigest.js');
  // Capture the real entry identity once, before an alias can be retargeted.
  const entry = "import { realpathSync } from 'node:fs';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\nconst where = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;\nexport const nodes = { '" + TYPE + "': async () => ({status:'success',outputs:{where}}) };\n";
  const f = fixture(entry), alias = join(f.root, 'identity-alias'), target = join(f.root, 'identical-real');
  try {
    cpSync(f.dir, target, { recursive: true });
    expect(verifyInstalledPack(target), 'new real target has valid ordinary fixture attestation').toBeNull();
    const digest = packContentDigest(f.dir);
    expect(packContentDigest(target), 'the discriminator is real identity, not changed bytes').toBe(digest);
    expect(hash(join(target, 'index.mjs'))).toBe(hash(join(f.dir, 'index.mjs')));
    const originalURL = pathToFileURL(realpathSync(join(f.dir, 'index.mjs'))).href;
    const targetURL = pathToFileURL(realpathSync(join(target, 'index.mjs'))).href;
    expect(targetURL).not.toBe(originalURL);

    symlinkSync(f.dir, alias, 'dir');
    const original = await loaded(alias);
    expect(await value(original), 'actual original executing root before retarget').toEqual({ status: 'success', outputs: { where: originalURL } });
    expect(getNodeRegistry().get(TYPE)).toBe(original);
    rmSync(alias); symlinkSync(target, alias, 'dir');
    expect(realpathSync(alias)).toBe(realpathSync(target));
    expect(packContentDigest(alias)).toBe(digest);
    expect(verifyInstalledPack(alias)).toBeNull();

    // Capture real loader outcome and registration before any control reload.
    // On the unfixed helper this exposes the captured old real entry under a new root.
    const attempted: unknown = await loadPackFromManifest(alias).then(
      module => module ? value(module) : null, error => error,
    );
    const registrationAfterAttempt = getNodeRegistry().get(TYPE);

    // Complete genuine positives before the final refusal oracle: both source
    // roots are valid, and new aliases to the original identity remain allowed.
    const originalAgain = await loaded(f.dir);
    expect(await value(originalAgain)).toEqual({ status: 'success', outputs: { where: originalURL } });
    const allowedAlias = join(f.root, 'another-original-alias');
    symlinkSync(f.dir, allowedAlias, 'dir');
    expect(await value(await loaded(allowedAlias))).toEqual({ status: 'success', outputs: { where: originalURL } });
    const coldTarget = await loaded(target);
    expect(await value(coldTarget), 'valid cold real target captures its own real entry identity').toEqual({ status: 'success', outputs: { where: targetURL } });

    expect(attempted, 'identical-digest retarget must refuse instead of publishing cached original code').toBeInstanceOf(PackRestartRequiredError);
    expect(registrationAfterAttempt, 'refusal precedes metadata/registry overwrite').toBe(original);
  } finally { f.close(); }
});
