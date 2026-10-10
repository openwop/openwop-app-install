/**
 * Live pack-registry client (RFC 0003 / 0013 / 0043).
 *
 * Fetches the public registry index + per-pack detail straight from
 * `config.registryBaseUrl` (default packs.openwop.dev). The registry is
 * static JSON over HTTPS — no auth — so these are plain `fetch`es with
 * no credentials.
 *
 * PATHS ARE RESOLVED, NEVER CONSTRUCTED (RFC 0177 §A.3, RFC 0222). The registry
 * is versioned by TREE, and `/.well-known/openwop-registry.json` `endpoints` is
 * the negotiation: this client reads `endpoints.v2` (`registryIndex`,
 * `packMetadata`) and falls back to the flat v1-era aliases only when a
 * registry (an older mirror) publishes no `v2` map. It used to hard-code
 * `/v1/index.json`, which pinned the SPA to the v1 tree after v2 existed.
 * Artifact links (manifest / sig / tarball / SBOM) come from each version
 * record, so they follow whichever tree served it.
 *
 * Per-version records carry the SRI `integrity`, the signing scheme,
 * `signingKeyId`, and deprecated/yanked flags, so the browser surfaces
 * supply-chain provenance without downloading the tarball. v2 renamed two of
 * them (`signingScheme`, `versionDeprecated`) and dropped `publishedAt`;
 * `normalizeVersion` maps both trees onto one record.
 */

import { config } from '../client/config.js';
import { assertArrayField, assertRecord } from '../client/parse.js';
import i18n from '../i18n/index.js';

export interface PackIndexEntry {
  name: string;
  kind: 'node' | 'agent' | string;
  latestVersion: string;
  description: string;
  license: string;
  tags: string[];
  typeIds: string[];
  nodeCount: number;
  agentCount: number;
  deprecated: boolean;
  yanked: boolean;
}

export interface PackVersionRecord {
  version: string;
  /** v1 tree only; the v2 version record has no publish date. */
  publishedAt?: string;
  manifestUrl: string;
  tarballUrl: string;
  signatureUrl: string;
  /** v2 publishes the SBOM link; v1 left it to be derived from the manifest URL. */
  sbomUrl?: string;
  /** v1 `signingMethod`, or v2 `signingScheme`. */
  signingMethod: string;
  signingKeyId: string;
  integrity: string;
  deprecated: boolean;
  yanked: boolean;
}

export interface PackDetail {
  name: string;
  kind: string;
  description: string;
  author?: string;
  license: string;
  homepage?: string;
  repository?: string;
  typeIds: string[];
  nodeCount: number;
  agentCount: number;
  versions: PackVersionRecord[];
  latest: string;
  deprecated: boolean;
}

export interface RegistryIndex {
  registryVersion: string;
  generatedAt: string;
  packCount: number;
  packs: PackIndexEntry[];
}

/** RFC 0043 trust tier inferred from the reverse-DNS namespace prefix. */
export type TrustTier = 'official' | 'vendor' | 'community' | 'unknown';

export function trustTierFor(packName: string): TrustTier {
  if (packName.startsWith('core.openwop.')) return 'official';
  if (packName.startsWith('vendor.')) return 'vendor';
  if (packName.startsWith('community.')) return 'community';
  return 'unknown';
}

const TRUST_TIER_LABEL_KEY: Record<TrustTier, string> = {
  official: 'registry:trustTierOfficial',
  vendor: 'registry:trustTierVendor',
  community: 'registry:trustTierCommunity',
  unknown: 'registry:trustTierUnknown',
} as const;

/** Localized human label for a trust tier. Resolved at call time so it
 *  re-localizes when the active language changes. */
export function trustTierLabel(tier: TrustTier): string {
  return i18n.t(TRUST_TIER_LABEL_KEY[tier]);
}

/** Absolute URL for a registry-relative path (manifest/sig/sbom links
 *  in the index are root-relative, e.g. `/v1/packs/.../1.0.0.json`). */
export function registryUrl(relativePath: string): string {
  const base = config.registryBaseUrl.replace(/\/$/, '');
  return `${base}${relativePath.startsWith('/') ? '' : '/'}${relativePath}`;
}

/** SBOM URL for a version record: the published link (v2), else the manifest's `.sbom.json` sibling (v1). */
export function sbomUrlFor(v: PackVersionRecord): string {
  return registryUrl(v.sbomUrl ?? v.manifestUrl.replace(/\.json$/, '.sbom.json'));
}

/**
 * The version to present as "latest" and install from. RFC 0222: a yanked
 * version stays served (forensics), the index MUST NOT name it `latest` while
 * an unyanked one exists, and a range MUST skip it. So this does not trust
 * `detail.latest` blindly: if it names a yanked version (a stale or
 * non-conforming registry), the newest unyanked version wins. `undefined` only
 * when every version is yanked; there is then nothing to install.
 */
export function latestInstallable(detail: Pick<PackDetail, 'latest' | 'versions'>): PackVersionRecord | undefined {
  const named = detail.versions.find((v) => v.version === detail.latest);
  if (named && !named.yanked) return named;
  const live = detail.versions.filter((v) => !v.yanked);
  return live.length ? live.reduce((a, b) => (compareSemver(b.version, a.version) > 0 ? b : a)) : undefined;
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;   // a release outranks its prereleases
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

interface RegistryEndpoints { registryIndex: string; packMetadata: string }

let endpointsInFlight: Promise<RegistryEndpoints> | null = null;

/** Test seam: forget the resolved endpoint map. */
export function resetRegistryEndpoints(): void { endpointsInFlight = null; }

/** `endpoints.v2` from the registry's well-known document, else its flat v1-era aliases. */
export function resolveRegistryEndpoints(): Promise<RegistryEndpoints> {
  if (!endpointsInFlight) {
    endpointsInFlight = getJson<Record<string, unknown>>(registryUrl('/.well-known/openwop-registry.json'))
      .then((doc) => {
        const eps = doc.endpoints as Record<string, unknown> | undefined;
        const pick = (m: unknown): RegistryEndpoints | null => {
          const o = m as Record<string, unknown> | null | undefined;
          return o && typeof o.registryIndex === 'string' && typeof o.packMetadata === 'string'
            ? { registryIndex: o.registryIndex, packMetadata: o.packMetadata }
            : null;
        };
        const resolved = pick(eps?.v2) ?? pick(eps);
        if (!resolved) throw new Error('Registry well-known document has no endpoints map');
        return resolved;
      })
      .catch((err: unknown) => { endpointsInFlight = null; throw err; });
  }
  return endpointsInFlight;
}

/** One version record, from either tree, as the UI reads it. */
function normalizeVersion(raw: Record<string, unknown>): PackVersionRecord {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const publishedAt = str(raw.publishedAt);
  const sbomUrl = str(raw.sbomUrl);
  return {
    version: str(raw.version) ?? '',
    ...(publishedAt ? { publishedAt } : {}),
    manifestUrl: str(raw.manifestUrl) ?? '',
    tarballUrl: str(raw.tarballUrl) ?? '',
    signatureUrl: str(raw.signatureUrl) ?? '',
    ...(sbomUrl ? { sbomUrl } : {}),
    signingMethod: str(raw.signingScheme) ?? str(raw.signingMethod) ?? '',
    signingKeyId: str(raw.signingKeyId) ?? '',
    integrity: str(raw.integrity) ?? '',
    deprecated: raw.versionDeprecated === true || raw.deprecated === true,
    yanked: raw.yanked === true,
  };
}

async function getJson<T>(url: string, validate?: (v: unknown) => void): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Registry ${res.status} for ${url}`);
  const body: unknown = await res.json();
  // The registry is a separate, UNTRUSTED origin (packs.openwop.dev). Validate
  // the response is at least the expected shape before the cast (A-2 / E4), so
  // a malformed payload throws here instead of crashing a downstream `.map()`.
  if (validate) validate(body);
  else assertRecord(body, 'registry response');
  return body as T;
}

export async function fetchRegistryIndex(): Promise<RegistryIndex> {
  const { registryIndex } = await resolveRegistryEndpoints();
  // The index's `packs` array is immediately mapped over by the UI — assert it
  // is actually an array before the cast so a malformed registry response can't
  // crash the catalog (A-2 / E4).
  return getJson<RegistryIndex>(registryUrl(registryIndex), (v) => assertArrayField(v, 'packs', 'registry index'));
}

export async function fetchPackDetail(name: string): Promise<PackDetail> {
  const { packMetadata } = await resolveRegistryEndpoints();
  const detail = await getJson<Omit<PackDetail, 'versions'> & { versions: unknown }>(
    registryUrl(packMetadata.replace('{name}', encodeURIComponent(name))),
    (v) => assertArrayField(v, 'versions', 'pack detail'),
  );
  return { ...detail, versions: (detail.versions as Record<string, unknown>[]).map(normalizeVersion) };
}
