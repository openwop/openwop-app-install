/**
 * Subscriptions & Billing (ADR 0176) — the subscription/plan store, the prepaid
 * AI-token balance ledger, the config-driven Stripe price catalog, the Stripe
 * webhook processor (idempotent per event id), the central entitlement resolver,
 * and the R-1 cutover importer.
 *
 * R-1 (the MyndHyve cutover): every existing Stripe integration works day-1 against
 * the EXISTING account — so (a) price IDs are OPERATOR CONFIG, never baked; (b) the
 * stores carry the Stripe ids verbatim; (c) the importer preserves them so live
 * customers/subscriptions/balances keep working with nothing re-created in Stripe.
 *
 * Pure host-extension — no wire change, no RFC. Stripe credentials stay host-side
 * (BYOK). Demo-mode default: with no webhook signing secret configured the webhook
 * route reports `not_configured` and the reference host is byte-identical when off.
 *
 * @see docs/adr/0176-subscriptions-billing.md
 */

import { isListedSuperadminTenant } from '../../host/superadmin.js';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { OpenwopError } from '../../types.js';
import { fireSubscriptionInvoicePaid } from './subscriptionInvoiceHook.js';
import {
  createStripeCheckoutSession, getStripeCheckoutSession, getStripeSubscription,
  createStripeTenantCustomer, isPermanentStripeReadError, isMissingStripeCustomerError,
} from './stripeApi.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { recordLedgerCount } from '../../host/paywallFunnel.js';
import { knownBundleIds, bundleFeatureIds, readBundleCatalog, isSellableBundleFeature } from '../../host/featureBundles.js';
import { displayablePlanLimits } from '../../host/planLimitsSeam.js';
import { listToggleDefaults, getToggleDefault } from '../../host/featureToggles/registry.js';
import { createLogger } from '../../observability/logger.js';
import { tokensToCredits } from '../../host/managedCredits.js';
import { publicLapseGraceDays } from '../../host/publicLapse.js';

const log = createLogger('billing');

/** Bounded CAS retry count for the token-balance ledger (matches host/imageGenBudget).
 *  Per-tenant balance is low-concurrency, so 12 comfortably covers real contention. */
const BALANCE_CAS_ATTEMPTS = 12;

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';
/** Stripe's full subscription status set (ADR 0786 D2 — the old four-value type was
 *  filled by an unchecked cast, so `unpaid`/`incomplete_expired`/`paused` were
 *  stored while the type said they could not be) + our own `none`. */
export type SubscriptionStatus =
  | 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused' | 'none';

/** ADR 0786 D2 — the ONE entitled-status predicate, shared by the plan
 *  (`resolveEntitlements`) and every bundle grant. Stripe: `incomplete` is not yet
 *  paid, `unpaid`/`canceled` must revoke access.
 *
 *  ADR 0820 §7 (BILLWF-13) — `past_due` is entitled ONLY inside the operator's
 *  grace window (`OPENWOP_BILLING_PAST_DUE_GRACE_DAYS`, default 0 = never), counted
 *  from `pastDueSince`, the transition time the webhook recorded on the row. No
 *  recorded transition ⇒ not entitled (fail-closed: a row that went past_due before
 *  the field existed gets no grace until its next event). Callers that decide
 *  SUPERSESSION (which subscription owns a row) pass no `pastDueSince`, so for them
 *  `past_due` stays non-entitled exactly as before. `nowMs` is the test clock. */
export function isEntitledStatus(status: string | undefined, opts: { pastDueSince?: string; nowMs?: number } = {}): boolean {
  if (status === 'active' || status === 'trialing') return true;
  if (status !== 'past_due' || !opts.pastDueSince) return false;
  const graceEnd = pastDueGraceEndsAtMs(opts.pastDueSince);
  return graceEnd !== undefined && (opts.nowMs ?? Date.now()) < graceEnd;
}
/** The operator's past-due grace in whole days (0 = off, today's behaviour). A
 *  malformed value is 0, never a widening. */
export function pastDueGraceDays(): number {
  const n = Number(process.env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS ?? '0');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
/** When a past_due row's grace ends (epoch ms), or undefined when grace is off or
 *  the transition time is unreadable. */
export function pastDueGraceEndsAtMs(pastDueSince: string | undefined): number | undefined {
  const days = pastDueGraceDays();
  const since = pastDueSince ? Date.parse(pastDueSince) : NaN;
  if (days <= 0 || !Number.isFinite(since)) return undefined;
  return since + days * 86_400_000;
}
/** The `pastDueSince` a row should carry after a write that sets `status`: kept
 *  from the previous row when the SAME subscription was already past_due (a repeat
 *  event never restarts the clock), stamped now on the transition, absent otherwise. */
function nextPastDueSince(status: string, prev: { status?: string; subId?: string; pastDueSince?: string }, subId: string): string | undefined {
  if (status !== 'past_due') return undefined;
  if (prev.status === 'past_due' && prev.subId === subId && prev.pastDueSince) return prev.pastDueSince;
  return nowIso();
}
/** A subscription status after which Stripe never bills it again. Stripe:
 *  `canceled` "is a terminal state that can't be updated"; `incomplete_expired`
 *  subscriptions "don't bill customers". */
function isTerminalStatus(status: string | undefined): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}
/** Still OPEN for the "don't sell a second plan" rule (D7): anything Stripe can
 *  still bill or recover — `unpaid` and `paused` recover to `active` when paid or
 *  resumed, `incomplete` when its first payment completes (grade-code BILLCD-2:
 *  counting only active/trialing/past_due let a second plan be sold beside a
 *  recoverable one, then both billed). Only a terminal status, or no subscription
 *  at all, is closed. */
function isOpenStatus(status: string | undefined): boolean {
  return status !== undefined && status !== 'none' && !isTerminalStatus(status);
}
/** Bounded memory of subscriptions that ended (D4) — enough for any realistic
 *  re-subscribe history; the oldest drop off. */
const ENDED_SUBS_MAX = 20;
function withEnded(list: string[] | undefined, subId: string): string[] {
  const out = (list ?? []).filter((id) => id !== subId);
  out.push(subId);
  return out.slice(-ENDED_SUBS_MAX);
}

/** One subscription per tenant (the billing subject, ADR 0015). Carries every Stripe
 *  id VERBATIM (R-1) so the portal + live subscription keep working post-cutover. */
export interface Subscription {
  tenantId: string;
  planTier: PlanTier;
  status: SubscriptionStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePriceId?: string;
  currentPeriodStart?: string; // R-1.3 — carried for "same renewal window" continuity
  currentPeriodEnd?: string;
  trialEnd?: string; // R-1.3 — carried so an active trial keeps its end date on cutover
  quantity?: number; // seats
  /** Stripe `cancel_at_period_end`: still `active`, but will not renew (grade-ux
   *  BILLUX-5 — without it the page promised a renewal that will not happen). */
  cancelAtPeriodEnd?: boolean;
  latestInvoiceId?: string;
  defaultPaymentMethodId?: string;
  /** ADR 0786 D4 — local time of the Stripe FETCH this row's subscription state
   *  came from. Only fetched subscription-state writes set or compare it. */
  syncedAtMs?: number;
  /** ADR 0786 D4 — subscriptions that reached a terminal status; an event for
   *  one of these never changes the row again. */
  endedSubscriptionIds?: string[];
  /** ADR 0820 §7 — when the plan subscription entered `past_due` (local time of the
   *  webhook that first saw it). Present only while `status === 'past_due'`. */
  pastDueSince?: string;
  updatedAt: string;
}
/** Prepaid AI-token balance ledger (NET-NEW — openwop had no balance, only a daily cap). */
export interface TokenBalance {
  tenantId: string;
  purchasedTokensTotal: number;
  totalAvailable: number;
  /** ADR 0786 D1 — the Checkout Sessions already credited (last
   *  {@link CREDITED_SESSIONS_MAX}). It rides the SAME compare-and-swap as the
   *  tokens, so there is no second write whose absence could double or strand a
   *  credit. */
  creditedSessions?: string[];
  updatedAt: string;
}
const CREDITED_SESSIONS_MAX = 100;

const subscriptions = new DurableCollection<Subscription>('billing:subscription', (s) => s.tenantId, undefined, (s) => s.tenantId);
const balances = new DurableCollection<TokenBalance>('billing:token-balance', (b) => b.tenantId, undefined, (b) => b.tenantId);

/** ADR 0419 — a tenant's purchased feature-bundle grants. ONE row per tenant
 *  (a map of bundleId → grant) so the entitlement read is a single point-get on
 *  the `requireEntitledFeature` path. A bundle add-on is its own Stripe
 *  subscription, tracked by `stripeSubscriptionId`. */
export interface BundleGrant {
  status: 'active' | 'canceled';
  stripeSubscriptionId?: string;
  /** ADR 0786 D2 — the raw Stripe status. `status` is DERIVED (entitled or not);
   *  terminal checks key on this, never on `status` (a `past_due` grant is not
   *  active and must still recover). Absent on a one-time grant. */
  stripeStatus?: string;
  syncedAtMs?: number;
  endedSubscriptionIds?: string[];
  /** ADR 0820 §7 — when this grant's subscription entered `past_due`. Present only
   *  while `stripeStatus === 'past_due'`. */
  pastDueSince?: string;
  updatedAt: string;
}
/** Whether a grant entitles NOW: `status` is the entitlement DERIVED at write time
 *  (grace-free), and a `past_due` grant additionally entitles inside the grace
 *  window — a time-dependent fact, so it is decided at read time, through the ONE
 *  predicate. */
function isGrantEntitled(g: BundleGrant | undefined, nowMs?: number): boolean {
  if (!g) return false;
  if (g.status === 'active') return true;
  return g.stripeStatus === 'past_due' && isEntitledStatus('past_due', { ...(g.pastDueSince ? { pastDueSince: g.pastDueSince } : {}), ...(nowMs !== undefined ? { nowMs } : {}) });
}
export interface BundleEntitlements { tenantId: string; bundles: Record<string, BundleGrant>; updatedAt: string }
const bundleEntitlements = new DurableCollection<BundleEntitlements>('billing:bundle-entitlement', (e) => e.tenantId, undefined, (e) => e.tenantId);
// Idempotency: a processed Stripe event id is recorded so a webhook RETRY (or the
// add-then-retire dual-endpoint cutover, R-1.4) never double-applies.
//
// DELIBERATELY NOT retention-purged. This is a money-critical dedup ledger: purging an
// entry lets a re-delivered Stripe event (webhook retries, a replayed endpoint, a manual
// resend) RE-PROCESS — double-applying a subscription change or a token top-up. Stripe's
// own retry horizon is bounded (~72h) but manual/replayed deliveries are not, so the only
// safe guarantee is to keep the marker forever. It is also global (keyed by eventId, no
// `tenantId`), so a per-tenant retention window doesn't even fit it. The row is tiny
// (id + timestamp); unbounded growth here is an accepted trade for the dedup guarantee.
// ADR 0786 D0 — a claim is a LEASE, not a tombstone. `state` absent = a legacy row
// written before D0, which only ever meant "processed" → `done`.
interface WebhookEvent { eventId: string; processedAt: string; state?: 'claimed' | 'done'; claimedAt?: number }
/** How long a claim protects an in-flight delivery before another may take it
 *  over. Two 15 s Stripe reads plus CAS retries fit well inside it. */
const EVENT_CLAIM_LEASE_MS = 120_000;
const seenEvents = new DurableCollection<WebhookEvent>('billing:webhook-event', (e) => e.eventId);
// ADR 0380 correction: the webhook-event ledger is deliberately EXCLUDED from the
// kvAgeOut size-hygiene registrations below — the dedup-guarantee analysis above
// (unbounded manual/replay horizon) overrides the size argument.

const nowIso = (): string => new Date().toISOString();
const STRIPE_REPLAY_WINDOW_MS = 5 * 60_000;

// ── config-driven price catalog (R-1.2 — NO baked price IDs) ──────────────────
/** `plan-tier → stripePriceId` and `stripePriceId → plan-tier`, from operator config
 *  (env JSON). Point the host at MyndHyve's Stripe = supply the EXISTING price IDs. */
function planPriceMap(): Record<string, PlanTier> {
  // OPENWOP_BILLING_PLAN_PRICES = {"price_abc":"pro","price_def":"team",...}
  try {
    const raw = process.env.OPENWOP_BILLING_PLAN_PRICES;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<string, PlanTier> = {};
    for (const [priceId, tier] of Object.entries(parsed)) {
      if (tier === 'pro' || tier === 'team' || tier === 'enterprise' || tier === 'free') out[priceId] = tier;
    }
    return out;
  } catch { return {}; }
}
function tokenPackMap(): Record<string, number> {
  // OPENWOP_BILLING_TOKEN_PACK_PRICES = {"price_pack1":100000,"price_pack2":500000}
  try {
    const raw = process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    const out: Record<string, number> = {};
    for (const [priceId, tokens] of Object.entries(parsed)) if (typeof tokens === 'number' && tokens > 0) out[priceId] = tokens;
    return out;
  } catch { return {}; }
}
export function planTierForPrice(priceId: string): PlanTier | undefined { return planPriceMap()[priceId]; }
export function tokensForPackPrice(priceId: string): number | undefined { return tokenPackMap()[priceId]; }

// ── ADR 0821 D1/D7: AI-credit packs on the store ──────────────────────────────
/** Marketing-only display copy per PACK PRICE (never sent to a client keyed by
 *  that price). Honest-when-unconfigured: a pack with no `price` still lists its
 *  credits, and the store offers no buy button for it (MKT-UX-6 — a money action
 *  is never offered without its amount beside it).
 *  OPENWOP_BILLING_TOKEN_PACK_DISPLAY = {"price_pack1":{"price":"$5","label":"Starter"}} */
export interface TokenPackDisplay { price?: string; label?: string }
// Parsed ONCE per raw env string (pack prices + display), like `bundleDisplayConfig`.
let tokenPackDisplayCache: { raw: string | undefined; packsRaw: string | undefined; value: Record<string, TokenPackDisplay> } | null = null;
function tokenPackDisplayConfig(): Record<string, TokenPackDisplay> {
  const raw = process.env.OPENWOP_BILLING_TOKEN_PACK_DISPLAY;
  const packsRaw = process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES;
  if (tokenPackDisplayCache && tokenPackDisplayCache.raw === raw && tokenPackDisplayCache.packsRaw === packsRaw) return tokenPackDisplayCache.value;
  const value = parseTokenPackDisplay(raw, tokenPackMap());
  tokenPackDisplayCache = { raw, packsRaw, value };
  return value;
}
function parseTokenPackDisplay(raw: string | undefined, packs: Record<string, number>): Record<string, TokenPackDisplay> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, TokenPackDisplay> = {};
    for (const [priceId, d] of Object.entries(parsed)) {
      // Display copy for a price that is not a configured pack sells nothing — warn
      // (the operator typo trap, DATA-419-3) and drop it.
      if (!(priceId in packs)) { log.warn('billing token-pack display config references a price that is not a configured pack — ignored', { priceId }); continue; }
      if (!d || typeof d !== 'object') continue;
      const rec = d as Record<string, unknown>;
      const disp: TokenPackDisplay = {};
      if (typeof rec.price === 'string' && rec.price.trim()) disp.price = rec.price.trim().slice(0, 40);
      if (typeof rec.label === 'string' && rec.label.trim()) disp.label = rec.label.trim().slice(0, 40);
      if (Object.keys(disp).length > 0) out[priceId] = disp;
    }
    return out;
  } catch {
    log.warn('billing token-pack display config is not valid JSON — packs list without prices');
    return {};
  }
}
/** The OPAQUE, stable key a client names a pack by — a hash of the price id, so
 *  the store never sees a Stripe id and the key survives adding/removing other
 *  packs (a sorted index would shift). The client never names a price: checkout
 *  resolves the key back through `priceForTokenPack`. */
export function tokenPackKey(priceId: string): string {
  return `pack_${createHash('sha256').update(priceId).digest('hex').slice(0, 16)}`;
}
/** One credit pack as the store shows it. NO Stripe id. */
export interface TokenPackOffer { packKey: string; credits: number; tokens: number; priceDisplay?: TokenPackDisplay }
/** Every configured pack, smallest first; `[]` when none is configured. */
export function listTokenPacks(): TokenPackOffer[] {
  const display = tokenPackDisplayConfig();
  return Object.entries(tokenPackMap())
    .map(([priceId, tokens]) => {
      const disp = display[priceId];
      return { packKey: tokenPackKey(priceId), credits: tokensToCredits(tokens), tokens, ...(disp ? { priceDisplay: disp } : {}) };
    })
    .sort((a, b) => a.tokens - b.tokens || a.packKey.localeCompare(b.packKey));
}
/** The configured pack price behind an opaque key, if any (the checkout route). */
export function priceForTokenPack(packKey: string): string | undefined {
  for (const priceId of Object.keys(tokenPackMap())) if (tokenPackKey(priceId) === packKey) return priceId;
  return undefined;
}

// ── ADR 0419: paid feature bundles (priceId ⇄ bundleId, operator config) ──────
/** `stripePriceId → bundleId`. Only entries whose bundleId is a REAL bundle
 *  (`knownBundleIds()`) are honored — a typo'd/phantom bundle can never be
 *  entitled. Money lives ONLY here (operator config), never in bundles.json.
 *  OPENWOP_BILLING_BUNDLE_PRICES = {"price_crm":"crm","price_marketing":"marketing"} */
// Memoized on the raw env string (operator config never changes at runtime; only
// tests mutate it → the raw-string key re-parses). Mirrors `planDisplayConfig` —
// the public bundle-pricing read must not JSON.parse per bundle per request (CODE-BS-1).
let bundlePriceCache: { raw: string | undefined; value: Record<string, string> } | null = null;
function bundlePriceMap(): Record<string, string> {
  const raw = process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  if (bundlePriceCache && bundlePriceCache.raw === raw) return bundlePriceCache.value;
  const value = parseBundlePriceMap(raw);
  bundlePriceCache = { raw, value };
  return value;
}
function parseBundlePriceMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const known = new Set(knownBundleIds());
    const out: Record<string, string> = {};
    for (const [priceId, bundleId] of Object.entries(parsed)) {
      if (typeof bundleId === 'string' && known.has(bundleId)) out[priceId] = bundleId;
      // DATA-419-3: a configured price pointing at an unknown bundle is silently
      // dropped (fail-safe) — but warn so an operator typo isn't a silent no-sale.
      else if (typeof bundleId === 'string') log.warn('billing bundle-price config references an unknown bundle — ignored', { priceId, bundleId });
    }
    return out;
  } catch { return {}; }
}
/** The bundle a Stripe price sells, if any (webhook + checkout use this). */
export function bundleForPrice(priceId: string): string | undefined { return bundlePriceMap()[priceId]; }

// ── ADR 0820 §7: billing cadence (annual prices) ──────────────────────────────
/** A recurring price's billing interval. Every price is `month` unless the
 *  operator's cadence map says `year`. */
export type BillingCadence = 'month' | 'year';
export const BILLING_CADENCES: readonly BillingCadence[] = ['month', 'year'];
export function isBillingCadence(v: unknown): v is BillingCadence { return v === 'month' || v === 'year'; }
/** `stripePriceId → cadence` for one env key, memoized on the raw string (operator
 *  config never changes at runtime). A non-cadence value is dropped with a warn.
 *  OPENWOP_BILLING_BUNDLE_PRICE_CADENCE / OPENWOP_BILLING_PLAN_PRICE_CADENCE =
 *  {"price_crm_year":"year"} */
const cadenceCaches = new Map<string, { raw: string | undefined; value: Record<string, BillingCadence> }>();
function cadenceMap(envKey: string): Record<string, BillingCadence> {
  const raw = process.env[envKey];
  const hit = cadenceCaches.get(envKey);
  if (hit && hit.raw === raw) return hit.value;
  const value: Record<string, BillingCadence> = {};
  if (raw) {
    try {
      for (const [priceId, c] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (isBillingCadence(c)) value[priceId] = c;
        else log.warn('billing cadence config has a value that is not "month" or "year" — ignored', { envKey, priceId });
      }
    } catch { log.warn('billing cadence config is not valid JSON — every price is monthly', { envKey }); }
  }
  cadenceCaches.set(envKey, { raw, value });
  return value;
}
const bundleCadenceOf = (priceId: string): BillingCadence => cadenceMap('OPENWOP_BILLING_BUNDLE_PRICE_CADENCE')[priceId] ?? 'month';
const planCadenceOf = (priceId: string): BillingCadence => cadenceMap('OPENWOP_BILLING_PLAN_PRICE_CADENCE')[priceId] ?? 'month';

/** The configured Stripe price for a bundle at a cadence (default `month`), if it is
 *  for sale at that cadence (checkout route). The CLIENT never names a price: it
 *  names a bundle and a cadence, and this resolves the operator's price. Two prices
 *  of one cadence ⇒ the first (the pre-0820 behaviour). Fulfilment is unaffected:
 *  `bundleForPrice` maps every listed price, of either cadence, to its bundle. */
export function priceForBundle(bundleId: string, cadence: BillingCadence = 'month'): string | undefined {
  for (const [priceId, id] of Object.entries(bundlePriceMap())) if (id === bundleId && bundleCadenceOf(priceId) === cadence) return priceId;
  return undefined;
}
/** The cadences a bundle is for sale at, in display order (empty = not for sale). */
export function bundleCadences(bundleId: string): BillingCadence[] {
  return BILLING_CADENCES.filter((c) => priceForBundle(bundleId, c) !== undefined);
}
/** The configured Stripe price for a plan tier at a cadence — the plan-checkout
 *  twin of `priceForBundle`, so a client can buy a plan by tier + cadence. */
export function priceForPlan(tier: PlanTier, cadence: BillingCadence = 'month'): string | undefined {
  for (const [priceId, t] of Object.entries(planPriceMap())) if (t === tier && planCadenceOf(priceId) === cadence) return priceId;
  return undefined;
}

// ── ADR 0820 §5: standalone bundles (sold only on their own) ──────────────────
/** Bundles that NO plan may grant — sold only as their own purchase (the owner's
 *  2026-10-05 decision for `job-search`). An unknown id is dropped with a warn.
 *  OPENWOP_BILLING_STANDALONE_BUNDLES = ["job-search"] */
let standaloneCache: { raw: string | undefined; value: Set<string> } | null = null;
export function standaloneBundleIds(): Set<string> {
  const raw = process.env.OPENWOP_BILLING_STANDALONE_BUNDLES;
  if (standaloneCache && standaloneCache.raw === raw) return standaloneCache.value;
  const value = new Set<string>();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error('not an array');
      const known = new Set(knownBundleIds());
      for (const id of parsed) {
        if (typeof id === 'string' && known.has(id)) value.add(id);
        else log.warn('billing standalone-bundle config names an unknown bundle — ignored', { bundleId: String(id) });
      }
    } catch { log.warn('OPENWOP_BILLING_STANDALONE_BUNDLES is not a JSON array of bundle ids — ignored'); }
  }
  standaloneCache = { raw, value };
  return value;
}
/** Every feature of every standalone bundle. */
function standaloneFeatureIds(): Set<string> {
  const out = new Set<string>();
  for (const b of standaloneBundleIds()) for (const f of bundleFeatureIds(b)) out.add(f);
  return out;
}

// ── ADR 0820 §7: trials ───────────────────────────────────────────────────────
/** Checkout trial days for a plan tier or a bundle, keyed `plan:<tier>` /
 *  `bundle:<id>`. Stripe accepts 1–730; anything else is dropped with a warn.
 *  OPENWOP_BILLING_TRIAL_DAYS = {"plan:pro":14,"bundle:crm":7} */
let trialCache: { raw: string | undefined; value: Record<string, number> } | null = null;
function trialDaysMap(): Record<string, number> {
  const raw = process.env.OPENWOP_BILLING_TRIAL_DAYS;
  if (trialCache && trialCache.raw === raw) return trialCache.value;
  const value: Record<string, number> = {};
  if (raw) {
    try {
      for (const [key, days] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 730) value[key] = days;
        else log.warn('billing trial config needs a whole number of days between 1 and 730 — ignored', { key });
      }
    } catch { log.warn('OPENWOP_BILLING_TRIAL_DAYS is not valid JSON — no trials'); }
  }
  trialCache = { raw, value };
  return value;
}
export function trialDaysFor(target: { plan: PlanTier } | { bundleId: string }): number | undefined {
  return trialDaysMap()['plan' in target ? `plan:${target.plan}` : `bundle:${target.bundleId}`];
}

/** A bundle sold as a ONE-TIME unlock (`mode:'payment'`) rather than a recurring
 *  add-on subscription. Default = recurring. OPENWOP_BILLING_BUNDLE_ONETIME =
 *  ["<bundleId>", …]. A one-time grant has no Stripe subscription, so it never
 *  receives a `.deleted` — it stays active (buy-once semantics; an operator can
 *  revoke via a manual entitlement edit if ever needed). */
export function isOneTimeBundle(bundleId: string): boolean {
  try {
    const raw = process.env.OPENWOP_BILLING_BUNDLE_ONETIME;
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.includes(bundleId);
  } catch { return false; }
}

/** Marketing-only per-bundle display copy (never a Stripe id; honest-when-
 *  unconfigured — an absent entry shows the label + "included", never a
 *  fabricated figure). OPENWOP_BILLING_BUNDLE_DISPLAY =
 *  {"crm":{"price":"$29","cadence":"/mo","blurb":"…"}} */
/** ADR 0820 §7 — `priceAnnual`/`cadenceAnnual` are the display copy for a bundle's
 *  YEARLY price (its `year` entry in OPENWOP_BILLING_BUNDLE_PRICE_CADENCE). The store
 *  offers the yearly checkout only when this copy exists (MKT-UX-6: a money action
 *  is never offered without its amount beside it). */
export interface BundleDisplay { price?: string; cadence?: string; blurb?: string; priceAnnual?: string; cadenceAnnual?: string }
// Parsed ONCE per raw env string and memoized (CODE-BS-1) — same idiom as
// `planDisplayConfig`; the public read indexes this map instead of re-parsing.
let bundleDisplayCache: { raw: string | undefined; value: Record<string, BundleDisplay> } | null = null;
function bundleDisplayConfig(): Record<string, BundleDisplay> {
  const raw = process.env.OPENWOP_BILLING_BUNDLE_DISPLAY;
  if (bundleDisplayCache && bundleDisplayCache.raw === raw) return bundleDisplayCache.value;
  const value = parseBundleDisplayConfig(raw);
  bundleDisplayCache = { raw, value };
  return value;
}
function parseBundleDisplayConfig(raw: string | undefined): Record<string, BundleDisplay> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const known = new Set(knownBundleIds());
    const out: Record<string, BundleDisplay> = {};
    for (const [bundleId, d] of Object.entries(parsed)) {
      // DATA-419-3: warn on display copy for an unknown bundle (silent-drift trap).
      if (!known.has(bundleId)) { log.warn('billing bundle-display config references an unknown bundle — ignored', { bundleId }); continue; }
      if (!d || typeof d !== 'object') continue;
      const rec = d as Record<string, unknown>;
      const disp: BundleDisplay = {};
      if (typeof rec.price === 'string') disp.price = rec.price;
      if (typeof rec.cadence === 'string') disp.cadence = rec.cadence;
      if (typeof rec.blurb === 'string') disp.blurb = rec.blurb;
      if (typeof rec.priceAnnual === 'string') disp.priceAnnual = rec.priceAnnual;
      if (typeof rec.cadenceAnnual === 'string') disp.cadenceAnnual = rec.cadenceAnnual;
      out[bundleId] = disp;
    }
    return out;
  } catch { return {}; }
}
export function bundleDisplay(bundleId: string): BundleDisplay | undefined {
  return bundleDisplayConfig()[bundleId];
}

// ── reads ────────────────────────────────────────────────────────────────────
export async function getSubscription(tenantId: string): Promise<Subscription> {
  return (await subscriptions.get(tenantId)) ?? { tenantId, planTier: 'free', status: 'none', updatedAt: nowIso() };
}
export async function getBalance(tenantId: string): Promise<TokenBalance> {
  return (await balances.get(tenantId)) ?? { tenantId, purchasedTokensTotal: 0, totalAvailable: 0, updatedAt: nowIso() };
}

// ── ADR 0419: bundle entitlements ─────────────────────────────────────────────
export async function getBundleEntitlements(tenantId: string): Promise<BundleEntitlements> {
  return (await bundleEntitlements.get(tenantId)) ?? { tenantId, bundles: {}, updatedAt: nowIso() };
}
/** The active bundle ids a tenant holds (canceled grants excluded; a past_due grant
 *  counts inside the ADR 0820 §7 grace window). */
export async function activeBundleIds(tenantId: string): Promise<string[]> {
  const ent = await getBundleEntitlements(tenantId);
  const now = Date.now();
  return Object.entries(ent.bundles).filter(([, g]) => isGrantEntitled(g, now)).map(([id]) => id);
}

/** The store projection the tenant bundle-shop renders: per bundle, whether it
 *  is for sale (a price is configured), whether the caller's tenant owns it, and
 *  its honest display copy. Deliberately carries NO Stripe id (money data stays
 *  host-side) — a safe result boundary.
 *
 *  ADR 0820 §5 — `includedInPlan`: the tenant's PLAN already grants every feature
 *  of the bundle, so the store must not sell it (and checkout refuses it). `owned`
 *  stays purchase truth. `cadences`: the billing intervals it is for sale at. */
/** ADR 0820 §7 UI — store facts beside `owned`:
 *  - `includedInPlan`: the workspace's ENTITLED PAID plan (pro/team/enterprise,
 *    `isEntitledStatus`-aware via `entitledPlanOf`) grants every feature.
 *  - `freeForNow`: priced, not owned, not paid-plan-included, yet every feature is
 *    allowed anyway — the FREE plan's list covers it (the complimentary notice
 *    period an operator runs by listing newly priced bundles on `free`), or no plan
 *    allowlist exists at all (the paywall is off).
 *  - `purchasable`: whether a checkout would actually be accepted — for sale, not
 *    owned, and NOT covered by the plan the checkout refusal reads (any plan cover,
 *    the free plan included, is a 409 `bundle_included_in_plan`). The store offers a
 *    Buy button only when this is true.
 *  All three are computed from the PLAN config alone — never the operator
 *  (superadmin) bypass — so unrestricted operator access never reads as "free".
 *  - `trialDays`: the free trial a checkout of this bundle would open with, for
 *    THIS workspace (the same eligibility `trialFor` applies: recurring bundles
 *    only, and never after any grant row). Absent ⇒ no trial; never a guess.
 *
 *  CORRECTED 2026-10-06 (PR #4481 review): the first cut read ANY plan cover as
 *  `includedInPlan` and `freeForNow` only when no allowlist existed. Prod sets the
 *  allowlist and lists priced bundles on `free`, so every free tenant saw "Included
 *  in your plan" and never "Free for now". */
export interface BundleStoreItem {
  bundleId: string; forSale: boolean; owned: boolean; includedInPlan: boolean;
  freeForNow: boolean; purchasable: boolean; trialDays?: number;
  cadences: BillingCadence[]; priceDisplay?: BundleDisplay;
}
export async function bundleStore(tenantId: string): Promise<BundleStoreItem[]> {
  const ent = await getBundleEntitlements(tenantId);
  const configured = Boolean(process.env.OPENWOP_BILLING_PLAN_FEATURES);
  const tier = configured ? entitledPlanOf(await getSubscription(tenantId)) : 'free';
  // The list the checkout refusal reads (`planGrantedFeatures`), without a second read.
  const planList: '*' | string[] | null = configured ? planFeatures(tier) : null;
  const now = Date.now();
  return knownBundleIds().map((bundleId) => {
    const disp = bundleDisplay(bundleId);
    const cadences = bundleCadences(bundleId);
    const forSale = cadences.length > 0;
    const owned = isGrantEntitled(ent.bundles[bundleId], now);
    const coveredByPlan = planCoversBundle(planList, bundleId);
    const includedInPlan = tier !== 'free' && coveredByPlan;
    const freeForNow = forSale && !owned && !includedInPlan && (planList === null || coveredByPlan);
    const purchasable = forSale && !owned && !coveredByPlan;
    const trial = forSale && !isOneTimeBundle(bundleId) && !ent.bundles[bundleId] ? trialDaysFor({ bundleId }) : undefined;
    return {
      bundleId,
      forSale,
      owned,
      includedInPlan,
      freeForNow,
      purchasable,
      ...(trial ? { trialDays: trial } : {}),
      cadences,
      ...(disp ? { priceDisplay: disp } : {}),
    };
  });
}
/** The features the tenant's PLAN (not its bundle grants, not the operator bypass)
 *  grants, or `null` when no plan allowlist is configured at all — then the paywall
 *  is off, nothing is "included", and the store behaves exactly as before 0820. */
async function planGrantedFeatures(tenantId: string): Promise<'*' | string[] | null> {
  if (!process.env.OPENWOP_BILLING_PLAN_FEATURES) return null;
  const sub = await getSubscription(tenantId);
  return planFeatures(entitledPlanOf(sub));
}
function planCoversBundle(planList: '*' | string[] | null, bundleId: string): boolean {
  if (planList === null) return false;
  const features = bundleFeatureIds(bundleId);
  if (features.length === 0) return false;
  if (planList === '*') return true;
  const has = new Set(planList);
  return features.every((f) => has.has(f));
}
/** The plan tier a subscription row entitles right now (grace-aware). */
function entitledPlanOf(sub: Subscription): PlanTier {
  return isEntitledStatus(sub.status, sub.pastDueSince ? { pastDueSince: sub.pastDueSince } : {}) ? sub.planTier : 'free';
}
/** The feature-id union of a tenant's ACTIVE bundle grants (for entitlements). */
async function activeBundleFeatureIds(tenantId: string): Promise<string[]> {
  const ids = await activeBundleIds(tenantId);
  const out = new Set<string>();
  for (const bundleId of ids) for (const f of bundleFeatureIds(bundleId)) out.add(f);
  return [...out];
}
/**
 * Mutate ONE bundle grant under CAS on the tenant's single row — mirrors
 * `creditBalance`. `fn` returns the next grant, or `null` to leave the row alone.
 * Throwing on contention exhaustion releases the webhook event claim so Stripe
 * redelivers.
 */
async function mutateBundleGrant(tenantId: string, bundleId: string, fn: (g: BundleGrant | undefined) => BundleGrant | null): Promise<boolean> {
  for (let attempt = 0; attempt < BALANCE_CAS_ATTEMPTS; attempt++) {
    const existing = await bundleEntitlements.get(tenantId);
    const prev = existing?.bundles[bundleId];
    const grant = fn(prev);
    if (!grant) return false;
    const next: BundleEntitlements = { tenantId, bundles: { ...(existing?.bundles ?? {}), [bundleId]: grant }, updatedAt: nowIso() };
    if (await bundleEntitlements.compareAndSwap(existing ?? null, next)) {
      // ADR 0820 §7 (funnel digest) — churn, counted on the CAS that made it true:
      // `prev` is the state this write replaced, so a redelivered event (which
      // rewrites the same state) is no transition and counts nothing.
      const transition = grantTransition(prev, grant);
      if (transition) await recordLedgerCount({ tenantId, metric: transition, product: `bundle:${bundleId}` });
      return true;
    }
  }
  log.error('bundle-entitlement CAS contention exhausted — throwing so the Stripe event claim releases and redelivery retries', { tenantId, bundleId });
  throw new Error('bundle-entitlement contention exhausted');
}
/** Statuses of a subscription that was paying (or trialing) and can still recover. */
const RECOVERABLE_GRANT_STATUSES = new Set(['past_due', 'unpaid', 'paused']);
/**
 * ADR 0820 §7 (funnel digest) — the funnel event a grant write is, if any:
 *  - `grant-started`: the grant becomes entitled (`status: 'active'`, a trial
 *    included) and was not, EXCEPT a recovery of the same subscription from
 *    past_due / unpaid / paused, which is a payment fixed, not a new customer;
 *  - `grant-ended`: the grant reaches a TERMINAL Stripe status (canceled,
 *    incomplete_expired) from a state that was paying or recoverable. A grant
 *    that was never paid (`incomplete` → `incomplete_expired`) did not churn.
 * A subscription superseding another (active → active) is neither.
 */
function grantTransition(prev: BundleGrant | undefined, next: BundleGrant): 'grant-started' | 'grant-ended' | null {
  const wasActive = prev?.status === 'active';
  if (next.status === 'active') {
    if (wasActive) return null;
    const recovery = Boolean(prev?.stripeSubscriptionId) && prev?.stripeSubscriptionId === next.stripeSubscriptionId
      && RECOVERABLE_GRANT_STATUSES.has(prev?.stripeStatus ?? '');
    return recovery ? null : 'grant-started';
  }
  const ended = next.stripeSubscriptionId ? isTerminalStatus(next.stripeStatus) : true;
  if (!ended || !prev) return null;
  const wasPaying = wasActive || RECOVERABLE_GRANT_STATUSES.has(prev.stripeStatus ?? '');
  return wasPaying ? 'grant-ended' : null;
}
/** A ONE-TIME bundle unlock (no subscription): active by value, so a second
 *  fulfilment of the same purchase is a no-op. */
async function activateOneTimeBundle(tenantId: string, bundleId: string): Promise<void> {
  await mutateBundleGrant(tenantId, bundleId, (g) => (g?.status === 'active' && !g.stripeSubscriptionId
    ? null
    : { status: 'active', updatedAt: nowIso() }));
}
/** Find the bundle a tenant's grant maps to a given Stripe subscription id
 *  (fallback for a `.deleted` event that lost its metadata). */
async function bundleForSubscription(tenantId: string, subId: string): Promise<string | undefined> {
  const ent = await getBundleEntitlements(tenantId);
  for (const [bundleId, g] of Object.entries(ent.bundles)) if (g.stripeSubscriptionId === subId) return bundleId;
  return undefined;
}

/**
 * ADR 0820 §7 — the grace-START source for the public-runtime owner-lapse policy
 * (`host/publicLapse.ts` `registerEntitlementEndedAtSource`). Asked only AFTER the
 * owner was refused `featureId` by their plan: "when did the coverage that USED to
 * grant it end?" Returns an ISO time, or `null` when billing cannot say, in which
 * case the host falls back to its observed clock (first refusal seen).
 *
 * A covering source is the paid plan subscription (when its tier's feature list
 * holds `featureId`) and every bundle grant whose bundle holds it. What "ended"
 * means, per source:
 *   - `past_due` (plan or grant), INSIDE the operator's past-due grace: still
 *     entitled, so never a lapse; this function is not reached.
 *   - `past_due` AFTER that grace: the grace's end, `pastDueSince + N days`
 *     (`OPENWOP_BILLING_PAST_DUE_GRACE_DAYS`; with N = 0, `pastDueSince` itself),
 *     the instant `isEntitledStatus` flipped. A `past_due` row with no recorded
 *     `pastDueSince` (written before the field existed) is UNKNOWN.
 *   - canceled / unpaid / paused (plan or recurring grant): the row's `updatedAt`
 *     (for a grant, that grant's own `updatedAt`). No dedicated transition stamp
 *     exists, and `updatedAt` is the last write, which is AT OR AFTER the true
 *     end. So the clock can start late, never early: the error is always in the
 *     owner's favour, the same bias as the observed clock.
 *   - a ONE-TIME grant never ends on its own; when it is revoked its `updatedAt`
 *     is the revocation's write, under the rule above.
 *   - `incomplete` / `incomplete_expired` were never paid, so they never covered
 *     anything and are skipped. A tenant whose plan never held the feature (`none`,
 *     or an operator narrowing `OPENWOP_BILLING_PLAN_FEATURES`, or a downgrade
 *     that is still `active`) has no billing timestamp for the loss: `null`.
 *
 * Coverage ended when the LAST covering source ended, so the result is the
 * latest end. If any lapsed covering source is unknown, the latest end is unknown
 * too, and the answer is `null` rather than an earlier known time. A source that
 * still entitles, or an end in the future, means billing and the refusal disagree:
 * `null`, never a guess. `nowMs` is the test clock.
 */
export async function entitlementEndedAt(tenantId: string, featureId: string, nowMs: number = Date.now()): Promise<string | null> {
  const ends: number[] = [];
  let unknown = false;
  let stillCovered = false;
  const endOf = (status: string | undefined, pastDueSince: string | undefined, updatedAt: string): void => {
    if (status === 'past_due') {
      const since = pastDueSince ? Date.parse(pastDueSince) : NaN;
      if (!Number.isFinite(since)) { unknown = true; return; }
      ends.push(pastDueGraceEndsAtMs(pastDueSince) ?? since);
      return;
    }
    const t = Date.parse(updatedAt);
    if (Number.isFinite(t)) ends.push(t); else unknown = true;
  };
  const neverPaid = (status: string | undefined): boolean => status === 'incomplete' || status === 'incomplete_expired';

  const sub = await getSubscription(tenantId);
  if (sub.status !== 'none' && !neverPaid(sub.status)) {
    const tierList = planFeatures(sub.planTier);
    if (tierList === '*' || tierList.includes(featureId)) {
      if (isEntitledStatus(sub.status, { ...(sub.pastDueSince ? { pastDueSince: sub.pastDueSince } : {}), nowMs })) stillCovered = true;
      else endOf(sub.status, sub.pastDueSince, sub.updatedAt);
    }
  }
  const ent = await getBundleEntitlements(tenantId);
  for (const [bundleId, g] of Object.entries(ent.bundles)) {
    if (!bundleFeatureIds(bundleId).includes(featureId) || neverPaid(g.stripeStatus)) continue;
    if (isGrantEntitled(g, nowMs)) { stillCovered = true; continue; }
    endOf(g.stripeStatus, g.pastDueSince, g.updatedAt);
  }
  if (stillCovered || unknown || ends.length === 0) return null;
  const latest = Math.max(...ends);
  return latest <= nowMs ? new Date(latest).toISOString() : null;
}

// ── entitlements (ONE central resolver — never per-feature checks) ────────────
export interface Entitlements {
  plan: PlanTier;
  /** '*' = all features (the safe default when billing is off / no plan gating). */
  allowedFeatures: '*' | string[];
  limits: Record<string, number>;
}
/**
 * The single entitlement resolver. When billing is disabled or the tenant has no
 * active plan, returns UNRESTRICTED ('*') — the reference host is unrestricted until
 * an operator opts into billing (ADR 0176 Open Q). Usage-LIMITS are expressed here
 * and enforced at existing choke points (managedProvider/orgs/governance), NOT by
 * editing each feature.
 */
export async function resolveEntitlements(tenantId: string, billingEnabled: boolean): Promise<Entitlements> {
  if (!billingEnabled) return { plan: 'free', allowedFeatures: '*', limits: {} };
  const sub = await getSubscription(tenantId);
  // ADR 0820 §7 — grace-aware: a past_due plan keeps its tier inside the window.
  const plan = entitledPlanOf(sub);
  // The host's OPERATOR (a tenant listed in OPENWOP_SUPERADMIN_TENANTS) has every
  // feature and no tier limits on their own host: the plan paywall sells features
  // to customers, it does not lock the operator out of them (owner decision,
  // 2026-10-01 — the superadmin hit "Your plan (free) does not include this
  // feature" on Boards of Advisors). Allowlist only: not the dev-open switch,
  // which would un-paywall everyone. The plan is still reported truthfully.
  if (isListedSuperadminTenant(tenantId)) return { plan, allowedFeatures: '*', limits: {} };
  // Per-tier usage LIMITS + feature ALLOWLISTS from operator config (Phase 3) — expressed
  // here, enforced at existing choke points (managedProvider / orgs / governance /
  // requireEntitledFeature), NOT by editing each feature. Absent config ⇒ '*' so nothing
  // is silently blocked before an operator narrows it.
  const planF = planFeatures(plan);
  // ADR 0419 — a narrowed plan is WIDENED by the tenant's purchased bundles: the
  // union of the plan's features + every active bundle grant's features. When the
  // plan is unrestricted ('*') the bundle features are already included — skip the
  // read (keeps the hot path a no-op for unrestricted tenants).
  //
  // ADR 0419 § Correction — a narrowed plan must NEVER lock a NON-SELLABLE feature.
  // The central gate only entitlement-checks `isSellableBundleFeature` toggles, but
  // the FE locks any enabled feature absent from `allowedFeatures` — so narrowing to
  // an allowlist of only bundle features falsely locked core/standalone features
  // (e.g. `marketplace` — the store locked ITSELF). Union in every non-sellable
  // toggle id so the allowlist can only ever exclude features that are actually for
  // sale; the operator's `PLAN_FEATURES` list therefore only needs the SELLABLE
  // features it wants included for free.
  const nonSellable = listToggleDefaults().map((t) => t.id).filter((id) => !isSellableBundleFeature(id));
  const allowedFeatures = planF === '*' ? '*'
    : [...new Set([...planF, ...nonSellable, ...(await activeBundleFeatureIds(tenantId))])];
  return { plan, allowedFeatures, limits: planLimits(plan) };
}

/** Per-plan-tier feature allowlists from operator config. Absent / not-listed / invalid
 *  ⇒ '*' (fail-open — the reference host stays unrestricted until an operator narrows it).
 *  OPENWOP_BILLING_PLAN_FEATURES = {"free":["crm","forms"],"pro":["bundle:agents"],"team":"*"}
 *
 *  ADR 0820 §5 — an entry `"bundle:<id>"` expands to that bundle's features (the plan
 *  references the bundle, so a `bundles.json` change can no longer drift it). An
 *  unknown bundle is IGNORED with a warn — never a widened plan. Then every feature
 *  of a STANDALONE bundle is stripped (with a warn when a plan named one): no plan
 *  grants it, by reference or literally. When standalone bundles exist and plans ARE
 *  configured, an unrestricted (`'*'`) plan becomes "every bundle feature except the
 *  standalone ones" (non-sellable features are unioned in by `resolveEntitlements`
 *  regardless), so "no plan tier includes job-search" holds for every tier. With no
 *  plan config at all the host stays unrestricted. Parsed once per raw env pair. */
let planFeaturesCache: { raw: string | undefined; standaloneRaw: string | undefined; value: Partial<Record<PlanTier, string[]>> } | null = null;
export function planFeatures(plan: PlanTier): '*' | string[] {
  const raw = process.env.OPENWOP_BILLING_PLAN_FEATURES;
  if (!raw) return '*';
  const standaloneRaw = process.env.OPENWOP_BILLING_STANDALONE_BUNDLES;
  if (!planFeaturesCache || planFeaturesCache.raw !== raw || planFeaturesCache.standaloneRaw !== standaloneRaw) {
    planFeaturesCache = { raw, standaloneRaw, value: parsePlanFeatures(raw) };
  }
  return planFeaturesCache.value[plan] ?? '*';
}
const PLAN_TIERS: readonly PlanTier[] = ['free', 'pro', 'team', 'enterprise'];
function parsePlanFeatures(raw: string): Partial<Record<PlanTier, string[]>> {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const standalone = standaloneFeatureIds();
  const known = new Set(knownBundleIds());
  const out: Partial<Record<PlanTier, string[]>> = {};
  for (const plan of PLAN_TIERS) {
    const forPlan = parsed[plan];
    // Accept the list only when it is EXACTLY a string array — a partially-invalid
    // array must not silently narrow to something the operator didn't write
    // (an empty array IS honored: an explicit "this plan gets nothing").
    if (Array.isArray(forPlan) && forPlan.every((f): f is string => typeof f === 'string')) {
      const expanded = new Set<string>();
      for (const entry of forPlan) {
        if (!entry.startsWith('bundle:')) { expanded.add(entry); continue; }
        const bundleId = entry.slice('bundle:'.length);
        if (!known.has(bundleId)) { log.warn('billing plan config references an unknown bundle — ignored', { plan, entry }); continue; }
        for (const f of bundleFeatureIds(bundleId)) expanded.add(f);
      }
      const stripped = [...expanded].filter((f) => standalone.has(f));
      if (stripped.length > 0) log.warn('billing plan config lists a standalone bundle\'s features — stripped (standalone bundles are never in a plan)', { plan, features: stripped });
      out[plan] = [...expanded].filter((f) => !standalone.has(f));
    } else if (standalone.size > 0) {
      // '*' (or absent) while plans are configured: everything but the standalone bundles.
      const all = new Set<string>();
      for (const b of known) for (const f of bundleFeatureIds(b)) if (!standalone.has(f)) all.add(f);
      out[plan] = [...all];
    }
  }
  return out;
}

/** Per-plan-tier usage limits from operator config (Phase 3). Absent ⇒ no limits.
 *  OPENWOP_BILLING_PLAN_LIMITS = {"free":{"workflowRuns":100},"pro":{"workflowRuns":10000}}
 *  ADR 0821: `workflowRuns` (monthly, `host/planRunLimit.ts`) and `aiCreditsMonthly`
 *  (credits, `host/managedCredits.ts`) are ENFORCED; only keys listed in
 *  `host/planLimitsSeam.ts` `ENFORCED_PLAN_LIMIT_KEYS` are ever displayed. */
export function planLimits(plan: PlanTier): Record<string, number> {
  try {
    const raw = process.env.OPENWOP_BILLING_PLAN_LIMITS;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Record<string, number>>;
    const forPlan = parsed[plan];
    if (!forPlan || typeof forPlan !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(forPlan)) if (typeof v === 'number' && v >= 0) out[k] = v;
    return out;
  } catch { return {}; }
}

// ── public pricing catalog (ADR 0391 (b) — the marketing pricing page's read) ──
/** The four marketing plan tiers, in display order. Marketing FACTS (not
 *  entitlements): the public `/public/pricing` read returns them even when the
 *  billing toggle is off (fail-open — the ADR says so). */
const PRICING_TIERS: PlanTier[] = ['free', 'pro', 'team', 'enterprise'];
const PRICING_TIER_NAMES: Record<PlanTier, string> = { free: 'Free', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

/** Operator-supplied, marketing-ONLY per-tier display copy (a price/cadence/blurb
 *  + a highlight flag). Deliberately NOT in the entitlement config: no display
 *  price exists in billing today, so the pricing page reads this instead — and
 *  when it is absent the card shows the tier name + feature/limit list + a neutral
 *  CTA, NEVER a fabricated dollar figure (ADR 0391 honest-when-unconfigured). */
/** R2-G7 (UX_UPGRADE-site round 2): `priceAnnual`/`cadenceAnnual`/`annualNote`
 *  are the ADDITIVE second price shape behind the pricing page's
 *  monthly/annual toggle. All optional: a tier with only `price` renders its
 *  single authored price in both modes (the honest Linear-style fallback), and
 *  the toggle itself appears only when SOME tier authored an annual price.
 *  `annualNote` is the operator's own discount claim ("Save 20% yearly") —
 *  rendered verbatim, never computed. */
export interface PlanDisplay {
  price?: string; cadence?: string; blurb?: string; highlighted?: boolean;
  priceAnnual?: string; cadenceAnnual?: string; annualNote?: string;
}
/** A display-safe tier row — feature allowlist + usage limits (from the existing
 *  entitlement config) + the optional operator display copy. NEVER carries a
 *  `stripePriceId` or any Stripe id (marketing surface, no entitlements). */
export interface PublicPricingTier {
  tier: PlanTier;
  name: string;
  features: '*' | string[];
  limits: Record<string, number>;
  display?: PlanDisplay;
  /** ADR 0820 §7 (pricing FAQ) — the checkout trial this tier is configured with
   *  (`OPENWOP_BILLING_TRIAL_DAYS` `plan:<tier>`). Absent when none is: a FAQ never
   *  advertises a trial the checkout would not open. */
  trialDays?: number;
}

/** Parse `OPENWOP_BILLING_PLAN_DISPLAY` DEFENSIVELY (malformed ⇒ log + ignore,
 *  never throw): a per-tier `{ price, cadence, blurb, highlighted }` map. Each
 *  field is optional + bounded; a non-object tier entry is skipped.
 *
 *  Parsed ONCE per process and memoized (keyed by the raw env string): the
 *  config is operator env, which never changes at runtime, so the public
 *  pricing read must not re-parse JSON on every request. A changed env value
 *  (only possible in tests) re-parses because the cache key is the raw string. */
let displayCache: { raw: string | undefined; value: Partial<Record<PlanTier, PlanDisplay>> } | null = null;
function planDisplayConfig(): Partial<Record<PlanTier, PlanDisplay>> {
  const raw = process.env.OPENWOP_BILLING_PLAN_DISPLAY;
  if (displayCache && displayCache.raw === raw) return displayCache.value;
  const value = parsePlanDisplayConfig(raw);
  displayCache = { raw, value };
  return value;
}
function parsePlanDisplayConfig(raw: string | undefined): Partial<Record<PlanTier, PlanDisplay>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<PlanTier, PlanDisplay>> = {};
    for (const tier of PRICING_TIERS) {
      const d = parsed[tier];
      if (!d || typeof d !== 'object') continue;
      const rec = d as Record<string, unknown>;
      const entry: PlanDisplay = {};
      if (typeof rec.price === 'string' && rec.price.trim()) entry.price = rec.price.trim().slice(0, 40);
      if (typeof rec.cadence === 'string' && rec.cadence.trim()) entry.cadence = rec.cadence.trim().slice(0, 40);
      if (typeof rec.blurb === 'string' && rec.blurb.trim()) entry.blurb = rec.blurb.trim().slice(0, 200);
      if (rec.highlighted === true) entry.highlighted = true;
      if (typeof rec.priceAnnual === 'string' && rec.priceAnnual.trim()) entry.priceAnnual = rec.priceAnnual.trim().slice(0, 40);
      if (typeof rec.cadenceAnnual === 'string' && rec.cadenceAnnual.trim()) entry.cadenceAnnual = rec.cadenceAnnual.trim().slice(0, 40);
      if (typeof rec.annualNote === 'string' && rec.annualNote.trim()) entry.annualNote = rec.annualNote.trim().slice(0, 80);
      if (Object.keys(entry).length > 0) out[tier] = entry;
    }
    return out;
  } catch (err) {
    log.warn('plan-display config parse failed', { error: err instanceof Error ? err.message : String(err) });
    return {};
  }
}

/** The display-safe tier catalog for the public pricing page — the static tier
 *  list enriched with each tier's feature allowlist + usage limits (operator
 *  config) and the optional marketing display copy. Never reads a subscription
 *  and never emits a Stripe id. Works with the billing toggle off. */
export function publicPricingCatalog(): PublicPricingTier[] {
  const display = planDisplayConfig();
  return PRICING_TIERS.map((tier) => {
    const trialDays = trialDaysFor({ plan: tier });
    return {
      tier,
      name: PRICING_TIER_NAMES[tier],
      features: planFeatures(tier),
      // ADR 0821 D6 — only limits that have an enforcement site are advertised.
      limits: displayablePlanLimits(planLimits(tier)),
      ...(display[tier] ? { display: display[tier]! } : {}),
      ...(trialDays !== undefined ? { trialDays } : {}),
    };
  });
}

/** ADR 0820 §7 (pricing FAQ) — the non-secret policy numbers the public pricing
 *  FAQ states, read from the SAME parsers that enforce them, so the page cannot
 *  drift from the env. `pastDueGraceDays` 0 = no grace after a failed payment;
 *  `publicLapseGraceDays` null = the public-lapse policy is OFF (public runtimes
 *  keep serving), 0 = they stop at once. No Stripe id, no tenant data. */
export interface PublicBillingPolicy { pastDueGraceDays: number; publicLapseGraceDays: number | null }
export function publicBillingPolicy(): PublicBillingPolicy {
  return { pastDueGraceDays: pastDueGraceDays(), publicLapseGraceDays: publicLapseGraceDays() };
}

/** ADR 0419 — the PUBLIC, anonymous bundle-pricing read (the marketing pricing
 *  page). FOR-SALE bundles only (a configured price), with their honest display
 *  copy. Marketing FACTS, not entitlements: carries NO Stripe id (safe on an
 *  anon boundary) and returns `[]` when no bundle is priced (honest-when-
 *  unconfigured — never a fabricated figure), mirroring `publicPricingCatalog`. */
/** `features` lets the public page group its plan comparison by bundle (ids
 *  only — names come from `publicFeatureLabels`). `standalone` (ADR 0820 §5) is
 *  present only for a bundle NO plan may grant, so the page can say "sold
 *  separately" instead of implying a plan includes it. */
export interface PublicBundlePrice { bundleId: string; label: string; features: string[]; standalone?: true; priceDisplay?: BundleDisplay }
export function publicBundlePricing(): PublicBundlePrice[] {
  const cat = readBundleCatalog();
  if (!cat) return [];
  const standalone = standaloneBundleIds();
  const out: PublicBundlePrice[] = [];
  for (const [bundleId, def] of Object.entries(cat.bundles)) {
    if (bundleCadences(bundleId).length === 0) continue; // only for-sale bundles (any cadence)
    const disp = bundleDisplay(bundleId);
    out.push({
      bundleId, label: def.label ?? bundleId, features: [...def.features],
      ...(standalone.has(bundleId) ? { standalone: true as const } : {}),
      ...(disp ? { priceDisplay: disp } : {}),
    });
  }
  return out;
}

/** Human feature names for the public pricing page — the SAME toggle-registry
 *  `label` the feature store's `/feature-bundles` read uses (bundleCatalog
 *  `enrich`), keyed by every feature id a tier or a for-sale bundle names. An id
 *  this build does not register gets no entry (the page humanizes it, honestly). */
export function publicFeatureLabels(tiers: PublicPricingTier[], bundles: PublicBundlePrice[]): Record<string, string> {
  const ids = new Set<string>();
  for (const t of tiers) if (Array.isArray(t.features)) for (const f of t.features) ids.add(f);
  for (const b of bundles) for (const f of b.features) ids.add(f);
  const out: Record<string, string> = {};
  for (const id of [...ids].sort()) {
    const label = getToggleDefault(id)?.label;
    if (label) out[id] = label;
  }
  return out;
}

/** ADR 0821 D7 — the AI credit packs as the PUBLIC page shows them. Priced packs
 *  only (a money figure is never advertised without its amount, and an unpriced
 *  pack is not something a visitor can be told the cost of); smallest first.
 *  Carries NO Stripe id and NO `packKey` (an anonymous visitor cannot buy; the
 *  opaque checkout key stays a store concern). `[]` when none is priced. */
export interface PublicCreditPack { credits: number; price: string; label?: string }
export function publicCreditPacks(): PublicCreditPack[] {
  const out: PublicCreditPack[] = [];
  for (const p of listTokenPacks()) {
    const price = p.priceDisplay?.price;
    if (!price) continue;
    out.push({ credits: p.credits, price, ...(p.priceDisplay?.label ? { label: p.priceDisplay.label } : {}) });
  }
  return out;
}

// ── checkout session (LEAK-11: REAL Stripe when a key is configured; honest demo otherwise) ──
/** `trialDays` (ADR 0820 §7) is present when the session was opened with a free
 *  trial — informational; Stripe's `trialing` status is what entitles. */
export interface CheckoutSession { sessionId: string; url: string; priceId: string; mode: 'live' | 'demo'; createdAt: string; trialDays?: number }
/** ADR 0786 D1 — what a checkout sells. Stamped on the row AND the session. */
export type CheckoutKind = 'plan' | 'token-pack' | 'bundle';
/** The server-side record of a checkout we created — the AUTHORITY for which tenant
 *  a session belongs to and which price it sold (ADR 0786 D1). `kind` is absent on
 *  rows written before ADR 0786 (inferred from the price). */
type CheckoutRow = CheckoutSession & {
  tenantId: string; kind?: CheckoutKind; fulfilledAt?: string;
  /** ADR 0820 §7 (funnel digest) — this row's start / completion is in the
   *  `paywall:funnel-counts` daily counts, so the funnel read must not count it
   *  again from this ledger. Absent on rows written before the counts existed,
   *  which the read still counts from here (the cutover, exact per row). */
  startedCounted?: true;
  completedCounted?: true;
  /** The tokens a pack session sold, SNAPSHOT at creation (grade-code BILLCD-4): an
   *  operator repricing or removing a pack during an ACH window must not change what
   *  an already-paid session credits. */
  tokens?: number;
};
const checkouts = new DurableCollection<CheckoutRow>('billing:checkout', (s) => s.sessionId);
function kindOfPrice(priceId: string): CheckoutKind | undefined {
  if (planTierForPrice(priceId)) return 'plan';
  if (tokensForPackPrice(priceId)) return 'token-pack';
  if (bundleForPrice(priceId)) return 'bundle';
  return undefined;
}

// Retention (ADR 0077 P3) — a checkout session is a short-lived redirect handle (priceId
// + a hosted-checkout URL, no PII → `internal`) that Stripe expires within ~24h; the row
// then serves no purpose but accrues forever. Age it out on `createdAt` under the operator's
// opt-in `retention.internalDays` window. Keyed by sessionId (not tenant-prefixed) ⇒ a full
// scan + tenant filter (the helper's rowOf enforces the tenant match). Unlike the
// webhook-event ledger above, this carries no dedup guarantee, so purging is safe.
registerRetentionPurger({
  feature: 'billing:checkout',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'internal') return 0;
    return purgeRowsByAge('billing:checkout', await checkouts.list(), tenantId, cutoffIso,
      (s) => ({ tenantId: s.tenantId, updatedAt: s.createdAt, id: s.sessionId }),
      (id) => checkouts.delete(id));
  },
});
// ADR 0380 §3 — the SIZE-hygiene ceiling COMPOSING with the opt-in policy window
// above (two lanes, one tick): the governance purge is per-tenant, admin-tunable,
// and dormant until an operator enables the sweep; this is the global default-on
// backstop (Stripe expires the session in ~24h — 30d covers any reconciliation).
// Deletes compose idempotently; whichever lane fires first wins harmlessly.
registerKvAgeOut({ id: 'billing:checkout', prefix: 'hostext:billing:checkout:', ttlDays: 30, timestampField: 'createdAt' });
/** The BYOK secret ref holding the operator's Stripe API key — the ONE name
 *  (commerce paymentIntent verification imports it from here). */
export const STRIPE_KEY_REF = 'billing:stripe-key';
/** Create a Checkout Session for a configured price. LIVE mode (Stripe key
 *  present) creates a REAL session via the Stripe API and returns Stripe's own
 *  id + hosted URL (the prior implementation FABRICATED a checkout.stripe.com
 *  URL that 404'd at Stripe — see the ADR 0176 correction note). DEMO mode
 *  returns the honest deterministic sentinel so the flow stays exercisable
 *  keyless. Rejects a price outside the configured catalog either way. */
export async function createCheckoutSession(
  tenantId: string,
  priceId: string,
  stripeKey: string | null,
  urls?: { successUrl: string; cancelUrl: string },
): Promise<CheckoutSession> {
  const kind = kindOfPrice(priceId);
  if (!kind) {
    throw new OpenwopError('validation_error', 'Unknown priceId — not in the configured plan/token-pack/bundle catalog.', 400, { field: 'priceId' });
  }
  const bundleId = kind === 'bundle' ? bundleForPrice(priceId) : undefined;
  // ADR 0786 D7 — one live plan, one live grant per bundle. A second purchase would
  // double-bill; a plan CHANGE goes through the portal (same subscription).
  await refuseIfAlreadyLive(tenantId, kind, bundleId, stripeKey);
  const trialDays = await trialFor(tenantId, kind, priceId, bundleId);
  if (stripeKey && urls) {
    // Plans + recurring bundles are subscriptions; token packs + ONE-TIME bundles
    // are payments. EVERY session carries {tenantId, kind, priceId(, bundleId)} —
    // ADR 0786 D1: plan and pack sessions used to carry NOTHING, so a real
    // purchase's events could not be traced to a tenant and were dropped. In
    // subscription mode the same map rides the created subscription.
    const bundleOneTime = bundleId ? isOneTimeBundle(bundleId) : false;
    const isSub = kind === 'plan' || (kind === 'bundle' && !bundleOneTime);
    const metadata: Record<string, string> = { tenantId, kind, priceId, ...(bundleId ? { bundleId } : {}) };
    const open = (customer: string) => createStripeCheckoutSession(stripeKey, {
      priceId,
      mode: isSub ? 'subscription' : 'payment',
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      customer,
      metadata,
      ...(isSub ? { subscriptionMetadata: metadata } : {}),
      ...(isSub && trialDays ? { trialPeriodDays: trialDays } : {}),
    });
    const customer = await ensureStripeCustomer(tenantId, stripeKey);
    let created: { id: string; url: string };
    try {
      created = await open(customer);
    } catch (err) {
      // BILLCD-5 — the stored customer is gone for this key (deleted, or a test↔live
      // key switch). Without this every checkout 502s forever. Replace it once.
      if (!isMissingStripeCustomerError(err)) throw err;
      log.warn('billing: stored Stripe customer is missing for the configured key — replacing it', { tenantId });
      const { customerId } = await createStripeTenantCustomer(stripeKey, tenantId, customer);
      await mutateSubscription(tenantId, (row) => (row.stripeCustomerId === customer ? { ...row, stripeCustomerId: customerId, updatedAt: nowIso() } : null));
      created = await open((await getSubscription(tenantId)).stripeCustomerId ?? customerId);
    }
    // Store under STRIPE'S session id — the webhook resolves the tenant and the
    // price from THIS row (D1), never from the payload alone.
    const session: CheckoutSession = { sessionId: created.id, url: created.url, priceId, mode: 'live', createdAt: nowIso(), ...(isSub && trialDays ? { trialDays } : {}) };
    await checkouts.put({ ...session, tenantId, kind, startedCounted: true, ...(kind === 'token-pack' ? { tokens: tokensForPackPrice(priceId)! } : {}) });
    await recordLedgerCount({ tenantId, metric: 'checkout-started', product: checkoutProduct(kind, priceId) });
    return session;
  }
  const sessionId = `cs_${randomUUID().replace(/-/g, '')}`;
  const demoIsSub = kind === 'plan' || (kind === 'bundle' && !(bundleId && isOneTimeBundle(bundleId)));
  const session: CheckoutSession = { sessionId, url: `demo:checkout:${sessionId}`, priceId, mode: 'demo', createdAt: nowIso(), ...(demoIsSub && trialDays ? { trialDays } : {}) };
  await checkouts.put({ ...session, tenantId, kind, startedCounted: true, ...(kind === 'token-pack' ? { tokens: tokensForPackPrice(priceId)! } : {}) });
  await recordLedgerCount({ tenantId, metric: 'checkout-demo', product: checkoutProduct(kind, priceId) });
  return session;
}

// ── Strategy §8 — the checkout + grant halves of the operator funnel read ─────
/** One checkout in the funnel window, as the operator read sees it: WHAT was
 *  offered (`product`), never a Stripe id. Derived from the `billing:checkout`
 *  ledger checkout creation already writes (`createdAt` = started, `fulfilledAt`
 *  = the webhook saw it paid) — no second copy of the funnel is kept. The ledger
 *  ages out at 30 days (kvAgeOut above), which bounds the honest window. */
export interface CheckoutFunnelRow {
  tenantId: string; product: string; kind: CheckoutKind | 'unknown'; mode: 'live' | 'demo'; createdAt: string; fulfilledAt?: string;
  /** Already in the daily counts: the read skips this row's start / completion. */
  startedCounted?: boolean; completedCounted?: boolean;
}
/** `plan:<tier>` / `bundle:<id>` / `pack:<opaque key>`, resolved through today's
 *  price maps; a price the operator has since removed reads `…:unknown`. */
function checkoutProduct(kind: CheckoutKind | undefined, priceId: string): string {
  if (kind === 'plan') return `plan:${planTierForPrice(priceId) ?? 'unknown'}`;
  if (kind === 'bundle') return `bundle:${bundleForPrice(priceId) ?? 'unknown'}`;
  if (kind === 'token-pack') return `pack:${tokenPackKey(priceId)}`;
  return 'unknown';
}
/** Ledger rows STARTED in `[sinceIso, untilIso)` (cohort: a completion is
 *  attributed to its row's start). `untilIso` absent = no upper bound. */
export async function listCheckoutsSince(sinceIso: string, untilIso?: string): Promise<CheckoutFunnelRow[]> {
  const out: CheckoutFunnelRow[] = [];
  for (const r of await checkouts.list()) {
    if (!(r.createdAt >= sinceIso)) continue;
    if (untilIso !== undefined && !(r.createdAt < untilIso)) continue;
    const kind = r.kind ?? kindOfPrice(r.priceId);
    out.push({
      tenantId: r.tenantId, product: checkoutProduct(kind, r.priceId), kind: kind ?? 'unknown',
      mode: r.mode, createdAt: r.createdAt, ...(r.fulfilledAt ? { fulfilledAt: r.fulfilledAt } : {}),
      ...(r.startedCounted ? { startedCounted: true } : {}), ...(r.completedCounted ? { completedCounted: true } : {}),
    });
  }
  return out;
}
/** Workspaces entitled RIGHT NOW, per bundle grant and per paid plan tier —
 *  through the same predicates the paywall uses (`isGrantEntitled`,
 *  `isEntitledStatus` with the past-due grace). Free plans are not counted. */
export async function countActiveEntitlements(nowMs: number = Date.now()): Promise<{ bundles: Record<string, number>; plans: Record<string, number> }> {
  const bundles: Record<string, number> = {};
  for (const row of await bundleEntitlements.list()) {
    for (const [bundleId, g] of Object.entries(row.bundles ?? {})) {
      if (isGrantEntitled(g, nowMs)) bundles[bundleId] = (bundles[bundleId] ?? 0) + 1;
    }
  }
  const plans: Record<string, number> = {};
  for (const sub of await subscriptions.list()) {
    if (sub.planTier === 'free') continue;
    if (!isEntitledStatus(sub.status, { ...(sub.pastDueSince ? { pastDueSince: sub.pastDueSince } : {}), nowMs })) continue;
    plans[sub.planTier] = (plans[sub.planTier] ?? 0) + 1;
  }
  return { bundles, plans };
}

/** ADR 0820 §7 — the trial a checkout opens with: the operator's configured days
 *  for this plan tier / bundle, and only for a workspace that never had that
 *  subscription before (a plan row that ever carried a Stripe subscription, or any
 *  grant row for the bundle) — cancel-and-resubscribe must not mint endless trials.
 *  One-time bundles and token packs never trial. */
async function trialFor(tenantId: string, kind: CheckoutKind, priceId: string, bundleId: string | undefined): Promise<number | undefined> {
  if (kind === 'plan') {
    const tier = planTierForPrice(priceId);
    const days = tier ? trialDaysFor({ plan: tier }) : undefined;
    if (!days) return undefined;
    const sub = await getSubscription(tenantId);
    return sub.stripeSubscriptionId || (sub.endedSubscriptionIds?.length ?? 0) > 0 ? undefined : days;
  }
  if (kind === 'bundle' && bundleId && !isOneTimeBundle(bundleId)) {
    const days = trialDaysFor({ bundleId });
    if (!days) return undefined;
    return (await getBundleEntitlements(tenantId)).bundles[bundleId] ? undefined : days;
  }
  return undefined;
}

/** ADR 0786 D7 — refuse a checkout that would create a SECOND open plan (or a
 *  second grant of an owned bundle). A row can say "open" when Stripe no longer
 *  does (an R-1 import, a row a pre-0786 out-of-order event resurrected), so with a
 *  key we ask Stripe first. grade-code BILLCD-1: the reconcile ENDS the subscription
 *  only when Stripe says it is terminal or does not know it; an `unpaid`/`paused`
 *  one is recoverable, so its real status is recorded (never added to the ended
 *  set, which would drop its recovery forever) and the checkout is refused. */
async function refuseIfAlreadyLive(tenantId: string, kind: CheckoutKind, bundleId: string | undefined, stripeKey: string | null): Promise<void> {
  if (kind === 'plan') {
    const sub = await getSubscription(tenantId);
    const subId = sub.stripeSubscriptionId;
    if (!isOpenStatus(sub.status)) return;
    if (stripeKey && subId) {
      const actual = await statusInStripe(stripeKey, subId);
      if (actual === null || isTerminalStatus(actual)) {
        await mutateSubscription(tenantId, (row) => (row.stripeSubscriptionId === subId && isOpenStatus(row.status)
          ? { ...row, status: 'canceled', endedSubscriptionIds: withEnded(row.endedSubscriptionIds, subId), updatedAt: nowIso() }
          : null));
        log.warn('billing: reconciled a plan row Stripe no longer bills', { tenantId });
        return;
      }
      if (actual !== sub.status) {
        await mutateSubscription(tenantId, (row) => (row.stripeSubscriptionId === subId && row.status !== actual
          ? { ...row, status: actual as SubscriptionStatus, updatedAt: nowIso() }
          : null));
      }
    }
    throw new OpenwopError('conflict', 'This workspace already has a plan. Change it in the billing portal.', 409, { reason: 'plan_already_live' });
  }
  if (kind === 'bundle' && bundleId) {
    // ADR 0820 §5 — never sell what the plan already grants. Checked before the
    // grant so a plan-covered bundle reads as "included", not "owned".
    if (planCoversBundle(await planGrantedFeatures(tenantId), bundleId)) {
      throw new OpenwopError('conflict', 'Your plan already includes this bundle.', 409, { reason: 'bundle_included_in_plan', bundleId });
    }
    const grant = (await getBundleEntitlements(tenantId)).bundles[bundleId];
    if (!grant) return;
    const subId = grant.stripeSubscriptionId;
    if (!subId) {
      if (grant.status === 'active') throw new OpenwopError('conflict', 'This workspace already owns this bundle.', 409, { reason: 'bundle_already_owned', bundleId });
      return;
    }
    if (!isOpenStatus(grant.stripeStatus ?? (grant.status === 'active' ? 'active' : 'canceled'))) return;
    if (stripeKey) {
      const actual = await statusInStripe(stripeKey, subId);
      if (actual === null || isTerminalStatus(actual)) {
        await mutateBundleGrant(tenantId, bundleId, (g) => (g?.stripeSubscriptionId === subId
          ? { ...g, status: 'canceled', stripeStatus: actual ?? 'canceled', endedSubscriptionIds: withEnded(g.endedSubscriptionIds, subId), updatedAt: nowIso() }
          : null));
        log.warn('billing: reconciled a bundle grant Stripe no longer bills', { tenantId, bundleId });
        return;
      }
    }
    throw new OpenwopError('conflict', 'This workspace already owns this bundle.', 409, { reason: 'bundle_already_owned', bundleId });
  }
}
/** The subscription's status at Stripe, or `null` when Stripe does not know it
 *  for this key (a permanent read failure). Transient failures throw. */
async function statusInStripe(stripeKey: string, subId: string): Promise<string | null> {
  try {
    return String((await getStripeSubscription(stripeKey, subId)).status ?? '');
  } catch (err) {
    if (isPermanentStripeReadError(err)) return null;
    throw err;
  }
}

/** ADR 0786 D7 — the tenant's ONE Stripe customer: the stored one, else a new one
 *  stamped `metadata.tenantId` and stored by CAS. Every checkout passes it, so a
 *  pack or bundle bought without a plan is still visible in the portal. */
async function ensureStripeCustomer(tenantId: string, stripeKey: string): Promise<string> {
  const known = (await getSubscription(tenantId)).stripeCustomerId;
  if (known) return known;
  const { customerId } = await createStripeTenantCustomer(stripeKey, tenantId);
  await recordStripeCustomer(tenantId, customerId);
  return (await getSubscription(tenantId)).stripeCustomerId ?? customerId;
}
/** Record a customer on the plan row ONLY when it has none — never re-point. */
async function recordStripeCustomer(tenantId: string, customerId: string): Promise<void> {
  await mutateSubscription(tenantId, (row) => (row.stripeCustomerId ? null : { ...row, stripeCustomerId: customerId, updatedAt: nowIso() }));
}

/** ADR 0786 D4 — every plan-row write goes through here: read, `fn` computes the
 *  next row (or `null` = no change), compare-and-swap, retry. A plain get→put lost
 *  concurrent webhook writes (an `invoice.created` holding a stale row wrote
 *  `incomplete` back over a fresh `active`). Exhaustion THROWS so the event claim
 *  releases and Stripe redelivers. */
async function mutateSubscription(tenantId: string, fn: (row: Subscription) => Subscription | null): Promise<boolean> {
  for (let attempt = 0; attempt < BALANCE_CAS_ATTEMPTS; attempt++) {
    const existing = await subscriptions.get(tenantId);
    const next = fn(existing ?? { tenantId, planTier: 'free', status: 'none', updatedAt: nowIso() });
    if (!next) return false;
    if (await subscriptions.compareAndSwap(existing ?? null, { ...next, tenantId })) return true;
  }
  log.error('subscription CAS contention exhausted — throwing so the Stripe event claim releases and redelivery retries', { tenantId });
  throw new Error('subscription contention exhausted');
}

// ── Stripe webhook (idempotent) ───────────────────────────────────────────────
/** Verify a Stripe `Stripe-Signature: t=<ts>,v1=<sig>[,v1=<sig>…]` header
 *  (HMAC-SHA256 over `${t}.${rawBody}`), constant-time, with the replay window.
 *
 *  ADR 0786 D8 — EVERY `v1` is compared: while an endpoint's signing secret is
 *  being rolled Stripe sends one signature per active secret, and keeping only the
 *  last one (the old `Object.fromEntries`) rejected every event whose header listed
 *  the other secret's signature last. Other schemes are ignored (Stripe: prevents
 *  downgrade attacks). */
export function verifyStripeSignature(input: { signingSecret: string; signatureHeader: string | undefined; rawBody: string; now: number }):
  { ok: true } | { ok: false; reason: 'missing_headers' | 'stale' | 'bad_signature' } {
  if (!input.signatureHeader) return { ok: false, reason: 'missing_headers' };
  let tRaw: string | undefined;
  const v1s: string[] = [];
  for (const part of input.signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') tRaw = v;
    else if (k === 'v1' && v) v1s.push(v);
  }
  const t = Number(tRaw);
  if (tRaw === undefined || !Number.isFinite(t) || v1s.length === 0) return { ok: false, reason: 'missing_headers' };
  if (Math.abs(input.now - t * 1000) > STRIPE_REPLAY_WINDOW_MS) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(createHmac('sha256', input.signingSecret).update(`${tRaw}.${input.rawBody}`).digest('hex'));
  // Compare against every candidate (no early exit) so timing does not reveal
  // which position matched.
  let matched = false;
  for (const v1 of v1s) {
    const b = Buffer.from(v1);
    if (b.length === expected.length && timingSafeEqual(expected, b)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/** `in_progress` = another delivery holds a fresh claim on this event id; the
 *  route answers non-2xx so Stripe RETRIES (ADR 0786 D0). */
export type WebhookResult = { status: 'applied' | 'duplicate' | 'ignored' | 'in_progress'; };

type StripeObj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const epoch = (v: unknown): string | undefined => (num(v) ? new Date(num(v)! * 1000).toISOString() : undefined);
const metaOf = (o: StripeObj): Record<string, unknown> => ((o.metadata as Record<string, unknown> | undefined) ?? {});
/** The subscription an INVOICE belongs to, and that subscription's metadata.
 *  ADR 0786 D3 — `2025-12-15.clover` (our pinned version) REMOVED
 *  `invoice.subscription`; it is `parent.subscription_details.subscription` (Stripe
 *  basil changelog). The legacy field is still read for pre-basil payloads (R-1). */
function invoiceSubscription(inv: StripeObj): { subId?: string; meta: Record<string, unknown> } {
  const details = ((inv.parent as { subscription_details?: unknown } | undefined)?.subscription_details ?? {}) as StripeObj;
  const legacyDetails = (inv.subscription_details ?? {}) as StripeObj;
  const subId = str(details.subscription) ?? str(inv.subscription);
  return { ...(subId ? { subId } : {}), meta: { ...metaOf(legacyDetails), ...metaOf(details) } };
}

/**
 * Which tenant a verified, non-Connect Stripe event belongs to (ADR 0786 D1/D3).
 * Called by the webhook route AFTER the Connect and `ccOrderId` branches — the
 * routing-order invariant is unchanged. In order:
 *  1. a Checkout Session we created → the `billing:checkout` row (the authority);
 *  2. the object's `metadata.tenantId` (every session/subscription we create);
 *  3. an invoice's subscription-metadata snapshot (clover: `parent.subscription_details`);
 *  4. the tenant owning the Stripe customer (R-1 imported rows, payment methods).
 */
export async function resolveEventTenant(event: { type?: unknown; data?: unknown }): Promise<string | null> {
  const type = typeof event.type === 'string' ? event.type : '';
  const obj = (((event.data as { object?: unknown })?.object ?? {}) as StripeObj);
  if (type.startsWith('checkout.session.')) {
    const row = str(obj.id) ? await checkouts.get(str(obj.id)!) : null;
    if (row) return row.tenantId;
  }
  const meta = str(metaOf(obj).tenantId);
  if (meta) return meta;
  if (type.startsWith('invoice.')) {
    const fromSub = str(invoiceSubscription(obj).meta.tenantId);
    if (fromSub) return fromSub;
  }
  return tenantForStripeCustomer(str(obj.customer) ?? '');
}

/** ADR 0786 D0 — claim an event id as a LEASE. */
async function claimEvent(eventId: string): Promise<WebhookEvent | 'duplicate' | 'in_progress'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const fresh: WebhookEvent = { eventId, processedAt: nowIso(), state: 'claimed', claimedAt: now };
    if (await seenEvents.compareAndSwap(null, fresh)) return fresh;
    const cur = await seenEvents.get(eventId);
    if (!cur) continue; // released between our CAS and our read — try the insert again
    if (cur.state !== 'claimed') return 'duplicate'; // `done`, or a legacy pre-D0 row
    if (now - (cur.claimedAt ?? 0) < EVENT_CLAIM_LEASE_MS) return 'in_progress';
    // A stale claim: its holder died between claiming and finishing (a Cloud Run
    // SIGTERM, a revision swap). Take it over; every handler is idempotent.
    if (await seenEvents.compareAndSwap(cur, fresh)) {
      log.warn('stripe webhook: took over a stale event claim', { eventId, claimedAgoMs: now - (cur.claimedAt ?? 0) });
      return fresh;
    }
  }
  return 'in_progress';
}

/**
 * Apply a verified Stripe event to billing state, exactly once per `event.id`.
 * Handles subscription lifecycle + checkout fulfilment + invoices + payment
 * methods. R-1: preserves Stripe ids. `stripeKey` (when configured) is used to
 * READ current Stripe state (ADR 0786 D1/D4) — never to write.
 */
export async function processStripeEvent(
  tenantId: string,
  event: { id?: unknown; type?: unknown; data?: unknown },
  opts: { stripeKey?: string | null } = {},
): Promise<WebhookResult> {
  const eventId = typeof event.id === 'string' ? event.id : '';
  const type = typeof event.type === 'string' ? event.type : '';
  if (!eventId) return { status: 'ignored' };

  // Idempotency = a CAS-claimed LEASE (R-1.4/R-1.6, ADR 0786 D0). Under the
  // add-then-retire dual-endpoint cutover both endpoints deliver the same event
  // concurrently; exactly one wins the claim, the other is told to retry. The claim
  // flips to `done` only AFTER the effect, so a crash in between leaves a claim that
  // goes stale and is taken over — never a paid event marked processed and lost.
  const claim = await claimEvent(eventId);
  if (claim === 'duplicate' || claim === 'in_progress') return { status: claim };
  let result: WebhookResult;
  try {
    result = await applyStripeEvent(tenantId, type, event, opts.stripeKey ?? null);
  } catch (err) {
    // Release → Stripe's retry reprocesses. Release = make OUR claim stale (a CAS on
    // our own row), never an unconditional delete: after a takeover, a slow original
    // holder must not erase the new holder's claim (grade-code BILLCD-3).
    await seenEvents.compareAndSwap(claim, { ...claim, claimedAt: 0 }).catch(() => false);
    throw err;
  }
  // Finish = CAS our claim to `done`. If another delivery took the claim over while
  // we ran, it finishes it; our (idempotent) effect already landed.
  await seenEvents.compareAndSwap(claim, { eventId, processedAt: nowIso(), state: 'done' });
  return result;
}

async function applyStripeEvent(tenantId: string, type: string, event: { data?: unknown }, stripeKey: string | null): Promise<WebhookResult> {
  const obj = ((event.data as { object?: unknown })?.object ?? {}) as StripeObj;
  if (type.startsWith('customer.subscription.')) return applySubscriptionEvent(tenantId, type, obj, stripeKey);
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded' || type === 'checkout.session.async_payment_failed') {
    return applyCheckoutEvent(tenantId, type, obj, stripeKey);
  }
  if (type === 'invoice.paid' || type === 'invoice.finalized' || type === 'invoice.created' || type === 'invoice.payment_failed') {
    return applyInvoiceEvent(tenantId, type, obj);
  }
  if (type === 'payment_method.attached' || type === 'payment_method.detached') return applyPaymentMethodEvent(tenantId, type, obj);
  return { status: 'ignored' };
}

/** ADR 0786 D4 — the subscription's CURRENT state: fetched when a key exists
 *  (order-independent), else the payload. A permanent read failure (404: gone
 *  for this key) returns null → the event is acked and ignored (D9). */
async function currentSubscription(obj: StripeObj, stripeKey: string | null): Promise<{ sub: StripeObj; syncedAtMs?: number } | null> {
  const subId = str(obj.id);
  if (!stripeKey || !subId) {
    if (!stripeKey) log.warn('stripe webhook: no Stripe key configured — applying the event payload in delivery order');
    return { sub: obj };
  }
  try {
    const sub = await getStripeSubscription(stripeKey, subId);
    return { sub, syncedAtMs: Date.now() };
  } catch (err) {
    if (isPermanentStripeReadError(err)) {
      log.error('stripe webhook: subscription not readable with the configured key — ignored', { subscriptionId: subId });
      return null;
    }
    throw err; // transient / key rejected → claim released, Stripe retries
  }
}

async function applySubscriptionEvent(tenantId: string, type: string, payload: StripeObj, stripeKey: string | null): Promise<WebhookResult> {
  const subId = str(payload.id);
  const current = await currentSubscription(payload, stripeKey);
  if (!current || !subId) return { status: 'ignored' };
  const { sub, syncedAtMs } = current;
  const item0 = ((sub.items as { data?: unknown[] })?.data?.[0] ?? {}) as StripeObj;
  const priceId = str((item0.price as { id?: unknown } | undefined)?.id);
  const meta = metaOf(sub);
  const status: string = type.endsWith('.deleted') ? 'canceled' : (str(sub.status) ?? 'active');
  const terminal = isTerminalStatus(status);

  // ADR 0419 — a bundle add-on is a SEPARATE Stripe subscription; its lifecycle
  // must NOT touch the tenant's PLAN row. Identified by `metadata.bundleId`, a
  // bundle-priced item, or the stored subscription-id reverse lookup.
  const bundleId = str(meta.bundleId) ?? (priceId ? bundleForPrice(priceId) : undefined) ?? await bundleForSubscription(tenantId, subId);
  if (bundleId) {
    // D7 — a bundle subscription is billing's own (created by our checkout), so its
    // customer is the tenant's. Record it when the tenant has none, so the portal can
    // open for a bundle-only tenant (before this, the ONE live bundle tenant's portal
    // was the demo sentinel: nothing ever wrote a customer for a tenant with no plan).
    const bundleCustomer = str(sub.customer);
    if (bundleCustomer) await recordStripeCustomer(tenantId, bundleCustomer);
    const changed = await mutateBundleGrant(tenantId, bundleId, (g) => {
      if (g?.endedSubscriptionIds?.includes(subId)) return null; // D4: terminal per id
      // A paid ONE-TIME grant (no subscription) is only ever displaced by an
      // entitled subscription, never revoked by an unpaid one (grade-code BILLCD-9).
      if (g && !g.stripeSubscriptionId && g.status === 'active' && !isEntitledStatus(status)) return null;
      if (g?.stripeSubscriptionId === subId) {
        if (syncedAtMs !== undefined && (g.syncedAtMs ?? 0) > syncedAtMs) return null; // an older fetch lost the race
      } else if (g?.stripeSubscriptionId && !isEntitledStatus(status)) {
        return null; // D4: only an ENTITLED subscription supersedes the current one
      }
      // ADR 0820 §7 — record when this subscription entered past_due (the grace clock).
      const pastDueSince = nextPastDueSince(status, { ...(g?.stripeStatus ? { status: g.stripeStatus } : {}), ...(g?.stripeSubscriptionId ? { subId: g.stripeSubscriptionId } : {}), ...(g?.pastDueSince ? { pastDueSince: g.pastDueSince } : {}) }, subId);
      return {
        // D2 — entitled status, not "not deleted": `incomplete` (3-D Secure pending),
        // `unpaid`, `incomplete_expired` never grant. A past_due grant is `canceled`
        // here and entitles only through the read-time grace check (isGrantEntitled).
        status: isEntitledStatus(status) ? 'active' : 'canceled',
        stripeSubscriptionId: subId,
        stripeStatus: status,
        ...(pastDueSince ? { pastDueSince } : {}),
        ...(syncedAtMs !== undefined ? { syncedAtMs } : g?.syncedAtMs !== undefined ? { syncedAtMs: g.syncedAtMs } : {}),
        ...(terminal ? { endedSubscriptionIds: withEnded(g?.endedSubscriptionIds, subId) } : g?.endedSubscriptionIds ? { endedSubscriptionIds: g.endedSubscriptionIds } : {}),
        updatedAt: nowIso(),
      };
    });
    return { status: changed ? 'applied' : 'ignored' };
  }

  // ADR 0786 D3 — the PLAN row takes only the plan subscription. A commerce product
  // subscription (inline price_data, `productSubscriptionId` metadata, stamped with
  // the MERCHANT's tenantId) used to land here and overwrite the merchant's plan.
  const tier = priceId ? planTierForPrice(priceId) : undefined;
  const existing = await getSubscription(tenantId);
  const isPlan = Boolean(tier) || meta.kind === 'plan' || existing.stripeSubscriptionId === subId;
  if (!isPlan) {
    log.info('stripe webhook: subscription is not this tenant\'s plan — plan row untouched', { tenantId, subscriptionId: subId });
    return { status: 'ignored' };
  }
  // API-version resilience (R-1): `current_period_{start,end}` are top-level on
  // older versions but on the subscription ITEM in `2025-12-15.clover`; read both.
  const periodStart = epoch(sub.current_period_start) ?? epoch(item0.current_period_start);
  const periodEnd = epoch(sub.current_period_end) ?? epoch(item0.current_period_end);
  const changed = await mutateSubscription(tenantId, (row) => {
    if (row.endedSubscriptionIds?.includes(subId)) return null; // D4: terminal per id
    if (row.stripeSubscriptionId === subId) {
      if (syncedAtMs !== undefined && (row.syncedAtMs ?? 0) > syncedAtMs) return null;
    } else if (row.stripeSubscriptionId && !isEntitledStatus(status)) {
      return null; // D4: a canceled/incomplete OTHER subscription never displaces this one
    }
    // ADR 0820 §7 — the grace clock: kept across repeat past_due events of the same
    // subscription, stamped on the transition, dropped when the status leaves past_due.
    const { pastDueSince: prevPastDueSince, ...rowRest } = row;
    const pastDueSince = nextPastDueSince(status, { status: row.status, ...(row.stripeSubscriptionId ? { subId: row.stripeSubscriptionId } : {}), ...(prevPastDueSince ? { pastDueSince: prevPastDueSince } : {}) }, subId);
    return {
      ...rowRest,
      tenantId,
      status: status as SubscriptionStatus,
      ...(pastDueSince ? { pastDueSince } : {}),
      ...(str(sub.customer) ? { stripeCustomerId: str(sub.customer) } : {}),
      stripeSubscriptionId: subId,
      // No silent `'pro'` default: an unmapped price keeps the existing tier (honest).
      ...(priceId ? { stripePriceId: priceId, ...(tier ? { planTier: tier } : {}) } : {}),
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      ...(epoch(sub.trial_end) ? { trialEnd: epoch(sub.trial_end) } : {}),
      ...(num(sub.quantity) ? { quantity: num(sub.quantity) } : {}),
      ...(typeof sub.cancel_at_period_end === 'boolean' ? { cancelAtPeriodEnd: sub.cancel_at_period_end } : {}),
      ...(str(sub.latest_invoice) ? { latestInvoiceId: str(sub.latest_invoice) } : {}),
      ...(str(sub.default_payment_method) ? { defaultPaymentMethodId: str(sub.default_payment_method) } : {}),
      ...(syncedAtMs !== undefined ? { syncedAtMs } : {}),
      ...(terminal ? { endedSubscriptionIds: withEnded(row.endedSubscriptionIds, subId) } : {}),
      updatedAt: nowIso(),
    };
  });
  return { status: changed ? 'applied' : 'ignored' };
}

/** ADR 0786 D1 — fulfil a Checkout Session from the row WE wrote when creating it:
 *  the row names the tenant and the price, Stripe says whether it was paid. */
async function applyCheckoutEvent(tenantId: string, type: string, payload: StripeObj, stripeKey: string | null): Promise<WebhookResult> {
  const sessionId = str(payload.id);
  if (!sessionId) return { status: 'ignored' };
  const payloadMeta = metaOf(payload);
  const row = await checkouts.get(sessionId);
  let priceId: string | undefined;
  let kind: CheckoutKind | undefined;
  let fetched: Awaited<ReturnType<typeof getStripeCheckoutSession>> | undefined;
  try {
    if (row) {
      if (row.tenantId !== tenantId || (str(payloadMeta.tenantId) && payloadMeta.tenantId !== row.tenantId)) {
        log.error('stripe webhook: checkout session tenant mismatch — refused', { sessionId });
        return { status: 'ignored' };
      }
      priceId = row.priceId;
      kind = row.kind ?? kindOfPrice(row.priceId);
      if (stripeKey) fetched = await getStripeCheckoutSession(stripeKey, sessionId);
    } else {
      // No row (purged, or never ours). Only a session WE stamped may fall back to
      // its metadata, and only when Stripe confirms the line actually sold that
      // price — a Payment Link or dashboard session carrying `kind` cannot choose
      // what it is credited for.
      const metaKind = str(payloadMeta.kind);
      const metaPrice = str(payloadMeta.priceId);
      if (!metaKind || !metaPrice || !stripeKey) return { status: 'ignored' };
      fetched = await getStripeCheckoutSession(stripeKey, sessionId, { expandLineItems: true });
      if (fetched.linePriceId !== metaPrice || fetched.metadata.tenantId !== tenantId) {
        log.error('stripe webhook: checkout session metadata does not match what was sold — refused', { sessionId });
        return { status: 'ignored' };
      }
      priceId = metaPrice;
      kind = kindOfPrice(metaPrice);
    }
  } catch (err) {
    if (isPermanentStripeReadError(err)) {
      log.error('stripe webhook: checkout session not readable with the configured key — ignored', { sessionId });
      return { status: 'ignored' };
    }
    throw err;
  }
  if (!priceId || !kind) return { status: 'ignored' };
  if (type === 'checkout.session.async_payment_failed') {
    log.warn('stripe webhook: delayed checkout payment failed — nothing fulfilled', { tenantId, sessionId, kind });
    return { status: 'ignored' };
  }
  // Stripe: fulfil only when `payment_status != 'unpaid'`. A delayed method
  // (ACH, SEPA) completes `unpaid` and is fulfilled by
  // `checkout.session.async_payment_succeeded`.
  const paymentStatus = fetched?.paymentStatus ?? str(payload.payment_status);
  if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') return { status: 'ignored' };

  const customer = fetched?.customer ?? str(payload.customer);
  if (customer) await recordStripeCustomer(tenantId, customer);
  let applied = false;
  if (kind === 'token-pack') {
    const tokens = row?.tokens ?? tokensForPackPrice(priceId);
    if (tokens) applied = await creditBalance(tenantId, tokens, sessionId);
  } else if (kind === 'bundle') {
    // A ONE-TIME bundle unlock fulfils here; recurring bundles activate via their
    // subscription events and must NOT double-fulfil.
    const bundleId = bundleForPrice(priceId);
    if (bundleId && isOneTimeBundle(bundleId)) { await activateOneTimeBundle(tenantId, bundleId); applied = true; }
  }
  if (row && !row.fulfilledAt) {
    // Informational (UI / audit). The guard is the balance CAS, never this row.
    // ADR 0820 §7 (funnel digest) — but it IS the once-per-session guard for the
    // funnel's completed count: only the delivery that wins this CAS counts it, so
    // a redelivered event, or `async_payment_succeeded` after `completed`, adds 0.
    const won = await checkouts.compareAndSwap(row, { ...row, fulfilledAt: nowIso(), completedCounted: true }).catch(() => false);
    if (won && row.mode === 'live') await recordLedgerCount({ tenantId, metric: 'checkout-completed', product: checkoutProduct(kind, priceId) });
  }
  return { status: applied || Boolean(customer) ? 'applied' : 'ignored' };
}

async function applyInvoiceEvent(tenantId: string, type: string, inv: StripeObj): Promise<WebhookResult> {
  let applied = false;
  const { subId } = invoiceSubscription(inv);
  const invoiceId = str(inv.id);
  // ADR 0786 D3 — `latestInvoiceId` belongs to the PLAN subscription's invoices only
  // (a bundle's or a product subscription's invoice used to overwrite it). A failed
  // payment leaves the subscription's own `.updated` event to flip status.
  if (invoiceId && subId) {
    applied = await mutateSubscription(tenantId, (row) => (row.stripeSubscriptionId === subId && row.latestInvoiceId !== invoiceId
      ? { ...row, latestInvoiceId: invoiceId, updatedAt: nowIso() }
      : null));
  }
  // MERCH-E (ADR 0279) — drive a PRODUCT-subscription's next period order via the seam
  // (commerce registers the handler; billing never imports commerce). Only invoice.paid
  // (money actually captured) advances a recurring order. ADR 0786 D3: the sub id now
  // comes from the clover `parent`, so this fires on live invoices at all.
  if (type === 'invoice.paid' && subId) {
    await fireSubscriptionInvoicePaid({ tenantId, stripeSubscriptionId: subId, invoiceId: invoiceId ?? '' });
    applied = true;
  }
  return { status: applied ? 'applied' : 'ignored' };
}

async function applyPaymentMethodEvent(tenantId: string, type: string, pm: StripeObj): Promise<WebhookResult> {
  const pmId = str(pm.id);
  if (!pmId) return { status: 'ignored' };
  // Keep the plan row's default payment method current so the portal shows the
  // right card. Attaching a card does NOT make it the default — only adopt it when
  // there is none yet, and only when it belongs to THIS tenant's customer (D3).
  const changed = await mutateSubscription(tenantId, (row) => {
    if (type === 'payment_method.attached') {
      return !row.defaultPaymentMethodId && row.stripeCustomerId && str(pm.customer) === row.stripeCustomerId
        ? { ...row, defaultPaymentMethodId: pmId, updatedAt: nowIso() }
        : null;
    }
    if (row.defaultPaymentMethodId !== pmId) return null;
    const { defaultPaymentMethodId: _dropped, ...rest } = row;
    return { ...rest, updatedAt: nowIso() };
  });
  return { status: changed ? 'applied' : 'ignored' };
}

// ── R-1 cutover importer (operator tool — preserves every Stripe id verbatim) ──
export async function importBillingState(input: { subscriptions?: Subscription[]; balances?: TokenBalance[] }): Promise<{ subscriptions: number; balances: number }> {
  let s = 0;
  let b = 0;
  for (const sub of input.subscriptions ?? []) {
    if (!sub.tenantId) continue;
    // ids preserved verbatim (R-1.3). Through the CAS (ADR 0786 D4) so an import
    // racing a webhook write is a retry, not a lost update. The importer never sets
    // `syncedAtMs` — only a fetched subscription state may.
    const { syncedAtMs: _ignored, ...imported } = sub;
    await mutateSubscription(sub.tenantId, () => ({ ...imported, updatedAt: sub.updatedAt || nowIso() }));
    s++;
  }
  for (const bal of input.balances ?? []) {
    if (!bal.tenantId) continue;
    await balances.put({ ...bal, updatedAt: bal.updatedAt || nowIso() });
    b++;
  }
  return { subscriptions: s, balances: b };
}

/** Draw down prepaid balance before the managed daily-cap (Phase 2 composition point).
 *  Returns the tokens actually drawn from balance (0 if none). Idempotency is the
 *  caller's (this is the balance-first check at the managedProvider choke point). */
export async function drawFromBalance(tenantId: string, tokens: number): Promise<number> {
  if (tokens <= 0) return 0;
  // (2026-07 vuln-scan H4) The balance is real prepaid money. A plain get→put lost
  // concurrent draws (two parallel model calls both read `bal`, both write `bal-drawn`,
  // dropping one → free tokens). CAS-retry serializes them; each attempt re-reads and
  // recomputes `drawn`. Exhaustion (pathological contention only) under-draws — the
  // daily-cap backstop covers it — rather than throw into an already-completed call.
  for (let attempt = 0; attempt < BALANCE_CAS_ATTEMPTS; attempt++) {
    const existing = await balances.get(tenantId);
    const bal = existing ?? { tenantId, purchasedTokensTotal: 0, totalAvailable: 0, updatedAt: nowIso() };
    if (bal.totalAvailable <= 0) return 0;
    const drawn = Math.min(tokens, bal.totalAvailable);
    const next: TokenBalance = { ...bal, totalAvailable: bal.totalAvailable - drawn, updatedAt: nowIso() };
    if (await balances.compareAndSwap(existing ?? null, next)) return drawn;
  }
  log.warn('drawFromBalance CAS contention exhausted — under-drawing (daily-cap covers)', { tenantId, tokens });
  return 0;
}

/** CAS-retry credit to the prepaid balance (2026-07 vuln-scan). Concurrent DISTINCT
 *  top-up events for one tenant otherwise raced (a plain get→put dropped one).
 *
 *  ADR 0786 D1 — `sessionId` makes the credit exactly-once PER CHECKOUT SESSION:
 *  the session id is appended to `creditedSessions` inside the SAME compare-and-swap
 *  that adds the tokens, so a second event for one session (`completed`, then
 *  `async_payment_succeeded`) or a takeover of a stale event claim credits nothing,
 *  and there is no second write whose absence could strand or double it. Returns
 *  whether THIS call credited. On exhaustion it THROWS — `processStripeEvent`
 *  releases the claim so Stripe redelivers (swallowing would drop a paid credit). */
async function creditBalance(tenantId: string, tokens: number, sessionId: string): Promise<boolean> {
  if (tokens <= 0) return false;
  for (let attempt = 0; attempt < BALANCE_CAS_ATTEMPTS; attempt++) {
    const existing = await balances.get(tenantId);
    if (existing?.creditedSessions?.includes(sessionId)) return false;
    const bal = existing ?? { tenantId, purchasedTokensTotal: 0, totalAvailable: 0, updatedAt: nowIso() };
    const next: TokenBalance = {
      ...bal, // carry every field (the pre-0786 code rebuilt the row and would have dropped the list)
      tenantId,
      purchasedTokensTotal: bal.purchasedTokensTotal + tokens,
      totalAvailable: bal.totalAvailable + tokens,
      creditedSessions: [...(bal.creditedSessions ?? []), sessionId].slice(-CREDITED_SESSIONS_MAX),
      updatedAt: nowIso(),
    };
    if (await balances.compareAndSwap(existing ?? null, next)) return true;
  }
  log.error('creditTokens CAS contention exhausted — throwing so the Stripe event claim releases and redelivery retries', { tenantId, tokens });
  throw new Error('token-balance credit contention exhausted');
}

/** Resolve which tenant a Stripe customer belongs to (for webhook routing) — from an
 *  existing subscription's `stripeCustomerId`. A brand-new customer's first event
 *  carries `metadata.tenantId` (set at checkout); the route falls back to that. */
export async function tenantForStripeCustomer(customerId: string): Promise<string | null> {
  if (!customerId) return null;
  for (const s of await subscriptions.list()) if (s.stripeCustomerId === customerId) return s.tenantId;
  return null;
}

// ── seat sync (deferred P2 — per-seat proration polish) ───────────────────────
/** Set the subscription's seat count (from the org membership count; the route supplies
 *  the number so the service stays free of a core import). A change drives a Stripe
 *  quantity update in live mode (operator last-mile). */
export async function setSeats(tenantId: string, seats: number): Promise<Subscription> {
  await mutateSubscription(tenantId, (row) => ({ ...row, quantity: Math.max(0, Math.floor(seats)), updatedAt: nowIso() }));
  return getSubscription(tenantId);
}

// ── billing coupons (deferred P2) ─────────────────────────────────────────────
export interface BillingCoupon { code: string; type: 'percentage' | 'fixed'; value: number; createdAt: string }
const billingCoupons = new DurableCollection<BillingCoupon & { tenantId: string }>('billing:coupon', (c) => `${c.tenantId}:${c.code}`);
export async function createBillingCoupon(tenantId: string, code: string, type: 'percentage' | 'fixed', value: number): Promise<BillingCoupon> {
  const c: BillingCoupon = { code: code.trim().toUpperCase(), type, value: Math.max(0, value), createdAt: nowIso() };
  if (!c.code) throw new OpenwopError('validation_error', 'A coupon code is required.', 400, {});
  await billingCoupons.put({ ...c, tenantId });
  return c;
}
/** The discount a billing coupon applies to an amount (0 if unknown). */
export async function billingCouponDiscount(tenantId: string, code: string, amount: number): Promise<number> {
  const c = await billingCoupons.get(`${tenantId}:${code.trim().toUpperCase()}`);
  if (!c) return 0;
  return c.type === 'percentage' ? Math.min(amount, Math.round(amount * (c.value / 100) * 100) / 100) : Math.min(amount, c.value);
}

// ── invoices (deferred P2 — record + markdown; real PDF composes Documents 0053) ──
export interface Invoice { invoiceId: string; tenantId: string; planTier: PlanTier; amount: number; currency: string; markdown: string; createdAt: string }
const invoices = new DurableCollection<Invoice>('billing:invoice', (i) => i.invoiceId, undefined, (i) => i.tenantId);
export async function generateInvoice(tenantId: string, amount: number, currency = 'USD'): Promise<Invoice> {
  const sub = await getSubscription(tenantId);
  const invoiceId = `inv:${randomUUID().replace(/-/g, '')}`;
  const seats = sub.quantity ?? 1;
  const markdown = [
    `# Invoice ${invoiceId}`, '', `**Plan:** ${sub.planTier} · **Seats:** ${seats}`, '',
    '| Item | Amount |', '| --- | --- |', `| ${sub.planTier} subscription (${seats} seat${seats === 1 ? '' : 's'}) | ${amount} ${currency} |`,
    '', `**Total: ${amount} ${currency}**`,
  ].join('\n');
  const invoice: Invoice = { invoiceId, tenantId, planTier: sub.planTier, amount, currency, markdown, createdAt: nowIso() };
  await invoices.put(invoice);
  return invoice;
}
export async function listInvoices(tenantId: string): Promise<Invoice[]> {
  return (await invoices.listForTenantIndexed(tenantId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getInvoice(tenantId: string, invoiceId: string): Promise<Invoice | null> {
  const i = await invoices.get(invoiceId);
  return i && i.tenantId === tenantId ? i : null;
}

/** Test-only: plant an event claim as if a delivery had claimed it at
 *  `claimedAt` and then died (the ADR 0786 D0 crash window). */
export async function __seedEventClaim(eventId: string, claimedAt: number): Promise<void> {
  await seenEvents.put({ eventId, processedAt: new Date(claimedAt).toISOString(), state: 'claimed', claimedAt });
}
/** Test-only: plant a PRE-0786 ledger row (`{eventId, processedAt}`, no `state`) —
 *  the shape every event processed in production before ADR 0786 left behind. */
export async function __seedLegacyProcessedEvent(eventId: string): Promise<void> {
  await seenEvents.put({ eventId, processedAt: '2026-09-21T00:00:00.000Z' });
}

/** Test-only: plant one bundle grant verbatim (a lapsed grant with a chosen
 *  `updatedAt` / `pastDueSince`, which no webhook path can backdate). */
export async function __seedBundleGrant(tenantId: string, bundleId: string, grant: BundleGrant): Promise<void> {
  const existing = await bundleEntitlements.get(tenantId);
  await bundleEntitlements.put({ tenantId, bundles: { ...(existing?.bundles ?? {}), [bundleId]: grant }, updatedAt: nowIso() });
}

export async function __resetBilling(): Promise<void> {
  await subscriptions.__clear();
  await balances.__clear();
  await bundleEntitlements.__clear();
  await seenEvents.__clear();
  await checkouts.__clear();
  await billingCoupons.__clear();
  await invoices.__clear();
}
