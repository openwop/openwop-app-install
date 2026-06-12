/**
 * RFC 0095 §B.6 reference implementation — connection-pack boot-time loader.
 *
 * Makes the in-code provider registry (ADR 0024 `providerRegistry.ts`)
 * INSTALLABLE: scans pack roots at boot for `pack.json` with
 * `kind: "connection"`, validates each against the vendored
 * `connection-pack-manifest.schema.json` (RFC 0095 §A), and registers the
 * pack's `provider` into the same registry the built-ins live in — so a
 * connector's `auth.provider` (RFC 0045) / `host.oauth` (RFC 0047) resolves
 * against installed packs via the unchanged `getProvider()`.
 *
 * Guarantees enforced here (spec/v1/connection-packs.md):
 *   - §B.2: a manifest carrying credential material (a secret-named property,
 *     anywhere in the object) is REJECTED with `connection_pack_credential_material`.
 *     The OAuth *client* secret stays host-side (ADR 0024 §7), never in a pack.
 *   - §B.3 / §B.5: https-only fixed endpoints + reach exactly-one-of are enforced
 *     by the §A schema (`pattern: ^https://`, `reach` `maxProperties:1`).
 *   - §B.6: provider-id precedence — an installed pack overrides a BUILT-IN of the
 *     same id (the built-in is the version floor); two installed packs with the
 *     same id resolve by SemVer (>= wins), else `connection_provider_conflict`.
 *
 * A connection pack carries NO secret, so there is no BYOK sealing here — the
 * pack is public provider metadata only.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { OpenwopError, type OpenwopErrorCode } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { locateRepoSchemasDir } from '../../host/_repoPath.js';
import {
  registerProvider,
  listProviders,
  type ProviderManifest,
  type ScopeGroup,
  type CredentialKind,
} from './providerRegistry.js';

const log = createLogger('connection-pack-loader');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = locateRepoSchemasDir(__dirname, 'connection-pack-manifest.schema.json');

/** §B.2 normative secret-property blocklist (spec/v1/connection-packs.md clause 2). */
const SECRET_PROPS = new Set([
  'clientsecret', 'client_secret', 'apikey', 'api_key', 'token',
  'accesstoken', 'refreshtoken', 'password', 'privatekey', 'secret',
]);

let _validator: ValidateFunction | null = null;
function manifestValidator(): ValidateFunction {
  if (_validator) return _validator;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'connection-pack-manifest.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  _validator = ajv.compile(schema);
  return _validator;
}

/** RFC 0095 §A connection-pack manifest (the subset this loader consumes). */
interface ConnectionPackManifest {
  name: string;
  version: string;
  kind: 'connection';
  provider: {
    id: string;
    displayName: string;
    category: string;
    auth: {
      kind: CredentialKind;
      authFlow?: ProviderManifest['authFlow'];
      scopeModel?: string;
      endpoints?: { authorize?: string; token?: string; revoke?: string };
      scopes?: { read?: ScopeGroup[]; write?: ScopeGroup[] };
      instanceUrlTemplate?: string;
    };
    reach:
      | { mcp: { server: { url: string; transport: 'http' | 'sse' } } }
      | { openapi: { ref: string } }
      | { integration: { node: string } };
    consumerNodes?: string[];
    docsUrl?: string;
  };
}

/** §B.2 — recursively reject a manifest carrying any secret-named property.
 *  The ONE blocklist name that is also a legitimate field is `token`, but only at
 *  the exact schema-sanctioned path `provider.auth.endpoints.token` (the OAuth
 *  token-ENDPOINT URL). A FULL-PATH exemption — not a parent-key one — so a
 *  smuggled `*.endpoints.token` elsewhere is still rejected (myndhyve-1 937c).
 *  Every other secret-named property (`clientSecret`/`apiKey`/`password`/…) is
 *  also caught by the schema's `additionalProperties:false`; this scan exists to
 *  emit the specific `connection_pack_credential_material` code (it runs first). */
const TOKEN_ENDPOINT_PATH = 'provider.auth.endpoints';
function assertNoCredentialMaterial(value: unknown, packName: string, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCredentialMaterial(v, packName, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const norm = k.toLowerCase().replace(/[-_]/g, '');
      const isTokenEndpointUrl = norm === 'token' && path === TOKEN_ENDPOINT_PATH;
      if (SECRET_PROPS.has(norm) && !isTokenEndpointUrl) {
        throw new OpenwopError(
          'connection_pack_credential_material',
          `Connection pack '${packName}' carries credential material at \`${path}${path ? '.' : ''}${k}\` — packs MUST NOT ship secrets (RFC 0095 §B.2). The OAuth client secret is host-side (ADR 0024 §7).`,
          422,
          { pack: packName, property: k },
        );
      }
      assertNoCredentialMaterial(v, packName, `${path}${path ? '.' : ''}${k}`);
    }
  }
}

/** Map a §A `provider` to the app's ProviderManifest (ADR 0024 shape). */
function toProviderManifest(p: ConnectionPackManifest['provider']): ProviderManifest {
  const read = p.auth.scopes?.read ?? [];
  const defaultScopes = [...new Set(read.flatMap((g) => g.scopes))];
  const base: ProviderManifest = {
    id: p.id,
    label: p.displayName,
    kind: p.auth.kind,
    authFlow: p.auth.authFlow ?? 'none',
    reach: 'openapi', // overwritten below per reach
    scopes: { read, ...(p.auth.scopes?.write ? { write: p.auth.scopes.write } : {}) },
    ...(p.auth.endpoints ? { endpoints: p.auth.endpoints } : {}),
    refreshable: p.auth.kind === 'oauth2',
    defaultScopes,
    consumerNodes: p.consumerNodes ?? [],
    ...(p.docsUrl ? { docsUrl: p.docsUrl } : {}),
  };
  if ('mcp' in p.reach) {
    return { ...base, reach: 'mcp', mcpServer: p.reach.mcp.server };
  }
  if ('openapi' in p.reach) {
    return { ...base, reach: 'openapi', openapiRef: p.reach.openapi.ref };
  }
  // integration reach: the app injects via core.openwop.integration.* nodes; it
  // has no 'mcp'/'openapi' fetch binding, so advertise as openapi-less metadata.
  return { ...base, reach: 'openapi' };
}

export interface ConnectionPackLoadResult {
  pack: string;
  providerId: string;
  version: string;
  overrodeBuiltin: boolean;
}

/** A pack that was REJECTED (RFC 0095 §B.2/§B.5/§B.6) and therefore NOT
 *  registered. Surfaced (not thrown) so one bad operator pack cannot abort boot. */
export interface ConnectionPackLoadError {
  pack: string;
  code: OpenwopErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ConnectionPackLoadOutcome {
  installed: ConnectionPackLoadResult[];
  errors: ConnectionPackLoadError[];
}

/**
 * Load every `kind: "connection"` pack under `roots` and register its provider.
 *
 * Per-pack failures are ISOLATED, matching the prompt-pack loader's posture
 * (`promptPackLoader.ts` warns + `continue`s per pack) and the registry-pack
 * installer ("install failed; continuing without it"). A pack that ships
 * credential material (§B.2), fails the §A schema (§B.3/§B.5), or loses a
 * provider-id conflict (§B.6) is REJECTED — logged, collected in
 * `outcome.errors`, and skipped — never registered. It does NOT throw, because
 * one malformed pack dropped into an operator's `OPENWOP_CONNECTION_PACKS_DIR`
 * must not take down the whole backend boot. "Rejected" (RFC 0095 §B.2) means
 * the pack is not installed, not that the host refuses to start.
 */
export function loadConnectionPacks(opts: { roots: string[] }): ConnectionPackLoadOutcome {
  const builtinIds = new Set(listProviders().map((p) => p.id)); // snapshot BEFORE loading
  const installedVersions = new Map<string, string>();
  const installed: ConnectionPackLoadResult[] = [];
  const errors: ConnectionPackLoadError[] = [];

  // Build the validator up front, but GUARD it: if the vendored §A schema can't
  // be read or compiled (corrupt/missing file, Ajv2020 compile throw), disable
  // connection-pack loading entirely and keep booting — the same "a load problem
  // must not abort the backend" posture the per-pack loop below applies. The
  // built-in provider catalog remains available. (Cross-host parity: myndhyve-1
  // hardened the equivalent unguarded compile path in their host, id a849.)
  let validate: ValidateFunction;
  try {
    validate = manifestValidator();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('connection-pack schema unavailable; skipping connection-pack loading', { message });
    return { installed, errors: [{ pack: '(schema)', code: 'validation_error', message }] };
  }

  for (const root of opts.roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const packDir = join(root, entry);
      const manifestPath = join(packDir, 'pack.json');
      if (!existsSync(manifestPath) || !statSync(packDir).isDirectory()) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        log.warn('skipping unparseable pack.json', { packDir });
        continue;
      }
      if (!raw || typeof raw !== 'object' || (raw as { kind?: string }).kind !== 'connection') continue;

      const packName = (raw as { name?: string }).name ?? entry;
      try {
        // §B.2 FIRST — a secret-named property must surface as
        // `connection_pack_credential_material`, not the schema's generic
        // `validation_error` (additionalProperties:false would also reject it).
        assertNoCredentialMaterial(raw, packName);
        if (!validate(raw)) {
          throw new OpenwopError(
            'validation_error',
            `Connection pack '${packName}' fails connection-pack-manifest.schema.json: ${ajvErrors(validate)}`,
            422,
            { pack: packName },
          );
        }

        const manifest = raw as ConnectionPackManifest;
        const { id } = manifest.provider;
        const version = manifest.version;

        // §B.6 precedence.
        const prevInstalled = installedVersions.get(id);
        if (prevInstalled !== undefined && !semverGte(version, prevInstalled)) {
          throw new OpenwopError(
            'connection_provider_conflict',
            `Connection pack '${packName}' declares provider '${id}' v${version}, which does not supersede the already-installed v${prevInstalled} (RFC 0095 §B.6).`,
            409,
            { provider: id, installed: prevInstalled, incoming: version },
          );
        }
        const overrodeBuiltin = builtinIds.has(id) && prevInstalled === undefined;

        registerProvider(toProviderManifest(manifest.provider));
        installedVersions.set(id, version);
        installed.push({ pack: packName, providerId: id, version, overrodeBuiltin });
        log.info('installed connection pack', { pack: packName, provider: id, version, overrodeBuiltin });
      } catch (err) {
        // Isolate the failure to THIS pack — log loud, collect, continue.
        if (err instanceof OpenwopError) {
          errors.push({ pack: packName, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
          log.error('rejected connection pack', { pack: packName, code: err.code, message: err.message });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ pack: packName, code: 'validation_error', message });
          log.error('rejected connection pack', { pack: packName, code: 'validation_error', message });
        }
      }
    }
  }
  return { installed, errors };
}

/** SemVer §11 precedence: `a >= b`. A PRE-RELEASE is lower than its release
 *  (`1.0.0-alpha.1 < 1.0.0`), so a prerelease pack must NOT silently supersede a
 *  release of the same core — §B.6 forbids the silent choice (myndhyve-1 937c). */
function semverGte(a: string, b: string): boolean {
  return semverCompare(a, b) >= 0;
}
function semverCompare(a: string, b: string): number {
  // Split on the FIRST hyphen only — a prerelease tag may itself contain hyphens
  // (`1.0.0-x-y` → pre `x-y`); `String.split('-', 2)` would truncate to `x`.
  const splitPre = (s: string): [string, string] => {
    const v = s.split('+')[0];
    const i = v.indexOf('-');
    return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)];
  };
  const [coreA, preA] = splitPre(a);
  const [coreB, preB] = splitPre(b);
  const na = coreA.split('.').map((n) => parseInt(n, 10) || 0);
  const nb = coreB.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) > (nb[i] ?? 0) ? 1 : -1;
  }
  // Equal core. No-prerelease outranks a prerelease.
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  // Both prerelease — compare dot identifiers (numeric < alphanumeric; SemVer §11.4).
  const ia = preA.split('.');
  const ib = preB.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1; // shorter prerelease set is lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) { const d = parseInt(x, 10) - parseInt(y, 10); if (d !== 0) return d > 0 ? 1 : -1; }
    else if (xn) return -1; // numeric identifiers have lower precedence than alphanumeric
    else if (yn) return 1;
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function ajvErrors(v: ValidateFunction): string {
  return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
}

/** Default pack roots: the in-tree `examples/connection-packs/` (when present)
 *  plus an operator dir via `OPENWOP_CONNECTION_PACKS_DIR`. Non-existent roots
 *  are skipped by the loader. `SCHEMAS_DIR` is `<repo>/schemas`, so its parent
 *  is the repo root. */
export function defaultConnectionPackRoots(): string[] {
  const repoRoot = dirname(SCHEMAS_DIR);
  return [
    join(repoRoot, 'examples', 'connection-packs'),
    process.env.OPENWOP_CONNECTION_PACKS_DIR ?? '',
  ].filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Conformance test-seam affordances (host-sample-test-seams.md §10).
// Single-sourced through the SAME §B.2 scan → §A schema → §B.6 precedence path
// the boot loader uses; the seam route (routes/connectionPackSeam.ts) is a thin
// HTTP shim over these. Seam installs track their own version map so a
// conformance run is self-contained and repeatable.
// ---------------------------------------------------------------------------

const seamInstalledVersions = new Map<string, string>();

export interface SeamInstallOutcome {
  installed: boolean;
  errors?: ConnectionPackLoadError[];
}

/** Install ONE manifest exactly as the boot loader would (scan-first, then
 *  schema, then §B.6 precedence vs prior seam installs). Never throws —
 *  rejection means NOT INSTALLED (§B.8), reported with the specific code. */
export function installConnectionPackManifest(raw: unknown): SeamInstallOutcome {
  const packName =
    raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
      ? ((raw as { name: string }).name)
      : '(unnamed)';
  let validate: ValidateFunction;
  try {
    validate = manifestValidator();
  } catch (err) {
    // §B.9 — a schema-compile failure is a structured error, never a throw/5xx.
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, errors: [{ pack: '(schema)', code: 'validation_error', message }] };
  }
  try {
    // §B.2 FIRST — the specific code wins over the generic shape error.
    assertNoCredentialMaterial(raw, packName);
    if (!validate(raw)) {
      throw new OpenwopError(
        'validation_error',
        `Connection pack '${packName}' fails connection-pack-manifest.schema.json: ${ajvErrors(validate)}`,
        422,
        { pack: packName },
      );
    }
    const manifest = raw as ConnectionPackManifest;
    const { id } = manifest.provider;
    const version = manifest.version;
    const prev = seamInstalledVersions.get(id);
    if (prev !== undefined && !semverGte(version, prev)) {
      throw new OpenwopError(
        'connection_provider_conflict',
        `Connection pack '${packName}' declares provider '${id}' v${version}, which does not supersede the already-installed v${prev} (RFC 0095 §B.6).`,
        409,
        { provider: id, installed: prev, incoming: version },
      );
    }
    registerProvider(toProviderManifest(manifest.provider));
    seamInstalledVersions.set(id, version);
    log.info('seam-installed connection pack', { pack: packName, provider: id, version });
    return { installed: true };
  } catch (err) {
    if (err instanceof OpenwopError) {
      return {
        installed: false,
        errors: [{ pack: packName, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }],
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, errors: [{ pack: packName, code: 'validation_error', message }] };
  }
}

export interface SeamResolveOutcome {
  resolved: boolean;
  source?: 'pack' | 'builtin';
  version?: string;
  code?: 'connection_provider_unresolved' | 'connection_provider_conflict';
}

/** §B.6 resolution probe. `simulateBuiltinVersion` lets a conformance run
 *  exercise the installed-vs-built-in SemVer §11 precedence rule without
 *  depending on which providers this deployment happens to build in. */
export function seamResolveProvider(provider: string, simulateBuiltinVersion?: string): SeamResolveOutcome {
  const installedVersion = seamInstalledVersions.get(provider);
  if (simulateBuiltinVersion !== undefined) {
    if (installedVersion === undefined) {
      return { resolved: true, source: 'builtin', version: simulateBuiltinVersion };
    }
    if (!semverGte(installedVersion, simulateBuiltinVersion)) {
      // §B.6 — the installed pack is NOT >=, so the host MUST surface the
      // conflict rather than silently choosing either definition.
      return { resolved: false, code: 'connection_provider_conflict' };
    }
    return { resolved: true, source: 'pack', version: installedVersion };
  }
  const m = listProviders().find((p) => p.id === provider);
  if (!m) {
    return { resolved: false, code: 'connection_provider_unresolved' };
  }
  return {
    resolved: true,
    source: installedVersion !== undefined ? 'pack' : 'builtin',
    ...(installedVersion !== undefined ? { version: installedVersion } : {}),
  };
}

/** Test affordance — re-resolve a provider; throws the spec error when absent. */
export function resolveConnectionProviderOrThrow(id: string): ProviderManifest {
  const m = listProviders().find((p) => p.id === id);
  if (!m) {
    throw new OpenwopError(
      'connection_provider_unresolved',
      `No connection provider '${id}' — install a connection pack whose provider.id is '${id}', or none is built in (RFC 0095 §B.6).`,
      404,
      { provider: id },
    );
  }
  return m;
}
