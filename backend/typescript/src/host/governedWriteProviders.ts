/**
 * ADR 0941 P4 / ADR 0292 — connection providers whose writes are GOVERNED.
 *
 * A provider listed here is `adapterOnly` on this host, whatever its connection
 * pack says: its credential is used only by its host adapter (which carries the
 * approval and spend gates), never injected into the generic
 * `ctx.http.safeFetch` (`host/connectionInjection.ts` `matchAllowedProvider`).
 *
 * WHY A HOST LIST AND NOT A PACK FIELD: the RFC 0095 connection-pack manifest's
 * `provider` object is closed (`schemas/connection-pack-manifest.schema.json`,
 * `additionalProperties: false`) and has no `adapterOnly`. Writing the field into
 * a pack would be a wire change. Making the flag portable is an optional RFC 0095
 * revision (recorded in ADR 0941, not authored).
 *
 * The four ad platforms are here because every ad write spends money: the ADR
 * 0357 spend gate lives in `host/adsAdapter.ts`, and a generic HTTP call
 * credentialed for the same account would step around it. Pinned against the ads
 * adapter's platform map by `adr0941-p4-consolidation-guards.test.ts`.
 */

export const GOVERNED_WRITE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'meta-ads',
  'google-ads',
  'tiktok-ads',
  'linkedin-ads',
]);

/** The generic HTTP node a governed provider must not be advertised to. */
export const GENERIC_HTTP_CONSUMER = 'core.openwop.http';

export function isGovernedWriteProvider(providerId: string): boolean {
  return GOVERNED_WRITE_PROVIDER_IDS.has(providerId);
}
