/**
 * ADR 0514 OQ1 — the draft-only persist stash. Invariants:
 *   - only a closed-world-VALID draft is ever stashed (typed failure else)
 *   - stashing requires an acting user (subject-keyed store)
 *   - the routes are SELF-scoped: an anonymous caller gets { draft: null },
 *     a signed-in caller reads/deletes ONLY their own row
 *   - the subject eraser actually deletes (ADR 0464 self-policing — the
 *     build ratchet does not reach feature-owned collections)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { buildAgentAuthorSurface } from '../src/features/agent-author/surface.js';
import {
  eraseAgentDraftStashForSubject,
  getStashedDraft,
  stashAgentDraft,
} from '../src/features/agent-author/draftStash.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  getAgentRegistry().register({
    agentId: 'test.stash.backing',
    persona: 'Backing',
    modelClass: 'general',
    systemPrompt: 'Respond.',
    packName: 'test',
    packVersion: '0',
    toolAllowlist: [],
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client(): { get: (p: string) => Promise<{ status: number; body: any }>; post: (p: string, b?: unknown) => Promise<{ status: number; body: any }>; del: (p: string) => Promise<{ status: number; body: any }> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

const DRAFT_URL = '/v1/host/openwop-app/agent-author/draft';
const VALID = { persona: 'Stash Nova', agentId: 'test.stash.backing' };

describe('surface stashDraft — the validation gate', () => {
  it('refuses without an acting user (typed failure, not a silent no-op)', async () => {
    const s = buildAgentAuthorSurface({ tenantId: 't-stash' } as Parameters<typeof buildAgentAuthorSurface>[0]);
    await expect((s as { stashDraft: (a: unknown) => Promise<unknown> }).stashDraft({ draft: VALID })).rejects.toThrow(/acting user/);
  });

  it('refuses an invalid draft; stashes a valid one', async () => {
    const s = buildAgentAuthorSurface({ tenantId: 't-stash', actingUserId: 'user-a' } as Parameters<typeof buildAgentAuthorSurface>[0]);
    const stashDraft = (s as { stashDraft: (a: unknown) => Promise<{ stashed: boolean; persona: string }> }).stashDraft;
    await expect(stashDraft({ draft: { persona: 'X', agentId: 'invented.nope' } })).rejects.toThrow(/not valid/);
    const out = await stashDraft({ draft: VALID });
    expect(out).toEqual({ stashed: true, persona: 'Stash Nova' });
    const row = await getStashedDraft('t-stash', 'user-a');
    expect(row?.draft.agentId).toBe('test.stash.backing');
  });
});

describe('routes — self-scoped', () => {
  it('anonymous: { draft: null }; signed-in: own row only; DELETE consumes', async () => {
    const anon = await fetch(`${BASE}${DRAFT_URL}`);
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { draft: unknown }).draft).toBeNull();

    const tenantId = `org:stash-${Date.now()}`;
    const c = client();
    const login = await c.post('/v1/host/openwop-app/test/login', { email: `stash-${Date.now()}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    const userId = login.body.user.userId as string;

    // Nothing stashed yet — the TRUE state, not a masked failure.
    expect((await c.get(DRAFT_URL)).body.draft).toBeNull();

    await stashAgentDraft(tenantId, userId, { persona: 'Route Nova', agentId: 'test.stash.backing' });
    // A DIFFERENT user's stash is never visible.
    await stashAgentDraft(tenantId, 'someone-else', { persona: 'Foreign', agentId: 'test.stash.backing' });

    const got = await c.get(DRAFT_URL);
    expect(got.status).toBe(200);
    expect(got.body.draft.persona).toBe('Route Nova'); // own row, not the foreign one
    expect(got.body.stashedAt).toBeTruthy();

    expect((await c.del(DRAFT_URL)).status).toBe(204);
    expect((await c.get(DRAFT_URL)).body.draft).toBeNull();
    // The foreign row survived the delete (self-scoped, not tenant-wide).
    expect(await getStashedDraft(tenantId, 'someone-else')).not.toBeNull();
  });
});

describe('subject eraser (ADR 0464 self-policing)', () => {
  it('deletes the subject’s row and only that row', async () => {
    await stashAgentDraft('t-erase', 'subject-x', { persona: 'Erase Me', agentId: 'test.stash.backing' });
    await stashAgentDraft('t-erase', 'subject-y', { persona: 'Keep Me', agentId: 'test.stash.backing' });
    await eraseAgentDraftStashForSubject('t-erase', 'subject-x');
    expect(await getStashedDraft('t-erase', 'subject-x')).toBeNull();
    expect((await getStashedDraft('t-erase', 'subject-y'))?.draft.persona).toBe('Keep Me');
  });
});
