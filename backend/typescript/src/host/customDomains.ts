/**
 * Custom domains for published content (ADR 0295 / Funnel B) — the HOST-owned
 * store + verification + resolution cache. Host-owned (not feature code) so
 * the core middleware chain may depend on it without a core→feature edge; the
 * `custom-domains` feature package supplies the toggle + authed routes over
 * this service.
 *
 * v1 scope (option A, pinned P0): DNS TXT ownership verification + the
 * fail-closed public-only host guard. TLS + routing for the domain itself are
 * the platform proxy tier's job (GCLB certificate-map — the operator recipe in
 * DEPLOY.md); a domain here turning `live` is the HOST-side half only.
 *
 * Lifecycle: pending → live (TXT proves ownership) → failed (a re-check loses
 * the record — DISABLE, never delete: the row + token survive so the operator
 * can fix DNS and re-verify). Hostname is the PK — globally unique by nature,
 * so a hostile tenant cannot claim a hostname another tenant verified.
 */
import { randomUUID } from 'node:crypto';
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import { DurableCollection } from './hostExtPersistence.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.customDomains');

export type CustomDomainStatus = 'pending' | 'live' | 'failed';

export interface CustomDomain {
  /** The PK: the lowercased hostname. */
  hostname: string;
  tenantId: string;
  orgId: string;
  status: CustomDomainStatus;
  /** The TXT value the owner publishes at `_openwop-verify.<hostname>`. */
  verificationToken: string;
  createdBy: string;
  createdAt: string;
  verifiedAt?: string;
  lastCheckedAt?: string;
  /** Why the last check failed (operator-actionable, never secret). */
  lastError?: string;
}

const domains = new DurableCollection<CustomDomain>('custom-domains:domain', (d) => d.hostname, undefined, (d) => d.tenantId);

// GC-CD-1 (grade-code) — cross-instance cache coherence: every mutation bumps a
// shared version row; readers check it on a micro-TTL (5s) and rebuild the host
// map when it moved. Worst-case staleness drops 60s → ~5s across instances at
// the cost of one cheap point-read per 5s window.
interface DomainsMeta { id: 'version'; tenantId: '__meta'; value: number }
const domainsMeta = new DurableCollection<DomainsMeta>('custom-domains:meta', (m) => m.id, undefined, (m) => m.tenantId);
async function bumpDomainsVersion(): Promise<void> {
  try {
    const cur = await domainsMeta.get('version');
    await domainsMeta.put({ id: 'version', tenantId: '__meta', value: (cur?.value ?? 0) + 1 });
  } catch { /* best-effort — the TTL fallback still bounds staleness */ }
}

const MAX_PER_ORG = 20;
// RFC-ish hostname: labels of [a-z0-9-], dots, ≤253 chars. Lowercased first.
const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export type TxtResolver = (name: string) => Promise<string[][]>;

export function normalizeHostname(raw: unknown): string {
  const hostname = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME_RE.test(hostname)) {
    throw new OpenwopError('validation_error', 'A valid hostname is required (e.g. pages.example.com).', 400, { field: 'hostname' });
  }
  return hostname;
}

/**
 * The deployment's OWN origin hostname, or '' when unconfigured.
 *
 * Used only to refuse binding it as a customer domain — see `addDomain`.
 * `OPENWOP_PUBLIC_BASE_URL` is the same source `featureRoute.ts:161` calls "the
 * trustworthy source of truth" for this deployment's public origin.
 */
function platformHostname(): string {
  const raw = (process.env['OPENWOP_PUBLIC_BASE_URL'] ?? '').trim();
  if (!raw) return '';
  try { return new URL(raw).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}

export async function listDomains(tenantId: string, orgId: string): Promise<CustomDomain[]> {
  return (await domains.listForTenantIndexed(tenantId))
    .filter((d) => d.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addDomain(input: { tenantId: string; orgId: string; createdBy: string; hostname: unknown }): Promise<CustomDomain> {
  const hostname = normalizeHostname(input.hostname);
  // REFUSE THE PLATFORM ORIGIN. A live custom hostname is pinned to its org and
  // constrained to the PUBLIC surface, fail-closed — `middleware/customDomain.ts`
  // states it plainly: "the authed app, admin routes, and the protocol surface
  // NEVER serve on a customer domain". Binding the deployment's OWN origin
  // therefore removes login, the app and the wire in a single POST, and the
  // damage is invisible from outside: the host simply stops matching "no live
  // domain passes through untouched" and starts matching the customer-domain
  // branch instead.
  //
  // Written because an operator was given exactly those steps for exactly that
  // hostname (crosstalk 58f9, 2026-09-13) and the sequence was described as
  // having "no judgement in it". Caught in review by kicktodo-1 before anyone ran
  // it. The remedy for a foot-gun that reads as a legal request is a refusal at
  // the choke point, not a warning in a runbook nobody re-reads.
  //
  // WHEN `OPENWOP_PUBLIC_BASE_URL` IS UNSET this is NOT-APPLICABLE, not
  // unverifiable: there is no configured origin, so there is none to protect.
  // That is a different state from "could not check" and is why the guard is
  // silent rather than fail-closed here — a dev box with no public origin must
  // still be able to register a domain.
  const platform = platformHostname();
  if (platform && hostname === platform) {
    throw new OpenwopError(
      'validation_error',
      `"${hostname}" is this deployment's own origin. Binding it as a custom domain would restrict it to the public surface only — sign-in, the app and the API would stop serving on it. Use a separate hostname (e.g. pages.${hostname}).`,
      400,
      { field: 'hostname' },
    );
  }
  const existing = await domains.get(hostname);
  // Hostname is globally unique: an existing claim by ANYONE blocks a re-add
  // (uniform message — never reveal who holds it).
  if (existing) throw new OpenwopError('validation_error', 'This hostname is already registered.', 400, { field: 'hostname' });
  if ((await listDomains(input.tenantId, input.orgId)).length >= MAX_PER_ORG) {
    throw new OpenwopError('validation_error', 'Custom-domain limit reached for this workspace.', 400, {});
  }
  const row: CustomDomain = {
    hostname, tenantId: input.tenantId, orgId: input.orgId,
    status: 'pending', verificationToken: `owp-verify=${randomUUID()}`,
    createdBy: input.createdBy, createdAt: new Date().toISOString(),
  };
  await domains.put(row);
  await bumpDomainsVersion();
  return row;
}

export async function getDomain(tenantId: string, orgId: string, hostname: string): Promise<CustomDomain | null> {
  const d = await domains.get(hostname.toLowerCase());
  return d && d.tenantId === tenantId && d.orgId === orgId ? d : null;
}

export async function removeDomain(tenantId: string, orgId: string, hostname: string): Promise<boolean> {
  const d = await getDomain(tenantId, orgId, hostname);
  if (!d) return false;
  await domains.delete(d.hostname);
  await bumpDomainsVersion();
  invalidateHostCache();
  return true;
}

/** Check the `_openwop-verify.<hostname>` TXT record for the token. Transitions
 *  pending/failed → live on success; live/pending → failed on a definitive miss
 *  (DNS errors record the failure but a LIVE domain is only demoted by a CLEAN
 *  answer without the token — a resolver outage must not take a site down). */
export async function verifyDomain(
  tenantId: string, orgId: string, hostname: string,
  resolveTxt: TxtResolver = dnsResolveTxt,
): Promise<CustomDomain | null> {
  const d = await getDomain(tenantId, orgId, hostname);
  if (!d) return null;
  const now = new Date().toISOString();
  let next: CustomDomain;
  try {
    const records = (await resolveTxt(`_openwop-verify.${d.hostname}`)).map((chunks) => chunks.join(''));
    if (records.includes(d.verificationToken)) {
      next = { ...d, status: 'live', verifiedAt: d.verifiedAt ?? now, lastCheckedAt: now };
      delete next.lastError;
    } else {
      next = { ...d, status: 'failed', lastCheckedAt: now, lastError: 'verification TXT record not found' };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // resolver error: pending stays pending; live SURVIVES (fail-open on
    // infra noise, fail-closed only on a clean negative answer)
    next = { ...d, lastCheckedAt: now, lastError: `dns lookup failed: ${reason.slice(0, 200)}` };
  }
  await domains.put(next);
  await bumpDomainsVersion();
  invalidateHostCache();
  return next;
}

// ── Host resolution (the middleware read path — cached, never a per-request scan) ──

interface HostCacheEntry { tenantId: string; orgId: string }
let hostCache: Map<string, HostCacheEntry> | null = null;
let hostCacheAt = 0;
let hostCacheVersion = -1;
let versionCheckedAt = 0;
const HOST_CACHE_TTL_MS = 60_000;
const VERSION_CHECK_TTL_MS = 5_000;

export function invalidateHostCache(): void { hostCache = null; hostCacheAt = 0; hostCacheVersion = -1; versionCheckedAt = 0; }

/** The org a LIVE custom hostname is bound to, or null. Cached; refreshed when
 *  the shared version row moves (checked at most every 5s) or on TTL expiry. */
export async function resolveCustomHost(hostname: string): Promise<HostCacheEntry | null> {
  const key = hostname.toLowerCase().replace(/:\d+$/, '');
  const now = Date.now();
  let stale = !hostCache || now - hostCacheAt > HOST_CACHE_TTL_MS;
  if (!stale && now - versionCheckedAt > VERSION_CHECK_TTL_MS) {
    versionCheckedAt = now;
    try {
      const v = (await domainsMeta.get('version'))?.value ?? 0;
      if (v !== hostCacheVersion) stale = true;
    } catch { /* fall back to the TTL */ }
  }
  if (stale) {
    const fresh = new Map<string, HostCacheEntry>();
    for (const d of await domains.list()) {
      if (d.status === 'live') fresh.set(d.hostname, { tenantId: d.tenantId, orgId: d.orgId });
    }
    hostCache = fresh;
    hostCacheAt = now;
    versionCheckedAt = now;
    try { hostCacheVersion = (await domainsMeta.get('version'))?.value ?? 0; } catch { hostCacheVersion = -1; }
  }
  return hostCache!.get(key) ?? null;
}

// ── Re-verification sweep (revocation on DNS change — the reservation clone) ──
const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_CUSTOM_DOMAIN_RECHECK_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 6 * 60 * 60 * 1000; // default 6h
})();

let started = false;
export function startCustomDomainSweep(resolveTxt: TxtResolver = dnsResolveTxt): { stop: () => void } | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const d of await domains.list()) {
        if (d.status !== 'live') continue;
        await verifyDomain(d.tenantId, d.orgId, d.hostname, resolveTxt);
      }
    } catch (err) {
      log.warn('custom-domain recheck failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('custom-domain recheck sweep started', { pollMs: POLL_MS });
  return { stop: () => { clearInterval(timer); started = false; } };
}

/** Test-only. */
export async function __resetCustomDomains(): Promise<void> {
  for (const d of await domains.list()) await domains.delete(d.hostname);
  for (const m of await domainsMeta.list()) await domainsMeta.delete(m.id);
  invalidateHostCache();
}
