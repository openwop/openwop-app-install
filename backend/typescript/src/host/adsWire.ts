/**
 * Ad-platform wire constants + pure body builders (ADR 0907 D0/D1/D2).
 *
 * Free of host dependencies on purpose: `scripts/ads-sandbox-verify.mjs` imports the
 * compiled copy of this module to build the exact bodies the adapter sends, so
 * the sandbox verifies the shipped shape, not a hand-written copy. Anything
 * that needs storage, the broker or logging belongs in `adsAdapter.ts`. Its one
 * import is the pure ISO exponent helper (`currencyUnits.ts`), bundled with it.
 */

import { strictCurrencyExponent } from './currencyUnits.js';

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

// ── ADR 0952 defect P9 — budget units ───────────────────────────────────────
// The adapter's `dailyBudgetMinor` is ISO-4217 MINOR units of the AD ACCOUNT's
// currency (cents for USD, yen for JPY, fils for KWD). Each platform wants its own
// unit, and every conversion goes through the functions below, keyed by the
// account currency the platform reports (never assumed):
//   - Google: micros = major × 10⁶ = minor × 10^(6 − exponent).
//   - Meta: the account currency's "offset" (Meta's own table, NOT ISO: Meta uses
//     100 for BHD/JOD although ISO has 3 decimals, and 1 for HUF/TWD/IDR/COP/CRC
//     although ISO has 2). Value = minor × offset / 10^exponent.
//   - TikTok / LinkedIn: major units (decimal).
// Before this, Google sent minor × 10⁴ and TikTok/LinkedIn minor / 100 — right
// only for 2-decimal currencies: a JPY budget went out 100× too SMALL, a KWD one
// 10× too LARGE; Meta passed ISO minor units through, 100× too large for HUF/TWD
// and 10× too large for BHD/JOD. The exponent comes from the ONE ISO helper
// (`currencyUnits.ts`); the Meta offset table is Meta's, kept separate the way
// billing keeps Stripe's zero-decimal list.


/** Meta Marketing API currency offsets — https://developers.facebook.com/docs/marketing-api/currencies/
 *  (read 2026-10-20). A currency in neither set is not a Meta ad-account currency. */
export const META_CURRENCY_OFFSET_1: ReadonlySet<string> = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
export const META_CURRENCY_OFFSET_100: ReadonlySet<string> = new Set([
  'DZD', 'ARS', 'AUD', 'BHD', 'BDT', 'BOB', 'BGN', 'BRL', 'GBP', 'CAD', 'CNY', 'HRK', 'CZK', 'DKK', 'EGP', 'EUR', 'GTQ', 'HNL',
  'HKD', 'INR', 'ILS', 'JOD', 'KES', 'LVL', 'LTL', 'MOP', 'MYR', 'MXN', 'NZD', 'NIO', 'NGN', 'NOK', 'PKR', 'PEN', 'PHP', 'PLN',
  'QAR', 'RON', 'RUB', 'SAR', 'RSD', 'SGD', 'SKK', 'ZAR', 'SEK', 'CHF', 'THB', 'TRY', 'AED', 'UAH', 'USD', 'UYU', 'VEF', 'VES',
]);

/** ISO-4217 exponent of a REPORTED currency code; `null` for anything that is not one (never a default). */
export function isoExponent(currency: string | undefined): number | null {
  return strictCurrencyExponent(currency);
}

/** Exact nonnegative integer rescaling. Refuse rounding and unsafe outputs. */
function rescaleMoney(value: number, from: number, to: number): number | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const factor = 10 ** Math.abs(to - from);
  if (to >= from) {
    if (value > Math.floor(Number.MAX_SAFE_INTEGER / factor)) return null;
    const result = value * factor;
    return Number.isSafeInteger(result) ? result : null;
  }
  return value % factor === 0 ? value / factor : null;
}

export function minorToGoogleMicros(minor: number, currency: string): number | null {
  const exp = isoExponent(currency);
  return exp === null ? null : rescaleMoney(minor, exp, 6);
}
export function googleMicrosToMinor(micros: number, currency: string): number | null {
  const exp = isoExponent(currency);
  return exp === null ? null : rescaleMoney(micros, 6, exp);
}

export function metaCurrencyOffset(currency: string): 1 | 100 | null {
  return META_CURRENCY_OFFSET_1.has(currency) ? 1 : META_CURRENCY_OFFSET_100.has(currency) ? 100 : null;
}
export function minorToMetaBudget(minor: number, currency: string): number | null {
  const exp = isoExponent(currency);
  const offset = metaCurrencyOffset(currency);
  return exp === null || offset === null ? null : rescaleMoney(minor, exp, offset === 1 ? 0 : 2);
}
export function metaBudgetToMinor(value: number, currency: string): number | null {
  const exp = isoExponent(currency);
  const offset = metaCurrencyOffset(currency);
  return exp === null || offset === null ? null : rescaleMoney(value, offset === 1 ? 0 : 2, exp);
}

/** Major units as a decimal string with exactly the currency's ISO decimals (LinkedIn `amount`). */
export function minorToMajorString(minor: number, currency: string): string | null {
  const exp = isoExponent(currency);
  if (exp === null || !Number.isSafeInteger(minor) || minor < 0) return null;
  if (exp === 0) return String(minor);
  const factor = 10 ** exp;
  const remainder = minor % factor;
  return `${(minor - remainder) / factor}.${String(remainder).padStart(exp, '0')}`;
}
/** Major units as a number (TikTok `budget`). */
export function minorToMajorNumber(minor: number, currency: string): number | null {
  const s = minorToMajorString(minor, currency);
  if (s === null) return null;
  const value = Number(s);
  const exactDecimal = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  // JSON serializes the shortest decimal number. It must still carry the exact
  // requested amount, rather than hiding a lost minor unit with toFixed().
  return Number.isFinite(value) && String(value) === exactDecimal ? value : null;
}

/**
 * ADR 0952 D1 — campaign delivery-status writes (pause / activate). The bodies
 * are built here so `scripts/ads-sandbox-verify.mjs` verifies the shipped shape.
 * Like every reader and sender, a status writer is `unsupported` until a sandbox
 * transcript exists and the operator lists it in
 * `OPENWOP_ADS_VERIFIED_STATUS_WRITERS` (comma-separated).
 */
export type DeliveryStatus = 'paused' | 'active';
export const ADS_STATUS_WRITER_STATUS: Readonly<Record<AdPlatform, 'live' | 'pending_sandbox'>> = {
  meta: 'pending_sandbox', google: 'pending_sandbox', tiktok: 'pending_sandbox', linkedin: 'pending_sandbox',
};
export function adsStatusWriterEnabled(platform: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const status = (ADS_STATUS_WRITER_STATUS as Record<string, 'live' | 'pending_sandbox' | undefined>)[platform];
  if (!status) return false;
  if (status === 'live') return true;
  return (env.OPENWOP_ADS_VERIFIED_STATUS_WRITERS ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(platform);
}
/** Meta campaign `status` literal for a delivery status. */
export function metaStatusLiteral(s: DeliveryStatus): 'PAUSED' | 'ACTIVE' {
  if (s === 'paused') return 'PAUSED';
  if (s === 'active') return 'ACTIVE';
  throw new Error('invalid_delivery_status');
}
/** Google `campaign.status` literal for a delivery status. */
export function googleStatusLiteral(s: DeliveryStatus): 'PAUSED' | 'ENABLED' {
  if (s === 'paused') return 'PAUSED';
  if (s === 'active') return 'ENABLED';
  throw new Error('invalid_delivery_status');
}
/** Meta: `POST /{campaign-id}` with this body. */
export function buildMetaStatusBody(status: DeliveryStatus): Record<string, unknown> {
  return { status: metaStatusLiteral(status) };
}
/** Google: `POST customers/{cid}/campaigns:mutate` with this body. `validateOnly`
 *  is the sandbox harness's dry run (Google checks the row, writes nothing). */
export function buildGoogleStatusBody(customerId: string, campaignId: string, status: DeliveryStatus, opts: { validateOnly?: boolean } = {}): Record<string, unknown> {
  const cid = customerId.replace(/[^0-9]/g, '');
  const id = campaignId.replace(/[^0-9]/g, '');
  return {
    operations: [{ update: { resourceName: `customers/${cid}/campaigns/${id}`, status: googleStatusLiteral(status) }, updateMask: 'status' }],
    ...(opts.validateOnly ? { validateOnly: true } : {}),
  };
}

// ── ADR 0945 D6 / ADR 0952 — TikTok AI-generated-content self-disclosure ────
// TikTok ads policy requires realistic AI-generated content in an ad to be
// disclosed; Ads Manager has a self-disclosure toggle ("This ad contains
// AI-generated content"). The Marketing API v1.3 documents the creative field
// `aigc_disclosure_type` ("whether to turn on the AIGC self-disclosure toggle to
// indicate the ad contains AI-generated content") on Get ads:
// https://business-api.tiktok.com/portal/docs/get-ads/v1.3 (read 2026-10-20).
// The VALUE that turns it on is NOT confirmed from the docs (the page renders
// client-side), so it is `pending_sandbox`: an AI ad to TikTok is refused
// (`aigc_flag_not_verified`, never published unlabelled) until
// `ads-sandbox-verify.mjs tiktok aigc-disclosure` reads the value Ads Manager
// stores on a TEST ad and the operator lists `tiktok` in
// OPENWOP_ADS_VERIFIED_AIGC_FLAGS.
export const TIKTOK_AIGC_FIELD = 'aigc_disclosure_type';
export const TIKTOK_AIGC_SELF_DISCLOSURE = 'SELF_DISCLOSURE';
export const ADS_AIGC_FLAG_STATUS: Readonly<Record<'tiktok', 'live' | 'pending_sandbox'>> = { tiktok: 'pending_sandbox' };
/** Can this host set the platform's AI-content flag on an ad (live)? */
export function adsAigcFlagEnabled(platform: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const status = (ADS_AIGC_FLAG_STATUS as Record<string, 'live' | 'pending_sandbox' | undefined>)[platform];
  if (!status) return false;
  if (status === 'live') return true;
  return (env.OPENWOP_ADS_VERIFIED_AIGC_FLAGS ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(platform);
}

// ── ADR 0952 D2 layer 1 (P2) — platform-native spend ceilings at launch ─────
// Meta campaign `spend_cap`: the campaign stops delivering once its LIFETIME
// spend reaches it, with no polling delay. Meta's campaign reference defines it
// as an "integer value of subunit in your currency with a minimum value of $100
// USD (or approximate local equivalent)" (https://developers.facebook.com/docs/
// marketing-api/reference/ad-campaign-group, from that reference; not re-read
// live — the sandbox `ceiling` check is what verifies it). "Subunit" is Meta's
// own currency unit (the offset table above), so it converts like daily_budget.
// Writers are `pending_sandbox` until `ads-sandbox-verify.mjs meta ceiling`
// passes and the operator lists the platform in OPENWOP_ADS_VERIFIED_CEILING_WRITERS.
export const ADS_CEILING_WRITER_STATUS: Readonly<Record<'meta', 'live' | 'pending_sandbox'>> = { meta: 'pending_sandbox' };
export function adsCeilingWriterEnabled(platform: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const status = (ADS_CEILING_WRITER_STATUS as Record<string, 'live' | 'pending_sandbox' | undefined>)[platform];
  if (!status) return false;
  if (status === 'live') return true;
  return (env.OPENWOP_ADS_VERIFIED_CEILING_WRITERS ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(platform);
}
/** Meta: `POST /{campaign-id}` with this body; `null` for a currency Meta does not support. */
export function buildMetaSpendCapBody(limitMinor: number, currency: string): { spend_cap: number } | null {
  const v = minorToMetaBudget(limitMinor, currency);
  return v === null ? null : { spend_cap: v };
}

// ── ADR 0952 P5 — TikTok and LinkedIn budget and status writers ─────────────
// Built from the platforms' v1.3 / versioned-REST references and NOT yet run
// against either: every writer is `pending_sandbox` (status above; budget below)
// until `ads-sandbox-verify.mjs <tiktok|linkedin> <delivery-status|budget>` passes
// and the operator lists the platform in OPENWOP_ADS_VERIFIED_STATUS_WRITERS /
// OPENWOP_ADS_VERIFIED_BUDGET_WRITERS.
//   TikTok API for Business v1.3: GET /campaign/get/ (fields operation_status,
//   budget, budget_mode), POST /campaign/update/ (budget, major units of the
//   advertiser currency), POST /campaign/status/update/ (operation_status
//   ENABLE | DISABLE). https://business-api.tiktok.com/portal/docs (v1.3).
//   LinkedIn Marketing API (versioned REST): campaign groups and campaigns under
//   /rest/adAccounts/{id}/…, updated with `X-RestLi-Method: PARTIAL_UPDATE` and a
//   `{patch:{$set:{…}}}` body; campaign `dailyBudget {amount, currencyCode}` is a
//   decimal string in major units. https://learn.microsoft.com/linkedin/marketing/
//   integrations/ads/account-structure/create-and-manage-campaigns
export const ADS_BUDGET_WRITER_STATUS: Readonly<Record<'tiktok' | 'linkedin', 'live' | 'pending_sandbox'>> = {
  tiktok: 'pending_sandbox', linkedin: 'pending_sandbox',
};
export function adsBudgetWriterEnabled(platform: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const status = (ADS_BUDGET_WRITER_STATUS as Record<string, 'live' | 'pending_sandbox' | undefined>)[platform];
  if (!status) return false;
  if (status === 'live') return true;
  return (env.OPENWOP_ADS_VERIFIED_BUDGET_WRITERS ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(platform);
}
/** TikTok `operation_status` for a delivery status; an invalid runtime value throws (never ENABLE). */
export function tiktokStatusLiteral(s: DeliveryStatus): 'DISABLE' | 'ENABLE' {
  if (s === 'paused') return 'DISABLE';
  if (s === 'active') return 'ENABLE';
  throw new Error('invalid_delivery_status');
}
export function buildTiktokStatusBody(advertiserId: string, campaignId: string, status: DeliveryStatus): Record<string, unknown> {
  return { advertiser_id: advertiserId.replace(/[^0-9]/g, ''), campaign_ids: [campaignId], operation_status: tiktokStatusLiteral(status) };
}
export function buildTiktokBudgetBody(advertiserId: string, campaignId: string, budgetMajor: number): Record<string, unknown> {
  return { advertiser_id: advertiserId.replace(/[^0-9]/g, ''), campaign_id: campaignId, budget: budgetMajor };
}
/** LinkedIn `status` for a delivery status; an invalid runtime value throws (never ACTIVE). */
export function linkedinStatusLiteral(s: DeliveryStatus): 'PAUSED' | 'ACTIVE' {
  if (s === 'paused') return 'PAUSED';
  if (s === 'active') return 'ACTIVE';
  throw new Error('invalid_delivery_status');
}
export function buildLinkedinStatusPatch(status: DeliveryStatus): Record<string, unknown> {
  return { patch: { $set: { status: linkedinStatusLiteral(status) } } };
}
export function buildLinkedinBudgetPatch(amount: string, currencyCode: string): Record<string, unknown> {
  return { patch: { $set: { dailyBudget: { amount, currencyCode } } } };
}


// ── ADR 0952 D6 (P7) — catalog push (Meta Catalog, Google Merchant Center) ──
// Built from the platforms' references and NOT yet run against either:
// `pending_sandbox` until `ads-sandbox-verify.mjs <meta|google> catalog-push`
// passes and the operator lists the platform in OPENWOP_ADS_VERIFIED_CATALOG_PUSH.
//   Meta: POST /{catalog_id}/items_batch, item_type PRODUCT_ITEM, requests of
//   {method: UPDATE|DELETE, data}; `allow_upsert` creates missing items.
//   https://developers.facebook.com/docs/marketing-api/catalog-batch/reference
//   Google: Merchant API products v1 — POST accounts/{account}/productInputs:insert
//   ?dataSource=…, and DELETE …/productInputs/{contentLanguage}~{feedLabel}~{offerId}.
//   https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.productInputs
export const ADS_CATALOG_PUSH_STATUS: Readonly<Record<'meta' | 'google', 'live' | 'pending_sandbox'>> = { meta: 'pending_sandbox', google: 'pending_sandbox' };
export function adsCatalogPushEnabled(platform: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const status = (ADS_CATALOG_PUSH_STATUS as Record<string, 'live' | 'pending_sandbox' | undefined>)[platform];
  if (!status) return false;
  if (status === 'live') return true;
  return (env.OPENWOP_ADS_VERIFIED_CATALOG_PUSH ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(platform);
}
/** The catalog item shape both builders take (the feed's Google-spec item). */
export interface CatalogPushItem {
  id: string; title: string; description: string; link: string; image_link: string; additional_image_link?: string[];
  availability: 'in_stock' | 'out_of_stock'; price: string; condition: 'new'; item_group_id?: string; product_type?: string; brand: string;
}
export const META_CATALOG_BATCH_MAX = 500;
export function buildMetaItemsBatchBody(updates: readonly CatalogPushItem[], deleteIds: readonly string[] = []): Record<string, unknown> {
  return {
    item_type: 'PRODUCT_ITEM',
    allow_upsert: true,
    requests: [
      ...updates.map((i) => ({
        method: 'UPDATE',
        data: {
          id: i.id, title: i.title, description: i.description, link: i.link, image_link: i.image_link,
          ...(i.additional_image_link?.length ? { additional_image_link: i.additional_image_link } : {}),
          // Meta writes availability with a space ("in stock").
          availability: i.availability === 'in_stock' ? 'in stock' : 'out of stock',
          condition: i.condition, price: i.price, brand: i.brand,
          ...(i.item_group_id ? { item_group_id: i.item_group_id } : {}),
          ...(i.product_type ? { product_type: i.product_type } : {}),
        },
      })),
      ...deleteIds.map((id) => ({ method: 'DELETE', data: { id } })),
    ],
  };
}
/** Merchant API ProductInput. `price` "12.34 USD" → amountMicros + currencyCode. */
/** Merchant API products v1 base — hardcoded host; test override only. */
export function merchantApiBase(): string {
  return (process.env.OPENWOP_GOOGLE_MERCHANT_API_BASE ?? 'https://merchantapi.googleapis.com/products/v1').replace(/\/+$/, '');
}
export function buildMerchantProductInput(i: CatalogPushItem, opts: { contentLanguage: string; feedLabel: string }): Record<string, unknown> | null {
  const m = /^([0-9]+(?:\.[0-9]+)?) ([A-Z]{3})$/.exec(i.price);
  if (!m) return null;
  const [whole, frac = ''] = (m[1] as string).split('.');
  const amountMicros = String(BigInt(whole as string) * 1_000_000n + BigInt((frac + '000000').slice(0, 6)));
  return {
    offerId: i.id, contentLanguage: opts.contentLanguage, feedLabel: opts.feedLabel,
    productAttributes: {
      title: i.title, description: i.description, link: i.link, imageLink: i.image_link,
      ...(i.additional_image_link?.length ? { additionalImageLinks: i.additional_image_link } : {}),
      availability: i.availability === 'in_stock' ? 'IN_STOCK' : 'OUT_OF_STOCK', condition: 'NEW',
      price: { amountMicros, currencyCode: m[2] }, brand: i.brand, identifierExists: false,
      ...(i.item_group_id ? { itemGroupId: i.item_group_id } : {}),
      ...(i.product_type ? { productTypes: [i.product_type] } : {}),
    },
  };
}
