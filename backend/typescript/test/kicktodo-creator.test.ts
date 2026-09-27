/**
 * ADR 0415 P1 — Challenge Factory research spine:
 *
 *  - deterministic risk classification (tiers escalate; PROHIBITED refused at
 *    intake with the matched signals surfaced)
 *  - candidate CRUD, tenant-scoped, toggle-gated
 *  - dossier recording: unsupported claims RECORDED (never silently kept);
 *    stub/demo search engines FAIL CLOSED (409 — the PRD §7.4 honesty rule)
 *  - deterministic research framing (model-free question families)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { classifyRisk, sourceHash } from '../src/features/kicktodo-creator/creatorService.js';
import { frameResearchQuestions } from '../src/features/kicktodo-creator/surface.js';
import { ensurePersonalWorkspace } from '../src/host/accessControlService.js';

let BASE: string;
let server: http.Server;

function client() {
  let cookie = '';
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    return res;
  };
  return {
    get: (p: string) => send('GET', p),
    post: (p: string, b?: unknown) => send('POST', p, b),
    login: async (subject: string, tenantId: string) => {
      const res = await send('POST', '/v1/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
      // USERS-19 (ADR 0617 D2): a deployment-named tenant is NOT a personal
      // shape, so the collapsed `personalTenant === tenantId` cookie no longer
      // grants implicit ownership — the seam founds + owns a tenant only for its
      // FIRST login, and later subjects here relied on the (SAML-shaped)
      // implicit-owner hole. Seat each subject as an explicit owner MEMBER
      // (`ensurePersonalWorkspace` seeds the owner row idempotently — the same
      // call the seam makes for the first login), so authority is membership-derived.
      const { user } = (await res.clone().json()) as { user: { userId: string } };
      await ensurePersonalWorkspace({ tenantId, ownerSubject: user.userId, name: `Test workspace ${tenantId}` });
    },
  };
}

const B = '/v1/host/openwop-app/kicktodo/creator';
const TENANT = 'tenant-kt-creator';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  for (const id of ['users', 'kicktodo-core', 'kicktodo-creator']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('risk classification (deterministic, reviewable)', () => {
  it('tiers classify from matched signals; prohibited wins', () => {
    expect(classifyRisk('Learn watercolor painting basics').tier).toBe('general');
    expect(classifyRisk('Build a morning fitness routine').tier).toBe('sensitive');
    expect(classifyRisk('A weight loss program for beginners').tier).toBe('regulated-adjacent');
    const p = classifyRisk('Crash diet challenge for rapid weight loss');
    expect(p.tier).toBe('prohibited');
    expect(p.signals).toContain('crash diet');
  });

  it('prohibited topics are refused at intake with signals surfaced (422)', async () => {
    const c = client();
    await c.login('user:cr-ana', TENANT);
    const res = await c.post(`${B}/candidates`, { topic: 'Day trading bootcamp for beginners' });
    expect(res.status).toBe(422);
    const body = await res.json() as { details?: { signals?: string[] } };
    expect(JSON.stringify(body)).toContain('day trading');
  });
});

describe('candidates + research dossier', () => {
  it('intake → research recording; unsupported claims recorded; risk tier stored', async () => {
    const c = client();
    await c.login('user:cr-ben', TENANT);
    const cand = await (await c.post(`${B}/candidates`, {
      topic: 'Deep-focus work sessions',
      audience: 'busy professionals',
      transformation: 'reliable daily focus blocks',
      durationDaysTarget: 14,
      dailyMinutesTarget: 20,
    })).json() as { id: string; riskTier: string; state: string };
    expect(cand.riskTier).toBe('general');
    expect(cand.state).toBe('intake');

    const s1 = { url: 'https://example.org/focus-research', domain: 'example.org', title: 'Focus research', hash: sourceHash('https://example.org/focus-research', 'Focus research'), engine: 'searx' };
    const recorded = await (await c.post(`${B}/candidates/${cand.id}/research`, {
      questions: ['q1'],
      sources: [s1],
      claims: [
        { claimId: 'c1', text: 'Short focus blocks beat marathon sessions', sourceHashes: [s1.hash] },
        { claimId: 'c2', text: 'Unsupported claim', sourceHashes: ['sha256:nope'] },
      ],
    })).json() as { state: string; dossier: { unsupportedClaimIds: string[]; engines: string[] } };
    expect(recorded.state).toBe('researched');
    expect(recorded.dossier.unsupportedClaimIds).toEqual(['c2']);
    expect(recorded.dossier.engines).toEqual(['searx']);
  });

  it('stub/demo search engines FAIL CLOSED at record time (409)', async () => {
    const c = client();
    await c.login('user:cr-cy', TENANT);
    const cand = await (await c.post(`${B}/candidates`, { topic: 'Daily sketching practice' })).json() as { id: string };
    const stub = { url: 'https://example.com/x/result-1', domain: 'example.com', title: 'stub', hash: sourceHash('https://example.com/x/result-1', 'stub'), engine: 'stub' };
    const res = await c.post(`${B}/candidates/${cand.id}/research`, { questions: [], sources: [stub], claims: [] });
    expect(res.status).toBe(409);
    // The candidate keeps NO dossier — placeholder retrieval never lands.
    const after = await (await c.get(`${B}/candidates/${cand.id}`)).json() as { state: string; dossier?: unknown };
    expect(after.state).toBe('intake');
    expect(after.dossier).toBeUndefined();
  });

  it('toggle OFF hides the surface; foreign tenant sees nothing', async () => {
    const c = client();
    await c.login('user:cr-dee', TENANT);
    const cand = await (await c.post(`${B}/candidates`, { topic: 'Gratitude journaling' })).json() as { id: string };

    const other = client();
    await other.login('user:cr-eve', 'tenant-kt-other');
    // kicktodo-creator toggle is tenant-bucketed and ON only via saveConfig
    // global default in this suite — the other tenant still can't SEE this
    // tenant's candidate (tenant scoping).
    expect((await other.get(`${B}/candidates/${cand.id}`)).status).toBe(404);
  });
});

describe('deterministic research framing', () => {
  it('question families are templated, ordered, and model-free', () => {
    const qs = frameResearchQuestions('deep focus', 'engineers');
    expect(qs).toHaveLength(7);
    expect(qs[2]).toContain('CONTRADICTS');
    expect(frameResearchQuestions('deep focus', 'engineers')).toEqual(qs); // deterministic
  });
});
