/**
 * ADR 1014 P1 — prior agent-pack versions stay on disk (D1) and the registry
 * resolves `agentId@version` beside the head (D2).
 *
 * Real installer, real `tar`, real signature and trust checks; only `fetch` (the
 * registry) is stubbed, as in `adr0826-install-closed-world`. Installing 1.0.0
 * then 1.1.0 must leave 1.1.0 live at `<name>/` and 1.0.0 archived, still
 * trusted, and loadable as exactly that version, never as a fallback.
 *
 * Red when: an upgrade deletes the outgoing version; the archive loses its trust
 * verdict; a named version falls back to the head (or the head is overwritten by
 * an archive load); a version a deployment row names is pruned; an unreadable pin
 * source lets the prune delete anything; or a pack with no agents is archived.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { installPackFromRegistry } from '../src/packs/registryInstaller.js';
import { __resetArchiveFetchStateForTests, fetchArchivedVersion } from '../src/packs/installLane.js';
import { __resetRegistryDiscoveryCache } from '../src/host/packSignature.js';
import { classifyPackDir, __resetPackTrustCachesForTests } from '../src/host/packTrust.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getAgentRegistry, setAgentArchiveResolver } from '../src/executor/agentRegistry.js';
import {
  ARCHIVE_DIR, ARCHIVE_KEEP_NEWEST, archiveOutgoingAgentPack, archivedVersionDir, pruneAgentPackArchive, setArchivePinnedVersions,
} from '../src/packs/agentPackArchive.js';

const REGISTRY = 'https://registry.test';
const NAME = 'acme.agents.versioned';
const AGENT = `${NAME}.a`;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const realFetch = globalThis.fetch;
let workdir: string;
let packDir: string;

const packJson = (version: string, agents = true): string => JSON.stringify({
  name: NAME, version, description: 'fixture', author: 'test', license: 'Apache-2.0',
  engines: { openwop: '>=1.0.0 <3.0.0' },
  signing: { method: 'ed25519', publicKeyRef: 'acme-key' },
  ...(agents ? { agents: [{ agentId: AGENT, persona: `Persona ${version}`, modelClass: 'general', systemPrompt: `I am ${version}.` }] } : {}),
}, null, 2);

let hits = 0;
/** Serve `version` of the pack, signed, as the registry would (`badSig` signs other bytes). */
function serve(version: string, opts: { badSig?: boolean } = {}): void {
  const src = mkdtempSync(join(workdir, 'src-'));
  const pj = packJson(version);
  writeFileSync(join(src, 'pack.json'), pj);
  const out = join(workdir, `t-${version}.tar`);
  expect(spawnSync('tar', ['-cf', out, '-C', src, 'pack.json']).status).toBe(0);
  const tgz = gzipSync(readFileSync(out));
  const sig = edSign(null, Buffer.from(opts.badSig ? `${pj} ` : pj), privateKey);
  const integrity = `sha256-${createHash('sha256').update(tgz).digest('base64')}`;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const ok = (b: string | Uint8Array, t = 'application/json') => new Response(typeof b === 'string' ? b : new Blob([new Uint8Array(b)]), { status: 200, headers: { 'content-type': t } });
    if (u.endsWith('.tgz')) hits += 1;
    if (u.endsWith('.json') && u.includes('/t1/packs/')) return ok(JSON.stringify({ name: NAME, version, integrity, signing: { method: 'ed25519', publicKeyRef: 'acme-key' } }));
    if (u.endsWith('.tgz')) return ok(new Uint8Array(tgz), 'application/gzip');
    if (u.endsWith('.sig')) return ok(new Uint8Array(sig), 'application/octet-stream');
    if (u.includes('/keys/')) return ok(PUB_PEM, 'text/plain');
    if (u.endsWith('/.well-known/openwop-registry.json')) return ok(JSON.stringify({
      signingKeys: [{ keyId: 'acme-key', permittedNamespaces: ['acme.*'] }],
      endpoints: { publicKey: '/keys/{keyId}.pub', v1: { versionManifest: '/t1/packs/{name}/-/{version}.json', versionTarball: '/t1/packs/{name}/-/{version}.tgz', versionSignature: '/t1/packs/{name}/-/{version}.sig' } },
    }));
    throw new Error(`unstubbed fetch: ${u}`);
  }) as typeof globalThis.fetch;
}

const install = (version: string) => installPackFromRegistry({ name: NAME, version }, { packDir, registry: REGISTRY });
const markerVersion = (dir: string): string => (JSON.parse(readFileSync(join(dir, '.openwop-installed.json'), 'utf-8')) as { version: string }).version;

const realPackDir = process.env.OPENWOP_PACK_DIR;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'adr1014-'));
  packDir = mkdtempSync(join(workdir, 'packs-'));
  process.env.OPENWOP_PACK_DIR = packDir; // `fetchArchivedVersion` installs under the default pack dir
  hits = 0;
  __resetArchiveFetchStateForTests();
  __resetRegistryDiscoveryCache();
  __resetPackTrustCachesForTests();
  getAgentRegistry()._resetForTest();
  setArchivePinnedVersions(undefined);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realPackDir === undefined) delete process.env.OPENWOP_PACK_DIR; else process.env.OPENWOP_PACK_DIR = realPackDir;
  rmSync(workdir, { recursive: true, force: true });
  setAgentArchiveResolver(undefined);
  setArchivePinnedVersions(undefined);
});

describe('ADR 1014 D1 — an upgrade archives the outgoing agent-pack version', () => {
  it('1.0.0 → 1.1.0 leaves 1.1.0 live and 1.0.0 archived, still trusted', async () => {
    serve('1.0.0');
    expect((await install('1.0.0')).installed).toBe(true);
    serve('1.1.0');
    expect((await install('1.1.0')).installed).toBe(true);

    expect(markerVersion(join(packDir, NAME))).toBe('1.1.0');
    const archived = archivedVersionDir(packDir, NAME, '1.0.0')!;
    expect(markerVersion(archived)).toBe('1.0.0');
    expect(JSON.parse(readFileSync(join(archived, 'pack.json'), 'utf-8')).agents[0].persona).toBe('Persona 1.0.0');
    // The marker travels with the bytes, so the archive keeps the install's trust.
    expect(classifyPackDir(archived).dispatchable).toBe(true);
    // Hidden from every `readdirSync(packDir)` scan: only the head and the dot dir.
    expect(readdirSync(packDir).sort()).toEqual([ARCHIVE_DIR, NAME].sort());
  });

  it('a pack that declares no agents is replaced as before, not archived', () => {
    const live = join(packDir, NAME);
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'pack.json'), packJson('1.0.0', false));
    writeFileSync(join(live, '.openwop-installed.json'), JSON.stringify({ version: '1.0.0' }));
    expect(archiveOutgoingAgentPack(packDir, NAME, '1.1.0')).toBe(false);
    expect(existsSync(join(packDir, ARCHIVE_DIR))).toBe(false);
  });
});

describe('ADR 1014 D2 — the registry resolves agentId@version beside the head', () => {
  it('a named version loads from the archive; the head stays the head; an unknown version is null', async () => {
    serve('1.0.0');
    await install('1.0.0');
    serve('1.1.0');
    await install('1.1.0');
    const registry = getAgentRegistry();
    loadAgentsFromManifest(join(packDir, NAME));
    // The same two lines the bootstrap registers (bootstrap/agentPackResolver.ts).
    setAgentArchiveResolver(async (_id, version, packName) => {
      const dir = archivedVersionDir(packDir, packName, version);
      if (dir && existsSync(join(dir, 'pack.json'))) loadAgentsFromManifest(dir, { archived: true });
    });

    expect(registry.get(AGENT)?.packVersion).toBe('1.1.0');
    expect(registry.get(AGENT, undefined, '1.0.0'), 'not loaded yet, and never a fallback').toBeNull();
    const old = await registry.resolve(AGENT, undefined, '1.0.0');
    expect(old?.packVersion).toBe('1.0.0');
    expect(old?.persona).toBe('Persona 1.0.0');
    expect(registry.get(AGENT)?.packVersion, 'loading an archive never replaces the head').toBe('1.1.0');
    expect((await registry.resolve(AGENT, undefined, '1.1.0'))?.persona).toBe('Persona 1.1.0');
    expect(await registry.resolve(AGENT, undefined, '9.9.9')).toBeNull();
  });
});

describe('ADR 1014 Q3 — retention: newest ten plus every version a row names', () => {
  const seed = (n: number): string[] => {
    const versions = Array.from({ length: n }, (_, i) => `1.0.${i}`);
    for (const v of versions) {
      const d = archivedVersionDir(packDir, NAME, v)!;
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'pack.json'), packJson(v));
    }
    mkdirSync(join(packDir, NAME), { recursive: true });
    writeFileSync(join(packDir, NAME, 'pack.json'), packJson('2.0.0'));
    return versions;
  };
  const left = (): string[] => readdirSync(join(packDir, ARCHIVE_DIR, NAME)).sort((a, b) => Number(a.split('.')[2]) - Number(b.split('.')[2]));

  it('keeps the newest ten and a row-named old version; drops the rest', async () => {
    const versions = seed(14);
    setArchivePinnedVersions(async (_pack, ids) => new Set(ids.includes(AGENT) ? ['1.0.0'] : []));
    const dropped = await pruneAgentPackArchive(packDir, NAME);
    expect(dropped.sort()).toEqual(['1.0.1', '1.0.2', '1.0.3']);
    expect(left()).toEqual(['1.0.0', ...versions.slice(-ARCHIVE_KEEP_NEWEST)]);
  });

  it('an unreadable pin source deletes nothing', async () => {
    seed(14);
    setArchivePinnedVersions(async () => { throw new Error('store down'); });
    expect(await pruneAgentPackArchive(packDir, NAME)).toEqual([]);
    expect(left()).toHaveLength(14);
  });

  it('refuses a path-shaped pack name or version', () => {
    expect(archivedVersionDir(packDir, '../etc', '1.0.0')).toBeNull();
    expect(archivedVersionDir(packDir, NAME, '../../x')).toBeNull();
  });
});

describe('ADR 1014 D1 (corrected) — a version is fetched from the registry, in the background, verified', () => {
  const cached = (v: string): boolean => existsSync(join(archivedVersionDir(packDir, NAME, v)!, '.openwop-installed.json'));
  const stray = (): string[] => (existsSync(join(packDir, ARCHIVE_DIR, NAME)) ? readdirSync(join(packDir, ARCHIVE_DIR, NAME)).filter((e) => e.startsWith('.tmp-')) : []);

  it('fetches exactly name@version into the archive without touching the head, and the registry then resolves it', async () => {
    serve('1.1.0');
    await install('1.1.0');
    loadAgentsFromManifest(join(packDir, NAME));
    setAgentArchiveResolver(async (_id, version, packName) => {
      const dir = archivedVersionDir(packDir, packName, version);
      if (dir && existsSync(join(dir, 'pack.json'))) loadAgentsFromManifest(dir, { archived: true });
    });
    expect(await getAgentRegistry().resolve(AGENT, undefined, '1.0.0'), 'not fetched yet').toBeNull();
    serve('1.0.0');
    expect(await fetchArchivedVersion(NAME, '1.0.0')).toBe(true);
    expect((await getAgentRegistry().resolve(AGENT, undefined, '1.0.0'))?.persona, 'end to end through the registry').toBe('Persona 1.0.0');
    expect(cached('1.0.0')).toBe(true);
    expect(markerVersion(join(packDir, NAME)), 'the head is untouched').toBe('1.1.0');
    expect(classifyPackDir(archivedVersionDir(packDir, NAME, '1.0.0')!).dispatchable).toBe(true);
    expect(stray()).toEqual([]);
  });

  it('concurrent requests for one version make one fetch and land it once', async () => {
    serve('1.0.0');
    const [a, b, c] = await Promise.all([fetchArchivedVersion(NAME, '1.0.0'), fetchArchivedVersion(NAME, '1.0.0'), fetchArchivedVersion(NAME, '1.0.0')]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(hits, 'one tarball download').toBe(1);
    expect(stray()).toEqual([]);
    expect(await fetchArchivedVersion(NAME, '1.0.0')).toBe(true);
    expect(hits, 'a cached version is not fetched again').toBe(1);
  });

  it('a bad signature is refused: nothing is cached and no temp dir is left', async () => {
    serve('1.0.0', { badSig: true });
    expect(await fetchArchivedVersion(NAME, '1.0.0')).toBe(false);
    expect(cached('1.0.0')).toBe(false);
    expect(stray()).toEqual([]);
  });

  it('a failed download backs off instead of re-downloading on every run', async () => {
    serve('1.0.0');
    const serving = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (u.endsWith('.tgz')) { hits += 1; throw new Error('ECONNRESET'); }
      return serving(input);
    }) as typeof globalThis.fetch;
    expect(await fetchArchivedVersion(NAME, '1.0.0')).toBe(false);
    expect(hits).toBe(1);
    expect(await fetchArchivedVersion(NAME, '1.0.0')).toBe(false);
    expect(hits, 'the backoff makes no second download').toBe(1);
  });

  it('a hung registry is bounded for the caller and never stacks a second download', async () => {
    let calls = 0;
    globalThis.fetch = (() => { calls += 1; return new Promise<Response>(() => undefined); }) as typeof globalThis.fetch;
    const t0 = Date.now();
    expect(await fetchArchivedVersion(NAME, '1.0.0', { timeoutMs: 50 })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const during = calls;
    expect(await fetchArchivedVersion(NAME, '1.0.0', { timeoutMs: 50 })).toBe(false);
    expect(calls, 'the first download still holds the slot').toBe(during);
    expect(cached('1.0.0')).toBe(false);
    // Never a fallback: the registry still answers null for the version.
    expect(await getAgentRegistry().resolve(AGENT, undefined, '1.0.0')).toBeNull();
  });

  it('a failed archive never fails the install: the new version still lands', async () => {
    serve('1.0.0');
    await install('1.0.0');
    writeFileSync(join(packDir, ARCHIVE_DIR), 'not a directory'); // the archive move cannot happen
    serve('1.1.0');
    expect((await install('1.1.0')).installed).toBe(true);
    expect(markerVersion(join(packDir, NAME))).toBe('1.1.0');
  });

  it('an archive dir that cannot be created resolves false, never throws', async () => {
    writeFileSync(join(packDir, ARCHIVE_DIR), 'not a directory');
    serve('1.0.0');
    await expect(fetchArchivedVersion(NAME, '1.0.0')).resolves.toBe(false);
  });

  it('a leftover version dir without a marker is replaced by the verified fetch', async () => {
    const final = archivedVersionDir(packDir, NAME, '1.0.0')!;
    mkdirSync(final, { recursive: true });
    writeFileSync(join(final, 'pack.json'), 'partial');
    serve('1.0.0');
    expect(await fetchArchivedVersion(NAME, '1.0.0')).toBe(true);
    expect(markerVersion(final)).toBe('1.0.0');
    expect(classifyPackDir(final).dispatchable).toBe(true);
  });
});
