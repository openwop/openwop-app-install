/**
 * ADR 0858 P4 (2026-10-10) — two v2 discovery fixes.
 *
 * 1. `scheduling` is projected. The v1 root carried it (only behind the test
 *    seam); the v2 root never did, so since the cut no served document said
 *    what the v0.3.0 CHANGELOG told adopters (`maxFutureHorizon: P366D`). Each
 *    facet is asserted against the source the behaviour reads, and the served
 *    record is validated against its v2 schema seat.
 * 2. `auth.subjectLinkKey` is stated ONLY when both the `saml` and `scim` lanes
 *    are (spec-steward ruling 2026-10-10: identity.md §3 — a link joins exactly
 *    two subjects, so a one-lane host forms none). The v2 auth facet schema does
 *    not enforce this, so this file is the guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createApp, loadConfigFromEnv } from '../src/index.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { MAX_FUTURE_HORIZON_ISO, ONE_SHOT_CRON } from '../src/host/schedulingService.js';
import { SUBJECT_LINK_KEY } from '../src/host/auth/subjectLinkService.js';
import { corpusSchema } from './support/corpusSchema.js';

let server: http.Server;
let BASE = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** The SERVED v2 root, as a v2 client reads it. */
async function served(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A validator for one family's seat, compiled through the whole v2 tree so sibling `$ref`s resolve. */
function seatValidator(family: string): ReturnType<Ajv2020['compile']> {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const caps = corpusSchema('v2/capabilities.schema.json') as { $id?: string };
  const dir = dirname(createRequire(`${process.cwd()}/`).resolve('@openwop/spec-artifacts/schemas/v2/capabilities.schema.json'));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try { ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>); } catch { /* a malformed sibling is its own test's problem */ }
  }
  return ajv.compile({ $ref: `${caps.$id ?? ''}#/properties/${family}` });
}

describe('ADR 0858 P4 — scheduling is advertised at v2, from its sources', () => {
  it('the served record validates against the v2 `scheduling` seat', async () => {
    const rec = (await served())['scheduling'];
    expect(rec, 'the v2 root must carry scheduling (the daemon runs on every boot)').toBeDefined();
    const validate = seatValidator('scheduling');
    expect(validate(rec), JSON.stringify(validate.errors ?? [])).toBe(true);
    // Non-vacuity of the validator: a facet the closed seat does not declare fails.
    expect(validate({ ...(rec as object), notAFacet: true })).toBe(false);
  });

  it('maxFutureHorizon is the constant the refusal reads', async () => {
    const rec = (await served())['scheduling'] as Record<string, unknown>;
    expect(rec['maxFutureHorizon']).toBe(MAX_FUTURE_HORIZON_ISO);
    expect(MAX_FUTURE_HORIZON_ISO).toBe('P366D'); // the v0.3.0 CHANGELOG value
  });

  it('cron and delayed are claimed; calendar is not (no calendar-reference schedule exists)', async () => {
    const rec = (await served())['scheduling'] as Record<string, unknown>;
    expect(rec['cron']).toBe(true);
    // `delayed` is the one-shot cadence (ADR 0309 D1); its sentinel must exist.
    expect(ONE_SHOT_CRON).toBe('once');
    expect(rec['delayed']).toBe(true);
    expect(rec).not.toHaveProperty('calendar');
  });

  it('the horizon is enforced, and the refusal echoes the advertised cap', async () => {
    const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
    const res = await fetch(`${BASE}/host/openwop-app/scheduler/jobs`, {
      method: 'POST', headers: H, body: JSON.stringify({ cronExpr: '0 0 31 2 *', workflowId: 'wf.never' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; details?: { maxFutureHorizon?: string } };
    expect(body.error).toBe('schedule_horizon_exceeded');
    expect(body.details?.maxFutureHorizon).toBe(((await served())['scheduling'] as Record<string, unknown>)['maxFutureHorizon']);
  });
});

describe('ADR 0858 P4 — auth.subjectLinkKey only when BOTH saml and scim lanes are advertised (steward ruling 2026-10-10)', () => {
  const SAML_SEAM = { OPENWOP_TEST_SAML_IDP_URL: 'http://127.0.0.1:1/idp' };
  const SCIM_SEAM = { OPENWOP_TEST_SCIM_URL: 'http://127.0.0.1:1/scim' };
  const KEYS = ['OPENWOP_TEST_SAML_IDP_URL', 'OPENWOP_TEST_SCIM_URL', 'OPENWOP_SCIM_BEARER', 'OPENWOP_SCIM_IDP_ENTITY_ID', 'OPENWOP_SAML_TENANT', 'OPENWOP_SCIM_TENANT',
    'OPENWOP_SAML_IDP_SSO_URL', 'OPENWOP_SAML_IDP_CERT', 'OPENWOP_SAML_SP_ENTITY_ID', 'OPENWOP_SAML_ACS_URL'];

  function authWith(env: Record<string, string>): { lanes: string[]; rec: Record<string, unknown> } {
    const prior = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    try {
      const rec = buildV2Advertisement(loadConfigFromEnv())['auth'] as Record<string, unknown>;
      return { lanes: ((rec['lanes'] as Array<{ lane: string }> | undefined) ?? []).map((l) => l.lane), rec };
    } finally {
      for (const k of KEYS) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
    }
  }

  it('neither lane ⇒ no key', () => {
    const { lanes, rec } = authWith({});
    expect(lanes).not.toContain('saml');
    expect(lanes).not.toContain('scim');
    expect(rec).not.toHaveProperty('subjectLinkKey');
  });

  it('SAML only ⇒ no key', () => {
    const { lanes, rec } = authWith(SAML_SEAM);
    expect(lanes).toContain('saml');
    expect(lanes).not.toContain('scim');
    expect(rec).not.toHaveProperty('subjectLinkKey');
  });

  it('SCIM only ⇒ no key', () => {
    // A bearer advertises SCIM; no SAML is configured, so the realms align and
    // the trust-root seat keeps the lane.
    const { lanes, rec } = authWith({ OPENWOP_SCIM_BEARER: 'b-0123456789abcdef', OPENWOP_SCIM_IDP_ENTITY_ID: 'https://idp.example.test/x' });
    expect(lanes).toContain('scim');
    expect(lanes).not.toContain('saml');
    expect(rec).not.toHaveProperty('subjectLinkKey');
  });

  it('both lanes ⇒ the key, from the constant the link path joins on', () => {
    const { lanes, rec } = authWith({ ...SAML_SEAM, ...SCIM_SEAM });
    expect(lanes).toEqual(expect.arrayContaining(['saml', 'scim']));
    expect(rec['subjectLinkKey']).toBe(SUBJECT_LINK_KEY);
  });
});
