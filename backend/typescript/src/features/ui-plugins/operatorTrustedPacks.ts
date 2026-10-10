/**
 * ADR 0840 D5 — front-end plugin packs installed under OPERATOR trust, one pack per
 * trust entry (RFC 0238 §D.1: "an explicit operator act … MUST NOT be on by default").
 *
 * The conformance fixture `ui-plugin-pack-narrow` ships in the vendored
 * `conformance-fixtures/frontend-plugin-packs/` (a manifest JSON beside its `ui/`
 * entry files), but nothing there loads unless the operator names the pack in
 * `OPENWOP_UI_PLUGIN_OPERATOR_TRUST`:
 *
 *   [{ "pack": "<manifest name>", "tenant": "<tenant id>",
 *      "publicKey": "<Ed25519 SPKI PEM>", "signature": "<base64>" }]
 *
 * `signature` is the operator's detached Ed25519 signature over the canonical
 * statement `{"entries":{"<entry path>":"<sha256>",…},"manifestSha256":"…","pack":"…","version":"…"}`
 * (keys sorted, no whitespace). A statement of hashes, not `manifest ‖ entry`:
 * concatenation has no framing, so bytes could move between the parts and still
 * verify (ADR 0840 architect #4). Verification is the existing primitive
 * (`verifyDetachedPinned`) with a one-key keyring scoped to that pack.
 *
 * A separate trust root from ADR 0367's keyring on purpose: that one grants
 * MAIN-FRAME execution to any pack its key signed; this grants a sandboxed install
 * of one named pack. Every failure refuses the pack with a WARN and it is simply
 * absent (fail closed), which the RFC 0238 scenario records as `inapplicable`.
 *
 * The entry bytes are read and hashed ONCE, at verification, and those exact bytes
 * are what the frame serves: no re-read between the check and the use.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../observability/logger.js';
import { verifyDetachedPinned } from '../../host/packSignature.js';
import { locateRepoDir } from '../../host/_repoPath.js';
import { UI_PLUGIN_MAX_ENTRY_BYTES, type HostUiPluginMethod } from '../../host/uiPluginRpc.js';
import type { FrontendPluginManifest, UiPluginDecl } from './frontendPluginPacks.js';

const log = createLogger('feature.ui-plugins.operator-trust');

/** RFC 0238 §D — the conformance fixture's identity. */
export const UI_PLUGIN_FIXTURE_PACK = 'core.openwop.conformance.ui-plugin-narrow';
export const UI_PLUGIN_FIXTURE_ARTIFACT = 'ui-plugin-narrow-artifact';

export interface OperatorTrustEntry { pack: string; tenant: string; publicKey: string; signature: string }

export interface OperatorTrustedPack {
  manifest: FrontendPluginManifest;
  tenant: string;
  /** pluginId → the exact verified entry bytes. */
  entries: ReadonlyMap<string, Buffer>;
}

/** Keys sorted at every level, no whitespace: the bytes the operator signs. */
export function canonicalStatement(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalStatement).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalStatement((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function packsDir(): string | null {
  const override = process.env.OPENWOP_UI_PLUGIN_OPERATOR_PACKS_DIR;
  if (override) return override;
  try {
    return resolve(locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'conformance-fixtures', 'frontend-plugin-packs'), 'frontend-plugin-packs');
  } catch {
    return null;
  }
}

function parseTrust(raw: string | undefined): OperatorTrustEntry[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) throw new Error('not an array');
    return list.filter((e): e is OperatorTrustEntry => {
      const ok = !!e && typeof e === 'object'
        && ['pack', 'tenant', 'publicKey', 'signature'].every((k) => typeof (e as Record<string, unknown>)[k] === 'string' && (e as Record<string, string>)[k]!.length > 0);
      if (!ok) log.warn('operator_trust_entry_refused', { reason: 'pack, tenant, publicKey and signature are all required' });
      return ok;
    });
  } catch (err) {
    log.warn('operator_trust_unparseable', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

function loadOne(dir: string, entry: OperatorTrustEntry, validate: (m: unknown) => boolean): OperatorTrustedPack | null {
  const refuse = (reason: string): null => { log.warn('operator_trusted_pack_refused', { pack: entry.pack, reason }); return null; };
  let manifestBytes: Buffer | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const bytes = readFileSync(resolve(dir, f));
    try {
      const m = JSON.parse(bytes.toString('utf8')) as { kind?: unknown; name?: unknown };
      if (m.kind === 'frontend-plugin' && m.name === entry.pack) { manifestBytes = bytes; break; }
    } catch { /* not a manifest */ }
  }
  if (!manifestBytes) return refuse('no frontend-plugin manifest with that name');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as FrontendPluginManifest;
  if (!validate(manifest)) return refuse('manifest fails the frontend-plugin schema');

  const entries = new Map<string, Buffer>();
  const entryHashes: Record<string, string> = {};
  for (const p of manifest.uiPlugins) {
    const abs = resolve(dir, p.entry);
    if (abs !== dir && !abs.startsWith(dir + sep)) return refuse(`entry ${p.entry} escapes the packs dir`);
    if (!existsSync(abs) || !statSync(abs).isFile()) return refuse(`entry ${p.entry} is missing`);
    if (statSync(abs).size > UI_PLUGIN_MAX_ENTRY_BYTES) return refuse(`entry ${p.entry} exceeds maxEntryBytes`);
    const bytes = readFileSync(abs);
    entries.set(p.pluginId, bytes);
    entryHashes[p.entry] = sha256(bytes);
  }
  const statement = canonicalStatement({ pack: manifest.name, version: manifest.version, manifestSha256: sha256(manifestBytes), entries: entryHashes });
  const keyring = { keys: { [entry.pack]: entry.publicKey }, revoked: new Set<string>() };
  if (!verifyDetachedPinned(Buffer.from(statement, 'utf8'), Buffer.from(entry.signature, 'base64'), entry.pack, keyring)) {
    return refuse('signature does not verify over the canonical statement');
  }
  return { manifest, tenant: entry.tenant, entries };
}

let cache: { key: string; packs: OperatorTrustedPack[] } | null = null;

/** The operator-trusted packs, verified once per trust configuration. */
export function operatorTrustedPacks(validate: (m: unknown) => boolean): OperatorTrustedPack[] {
  const raw = process.env.OPENWOP_UI_PLUGIN_OPERATOR_TRUST;
  const dir = packsDir();
  const key = `${raw ?? ''}\u0000${dir ?? ''}`;
  if (cache?.key === key) return cache.packs;
  const trust = parseTrust(raw);
  const packs = trust.length > 0 && dir && existsSync(dir)
    ? trust.map((t) => loadOne(resolve(dir), t, validate)).filter((p): p is OperatorTrustedPack => p !== null)
    : [];
  if (trust.length > 0 && (!dir || !existsSync(dir))) log.warn('operator_trusted_packs_dir_missing', { dir });
  cache = { key, packs };
  return packs;
}

/** Test seam: drop the memo (the env is the configuration). */
export function __resetOperatorTrustedPacksForTest(): void { cache = null; }

export type { HostUiPluginMethod, UiPluginDecl };
