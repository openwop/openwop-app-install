/**
 * ADR 1035 D1 — the connector instance pin.
 *
 * Some providers' API host pins are the shared suffix of a multi-tenant SaaS
 * (`service-now.com`, `workday.com`, …): every customer of that vendor has an
 * instance under it, and a third party can run header-reading code there
 * (ServiceNow Scripted REST, Salesforce Apex REST, NetSuite RESTlets). For those
 * providers the `apiHosts` pin cannot stop a caller-chosen URL from carrying this
 * tenant's credential to ANOTHER customer's instance. So a credential for an
 * instance-scoped provider is attached only when the request origin equals the
 * origin of the connection's data source (ADR 0783), the one instance the
 * connection was bound to.
 *
 * Classification is host-curated, never pack-declared (no RFC 0095 manifest
 * field, and no trust in a pack author to opt in): an `apiHost` equal to, under
 * or above a curated suffix, plus the builtin ids a pack could override with
 * different `apiHosts`.
 */
import { getProvider } from '../features/connections/providerRegistry.js';
import { hostMatchesApi } from './connectionInjection.js';
import { validateDataSourceBaseUrl } from './dataSourceUrl.js';

/** Multi-tenant SaaS API suffixes (the threat model above is the inclusion rule). */
export const INSTANCE_SCOPED_SUFFIXES: readonly string[] = [
  'service-now.com', 'servicenowservices.com',
  'workday.com', 'myworkday.com',
  'netsuite.com',
  'zendesk.com',
  'my.salesforce.com', 'force.com',
];

/** Builtins whose manifest a connection pack may replace (`registerProvider`). */
const STICKY_INSTANCE_PROVIDER_IDS: ReadonlySet<string> = new Set(['servicenow', 'workday']);

let suffixes: readonly string[] = INSTANCE_SCOPED_SUFFIXES;

/** Test-only: classify loopback hosts too, so the pin is witnessed without real egress. */
export function __setInstanceScopedSuffixesForTests(list: readonly string[] | null): void {
  suffixes = list ? [...INSTANCE_SCOPED_SUFFIXES, ...list] : INSTANCE_SCOPED_SUFFIXES;
}

/** Does any of these API hosts sit at, under or above a curated suffix? (A pack
 *  declaring `now.service-now.com` is as instance-scoped as `service-now.com`.) */
export function apiHostsAreInstanceScoped(hosts: readonly string[]): boolean {
  return hosts.some((ah) => suffixes.some((sfx) => hostMatchesApi(ah, sfx) || hostMatchesApi(sfx, ah)));
}

export function isInstanceScopedProvider(providerId: string): boolean {
  if (STICKY_INSTANCE_PROVIDER_IDS.has(providerId)) return true;
  return apiHostsAreInstanceScoped(getProvider(providerId)?.apiHosts ?? []);
}

export type InstancePinRefusal = 'connector_instance_unbound' | 'connector_instance_mismatch';

/** The origin a connection is bound to, or null: no data source, or one the
 *  provider's CURRENT pins no longer accept (re-validated per call, as the
 *  data-integration adapter does). */
function boundOrigin(c: { provider: string; dataSource?: { baseUrl: string } }): string | null {
  if (!c.dataSource) return null;
  try {
    return new URL(validateDataSourceBaseUrl(c.dataSource.baseUrl, getProvider(c.provider)?.apiHosts)).origin;
  } catch {
    return null;
  }
}

/**
 * Pick, among the connections the caller may use (precedence order), the one
 * bound to the request's origin. The WHATWG parser lowercases, punycodes and drops
 * a default port; userinfo is never part of an origin; another port or scheme
 * mismatches. A request no candidate is bound to is refused, never sent.
 */
export function pickInstanceBound<C extends { provider: string; dataSource?: { baseUrl: string } }>(
  candidates: readonly C[],
  requestUrl: string,
): { ok: C } | { refused: InstancePinRefusal } {
  let want: string | null = null;
  try { want = new URL(requestUrl).origin; } catch { want = null; }
  const bound = candidates.map((c) => ({ c, origin: boundOrigin(c) }));
  const hit = want === null ? undefined : bound.find((b) => b.origin === want);
  if (hit) return { ok: hit.c };
  return { refused: bound.some((b) => b.origin !== null) ? 'connector_instance_mismatch' : 'connector_instance_unbound' };
}
