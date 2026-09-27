/**
 * ADR 0545 row 8 — the answer bank is SUBJECT-scoped at the HTTP boundary.
 *
 * The service test pins that the store keys on the subject. Only a real request
 * establishes the part that matters: the subject comes from the SESSION and
 * there is no parameter — path, query or body — through which a caller can name
 * someone else. A store that keys correctly behind a route that accepts
 * `?subjectId=` is not subject-scoped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { assertFlatErrorEnvelope, detailOf } from './helpers/errorEnvelope.js';

const BASE_PATH = '/v1/host/openwop-app/job-search/me/answers';
let server: Server;
let BASE: string;

async function login(email: string) {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const body = (await res.json()) as { user: { userId: string; tenantId: string } };
  return { cookie, userId: body.user.userId, tenantId: body.user.tenantId };
}
const call = (path: string, cookie: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'false';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
}, 180_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0545 — answer-bank routes', () => {
  it('stores and returns the caller’s OWN answers, with their coverage', async () => {
    const me = await login('bank-me@e2e.test');
    await enableTenantOverride('job-search', me.tenantId, 'test');

    const put = await call(BASE_PATH, me.cookie, {
      method: 'PUT', body: JSON.stringify({ questionText: 'What are your salary expectations?', value: '$180,000' }),
    });
    expect(put.status).toBe(200);

    const got = await call(BASE_PATH, me.cookie);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { answers: Array<{ value: string }>; coverage: { ratio: number }; questions: unknown[] };
    expect(body.answers).toHaveLength(1);
    expect(body.answers[0]!.value).toBe('$180,000');
    expect(body.questions.length).toBeGreaterThan(5);
    // The toil metric is per-USER progress, not the bank's hypothetical maximum.
    expect(body.coverage.ratio).toBeGreaterThan(0);
    expect(body.coverage.ratio).toBeLessThan(1);
  });

  it('ignores a subject named in the BODY — the session decides', async () => {
    // NOTE ON THIS TEST'S SHAPE. The first version logged in two users and
    // checked the OTHER one's list stayed empty. It passed against a build where
    // the route honoured `body.subjectId` — because the two sessions are in
    // different tenants, so a hijacked write lands under (my tenant, their
    // subject) and neither read looks there. Sabotage caught it; the assertion
    // now runs on MY OWN read, which is tenant-independent: if the body were
    // honoured, my answer would be filed under someone else and my list empty.
    const me = await login('bank-a@e2e.test');
    await enableTenantOverride('job-search', me.tenantId, 'test');

    const res = await call(BASE_PATH, me.cookie, {
      method: 'PUT',
      body: JSON.stringify({
        questionText: 'What are your salary expectations?', value: '$180,000',
        // The attack: name someone else. There is no such parameter, and the
        // point of this assertion is that adding one would turn it red.
        subjectId: 'user:somebody-else', userId: 'user:somebody-else',
      }),
    });
    expect(res.status).toBe(200);

    const mine = await (await call(BASE_PATH, me.cookie)).json() as { answers: Array<{ value: string }> };
    expect(mine.answers, 'the write must be filed under the SESSION subject').toHaveLength(1);
    expect(mine.answers[0]!.value).toBe('$180,000');
  });

  it('refuses a special-category answer with a REASON, not a silent success', async () => {
    const me = await login('bank-eeo@e2e.test');
    await enableTenantOverride('job-search', me.tenantId, 'test');
    const res = await call(BASE_PATH, me.cookie, {
      method: 'PUT', body: JSON.stringify({ questionText: 'Do you have a disability?', value: 'Yes' }),
    });
    expect(res.status).toBe(422);
    // H27-b — INVERTED. `reason` was a NEW TOP-LEVEL key, which
    // `error-envelope.schema.json` forbids (`additionalProperties: false`); it
    // now rides `details.reason`. The wizard still gets the machine-readable
    // refusal, and `assertFlatErrorEnvelope` pins that the body did not simply
    // grow a different illegal key in its place.
    const body: unknown = await res.json();
    assertFlatErrorEnvelope(body, 'special-category refusal');
    expect(detailOf(body, 'reason')).toBe('special-category');
    const { message } = body as { message: string };
    // The wizard has to be able to explain it, so the message must say what
    // happens instead rather than only that something failed.
    expect(message).toMatch(/decline to self-identify/i);

    const got = await (await call(BASE_PATH, me.cookie)).json() as { answers: unknown[] };
    expect(got.answers, 'nothing may be written').toHaveLength(0);
  });

  it('is TOGGLE-GATED — off means gone', async () => {
    const off = await login('bank-off@e2e.test');
    expect([403, 404]).toContain((await call(BASE_PATH, off.cookie)).status);
  });

  it('is not reachable anonymously', async () => {
    const res = await fetch(`${BASE}${BASE_PATH}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('ADR 0545 D3 — the batched exceptions card', () => {
  it('is ONE row per question, carrying how many applications wait on it', async () => {
    // Never one row per application: that is how "3 questions, ~40 seconds"
    // turns back into eighteen interruptions.
    const me = await login('bank-exc@e2e.test');
    await enableTenantOverride('job-search', me.tenantId, 'test');

    const { park } = await import('../src/features/job-search/autopilot/campaign.js');
    for (const listing of ['l1', 'l2', 'l3']) {
      await park(me.tenantId, me.userId, { question: 'How many years of Kubernetes?', reason: 'unknown' }, listing, Date.now());
    }

    const res = await call(`${BASE_PATH.replace('/answers', '/exceptions')}`, me.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exceptions: Array<{ questionText: string; blockedCount: number }> };
    expect(body.exceptions).toHaveLength(1);
    expect(body.exceptions[0]!.blockedCount).toBe(3);
  });

  it('answering one clears it from the backlog AND stores it for next time', async () => {
    const me = await login('bank-exc2@e2e.test');
    await enableTenantOverride('job-search', me.tenantId, 'test');
    const { park } = await import('../src/features/job-search/autopilot/campaign.js');
    await park(me.tenantId, me.userId, { question: 'What are your salary expectations?', reason: 'unknown' }, 'l1', Date.now());

    const EXC = BASE_PATH.replace('/answers', '/exceptions');
    const answered = await call(EXC, me.cookie, {
      method: 'POST', body: JSON.stringify({ questionText: 'What are your salary expectations?', value: '$180,000' }),
    });
    expect(answered.status).toBe(200);

    // Gone from the chore list…
    const after = (await (await call(EXC, me.cookie)).json()) as { exceptions: unknown[] };
    expect(after.exceptions).toHaveLength(0);
    // …and in the bank, so the NEXT employer never asks.
    const bank = (await (await call(BASE_PATH, me.cookie)).json()) as { answers: Array<{ value: string }> };
    expect(bank.answers[0]!.value).toBe('$180,000');
  });
});
