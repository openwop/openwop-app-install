/**
 * RFC 0129 (Active) — data-residency admission control (host tier-1 witness).
 *
 * The FROZEN contract (ADR 0290): a host MAY advertise the regions it can serve
 * (`capabilities.dataResidency`), and a `POST /v1/runs` request MAY pin a
 * `residency.region`. When the host advertises residency AND the request pins a
 * region, the host MUST honor-or-reject:
 *
 *   region ∈ advertised  → admit (proceed normally)
 *   region ∉ advertised  → reject `residency_unavailable` (422), create NO run
 *
 * Falsifiability scoping: only the ADMISSION-CONTROL decision is host-enforced /
 * conformance-tested here. Where the bytes physically land is an operator SHOULD
 * (data-plane / infra concern), out-of-band and NOT expressed by this module — a
 * hollow advert that accepts an unadvertised region is the exact failure the
 * conformance witness (`data-residency-admission`) hard-fails.
 *
 * HONEST-OFF: `OPENWOP_DATA_RESIDENCY_ENABLED` defaults unset ⇒ the host makes no
 * residency promise at all — the advert omits `dataResidency` entirely and the
 * admission gate ignores any `residency.region` the caller supplies. Pure +
 * dependency-free so the advertise-side and enforce-side read one source of truth.
 */

/** True iff the operator has deliberately enabled the residency capability. */
export function dataResidencyEnabled(): boolean {
  return process.env.OPENWOP_DATA_RESIDENCY_ENABLED === 'true';
}

/**
 * The regions this host advertises + admits, parsed from the comma-separated
 * `OPENWOP_DATA_RESIDENCY_REGIONS` (e.g. "eu,us"). Trimmed, empties dropped,
 * de-duplicated (order preserved).
 */
export function dataResidencyRegions(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (process.env.OPENWOP_DATA_RESIDENCY_REGIONS ?? '').split(',')) {
    const region = raw.trim();
    if (region.length === 0 || seen.has(region)) continue;
    seen.add(region);
    out.push(region);
  }
  return out;
}

/**
 * Whether this host actually advertises a residency capability. Honest-advertise
 * rule: enabled AND at least one region — a host that supports residency but pins
 * nowhere is useless and would be a dishonest empty advert, so it stays dark.
 */
export function dataResidencyAdvertised(): boolean {
  return dataResidencyEnabled() && dataResidencyRegions().length > 0;
}

/** True iff `region` is one this host advertises (the admission decision). */
export function residencyRegionAdmissible(region: string): boolean {
  return dataResidencyRegions().includes(region);
}

/**
 * Extract an OPTIONAL `residency.region` (string) from a run-create request body
 * without trusting its shape. Returns `undefined` when absent or malformed — a
 * body that carries no residency intent must be treated exactly like an
 * unadvertised host (no promise, no rejection).
 */
export function readResidencyRegion(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const residency = (body as { residency?: unknown }).residency;
  if (!residency || typeof residency !== 'object') return undefined;
  const region = (residency as { region?: unknown }).region;
  return typeof region === 'string' && region.length > 0 ? region : undefined;
}
