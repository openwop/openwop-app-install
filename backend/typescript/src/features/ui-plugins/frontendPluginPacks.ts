/**
 * Front-end plugin pack loader — OpenWOP RFC 0117 (front-end plugin packs) +
 * RFC 0119 (isolation mechanism-neutrality). Loads `kind:"frontend-plugin"` packs
 * (vendored under `<repo>/packs/*`), validates each against the pinned
 * `frontend-plugin-manifest.schema.json`, and resolves a plugin's `entry` bundle
 * bytes for the host to SERVE to the sandboxed front-end loader.
 *
 * This is the host's "load + serve the downloaded pack" leg of the graduation bar:
 * the FE `PluginFrame` fetches the manifest list + the entry bytes from here and
 * mounts the plugin in a cross-origin sandboxed iframe. The manifest's declared
 * `surface`/`hostApi` are intersected with what the host actually advertises
 * (`uiPluginsCapability()` — the SAME single source discovery.ts advertises), so a
 * pack can never surface a capability the host doesn't honor (RFC 0117 §Degradation).
 *
 * ── Isolation is host-advertised, not pack-chosen (RFC 0119) ──
 * The pack manifest carries NO isolation field; the host owns the mechanism it
 * applies (`UI_PLUGIN_ISOLATION` = `cross-origin-iframe`) and advertises it as a
 * categorical enum member. `hostIsolation()` re-exports that one value so the FE
 * loader and the non-drift test read the SAME source the advert does.
 *
 * ── Trust (mirrors workflowChainPackLoader R7) ──
 * In-tree vendored packs are trusted source (no load-time signature check here).
 * A pack ships a detached Ed25519 signature (`pack.json.sig` + `pack.sig.json`) as
 * the REGISTRY-PUBLISH artifact — signature verification is the registry-fetch path
 * (packs.openwop.dev), not this in-tree loader, exactly as the chain/connection/node
 * loaders treat their vendored packs.
 *
 * @see docs/adr/0300-frontend-plugin-loader-rfc-0117-0119.md
 * @see ../../../schemas/frontend-plugin-manifest.schema.json (RFC 0117)
 * @see ../../host/uiPluginRpc.ts (the ui-plugin/1 host-RPC single source)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createLogger } from '../../observability/logger.js';
import { locateRepoSchemasDir } from '../../host/_repoPath.js';
import {
  UI_PLUGIN_ISOLATION,
  UI_PLUGIN_MAX_ENTRY_BYTES,
  uiPluginsCapability,
  type HostUiPluginMethod,
} from '../../host/uiPluginRpc.js';

const log = createLogger('feature.ui-plugins.packs');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = locateRepoSchemasDir(__dirname, 'frontend-plugin-manifest.schema.json');
/** `<repo>/packs` — the vendored source packs dir (image-vendored per DEPLOY.md). */
const PACKS_DIR = process.env.OPENWOP_FRONTEND_PLUGIN_PACK_DIR ?? join(dirname(SCHEMAS_DIR), 'packs');

// ── manifest shapes (the subset we consume; the schema is the authority) ──

export interface UiPluginDecl {
  pluginId: string;
  surface: 'artifact-viewer' | 'route' | 'settings-panel' | 'canvas-preview';
  entry: string;
  hostApi: HostUiPluginMethod[];
  /** RFC 0130 — canvas-preview only: the canvas type id(s) this preview renders. */
  canvasTypes?: string[];
  connectSrc?: string[];
}
export interface FrontendPluginManifest {
  name: string;
  version: string;
  kind: 'frontend-plugin';
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  engines: { openwop: string };
  uiPlugins: UiPluginDecl[];
}

/** A plugin as the host SERVES it — the manifest decl filtered to what the host
 *  honors, plus the pack it came from and the URL the FE loader downloads. */
export interface ServedPlugin {
  packName: string;
  packVersion: string;
  pluginId: string;
  surface: UiPluginDecl['surface'];
  /** RFC 0130 — present for canvas-preview plugins that declared it. */
  canvasTypes?: string[];
  /** hostApi ∩ the host's advertised set — the closed allowlist for THIS plugin. */
  hostApi: HostUiPluginMethod[];
  /** Host-relative path the FE loader GETs the entry bytes from. */
  entryPath: string;
}

// ── schema validator (lazy singleton, mirrors workflowChainPackLoader) ──
let _validator: ValidateFunction | undefined;
function validator(): ValidateFunction {
  if (_validator) return _validator;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, 'frontend-plugin-manifest.schema.json'), 'utf8'));
  _validator = ajv.compile(schema);
  return _validator;
}

/** The host's advertised isolation mechanism (RFC 0119 categorical value). The FE
 *  loader and the advertise/serve non-drift test read THIS, not a literal, so the
 *  advertised value and the mechanism the loader applies can never drift. */
export function hostIsolation(): typeof UI_PLUGIN_ISOLATION {
  return UI_PLUGIN_ISOLATION;
}

const HOST_SURFACES = new Set(uiPluginsCapability().surfaces);
const HOST_HOST_API = new Set(uiPluginsCapability().hostApi);

/** Scan + validate every vendored `kind:"frontend-plugin"` pack and project each
 *  plugin to the host-honored `ServedPlugin` shape. Packs that fail schema
 *  validation are skipped with a WARN (never crash the boot / the endpoint). */
export function listFrontendPluginPacks(): ServedPlugin[] {
  if (!existsSync(PACKS_DIR)) return [];
  const validate = validator();
  const served: ServedPlugin[] = [];

  for (const dirent of readdirSync(PACKS_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = join(PACKS_DIR, dirent.name, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: FrontendPluginManifest;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { kind?: string };
      if (raw.kind !== 'frontend-plugin') continue; // not our kind — another pack loader owns it
      if (!validate(raw)) {
        log.warn('frontend-plugin manifest failed schema validation; skipping', {
          pack: dirent.name,
          errors: validate.errors?.slice(0, 3),
        });
        continue;
      }
      manifest = raw as unknown as FrontendPluginManifest;
    } catch (err) {
      log.warn('frontend-plugin manifest unreadable; skipping', { pack: dirent.name, error: String(err) });
      continue;
    }

    for (const p of manifest.uiPlugins) {
      // Degradation (RFC 0117 §Degradation): a surface the host doesn't advertise,
      // or a hostApi method it doesn't recognize, is filtered — installable-but-inert,
      // never an error. hostApi is intersected to the host set = the closed allowlist.
      if (!HOST_SURFACES.has(p.surface)) continue;
      const hostApi = p.hostApi.filter((m) => HOST_HOST_API.has(m));
      served.push({
        packName: manifest.name,
        packVersion: manifest.version,
        pluginId: p.pluginId,
        surface: p.surface,
        hostApi,
        // RFC 0130: the canvas-preview binding key — without it on the wire the
        // FE discovery→mount match can never fire (code-review C1).
        ...(Array.isArray(p.canvasTypes) && p.canvasTypes.length ? { canvasTypes: p.canvasTypes } : {}),
        entryPath: `/v1/host/openwop-app/ui-plugin/packs/${encodeURIComponent(manifest.name)}/plugins/${encodeURIComponent(p.pluginId)}/entry`,
      });
    }
  }
  return served;
}

export interface PluginEntry {
  bytes: Buffer;
  /** Always text/html for the reference viewer; the sandbox renders it via srcdoc. */
  contentType: string;
}

/** Resolve the on-disk pack directory whose `frontend-plugin` manifest `name` equals
 *  `packName`. `listFrontendPluginPacks()` locates packs by DIRECTORY name but serves them
 *  under `manifest.name`; `/entry` must map that served name back to the correct dir even
 *  when the two differ. Returns the absolute dir (safe — always a real child of PACKS_DIR),
 *  or null when no such pack exists. */
function resolvePackDirByManifestName(packName: string): string | null {
  if (!existsSync(PACKS_DIR)) return null;
  for (const dirent of readdirSync(PACKS_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = join(PACKS_DIR, dirent.name, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { kind?: string; name?: string };
      if (raw.kind === 'frontend-plugin' && raw.name === packName) return resolve(PACKS_DIR, dirent.name);
    } catch {
      continue;
    }
  }
  return null;
}

/** ADR 0367 P2 — everything the trusted lane needs to VERIFY before serving.
 *
 *  The T1 payload is NOT the sandbox `entry` (HTML for srcdoc) — it is the ES
 *  MODULE sibling `<entry-basename>.mjs`, dynamic-imported into the main frame,
 *  with a detached signature `<module>.sig` over the exact module bytes. The
 *  signing refs come from the `pack.sig.json` SIDECAR (RFC 0117 §Signing) — the
 *  frontend-plugin manifest schema is wire-pinned (`additionalProperties:false`)
 *  and deliberately carries no signing block, so the sidecar is the ONLY place
 *  a pack can name its key without a wire change.
 *
 *  Same uniform-null posture as getPluginEntry (route answers 404 on miss):
 *  no module file, no module signature, no sidecar, traversal, or over-cap ⇒ null.
 */
export interface TrustCandidate {
  packDir: string;
  /** Identity + sidecar-derived signing refs, in `verifyPinned`'s shape. */
  manifest: { name: string; version: string; signing: { keyId: string; signatureRef: string } };
  /** The ES-module bytes the T1 lane serves (main-frame `import()` target). */
  moduleBytes: Buffer;
  /** Detached Ed25519 signature over exactly `moduleBytes`. */
  moduleSignature: Buffer;
}

export function resolveTrustCandidate(packName: string, pluginId: string, servedHint?: ServedPlugin[]): TrustCandidate | null {
  // Host-honored plugins only — the same filter the sandbox lane serves through.
  // A caller that already listed the packs passes them as the hint so a
  // request labeling N plugins costs one directory scan, not N+1.
  const served = (servedHint ?? listFrontendPluginPacks()).find((p) => p.packName === packName && p.pluginId === pluginId);
  if (!served) return null;
  const packDir = resolvePackDirByManifestName(packName);
  if (!packDir) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(packDir, 'pack.json'), 'utf8')) as FrontendPluginManifest;
    const decl = manifest.uiPlugins.find((p) => p.pluginId === pluginId);
    if (!decl) return null;
    const moduleRel = decl.entry.replace(/\.[^./\\]+$/, '.mjs');
    if (!moduleRel.endsWith('.mjs')) return null;
    const moduleAbs = resolve(packDir, moduleRel);
    if (moduleAbs !== packDir && !moduleAbs.startsWith(packDir + sep)) return null; // traversal guard
    const sigAbs = `${moduleAbs}.sig`;
    if (!existsSync(moduleAbs) || !statSync(moduleAbs).isFile() || !existsSync(sigAbs)) return null;
    if (statSync(moduleAbs).size > UI_PLUGIN_MAX_ENTRY_BYTES) return null;
    const sidecar = JSON.parse(readFileSync(join(packDir, 'pack.sig.json'), 'utf8')) as { keyId?: unknown; signatureFile?: unknown };
    if (typeof sidecar.keyId !== 'string' || typeof sidecar.signatureFile !== 'string') return null;
    return {
      packDir,
      manifest: { name: manifest.name, version: manifest.version, signing: { keyId: sidecar.keyId, signatureRef: sidecar.signatureFile } },
      moduleBytes: readFileSync(moduleAbs),
      moduleSignature: readFileSync(sigAbs),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve + read a plugin's `entry` bundle bytes, enforcing:
 *  - the plugin exists and its surface/hostApi survive the host filter (else null),
 *  - path-traversal safety: the resolved entry MUST stay inside the pack dir
 *    (defense-in-depth on top of the schema's no-`..`/no-leading-`/` pattern),
 *  - the `UI_PLUGIN_MAX_ENTRY_BYTES` cap the host advertises (a larger bundle → null).
 * Returns null (never throws) on any miss so the route answers a uniform 404.
 */
export function getPluginEntry(packName: string, pluginId: string): PluginEntry | null {
  const served = listFrontendPluginPacks().find((s) => s.packName === packName && s.pluginId === pluginId);
  if (!served) return null;

  // Locate the pack by its manifest `name`, NOT by assuming the on-disk directory is
  // named after it. `listFrontendPluginPacks` scans by DIRECTORY name but serves each pack
  // under `manifest.name`; the two need not match. Reconstructing `packDir` from the served
  // name (as before) 404s any pack whose dir name ≠ manifest name even though it lists fine.
  const packDir = resolvePackDirByManifestName(packName);
  if (!packDir) return null;
  const manifestPath = join(packDir, 'pack.json');
  if (!existsSync(manifestPath)) return null;
  let manifest: FrontendPluginManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FrontendPluginManifest;
  } catch {
    return null;
  }
  const decl = manifest.uiPlugins.find((p) => p.pluginId === pluginId);
  if (!decl) return null;

  const entryAbs = resolve(packDir, decl.entry);
  // Traversal guard: entryAbs must be within packDir.
  if (entryAbs !== packDir && !entryAbs.startsWith(packDir + sep)) {
    log.warn('frontend-plugin entry escapes pack dir; refusing', { pack: packName, entry: decl.entry });
    return null;
  }
  if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) return null;
  if (statSync(entryAbs).size > UI_PLUGIN_MAX_ENTRY_BYTES) {
    log.warn('frontend-plugin entry exceeds maxEntryBytes; refusing', { pack: packName, cap: UI_PLUGIN_MAX_ENTRY_BYTES });
    return null;
  }
  return { bytes: readFileSync(entryAbs), contentType: 'text/html; charset=utf-8' };
}
