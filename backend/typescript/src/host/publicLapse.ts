/**
 * Owner-lapse policy for PUBLIC runtimes (ADR 0820 §7, strategy §5 G9 / §6
 * "Downgrade: public pages", architect #5).
 *
 * A public lane (storefront, funnel runtime, docs site, podcast feed, partner
 * portal, custom domain, widget gateway…) derives its tenant from the RESOURCE,
 * never the request, and must never refuse a VISITOR for the visitor's own state
 * (the ADR 0176 / ADR 0419 shopper exemption). That is why those lanes read the
 * toggle through `resolveToggle` (the reviewed ADR 0819 opt-out) and not through
 * `resolveOne`. The side effect was that a lapsed OWNER's paid product kept
 * serving forever. This module is the one place that decides what happens to a
 * public runtime when the OWNER's entitlement to the feature ends.
 *
 * THE KNOB: `OPENWOP_BILLING_PUBLIC_LAPSE_GRACE_DAYS`.
 *   - unset / empty / not a non-negative number ⇒ the policy is OFF: every public
 *     runtime keeps serving whatever the owner's plan. This is the behaviour on
 *     main before this module, and it is reproduced EXACTLY (no read is made).
 *   - N ⇒ a public runtime of a SELLABLE feature keeps serving for N days after
 *     the owner's entitlement to it ended, then the lane answers with its own
 *     existing "unavailable" shape (its uniform 404 / empty projection).
 * Owner question Q5 (strategy §6) has not picked N; the knob ships unset.
 *
 * FAULTS SERVE. An entitlement read that fails for any reason other than a plan
 * refusal (403) keeps the runtime up, and is logged. A billing outage must never
 * take down every tenant's public pages (the ADR 0819 A2 lesson). The same holds
 * for a fault in this module's own grace-clock store.
 *
 * GRACE START. Preference order:
 *   1. a registered {@link EntitlementEndedAtSource} — the billing feature can
 *      report when the grant/plan that covered the feature ended (a canceled
 *      `BundleGrant.updatedAt`, a canceled subscription's `updatedAt`, or the
 *      `pastDueSince` clock workstream D adds in PR #4417). Registered by
 *      `features/billing/routes.ts` (`entitlementEndedAt` in
 *      `features/billing/billingService.ts`, which documents what "ended" means
 *      per source), beside the two entitlement checks it registers into
 *      `host/entitlementSeam.ts`. It answers `null` when it cannot say.
 *   2. otherwise, the first time this host observed the owner refused on a
 *      public lane, kept in a durable host row so it survives deploys and is
 *      shared across instances. This is ALSO the only honest clock for the
 *      lapses that leave no billing timestamp at all — an operator narrowing
 *      `OPENWOP_BILLING_PLAN_FEATURES`, or a plan downgrade. It can start later
 *      than the true end (a page nobody visits does not tick), never earlier, so
 *      its error is always in the owner's favour.
 * When the owner is entitled again, the observed row is deleted, so a later lapse
 * starts a fresh grace window.
 *
 * Cost. With the knob unset the check is a synchronous env read. With it set,
 * verdicts are cached per (feature, owner tenant) for {@link VERDICT_TTL_MS}, so
 * the custom-domain middleware (every request on a bound host) costs at most one
 * entitlement read per tenant per minute.
 *
 * NOT for compliance lanes. Email unsubscribe/preferences/bounce, WhatsApp
 * STOP/START, consent capture and consent-carrying form submissions are data-
 * subject rights and stay reachable whatever the owner's plan. The pinned list
 * lives in `test/public-lapse-lanes.test.ts`.
 */
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { resolveToggle } from './featureToggles/service.js';
import { isSellableBundleFeature } from './featureBundles.js';
import { checkTenantEntitlement } from './entitlementSeam.js';
import { DurableCollection } from './hostExtPersistence.js';

const log = createLogger('host.public-lapse');

export const PUBLIC_LAPSE_GRACE_ENV = 'OPENWOP_BILLING_PUBLIC_LAPSE_GRACE_DAYS';
const DAY_MS = 86_400_000;
/** How long one verdict is reused for a (feature, owner tenant) pair. */
export const VERDICT_TTL_MS = 60_000;
const VERDICT_CACHE_MAX = 10_000;

/** The configured grace in days, or `null` when the policy is off (unset or
 *  unparseable: an invalid value must not darken anyone's pages). */
export function publicLapseGraceDays(): number | null {
  const raw = process.env[PUBLIC_LAPSE_GRACE_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    log.warn('public_lapse_grace_invalid', { value: raw });
    return null;
  }
  return n;
}

/**
 * Seam: when did the owner's entitlement to `featureId` end? ISO timestamp, or
 * `null` when the source does not know (then the observed clock is used).
 * Registered by the billing feature (see the module header).
 */
export type EntitlementEndedAtSource = (tenantId: string, featureId: string) => Promise<string | null>;
let endedAtSource: EntitlementEndedAtSource | null = null;
/** Register the billing-side grace-start source. Last wins. */
export function registerEntitlementEndedAtSource(fn: EntitlementEndedAtSource | null): void {
  endedAtSource = fn;
  verdictCache.clear();
}

/** The host-observed lapse clock: one row per (owner tenant, feature). Holds no
 *  subject data (a tenant id, a feature id and a timestamp). */
interface ObservedLapse { id: string; tenantId: string; featureId: string; firstRefusedAt: string }
const observed = new DurableCollection<ObservedLapse>('public-lapse:observed', (r) => r.id, undefined, (r) => r.tenantId);
const observedId = (tenantId: string, featureId: string): string => `${tenantId}:${featureId}`;

export type LapseReason =
  | 'policy-off'    // knob unset: today's behaviour
  | 'not-sellable'  // the feature is in no paid bundle: there is nothing to lapse
  | 'entitled'      // the owner holds it
  | 'grace'         // the owner lost it less than N days ago
  | 'lapsed'        // the owner lost it N or more days ago
  | 'fault';        // the entitlement read (or the clock) failed: serve

export interface LapseVerdict { serve: boolean; reason: LapseReason; graceEndsAt?: string }

const verdictCache = new Map<string, { verdict: LapseVerdict; expiresAt: number }>();

async function graceStartMs(tenantId: string, featureId: string, nowMs: number): Promise<number> {
  if (endedAtSource) {
    const ended = await endedAtSource(tenantId, featureId);
    const t = ended ? Date.parse(ended) : NaN;
    if (Number.isFinite(t)) return t;
  }
  const id = observedId(tenantId, featureId);
  const existing = await observed.get(id);
  if (existing) return Date.parse(existing.firstRefusedAt);
  const row: ObservedLapse = { id, tenantId, featureId, firstRefusedAt: new Date(nowMs).toISOString() };
  // Create-if-absent: two instances racing keep the EARLIER writer's clock.
  if (await observed.putIfAbsent(row)) return nowMs;
  const winner = await observed.get(id);
  return winner ? Date.parse(winner.firstRefusedAt) : nowMs;
}

async function computeVerdict(featureId: string, ownerTenantId: string, graceDays: number, nowMs: number): Promise<LapseVerdict> {
  try {
    await checkTenantEntitlement(ownerTenantId, featureId);
  } catch (err) {
    if (!(err instanceof OpenwopError && err.httpStatus === 403)) {
      log.warn('public_lapse_entitlement_unresolved', { featureId, tenantId: ownerTenantId, error: err instanceof Error ? err.message : String(err) });
      return { serve: true, reason: 'fault' };
    }
    try {
      const graceEndsMs = (await graceStartMs(ownerTenantId, featureId, nowMs)) + graceDays * DAY_MS;
      const graceEndsAt = new Date(graceEndsMs).toISOString();
      return nowMs < graceEndsMs ? { serve: true, reason: 'grace', graceEndsAt } : { serve: false, reason: 'lapsed', graceEndsAt };
    } catch (clockErr) {
      log.warn('public_lapse_clock_unresolved', { featureId, tenantId: ownerTenantId, error: clockErr instanceof Error ? clockErr.message : String(clockErr) });
      return { serve: true, reason: 'fault' };
    }
  }
  // Entitled: reset the observed clock so a later lapse gets a full window.
  try {
    const id = observedId(ownerTenantId, featureId);
    if (await observed.get(id)) await observed.delete(id);
  } catch (err) {
    log.warn('public_lapse_clock_reset_failed', { featureId, tenantId: ownerTenantId, error: err instanceof Error ? err.message : String(err) });
  }
  return { serve: true, reason: 'entitled' };
}

/**
 * The OWNER-lapse half alone, for a lane that has already applied its own
 * toggle read. `serve:false` only when the knob is set, the feature is sellable,
 * the owner is refused by their plan, and the grace window has run out.
 */
export async function ownerLapseVerdict(featureId: string, ownerTenantId: string, nowMs: number = Date.now()): Promise<LapseVerdict> {
  const graceDays = publicLapseGraceDays();
  if (graceDays === null) return { serve: true, reason: 'policy-off' };
  if (!isSellableBundleFeature(featureId)) return { serve: true, reason: 'not-sellable' };
  const key = `${featureId}\u0000${ownerTenantId}`;
  const hit = verdictCache.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.verdict;
  const verdict = await computeVerdict(featureId, ownerTenantId, graceDays, nowMs);
  if (verdictCache.size >= VERDICT_CACHE_MAX) verdictCache.clear();
  verdictCache.set(key, { verdict, expiresAt: nowMs + VERDICT_TTL_MS });
  return verdict;
}

/** Convenience: true when the public runtime must stop serving for the owner's lapse. */
export async function ownerPublicRuntimeLapsed(featureId: string, ownerTenantId: string): Promise<boolean> {
  return !(await ownerLapseVerdict(featureId, ownerTenantId)).serve;
}

/**
 * The whole public-lane decision: the feature's toggle for the OWNER tenant
 * (the operator's kill switch, which every public lane must honour) AND the
 * owner-lapse policy. Never consults the visitor.
 */
export async function checkOwnerPublicAccess(featureId: string, ownerTenantId: string): Promise<{ serve: boolean; reason: LapseReason | 'toggle-off' }> {
  // ADR 0819 §1 opt-out — the owner-lapse helper for PUBLIC lanes: the toggle is
  // read alone because the plan half is applied below WITH the grace window and
  // the fault-serves rule, which `resolveOne` (fail-closed, no grace) cannot express.
  const toggle = await resolveToggle(featureId, { tenantId: ownerTenantId });
  if (!toggle?.enabled) return { serve: false, reason: 'toggle-off' };
  return ownerLapseVerdict(featureId, ownerTenantId);
}

/** Test-only: drop cached verdicts and the observed clock. */
export async function __resetPublicLapse(): Promise<void> {
  verdictCache.clear();
  endedAtSource = null;
  await observed.__clear();
}
