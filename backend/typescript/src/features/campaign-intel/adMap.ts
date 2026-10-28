/**
 * ADR 0956 D6 — AdMap: each dispatched ad → its landing URL → the CMS page or
 * funnel step that URL resolves to → the experiment arm it carries, with the
 * landing sessions and the conversions credited to that ad.
 *
 * - Ads come from the dispatch ledger (`host/adsAdapter.ts`), which records
 *   `orgId`, `landingUrl` and `adRef` since ADR 0956 P0. A row written before P0
 *   has no `orgId`; it is placed by its brief's org, else left out without
 *   exposing another client's count.
 * - The join from ad to visit is `utm_id` = the ad reference, which
 *   `buildTrackedUrl` stamps on the landing link. Credit uses the same paths
 *   and model as the attribution report.
 * - The performance store has no ad grain yet (ADR 0907 reads campaign × ad set
 *   × day), so per-ad spend and clicks are `null` with `metricsGrain:
 *   'campaign'`, and the click-to-session loss rate is `null` too. It is never
 *   estimated by splitting a campaign's spend.
 * - The message-match score (ad copy vs page hero) comes from ADR 0933 content
 *   rules, which are not built yet: it is reported as `owed`, never computed ad hoc.
 * - The ledger keeps the newest 500 dispatches per tenant. When it is full, the
 *   map says so (`ledgerCapped`), because an older ad may be missing.
 */
import { listTenantDispatchRecords, type AdPlatform, type DispatchLedgerRow } from '../../host/adsAdapter.js';
import { resolveCustomHost } from '../../host/customDomains.js';
import { featureAccessRefusal } from '../../host/workflowFeatureGate.js';
// Cross-feature READS (the documented precedent): page and funnel lookups go
// through their owning services, never their stores.
import { getPublishedBySlug } from '../cms/cmsService.js';
import { listFunnels } from '../funnels/funnelsService.js';
import { CONVERSION_UNITS, type AttributionModel } from './attributionModels.js';
import { creditTouches, loadAttributionContext } from './attribution.js';

const LEDGER_CAP = (): number => Math.max(1, Number(process.env.OPENWOP_ADS_DISPATCH_LEDGER_CAP ?? '') || 500);

export type LandingResolution =
  | { kind: 'cms_page'; pageId: string; slug: string; title: string; funnelSteps: Array<{ funnelId: string; funnelName: string; stepId: string }> }
  | { kind: 'external'; host: string }
  | { kind: 'unresolved'; reason: 'no_landing_url' | 'invalid_url' | 'page_not_found' | 'other_org' | 'feature_off' };

export interface AdMapRow {
  platform: AdPlatform;
  platformAdId: string;
  platformCampaignId: string;
  adRef: string | null;
  campaignId: string | null;
  campaignName: string | null;
  landingUrl: string | null;
  landing: LandingResolution;
  /** `utm_content` on the landing link: the variant / experiment arm (ADR 0946). */
  variantKey: string | null;
  spend: null;
  clicks: null;
  metricsGrain: 'campaign';
  /** Distinct sessions that arrived with this ad's `utm_id`. */
  landingSessions: number | null;
  /** Conversions credited to this ad's touches under `model`. */
  conversions: number | null;
  clickToSessionLoss: null;
  messageMatch: { status: 'owed'; reason: 'adr_0933_content_rules_pending' };
  dispatchedAt: string;
}

export interface AdMapReport {
  model: AttributionModel;
  rows: AdMapRow[];
  /** Compatibility field: unowned legacy rows are never counted for a client. */
  unplacedLegacyRows: number;
  ledgerCapped: boolean;
  computedAt: string;
}

const platformOrigin = (): string | null => {
  const raw = process.env.OPENWOP_PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try { return new URL(raw).host.toLowerCase(); } catch { return null; }
};

/** The slug a landing URL names for this org, or why it names none. Pure but
 *  for the custom-host lookup (cached in `customDomains.ts`). */
export async function slugForLanding(url: string, orgId: string): Promise<{ slug: string } | { external: string } | { unresolved: 'invalid_url' | 'other_org' }> {
  let u: URL;
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//');
  try { u = new URL(url, 'https://relative.invalid'); } catch { return { unresolved: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { unresolved: 'invalid_url' };
  let parts: string[];
  try { parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p)); }
  catch { return { unresolved: 'invalid_url' }; }
  const host = u.host.toLowerCase();
  const platform = host === platformOrigin();
  const custom = relative || platform ? null : await resolveCustomHost(host);
  if (custom && custom.orgId !== orgId) return { unresolved: 'other_org' };
  if (!relative && !platform && !custom) return { external: host };
  // An explicit org in a URL path is useful only after the host is ours.
  const pub = parts.indexOf('public');
  if (pub !== -1 && parts[pub + 2] === 'pages' && parts[pub + 3]) {
    return parts[pub + 1] === orgId ? { slug: parts[pub + 3]! } : { unresolved: 'other_org' };
  }
  const siteOrg = process.env.OPENWOP_PUBLIC_SITE_ORG_ID?.trim();
  const isOwnSite = relative || (custom !== null && custom.orgId === orgId) || (platform && siteOrg === orgId);
  if (!isOwnSite) return { external: host };
  // `/` → home; `/p/<slug>`, `/blog/<slug>`, `/docs/<slug>` or a bare `/<slug>`.
  if (parts.length === 0) return { slug: 'home' };
  if (parts.length === 2 && ['p', 'blog', 'docs'].includes(parts[0]!)) return { slug: parts[1]! };
  if (parts.length === 1) return { slug: parts[0]! };
  return { unresolved: 'invalid_url' };
}

function param(url: string | undefined, name: string): string | null {
  if (!url) return null;
  try { return new URL(url, 'https://relative.invalid').searchParams.get(name) || null; } catch { return null; }
}

export async function buildAdMap(tenantId: string, orgId: string, requested?: AttributionModel): Promise<AdMapReport> {
  const funnelsAvailable = !(await featureAccessRefusal('funnels', tenantId));
  const cmsAvailable = !(await featureAccessRefusal('cms', tenantId));
  const [ctx, ledger, funnels] = await Promise.all([
    loadAttributionContext(tenantId, orgId),
    listTenantDispatchRecords(tenantId),
    funnelsAvailable ? listFunnels(tenantId, orgId) : Promise.resolve([]),
  ]);
  const model = requested ?? ctx.settings.defaultModel;
  const campaignByBrief = new Map(ctx.campaigns.map((c) => [c.briefId, c] as const));

  // Which ledger rows belong to this org: their own `orgId`, else (a pre-P0
  // row) the org of the brief they were published from.
  const mine: DispatchLedgerRow[] = [];
  for (const r of ledger) {
    if (r.orgId !== undefined) { if (r.orgId === orgId) mine.push(r); continue; }
    if (r.briefId && campaignByBrief.has(r.briefId)) mine.push(r);
    // A legacy row whose brief this client does not own is not even a count
    // this client may read. It could belong to another client in the tenant.
  }

  // Sessions and credit per ad reference (utm_id), from the same paths.
  const sessionsByRef = new Map<string, Set<string>>();
  const unitsByRef = new Map<string, number>();
  for (const event of ctx.events) {
    if (!event.utm?.id || !event.sessionKey) continue;
    const sessions = sessionsByRef.get(event.utm.id) ?? new Set<string>();
    sessions.add(event.sessionKey);
    sessionsByRef.set(event.utm.id, sessions);
  }
  for (const p of ctx.paths) {
    if (p.touches.length === 0) continue;
    const { units } = creditTouches(model, p, ctx.settings);
    p.touches.forEach((t, i) => { if (t.utmId) unitsByRef.set(t.utmId, (unitsByRef.get(t.utmId) ?? 0) + units[i]!); });
  }

  const stepsByPage = new Map<string, Array<{ funnelId: string; funnelName: string; stepId: string }>>();
  for (const f of funnels) for (const s of f.steps) {
    const arr = stepsByPage.get(s.pageId) ?? [];
    arr.push({ funnelId: f.funnelId, funnelName: f.name, stepId: s.stepId });
    stepsByPage.set(s.pageId, arr);
  }
  const pageBySlug = new Map<string, Awaited<ReturnType<typeof getPublishedBySlug>>>();
  const resolve = async (url: string | undefined): Promise<LandingResolution> => {
    if (!url) return { kind: 'unresolved', reason: 'no_landing_url' };
    if (!cmsAvailable) return { kind: 'unresolved', reason: 'feature_off' };
    const where = await slugForLanding(url, orgId);
    if ('external' in where) return { kind: 'external', host: where.external };
    if ('unresolved' in where) return { kind: 'unresolved', reason: where.unresolved };
    if (!pageBySlug.has(where.slug)) pageBySlug.set(where.slug, await getPublishedBySlug(tenantId, orgId, where.slug));
    const hit = pageBySlug.get(where.slug);
    if (!hit) return { kind: 'unresolved', reason: 'page_not_found' };
    return { kind: 'cms_page', pageId: hit.page.pageId, slug: hit.page.slug, title: hit.page.title, funnelSteps: stepsByPage.get(hit.page.pageId) ?? [] };
  };

  const rows: AdMapRow[] = [];
  const refCounts = new Map<string, Set<string>>();
  for (const r of mine) {
    const ref = r.adRef ?? param(r.landingUrl, 'utm_id');
    if (!ref) continue;
    const ads = refCounts.get(ref) ?? new Set<string>();
    ads.add(`${r.platform}:${r.platformAdId}`);
    refCounts.set(ref, ads);
  }
  for (const r of mine) {
    const campaign = r.briefId ? campaignByBrief.get(r.briefId) : undefined;
    const adRef = r.adRef ?? param(r.landingUrl, 'utm_id');
    const measurable = adRef !== null && refCounts.get(adRef)?.size === 1;
    rows.push({
      platform: r.platform,
      platformAdId: r.platformAdId,
      platformCampaignId: r.platformCampaignId,
      adRef,
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? r.campaignName ?? null,
      landingUrl: r.landingUrl ?? null,
      landing: await resolve(r.landingUrl),
      variantKey: param(r.landingUrl, 'utm_content'),
      spend: null,
      clicks: null,
      metricsGrain: 'campaign',
      landingSessions: measurable ? sessionsByRef.get(adRef)?.size ?? 0 : null,
      conversions: measurable ? Number(((unitsByRef.get(adRef) ?? 0) / CONVERSION_UNITS).toFixed(4)) : null,
      clickToSessionLoss: null,
      messageMatch: { status: 'owed', reason: 'adr_0933_content_rules_pending' },
      dispatchedAt: r.createdAt,
    });
  }
  return {
    model,
    rows,
    unplacedLegacyRows: 0,
    ledgerCapped: ledger.length >= LEDGER_CAP(),
    computedAt: new Date().toISOString(),
  };
}
