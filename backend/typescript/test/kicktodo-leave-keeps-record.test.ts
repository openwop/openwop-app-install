/**
 * What "Leave challenge" actually does, pinned so the SPA's confirmation copy
 * cannot claim more or less than the route delivers.
 *
 * The SPA's confirm dialog says three things, each asserted here through the real
 * HTTP routes:
 *   1. the enrollment becomes `abandoned` and stays in the caller's list (Progress
 *      shows it as an ended journey; "completed work never disappears");
 *   2. journal entries (evidence-bearing check-ins) are kept ("recovery never
 *      destroys evidence");
 *   3. enrolling again in the same challenge version returns that SAME left
 *      enrollment. The id is derived from (owner, challenge, version), so a
 *      rejoin is not possible, and the dialog says so instead of promising it.
 * A second abandon is a no-op that returns the row (the route is idempotent).
 *
 * Red when: abandon deletes or hides the row, drops check-ins from the journal,
 * or re-enroll starts a fresh enrollment (then the copy must change with it).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ensurePersonalWorkspace } from '../src/host/accessControlService.js';

const B = '/host/openwop-app/kicktodo';
const TENANT = 'tenant-kicktodo-leave';
let BASE: string;
let server: http.Server;

async function body<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

function client() {
  let cookie = '';
  const send = async (method: string, path: string, b?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(b !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(b !== undefined ? { body: JSON.stringify(b) } : {}),
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
    login: async (subject: string) => {
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId: TENANT });
      expect([200, 201]).toContain(res.status);
      const { user } = await body<{ user: { userId: string } }>(res.clone());
      await ensurePersonalWorkspace({ tenantId: TENANT, ownerSubject: user.userId, name: `Test workspace ${TENANT}` });
    },
  };
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
      const addr: AddressInfo | string | null = server.address();
      if (!addr || typeof addr === 'string') throw new Error('server has no TCP address');
      BASE = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
  for (const id of ['users', 'kicktodo-core']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('KickTodo leave (abandon) keeps the record', () => {
  it('abandoned stays listed, keeps journal entries, and a re-enroll returns the same left enrollment', async () => {
    const c = client();
    await c.login('user:kt-leaver');
    const draft = await body<{ id: string }>(await c.post(`${B}/challenges`, {
      title: 'Leave test', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'd1', day: 1, title: 'Note it', instructions: 'One line.', evidencePolicy: 'note' }],
    }));
    expect((await c.post(`${B}/challenges/${draft.id}/versions/1/publish`)).status).toBe(200);
    const e = await body<{ id: string }>(await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' }));

    const today = await body<{ enrollments: Array<{ enrollmentId: string; actions: Array<{ occurrence: { cardId: string } }> }> }>(await c.get(`${B}/today`));
    const cardId = today.enrollments.find((x) => x.enrollmentId === e.id)!.actions[0]!.occurrence.cardId;
    expect((await c.post(`${B}/check-ins`, { cardId, note: 'kept after leaving' })).status).toBe(200);

    const left = await c.post(`${B}/enrollments/${e.id}/abandon`);
    expect(left.status).toBe(200);
    expect((await body<{ state: string }>(left)).state).toBe('abandoned');

    // 1. still listed, as abandoned.
    const list = await body<{ enrollments: Array<{ id: string; state: string }> }>(await c.get(`${B}/enrollments?include=progress`));
    expect(list.enrollments.find((x) => x.id === e.id)?.state).toBe('abandoned');

    // 2. the journal entry survives.
    const journal = await body<{ entries: Array<{ enrollmentId: string; note?: string }> }>(await c.get(`${B}/journal`));
    expect(journal.entries.some((j) => j.enrollmentId === e.id && j.note === 'kept after leaving')).toBe(true);

    // 3. a re-enroll in the same version converges on the left enrollment.
    const again = await body<{ id: string; state: string }>(await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' }));
    expect(again.id).toBe(e.id);
    expect(again.state).toBe('abandoned');

    // A second abandon is a no-op.
    const twice = await c.post(`${B}/enrollments/${e.id}/abandon`);
    expect(twice.status).toBe(200);
    expect((await body<{ state: string }>(twice)).state).toBe('abandoned');
  });
});
