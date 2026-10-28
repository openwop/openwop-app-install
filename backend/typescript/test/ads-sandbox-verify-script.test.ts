/**
 * ADR 0907 P1 — `scripts/ads-sandbox-verify.mjs`, the D2 harness. It is never
 * run against a real platform here: these runs point the script's own
 * `OPENWOP_*_API_BASE` overrides at a local fake server.
 *
 * Pins: it REFUSES to send without the sandbox opt-in, a token, and the
 * platform's test marker (a Meta/TikTok `test_event_code`, a test ad account,
 * Google `validateOnly`); it sends the body the ADAPTER's builders produce
 * (`test_event_code` added) and redacts every credential header in the
 * transcript; a platform rejection is a FAIL with exit 1.
 *
 * Sabotage that turns it red: drop the test_event_code refusal; print the
 * token; build the body by hand instead of through adsWire.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'ads-sandbox-verify.mjs');
let srv: http.Server;
let base = '';
let reply: { status: number; body: unknown } = { status: 200, body: { events_received: 1 } };
const hits: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => srv.close(() => r())); });

/** Async on purpose: a synchronous spawn would block this process's event
 *  loop, and the fake platform server lives in it. */
const run = (args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPENWOP_SANDBOX_') && k !== 'OPENWOP_ADS_SANDBOX'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
};

describe('ADR 0907 P1 — ads-sandbox-verify.mjs', () => {
  it('refuses to send without the sandbox opt-in, a token, or the test marker — and calls nothing', async () => {
    const META = { OPENWOP_META_API_BASE: `${base}/meta`, OPENWOP_SANDBOX_META_PIXEL_ID: '1' };
    expect((await run(['meta', 'conversion'], META)).stderr).toMatch(/OPENWOP_ADS_SANDBOX=1/);
    expect((await run(['meta', 'conversion'], { ...META, OPENWOP_ADS_SANDBOX: '1' })).stderr).toMatch(/TOKEN is not set/);
    const noMarker = await run(['meta', 'conversion'], { ...META, OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_META_TOKEN: 'T' });
    expect(noMarker.status).toBe(2);
    expect(noMarker.stderr).toMatch(/TEST_EVENT_CODE is not set/);
    expect((await run(['linkedin', 'metrics'], { OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_LINKEDIN_TOKEN: 'T' })).stderr).toMatch(/TEST ad account/);
    expect((await run(['pinterest', 'conversion'], {})).status).toBe(2);
    expect(hits).toHaveLength(0);
  });

  it('sends the adapter-built body with the test marker, redacts the token, writes a PASS transcript', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ads-sv-')), 't.json');
    const r = await run(['meta', 'conversion', '--out', out], {
      OPENWOP_META_API_BASE: `${base}/meta`, OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_META_TOKEN: 'SECRET_TOKEN',
      OPENWOP_SANDBOX_META_PIXEL_ID: 'PX9', OPENWOP_SANDBOX_META_TEST_EVENT_CODE: 'TEST123',
    });
    expect(r.status, r.stderr).toBe(0);
    const hit = hits.at(-1)!;
    expect(hit.url).toBe('/meta/PX9/events');
    expect(hit.headers.authorization).toBe('Bearer SECRET_TOKEN');
    expect(hit.body.test_event_code).toBe('TEST123');
    expect((hit.body.data as Array<Record<string, unknown>>)[0]).toMatchObject({ event_name: 'Purchase', action_source: 'website' });
    const transcript = readFileSync(out, 'utf8');
    expect(transcript).not.toContain('SECRET_TOKEN');
    expect(JSON.parse(transcript)).toMatchObject({ verdict: 'PASS', platform: 'meta', check: 'conversion', request: { headers: { authorization: '<redacted>' } } });
  });

  it('Google upload goes out with validateOnly; a platform rejection is a FAIL (exit 1)', async () => {
    reply = { status: 200, body: { partialFailureError: { message: 'invalid conversion action' } } };
    try {
      const r = await run(['google', 'google-upload'], {
        OPENWOP_GOOGLE_ADS_API_BASE: `${base}/google`, OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_GOOGLE_TOKEN: 'G',
        OPENWOP_SANDBOX_GOOGLE_DEVELOPER_TOKEN: 'DEV', OPENWOP_SANDBOX_GOOGLE_CUSTOMER_ID: '1234567890',
        OPENWOP_SANDBOX_GOOGLE_CONVERSION_ACTION: 'customers/1234567890/conversionActions/1',
      });
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('DEV"');
      const hit = hits.at(-1)!;
      expect(hit.url).toBe('/google/customers/1234567890:uploadClickConversions');
      expect(hit.body.validateOnly).toBe(true);
      expect(JSON.parse(r.stdout).verdict).toBe('FAIL');
    } finally {
      reply = { status: 200, body: { events_received: 1 } };
    }
  });

  it('ADR 0952 D1 delivery-status: refuses without a TEST account + campaign; Google goes out validateOnly with PAUSED', async () => {
    const refused = await run(['meta', 'delivery-status'], { OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_META_TOKEN: 'T', OPENWOP_SANDBOX_META_ACCOUNT_ID: '1' });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/CAMPAIGN_ID are required/);
    reply = { status: 200, body: { results: [{ resourceName: 'customers/1234567890/campaigns/55' }] } };
    try {
      const r = await run(['google', 'delivery-status'], {
        OPENWOP_GOOGLE_ADS_API_BASE: `${base}/google`, OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_GOOGLE_TOKEN: 'G',
        OPENWOP_SANDBOX_GOOGLE_DEVELOPER_TOKEN: 'DEV', OPENWOP_SANDBOX_GOOGLE_ACCOUNT_ID: '123-456-7890', OPENWOP_SANDBOX_GOOGLE_CAMPAIGN_ID: '55',
      });
      expect(r.status, r.stderr).toBe(0);
      const hit = hits.at(-1)!;
      expect(hit.url).toBe('/google/customers/1234567890/campaigns:mutate');
      expect(hit.body).toEqual({ operations: [{ update: { resourceName: 'customers/1234567890/campaigns/55', status: 'PAUSED' }, updateMask: 'status' }], validateOnly: true });
    } finally {
      reply = { status: 200, body: { events_received: 1 } };
    }
  });

  it('ADR 0952 P2 ceiling (meta): writes spend_cap through the adapter builder and PASSES only when the read-back matches', async () => {
    const env = { OPENWOP_META_API_BASE: `${base}/meta`, OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_META_TOKEN: 'M', OPENWOP_SANDBOX_META_CAMPAIGN_ID: '55', OPENWOP_SANDBOX_META_CEILING_MINOR: '500000', OPENWOP_SANDBOX_META_CURRENCY: 'BHD' };
    try {
      // 500.000 BHD → Meta offset 100 → 50000.
      reply = { status: 200, body: { success: true, spend_cap: '50000' } };
      const pass = await run(['meta', 'ceiling'], env);
      expect(pass.status, pass.stderr).toBe(0);
      expect(hits.at(-2)?.body).toEqual({ spend_cap: 50000 }); // the write; the read-back follows
      reply = { status: 200, body: { success: true, spend_cap: '5000' } }; // stored in another unit
      expect((await run(['meta', 'ceiling'], env)).status).toBe(1);
    } finally {
      reply = { status: 200, body: { events_received: 1 } };
    }
  });

  it('ADR 0952 P5: tiktok/linkedin delivery-status (PAUSED) and budget go out through the adapter builders', async () => {
    try {
      reply = { status: 200, body: { code: 0, message: 'OK', data: {} } };
      const t = await run(['tiktok', 'budget'], { OPENWOP_TIKTOK_ADS_API_BASE: `${base}/tiktok`, OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_TIKTOK_TOKEN: 'TT', OPENWOP_SANDBOX_TIKTOK_ACCOUNT_ID: '7001', OPENWOP_SANDBOX_TIKTOK_CAMPAIGN_ID: '11', OPENWOP_SANDBOX_TIKTOK_BUDGET_MAJOR: '12.5' });
      expect(t.status, t.stderr).toBe(0);
      expect(hits.at(-1)).toMatchObject({ url: '/tiktok/campaign/update/', body: { advertiser_id: '7001', campaign_id: '11', budget: 12.5 } });
      reply = { status: 200, body: {} };
      const l = await run(['linkedin', 'delivery-status'], { OPENWOP_LINKEDIN_ADS_API_BASE: `${base}/li`, OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_LINKEDIN_TOKEN: 'L', OPENWOP_SANDBOX_LINKEDIN_ACCOUNT_ID: '5091', OPENWOP_SANDBOX_LINKEDIN_CAMPAIGN_ID: '21' });
      expect(l.status, l.stderr).toBe(0);
      const hit = hits.at(-1);
      expect(hit?.url).toBe('/li/rest/adAccounts/5091/adCampaignGroups/21');
      expect(hit?.headers['x-restli-method']).toBe('PARTIAL_UPDATE');
      expect(hit?.body).toEqual({ patch: { $set: { status: 'PAUSED' } } });
    } finally {
      reply = { status: 200, body: { events_received: 1 } };
    }
  });

  it('ADR 0945 D6 aigc-disclosure (tiktok, read-only): PASS only when TikTok stores the value the adapter sends', async () => {
    const env = { OPENWOP_TIKTOK_ADS_API_BASE: `${base}/tiktok`, OPENWOP_ADS_SANDBOX: '1', OPENWOP_SANDBOX_TIKTOK_TOKEN: 'TT', OPENWOP_SANDBOX_TIKTOK_ACCOUNT_ID: '7001', OPENWOP_SANDBOX_TIKTOK_AD_ID: '99' };
    try {
      reply = { status: 200, body: { code: 0, data: { list: [{ ad_id: '99', aigc_disclosure_type: 'SELF_DISCLOSURE' }] } } };
      const pass = await run(['tiktok', 'aigc-disclosure'], env);
      expect(pass.status, pass.stderr).toBe(0);
      expect(hits.at(-1)?.url).toMatch(/^\/tiktok\/ad\/get\/\?advertiser_id=7001/);
      // Any other stored value (or none) is a FAIL: the adapter's value is not proven.
      reply = { status: 200, body: { code: 0, data: { list: [{ ad_id: '99', aigc_disclosure_type: 'OTHER' }] } } };
      expect((await run(['tiktok', 'aigc-disclosure'], env)).status).toBe(1);
    } finally {
      reply = { status: 200, body: { events_received: 1 } };
    }
  });
});
