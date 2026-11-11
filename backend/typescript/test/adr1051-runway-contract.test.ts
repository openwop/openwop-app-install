/**
 * ADR 1051 D2 — the text/image-to-video adapter speaks Runway's PUBLISHED API.
 *
 * The fixture `fixtures/runway-openapi-2024-11-06.json` is a trimmed parse of the
 * OpenAPI document embedded in https://docs.dev.runwayml.com/api/ (info.version
 * 2024-11-06, read 2026-11-03): the server, the version header, and per endpoint
 * each model's ratio set and duration rule. Plus the outputs guide's note that
 * task outputs are CloudFront URLs. No live fetch: the test pins our defaults
 * and our model table to that saved reading.
 *
 * RED on unmodified main `ec97cbb21`: the base was `api.runwayml.com`, the default
 * model `gen3a_turbo` (in neither endpoint), the ratio `1280:768` (valid for no
 * model), no duration was sent (gen4.5 requires one), and a CloudFront result URL
 * was refused by a `runwayml.com`-only allowlist after the job was paid for.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ModelRule { ratios: string[] | null; duration: { enum?: number[]; minimum?: number; maximum?: number } | null; required: string[] }
interface Fixture { servers: { url: string }[]; versionHeader: string; endpoints: Record<string, Record<string, ModelRule>> }
const SPEC = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runway-openapi-2024-11-06.json'), 'utf8')) as Fixture;
/** Runway's own endpoint paths, read from the fixture's keys (never restated here). */
const endpointPath = (suffix: string): string => {
  const key = Object.keys(SPEC.endpoints).find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`fixture has no ${suffix} endpoint`);
  return key;
};
const T2V_PATH = endpointPath('text_to_video');
const I2V_PATH = endpointPath('image_to_video');

const posts: { url: string; body: Record<string, unknown>; extraHeaders?: Record<string, string> }[] = [];
const fetched: string[] = [];
const polls: { actingUserId?: string; connectionId?: string }[] = [];

vi.mock('../src/host/brokeredEgress.js', () => ({
  brokeredPost: vi.fn(async (_deps: unknown, opts: { url: string; body: string; extraHeaders?: Record<string, string> }) => {
    posts.push({ url: opts.url, body: JSON.parse(opts.body) as Record<string, unknown>, ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}) });
    return { outcome: 'sent', res: new Response(JSON.stringify({ id: 'task-1' }), { status: 200 }), provenance: { connectionId: 'conn-1', provider: 'runway', scopeAxis: 'user', scopeChecked: true } };
  }),
  brokeredFetch: vi.fn(async (d: { actingUserId?: string }, opts: { connectionId?: string }) => {
    polls.push({ actingUserId: d.actingUserId, connectionId: opts.connectionId });
    return { outcome: 'sent', res: new Response(JSON.stringify({ status: 'RUNNING' }), { status: 200 }) };
  }),
}));
vi.mock('../src/host/webhookEgressGuard.js', () => ({
  guardedEgressFetch: vi.fn(async (url: string) => {
    fetched.push(url);
    return new Response(new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '8' } });
  }),
}));

const { makeT2VAdapter } = await import('../src/features/creative-video/host/t2vProviderAdapter.js');
const { RUNWAY_MODELS, RUNWAY_API_BASE, RUNWAY_API_VERSION, resolveRunwayRequest } = await import('../src/features/creative-video/host/runwayModels.js');

const deps = { storage: {} as never, tenantId: 't', runId: 'r', actingUserId: 'u', orgId: 'o' };

function satisfiesDuration(rule: ModelRule['duration'], d: unknown): boolean {
  if (typeof d !== 'number' || !Number.isInteger(d)) return false;
  if (!rule) return true;
  if (rule.enum) return rule.enum.includes(d);
  return (rule.minimum === undefined || d >= rule.minimum) && (rule.maximum === undefined || d <= rule.maximum);
}

beforeEach(() => { posts.length = 0; fetched.length = 0; polls.length = 0; });
afterEach(() => { delete process.env.OPENWOP_T2V_API_BASE; });

describe('ADR 1051 D2 — the default request is one Runway accepts', () => {
  it('text-to-video: the spec server, the version header, a listed model, its ratio and a duration it allows', async () => {
    const out = await makeT2VAdapter(deps).submitJob({ script: 'A lighthouse at dusk', avatarId: '' });
    expect(out.ok).toBe(true);
    const p = posts[0]!;
    expect(p.url).toBe(`${SPEC.servers[0]!.url}${T2V_PATH}`);
    expect(p.extraHeaders?.['X-Runway-Version']).toBe(SPEC.versionHeader);
    const rule = SPEC.endpoints[T2V_PATH]![String(p.body.model)];
    expect(rule, `model ${String(p.body.model)} is in the spec's text_to_video set`).toBeDefined();
    expect(rule!.ratios).toContain(p.body.ratio);
    expect(satisfiesDuration(rule!.duration, p.body.duration), `duration ${String(p.body.duration)}`).toBe(true);
    for (const field of rule!.required) expect(p.body, `required field ${field}`).toHaveProperty(field);
  });

  it('image-to-video: same, against the image_to_video set', async () => {
    await makeT2VAdapter(deps).submitJob({ script: 'Slow pan', avatarId: '', promptImage: 'data:image/png;base64,AAAA' });
    const p = posts[0]!;
    expect(p.url).toBe(`${SPEC.servers[0]!.url}${I2V_PATH}`);
    const rule = SPEC.endpoints[I2V_PATH]![String(p.body.model)];
    expect(rule).toBeDefined();
    expect(rule!.ratios).toContain(p.body.ratio);
    expect(satisfiesDuration(rule!.duration, p.body.duration)).toBe(true);
    for (const field of rule!.required) expect(p.body).toHaveProperty(field);
  });
});

describe('ADR 1051 D2 — a completed job can be downloaded', () => {
  it('a CloudFront output URL (the host the outputs guide names) is fetched, not refused', async () => {
    const out = await makeT2VAdapter(deps).downloadResult('https://dnznrvs05pmza.cloudfront.net/output.mp4?_jwt=x');
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(fetched).toEqual(['https://dnznrvs05pmza.cloudfront.net/output.mp4?_jwt=x']);
  });

  it('…but an operator-overridden base does not inherit the CloudFront allowance', async () => {
    process.env.OPENWOP_T2V_API_BASE = 'https://api.other-vendor.example';
    const out = await makeT2VAdapter(deps).downloadResult('https://dnznrvs05pmza.cloudfront.net/output.mp4');
    expect(out).toEqual({ ok: false, error: 'video_result_url_host_denied:dnznrvs05pmza.cloudfront.net' });
    expect(fetched).toEqual([]);
  });
});

describe('ADR 1051 D2 — the model table is a subset of the spec', () => {
  it('the base and version header are the spec\'s', () => {
    expect(RUNWAY_API_BASE).toBe(SPEC.servers[0]!.url);
    expect(RUNWAY_API_VERSION).toBe(SPEC.versionHeader);
  });

  for (const m of RUNWAY_MODELS) {
    it(`${m.id}: every ratio and every allowed duration is one the spec takes`, () => {
      for (const [endpoint, ratios] of Object.entries(m.ratios)) {
        const rule = SPEC.endpoints[endpoint === 't2v' ? T2V_PATH : I2V_PATH]![m.id];
        expect(rule, `${m.id} on ${endpoint}`).toBeDefined();
        for (const r of ratios ?? []) expect(rule!.ratios, `${m.id} ${endpoint} ratio ${r}`).toContain(r);
        const durations = 'oneOf' in m.duration ? [...m.duration.oneOf] : [m.duration.min, m.duration.max];
        for (const d of [...durations, m.defaultDurationSec]) expect(satisfiesDuration(rule!.duration, d), `${m.id} ${endpoint} ${d}s`).toBe(true);
      }
    });
  }

  it('a model, ratio or duration outside the table is refused, with the field named', () => {
    expect(resolveRunwayRequest('t2v', { model: 'gen3a_turbo' })).toMatchObject({ ok: false, field: 'model' });
    expect(resolveRunwayRequest('t2v', { model: 'gen4_turbo' }), 'gen4_turbo is image-to-video only').toMatchObject({ ok: false, field: 'model' });
    expect(resolveRunwayRequest('t2v', { ratio: '1280:768' })).toMatchObject({ ok: false, field: 'ratio' });
    expect(resolveRunwayRequest('t2v', { model: 'veo3.1', durationSec: 5 })).toMatchObject({ ok: false, field: 'durationSec' });
    expect(resolveRunwayRequest('i2v', { portrait: true })).toEqual({ ok: true, value: { model: 'gen4.5', ratio: '720:1280', durationSec: 5 } });
  });

  it('the adapter refuses a bad model before the dial (a provable refusal, no POST)', async () => {
    const out = await makeT2VAdapter(deps).submitJob({ script: 'x', avatarId: '', model: 'gen3a_turbo' });
    expect(out).toEqual({ ok: false, error: 't2v_invalid_model' });
    expect(posts).toEqual([]);
  });
});

describe('ADR 1051 D10 — polling pins the submit\'s connection and person', () => {
  it('a pinned adapter polls with the submitter as the acting user and the exact connection', async () => {
    await makeT2VAdapter({ ...deps, actingUserId: 'user:reader' }, { connectionId: 'conn-writer', actingUserId: 'user:writer' }).pollJob('task-1');
    expect(polls).toEqual([{ actingUserId: 'user:writer', connectionId: 'conn-writer' }]);
  });

  it('an unpinned adapter (the submit itself) does not pin', async () => {
    await makeT2VAdapter(deps).pollJob('task-1');
    expect(polls).toEqual([{ actingUserId: 'u', connectionId: undefined }]);
  });
});
