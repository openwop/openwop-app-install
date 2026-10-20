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
import { createHash } from 'node:crypto';
import { advanceEdge, hasEdgeResources, releaseEdge } from './edgeCertificates/engine.js';
import { edgeResourceIds } from './edgeCertificates/gcpCertificateManager.js';
import { getNotificationEmitter } from '../notifications/emitter.js';
import { appendAudit } from './auditChainService.js';
import { resolveEdgeProvider, type CustomDomainEdge, type EdgeCertificateProvider } from './edgeCertificates/index.js';

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
  /**
   * ADR 0906 D3 — TLS at the edge, a separate axis from ownership (`status`).
   * Absent under the `manual` provider. Only the server writes it.
   */
  edge?: CustomDomainEdge;
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
/** ADR 0906 D2 (architect C4) — unverified claims a tenant may hold at once. */
const MAX_PENDING_PER_TENANT = 5;
/** ADR 0906 D5 — an unverified claim older than this is released (squatting residue, ADR 0836). */
export const PENDING_CLAIM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** ADR 0906 D4 — failed release sweeps before an org admin may force the delete. */
export const FORCE_RELEASE_AFTER_ATTEMPTS = 3;
/** "Check again" / status refresh: at most one provider read per hostname per minute. */
const EDGE_REFRESH_MIN_MS = 60_000;
// RFC-ish hostname: labels of [a-z0-9-], dots, ≤253 chars. Lowercased first.
const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export type TxtResolver = (name: string) => Promise<string[][]>;

/**
 * The ONE canonical form of a hostname (ADR 0906 D8 / C6): lowercased, port
 * stripped, trailing dot stripped. `addDomain` stores this form and every
 * lookup uses it, so `pages.example.com.` cannot miss its own row.
 */
export function canonicalHost(raw: unknown): string {
  const host = String(raw ?? '').trim().toLowerCase();
  // An IPv6 literal (`[::1]:8080`) keeps its brackets; only a trailing `:port` goes.
  return host.replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * Suffixes owned by the platform's own providers. No customer can publish a TXT
 * record under them, so none can ever become a verified custom domain — which is
 * what lets the middleware treat them as platform traffic when a lookup fails
 * (ADR 0906 D8). `*.run.app` is load-bearing: Firebase Hosting rewrites reach
 * Cloud Run with `Host: <service>-<hash>.<region>.run.app` and the original name
 * in `X-Forwarded-Host` (measured, `host/sseChannel.ts` `frontDoorHop`).
 */
const PLATFORM_SUFFIXES = ['.run.app', '.web.app', '.firebaseapp.com'];

function originHost(raw: string): string {
  try { return canonicalHost(new URL(raw.trim()).host); } catch { return ''; }
}

/**
 * True when `host` can never be a custom domain: not hostname-shaped
 * (localhost, IP literals), under a platform-owned suffix, or one of this
 * deployment's configured origins (`OPENWOP_PUBLIC_BASE_URL`,
 * `OPENWOP_CORS_ORIGINS`). `addDomain` refuses all of these up front, so the
 * set the middleware passes through on a lookup failure and the set a tenant
 * can claim never overlap.
 */
export function isPlatformHost(raw: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = canonicalHost(raw);
  if (!HOSTNAME_RE.test(host)) return true;
  if (PLATFORM_SUFFIXES.some((s) => host.endsWith(s))) return true;
  const origins = [env['OPENWOP_PUBLIC_BASE_URL'] ?? '', ...(env['OPENWOP_CORS_ORIGINS'] ?? '').split(',')]
    .map((o) => o.trim()).filter(Boolean).map(originHost);
  return origins.includes(host);
}

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
  // ADR 0906 D8 (architect A2) — a platform-owned suffix can never be verified
  // by a customer, and the middleware treats it as platform traffic.
  if (PLATFORM_SUFFIXES.some((sfx) => hostname.endsWith(sfx))) {
    throw new OpenwopError('validation_error', `"${hostname}" is under a hosting provider's own domain and cannot be used as a custom domain.`, 400, { field: 'hostname' });
  }
  // ADR 0906 D2 (architect C4) — an anonymous trial tenant cannot claim a
  // hostname, and a tenant's unverified claims are capped.
  if (input.tenantId.startsWith('anon:')) {
    throw new OpenwopError('forbidden', 'Sign in to add a custom domain.', 403, {});
  }
  const existing = await domains.get(hostname);
  // Hostname is globally unique: an existing claim by ANYONE blocks a re-add
  // (uniform message — never reveal who holds it).
  if (existing) throw new OpenwopError('validation_error', 'This hostname is already registered.', 400, { field: 'hostname' });
  if ((await listDomains(input.tenantId, input.orgId)).length >= MAX_PER_ORG) {
    throw new OpenwopError('validation_error', 'Custom-domain limit reached for this workspace.', 400, {});
  }
  const pending = (await domains.listForTenantIndexed(input.tenantId)).filter((d) => d.status === 'pending').length;
  if (pending >= MAX_PENDING_PER_TENANT) {
    throw new OpenwopError('validation_error', `You already have ${MAX_PENDING_PER_TENANT} domains waiting for verification. Verify or remove one first.`, 400, {});
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
  const d = await domains.get(canonicalHost(hostname));
  return d && d.tenantId === tenantId && d.orgId === orgId ? d : null;
}

export type RemoveOutcome = 'deleted' | 'releasing' | 'not_found';

async function deleteRow(hostname: string): Promise<void> {
  await domains.delete(hostname);
  await bumpDomainsVersion();
  invalidateHostCache();
}

/**
 * Remove a domain (ADR 0906 D4). A row holding edge resources is marked
 * `releasing` first — it stops serving at once — and is deleted only after the
 * provider confirms every resource is gone. Otherwise the sweep retries, and
 * after {@link FORCE_RELEASE_AFTER_ATTEMPTS} failures an org admin may force it.
 */
export async function removeDomain(
  tenantId: string, orgId: string, hostname: string,
  provider: EdgeCertificateProvider | null = resolveEdgeProvider(),
): Promise<RemoveOutcome> {
  const d = await getDomain(tenantId, orgId, hostname);
  if (!d) return 'not_found';
  if (!hasEdgeResources(d.edge)) { await deleteRow(d.hostname); return 'deleted'; }
  return finishRelease(d.hostname, 'delete', provider);
}

/** Run one release attempt for `intent` and complete it when the provider is clean. */
async function finishRelease(
  hostname: string,
  intent: NonNullable<CustomDomainEdge['releaseIntent']>,
  provider: EdgeCertificateProvider | null,
): Promise<RemoveOutcome> {
  if (!provider || provider.id === 'manual') {
    // No provider can release these resources right now: mark it, keep retrying.
    const cur = await domains.get(hostname);
    if (!cur) return 'not_found';
    if (cur.edge?.tls !== 'releasing') {
      await domains.compareAndSwap(cur, { ...cur, edge: { ...cur.edge!, tls: 'releasing', releaseIntent: intent, releaseAttempts: 0, tlsSince: new Date().toISOString(), checkedAt: new Date().toISOString() } });
      await bumpDomainsVersion();
      invalidateHostCache();
    }
    return 'releasing';
  }
  const deps = edgeDeps(provider);
  const { outcome, row } = await releaseEdge<CustomDomain>(hostname, intent, deps);
  await bumpDomainsVersion();
  invalidateHostCache();
  if (outcome === 'gone') return 'not_found';
  if (outcome === 'partial' || !row) return 'releasing';
  if (row.edge?.releaseIntent === 'reissue') {
    // Clean slate, then issue again from the start (same deterministic ids).
    const fresh = await domains.get(hostname);
    if (fresh) {
      const { edge: _drop, ...rest } = fresh;
      await domains.compareAndSwap(fresh, rest as CustomDomain);
      await advanceDomainEdge(hostname, provider);
    }
    return 'releasing';
  }
  await deleteRow(hostname);
  return 'deleted';
}

/**
 * ADR 0906 D4 — an org admin removes a row whose release keeps failing. The
 * provider resources may survive; their ids go into the audit entry so an
 * operator can clean them up by hand.
 */
export async function forceRemoveDomain(tenantId: string, orgId: string, hostname: string, actor: string): Promise<boolean> {
  const d = await getDomain(tenantId, orgId, hostname);
  if (!d) return false;
  if (d.edge?.tls !== 'releasing' || (d.edge.releaseAttempts ?? 0) < FORCE_RELEASE_AFTER_ATTEMPTS) {
    throw new OpenwopError('conflict', `Force removal is only available after ${FORCE_RELEASE_AFTER_ATTEMPTS} failed release attempts.`, 409, {});
  }
  await appendAudit(tenantId, 'custom-domain.force-released', {
    hostname: d.hostname, orgId, actor, provider: d.edge.provider,
    attempts: d.edge.releaseAttempts ?? 0, resources: edgeResourceIds(d.hostname),
  });
  await deleteRow(d.hostname);
  return true;
}

/**
 * "Check again" (ADR 0906 P3). A failed certificate is released and issued
 * afresh; anything else is advanced. At most one provider read per minute.
 */
export async function retryDomainEdge(
  tenantId: string, orgId: string, hostname: string,
  provider: EdgeCertificateProvider | null = resolveEdgeProvider(),
  nowMs: number = Date.now(),
): Promise<CustomDomain | null> {
  const d = await getDomain(tenantId, orgId, hostname);
  if (!d) return null;
  if (d.edge?.tls === 'releasing') {
    throw new OpenwopError('conflict', 'This domain is being removed or re-issued; try again shortly.', 409, {});
  }
  const last = Date.parse(d.edge?.checkedAt ?? '');
  if (Number.isFinite(last) && nowMs - last < EDGE_REFRESH_MIN_MS) {
    throw new OpenwopError('rate_limited', 'Checked less than a minute ago. Try again shortly.', 429, {});
  }
  if (d.edge?.tls === 'failed' && provider) {
    await finishRelease(d.hostname, 'reissue', provider);
    return domains.get(d.hostname);
  }
  return advanceDomainEdge(d.hostname, provider);
}

/** The row, refreshed from the provider when it was last read over a minute ago. */
export async function domainStatus(
  tenantId: string, orgId: string, hostname: string,
  provider: EdgeCertificateProvider | null = resolveEdgeProvider(),
  nowMs: number = Date.now(),
): Promise<CustomDomain | null> {
  const d = await getDomain(tenantId, orgId, hostname);
  if (!d) return null;
  const last = Date.parse(d.edge?.checkedAt ?? '');
  const busy = d.edge && (d.edge.tls === 'awaiting_dns' || d.edge.tls === 'provisioning');
  if (busy && !(Number.isFinite(last) && nowMs - last < EDGE_REFRESH_MIN_MS)) return advanceDomainEdge(d.hostname, provider);
  return d;
}

/** Check the `_openwop-verify.<hostname>` TXT record for the token. Transitions
 *  pending/failed → live on success; live/pending → failed on a definitive miss
 *  (DNS errors record the failure but a LIVE domain is only demoted by a CLEAN
 *  answer without the token — a resolver outage must not take a site down). */
export async function verifyDomain(
  tenantId: string, orgId: string, hostname: string,
  resolveTxt: TxtResolver = dnsResolveTxt,
  edgeProvider: EdgeCertificateProvider | null = resolveEdgeProvider(),
): Promise<CustomDomain | null> {
  const first = await getDomain(tenantId, orgId, hostname);
  if (!first) return null;
  const now = new Date().toISOString();
  type Verdict = { kind: 'match' } | { kind: 'miss' } | { kind: 'error'; reason: string };
  let verdict: Verdict;
  try {
    const records = (await resolveTxt(`_openwop-verify.${first.hostname}`)).map((chunks) => chunks.join(''));
    verdict = records.includes(first.verificationToken) ? { kind: 'match' } : { kind: 'miss' };
  } catch (err) {
    verdict = { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  const apply = (d: CustomDomain): CustomDomain => {
    if (verdict.kind === 'match') {
      const next: CustomDomain = { ...d, status: 'live', verifiedAt: d.verifiedAt ?? now, lastCheckedAt: now };
      delete next.lastError;
      return next;
    }
    if (verdict.kind === 'miss') return { ...d, status: 'failed', lastCheckedAt: now, lastError: 'verification TXT record not found' };
    // resolver error: pending stays pending; live SURVIVES (fail-open on
    // infra noise, fail-closed only on a clean negative answer)
    return { ...d, lastCheckedAt: now, lastError: `dns lookup failed: ${verdict.reason.slice(0, 200)}` };
  };
  // CAS, not put: the edge poll writes the same row (ADR 0906 P3), and a
  // stale whole-row put would roll its edge state back.
  let d: CustomDomain | null = first;
  let next = apply(first);
  for (let i = 0; i < 3 && d; i++) {
    if (await domains.compareAndSwap(d, next)) break;
    d = await domains.get(first.hostname);
    if (d) next = apply(d);
  }
  if (!d) return null;
  await bumpDomainsVersion();
  invalidateHostCache();
  // ADR 0906 D2 — the DNS authorization (and certificate) are created only
  // once the TXT has proven ownership. A no-op under `manual`.
  if (next.status === 'live') {
    return (await advanceDomainEdge(next.hostname, edgeProvider)) ?? next;
  }
  return next;
}

// ── Edge certificates (ADR 0906 P2) ──────────────────────────────────────────

/**
 * Move one domain's edge certificate forward as far as it can go now. A no-op
 * under `manual`, when the provider is configured but not ready, and for any
 * row that is not `live`. Never throws: provider faults land on `edge.issue`.
 */
export async function advanceDomainEdge(
  hostname: string,
  provider: EdgeCertificateProvider | null = resolveEdgeProvider(),
): Promise<CustomDomain | null> {
  const key = canonicalHost(hostname);
  if (!provider) return domains.get(key);
  try {
    const before = await domains.get(key);
    const after = await advanceEdge<CustomDomain>(key, edgeDeps(provider));
    if (after) await notifyTlsTransition(before, after);
    return after;
  } catch (err) {
    log.warn('edge advance failed', { hostname: key, error: err instanceof Error ? err.message : String(err) });
    return domains.get(key);
  }
}

function edgeDeps(provider: EdgeCertificateProvider) {
  return {
    provider,
    get: (h: string) => domains.get(h),
    compareAndSwap: (expected: CustomDomain, next: CustomDomain) => domains.compareAndSwap(expected, next),
  };
}

/**
 * ADR 0906 D5 — tell the domain's creator when HTTPS goes live or fails. The
 * notification id is derived from (host, state, since), so two instances that
 * finish the same step produce one notification. Best-effort.
 */
async function notifyTlsTransition(before: CustomDomain | null, after: CustomDomain): Promise<void> {
  const tls = after.edge?.tls;
  if (!tls || before?.edge?.tls === tls || (tls !== 'active' && tls !== 'failed')) return;
  const tag = createHash('sha256').update(after.hostname).digest('hex').slice(0, 8);
  try {
    await getNotificationEmitter().emit({
      notificationId: `cd-tls:${tag}:${tls}:${after.edge?.tlsSince ?? ''}`,
      tenantId: after.tenantId,
      recipientUserId: after.createdBy,
      type: 'system.alert',
      priority: tls === 'failed' ? 'high' : 'normal',
      title: tls === 'active' ? `HTTPS is ready for ${after.hostname}` : `HTTPS setup failed for ${after.hostname}`,
      message: tls === 'active'
        ? `The certificate for ${after.hostname} is active. Point its routing record at the platform edge to start serving.`
        : `${after.edge?.issue?.detail ?? 'The certificate could not be issued.'} Open Domains to fix it and check again.`,
      actionUrl: '/domains',
      metadata: { kind: 'custom-domain.tls', hostname: after.hostname, tls },
    });
  } catch (err) {
    log.debug('custom_domain_tls_notify_failed', { hostname: after.hostname, error: err instanceof Error ? err.message : String(err) });
  }
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
  const key = canonicalHost(hostname);
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
      // ADR 0906 D4 — a removed or expired row stops serving the moment it is
      // marked, not when its certificate cleanup finishes.
      const leaving = d.edge?.tls === 'releasing' && d.edge.releaseIntent !== 'reissue';
      if (d.status === 'live' && !leaving) fresh.set(d.hostname, { tenantId: d.tenantId, orgId: d.orgId });
    }
    hostCache = fresh;
    hostCacheAt = now;
    versionCheckedAt = now;
    try { hostCacheVersion = (await domainsMeta.get('version'))?.value ?? 0; } catch { hostCacheVersion = -1; }
  }
  return hostCache!.get(key) ?? null;
}

/**
 * Every domain row, for the background sweep only (`host/customDomainSweep.ts`).
 * A full cross-tenant scan — never call it on a request path.
 */
export async function listAllDomainsForSweep(): Promise<CustomDomain[]> {
  return domains.list();
}

/** Is this row due for the edge lifecycle pass (ADR 0906 D5)? Pure; the sweep leases it. */
export function edgeWorkDue(d: CustomDomain, nowMs: number): boolean {
  const tls = d.edge?.tls;
  const expired = d.status === 'pending' && nowMs - Date.parse(d.createdAt) > PENDING_CLAIM_TTL_MS;
  return expired || tls === 'awaiting_dns' || tls === 'provisioning' || tls === 'releasing';
}

/**
 * One row's edge lifecycle step (ADR 0906 D5). The caller (`host/customDomainSweep.ts`)
 * holds the per-(hostname, slot) lease:
 *   - a `pending` claim older than {@link PENDING_CLAIM_TTL_MS} is released;
 *   - `awaiting_dns` / `provisioning` rows are advanced (and notified);
 *   - `releasing` rows get another release attempt, completing their intent.
 */
export async function processEdgeRow(
  d: CustomDomain,
  provider: EdgeCertificateProvider | null,
  nowMs: number,
): Promise<'expired' | 'released' | 'advanced' | null> {
  const tls = d.edge?.tls;
  const expired = d.status === 'pending' && nowMs - Date.parse(d.createdAt) > PENDING_CLAIM_TTL_MS;
  if (expired && tls !== 'releasing') {
    const out = hasEdgeResources(d.edge) ? await finishRelease(d.hostname, 'expire', provider) : (await deleteRow(d.hostname), 'deleted');
    return out === 'deleted' ? 'expired' : null;
  }
  if (tls === 'releasing') {
    const out = await finishRelease(d.hostname, d.edge?.releaseIntent ?? 'delete', provider);
    return out === 'deleted' || d.edge?.releaseIntent === 'reissue' ? 'released' : null;
  }
  await advanceDomainEdge(d.hostname, provider);
  return 'advanced';
}

/** Test-only. */
export async function __resetCustomDomains(): Promise<void> {
  for (const d of await domains.list()) await domains.delete(d.hostname);
  for (const m of await domainsMeta.list()) await domainsMeta.delete(m.id);
  invalidateHostCache();
}
