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

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { OpenwopError } from '../../types.js';
import { fireSubscriptionInvoicePaid } from './subscriptionInvoiceHook.js';
import { createStripeCheckoutSession } from './stripeApi.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { knownBundleIds, bundleFeatureIds, readBundleCatalog, isSellableBundleFeature } from '../../host/featureBundles.js';
import { listToggleDefaults } from '../../host/featureToggles/registry.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('billing');

/** Bounded CAS retry count for the token-balance ledger (matches host/imageGenBudget).
 *  Per-tenant balance is low-concurrency, so 12 comfortably covers real contention. */
const BALANCE_CAS_ATTEMPTS = 12;

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'none';

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
  latestInvoiceId?: string;
  defaultPaymentMethodId?: string;
  updatedAt: string;
}
/** Prepaid AI-token balance ledger (NET-NEW — openwop had no balance, only a daily cap). */
export interface TokenBalance {
  tenantId: string;
  purchasedTokensTotal: number;
  totalAvailable: number;
  updatedAt: string;
}

const subscriptions = new DurableCollection<Subscription>('billing:subscription', (s) => s.tenantId, undefined, (s) => s.tenantId);
const balances = new DurableCollection<TokenBalance>('billing:token-balance', (b) => b.tenantId, undefined, (b) => b.tenantId);

/** ADR 0419 — a tenant's purchased feature-bundle grants. ONE row per tenant
 *  (a map of bundleId → grant) so the entitlement read is a single point-get on
 *  the `requireEntitledFeature` path. A bundle add-on is its own Stripe
 *  subscription, tracked by `stripeSubscriptionId`. */
export interface BundleGrant { status: 'active' | 'canceled'; stripeSubscriptionId?: string; updatedAt: string }
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
interface WebhookEvent { eventId: string; processedAt: string }
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
/** The configured Stripe price for a bundle, if it is for sale (checkout route). */
export function priceForBundle(bundleId: string): string | undefined {
  for (const [priceId, id] of Object.entries(bundlePriceMap())) if (id === bundleId) return priceId;
  return undefined;
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
export interface BundleDisplay { price?: string; cadence?: string; blurb?: string }
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
/** The active bundle ids a tenant holds (canceled grants excluded). */
export async function activeBundleIds(tenantId: string): Promise<string[]> {
  const ent = await getBundleEntitlements(tenantId);
  return Object.entries(ent.bundles).filter(([, g]) => g.status === 'active').map(([id]) => id);
}

/** The store projection the tenant bundle-shop renders: per bundle, whether it
 *  is for sale (a price is configured), whether the caller's tenant owns it, and
 *  its honest display copy. Deliberately carries NO Stripe id (money data stays
 *  host-side) — a safe result boundary. */
export interface BundleStoreItem { bundleId: string; forSale: boolean; owned: boolean; priceDisplay?: BundleDisplay }
export async function bundleStore(tenantId: string): Promise<BundleStoreItem[]> {
  const ent = await getBundleEntitlements(tenantId);
  return knownBundleIds().map((bundleId) => {
    const disp = bundleDisplay(bundleId);
    return {
      bundleId,
      forSale: priceForBundle(bundleId) !== undefined,
      owned: ent.bundles[bundleId]?.status === 'active',
      ...(disp ? { priceDisplay: disp } : {}),
    };
  });
}
/** The feature-id union of a tenant's ACTIVE bundle grants (for entitlements). */
async function activeBundleFeatureIds(tenantId: string): Promise<string[]> {
  const ids = await activeBundleIds(tenantId);
  const out = new Set<string>();
  for (const bundleId of ids) for (const f of bundleFeatureIds(bundleId)) out.add(f);
  return [...out];
}
/**
 * Set (activate/deactivate) a tenant's grant for ONE bundle, money-truth via
 * CAS on the single per-tenant row — mirrors `creditBalance`. Throwing on
 * contention exhaustion releases the webhook event claim so Stripe redelivers.
 * A `subId` reverse-lookup lets a metadata-less `.deleted` still find its grant.
 */
async function setBundleEntitlement(tenantId: string, bundleId: string, active: boolean, subId?: string): Promise<void> {
  for (let attempt = 0; attempt < BALANCE_CAS_ATTEMPTS; attempt++) {
    const existing = await bundleEntitlements.get(tenantId);
    const bundles = { ...(existing?.bundles ?? {}) };
    bundles[bundleId] = {
      status: active ? 'active' : 'canceled',
      ...(subId ? { stripeSubscriptionId: subId } : existing?.bundles[bundleId]?.stripeSubscriptionId ? { stripeSubscriptionId: existing.bundles[bundleId].stripeSubscriptionId } : {}),
      updatedAt: nowIso(),
    };
    const next: BundleEntitlements = { tenantId, bundles, updatedAt: nowIso() };
    if (await bundleEntitlements.compareAndSwap(existing ?? null, next)) return;
  }
  log.error('bundle-entitlement CAS contention exhausted — throwing so the Stripe event claim releases and redelivery retries', { tenantId, bundleId });
  throw new Error('bundle-entitlement contention exhausted');
}
/** Find the bundle a tenant's grant maps to a given Stripe subscription id
 *  (fallback for a `.deleted` event that lost its metadata). */
async function bundleForSubscription(tenantId: string, subId: string): Promise<string | undefined> {
  const ent = await getBundleEntitlements(tenantId);
  for (const [bundleId, g] of Object.entries(ent.bundles)) if (g.stripeSubscriptionId === subId) return bundleId;
  return undefined;
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
  const active = sub.status === 'active' || sub.status === 'trialing';
  const plan = active ? sub.planTier : 'free';
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
 *  OPENWOP_BILLING_PLAN_FEATURES = {"free":["crm","forms"],"pro":"*"} */
export function planFeatures(plan: PlanTier): '*' | string[] {
  try {
    const raw = process.env.OPENWOP_BILLING_PLAN_FEATURES;
    if (!raw) return '*';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const forPlan = parsed[plan];
    // Accept the list only when it is EXACTLY a string array — a partially-invalid
    // array must not silently narrow to something the operator didn't write
    // (an empty array IS honored: an explicit "this plan gets nothing").
    if (Array.isArray(forPlan) && forPlan.every((f): f is string => typeof f === 'string')) return forPlan;
    return '*';
  } catch { return '*'; }
}

/** Per-plan-tier usage limits from operator config (Phase 3). Absent ⇒ no limits.
 *  OPENWOP_BILLING_PLAN_LIMITS = {"free":{"workflowRuns":100},"pro":{"workflowRuns":10000}} */
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
  return PRICING_TIERS.map((tier) => ({
    tier,
    name: PRICING_TIER_NAMES[tier],
    features: planFeatures(tier),
    limits: planLimits(tier),
    ...(display[tier] ? { display: display[tier]! } : {}),
  }));
}

/** ADR 0419 — the PUBLIC, anonymous bundle-pricing read (the marketing pricing
 *  page). FOR-SALE bundles only (a configured price), with their honest display
 *  copy. Marketing FACTS, not entitlements: carries NO Stripe id (safe on an
 *  anon boundary) and returns `[]` when no bundle is priced (honest-when-
 *  unconfigured — never a fabricated figure), mirroring `publicPricingCatalog`. */
export interface PublicBundlePrice { bundleId: string; label: string; priceDisplay?: BundleDisplay }
export function publicBundlePricing(): PublicBundlePrice[] {
  const cat = readBundleCatalog();
  if (!cat) return [];
  const out: PublicBundlePrice[] = [];
  for (const [bundleId, def] of Object.entries(cat.bundles)) {
    if (priceForBundle(bundleId) === undefined) continue; // only for-sale bundles
    const disp = bundleDisplay(bundleId);
    out.push({ bundleId, label: def.label ?? bundleId, ...(disp ? { priceDisplay: disp } : {}) });
  }
  return out;
}

// ── checkout session (LEAK-11: REAL Stripe when a key is configured; honest demo otherwise) ──
export interface CheckoutSession { sessionId: string; url: string; priceId: string; mode: 'live' | 'demo'; createdAt: string }
const checkouts = new DurableCollection<CheckoutSession & { tenantId: string }>('billing:checkout', (s) => s.sessionId);

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
  const planTier = planTierForPrice(priceId);
  const packTokens = tokensForPackPrice(priceId);
  const bundleId = bundleForPrice(priceId); // ADR 0419 — a paid feature bundle
  if (!planTier && !packTokens && !bundleId) {
    throw new OpenwopError('validation_error', 'Unknown priceId — not in the configured plan/token-pack/bundle catalog.', 400, { field: 'priceId' });
  }
  if (stripeKey && urls) {
    // Plans + recurring bundles are subscriptions; token packs + ONE-TIME bundles
    // are payments. A bundle carries {tenantId, bundleId} metadata on the session
    // (and, in subscription mode, on the subscription) so every event — including a
    // one-time checkout.session.completed — correlates back to this tenant + bundle.
    const bundleOneTime = bundleId ? isOneTimeBundle(bundleId) : false;
    const isSub = Boolean(planTier) || (Boolean(bundleId) && !bundleOneTime);
    const created = await createStripeCheckoutSession(stripeKey, {
      priceId,
      mode: isSub ? 'subscription' : 'payment',
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      ...(bundleId ? { metadata: { tenantId, bundleId }, ...(isSub ? { subscriptionMetadata: { tenantId, bundleId } } : {}) } : {}),
    });
    // Store under STRIPE'S session id so the (already-real) webhook's
    // checkout.session.completed correlates back to this tenant.
    const session: CheckoutSession = { sessionId: created.id, url: created.url, priceId, mode: 'live', createdAt: nowIso() };
    await checkouts.put({ ...session, tenantId });
    return session;
  }
  const sessionId = `cs_${randomUUID().replace(/-/g, '')}`;
  const session: CheckoutSession = { sessionId, url: `demo:checkout:${sessionId}`, priceId, mode: 'demo', createdAt: nowIso() };
  await checkouts.put({ ...session, tenantId });
  return session;
}

// ── Stripe webhook (idempotent) ───────────────────────────────────────────────
/** Verify a Stripe `Stripe-Signature: t=<ts>,v1=<sig>` header (HMAC-SHA256 over
 *  `${t}.${rawBody}`), constant-time, with the replay window. */
export function verifyStripeSignature(input: { signingSecret: string; signatureHeader: string | undefined; rawBody: string; now: number }):
  { ok: true } | { ok: false; reason: 'missing_headers' | 'stale' | 'bad_signature' } {
  if (!input.signatureHeader) return { ok: false, reason: 'missing_headers' };
  const parts = Object.fromEntries(input.signatureHeader.split(',').map((kv) => kv.split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'missing_headers' };
  if (Math.abs(input.now - t * 1000) > STRIPE_REPLAY_WINDOW_MS) return { ok: false, reason: 'stale' };
  const expected = createHmac('sha256', input.signingSecret).update(`${parts.t}.${input.rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

export type WebhookResult = { status: 'applied' | 'duplicate' | 'ignored'; };

/**
 * Apply a verified Stripe event to billing state, idempotent per `event.id`. Handles
 * subscription lifecycle + invoice + token-pack purchase. R-1: preserves Stripe ids.
 */
export async function processStripeEvent(tenantId: string, event: { id?: unknown; type?: unknown; data?: unknown }): Promise<WebhookResult> {
  const eventId = typeof event.id === 'string' ? event.id : '';
  const type = typeof event.type === 'string' ? event.type : '';
  if (!eventId) return { status: 'ignored' };

  // Idempotency = an atomic CLAIM (R-1.4/R-1.6): compare-and-swap-insert the
  // event-id marker BEFORE processing. Under the add-then-retire dual-endpoint
  // cutover, both endpoints deliver the same event concurrently; a get-then-put
  // guard races (both read "unseen", both apply → double-credited token pack).
  // CAS lets exactly one delivery win the claim; the loser returns `duplicate`.
  // On a processing error we RELEASE the claim so Stripe's retry reprocesses.
  if (!(await seenEvents.compareAndSwap(null, { eventId, processedAt: nowIso() }))) {
    return { status: 'duplicate' };
  }
  try {
    return await applyStripeEvent(tenantId, type, event);
  } catch (err) {
    await seenEvents.delete(eventId).catch(() => undefined); // release → Stripe retry reprocesses
    throw err;
  }
}

async function applyStripeEvent(tenantId: string, type: string, event: { data?: unknown }): Promise<WebhookResult> {
  const obj = ((event.data as { object?: unknown })?.object ?? {}) as Record<string, unknown>;
  let applied = false;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const item0 = ((obj.items as { data?: unknown[] })?.data?.[0] ?? {}) as Record<string, unknown>;
  const epoch = (v: unknown): string | undefined => (num(v) ? new Date(num(v)! * 1000).toISOString() : undefined);

  if (type.startsWith('customer.subscription.')) {
    const priceId = str((item0.price as { id?: unknown } | undefined)?.id);
    // ADR 0419 — a bundle add-on is a SEPARATE Stripe subscription; its lifecycle
    // events must NOT overwrite the tenant's PLAN subscription row. Route them to
    // the bundle-entitlement store, identified by `metadata.bundleId` (primary) OR
    // a bundle-priced item (fallback for a sub created without our metadata) OR —
    // for a `.deleted` that lost both — the stored subscription-id reverse-lookup.
    const metaBundle = str((obj.metadata as { bundleId?: unknown } | undefined)?.bundleId);
    const subId = str(obj.id);
    const priceBundle = priceId ? bundleForPrice(priceId) : undefined;
    let bundleId = metaBundle ?? priceBundle;
    if (!bundleId && type.endsWith('.deleted') && subId) bundleId = await bundleForSubscription(tenantId, subId);
    if (bundleId) {
      await setBundleEntitlement(tenantId, bundleId, !type.endsWith('.deleted'), subId);
      return { status: 'applied' };
    }
    const tier = priceId ? planTierForPrice(priceId) : undefined;
    const status = str(obj.status);
    // API-version resilience (R-1): `current_period_{start,end}` are top-level on
    // older versions but on the subscription ITEM in `2025-12-15.clover`; read both.
    const periodStart = epoch(obj.current_period_start) ?? epoch(item0.current_period_start);
    const periodEnd = epoch(obj.current_period_end) ?? epoch(item0.current_period_end);
    const next: Subscription = {
      ...(await getSubscription(tenantId)),
      tenantId,
      status: type.endsWith('.deleted') ? 'canceled' : (status as SubscriptionStatus) ?? 'active',
      ...(str(obj.customer) ? { stripeCustomerId: str(obj.customer) } : {}),
      ...(str(obj.id) ? { stripeSubscriptionId: str(obj.id) } : {}),
      // No silent `'pro'` default: an unmapped price keeps the existing tier (honest).
      ...(priceId ? { stripePriceId: priceId, ...(tier ? { planTier: tier } : {}) } : {}),
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      ...(epoch(obj.trial_end) ? { trialEnd: epoch(obj.trial_end) } : {}),
      ...(num(obj.quantity) ? { quantity: num(obj.quantity) } : {}),
      ...(str(obj.latest_invoice) ? { latestInvoiceId: str(obj.latest_invoice) } : {}),
      ...(str(obj.default_payment_method) ? { defaultPaymentMethodId: str(obj.default_payment_method) } : {}),
      updatedAt: nowIso(),
    };
    await subscriptions.put(next);
    applied = true;
  } else if (type === 'checkout.session.completed') {
    // A token-pack purchase credits the prepaid balance — the CAS claim above makes
    // it exactly-once even under concurrent dual-endpoint redelivery (R-1.6).
    const priceId = str(obj.priceId) ?? str(((obj.line_items as { data?: unknown[] })?.data?.[0] as { price?: { id?: unknown } })?.price?.id);
    const tokens = priceId ? tokensForPackPrice(priceId) : undefined;
    if (tokens) {
      await creditBalance(tenantId, tokens);
      applied = true;
    }
    // ADR 0419 — a ONE-TIME bundle unlock fulfils here (no subscription events).
    // Read the bundle from the session metadata we set at checkout; activate ONLY
    // one-time bundles — recurring bundles activate via customer.subscription.* and
    // must NOT double-fulfil here. Idempotent per event id (the claim above).
    const metaBundle = str((obj.metadata as { bundleId?: unknown } | undefined)?.bundleId);
    if (metaBundle && isOneTimeBundle(metaBundle)) {
      await setBundleEntitlement(tenantId, metaBundle, true);
      applied = true;
    }
  } else if (type === 'invoice.paid' || type === 'invoice.finalized' || type === 'invoice.created' || type === 'invoice.payment_failed') {
    // Record the latest invoice id (parity with MyndHyve's invoice sync). A failed
    // payment leaves the subscription's own `.updated` event to flip status to past_due.
    const sub = await getSubscription(tenantId);
    if (str(obj.id)) { await subscriptions.put({ ...sub, latestInvoiceId: str(obj.id), updatedAt: nowIso() }); applied = true; }
    // MERCH-E (ADR 0279) — drive a PRODUCT-subscription's next period order via the seam
    // (commerce registers the handler; billing never imports commerce). Only invoice.paid
    // (money actually captured) advances a recurring order; the other invoice events do not.
    const subId = str(obj.subscription);
    if (type === 'invoice.paid' && subId) {
      await fireSubscriptionInvoicePaid({ tenantId, stripeSubscriptionId: subId, invoiceId: str(obj.id) ?? '' });
      applied = true;
    }
  } else if (type === 'payment_method.attached' || type === 'payment_method.detached') {
    // Keep the tenant subscription's default payment method current so the portal
    // shows the right card post-cutover (the sub's own `.updated` event is the
    // authoritative source; this covers the standalone card add/remove case).
    const pmId = str(obj.id);
    const sub = await getSubscription(tenantId);
    // Attaching a card does NOT make it the default — only adopt it when there's
    // no default yet (first card). The authoritative default rides the
    // subscription's own `default_payment_method` event, which would otherwise be
    // clobbered here by a newly-added SECONDARY card.
    if (type === 'payment_method.attached' && pmId && !sub.defaultPaymentMethodId) {
      await subscriptions.put({ ...sub, defaultPaymentMethodId: pmId, updatedAt: nowIso() }); applied = true;
    } else if (type === 'payment_method.detached' && pmId && sub.defaultPaymentMethodId === pmId) {
      const { defaultPaymentMethodId: _dropped, ...rest } = sub;
      await subscriptions.put({ ...rest, updatedAt: nowIso() }); applied = true;
    }
  }

  return { status: applied ? 'applied' : 'ignored' };
}

// ── R-1 cutover importer (operator tool — preserves every Stripe id verbatim) ──
export async function importBillingState(input: { subscriptions?: Subscription[]; balances?: TokenBalance[] }): Promise<{ subscriptions: number; balances: number }> {
  let s = 0;
  let b = 0;
  for (const sub of input.subscriptions ?? []) {
    if (!sub.tenantId) continue;
    await subscriptions.put({ ...sub, updatedAt: sub.updatedAt || nowIso() }); // ids preserved verbatim (R-1.3)
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
 *  top-up events for one tenant otherwise raced (a plain get→put dropped one). The
 *  Stripe event-id CAS-claim upstream already makes REDELIVERY of the same event
 *  exactly-once; this fixes the distinct-event race. On exhaustion it THROWS —
 *  `processStripeEvent`'s catch RELEASES the claimed event id (`seenEvents.delete`,
 *  billingService.ts), so Stripe redelivers and the credit reprocesses. Throwing is
 *  the money-correct fail-safe here (swallowing would mark the event applied and drop
 *  a paid credit permanently). Real money — never silently under-credit. */
async function creditBalance(tenantId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  for (let attempt = 0; attempt < BALANCE_CAS_ATTEMPTS; attempt++) {
    const existing = await balances.get(tenantId);
    const bal = existing ?? { tenantId, purchasedTokensTotal: 0, totalAvailable: 0, updatedAt: nowIso() };
    const next: TokenBalance = {
      tenantId,
      purchasedTokensTotal: bal.purchasedTokensTotal + tokens,
      totalAvailable: bal.totalAvailable + tokens,
      updatedAt: nowIso(),
    };
    if (await balances.compareAndSwap(existing ?? null, next)) return;
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
  const sub = await getSubscription(tenantId);
  const next: Subscription = { ...sub, quantity: Math.max(0, Math.floor(seats)), updatedAt: nowIso() };
  await subscriptions.put(next);
  return next;
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

export async function __resetBilling(): Promise<void> {
  await subscriptions.__clear();
  await balances.__clear();
  await bundleEntitlements.__clear();
  await seenEvents.__clear();
  await checkouts.__clear();
  await billingCoupons.__clear();
  await invoices.__clear();
}
