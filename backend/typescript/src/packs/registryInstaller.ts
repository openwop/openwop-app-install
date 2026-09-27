/**
 * Registry-side pack installer for packs.openwop.dev (or any registry
 * following the same shape per `spec/v1/node-pack-registry.md`).
 *
 * For each {name, version}:
 *   1. Fetch the version manifest, tarball, and signature.
 *   2. Resolve the signing public key (registry/keys/<keyId>.pub on disk,
 *      then HTTPS /keys/<keyId>.pub as a fallback).
 *   3. Verify the tarball's SHA-256 SRI integrity AND Ed25519 signature.
 *   4. Extract to ./packs/<name>/ (any pre-existing dir is replaced).
 *   5. Drop a `.openwop-installed.json` trust marker so the runtime
 *      pack loader knows the manifest was verified at install-time
 *      and doesn't need to re-check the manifest signature.
 *
 * The installer is best-effort: shells out to /usr/bin/tar (bsdtar/
 * GNU tar both work). Real hosts use a vetted tar library + extract
 * into a sandboxed dir. The verification logic is the same.
 */

import { resolveRegistry, templateFor, expandEndpoint, legacyPathsEnabled, type EndpointKey } from './registryEndpoints.js';
import { PROTOCOL_VERSION_V2 } from '../middleware/protocolVersion.js';
import { createHash, createPublicKey, verify as verifySig } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createLogger } from '../observability/logger.js';
import { isTombstoned } from '../host/packTombstones.js';
import { assertCanonicalManifest } from './canonicalManifestGate.js';
import { assertKeyPermittedForPack } from '../host/packSignature.js';
import { verifyContentHashes } from './packContentDigest.js';
import { checkPackManifestForMajor } from '../host/packManifestV2Gate.js';

const log = createLogger('packs.registryInstaller');

const DEFAULT_REGISTRY = 'https://packs.openwop.dev';
/** This host serves major 2, so it reads the tree a major-2 host must read (ADR 0663). */
const HOST_PROTOCOL_MAJOR = Number(PROTOCOL_VERSION_V2.split('.')[0]);
const MARKER = '.openwop-installed.json';

export interface InstallTarget {
  name: string;
  version: string;
}

export interface InstallOptions {
  packDir: string;
  registry?: string;
  /** Local fallback directory for signing keys (registry/keys/). */
  trustedKeysDir?: string;
}

/** A version manifest's `signing` block. Its shape depends on the TREE it came
 *  from: v1 `{ method, publicKeyRef, signatureRef? }`; v2 `{ keyId, scheme }`
 *  (`spec/v2/core/packs.md` §Signing). Every field optional here so the reader
 *  below decides, per tree, what a valid block is. */
interface ManifestSigning {
  keyId?: unknown;
  scheme?: unknown;
  method?: unknown;
  publicKeyRef?: unknown;
  signatureRef?: unknown;
}

interface PackVersionManifest {
  name: string;
  version: string;
  signing?: ManifestSigning;
  integrity: string;
}

/** The v2 tree's one signing scheme (`spec/v2/core/packs.md` §Signing). */
export const V2_SIGNING_SCHEME = 'ed25519-canonical-json';

/**
 * ADR 0713 — the signing key id a version manifest names, read the way its TREE
 * defines it, or a thrown `pack_signature_unverifiable`.
 *
 * This used to read `signing.publicKeyRef` unconditionally. ADR 0663 moved this
 * host onto the v2 tree, whose manifests carry `{ keyId, scheme }` and where
 * "`publicKeyRef` does not exist" — so every v2 install in production failed here
 * (16 of 16 at the 2026-09-16 boot), and the image-vendored copy served instead.
 *
 * - v2: `keyId` (non-empty string) AND `scheme === 'ed25519-canonical-json'`,
 *   REQUIRED; a block carrying `method` "fails validation" per the spec. The
 *   signed bytes are the canonical-JSON `pack.json` inside the tarball — what
 *   `extractPackJsonFromTarball` already returns, and what the registry's own
 *   `verify-signatures.mjs` verifies for v2.
 * - v1 / flat / legacy paths: `publicKeyRef`, unchanged.
 */
export function manifestSigningKeyId(signing: ManifestSigning | undefined, tree: string): string {
  if (tree === 'v2') {
    if (!signing || typeof signing.keyId !== 'string' || signing.keyId.length === 0) {
      throw new Error('pack_signature_unverifiable: v2 manifest has no signing.keyId');
    }
    if (signing.scheme !== V2_SIGNING_SCHEME) {
      throw new Error(`pack_signature_unverifiable: v2 signing.scheme must be ${V2_SIGNING_SCHEME}`);
    }
    if (signing.method !== undefined || signing.publicKeyRef !== undefined) {
      throw new Error('pack_signature_unverifiable: v2 signing block carries a v1 field (method/publicKeyRef)');
    }
    return signing.keyId;
  }
  if (!signing || typeof signing.publicKeyRef !== 'string' || signing.publicKeyRef.length === 0) {
    throw new Error('pack_signature_unverifiable: no signing.publicKeyRef in manifest');
  }
  return signing.publicKeyRef;
}

interface InstallMarker {
  name: string;
  version: string;
  integrity: string;
  /** The signing key id. Named for its v1 origin and kept (the marketplace
   *  listing reads it); for a v2 install it holds `signing.keyId` (ADR 0713). */
  publicKeyRef: string;
  registry: string;
  installedAt: string;
  /** SHA-256 hex digest of each load-bearing file in the install
   *  dir. Re-verified by `verifyInstalledPack()` on every load. */
  contentHashes: Record<string, string>;
}

/** Files copied from a verified install. Anything outside this set
 *  (READMEs, LICENSEs, CHANGELOGs) is skipped to keep the install dir
 *  free of files that aren't load-bearing. */
const ALLOWED_FILES = new Set(['pack.json', 'index.mjs']);
// `prompts` added for RFC 0070 / RFC 0003 §C: agent manifests carry
// `systemPromptRef` (e.g. `prompts/supervisor.md`) which the AgentRegistry
// loader resolves from the installed pack dir at load time.
const ALLOWED_SUBDIRS = new Set(['schemas', 'keys', 'prompts']);

export async function installPackFromRegistry(
  target: InstallTarget,
  opts: InstallOptions,
): Promise<{ installed: boolean; reason?: string }> {
  const registry = opts.registry ?? DEFAULT_REGISTRY;
  const destDir = join(opts.packDir, target.name);

  // Idempotent: skip if already installed at the requested version.
  if (existsSync(join(destDir, MARKER))) {
    try {
      const marker = JSON.parse(readFileSync(join(destDir, MARKER), 'utf-8')) as InstallMarker;
      if (marker.version === target.version) {
        return { installed: false, reason: 'already_installed' };
      }
    } catch {
      /* fall through to reinstall */
    }
  }

  // 1. Fetch the version manifest.
  // ADR 0663 — `packs.md` §"The registry tree": a client MUST resolve every
  // registry path through `.well-known/openwop-registry.json` `endpoints`
  // rather than constructing one. Constructing `/v1/…` both violated that and
  // pinned this host to the frozen tree, where no major-2-admissible version
  // is published.
  const resolution = await resolveRegistry(registry, HOST_PROTOCOL_MAJOR);
  const urlFor = (key: EndpointKey, vars: Record<string, string>): string => {
    if (resolution.ok) {
      const tpl = templateFor(resolution.resolved, key);
      if (tpl) return `${registry.replace(/\/+$/, '')}${expandEndpoint(tpl, vars)}`;
      throw new Error(
        `registry_endpoint_missing: ${key} is not named by ${registry}/.well-known/openwop-registry.json`,
      );
    }
    if (!legacyPathsEnabled()) {
      // An unreachable registry keeps the vocabulary the rest of the install
      // path already uses for exactly that cause (ADR 0660); only a registry
      // that ANSWERED without `endpoints` gets the new code.
      if (resolution.reason === 'unreachable') {
        throw new Error(
          `pack_registry_unreachable: ${registry}/.well-known/openwop-registry.json did not answer`,
        );
      }
      throw new Error(
        `registry_endpoints_unresolvable: ${registry}/.well-known/openwop-registry.json publishes no `
        + '`endpoints` map. packs.md §"The registry tree" requires paths to be resolved through it; this host '
        + 'will not construct one. Set OPENWOP_REGISTRY_LEGACY_V1_PATHS=true only for a registry that predates it.',
      );
    }
    const legacy: Record<EndpointKey, string> = {
      registryIndex: '/v1/index.json',
      packMetadata: `/v1/packs/${vars.name}/index.json`,
      versionManifest: `/v1/packs/${vars.name}/-/${vars.version}.json`,
      versionTarball: `/v1/packs/${vars.name}/-/${vars.version}.tgz`,
      versionSignature: `/v1/packs/${vars.name}/-/${vars.version}.sig`,
      publicKey: `/keys/${vars.keyId}.pub`,
    };
    return `${registry.replace(/\/+$/, '')}${legacy[key]}`;
  };

  const manifestUrl = urlFor('versionManifest', { name: target.name, version: target.version });
  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) {
    throw new Error(`manifest_fetch_failed (${manifestRes.status}): ${manifestUrl}`);
  }
  const manifest = (await manifestRes.json()) as PackVersionManifest;
  if (manifest.name !== target.name || manifest.version !== target.version) {
    throw new Error(
      `manifest_identity_mismatch: requested ${target.name}@${target.version}, got ${manifest.name}@${manifest.version}`,
    );
  }

  // 2. Fetch the tarball.
  const tarballUrl = urlFor('versionTarball', { name: target.name, version: target.version });
  const tarballRes = await fetch(tarballUrl);
  if (!tarballRes.ok) {
    throw new Error(`tarball_fetch_failed (${tarballRes.status}): ${tarballUrl}`);
  }
  const tarballBytes = Buffer.from(await tarballRes.arrayBuffer());

  // 3. SHA-256 SRI integrity over the tarball.
  const [algo, expectedB64] = manifest.integrity.split('-');
  if (algo !== 'sha256') {
    throw new Error(`unsupported_integrity_algorithm: ${algo}`);
  }
  const computedB64 = createHash('sha256').update(tarballBytes).digest('base64');
  if (computedB64 !== expectedB64) {
    throw new Error(`pack_integrity_mismatch: expected ${expectedB64}, got ${computedB64}`);
  }

  // 4. Resolve public key. Try the on-disk registry/keys/ first
  // (faster + works offline), then fall back to the registry's
  // /keys/<keyId>.pub endpoint.
  // ADR 0713 — the tree the manifest was fetched from decides the signing shape.
  // The legacy constructed paths are `/v1/…`, so they read as v1.
  const keyRef = manifestSigningKeyId(manifest.signing, resolution.ok ? resolution.resolved.tree : 'v1');
  const publicKeyPem = await resolvePublicKey(keyRef, opts.trustedKeysDir, urlFor);

  // 5. Fetch the signature and verify Ed25519 against the pack.json
  // bytes inside the tarball. Canonical recipe per
  // registry/scripts/verify-signatures.mjs — the signature is over the
  // raw pack.json file (not the whole tarball), so we gunzip + USTAR-
  // parse to find pack.json before verifying.
  const sigUrl = urlFor('versionSignature', { name: target.name, version: target.version });
  const sigRes = await fetch(sigUrl);
  if (!sigRes.ok) {
    throw new Error(`signature_fetch_failed (${sigRes.status}): ${sigUrl}`);
  }
  const sigBytes = Buffer.from(await sigRes.arrayBuffer());
  const packJsonBytes = extractPackJsonFromTarball(tarballBytes);
  const verified = verifySig(null, packJsonBytes, createPublicKey(publicKeyPem), sigBytes);
  if (!verified) {
    throw new Error('pack_signature_invalid');
  }

  // 5a. ADR 0660 D1 — STEP 4 of the spec's trust model, which this host did not
  // implement at all: the signature proves the key signed this pack; THIS proves
  // the issuing registry AUTHORIZED that key for this pack's namespace
  // (`spec/v1/registry-operations.md:405-409`). Without it, the steps above accept
  // ANY key the registry serves, so a key issued for `acme.*` signs
  // `core.openwop.*`. Fail-closed, including on an unreachable discovery document.
  await assertKeyPermittedForPack(registry, keyRef, target.name);

  // 5b. PMC-5 — canonical MANIFEST validation, on the bytes we just verified.
  // A signature proves AUTHORSHIP, not SHAPE: until now a correctly-signed pack
  // with a structurally invalid manifest installed cleanly. Runs BEFORE extraction
  // so a malformed pack never reaches disk.
  //
  // Deliberately gated to kinds whose shipped packs already validate (measured:
  // form-content 1/1, artifact-type 0/4). Enforcing every kind today would reject
  // packs this repo ships — see docs/steward/PACK-MANIFEST-CANONICAL-GAP.md.
  {
    assertCanonicalManifest(packJsonBytes);
  }

  // RFC 0177 §A.1/§B.1/§E.1 — the same major-2 admission gate used
  // by the mirror test surface also owns the production registry path. A
  // signature proves who authored these bytes; it does not make an inadmissible
  // engine range, peer family, or ranged chain reference safe to install.
  const packManifest = JSON.parse(packJsonBytes.toString('utf8')) as unknown;
  const refusal = checkPackManifestForMajor(packManifest, HOST_PROTOCOL_MAJOR);
  if (refusal) throw new Error(`${refusal.code}: ${refusal.message}`);

  // 6. Extract. Stage into a temp dir to detect any wrapper directory
  // (e.g., npm-style `package/`). Then copy only the load-bearing
  // files (pack.json, index.mjs, schemas/, keys/) to destDir —
  // skipping READMEs and LICENSEs whose relative `../../spec/v1/*.md`
  // links pollute spec-corpus link-walks if the install dir ends up
  // anywhere under the openwop repo.
  const stageDir = join(tmpdir(), `openwop-install-${target.name.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}`);
  mkdirSync(stageDir, { recursive: true });
  const tarballPath = join(stageDir, 'pack.tgz');
  // Computed during the install path; persisted in the marker so the
  // runtime loader can re-verify on each load.
  let packJsonSha = '';
  let indexMjsSha: string | undefined;
  try {
    writeFileSync(tarballPath, tarballBytes);
    const r = spawnSync('tar', ['-xzf', tarballPath, '-C', stageDir], { encoding: 'utf-8' });
    if (r.status !== 0) {
      throw new Error(`tar_extract_failed: ${r.stderr ?? ''}`);
    }
    // Delete the tarball immediately so findPackRoot doesn't have to
    // skip it by name, and so the install dir stays clean if the
    // tarball had no wrapper directory.
    rmSync(tarballPath, { force: true });
    const packRoot = findPackRoot(stageDir);
    if (!packRoot) {
      throw new Error('extracted_archive_missing_pack_json');
    }
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true });
    }
    mkdirSync(destDir, { recursive: true });
    copyAllowlistedFiles(packRoot, destDir);
    packJsonSha = createHash('sha256').update(readFileSync(join(destDir, 'pack.json'))).digest('hex');
    // ADR 0660 D3 — verify-one / install-another. `extractPackJsonFromTarball`
    // returns the FIRST root `pack.json` entry, while `tar -xzf` lets the LAST
    // one win on disk: so the signature AND the canonical-manifest gate can both
    // validate bytes that are then overwritten. Re-hash what actually landed.
    // (`copyAllowlistedFiles` is a byte copy, so this cannot fail spuriously.)
    // Scope: this binds `pack.json` only — `index.mjs` has no verified reference
    // bytes to compare against, and is covered by the marker below, not a signature.
    if (packJsonSha !== createHash('sha256').update(packJsonBytes).digest('hex')) {
      throw new Error('pack_integrity_mismatch: the installed pack.json is not the bytes that were verified');
    }
    const indexPath = join(destDir, 'index.mjs');
    if (existsSync(indexPath)) {
      indexMjsSha = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  // 7. Drop the trust marker. SHA-256 of pack.json + index.mjs lets
  // the loader re-verify the install on every boot — without this,
  // anyone with write access to the install dir could replace the
  // code post-install and bypass the install-time signature check.
  const marker: InstallMarker = {
    name: manifest.name,
    version: manifest.version,
    integrity: manifest.integrity,
    publicKeyRef: keyRef,
    registry,
    installedAt: new Date().toISOString(),
    contentHashes: {
      'pack.json': packJsonSha,
      ...(indexMjsSha ? { 'index.mjs': indexMjsSha } : {}),
    },
  };
  writeFileSync(join(destDir, MARKER), JSON.stringify(marker, null, 2));

  log.info('pack installed and verified', {
    name: manifest.name,
    version: manifest.version,
    integrity: manifest.integrity,
    keyRef,
  });
  return { installed: true };
}

async function resolvePublicKey(
  keyRef: string,
  trustedKeysDir: string | undefined,
  urlFor: (key: EndpointKey, vars: Record<string, string>) => string,
): Promise<string> {
  if (trustedKeysDir) {
    const localPath = join(trustedKeysDir, `${keyRef}.pub`);
    if (existsSync(localPath)) {
      return readFileSync(localPath, 'utf-8');
    }
  }
  // `publicKey` is unversioned by design ("keys are not protocol-versioned"),
  // so it resolves from the flat alias rather than a tree.
  const keyUrl = urlFor('publicKey', { keyId: keyRef });
  const keyRes = await fetch(keyUrl);
  if (!keyRes.ok) {
    throw new Error(`public_key_fetch_failed (${keyRes.status}): ${keyUrl}`);
  }
  return keyRes.text();
}

/**
 * Extract pack.json from a gzipped USTAR tarball. Returns the raw bytes
 * the publisher signed (parse-and-re-serialize would normalize JSON
 * whitespace and break the signature).
 *
 * Ported from registry/scripts/verify-signatures.mjs's extractPackJson.
 * Pack tarballs MUST keep the pack.json entry name <= 100 bytes. PAX metadata
 * records are skipped: bsdtar emits them for ordinary short-name archives on
 * macOS, and ignoring their optional overrides is fail-closed here (we only
 * accept a literal root pack.json header, then bind it to the extracted bytes).
 * GNU LongLink still throws rather than risk silent name substitution.
 */
function extractPackJsonFromTarball(tarballBytes: Buffer): Buffer {
  const decompressed = gunzipSync(tarballBytes);
  const BLOCK = 512;
  for (let off = 0; off + BLOCK <= decompressed.length; ) {
    const nameBuf = decompressed.subarray(off, off + 100);
    const nameEnd = nameBuf.indexOf(0);
    const name = nameBuf.subarray(0, nameEnd < 0 ? 100 : nameEnd).toString('utf8');
    if (!name) break;
    const sizeStr = decompressed
      .subarray(off + 124, off + 136)
      .toString('ascii')
      .replace(/\0/g, '')
      .trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = decompressed[off + 156];
    if (typeflag === 0x4c) {
      throw new Error(
        `tarball uses extended USTAR header (typeflag=0x${typeflag.toString(16)}); not supported`,
      );
    }
    if (name === 'pack.json' || name === './pack.json') {
      return Buffer.from(decompressed.subarray(off + BLOCK, off + BLOCK + size));
    }
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new Error('pack.json not found in tarball');
}

function findPackRoot(stageDir: string): string | null {
  // Direct hit: tarball extracts files at the top level (rare).
  if (existsSync(join(stageDir, 'pack.json'))) return stageDir;

  // Common: single wrapper directory (npm `package/`, or `<name>-<version>/`).
  const entries = readdirSync(stageDir).filter((e) => {
    const full = join(stageDir, e);
    return statSync(full).isDirectory();
  });
  for (const e of entries) {
    if (existsSync(join(stageDir, e, 'pack.json'))) {
      return join(stageDir, e);
    }
  }
  return null;
}

/**
 * Copy only ALLOWED_FILES + ALLOWED_SUBDIRS from `from` to `to`. Skips
 * READMEs, LICENSEs, CHANGELOGs, and anything else the pack ships that
 * isn't needed at runtime. The `keys/` subdir is preserved because
 * legacy on-disk packs use it for the manifest-signature path even
 * though registry-installed packs don't.
 */
function copyAllowlistedFiles(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isFile() && ALLOWED_FILES.has(entry.name)) {
      writeFileSync(join(to, entry.name), readFileSync(join(from, entry.name)));
      continue;
    }
    if (entry.isDirectory() && ALLOWED_SUBDIRS.has(entry.name)) {
      const subFrom = join(from, entry.name);
      const subTo = join(to, entry.name);
      mkdirSync(subTo, { recursive: true });
      const r = spawnSync('cp', ['-R', `${subFrom}/.`, subTo], { encoding: 'utf-8' });
      if (r.status !== 0) {
        throw new Error(`copy_subdir_failed: ${entry.name}: ${r.stderr ?? ''}`);
      }
    }
  }
}

/**
 * Returns true when the pack dir holds a verified install marker.
 * Consumed by the runtime loader to skip the legacy manifest-sig path.
 */
export function isInstalledPack(packDir: string): boolean {
  return existsSync(join(packDir, MARKER));
}

/**
 * Re-verify a registry-installed pack against its trust marker. The
 * loader calls this on every load — without it, anyone with write
 * access to the install dir could swap `index.mjs` post-install and
 * bypass the install-time signature check.
 *
 * Returns null on success, or a string reason on failure.
 */
export function verifyInstalledPack(packDir: string): string | null {
  const markerPath = join(packDir, MARKER);
  if (!existsSync(markerPath)) return 'marker_missing';
  let marker: InstallMarker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as InstallMarker;
  } catch {
    return 'marker_invalid_json';
  }
  if (!marker.contentHashes || typeof marker.contentHashes !== 'object') {
    return 'marker_missing_content_hashes';
  }
  // ADR 0555 P0 — one hasher, not two. `host/packTrust.ts` re-verifies these
  // same hashes to decide `operator-trusted`, and two implementations of "does
  // this file still hash to what the marker says" would drift into disagreeing
  // about whether an install is tampered.
  return verifyContentHashes(packDir, marker.contentHashes);
}

/**
 * On-disk presence tier for a pack, by name (ADR 0194 Phase 2; `tombstoned`
 * added in Phase 4). Read-only, display-grade — the runtime loader's verify
 * path stays the authority:
 *  - `installed`  — dir present WITH a verified-install trust marker (registry path)
 *  - `mounted`    — dir present without a marker (dev-mount / symlink)
 *  - `missing`    — no pack dir
 *  - `tombstoned` — removed from this host (bytes may remain for replay)
 * `version` is the on-disk `pack.json` version when present — callers compare it
 * to their pinned ref so the UI never claims a pinned version is installed when a
 * different one is on disk.
 */
export function packPresence(name: string): { status: 'installed' | 'mounted' | 'missing' | 'tombstoned'; version?: string } {
  if (isTombstoned(name)) return { status: 'tombstoned' };
  const dir = join(resolveDefaultPackDir(), name);
  const manifestPath = join(dir, 'pack.json');
  if (!existsSync(manifestPath)) return { status: 'missing' };
  const status = isInstalledPack(dir) ? 'installed' : 'mounted';
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version?: string };
    return typeof manifest.version === 'string' ? { status, version: manifest.version } : { status };
  } catch {
    return { status }; // malformed manifest: presence is still honest, version unknown
  }
}

/** Parse `name@version` pairs from `OPENWOP_INSTALL_PACKS`. */
export function parseInstallList(raw: string | undefined): InstallTarget[] {
  if (!raw) return [];
  const out: InstallTarget[] = [];
  for (const entry of raw.split(',')) {
    const [name, version] = entry.trim().split('@');
    if (!name || !version) continue;
    out.push({ name, version });
  }
  return out;
}

/**
 * A pack name that is SAFE to join onto the pack dir for a filesystem operation
 * (ADR 0194 review hardening). Rejects path traversal + separators so a
 * `join(packDir, name)` can never escape the pack dir — defense-in-depth for the
 * marketplace remove/purge routes, independent of any upstream existence gate.
 * Deliberately looser than the publish-surface `PACK_NAME_RE` (`routes/packs.ts`)
 * because the marketplace also handles in-tree `feature.*` packs, which that
 * publish regex excludes. The one invariant here is "no path escape".
 */
export function isSafePackName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 214 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..' &&
    !name.split('.').includes('') && // rejects leading/trailing/`..` dot segments
    /^[a-zA-Z0-9._-]+$/.test(name)
  );
}

export function resolveDefaultPackDir(): string {
  // Default outside the repo working tree. Installed packs ship with
  // their own READMEs whose relative `../../spec/v1/*.md` links don't
  // resolve when extracted into a deep subdir of the repo — the
  // openwop spec-corpus link-check walks every .md under the repo
  // and flags those as broken. Caching under $HOME side-steps the
  // problem and is also more durable across `git clean`.
  return process.env.OPENWOP_PACK_DIR ?? join(homedir(), '.openwop-packs');
}
