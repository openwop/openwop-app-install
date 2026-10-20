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
 * and `google-upload` (P3), all through the adapter's own builders.
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

const CHECKS = { meta: ['conversion'], tiktok: ['conversion', 'metrics'], linkedin: ['metrics'], google: ['google-upload'] };

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
try { json = await res.json(); } catch { json = null; }
const ok = res.ok && (platform !== 'tiktok' || json?.code === 0) && !(check === 'google-upload' && json?.partialFailureError);
transcript.response = { status: res.status, body: json };
transcript.verdict = ok ? 'PASS' : 'FAIL';

const text = JSON.stringify(transcript, null, 2);
if (outPath) writeFileSync(outPath, `${text}\n`);
console.log(text);
process.exit(ok ? 0 : 1);
