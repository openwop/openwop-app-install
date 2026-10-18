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
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
      // USERS-19 (ADR 0617 D2): a deployment-named tenant is NOT a personal
      // shape, so the collapsed `personalTenant === tenantId` cookie no longer
      // grants implicit ownership — the seam founds + owns a tenant only for its
      // FIRST login, and later subjects here relied on the (SAML-shaped)
      // implicit-owner hole. Seat each subject as an explicit owner MEMBER
      // (`ensurePersonalWorkspace` seeds the owner row idempotently — the same
      // call the seam makes for the first login), so authority is membership-derived.
      const user = recOf((await bodyOf(res.clone())).user);
      await ensurePersonalWorkspace({ tenantId, ownerSubject: strOf(user.userId, 'userId'), name: `Test workspace ${tenantId}` });
    },
  };
}

const B = '/host/openwop-app/kicktodo/creator';
const TENANT = 'tenant-kt-creator';

/** Untyped JSON → a plain record, without a cast (w41 typing rule: no `as`). */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const v: unknown = await res.json();
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected a JSON object (status ${res.status})`);
  return { ...v };
}

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_DEMO_MODE'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
/** A nested object field as a record (absent/non-object ⇒ `{}`). */
function recOf(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {};
}
/** A string field, or a failed assertion naming it. */
function strOf(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`expected ${what} to be a string, got ${JSON.stringify(v)}`);
  return v;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      BASE = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
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
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('risk classification (deterministic, reviewable)', () => {
  it('tiers classify from matched signals; prohibited wins', () => {
    expect(classifyRisk('Learn watercolor painting basics').tier).toBe('general');
    // Code-grade KTF-IN-1 — word-start matching: these used to escalate on a substring.
    expect(classifyRisk('A taxonomy of garden birds').tier).toBe('general');
    expect(classifyRisk('Investigate your local history').tier).toBe('general');
    expect(classifyRisk('Cook with a dietitian-approved pantry').tier).toBe('general');
    // ...while inflected keywords still match.
    expect(classifyRisk('Start investing in index funds').tier).toBe('regulated-adjacent');
    expect(classifyRisk('Understand your diagnosis').tier).toBe('regulated-adjacent');
    expect(classifyRisk('File your taxes on time').tier).toBe('regulated-adjacent');
    expect(classifyRisk('Quit self-harm').tier).toBe('prohibited');
    expect(classifyRisk('A challenge for minors').tier).toBe('prohibited');
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
    const body = await bodyOf(res);
    // The matched signal itself, not a substring that the echoed topic could supply.
    expect(recOf(body.details).signals).toEqual(['day trading']);
  });
});

describe('candidates + research dossier', () => {
  it('intake → research recording; unsupported claims recorded; risk tier stored', async () => {
    const c = client();
    await c.login('user:cr-ben', TENANT);
    const cand = await bodyOf(await c.post(`${B}/candidates`, {
      topic: 'Deep-focus work sessions',
      audience: 'busy professionals',
      transformation: 'reliable daily focus blocks',
      durationDaysTarget: 14,
      dailyMinutesTarget: 20,
    }));
    expect(cand.riskTier).toBe('general');
    expect(cand.state).toBe('intake');

    const s1 = { url: 'https://example.org/focus-research', domain: 'example.org', title: 'Focus research', hash: sourceHash('https://example.org/focus-research', 'Focus research'), engine: 'searx' };
    const recorded = await bodyOf(await c.post(`${B}/candidates/${strOf(cand.id, 'candidate id')}/research`, {
      questions: ['q1'],
      sources: [s1],
      claims: [
        { claimId: 'c1', text: 'Short focus blocks beat marathon sessions', sourceHashes: [s1.hash] },
        { claimId: 'c2', text: 'Unsupported claim', sourceHashes: ['sha256:nope'] },
      ],
    }));
    expect(recorded.state).toBe('researched');
    expect(recOf(recorded.dossier).unsupportedClaimIds).toEqual(['c2']);
    expect(recOf(recorded.dossier).engines).toEqual(['searx']);
    // persisted, not just echoed
    const reread = await bodyOf(await c.get(`${B}/candidates/${strOf(cand.id, 'candidate id')}`));
    expect(recOf(reread.dossier).unsupportedClaimIds).toEqual(['c2']);
  });

  it('stub/demo search engines FAIL CLOSED at record time (409)', async () => {
    const c = client();
    await c.login('user:cr-cy', TENANT);
    const candId = strOf((await bodyOf(await c.post(`${B}/candidates`, { topic: 'Daily sketching practice' }))).id, 'candidate id');
    const stub = { url: 'https://example.com/x/result-1', domain: 'example.com', title: 'stub', hash: sourceHash('https://example.com/x/result-1', 'stub'), engine: 'stub' };
    const res = await c.post(`${B}/candidates/${candId}/research`, { questions: [], sources: [stub], claims: [] });
    expect(res.status).toBe(409);
    // The candidate keeps NO dossier — placeholder retrieval never lands.
    const after = await bodyOf(await c.get(`${B}/candidates/${candId}`));
    expect(after.state).toBe('intake');
    expect(after.dossier).toBeUndefined();
  });

  // Retitled in w41: this case never turned a toggle off (the old title said it did).
  // Isolation is by key construction (`${tenantId}::${id}`) behind a second tenant
  // re-check in `getCandidate` — a double guard no single sabotage separates; the
  // owner positive control proves the id is real.
  it('a foreign tenant cannot read another tenant\'s candidate (404, owner control 200)', async () => {
    const c = client();
    await c.login('user:cr-dee', TENANT);
    const candId = strOf((await bodyOf(await c.post(`${B}/candidates`, { topic: 'Gratitude journaling' }))).id, 'candidate id');
    const own = await c.get(`${B}/candidates/${candId}`);
    expect(own.status).toBe(200);
    expect((await bodyOf(own)).topic).toBe('Gratitude journaling');

    const other = client();
    await other.login('user:cr-eve', 'tenant-kt-other');
    const res = await other.get(`${B}/candidates/${candId}`);
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).error).toBe('not_found');
  });

  // The store key is `${tenantId}::${id}`, and `:id` comes from the URL — so when a
  // tenant id itself contains `::`, a SHORTER tenant can spell the longer tenant's
  // key: tenant `X` asking for id `inner::<cand>` reads key `X::inner::<cand>`, which
  // is tenant `X::inner`'s candidate. Key construction cannot catch that; only the
  // row-level `c.tenantId === tenantId` re-check in `getCandidate` does. Witness:
  // w41g1-cr-tenant-fence (the re-check removed ⇒ this read returns 200).
  it('a composite-key collision cannot cross tenants (a `::` tenant id, the row-level fence)', async () => {
    const OUTER = 'tenant-kt-fence';
    const INNER = `${OUTER}::inner`;
    const victim = client();
    await victim.login('user:cr-fence-victim', INNER);
    const created = await victim.post(`${B}/candidates`, { topic: 'Evening walk' });
    expect([200, 201], JSON.stringify(await bodyOf(created.clone()))).toContain(created.status);
    const candId = strOf((await bodyOf(created)).id, 'candidate id');
    expect((await victim.get(`${B}/candidates/${candId}`)).status).toBe(200); // positive control

    const prober = client();
    await prober.login('user:cr-fence-prober', OUTER);
    const res = await prober.get(`${B}/candidates/inner::${candId}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await bodyOf(res))).not.toContain('Evening walk');
  });
});

describe('deterministic research framing', () => {
  it('question families are templated, ordered, and model-free', () => {
    const qs = frameResearchQuestions('deep focus', 'engineers');
    expect(qs).toHaveLength(7);
    // literal expectations (never the function as its own oracle)
    expect(qs[0]).toBe('What outcomes can engineers realistically achieve with deep focus in 2–4 weeks?');
    expect(qs[2]).toBe('What evidence CONTRADICTS common advice about deep focus?');
    // the default audience when none is given
    expect(frameResearchQuestions('deep focus', '  ')[0]).toBe('What outcomes can busy adults realistically achieve with deep focus in 2–4 weeks?');
  });
});
