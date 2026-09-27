/**
 * ADR 0601 § Corrections (MEDIUM-6) — the conversation cascade must be REACHABLE
 * in the one branch that needs it.
 *
 * ADR 0601 D5 reordered the delete so the row goes first and the conversation
 * second. Correct. But it also GATED the second step on the first
 * (`result.deleted ? cascade : 0`), and the gate is what this file is about.
 *
 * Both doors re-read the project between the authorization guard and the delete
 * (`requireNotebook` → `getNotebook`, then `deleteNotebook` → `getProject`), so
 * `deleted:false` is not a dead branch: it is the concurrent-delete race. A peer
 * removes the row in that window, our delete finds nothing, and under the gate we
 * walked away from the project's group conversation and reported a clean zero.
 * That is the WF-PRJ-1 shape ("the cascade never runs, the conversation is
 * stranded") re-entering through the door the fix installed — plus it silently
 * retired the stranded-meta self-heal documented at `conversationCascade.ts:34`,
 * whose entire job is to clean a meta left behind by an EARLIER partial delete
 * and which the gate left with no caller at all.
 *
 * The invariant was never "the number must be zero". It is "the body reports what
 * actually happened", which unconditional-plus-truthful satisfies: `{deleted:
 * false, conversationsDeleted:1}` after a peer removed the row is a true
 * statement. The original NBC-1 defect was the opposite — a body claiming NOTHING
 * was destroyed while a conversation had just been irrecoverably destroyed.
 *
 * HOW THE RACE IS MADE DETERMINISTIC. `deleteNotebook` is wrapped so that, when
 * armed, the "peer" (`deleteProject`) runs first and THEN the REAL
 * `deleteNotebook` is called. The `deleted:false` under test is therefore
 * genuinely produced by the shipped function against a genuinely absent row — not
 * a fabricated return value that only looks like the race.
 *
 * @see docs/adr/0601-notebooks-trust-boundary-and-mcp-authz.md § Corrections
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Armed per-test; when set, a "peer" deletes the row first. */
const race = vi.hoisted(() => ({ armed: false }));

vi.mock('../src/features/notebooks/notebooksService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/notebooks/notebooksService.js')>();
  const projects = await import('../src/features/projects/projectsService.js');
  return {
    ...actual,
    deleteNotebook: async (tenantId: string, id: string) => {
      if (race.armed) await projects.deleteProject(tenantId, id); // the peer wins the race
      return actual.deleteNotebook(tenantId, id);
    },
  };
});

import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['notebooks', 'kb', 'users', 'projects']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { race.armed = false; await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

const NB = '/v1/host/openwop-app/notebooks';
const PROJ = '/v1/host/openwop-app/projects';
const CHAT = '/v1/host/openwop-app/chat/sessions';

/** A notebook with a real group conversation carrying at least one message, so
 *  "the conversation survived" is a statement about real data and not an empty
 *  row. */
async function notebookWithConversation(who: string): Promise<{ c: Client; id: string; conversationId: string }> {
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = org.body.orgId as string;
  const plain = await c.post(PROJ, { orgId, name: 'Raced project' });
  const id = plain.body.id as string;
  expect((await c.post(`${NB}/${id}/ensure`)).status).toBe(200);
  const chat = await c.post(`${NB}/${id}/chat`);
  expect([200, 201], JSON.stringify(chat.body)).toContain(chat.status);
  const conversationId = chat.body.conversationId as string;
  // The conversation is real and reachable before the delete — otherwise the
  // 404 asserted below would be indistinguishable from "there was never one".
  expect((await c.get(`${CHAT}/${conversationId}`)).status, 'precondition: the conversation exists').toBe(200);
  return { c, id, conversationId };
}

describe('ADR 0601 § Corrections / MEDIUM-6 — the cascade runs even when the row was already gone', () => {
  it('DELETE /notebooks/:id — a lost race still cleans the conversation, and SAYS so', async () => {
    const { c, id, conversationId } = await notebookWithConversation('nb-race-nb');
    race.armed = true;
    try {
      const del = await c.del(`${NB}/${id}`);
      expect(del.status, JSON.stringify(del.body)).toBe(200);
      // The peer won: our delete found nothing to delete. That much is honest.
      expect(del.body.deleted, JSON.stringify(del.body)).toBe(false);
      // …and the conversation the peer left behind is OURS to clean. Under the
      // `deleted ? cascade : 0` gate this was 0 and the thread survived forever.
      expect(del.body.conversationsDeleted, JSON.stringify(del.body)).toBe(1);
    } finally { race.armed = false; }
    // The count is a claim; this is the fact behind it.
    expect((await c.get(`${CHAT}/${conversationId}`)).status, 'the conversation must actually be gone').toBe(404);
  });

  it('DELETE /projects/:id — the SIBLING door behaves identically (they must not drift)', async () => {
    const { c, id, conversationId } = await notebookWithConversation('nb-race-proj');
    race.armed = true;
    try {
      const del = await c.del(`${PROJ}/${id}`);
      expect(del.status, JSON.stringify(del.body)).toBe(200);
      expect(del.body.deleted, JSON.stringify(del.body)).toBe(false);
      expect(del.body.conversationsDeleted, JSON.stringify(del.body)).toBe(1);
    } finally { race.armed = false; }
    expect((await c.get(`${CHAT}/${conversationId}`)).status).toBe(404);
  });

  it('CONTROL — with no race, both doors still report the ordinary truth', async () => {
    // The gate's removal must not turn every delete into a fabricated 1. A
    // notebook with NO conversation reports 0, and one WITH a conversation
    // reports 1 — so the number tracks reality in both directions rather than
    // being a constant that happens to satisfy the assertions above.
    const { c, id, conversationId } = await notebookWithConversation('nb-race-control');
    const del = await c.del(`${NB}/${id}`);
    expect(del.body.deleted).toBe(true);
    expect(del.body.conversationsDeleted).toBe(1);
    expect((await c.get(`${CHAT}/${conversationId}`)).status).toBe(404);

    const c2 = client();
    expect((await c2.post('/v1/host/openwop-app/test/login', { email: `nb-race-none-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
    const org = await c2.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const created = await c2.post(NB, { orgId: org.body.orgId, name: 'No chat here' });
    const noChat = await c2.del(`${NB}/${created.body.notebook.id}`);
    expect(noChat.body.deleted).toBe(true);
    expect(noChat.body.conversationsDeleted, 'a notebook with no conversation must report 0').toBe(0);
  });
});
