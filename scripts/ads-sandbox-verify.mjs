#!/usr/bin/env node
/**
 * ADR 0907 D2 — sandbox verification for ad-platform readers and senders.
 *
 * A platform reader or sender stays `unsupported` (honest-OFF) until it has been
 * exercised against that platform's TEST surface. This script is that exercise,
 * recorded: it sends ONE request built by the SAME pure builders the adapter uses
 * (`backend/typescript/src/host/adsWire.ts`, bundled here at run time with
 * esbuild), and writes a transcript with the token redacted. The transcript is
 * what the ADR's implementation record cites.
 *
 * IT NEVER RUNS BY ITSELF. Nothing in `npm run ci` calls it, and it refuses to
 * send unless all of these hold:
 *   - OPENWOP_ADS_SANDBOX=1
 *   - a token in the environment (never read from BYOK, the broker or a file)
 *   - for a send, the platform's TEST marker, so it cannot touch live reporting:
 *       meta    conversion  OPENWOP_SANDBOX_META_TEST_EVENT_CODE    (Events Manager > Test events)
 *       tiktok  conversion  OPENWOP_SANDBOX_TIKTOK_TEST_EVENT_CODE  (Events Manager > Test events)
 *       google  google-upload  sent with `validateOnly: true` — Google checks the
 *               row and stores nothing; needs OPENWOP_SANDBOX_GOOGLE_DEVELOPER_TOKEN,
 *               _CUSTOMER_ID and _CONVERSION_ACTION (a test-account resource name)
 *   - for a read (`metrics`, read-only), a TEST ad account id:
 *       tiktok  metrics     OPENWOP_SANDBOX_TIKTOK_ACCOUNT_ID       (a sandbox advertiser)
 *       linkedin metrics    OPENWOP_SANDBOX_LINKEDIN_ACCOUNT_ID     (a test ad account)
 *
 * A PASS on `metrics` is what lets an operator add the platform to
 * OPENWOP_ADS_VERIFIED_READERS (ADR 0907 D2); cite the transcript in the ADR.
 *
 * Usage:
 *   OPENWOP_ADS_SANDBOX=1 \
 *   OPENWOP_SANDBOX_META_TOKEN=... OPENWOP_SANDBOX_META_PIXEL_ID=... \
 *   OPENWOP_SANDBOX_META_TEST_EVENT_CODE=TEST123 \
 *     node scripts/ads-sandbox-verify.mjs meta conversion [--out transcript.json]
 *
 *   node scripts/ads-sandbox-verify.mjs --dry meta conversion   # print the request, send nothing
 *
 * Checks: `conversion` (meta, tiktok — P0), `metrics` (tiktok, linkedin — P2)
 * `google-upload` (P3) and `delivery-status` (ADR 0952 D1: meta, google — PAUSED
 * only; Google validateOnly, Meta on a named TEST campaign), `aigc-disclosure` (ADR 0945
 * D6: tiktok, READ-ONLY — reads back the AIGC flag value Ads Manager stores on a TEST
 * ad, needs _ACCOUNT_ID and _AD_ID), `catalog-push` (ADR 0952 D6: meta, google —
 * upserts ONE test item `sandbox-verify-item` into a TEST catalog / Merchant data
 * source; meta needs _CATALOG_ID, google _MERCHANT_ACCOUNT_ID and
 * _MERCHANT_DATA_SOURCE), all through the adapter's own builders.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, '..', 'backend', 'typescript');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
const [platform, check] = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));

const CHECKS = { meta: ['conversion', 'delivery-status', 'ceiling', 'catalog-push'], tiktok: ['conversion', 'metrics', 'aigc-disclosure', 'delivery-status', 'budget'], linkedin: ['metrics', 'delivery-status', 'budget'], google: ['google-upload', 'delivery-status', 'catalog-push'] };

function die(msg) {
  console.error(`ads-sandbox-verify: ${msg}`);
  process.exit(2);
}

if (!platform || !CHECKS[platform]) die(`platform must be one of: ${Object.keys(CHECKS).join(', ')} (google/linkedin checks land with ADR 0907 P1–P3)`);
if (!CHECKS[platform].includes(check)) die(`check for ${platform} must be one of: ${CHECKS[platform].join(', ')}`);

const env = (name) => process.env[name]?.trim() || undefined;
const P = platform.toUpperCase();
const token = env(`OPENWOP_SANDBOX_${P}_TOKEN`);
const pixelId = env(`OPENWOP_SANDBOX_${P}_PIXEL_ID`);
const testCode = env(`OPENWOP_SANDBOX_${P}_TEST_EVENT_CODE`);
const accountId = env(`OPENWOP_SANDBOX_${P}_ACCOUNT_ID`);

if (!dry) {
  if (process.env.OPENWOP_ADS_SANDBOX !== '1') die('refusing to send: set OPENWOP_ADS_SANDBOX=1 to confirm this is a sandbox run');
  if (!token) die(`refusing to send: OPENWOP_SANDBOX_${P}_TOKEN is not set`);
  if (check === 'conversion' && !testCode) die(`refusing to send: OPENWOP_SANDBOX_${P}_TEST_EVENT_CODE is not set — without it the event would reach live reporting`);
}
if (check === 'conversion' && !pixelId) die(`OPENWOP_SANDBOX_${P}_PIXEL_ID is not set`);
const gDev = env('OPENWOP_SANDBOX_GOOGLE_DEVELOPER_TOKEN');
const gCustomer = env('OPENWOP_SANDBOX_GOOGLE_CUSTOMER_ID');
const gAction = env('OPENWOP_SANDBOX_GOOGLE_CONVERSION_ACTION');
if (check === 'google-upload' && (!gCustomer || !gAction)) die('OPENWOP_SANDBOX_GOOGLE_CUSTOMER_ID and OPENWOP_SANDBOX_GOOGLE_CONVERSION_ACTION are required');
if (check === 'google-upload' && !dry && !gDev) die('refusing to send: OPENWOP_SANDBOX_GOOGLE_DEVELOPER_TOKEN is not set');
if (check === 'metrics' && !accountId) die(`OPENWOP_SANDBOX_${P}_ACCOUNT_ID is not set (a TEST ad account)`);
// ADR 0952 D1 — delivery status. It writes PAUSED (the safe direction) to ONE named
// campaign in a TEST account. Google sends validateOnly, so nothing changes; Meta has
// no validate-only mode, so the campaign MUST be a test-account campaign.
const campaignId = env(`OPENWOP_SANDBOX_${P}_CAMPAIGN_ID`);
if (check === 'delivery-status' && (!accountId || !campaignId)) die(`OPENWOP_SANDBOX_${P}_ACCOUNT_ID and OPENWOP_SANDBOX_${P}_CAMPAIGN_ID are required (a TEST account and one of its campaigns)`);
if (check === 'delivery-status' && platform === 'google' && !dry && !gDev) die('refusing to send: OPENWOP_SANDBOX_GOOGLE_DEVELOPER_TOKEN is not set');
// ADR 0945 D6 — the TikTok AIGC flag. READ-ONLY: turn on "This ad contains
// AI-generated content" on ONE ad in a TEST advertiser in Ads Manager, then this reads
// back the value TikTok stores in `aigc_disclosure_type`. It passes only when that
// value is the one the adapter sends, which is what lets an operator list `tiktok`
// in OPENWOP_ADS_VERIFIED_AIGC_FLAGS.
const adId = env(`OPENWOP_SANDBOX_${P}_AD_ID`);
// ADR 0952 P2 — the Meta native ceiling. It writes `spend_cap` on ONE named TEST
// campaign through the adapter's builder (minor units of the given currency →
// Meta's unit), then reads it back: the PASS proves the unit, not just acceptance.
const ceilingMinor = Number(env(`OPENWOP_SANDBOX_${P}_CEILING_MINOR`) ?? 1_000_000); // 10,000.00 in a 2-decimal currency
const ceilingCurrency = env(`OPENWOP_SANDBOX_${P}_CURRENCY`) ?? 'USD';
// ADR 0952 P5 — TikTok/LinkedIn writers. delivery-status writes PAUSED (the safe
// direction) to ONE named TEST campaign (LinkedIn: a campaign GROUP); budget writes
// a daily budget in major units to ONE named TEST campaign (LinkedIn: a campaign).
const budgetMajor = env(`OPENWOP_SANDBOX_${P}_BUDGET_MAJOR`) ?? '10.00';
const budgetCurrency = env(`OPENWOP_SANDBOX_${P}_CURRENCY`) ?? 'USD';
if (check === 'budget' && (!accountId || !campaignId)) die(`OPENWOP_SANDBOX_${P}_ACCOUNT_ID and OPENWOP_SANDBOX_${P}_CAMPAIGN_ID are required (a TEST account and one of its campaigns)`);
if (check === 'ceiling' && !campaignId) die(`OPENWOP_SANDBOX_${P}_CAMPAIGN_ID is required (a campaign in a TEST ad account)`);
// ADR 0952 D6 (P7) — catalog push. Upserts ONE item, `sandbox-verify-item`, into a
// TEST Meta catalog or a TEST Merchant Center data source through the adapter's own
// builders. A PASS is what lets an operator list the platform in
// OPENWOP_ADS_VERIFIED_CATALOG_PUSH. Delete the item afterwards in the platform UI.
const catalogId = env(`OPENWOP_SANDBOX_${P}_CATALOG_ID`);
const merchantAccount = env('OPENWOP_SANDBOX_GOOGLE_MERCHANT_ACCOUNT_ID');
const merchantDataSource = env('OPENWOP_SANDBOX_GOOGLE_MERCHANT_DATA_SOURCE');
if (check === 'catalog-push' && platform === 'meta' && !catalogId) die('OPENWOP_SANDBOX_META_CATALOG_ID is required (a catalog in a TEST business)');
if (check === 'catalog-push' && platform === 'google' && (!merchantAccount || !merchantDataSource)) die('OPENWOP_SANDBOX_GOOGLE_MERCHANT_ACCOUNT_ID and OPENWOP_SANDBOX_GOOGLE_MERCHANT_DATA_SOURCE (accounts/<id>/dataSources/<id>) are required');
if (check === 'aigc-disclosure' && (!accountId || !adId)) die(`OPENWOP_SANDBOX_${P}_ACCOUNT_ID and OPENWOP_SANDBOX_${P}_AD_ID are required (a TEST advertiser and one ad with the AIGC toggle ON)`);

// Bundle the dependency-free wire module so this script and the adapter share
// one builder. esbuild is a backend devDependency.
const require = createRequire(join(backend, 'package.json'));
const esbuild = require('esbuild');
const bundled = await esbuild.build({
  entryPoints: [join(backend, 'src', 'host', 'adsWire.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const wire = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const event = {
  pixelId,
  eventId: `sandbox-${randomUUID()}`,
  eventName: platform === 'meta' ? 'Purchase' : 'CompletePayment',
  eventTimeIso: new Date().toISOString(),
  emailHash: createHash('sha256').update('sandbox-verify@example.com').digest('hex'),
  value: 1,
  currency: 'USD',
};

let url;
let headers;
let body;
let method = 'POST';
const until = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
if (check === 'metrics') {
  method = 'GET';
  const q = { adAccountId: accountId ?? '<unset>', level: 'campaign', since, until };
  if (platform === 'tiktok') {
    url = wire.buildTiktokReportUrl(wire.tiktokApiBase(), q, 1, 1000);
    headers = { 'access-token': token ?? '<unset>' };
  } else {
    url = wire.buildLinkedinAnalyticsUrl(wire.linkedinApiBase(), q);
    headers = { authorization: `Bearer ${token ?? '<unset>'}`, 'LinkedIn-Version': wire.LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' };
  }
} else if (check === 'aigc-disclosure') {
  method = 'GET';
  const params = new URLSearchParams({
    advertiser_id: (accountId ?? '').replace(/[^0-9]/g, ''),
    filtering: JSON.stringify({ ad_ids: [adId ?? ''] }),
    fields: JSON.stringify(['ad_id', wire.TIKTOK_AIGC_FIELD]),
  });
  url = `${wire.tiktokApiBase()}/ad/get/?${params.toString()}`;
  headers = { 'access-token': token ?? '<unset>' };
} else if (check === 'ceiling') {
  url = `${wire.metaApiBase()}/${encodeURIComponent(campaignId ?? '')}`;
  headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? '<unset>'}` };
  body = wire.buildMetaSpendCapBody(ceilingMinor, ceilingCurrency);
  if (!body) die(`${ceilingCurrency} is not a Meta ad-account currency`);
} else if (check === 'catalog-push') {
  const item = {
    id: 'sandbox-verify-item', title: 'OpenWOP sandbox verify item', description: 'A test item written by ads-sandbox-verify (ADR 0952 D6).',
    link: 'https://example.com/sandbox-verify-item', image_link: 'https://example.com/sandbox-verify-item.png',
    availability: 'in_stock', price: '1.00 USD', condition: 'new', brand: 'OpenWOP sandbox',
  };
  headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? '<unset>'}` };
  if (platform === 'meta') {
    url = `${wire.metaApiBase()}/${encodeURIComponent(catalogId ?? '')}/items_batch`;
    body = wire.buildMetaItemsBatchBody([item]);
  } else {
    url = `${wire.merchantApiBase()}/accounts/${encodeURIComponent(merchantAccount ?? '')}/productInputs:insert?dataSource=${encodeURIComponent(merchantDataSource ?? '')}`;
    body = wire.buildMerchantProductInput(item, { contentLanguage: 'en', feedLabel: 'US' });
  }
} else if (check === 'budget') {
  if (platform === 'tiktok') {
    url = `${wire.tiktokApiBase()}/campaign/update/`;
    headers = { 'content-type': 'application/json', 'access-token': token ?? '<unset>' };
    body = wire.buildTiktokBudgetBody(accountId ?? '', campaignId ?? '', Number(budgetMajor));
  } else {
    url = `${wire.linkedinApiBase()}/rest/adAccounts/${(accountId ?? '').replace(/[^0-9]/g, '')}/adCampaigns/${campaignId}`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? '<unset>'}`, 'LinkedIn-Version': wire.LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'PARTIAL_UPDATE' };
    body = wire.buildLinkedinBudgetPatch(budgetMajor, budgetCurrency);
  }
} else if (check === 'delivery-status' && platform === 'tiktok') {
  url = `${wire.tiktokApiBase()}/campaign/status/update/`;
  headers = { 'content-type': 'application/json', 'access-token': token ?? '<unset>' };
  body = wire.buildTiktokStatusBody(accountId ?? '', campaignId ?? '', 'paused');
} else if (check === 'delivery-status' && platform === 'linkedin') {
  url = `${wire.linkedinApiBase()}/rest/adAccounts/${(accountId ?? '').replace(/[^0-9]/g, '')}/adCampaignGroups/${campaignId}`;
  headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? '<unset>'}`, 'LinkedIn-Version': wire.LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'PARTIAL_UPDATE' };
  body = wire.buildLinkedinStatusPatch('paused');
} else if (check === 'delivery-status') {
  if (platform === 'meta') {
    url = `${wire.metaApiBase()}/${encodeURIComponent(campaignId ?? '')}`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? '<unset>'}` };
    body = wire.buildMetaStatusBody('paused');
  } else {
    url = `${wire.googleApiBase()}/customers/${(accountId ?? '').replace(/[^0-9]/g, '')}/campaigns:mutate`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? '<unset>'}`, 'developer-token': gDev ?? '<unset>' };
    body = wire.buildGoogleStatusBody(accountId ?? '', campaignId ?? '', 'paused', { validateOnly: true });
  }
} else if (check === 'google-upload') {
  url = `${wire.googleApiBase()}/customers/${(gCustomer ?? '').replace(/[^0-9]/g, '')}:uploadClickConversions`;
  headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? '<unset>'}`, 'developer-token': gDev ?? '<unset>' };
  // validateOnly: Google validates the row and stores nothing (the test marker for uploads).
  body = { ...wire.buildGoogleClickConversionBody({ ...event, conversionAction: gAction ?? '<unset>', consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' } }), validateOnly: true };
} else if (platform === 'meta') {
  url = `${wire.metaApiBase()}/${encodeURIComponent(pixelId)}/events`;
  headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? '<unset>'}` };
  body = { ...wire.buildMetaConversionBody(event), test_event_code: testCode ?? '<unset>' };
} else {
  url = `${wire.tiktokApiBase()}/event/track/`;
  headers = { 'content-type': 'application/json', 'access-token': token ?? '<unset>' };
  body = { ...wire.buildTiktokConversionBody(event), test_event_code: testCode ?? '<unset>' };
}

const redact = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /authorization|access-token|developer-token/i.test(k) ? '<redacted>' : v]));
const transcript = {
  adr: '0907 D2', platform, check, at: new Date().toISOString(),
  pinnedVersion: wire.ADS_API_VERSIONS[platform].version,
  request: { method, url, headers: redact(headers), ...(body ? { body } : {}) },
};

if (dry) {
  console.log(JSON.stringify(transcript, null, 2));
  process.exit(0);
}

const res = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
let json;
try { json = await res.json(); } catch { json = null; } // a LinkedIn PARTIAL_UPDATE answers 204 with no body
const aigcValue = check === 'aigc-disclosure' ? json?.data?.list?.[0]?.[wire.TIKTOK_AIGC_FIELD] : undefined;
const ok = res.ok && (platform !== 'tiktok' || json?.code === 0)
  && !(check === 'aigc-disclosure' && aigcValue !== wire.TIKTOK_AIGC_SELF_DISCLOSURE) && !(check === 'google-upload' && json?.partialFailureError) && !(check === 'delivery-status' && platform === 'meta' && json?.success !== true)
  && !(check === 'catalog-push' && platform === 'meta' && (!(json?.handles?.length > 0) || (json?.validation_status ?? []).some((v) => v?.errors?.length)));
transcript.response = { status: res.status, body: json };
let okFinal = ok && !(check === 'ceiling' && json?.success !== true);
if (check === 'ceiling' && okFinal) {
  const back = await fetch(`${url}?fields=spend_cap`, { headers: { authorization: headers.authorization } });
  let bj; try { bj = await back.json(); } catch { bj = null; }
  transcript.readBack = { status: back.status, body: bj };
  okFinal = back.ok && Number(bj?.spend_cap) === body.spend_cap;
}
transcript.verdict = okFinal ? 'PASS' : 'FAIL';

const text = JSON.stringify(transcript, null, 2);
if (outPath) writeFileSync(outPath, `${text}\n`);
console.log(text);
process.exit(okFinal ? 0 : 1);
