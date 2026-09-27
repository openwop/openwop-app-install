/**
 * Solstice Roasters — the shared demo brand bible.
 *
 * ONE company across EVERY seeded surface (app-seeding-strategy.md §3): a
 * specialty-coffee business selling DTC via the storefront and B2B wholesale to
 * cafés, hotels, and grocers. Every `demo-*` seeder (people, media, crm,
 * commerce-depth, merchandising, territories, cdp, content-marketing,
 * ops-planning) and Phase 8's agent depth pulls names, people, companies, SKUs,
 * and copy FROM HERE so the whole tenant tells one coherent story and future
 * features can reuse the same canon.
 *
 * This module is authored content, NOT seeding logic — the `*Seed.ts` modules
 * consume it through the real services. It grows one section per phase; keep it
 * legible and typed so a malformed edit fails `tsc`.
 *
 * Coherence note: the existing `commerceShowcase.ts` / `campaignShowcase.ts`
 * seeders already use the "Solstice Roasters" name. Those stay as-is (name-only
 * coherence, ADR 0031); this module is the canonical superset the new
 * dependency-ordered `demo-*` phases build on, under DISTINCT canonical ids so
 * the two never collide.
 */

import { createHash } from 'node:crypto';
import type { MediaSpec, Silhouette } from './media/solsticeArt.js';

export const SOLSTICE_BRAND = {
  name: 'Solstice Roasters',
  domain: 'solsticeroasters.com',
  tagline: 'Small-batch coffee, roasted to order — for your kitchen and your café.',
} as const;

// ──────────────────────────────────────────────────────────────────────────
// Phase 1 — demo-people: the org, its teams, and the 12 coworkers every
// `owner`/`assignee`/`member` id across later phases resolves against.
// ──────────────────────────────────────────────────────────────────────────

/** Marker for every entity the demo-people seeder owns (count + clear scope). */
export const DEMO_PEOPLE_ACTOR = 'demo:people';

/** Seed users carry this principal prefix so count/clear can find exactly the
 *  demo coworkers without touching a real signed-in user. `createUser` derives
 *  the userId from `(tenantId, principalId)`, so the prefix IS the marker. */
export const PERSON_PRINCIPAL_PREFIX = 'demo:people:';

// NOTE (review #1344 CRITICAL): the demo org is NEVER given a fixed id. The
// `access-orgs` store is keyed by orgId ALONE (no tenant in the key) and
// `deleteOrg` cascades by orgId alone, so a fixed per-tenant id lets one tenant's
// seed overwrite — and later delete-cascade — another tenant's org+teams+members.
// The org gets `createOrg`'s random `org-<uuid>`; ownership is marked purely by
// `createdBy === DEMO_PEOPLE_ACTOR`, and every seeder resolves it via
// `listOrgs(tenantId)[0]`. Fixed ids are ONLY for deliberately host-GLOBAL orgs
// (`host-site`, ADR 0027), never per-tenant ones.

/** Built-in RBAC roles (RFC 0049 / accessControlService `BuiltInRoleId`). */
export type SolsticeRole = 'owner' | 'admin' | 'editor' | 'viewer';

export type SolsticeTeamSlug = 'sales' | 'marketing' | 'customer-success';

export interface SolsticePerson {
  /** Stable slug — the id key other phases reference this person by. */
  slug: string;
  name: string;
  /** Local part; full address is `${email}@${SOLSTICE_BRAND.domain}`. */
  emailLocal: string;
  title: string;
  department: 'Executive' | 'Sales' | 'Marketing' | 'Customer Success' | 'Operations' | 'Finance' | 'IT';
  role: SolsticeRole;
  /** Team membership (org sub-scope). Execs/ops/finance/IT sit outside the three
   *  business teams the strategy calls for (sales/marketing/cs). */
  team?: SolsticeTeamSlug;
  bio: string;
  skills: { name: string; proficiency: 1 | 2 | 3 | 4 | 5 }[];
}

/** The 12 coworkers (app-seeding-strategy.md §4 Phase 1). Names are deliberately
 *  distinct from the ten agent personas (Ava/Felix/Cleo/Idris/Mira/Ren/Pax/
 *  Quill/Iris/Ezra) so a human never reads as an agent. The four Account
 *  Executives (Dana/Priya/Tomás/Sofia) become territory members + quota holders
 *  (Phase 6) and deal owners (Phase 3) — see {@link SOLSTICE_SALES_REPS}. */
export const SOLSTICE_PEOPLE: readonly SolsticePerson[] = [
  {
    slug: 'maya-solberg', name: 'Maya Solberg', emailLocal: 'maya',
    title: 'CEO & Founder', department: 'Executive', role: 'owner',
    bio: 'Founded Solstice Roasters in 2016 after a decade sourcing green coffee across Central America. Sets the growth strategy and keeps the roast honest.',
    skills: [{ name: 'Green coffee sourcing', proficiency: 5 }, { name: 'Company strategy', proficiency: 5 }, { name: 'Fundraising', proficiency: 4 }],
  },
  {
    slug: 'marcus-chen', name: 'Marcus Chen', emailLocal: 'marcus',
    title: 'VP of Sales', department: 'Sales', role: 'admin', team: 'sales',
    bio: 'Runs the B2B wholesale motion — cafés, hotels, and regional grocers. Owns the pipeline, the territory plan, and the quarterly number.',
    skills: [{ name: 'Wholesale sales', proficiency: 5 }, { name: 'Territory planning', proficiency: 4 }, { name: 'Forecasting', proficiency: 4 }],
  },
  {
    slug: 'dana-reyes', name: 'Dana Reyes', emailLocal: 'dana',
    title: 'Senior Account Executive', department: 'Sales', role: 'editor', team: 'sales',
    bio: 'Closes the largest hospitality accounts. Prefers a standing quarterly business review with every named account.',
    skills: [{ name: 'Enterprise sales', proficiency: 5 }, { name: 'Account management', proficiency: 4 }, { name: 'Contract negotiation', proficiency: 4 }],
  },
  {
    slug: 'priya-nair', name: 'Priya Nair', emailLocal: 'priya',
    title: 'Account Executive', department: 'Sales', role: 'editor', team: 'sales',
    bio: 'Owns the independent-café segment on the West territory. Fast to first meeting, methodical on follow-up.',
    skills: [{ name: 'Prospecting', proficiency: 5 }, { name: 'Product demos', proficiency: 4 }, { name: 'CRM hygiene', proficiency: 5 }],
  },
  {
    slug: 'tomas-okafor', name: 'Tomás Okafor', emailLocal: 'tomas',
    title: 'Account Executive', department: 'Sales', role: 'editor', team: 'sales',
    bio: 'Covers the East territory grocers and mid-market hotels. Strong on multi-location rollouts and equipment bundles.',
    skills: [{ name: 'Channel sales', proficiency: 4 }, { name: 'Solution selling', proficiency: 4 }, { name: 'Logistics', proficiency: 3 }],
  },
  {
    slug: 'sofia-lindqvist', name: 'Sofia Lindqvist', emailLocal: 'sofia',
    title: 'Wholesale Account Executive', department: 'Sales', role: 'editor', team: 'sales',
    bio: 'New-business hunter for wholesale renewals and partnerships. Keeps the equipment-financing playbook.',
    skills: [{ name: 'New business', proficiency: 4 }, { name: 'Renewals', proficiency: 4 }, { name: 'Partnerships', proficiency: 3 }],
  },
  {
    slug: 'noah-bergstrom', name: 'Noah Bergström', emailLocal: 'noah',
    title: 'Marketing Manager', department: 'Marketing', role: 'editor', team: 'marketing',
    bio: 'Owns the DTC brand, the campaign calendar, and the email program. Obsessive about the subscriber lifecycle.',
    skills: [{ name: 'Lifecycle marketing', proficiency: 5 }, { name: 'Brand', proficiency: 4 }, { name: 'Email', proficiency: 4 }],
  },
  {
    slug: 'elena-vasquez', name: 'Elena Vásquez', emailLocal: 'elena',
    title: 'Merchandiser', department: 'Marketing', role: 'editor', team: 'marketing',
    bio: 'Curates the storefront: collections, product discovery, promotions, and the recommendation surfaces. Watches the co-purchase data closely.',
    skills: [{ name: 'Merchandising', proficiency: 5 }, { name: 'Promotions', proficiency: 4 }, { name: 'Catalog', proficiency: 4 }],
  },
  {
    slug: 'jordan-kim', name: 'Jordan Kim', emailLocal: 'jordan',
    title: 'Customer Success Lead', department: 'Customer Success', role: 'editor', team: 'customer-success',
    bio: 'Keeps wholesale accounts healthy and DTC subscribers happy. Runs the renewal-risk review and the account health scorecard.',
    skills: [{ name: 'Account health', proficiency: 5 }, { name: 'Retention', proficiency: 4 }, { name: 'Support ops', proficiency: 4 }],
  },
  {
    slug: 'wren-patel', name: 'Wren Patel', emailLocal: 'wren',
    title: 'Operations Manager', department: 'Operations', role: 'admin',
    bio: 'Runs roasting schedules, inventory, and fulfillment. The person who knows exactly when the espresso blend will restock.',
    skills: [{ name: 'Inventory', proficiency: 5 }, { name: 'Fulfillment', proficiency: 4 }, { name: 'Supply planning', proficiency: 4 }],
  },
  {
    slug: 'grace-osei', name: 'Grace Osei', emailLocal: 'grace',
    title: 'Finance Manager', department: 'Finance', role: 'editor',
    bio: 'Owns revenue reporting, the month-end close, and the wholesale pricing model. Signs off on custom price lists.',
    skills: [{ name: 'Financial reporting', proficiency: 5 }, { name: 'Pricing', proficiency: 4 }, { name: 'FP&A', proficiency: 4 }],
  },
  {
    slug: 'sam-whitfield', name: 'Sam Whitfield', emailLocal: 'sam',
    title: 'IT Administrator', department: 'IT', role: 'admin',
    bio: 'Administers the workspace, integrations, and access. Keeps connections and developer keys tidy.',
    skills: [{ name: 'IT administration', proficiency: 5 }, { name: 'Integrations', proficiency: 4 }, { name: 'Access management', proficiency: 4 }],
  },
];

export interface SolsticeTeam {
  slug: SolsticeTeamSlug;
  name: string;
  description: string;
  color: string;
}

/** The three business teams the strategy calls for (sales/marketing/cs). */
export const SOLSTICE_TEAMS: readonly SolsticeTeam[] = [
  { slug: 'sales', name: 'Sales', description: 'B2B wholesale — cafés, hotels, and grocers.', color: '#b45309' },
  { slug: 'marketing', name: 'Marketing', description: 'DTC brand, campaigns, and merchandising.', color: '#7c3aed' },
  { slug: 'customer-success', name: 'Customer Success', description: 'Account health, retention, and support.', color: '#0f766e' },
];

/** The four Account Executives — territory members / quota holders (Phase 6) and
 *  the deal owners (Phase 3). Order is stable so quota + territory splits are
 *  deterministic. */
export const SOLSTICE_SALES_REPS: readonly string[] = ['dana-reyes', 'priya-nair', 'tomas-okafor', 'sofia-lindqvist'];

/** Full email for a person. */
export function solsticeEmail(person: SolsticePerson): string {
  return `${person.emailLocal}@${SOLSTICE_BRAND.domain}`;
}

/** The synthetic auth principal for a seeded person (the count/clear marker). */
export function personPrincipal(slug: string): string {
  return `${PERSON_PRINCIPAL_PREFIX}${slug}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 2 — demo-media: the media library. Self-authored, brand-consistent PNG
// assets (never SVG — image/svg+xml is upload-banned as a stored-XSS guard; see
// media/pngCanvas.ts) generated parametrically so the bundle stays a few KB.
// Commerce (Phase 4) and CMS (Phase 9) reference these by their serve token,
// resolved from the deterministic asset tag/key.
// ──────────────────────────────────────────────────────────────────────────

/** Marker for every media asset/collection the demo-media seeder owns. */
export const DEMO_MEDIA_ACTOR = 'demo:media';

/** Solstice palette — kept here so every generated asset reads as one brand. */
export const SOLSTICE_PALETTE = {
  espresso: '#3b2417',
  clay: '#b45309',
  caramel: '#d9903f',
  cream: '#f5ede1',
  teal: '#0f766e',
  sage: '#6b7f5e',
  ink: '#241812',
} as const;

const P = SOLSTICE_PALETTE;

export type MediaCollectionName = 'Product Photos' | 'Brand' | 'Blog';

export interface SolsticeMediaAsset {
  /** Deterministic key — the tag other phases resolve the serve token by. For a
   *  product photo this equals the Phase-4 product slug. */
  key: string;
  collection: MediaCollectionName;
  /** File-style display name (unique within the library). */
  name: string;
  alt: string;
  /** Declarative draw spec — rendered to PNG bytes at seed time (never SVG: the
   *  upload allowlist blocks image/svg+xml as a stored-XSS guard). */
  spec: MediaSpec;
}

/** Product-photo keys = the Phase-4 catalog product slugs. Phase 4 defines the
 *  full products under THESE slugs and resolves each product's image by key, so
 *  the two phases stay in lockstep without importing each other's internals. */
export const PRODUCT_PHOTO_KEYS = [
  'ethiopia-yirgacheffe', 'colombia-huila', 'guatemala-antigua', 'sumatra-mandheling',
  'house-blend', 'espresso-blend', 'french-roast', 'breakfast-blend', 'decaf-colombia',
  'holiday-blend', 'cold-brew-concentrate', 'single-origin-sampler',
  'gift-set-classic', 'mix-and-match-sampler', 'office-blend-wholesale', 'green-beans-wholesale',
  'ceramic-mug', 'pour-over-kit', 'burr-grinder', 'travel-tumbler',
  'subscription-box', 'cold-brew-bottle', 'roasters-choice', 'nitro-cold-brew',
] as const;

/** Tinted product backgrounds (warm ramp). Tint + accent derive from a stable
 *  hash of the key (not module-level mutable state), so the manifest's colors
 *  don't depend on declaration order (review #1348 LOW). */
const TINTS = ['#f5ede1', '#efe4d2', '#e8dcc8', '#f0e7d6', '#eadfce', '#f2e8d8'];
function keyHash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}
const product = (key: string, name: string, silhouette: Silhouette): SolsticeMediaAsset => {
  const h = keyHash(key);
  const hue = TINTS[h % TINTS.length]!;
  const accent = h % 2 ? P.clay : P.teal;
  return { key, collection: 'Product Photos', name: `${name}.png`, alt: `${name} — Solstice Roasters product photo`, spec: { kind: 'product', silhouette, hue, accent } };
};
const brand = (key: string, name: string, variant: 'mark' | 'wordmark' | 'pattern'): SolsticeMediaAsset => ({
  key, collection: 'Brand', name: `${name}.png`, alt: `Solstice Roasters ${name}`, spec: { kind: 'brand', variant },
});
const blog = (key: string, name: string, alt: string, hue: string): SolsticeMediaAsset => ({
  key, collection: 'Blog', name: `${name}.png`, alt, spec: { kind: 'blog', hue },
});

/** The full media manifest (34 assets across three collections). */
export const SOLSTICE_MEDIA: readonly SolsticeMediaAsset[] = [
  // Product Photos — one per Phase-4 catalog product (keys === product slugs).
  product('ethiopia-yirgacheffe', 'Ethiopia Yirgacheffe', 'bag'),
  product('colombia-huila', 'Colombia Huila', 'bag'),
  product('guatemala-antigua', 'Guatemala Antigua', 'bag'),
  product('sumatra-mandheling', 'Sumatra Mandheling', 'bag'),
  product('house-blend', 'Solstice House Blend', 'bag'),
  product('espresso-blend', 'Solstice Espresso Blend', 'bag'),
  product('french-roast', 'French Roast', 'bag'),
  product('breakfast-blend', 'Breakfast Blend', 'bag'),
  product('decaf-colombia', 'Decaf Colombia', 'bag'),
  product('holiday-blend', 'Winter Solstice Blend', 'bag'),
  product('office-blend-wholesale', 'Office Blend (Wholesale)', 'bag'),
  product('roasters-choice', "Roaster's Choice", 'bag'),
  product('cold-brew-concentrate', 'Cold Brew Concentrate', 'bottle'),
  product('cold-brew-bottle', 'Cold Brew Bottle', 'bottle'),
  product('nitro-cold-brew', 'Nitro Cold Brew', 'cup'),
  product('single-origin-sampler', 'Single-Origin Sampler', 'grid'),
  product('mix-and-match-sampler', 'Mix-and-Match Sampler', 'grid'),
  product('gift-set-classic', 'Classic Gift Set', 'box'),
  product('subscription-box', 'Coffee Subscription', 'box'),
  product('green-beans-wholesale', 'Green Beans (Wholesale)', 'beans'),
  product('ceramic-mug', 'Solstice Ceramic Mug', 'mug'),
  product('travel-tumbler', 'Travel Tumbler', 'cup'),
  product('pour-over-kit', 'Pour-Over Kit', 'cup'),
  product('burr-grinder', 'Burr Grinder', 'grinder'),
  // Brand.
  brand('brand-mark', 'Sun Mark', 'mark'),
  brand('brand-wordmark', 'Wordmark', 'wordmark'),
  brand('brand-pattern', 'Coffee Pattern', 'pattern'),
  brand('brand-hero', 'Storefront Hero', 'wordmark'),
  brand('brand-social-avatar', 'Social Avatar', 'mark'),
  brand('brand-email-header', 'Email Header', 'wordmark'),
  // Blog.
  blog('blog-pour-over', 'Pour-Over Basics', 'The perfect pour-over, step by step', P.clay),
  blog('blog-origins', 'Sourcing Ethiopia', 'A week at origin in Yirgacheffe', P.teal),
  blog('blog-subscription', 'Why Subscribe', 'Fresh beans, delivered on your schedule', P.sage),
  blog('blog-wholesale', 'Wholesale Partners', 'Bringing Solstice to your café', P.espresso),
  blog('blog-cold-brew', 'Cold Brew at Home', 'Slow-steeped, smooth, and simple', P.caramel),
];

/** The industry string stamped on marketing-faceted demo assets. Matches the
 *  campaign showcase brief's `industryVertical` EXACTLY (facet matching in
 *  `selectAssets` is normalized-equality), so campaign-driven selection scores
 *  the industry dimension on demo data. */
export const SOLSTICE_MEDIA_INDUSTRY = 'Specialty coffee / DTC subscription';

/** ADR 0352 marketing facet stamped at seed time (SEED-3, DATA-ASSESSMENT
 *  campaign-studio-parity) — `personaIds` are deliberately ABSENT here: persona
 *  ids only exist at runtime, so the campaign showcase seeder stamps them after
 *  it creates its personas (see `campaignShowcaseSeed.ts`). */
export interface SolsticeMediaMarketing {
  product?: string;
  sku?: string;
  angle?: string;
  background?: string;
  industry?: string;
  useCase?: string;
  palette?: string[];
}

const productMkt = (name: string, key: string, useCase: string, angle = 'front'): SolsticeMediaMarketing => ({
  product: name, sku: key, angle, background: 'warm studio tint',
  industry: SOLSTICE_MEDIA_INDUSTRY, useCase, palette: [P.cream, P.espresso, P.clay],
});

/** Marketing facets for the campaign-relevant subset of {@link SOLSTICE_MEDIA}
 *  (11 of 34 — the assets the showcase campaign's selection criteria should
 *  find; the rest stay honestly untagged so the fallback chain still demos). */
export const SOLSTICE_MEDIA_MARKETING: Readonly<Record<string, SolsticeMediaMarketing>> = {
  // `product` matches the Phase-4 catalog display name; `subscription-box`
  // matches the showcase brief's productName ('Solstice Subscription').
  'ethiopia-yirgacheffe': productMkt('Ethiopia Yirgacheffe', 'ethiopia-yirgacheffe', 'product-launch'),
  'colombia-huila': productMkt('Colombia Huila', 'colombia-huila', 'product-launch'),
  'single-origin-sampler': productMkt('Single-Origin Sampler', 'single-origin-sampler', 'subscription-promo', 'flat-lay'),
  'subscription-box': productMkt('Solstice Subscription', 'subscription-box', 'subscription-promo', 'three-quarter'),
  'pour-over-kit': productMkt('Pour-Over Kit', 'pour-over-kit', 'how-to-content', 'three-quarter'),
  'burr-grinder': productMkt('Burr Grinder', 'burr-grinder', 'how-to-content'),
  'office-blend-wholesale': productMkt('Office Blend (Wholesale)', 'office-blend-wholesale', 'wholesale-outreach'),
  'green-beans-wholesale': productMkt('Green Beans (Wholesale)', 'green-beans-wholesale', 'wholesale-outreach'),
  'blog-pour-over': { angle: 'illustration', industry: SOLSTICE_MEDIA_INDUSTRY, useCase: 'how-to-content', palette: [P.clay, P.cream] },
  'blog-subscription': { angle: 'illustration', industry: SOLSTICE_MEDIA_INDUSTRY, useCase: 'subscription-promo', palette: [P.sage, P.cream] },
  'blog-wholesale': { angle: 'illustration', industry: SOLSTICE_MEDIA_INDUSTRY, useCase: 'wholesale-outreach', palette: [P.espresso, P.cream] },
};

// ──────────────────────────────────────────────────────────────────────────
// Phase 3 — demo-crm: the B2B anchor. Companies (cafés / hotels / grocers) that
// buy the same catalog commerce sells, the deal pipelines the sales org works,
// and the contacts CDP resolves + territories carve. All ids derive from stable
// slugs so seed is idempotent and clear is surgical.
// ──────────────────────────────────────────────────────────────────────────

/** Marker stamped on createdBy for demo-crm rows that carry one (companies,
 *  deals, tasks, activities, segments, field defs). Contacts have no createdBy —
 *  they are scoped by the `crm:demo-crm-` id prefix instead. */
export const DEMO_CRM_ACTOR = 'demo:crm';

export type CrmRegion = 'West' | 'East';
export type CrmIndustry = 'Hospitality' | 'Food & Beverage' | 'Grocery';
export type CrmTier = 'enterprise' | 'mid-market' | 'small';

export interface SolsticeCompany {
  slug: string;
  name: string;
  domain: string;
  industry: CrmIndustry;
  region: CrmRegion;
  tier: CrmTier;
  hqCity: string;
  employees: number;
  tags: string[];
}

/** 15 B2B accounts — the wholesale market territories carve and CSM tracks. */
export const SOLSTICE_COMPANIES: readonly SolsticeCompany[] = [
  { slug: 'harborview-hotels', name: 'Harborview Hotels', domain: 'harborviewhotels.com', industry: 'Hospitality', region: 'West', tier: 'enterprise', hqCity: 'Seattle, WA', employees: 1200, tags: ['hotel', 'key-account'] },
  { slug: 'summit-lodges', name: 'Summit Lodges', domain: 'summitlodges.com', industry: 'Hospitality', region: 'West', tier: 'mid-market', hqCity: 'Denver, CO', employees: 340, tags: ['hotel', 'resort'] },
  { slug: 'grandview-suites', name: 'Grandview Suites', domain: 'grandviewsuites.com', industry: 'Hospitality', region: 'East', tier: 'enterprise', hqCity: 'Boston, MA', employees: 900, tags: ['hotel', 'key-account'] },
  { slug: 'riverside-inns', name: 'Riverside Inns', domain: 'riversideinns.com', industry: 'Hospitality', region: 'East', tier: 'mid-market', hqCity: 'Savannah, GA', employees: 210, tags: ['hotel'] },
  { slug: 'morning-ritual-cafe', name: 'Morning Ritual Café', domain: 'morningritual.coffee', industry: 'Food & Beverage', region: 'West', tier: 'small', hqCity: 'Portland, OR', employees: 24, tags: ['cafe', 'independent'] },
  { slug: 'corner-cup-coffee', name: 'Corner Cup Coffee', domain: 'cornercup.coffee', industry: 'Food & Beverage', region: 'West', tier: 'small', hqCity: 'San Diego, CA', employees: 18, tags: ['cafe', 'independent'] },
  { slug: 'daily-grind-co', name: 'The Daily Grind Co.', domain: 'dailygrind.co', industry: 'Food & Beverage', region: 'East', tier: 'mid-market', hqCity: 'Brooklyn, NY', employees: 120, tags: ['cafe', 'chain'] },
  { slug: 'fika-house', name: 'Fika House', domain: 'fikahouse.cafe', industry: 'Food & Beverage', region: 'East', tier: 'small', hqCity: 'Providence, RI', employees: 15, tags: ['cafe', 'independent'] },
  { slug: 'sunbeam-roastery-bar', name: 'Sunbeam Roastery Bar', domain: 'sunbeambar.coffee', industry: 'Food & Beverage', region: 'West', tier: 'mid-market', hqCity: 'Oakland, CA', employees: 65, tags: ['cafe', 'roaster'] },
  { slug: 'terrace-cafe-group', name: 'Terrace Café Group', domain: 'terracecafes.com', industry: 'Food & Beverage', region: 'East', tier: 'mid-market', hqCity: 'Philadelphia, PA', employees: 140, tags: ['cafe', 'chain'] },
  { slug: 'greenleaf-markets', name: 'Greenleaf Markets', domain: 'greenleafmarkets.com', industry: 'Grocery', region: 'West', tier: 'enterprise', hqCity: 'Los Angeles, CA', employees: 3400, tags: ['grocery', 'key-account'] },
  { slug: 'harvest-grocers', name: 'Harvest Grocers', domain: 'harvestgrocers.com', industry: 'Grocery', region: 'East', tier: 'enterprise', hqCity: 'Atlanta, GA', employees: 2800, tags: ['grocery', 'key-account'] },
  { slug: 'cornerstone-provisions', name: 'Cornerstone Provisions', domain: 'cornerstoneprovisions.com', industry: 'Grocery', region: 'West', tier: 'mid-market', hqCity: 'Phoenix, AZ', employees: 480, tags: ['grocery'] },
  { slug: 'meadowlark-foods', name: 'Meadowlark Foods', domain: 'meadowlarkfoods.com', industry: 'Grocery', region: 'East', tier: 'mid-market', hqCity: 'Columbus, OH', employees: 520, tags: ['grocery'] },
  { slug: 'urban-pantry-coop', name: 'Urban Pantry Co-op', domain: 'urbanpantry.coop', industry: 'Grocery', region: 'West', tier: 'small', hqCity: 'Austin, TX', employees: 36, tags: ['grocery', 'co-op'] },
];

/** Contact-name pools — deterministic per global index, distinct from the 12
 *  coworker names and the ten agent personas. */
export const CRM_FIRST_NAMES = ['Alex', 'Bianca', 'Carlos', 'Dario', 'Emiko', 'Farah', 'Gabriel', 'Hana', 'Ivan', 'Julia', 'Kwame', 'Lena', 'Mateo', 'Nadia', 'Omar', 'Rosa'];
export const CRM_LAST_NAMES = ['Alvarez', 'Bennett', 'Cho', 'Delgado', 'Ellis', 'Fontaine', 'Ghosh', 'Hughes', 'Ibarra', 'Jansen', 'Kaur', 'Lombardi', 'Moreno', 'Novak', 'Ortega', 'Park'];
export const CRM_TITLES = ['Owner', 'General Manager', 'Head of Coffee', 'Beverage Director', 'Procurement Manager', 'Purchasing Lead', 'Café Manager', 'F&B Director', 'Operations Lead', 'Buyer'];

export interface CrmPipelineDef {
  key: 'new-business' | 'wholesale-renewals' | 'partnerships' | 'equipment';
  name: string;
  stages: { name: string; probability: number }[];
}

/** 4 pipelines with probability-weighted stages — quota attainment (Phase 6) is
 *  Σ deal amount × stage probability, so the weights are deliberate. */
export const SOLSTICE_PIPELINES: readonly CrmPipelineDef[] = [
  { key: 'new-business', name: 'New Business', stages: [{ name: 'Lead', probability: 10 }, { name: 'Qualified', probability: 30 }, { name: 'Proposal', probability: 55 }, { name: 'Negotiation', probability: 80 }, { name: 'Closed Won', probability: 100 }, { name: 'Closed Lost', probability: 0 }] },
  { key: 'wholesale-renewals', name: 'Wholesale Renewals', stages: [{ name: 'Upcoming', probability: 20 }, { name: 'In Discussion', probability: 50 }, { name: 'Contract Sent', probability: 75 }, { name: 'Renewed', probability: 100 }, { name: 'Churned', probability: 0 }] },
  { key: 'partnerships', name: 'Partnerships', stages: [{ name: 'Exploratory', probability: 15 }, { name: 'Aligned', probability: 40 }, { name: 'Piloting', probability: 65 }, { name: 'Signed', probability: 100 }, { name: 'Passed', probability: 0 }] },
  { key: 'equipment', name: 'Equipment', stages: [{ name: 'Requested', probability: 20 }, { name: 'Quoted', probability: 50 }, { name: 'Approved', probability: 80 }, { name: 'Delivered', probability: 100 }, { name: 'Cancelled', probability: 0 }] },
];

export interface CrmDealDef {
  slug: string;
  title: string;
  company: string;        // company slug
  pipeline: CrmPipelineDef['key'];
  stageIndex: number;     // index into that pipeline's stages
  amount: number;
  status: 'open' | 'won' | 'lost';
  rep: string;            // rep slug (SOLSTICE_SALES_REPS)
  /** Close date offset in days from seed time (negative = past, positive = future). */
  closeOffsetDays: number;
}

/** 30 deals across the four pipelines, $2k–$80k, close dates ±90d. */
export const SOLSTICE_DEALS: readonly CrmDealDef[] = [
  { slug: 'harborview-nb', title: 'Harborview Hotels — house coffee program', company: 'harborview-hotels', pipeline: 'new-business', stageIndex: 3, amount: 78000, status: 'open', rep: 'dana-reyes', closeOffsetDays: 24 },
  { slug: 'grandview-nb', title: 'Grandview Suites — in-room coffee', company: 'grandview-suites', pipeline: 'new-business', stageIndex: 2, amount: 54000, status: 'open', rep: 'tomas-okafor', closeOffsetDays: 40 },
  { slug: 'greenleaf-nb', title: 'Greenleaf Markets — private-label beans', company: 'greenleaf-markets', pipeline: 'new-business', stageIndex: 4, amount: 62000, status: 'won', rep: 'dana-reyes', closeOffsetDays: -18 },
  { slug: 'harvest-nb', title: 'Harvest Grocers — shelf placement', company: 'harvest-grocers', pipeline: 'new-business', stageIndex: 3, amount: 48000, status: 'open', rep: 'tomas-okafor', closeOffsetDays: 33 },
  { slug: 'daily-grind-nb', title: 'The Daily Grind — multi-location supply', company: 'daily-grind-co', pipeline: 'new-business', stageIndex: 1, amount: 22000, status: 'open', rep: 'sofia-lindqvist', closeOffsetDays: 61 },
  { slug: 'terrace-nb', title: 'Terrace Café Group — espresso program', company: 'terrace-cafe-group', pipeline: 'new-business', stageIndex: 2, amount: 26500, status: 'open', rep: 'sofia-lindqvist', closeOffsetDays: 52 },
  { slug: 'sunbeam-nb', title: 'Sunbeam Roastery — wholesale beans', company: 'sunbeam-roastery-bar', pipeline: 'new-business', stageIndex: 5, amount: 14000, status: 'lost', rep: 'priya-nair', closeOffsetDays: -9 },
  { slug: 'morning-ritual-nb', title: 'Morning Ritual — house blend', company: 'morning-ritual-cafe', pipeline: 'new-business', stageIndex: 4, amount: 8200, status: 'won', rep: 'priya-nair', closeOffsetDays: -30 },
  { slug: 'corner-cup-nb', title: 'Corner Cup — single-origin rotation', company: 'corner-cup-coffee', pipeline: 'new-business', stageIndex: 1, amount: 6400, status: 'open', rep: 'priya-nair', closeOffsetDays: 45 },
  { slug: 'cornerstone-nb', title: 'Cornerstone Provisions — bulk coffee', company: 'cornerstone-provisions', pipeline: 'new-business', stageIndex: 0, amount: 19500, status: 'open', rep: 'tomas-okafor', closeOffsetDays: 78 },
  { slug: 'harborview-ren', title: 'Harborview Hotels — annual renewal', company: 'harborview-hotels', pipeline: 'wholesale-renewals', stageIndex: 3, amount: 72000, status: 'won', rep: 'dana-reyes', closeOffsetDays: -6 },
  { slug: 'greenleaf-ren', title: 'Greenleaf Markets — renewal', company: 'greenleaf-markets', pipeline: 'wholesale-renewals', stageIndex: 2, amount: 60000, status: 'open', rep: 'dana-reyes', closeOffsetDays: 20 },
  { slug: 'harvest-ren', title: 'Harvest Grocers — renewal', company: 'harvest-grocers', pipeline: 'wholesale-renewals', stageIndex: 1, amount: 45000, status: 'open', rep: 'tomas-okafor', closeOffsetDays: 55 },
  { slug: 'summit-ren', title: 'Summit Lodges — seasonal renewal', company: 'summit-lodges', pipeline: 'wholesale-renewals', stageIndex: 4, amount: 16000, status: 'lost', rep: 'sofia-lindqvist', closeOffsetDays: -14 },
  { slug: 'daily-grind-ren', title: 'The Daily Grind — renewal', company: 'daily-grind-co', pipeline: 'wholesale-renewals', stageIndex: 3, amount: 28000, status: 'won', rep: 'sofia-lindqvist', closeOffsetDays: -3 },
  { slug: 'riverside-ren', title: 'Riverside Inns — renewal', company: 'riverside-inns', pipeline: 'wholesale-renewals', stageIndex: 0, amount: 13500, status: 'open', rep: 'tomas-okafor', closeOffsetDays: 70 },
  { slug: 'meadowlark-ren', title: 'Meadowlark Foods — renewal', company: 'meadowlark-foods', pipeline: 'wholesale-renewals', stageIndex: 2, amount: 24000, status: 'open', rep: 'sofia-lindqvist', closeOffsetDays: 31 },
  { slug: 'greenleaf-part', title: 'Greenleaf Markets — co-brand partnership', company: 'greenleaf-markets', pipeline: 'partnerships', stageIndex: 2, amount: 40000, status: 'open', rep: 'dana-reyes', closeOffsetDays: 48 },
  { slug: 'harborview-part', title: 'Harborview Hotels — loyalty partnership', company: 'harborview-hotels', pipeline: 'partnerships', stageIndex: 1, amount: 35000, status: 'open', rep: 'dana-reyes', closeOffsetDays: 66 },
  { slug: 'sunbeam-part', title: 'Sunbeam Roastery — training partnership', company: 'sunbeam-roastery-bar', pipeline: 'partnerships', stageIndex: 3, amount: 12000, status: 'won', rep: 'priya-nair', closeOffsetDays: -22 },
  { slug: 'fika-part', title: 'Fika House — pop-up partnership', company: 'fika-house', pipeline: 'partnerships', stageIndex: 0, amount: 4500, status: 'open', rep: 'sofia-lindqvist', closeOffsetDays: 58 },
  { slug: 'urban-pantry-part', title: 'Urban Pantry — community partnership', company: 'urban-pantry-coop', pipeline: 'partnerships', stageIndex: 4, amount: 3000, status: 'lost', rep: 'priya-nair', closeOffsetDays: -12 },
  { slug: 'harborview-equip', title: 'Harborview Hotels — espresso machines', company: 'harborview-hotels', pipeline: 'equipment', stageIndex: 2, amount: 52000, status: 'open', rep: 'dana-reyes', closeOffsetDays: 27 },
  { slug: 'daily-grind-equip', title: 'The Daily Grind — grinders rollout', company: 'daily-grind-co', pipeline: 'equipment', stageIndex: 3, amount: 31000, status: 'won', rep: 'sofia-lindqvist', closeOffsetDays: -8 },
  { slug: 'terrace-equip', title: 'Terrace Café Group — brew bar', company: 'terrace-cafe-group', pipeline: 'equipment', stageIndex: 1, amount: 18500, status: 'open', rep: 'sofia-lindqvist', closeOffsetDays: 44 },
  { slug: 'summit-equip', title: 'Summit Lodges — lobby machines', company: 'summit-lodges', pipeline: 'equipment', stageIndex: 2, amount: 21000, status: 'open', rep: 'priya-nair', closeOffsetDays: 36 },
  { slug: 'grandview-equip', title: 'Grandview Suites — banquet urns', company: 'grandview-suites', pipeline: 'equipment', stageIndex: 0, amount: 15000, status: 'open', rep: 'tomas-okafor', closeOffsetDays: 74 },
  { slug: 'greenleaf-equip', title: 'Greenleaf Markets — sampling stations', company: 'greenleaf-markets', pipeline: 'equipment', stageIndex: 4, amount: 9500, status: 'lost', rep: 'dana-reyes', closeOffsetDays: -25 },
  { slug: 'morning-ritual-equip', title: 'Morning Ritual — pour-over bar', company: 'morning-ritual-cafe', pipeline: 'equipment', stageIndex: 3, amount: 5200, status: 'won', rep: 'priya-nair', closeOffsetDays: -16 },
  { slug: 'cornerstone-equip', title: 'Cornerstone Provisions — cold-brew kegs', company: 'cornerstone-provisions', pipeline: 'equipment', stageIndex: 1, amount: 11000, status: 'open', rep: 'tomas-okafor', closeOffsetDays: 63 },
];

export interface CrmFieldDefDef {
  entity: 'contact' | 'deal';
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  options?: string[];
}

/** 4 custom field defs — three on contacts (used by segments + territory rules),
 *  one on deals. */
// NOTE: keys are lowercase — the field-def service normalizes keys to lowercase,
// so authoring them lowercase keeps the seeder idempotent (re-seed's dup guard
// matches the stored key). Contact `customFields` use the SAME keys so segments
// filter on them directly.
export const SOLSTICE_FIELD_DEFS: readonly CrmFieldDefDef[] = [
  { entity: 'contact', key: 'industry', label: 'Industry', type: 'enum', options: ['Hospitality', 'Food & Beverage', 'Grocery'] },
  { entity: 'contact', key: 'region', label: 'Region', type: 'enum', options: ['West', 'East'] },
  { entity: 'contact', key: 'tier', label: 'Account Tier', type: 'enum', options: ['enterprise', 'mid-market', 'small'] },
  { entity: 'deal', key: 'dealsource', label: 'Deal Source', type: 'enum', options: ['inbound', 'outbound', 'referral', 'renewal'] },
];

export interface CrmSegmentDef {
  slug: string;
  name: string;
  filters: { field: string; op: string; value?: string }[];
}

/** 6 segments with deliberately overlapping membership (CDP-C overlap demo). */
export const SOLSTICE_SEGMENTS: readonly CrmSegmentDef[] = [
  { slug: 'hotel-buyers', name: 'Hotel buyers', filters: [{ field: 'customFields.industry', op: 'eq', value: 'Hospitality' }] },
  { slug: 'cafe-accounts', name: 'Café accounts', filters: [{ field: 'customFields.industry', op: 'eq', value: 'Food & Beverage' }] },
  { slug: 'grocery-retail', name: 'Grocery & retail', filters: [{ field: 'customFields.industry', op: 'eq', value: 'Grocery' }] },
  { slug: 'west-territory', name: 'West territory', filters: [{ field: 'customFields.region', op: 'eq', value: 'West' }] },
  { slug: 'high-value-wholesale', name: 'High-value wholesale', filters: [{ field: 'customFields.tier', op: 'eq', value: 'enterprise' }] },
  { slug: 'churn-risk', name: 'Churn-risk', filters: [{ field: 'stage', op: 'eq', value: 'churned' }] },
];

/** Deterministic contact name for a global index. */
export function crmContactName(i: number): string {
  return `${CRM_FIRST_NAMES[i % CRM_FIRST_NAMES.length]!} ${CRM_LAST_NAMES[(i * 7 + 3) % CRM_LAST_NAMES.length]!}`;
}

// ── Tenant-scoped CRM entity ids ─────────────────────────────────────────────
// crm:company / crm:contact / crm:deal / crm:segment are keyed by their id ALONE
// (tenant is only the secondary index — DurableCollection's primary kv key is
// global). A FIXED per-tenant id therefore collides across tenants: the second
// tenant to seed demo-crm hits createCompany's cross-tenant guard and throws
// (review #1356 follow-up; same mechanic as #1344/#1363). These helpers fold a
// short tenant hash into every id so it is globally unique yet deterministic,
// keeping the seed idempotent and the `<prefix>:demo-crm-` count/clear filters
// matching. EVERY seeder that references a demo CRM entity MUST use these so the
// ids stay in lockstep across phases.
export function demoCrmTid(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 10);
}
export const demoCrmCompanyId = (tenantId: string, slug: string): string => `cmp:demo-crm-${demoCrmTid(tenantId)}-${slug}`;
export const demoCrmContactId = (tenantId: string, companySlug: string, k: number | string): string => `crm:demo-crm-${demoCrmTid(tenantId)}-${companySlug}-${k}`;
export const demoCrmDealId = (tenantId: string, slug: string): string => `deal:demo-crm-${demoCrmTid(tenantId)}-${slug}`;
export const demoCrmSegmentId = (tenantId: string, slug: string): string => `seg:demo-crm-${demoCrmTid(tenantId)}-${slug}`;
// ──────────────────────────────────────────────────────────────────────────
// Phase 4 — demo-commerce-depth: catalog depth on top of commerce-showcase, all
// under distinct canonical ids (marker `demo:commerce-depth`). Product slugs ===
// PRODUCT_PHOTO_KEYS so Phase-2 images wire up. B2B accounts (CRM companies) buy
// the same catalog: price lists per company, orders linked to CRM contacts.
// ──────────────────────────────────────────────────────────────────────────

export const DEMO_COMMERCE_ACTOR = 'demo:commerce-depth';

export type CoffeeRoast = 'light' | 'medium' | 'medium-dark' | 'dark';
export type CatalogCategory = 'Single Origin' | 'Blends' | 'Cold Brew' | 'Equipment' | 'Gifts & Bundles' | 'Wholesale';

export interface CatalogProduct {
  slug: string;            // === media key === Phase-4 product slug
  name: string;
  category: CatalogCategory;
  price: number;
  inventory: number;
  lowStock?: boolean;      // seed inventory below threshold (alert surface)
  /** Facetable typed fields (product-fielddef values). */
  roast?: CoffeeRoast;
  origin?: string;
  format?: 'whole-bean' | 'ground' | 'concentrate' | 'n/a';
  /** Coffee products get whole-bean / ground / 2 lb variants. */
  coffee?: boolean;
  /** Subscribe-and-save config. */
  sub?: { intervals: ('weekly' | 'monthly' | 'quarterly')[]; savePercent: number };
  /** Fixed bundle components (product slugs) — no mix-and-match primitive exists
   *  in commerce, so a "sampler" is modeled as a fixed component list. */
  bundleOf?: { slug: string; quantity: number }[];
  description: string;
}

const coffee = (slug: string, name: string, category: CatalogCategory, price: number, roast: CoffeeRoast, origin: string, inventory: number, extra?: Partial<CatalogProduct>): CatalogProduct => ({
  slug, name, category, price, inventory, roast, origin, format: 'whole-bean', coffee: true,
  description: `${origin} · ${roast} roast. Roasted to order in small batches.`, ...extra,
});

/** 24 products across 6 categories (slugs === PRODUCT_PHOTO_KEYS). */
export const SOLSTICE_CATALOG: readonly CatalogProduct[] = [
  coffee('ethiopia-yirgacheffe', 'Ethiopia Yirgacheffe', 'Single Origin', 19, 'light', 'Ethiopia', 90),
  coffee('colombia-huila', 'Colombia Huila', 'Single Origin', 18, 'medium', 'Colombia', 110),
  coffee('guatemala-antigua', 'Guatemala Antigua', 'Single Origin', 18, 'medium', 'Guatemala', 80),
  coffee('sumatra-mandheling', 'Sumatra Mandheling', 'Single Origin', 20, 'dark', 'Indonesia', 70),
  coffee('house-blend', 'Solstice House Blend', 'Blends', 16, 'medium', 'Blend', 140, { sub: { intervals: ['weekly', 'monthly'], savePercent: 10 } }),
  coffee('espresso-blend', 'Solstice Espresso Blend', 'Blends', 21, 'dark', 'Blend', 60, { sub: { intervals: ['monthly'], savePercent: 15 } }),
  coffee('french-roast', 'French Roast', 'Blends', 17, 'dark', 'Blend', 95),
  coffee('breakfast-blend', 'Breakfast Blend', 'Blends', 16, 'light', 'Blend', 120),
  coffee('decaf-colombia', 'Decaf Colombia', 'Blends', 18, 'medium', 'Colombia', 60),
  coffee('holiday-blend', 'Winter Solstice Blend', 'Blends', 19, 'medium-dark', 'Blend', 8, { lowStock: true }),
  coffee('roasters-choice', "Roaster's Choice", 'Single Origin', 22, 'medium', 'Rotating', 50),
  { slug: 'cold-brew-concentrate', name: 'Cold Brew Concentrate', category: 'Cold Brew', price: 14, inventory: 65, format: 'concentrate', description: 'Slow-steeped 18 hours. Just add water or milk.' },
  { slug: 'cold-brew-bottle', name: 'Cold Brew Bottle (12 oz)', category: 'Cold Brew', price: 5, inventory: 200, format: 'concentrate', description: 'Ready-to-drink single-serve cold brew.' },
  { slug: 'nitro-cold-brew', name: 'Nitro Cold Brew (4-pack)', category: 'Cold Brew', price: 18, inventory: 7, lowStock: true, format: 'concentrate', description: 'Nitrogen-infused, silky and smooth.' },
  { slug: 'ceramic-mug', name: 'Solstice Ceramic Mug', category: 'Equipment', price: 18, inventory: 150, format: 'n/a', description: 'Stoneware mug, 12 oz, sun mark glaze.' },
  { slug: 'pour-over-kit', name: 'Pour-Over Kit', category: 'Equipment', price: 42, inventory: 45, format: 'n/a', description: 'Dripper, carafe, and filters — everything for a clean cup.' },
  { slug: 'burr-grinder', name: 'Burr Grinder', category: 'Equipment', price: 89, inventory: 30, format: 'n/a', description: 'Conical burr grinder, 15 settings.' },
  { slug: 'travel-tumbler', name: 'Travel Tumbler', category: 'Equipment', price: 28, inventory: 110, format: 'n/a', description: 'Vacuum-insulated, leak-proof, 16 oz.' },
  { slug: 'green-beans-wholesale', name: 'Green Beans (Wholesale, 25 lb)', category: 'Wholesale', price: 165, inventory: 40, format: 'whole-bean', description: 'Unroasted green coffee for wholesale roasters. 25 lb sack.' },
  { slug: 'office-blend-wholesale', name: 'Office Blend (Wholesale, 5 lb)', category: 'Wholesale', price: 68, inventory: 55, roast: 'medium', origin: 'Blend', format: 'whole-bean', description: 'Crowd-pleasing medium roast for offices and cafés. 5 lb.' },
  { slug: 'subscription-box', name: 'Coffee Subscription Box', category: 'Gifts & Bundles', price: 24, inventory: 999, format: 'whole-bean', sub: { intervals: ['weekly', 'monthly', 'quarterly'], savePercent: 12 }, description: "A rotating bag of the roaster's pick, delivered on your schedule." },
  { slug: 'gift-set-classic', name: 'Classic Gift Set', category: 'Gifts & Bundles', price: 38, inventory: 60, format: 'n/a', bundleOf: [{ slug: 'house-blend', quantity: 1 }, { slug: 'ceramic-mug', quantity: 1 }], description: 'Our house blend + a Solstice mug, gift-boxed.' },
  { slug: 'single-origin-sampler', name: 'Single-Origin Sampler', category: 'Gifts & Bundles', price: 30, inventory: 75, format: 'whole-bean', bundleOf: [{ slug: 'ethiopia-yirgacheffe', quantity: 1 }, { slug: 'colombia-huila', quantity: 1 }, { slug: 'sumatra-mandheling', quantity: 1 }], description: 'Three 6 oz single origins to taste side by side.' },
  { slug: 'mix-and-match-sampler', name: 'Mix-and-Match Sampler', category: 'Gifts & Bundles', price: 32, inventory: 80, format: 'whole-bean', bundleOf: [{ slug: 'house-blend', quantity: 1 }, { slug: 'guatemala-antigua', quantity: 1 }, { slug: 'french-roast', quantity: 1 }], description: 'Build-your-own three-bag sampler (curated pick shown).' },
];

/** Product field defs (typed facet fields). Values live in each product's
 *  customFields; categories/tags carry browse facets. */
export const SOLSTICE_PRODUCT_FIELD_DEFS: readonly { key: string; label: string; type: 'string' | 'enum'; options?: string[] }[] = [
  { key: 'roast', label: 'Roast', type: 'enum', options: ['light', 'medium', 'medium-dark', 'dark'] },
  { key: 'origin', label: 'Origin', type: 'string' },
  { key: 'format', label: 'Format', type: 'enum', options: ['whole-bean', 'ground', 'concentrate', 'n/a'] },
];

export interface DemoPriceList {
  slug: string;
  name: string;
  companySlug: string;    // demo-crm company this wholesale list serves
  savePercent: number;    // discount off list for the entries
  productSlugs: string[];
}

/** 3 per-company wholesale price lists. */
export const SOLSTICE_PRICE_LISTS: readonly DemoPriceList[] = [
  { slug: 'harborview', name: 'Harborview Hotels — Wholesale', companySlug: 'harborview-hotels', savePercent: 20, productSlugs: ['house-blend', 'espresso-blend', 'office-blend-wholesale', 'green-beans-wholesale'] },
  { slug: 'greenleaf', name: 'Greenleaf Markets — Wholesale', companySlug: 'greenleaf-markets', savePercent: 25, productSlugs: ['house-blend', 'french-roast', 'office-blend-wholesale', 'cold-brew-concentrate'] },
  { slug: 'harvest', name: 'Harvest Grocers — Wholesale', companySlug: 'harvest-grocers', savePercent: 22, productSlugs: ['house-blend', 'breakfast-blend', 'office-blend-wholesale', 'green-beans-wholesale'] },
];

// Codes are NAMESPACED `SOLSTICE-*` (review #1357 HIGH/MEDIUM): coupons/affiliates
// carry no createdBy, so clear() removes them by code — a namespace keeps that
// delete from ever hitting a user's or operator's own coupon/affiliate code.
// R2 CM-P2-M2 — a `fixed` coupon states the currency its value is in (the catalog is
// seeded 'USD'); a percentage/free-shipping one is currency-free by nature.
export const SOLSTICE_COUPONS: readonly { code: string; type: 'percentage' | 'fixed' | 'free_shipping'; value: number; currency?: string }[] = [
  { code: 'SOLSTICE-WELCOME20', type: 'percentage', value: 20 },
  { code: 'SOLSTICE-WHOLESALE15', type: 'percentage', value: 15 },
  { code: 'SOLSTICE-HOLIDAY25', type: 'fixed', value: 25, currency: 'USD' },
  { code: 'SOLSTICE-FREESHIP', type: 'free_shipping', value: 0 },
];

export const SOLSTICE_AFFILIATES: readonly { code: string; name: string; commissionType: 'percentage' | 'fixed'; commissionRate: number }[] = [
  { code: 'SOLSTICE-BARISTABLOG', name: 'The Barista Blog', commissionType: 'percentage', commissionRate: 10 },
  { code: 'SOLSTICE-COFFEEGRAM', name: 'Coffeegram Creators', commissionType: 'fixed', commissionRate: 5 },
];

/** Co-purchase templates the order generator cycles — deliberate patterns
 *  (beans+grinder, subscription+mug) that Phase-5 affinityRebuild mines. */
export const SOLSTICE_ORDER_TEMPLATES: readonly { slugs: string[]; note: string }[] = [
  { slugs: ['house-blend', 'burr-grinder'], note: 'beans + grinder' },
  { slugs: ['espresso-blend', 'ceramic-mug'], note: 'espresso + mug' },
  { slugs: ['subscription-box', 'ceramic-mug'], note: 'subscription + mug' },
  { slugs: ['ethiopia-yirgacheffe', 'pour-over-kit'], note: 'single origin + pour-over' },
  { slugs: ['cold-brew-concentrate', 'nitro-cold-brew'], note: 'cold brew pair' },
  { slugs: ['house-blend', 'travel-tumbler'], note: 'beans + tumbler' },
  { slugs: ['gift-set-classic'], note: 'gift set' },
  { slugs: ['french-roast', 'breakfast-blend'], note: 'two blends' },
  { slugs: ['single-origin-sampler'], note: 'sampler' },
  { slugs: ['colombia-huila', 'burr-grinder'], note: 'beans + grinder' },
];

export interface DemoQuote {
  slug: string;
  companySlug: string;
  dealSlug: string;       // links to a demo-crm deal
  lines: { slug: string; quantity: number }[];
  advanceTo: 'draft' | 'sent' | 'accepted';
}

/** 8 quotes tied to deals/companies; one 'accepted' converts to an order. */
export const SOLSTICE_QUOTES: readonly DemoQuote[] = [
  { slug: 'harborview-q', companySlug: 'harborview-hotels', dealSlug: 'harborview-nb', lines: [{ slug: 'office-blend-wholesale', quantity: 40 }, { slug: 'burr-grinder', quantity: 6 }], advanceTo: 'accepted' },
  { slug: 'grandview-q', companySlug: 'grandview-suites', dealSlug: 'grandview-nb', lines: [{ slug: 'house-blend', quantity: 30 }], advanceTo: 'sent' },
  { slug: 'greenleaf-q', companySlug: 'greenleaf-markets', dealSlug: 'greenleaf-nb', lines: [{ slug: 'office-blend-wholesale', quantity: 60 }], advanceTo: 'sent' },
  { slug: 'harvest-q', companySlug: 'harvest-grocers', dealSlug: 'harvest-nb', lines: [{ slug: 'green-beans-wholesale', quantity: 20 }], advanceTo: 'draft' },
  { slug: 'daily-grind-q', companySlug: 'daily-grind-co', dealSlug: 'daily-grind-nb', lines: [{ slug: 'house-blend', quantity: 25 }, { slug: 'espresso-blend', quantity: 15 }], advanceTo: 'sent' },
  { slug: 'terrace-q', companySlug: 'terrace-cafe-group', dealSlug: 'terrace-nb', lines: [{ slug: 'espresso-blend', quantity: 20 }], advanceTo: 'draft' },
  { slug: 'summit-q', companySlug: 'summit-lodges', dealSlug: 'summit-equip', lines: [{ slug: 'pour-over-kit', quantity: 10 }], advanceTo: 'sent' },
  { slug: 'cornerstone-q', companySlug: 'cornerstone-provisions', dealSlug: 'cornerstone-nb', lines: [{ slug: 'cold-brew-concentrate', quantity: 24 }], advanceTo: 'draft' },
];

// ──────────────────────────────────────────────────────────────────────────
// Phase 5 — demo-merchandising: promotions + discovery + recommendations. All
// three are toggle-gated (skip honestly, never flip). Content references product
// slugs (resolved to ids at seed time) + Phase-3 segment slugs.
// ──────────────────────────────────────────────────────────────────────────

export const DEMO_MERCH_ACTOR = 'demo:merch';

export interface DemoPromotion {
  name: string;
  type: 'cart_threshold' | 'product_discount' | 'tiered' | 'bogo' | 'loss_leader';
  reward: { kind: 'percentage' | 'fixed'; value: number };
  scope?: { productSlugs?: string[]; categories?: string[]; all?: boolean };
  minSpend?: number;
  minQuantity?: number;
  bogo?: { buy: number; get: number };
  budget?: { maxDiscount?: number; maxQuantity?: number };
  segmentSlug?: string;
  /** Offsets (days from seed time) for the sale window — the "scheduled" case. */
  schedule?: { startDays: number; endDays: number };
  priority?: number;
}

/** 6 promotions covering every type (+ one scheduled window). */
export const SOLSTICE_PROMOTIONS: readonly DemoPromotion[] = [
  { name: '$10 off orders over $60', type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 60, priority: 1 },
  { name: '20% off Cold Brew', type: 'product_discount', reward: { kind: 'percentage', value: 20 }, scope: { categories: ['Cold Brew'] }, priority: 2 },
  { name: 'Buy 3+ bags, 15% off', type: 'tiered', reward: { kind: 'percentage', value: 15 }, minQuantity: 3, priority: 2 },
  { name: 'Buy 2 mugs, get 1 free', type: 'bogo', reward: { kind: 'percentage', value: 100 }, bogo: { buy: 2, get: 1 }, scope: { productSlugs: ['ceramic-mug'] }, priority: 3 },
  { name: 'House Blend loss leader (café segment)', type: 'loss_leader', reward: { kind: 'percentage', value: 40 }, scope: { productSlugs: ['house-blend'] }, budget: { maxDiscount: 500 }, segmentSlug: 'cafe-accounts', priority: 5 },
  { name: 'Holiday sale — 25% off Blends', type: 'product_discount', reward: { kind: 'percentage', value: 25 }, scope: { categories: ['Blends'] }, schedule: { startDays: 7, endDays: 21 }, priority: 4 },
];

export interface DemoCollection {
  name: string;
  type: 'manual' | 'dynamic';
  productSlugs?: string[];
  rule?: { categories?: string[]; tags?: string[]; minPrice?: number; maxPrice?: number };
  /** Parent collection NAME (one-level taxonomy). */
  parentName?: string;
}

/** 6 collections (4 manual, 2 dynamic) + a one-level taxonomy (Coffee → …). */
export const SOLSTICE_COLLECTIONS: readonly DemoCollection[] = [
  { name: 'Coffee', type: 'manual', productSlugs: [] },
  { name: 'Single Origin', type: 'dynamic', rule: { categories: ['Single Origin'] }, parentName: 'Coffee' },
  { name: 'Blends', type: 'dynamic', rule: { categories: ['Blends'] }, parentName: 'Coffee' },
  { name: 'Staff Picks', type: 'manual', productSlugs: ['ethiopia-yirgacheffe', 'house-blend', 'cold-brew-concentrate', 'burr-grinder'] },
  { name: 'Gifts', type: 'manual', productSlugs: ['gift-set-classic', 'single-origin-sampler', 'ceramic-mug'] },
  { name: 'Best Sellers', type: 'manual', productSlugs: ['house-blend', 'espresso-blend', 'cold-brew-concentrate'] },
];

export type MerchActionSpec =
  | { kind: 'pin'; productSlug: string; position: number }
  | { kind: 'boost'; predicate: { categories?: string[]; tags?: string[] }; factor: number }
  | { kind: 'bury'; predicate: { categories?: string[]; tags?: string[] } }
  | { kind: 'hide'; predicate: { categories?: string[]; tags?: string[] } };

export interface DemoMerchRule {
  name: string;
  scope: string;          // 'all' | 'query:<term>' | 'collection:<id>'
  actions: MerchActionSpec[];
  holdoutPct?: number;
}

/** 4 merch rules — one of each action, one with a holdout. */
export const SOLSTICE_MERCH_RULES: readonly DemoMerchRule[] = [
  { name: 'Feature House Blend', scope: 'all', actions: [{ kind: 'pin', productSlug: 'house-blend', position: 1 }] },
  { name: 'Boost Cold Brew (A/B)', scope: 'all', actions: [{ kind: 'boost', predicate: { categories: ['Cold Brew'] }, factor: 1.5 }], holdoutPct: 20 },
  { name: 'Bury Wholesale in retail browse', scope: 'all', actions: [{ kind: 'bury', predicate: { categories: ['Wholesale'] } }] },
  { name: 'Hide Wholesale from search', scope: 'query:coffee', actions: [{ kind: 'hide', predicate: { categories: ['Wholesale'] } }] },
];

export interface DemoPlacement {
  slot: 'pdp' | 'cart' | 'checkout' | 'post_purchase' | 'home';
  source: 'bought_together' | 'cross_sell' | 'upsell' | 'similar' | 'trending';
  holdoutPct?: number;
  segmentSlug?: string;
}

/** 5 recommendation placements — one holdout, one segment-scoped. */
export const SOLSTICE_PLACEMENTS: readonly DemoPlacement[] = [
  { slot: 'pdp', source: 'similar' },
  { slot: 'cart', source: 'cross_sell', holdoutPct: 20 },
  { slot: 'checkout', source: 'upsell' },
  { slot: 'post_purchase', source: 'bought_together' },
  { slot: 'home', source: 'trending', segmentSlug: 'west-territory' },
];

// ── Sales channel geography (dealers outlets + sales-map pins, ADR 0281/0282) ──
// Pre-set coordinates for the 15 company HQ metros. The dealers/sales-maps
// seeders pass these verbatim as outlet lat/lng — NEVER geocoding (no external
// call, no BYOK credential). Approximate metro centroids; keyed by the exact
// `hqCity` string on SOLSTICE_COMPANIES.
export const CITY_COORDS: Readonly<Record<string, { lat: number; lng: number }>> = {
  'Seattle, WA': { lat: 47.606, lng: -122.332 },
  'Denver, CO': { lat: 39.739, lng: -104.990 },
  'Boston, MA': { lat: 42.360, lng: -71.058 },
  'Savannah, GA': { lat: 32.084, lng: -81.099 },
  'Portland, OR': { lat: 45.515, lng: -122.679 },
  'San Diego, CA': { lat: 32.716, lng: -117.161 },
  'Brooklyn, NY': { lat: 40.678, lng: -73.944 },
  'Providence, RI': { lat: 41.824, lng: -71.413 },
  'Oakland, CA': { lat: 37.804, lng: -122.271 },
  'Philadelphia, PA': { lat: 39.953, lng: -75.165 },
  'Los Angeles, CA': { lat: 34.052, lng: -118.244 },
  'Atlanta, GA': { lat: 33.749, lng: -84.388 },
  'Phoenix, AZ': { lat: 33.448, lng: -112.074 },
  'Columbus, OH': { lat: 39.961, lng: -82.999 },
  'Austin, TX': { lat: 30.267, lng: -97.743 },
};

/** Coords for a company slug (via its hqCity), with a small deterministic offset
 *  per outlet index so multiple outlets of one dealer don't stack on one pixel. */
export function outletCoords(companySlug: string, outletIdx: number): { lat: number; lng: number } | undefined {
  const company = SOLSTICE_COMPANIES.find((c) => c.slug === companySlug);
  const base = company ? CITY_COORDS[company.hqCity] : undefined;
  if (!base) return undefined;
  const off = outletIdx * 0.06;
  return { lat: Number((base.lat + off).toFixed(4)), lng: Number((base.lng - off).toFixed(4)) };
}
