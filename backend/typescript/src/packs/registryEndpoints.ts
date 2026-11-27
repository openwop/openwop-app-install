/**
 * Registry path resolution (ADR 0663) — `packs.md` §"The registry tree".
 *
 * > The registry is versioned by tree, not by header. It publishes
 * > `registry/v2/packs/<name>/-/<version>.{json,sbom.json,sig,tgz}` as a
 * > parallel tree of re-signed manifests … `.well-known/openwop-registry.json`
 * > `endpoints` is the negotiation: it names both trees, and **a client MUST
 * > resolve every registry path through `endpoints` rather than constructing
 * > one.**
 *
 * This host constructed them. `registryInstaller.ts` built
 * `${registry}/v1/packs/{name}/-/{version}.json` inline — the MUST violated,
 * and the frozen v1 tree hardcoded, so a major-2 admissible version (published
 * only under `/v2/`) was unreachable: re-pinning production to one answered
 * `manifest_fetch_failed (404)`. Measured 2026-09-11 on packs.openwop.dev:
 * `v1 …/rag/-/1.0.1.json` → `engines.openwop: ">=1.0.0 <2.0.0"` (inadmissible
 * at major 2); `v2 …/rag/-/1.0.2.json` → `">=1.0.0 <3.0.0"`; `v1 …/1.0.2.json`
 * → 404. All 57 of this host's production pins were v1-tier versions.
 *
 * The tree is chosen by the host's protocol major, not guessed: a major-2 host
 * resolves the `v2` tree when the registry advertises one. `publicKey` is
 * deliberately unversioned (`keys are not protocol-versioned`), so it resolves
 * from the flat alias.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('packs.registryEndpoints');

/** The endpoint keys this host resolves. `publicKey` is unversioned by design. */
export type EndpointKey =
  | 'registryIndex'
  | 'packMetadata'
  | 'versionManifest'
  | 'versionTarball'
  | 'versionSignature'
  | 'publicKey';

export type RegistryTree = 'v2';

interface EndpointMap {
  readonly [k: string]: string | { readonly [k: string]: string } | undefined;
}

export interface ResolvedRegistry {
  readonly tree: RegistryTree;
  readonly endpoints: EndpointMap;
}

/**
 * Two different facts, never one. `unreachable` means the registry did not
 * answer for its own discovery document — the operator's problem, and the
 * existing `pack_registry_unreachable` vocabulary already names it.
 * `no_endpoints` means it answered and does not publish the `endpoints` map
 * this host must resolve through — the registry's problem, and a different
 * fix. Collapsing them reports an outage as a conformance gap and a
 * conformance gap as an outage.
 */
export type RegistryResolution =
  | { readonly ok: true; readonly resolved: ResolvedRegistry }
  | { readonly ok: false; readonly reason: 'unreachable' | 'no_endpoints' | 'no_v2_tree' };

const cache = new Map<string, Promise<RegistryResolution>>();

/** Test seam: the cache is per-process and per-registry-URL. */
export function resetRegistryEndpointCache(): void {
  cache.clear();
  docCache.clear();
}

/**
 * ONE fetch of `.well-known/openwop-registry.json` per registry, shared by
 * every consumer of it. `host/packSignature.ts` already fetched this document
 * for `signingKeys[].permittedNamespaces` (ADR 0660); adding a second fetcher
 * here for `endpoints` would have made two caches and two failure modes for
 * one document. It returns the raw document so each consumer reads its own
 * field and keeps its own error vocabulary — `packSignature` must still fail
 * closed with `pack_registry_unreachable` when `signingKeys[]` is absent,
 * which is a different question from whether `endpoints` is.
 */
const docCache = new Map<string, Promise<RegistryDocument | null>>();

export interface RegistryDocument {
  readonly signingKeys?: unknown;
  readonly endpoints?: EndpointMap;
}

export async function fetchRegistryDocument(registry: string): Promise<RegistryDocument | null> {
  const base = registry.replace(/\/+$/, '');
  const hit = docCache.get(base);
  if (hit) return hit;
  const p = (async (): Promise<RegistryDocument | null> => {
    const url = `${base}/.well-known/openwop-registry.json`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn('registry_wellknown_status', { url, status: res.status });
        return null;
      }
      return (await res.json()) as RegistryDocument;
    } catch (err) {
      log.warn('registry_wellknown_unreachable', { url, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  })();
  docCache.set(base, p);
  return p;
}

/**
 * RFC 0266 — this host reads the registry's v2 tree only. The v1 tree is frozen
 * v1-signed history (packs.md §"The registry tree"; §Signing: a v1 signature is
 * re-signed into the v2 tree, never relabelled), so there is no v1 or flat
 * fallback and no operator pin back to v1. A registry that publishes no
 * `endpoints.v2` is refused (`no_v2_tree`): every v2-signed pack lives there.
 */
export function hasV2Tree(endpoints: EndpointMap): boolean {
  return typeof endpoints['v2'] === 'object' && endpoints['v2'] !== null;
}

/**
 * Fetch and cache `.well-known/openwop-registry.json`. Returns `null` when the
 * registry does not serve one — the caller decides whether that is fatal
 * (it is, unless the operator opted into legacy constructed paths).
 */
export async function resolveRegistry(registry: string, hostMajor: number): Promise<RegistryResolution> {
  const key = `${registry}|${hostMajor}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<RegistryResolution> => {
    const doc = await fetchRegistryDocument(registry);
    if (!doc) return { ok: false, reason: 'unreachable' };
    const endpoints = doc.endpoints;
    if (!endpoints || typeof endpoints !== 'object') {
      log.warn('registry_wellknown_no_endpoints', { registry });
      return { ok: false, reason: 'no_endpoints' };
    }
    if (!hasV2Tree(endpoints)) {
      log.warn('registry_wellknown_no_v2_tree', { registry });
      return { ok: false, reason: 'no_v2_tree' };
    }
    log.info('registry_endpoints_resolved', { registry, tree: 'v2' });
    return { ok: true, resolved: { tree: 'v2', endpoints } };
  })();
  cache.set(key, p);
  return p;
}

/** The template for one endpoint from the v2 tree. Only `publicKey` may come from
 *  the flat map: keys are unversioned by design (packs.md §"The registry tree");
 *  every other flat key is a deprecated v1-era alias of the v1 tree. */
export function templateFor(resolved: ResolvedRegistry, key: EndpointKey): string | null {
  const treeMap = resolved.endpoints[resolved.tree];
  if (treeMap && typeof treeMap === 'object') {
    const t = (treeMap as Record<string, string>)[key];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  if (key !== 'publicKey') return null;
  const flat = resolved.endpoints[key];
  return typeof flat === 'string' && flat.length > 0 ? flat : null;
}

/**
 * Expand `{name}` / `{version}` / `{keyId}` in a template. Values are
 * percent-encoded per path segment: a pack name is already validated by
 * `isSafePackName`, but a template is registry-supplied and the expansion
 * must not become a path-traversal seam for a hostile registry.
 */
export function expandEndpoint(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`registry_endpoint_unbound_variable: {${k}}`);
    return encodeURIComponent(v);
  });
}

