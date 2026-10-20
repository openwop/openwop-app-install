/**
 * Ad-platform wire constants + pure body builders (ADR 0907 D0/D1/D2).
 *
 * DEPENDENCY-FREE on purpose: `scripts/ads-sandbox-verify.mjs` imports the
 * compiled copy of this module to build the exact bodies the adapter sends, so
 * the sandbox verifies the shipped shape, not a hand-written copy. Anything
 * that needs storage, the broker or logging belongs in `adsAdapter.ts`.
 */

export type AdPlatform = 'meta' | 'google' | 'tiktok' | 'linkedin';

/**
 * ADR 0907 D0 — the ONE table of pinned ad-platform API versions. Every base URL
 * and version header below derives from it, and `test/ads-api-version-tripwire`
 * goes red 60 days before any row's `sunset` (or `reviewBy`, for a row whose
 * sunset is estimated or unannounced). Before this table Google Ads sat on `v18`
 * a year past its sunset and Meta on `v21.0` past its Marketing API expiry, and
 * nothing noticed. Bump a row by reading the `source` page, never from memory.
 */
export interface AdsApiVersionPin {
  platform: AdPlatform;
  version: string;
  /** ISO date the platform stops serving this version (`published`), our
   *  conservative guess from the platform's cadence (`estimated`), or absent. */
  sunset?: string;
  basis: 'published' | 'estimated' | 'none-announced';
  /** For `estimated` / `none-announced` rows: the date by which a human must
   *  re-read `source`. The tripwire treats it exactly like a sunset. */
  reviewBy?: string;
  source: string;
  /** When the row was last read against `source`. */
  checkedAt: string;
}
export const ADS_API_VERSIONS: Readonly<Record<AdPlatform, AdsApiVersionPin>> = {
  google: {
    platform: 'google', version: 'v26', sunset: '2027-11-01', basis: 'published',
    source: 'https://developers.google.com/google-ads/api/docs/sunset-dates', checkedAt: '2026-10-17',
  },
  meta: {
    // Marketing API table: v24.0 expired 2026-10-06, v25.0 (2026-02-18) shows TBD.
    // Recent Marketing API versions lived ~12 months, hence the estimate.
    platform: 'meta', version: 'v25.0', sunset: '2027-02-18', basis: 'estimated', reviewBy: '2027-01-15',
    source: 'https://developers.facebook.com/docs/graph-api/changelog/versions/', checkedAt: '2026-10-17',
  },
  tiktok: {
    platform: 'tiktok', version: 'v1.3', basis: 'none-announced', reviewBy: '2027-04-01',
    source: 'https://business-api.tiktok.com/portal/docs', checkedAt: '2026-10-17',
  },
  linkedin: {
    // Monthly versions, each supported for at least one year.
    platform: 'linkedin', version: '202610', sunset: '2027-10-01', basis: 'published',
    source: 'https://learn.microsoft.com/en-us/linkedin/marketing/versioning', checkedAt: '2026-10-17',
  },
};

/** Meta Marketing API base — hardcoded host (NEVER input-derived); test override only. */
export function metaApiBase(): string {
  return (process.env.OPENWOP_META_API_BASE ?? `https://graph.facebook.com/${ADS_API_VERSIONS.meta.version}`).replace(/\/+$/, '');
}
/** Google Ads API base — hardcoded host; test override only. */
export function googleApiBase(): string {
  return (process.env.OPENWOP_GOOGLE_ADS_API_BASE ?? `https://googleads.googleapis.com/${ADS_API_VERSIONS.google.version}`).replace(/\/+$/, '');
}
/** TikTok Business API base — hardcoded host; test override only. */
export function tiktokApiBase(): string {
  return (process.env.OPENWOP_TIKTOK_ADS_API_BASE ?? `https://business-api.tiktok.com/open_api/${ADS_API_VERSIONS.tiktok.version}`).replace(/\/+$/, '');
}
/** LinkedIn Marketing API base — hardcoded host; test override only. Versioned REST
 *  lives under `/rest/*` with the `LinkedIn-Version` header (see LINKEDIN_VERSION). */
export function linkedinApiBase(): string {
  return (process.env.OPENWOP_LINKEDIN_ADS_API_BASE ?? 'https://api.linkedin.com').replace(/\/+$/, '');
}
/** The LinkedIn versioned-REST month pin (every /rest/* call sends it). */
export const LINKEDIN_VERSION = ADS_API_VERSIONS.linkedin.version;

/** One conversion event, as the relay hands it to a platform. Hashed
 *  identifiers only — the raw address and phone never reach this module. */
export interface ConversionBodyArgs {
  pixelId: string;
  eventId: string;
  eventName: string;
  eventTimeIso: string;
  emailHash?: string;
  /** SHA-256 of the E.164 digits WITHOUT `+` (Meta / TikTok form). */
  phoneHash?: string;
  /** SHA-256 of the E.164 number WITH `+` (Google form). */
  phoneHashE164?: string;
  value?: number;
  currency?: string;
  /** ADR 0907 D6 — match-quality signals captured at intake. */
  ip?: string;
  userAgent?: string;
  fbc?: string;
  fbp?: string;
  ttclid?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  pageUrl?: string;
}
const unixSeconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

/** Meta Conversions API body for ONE event (ADR 0297 D1; ADR 0907 D6 adds the
 *  match-quality fields Meta requires for `action_source:'website'`: client IP
 *  and user agent, plus fbc/fbp and the hashed phone). Pure — the adapter and
 *  `scripts/ads-sandbox-verify.mjs` build the wire body from this one function. */
export function buildMetaConversionBody(args: ConversionBodyArgs): Record<string, unknown> {
  return {
    data: [{
      event_name: args.eventName,
      event_time: unixSeconds(args.eventTimeIso),
      event_id: args.eventId, // the platform-side dedup key
      action_source: 'website',
      ...(args.pageUrl ? { event_source_url: args.pageUrl } : {}),
      user_data: {
        ...(args.emailHash ? { em: [args.emailHash] } : {}),
        ...(args.phoneHash ? { ph: [args.phoneHash] } : {}),
        ...(args.ip ? { client_ip_address: args.ip } : {}),
        ...(args.userAgent ? { client_user_agent: args.userAgent } : {}),
        ...(args.fbc ? { fbc: args.fbc } : {}),
        ...(args.fbp ? { fbp: args.fbp } : {}),
      },
      ...(args.value !== undefined ? { custom_data: { value: args.value, ...(args.currency ? { currency: args.currency } : {}) } } : {}),
    }],
  };
}

/** TikTok Events API 2.0 body for ONE web event (ADR 0907 D1/D6): the pixel
 *  code is the `event_source_id`, events ride `data[]`, identifiers are hashed
 *  arrays; IP, user agent and ttclid are sent as captured. */
export function buildTiktokConversionBody(args: ConversionBodyArgs): Record<string, unknown> {
  return {
    event_source: 'web',
    event_source_id: args.pixelId,
    data: [{
      event: args.eventName,
      event_time: unixSeconds(args.eventTimeIso),
      event_id: args.eventId,
      user: {
        ...(args.emailHash ? { email: [args.emailHash] } : {}),
        ...(args.phoneHash ? { phone: [args.phoneHash] } : {}),
        ...(args.ip ? { ip: args.ip } : {}),
        ...(args.userAgent ? { user_agent: args.userAgent } : {}),
        ...(args.ttclid ? { ttclid: args.ttclid } : {}),
      },
      ...(args.value !== undefined ? { properties: { value: args.value, ...(args.currency ? { currency: args.currency } : {}) } } : {}),
      ...(args.pageUrl ? { page: { url: args.pageUrl } } : {}),
    }],
  };
}

/** Google Ads consent signals for an uploaded conversion (EEA requirement). */
export interface GoogleConsent { adUserData: 'GRANTED' | 'DENIED'; adPersonalization: 'GRANTED' | 'DENIED' }

/** Google's `conversionDateTime`: `yyyy-mm-dd hh:mm:ss+hh:mm`. UTC is a valid offset. */
export function googleConversionDateTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')}+00:00`;
}

/** Google Ads `customers/{cid}:uploadClickConversions` body for ONE event
 *  (ADR 0907 D5). The conversion action is a RESOURCE NAME from the org's pixel
 *  config, never an event name (MyndHyve wart 6). A click id when there is one;
 *  hashed email/phone as user identifiers (enhanced conversions for leads).
 *  `orderId` = the relay eventId, Google's dedup key. `partialFailure` so a bad
 *  row is a per-row error instead of failing the request. */
export function buildGoogleClickConversionBody(args: ConversionBodyArgs & { conversionAction: string; consent: GoogleConsent }): Record<string, unknown> {
  const userIdentifiers = [
    ...(args.emailHash ? [{ hashedEmail: args.emailHash }] : []),
    ...(args.phoneHashE164 ? [{ hashedPhoneNumber: args.phoneHashE164 }] : []),
  ];
  return {
    conversions: [{
      conversionAction: args.conversionAction,
      conversionDateTime: googleConversionDateTime(args.eventTimeIso),
      orderId: args.eventId,
      ...(args.gclid ? { gclid: args.gclid } : args.gbraid ? { gbraid: args.gbraid } : args.wbraid ? { wbraid: args.wbraid } : {}),
      ...(args.value !== undefined ? { conversionValue: args.value, ...(args.currency ? { currencyCode: args.currency } : {}) } : {}),
      ...(userIdentifiers.length > 0 ? { userIdentifiers } : {}),
      consent: { adUserData: args.consent.adUserData, adPersonalization: args.consent.adPersonalization },
    }],
    partialFailure: true,
  };
}

/** A Google conversion action resource name: `customers/<cid>/conversionActions/<id>`. */
export const GOOGLE_CONVERSION_ACTION_RE = /^customers\/[0-9]{1,20}\/conversionActions\/[0-9]{1,20}$/;

/**
 * ADR 0907 D2/D4 — which account-metrics readers are honest-ON. Meta and Google
 * went live under ADR 0215. TikTok and LinkedIn readers are built to the
 * platforms' documented shapes but stay `unsupported` (`not_sandbox_verified`)
 * until an operator has run `scripts/ads-sandbox-verify.mjs <platform> metrics`
 * against a test account and lists the platform in
 * `OPENWOP_ADS_VERIFIED_READERS` (comma-separated). An unverified reader is
 * never presented as working.
 */
export const ADS_READER_STATUS: Readonly<Record<AdPlatform, 'live' | 'pending_sandbox'>> = {
  meta: 'live', google: 'live', tiktok: 'pending_sandbox', linkedin: 'pending_sandbox',
};
export function adsReaderEnabled(platform: AdPlatform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (ADS_READER_STATUS[platform] === 'live') return true;
  const listed = (env.OPENWOP_ADS_VERIFIED_READERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return listed.includes(platform);
}

/** One account-metrics read, as the readers and the sandbox script build it. */
export interface MetricsQueryArgs { adAccountId: string; level: 'campaign' | 'adset'; since: string; until: string }

/** TikTok BASIC report request URL for one page (ADR 0907 D4). */
export function buildTiktokReportUrl(base: string, args: MetricsQueryArgs, page: number, pageSize: number): string {
  const adset = args.level === 'adset';
  const params = new URLSearchParams({
    advertiser_id: args.adAccountId.replace(/[^0-9]/g, ''), report_type: 'BASIC', data_level: adset ? 'AUCTION_ADGROUP' : 'AUCTION_CAMPAIGN',
    dimensions: JSON.stringify(adset ? ['adgroup_id', 'stat_time_day'] : ['campaign_id', 'stat_time_day']),
    metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'conversion', 'campaign_name', 'campaign_id', ...(adset ? ['adgroup_name'] : [])]),
    start_date: args.since, end_date: args.until, page: String(page), page_size: String(pageSize),
  });
  return `${base}/report/integrated/get/?${params.toString()}`;
}

/** LinkedIn adAnalytics request URL (Rest.li 2.0: parens/colons literal, only the URN encoded). */
export function buildLinkedinAnalyticsUrl(base: string, args: MetricsQueryArgs): string {
  const ymd = (iso: string): string => { const [y, m, d] = iso.split('-').map(Number); return `(year:${y},month:${m},day:${d})`; };
  const account = args.adAccountId.replace(/[^0-9]/g, '');
  return `${base}/rest/adAnalytics?${[
    'q=analytics', 'pivot=CAMPAIGN', 'timeGranularity=DAILY',
    `dateRange=(start:${ymd(args.since)},end:${ymd(args.until)})`,
    `accounts=List(${encodeURIComponent(`urn:li:sponsoredAccount:${account}`)})`,
    'fields=dateRange,pivotValues,impressions,clicks,costInLocalCurrency,externalWebsiteConversions,conversionValueInLocalCurrency',
  ].join('&')}`;
}

/**
 * ADR 0907 D2 — which conversion SENDERS are honest-ON. Meta CAPI went live
 * under ADR 0297. The TikTok sender never worked before ADR 0907 P0 fixed its
 * header and body, and the Google upload is new in P3; neither has been
 * exercised against a test surface, so both stay `unsupported`
 * (`not_sandbox_verified`) until an operator runs
 * `scripts/ads-sandbox-verify.mjs <platform> conversion|google-upload` and lists
 * the platform in `OPENWOP_ADS_VERIFIED_SENDERS`.
 */
export const ADS_SENDER_STATUS: Readonly<Record<'meta' | 'tiktok' | 'google', 'live' | 'pending_sandbox'>> = {
  meta: 'live', tiktok: 'pending_sandbox', google: 'pending_sandbox',
};
export function adsSenderEnabled(platform: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const status = (ADS_SENDER_STATUS as Record<string, 'live' | 'pending_sandbox' | undefined>)[platform];
  if (!status) return false;
  if (status === 'live') return true;
  return (env.OPENWOP_ADS_VERIFIED_SENDERS ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(platform);
}

/**
 * ADR 0907 D7 (lead amendment 2026-10-17) — how old a conversion a platform
 * still accepts. Older rows are marked `expired` (`outside_platform_window`),
 * never sent: an old backlog must not be flushed to a third party when
 * delivery is first enabled. Meta CAPI: 7 days. TikTok Events: 7 days
 * (conservative; the same as Meta). Google click conversions: 90 days (the
 * click-lookback ceiling).
 */
export const CONVERSION_WINDOW_DAYS: Readonly<Record<'meta' | 'tiktok' | 'google', number>> = { meta: 7, tiktok: 7, google: 90 };
export function conversionOutsideWindow(platform: string, eventIso: string, nowMs: number = Date.now()): boolean {
  const days = (CONVERSION_WINDOW_DAYS as Record<string, number | undefined>)[platform];
  if (days === undefined) return false;
  const at = Date.parse(eventIso);
  return !Number.isFinite(at) || nowMs - at > days * 86_400_000;
}
