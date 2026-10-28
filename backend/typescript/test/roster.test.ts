/**
 * Standing agent roster (RFCS/0086 reference impl) + board attribution.
 *
 * Covers:
 *   1. The pure service (host/rosterService.ts): create/list/get/update/
 *      delete + tenant scoping + the host:<id> rosterId form.
 *   2. The REST routes (`/host/openwop-app/roster/*`) + the §C
 *      attribution path: a board bound to a roster member defaults its To
 *      Do column to the member's first portfolio workflow, and a card
 *      moved into it starts a run attributed to the member (persona +
 *      rosterId + agentId in the run's `kanban` metadata block — read back
 *      from the stored run row, not only the PATCH echo).
 *   3. The refusals carry their OWN message (an earlier validator answering
 *      400 for a different field cannot satisfy them): avatar SSRF/type/size,
 *      create without persona, binding an unknown roster member, a negative
 *      heartbeat, and the ADR 0414 M3-2 persona-collision 409 (the route half
 *      of roster-persona-collision.test.ts's claim; the service half lives there).
 *   4. Cross-tenant isolation: a roster entry that EXISTS in another tenant
 *      reads 404 with the same body as an absent id (no existence oracle).
 *      DOUBLE GUARD: the store read is tenant-KEYED (`getRosterEntry`) and the
 *      route re-checks `entry.tenantId !== tenantOf(req)`; either alone keeps
 *      the 404 (probe 8fw2g2-rst-foreign-r2 on the keyed read is expected
 *      vacuous for that reason).
 *
 * Breaks it (round-1 probes 8fw2g2-rst-*, all witnessed): listing without the
 * tenant prefix, dropping the advisor filter / the disabled-member trigger
 * guard / the avatar regex or length cap / the heartbeat -1 sentinel, and a
 * kanban board accepting an unknown rosterId.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetRosterStore,
  createRosterEntry,
  getRosterEntry,
  listRoster,
  updateRosterEntry,
} from '../src/host/rosterService.js';
import { __resetKanbanStore } from '../src/host/kanbanService.js';
import type { Storage } from '../src/storage/storage.js';

/** The host error envelope (`OpenwopError.toEnvelope`). */
interface ErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

describe('roster service (pure)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => {
    initHostExtPersistence(storage);
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetRosterStore();
  });

  it('creates a named instance with a host:<id> rosterId + portfolio', async () => {
    const e = await createRosterEntry({
      tenantId: 't1',
      persona: 'Sally',
      agentRef: { agentId: 'core.openwop.agents.brief-writer', channel: 'stable' },
      workflows: ['marketing-email-campaign'],
    });
    expect(e.rosterId).toBe('host:sally'); // deterministic per-persona id (ADR 0379 P2)
    expect(e.persona).toBe('Sally');
    expect(e.workflows).toEqual(['marketing-email-campaign']);
    expect(e.enabled).toBe(true);
  });

  it('scopes list by tenant', async () => {
    await createRosterEntry({ tenantId: 't1', persona: 'Sally', agentRef: { agentId: 'a.b.c.d' } });
    await createRosterEntry({ tenantId: 't2', persona: 'Sam', agentRef: { agentId: 'a.b.c.d' } });
    expect((await listRoster('t1')).map((e) => e.persona)).toEqual(['Sally']);
    expect((await listRoster('t2')).map((e) => e.persona)).toEqual(['Sam']);
  });

  it('updates the portfolio + enabled flag', async () => {
    const e = await createRosterEntry({ tenantId: 't1', persona: 'Sally', agentRef: { agentId: 'a.b.c.d' } });
    await updateRosterEntry(e.tenantId, e.rosterId, { workflows: ['wf-1', 'wf-2'], enabled: false });
    const after = await getRosterEntry(e.tenantId, e.rosterId);
    expect(after?.workflows).toEqual(['wf-1', 'wf-2']);
    expect(after?.enabled).toBe(false);
  });

  it('sets, leaves, and clears the avatarUrl', async () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const e = await createRosterEntry({ tenantId: 't1', persona: 'Sally', agentRef: { agentId: 'a.b.c.d' } });
    expect(e.avatarUrl).toBeUndefined();
    // set
    await updateRosterEntry(e.tenantId, e.rosterId, { avatarUrl: dataUri });
    expect((await getRosterEntry(e.tenantId, e.rosterId))?.avatarUrl).toBe(dataUri);
    // undefined patch leaves it untouched
    await updateRosterEntry(e.tenantId, e.rosterId, { workflows: ['wf-9'] });
    expect((await getRosterEntry(e.tenantId, e.rosterId))?.avatarUrl).toBe(dataUri);
    // null clears it
    await updateRosterEntry(e.tenantId, e.rosterId, { avatarUrl: null });
    expect((await getRosterEntry(e.tenantId, e.rosterId))?.avatarUrl).toBeUndefined();
  });
});

describe('roster routes + board attribution (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  let runStorage: Storage;
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    runStorage = app.locals.storage;
    await __resetRosterStore();
    await __resetKanbanStore();
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });
    if (res.status === 204) throw new Error(`unexpected 204 from ${path}: every call in this file expects a JSON body`);
    return { status: res.status, body: (await res.json()) as T };
  }

  it('advertises agents.roster in discovery', async () => {
    // ADR 0812 P3c-0 — v2 spelling: presence of the facet is the claim (no `supported` flag).
    const { body } = await jsonFetch<{ agents?: { roster?: { installScope?: string } } }>('/.well-known/openwop', { headers: { 'OpenWOP-Version': '2' } });
    expect(body.agents?.roster?.installScope).toBe('tenant');
  });

  it('binds a board to a roster member and attributes the triggered run', async () => {
    const triggerWorkflowId = (await jsonFetch<{ fixtures?: string[] }>('/.well-known/openwop')).body.fixtures?.[0];
    expect(typeof triggerWorkflowId).toBe('string');

    // Create "Sally" who owns that workflow.
    const sally = await jsonFetch<{ rosterId: string; persona: string }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Sally',
        agentRef: { agentId: 'core.openwop.agents.brief-writer' },
        workflows: [triggerWorkflowId],
      }),
    });
    expect(sally.status).toBe(201);
    expect(sally.body.rosterId.startsWith('host:')).toBe(true);

    // She shows up in the tenant roster.
    const roster = await jsonFetch<{ roster: { rosterId: string }[] }>('/host/openwop-app/roster');
    expect(roster.body.roster.some((e) => e.rosterId === sally.body.rosterId)).toBe(true);

    // A board bound to Sally defaults its To Do column to her first workflow.
    const board = await jsonFetch<{ id: string; rosterId?: string; columns: { id: string; triggerWorkflowId?: string }[] }>(
      '/host/openwop-app/kanban/boards',
      { method: 'POST', body: JSON.stringify({ name: "Sally's board", rosterId: sally.body.rosterId }) },
    );
    expect(board.status).toBe(201);
    expect(board.body.rosterId).toBe(sally.body.rosterId);
    expect(board.body.columns.find((c) => c.id === 'todo')?.triggerWorkflowId).toBe(triggerWorkflowId);

    // Card in Doing → move to To Do → run starts, attributed to Sally.
    const card = await jsonFetch<{ id: string }>(`/host/openwop-app/kanban/boards/${board.body.id}/cards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Spring campaign', columnId: 'doing' }),
    });
    const moved = await jsonFetch<{
      triggeredRunId: string | null;
      attribution: { persona?: string; rosterId?: string; agentId?: string } | null;
    }>(`/host/openwop-app/kanban/cards/${card.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId: 'todo' }),
    });
    expect(typeof moved.body.triggeredRunId).toBe('string');

    // The started run is attributed to Sally (RFC 0086 §C: persona +
    // rosterId + the manifest agentId, content-free).
    expect(moved.body.attribution?.persona).toBe('Sally');
    expect(moved.body.attribution?.rosterId).toBe(sally.body.rosterId);
    expect(moved.body.attribution?.agentId).toBe('core.openwop.agents.brief-writer');

    // …and the attribution is on the STORED run row's `kanban` metadata block
    // (the header's claim), not only on the PATCH response.
    const run = await runStorage.getRun(String(moved.body.triggeredRunId));
    expect(run?.metadata?.kanban).toMatchObject({
      persona: 'Sally',
      rosterId: sally.body.rosterId,
      agentId: 'core.openwop.agents.brief-writer',
      workflowId: triggerWorkflowId,
      toColumnId: 'todo',
    });
  });

  it('hides advisor-subject members from the general roster, opt-in with ?includeAdvisors', async () => {
    // A normal agent lands in the caller's resolved tenant via the route.
    const normal = await jsonFetch<{ rosterId: string; tenantId: string }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({ persona: 'Nora', agentRef: { agentId: 'core.openwop.agents.brief-writer' } }),
    });
    expect(normal.status).toBe(201);
    const tenantId = normal.body.tenantId;

    // Seed an advisor-subject member in the SAME tenant (the route's POST
    // doesn't accept `roleKey`, mirroring the advisory-board seed path).
    const advisor = await createRosterEntry({
      tenantId,
      persona: 'Marcus Aurelius',
      agentRef: { agentId: 'core.openwop.agents.brief-writer' },
      roleKey: 'advisor',
    });

    // Default list excludes the advisor, includes the normal agent.
    const defaultList = await jsonFetch<{ roster: { rosterId: string }[] }>('/host/openwop-app/roster');
    const defaultIds = defaultList.body.roster.map((e) => e.rosterId);
    expect(defaultIds).toContain(normal.body.rosterId);
    expect(defaultIds).not.toContain(advisor.rosterId);

    // ?includeAdvisors=true opts the advisor back in (the board-of-advisors picker).
    const withAdvisors = await jsonFetch<{ roster: { rosterId: string }[] }>(
      '/host/openwop-app/roster?includeAdvisors=true',
    );
    const withIds = withAdvisors.body.roster.map((e) => e.rosterId);
    expect(withIds).toContain(normal.body.rosterId);
    expect(withIds).toContain(advisor.rosterId);

    // The list filter is presentation-only: a direct GET by id still resolves an
    // advisor (the Board of Advisors `@@`-convene resolves the council by id).
    const byId = await jsonFetch<{ rosterId: string; roleKey?: string }>(
      `/host/openwop-app/roster/${advisor.rosterId}`,
    );
    expect(byId.status).toBe(200);
    expect(byId.body.rosterId).toBe(advisor.rosterId);
    expect(byId.body.roleKey).toBe('advisor');
  });

  it('rejects binding a board to an unknown roster member', async () => {
    const res = await jsonFetch<ErrorBody>('/host/openwop-app/kanban/boards', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', rosterId: 'host:nope-00000000' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Field `rosterId` does not name a roster entry in this tenant.');
    expect(res.body.details?.field).toBe('rosterId');
  });

  it('validates roster create + 404s a foreign entry', async () => {
    // `{}` is refused at `persona` (the first validator), with its own message.
    const empty = await jsonFetch<ErrorBody>('/host/openwop-app/roster', { method: 'POST', body: JSON.stringify({}) });
    expect(empty.status).toBe(400);
    expect(empty.body.details?.field).toBe('persona');
    // A persona but no agentRef reaches the agentRef validator.
    const noRef = await jsonFetch<ErrorBody>('/host/openwop-app/roster', { method: 'POST', body: JSON.stringify({ persona: 'Orphan' }) });
    expect(noRef.status).toBe(400);
    expect(noRef.body.details?.field).toBe('agentRef');

    // A REAL entry in another tenant (positive control: it exists there)…
    const foreign = await createRosterEntry({ tenantId: 'roster-foreign-t', persona: 'Foreign Fern', agentRef: { agentId: 'a.b.c.d' } });
    expect(foreign.rosterId).toBe('host:foreign-fern');
    expect(await getRosterEntry('roster-foreign-t', 'host:foreign-fern')).not.toBeNull();
    // …reads 404 for this caller, with the same body as an id that exists nowhere.
    const cross = await jsonFetch<ErrorBody>('/host/openwop-app/roster/host:foreign-fern');
    expect(cross.status).toBe(404);
    expect(cross.body.message).toBe('Roster entry not found.');
    const absent = await jsonFetch<ErrorBody>('/host/openwop-app/roster/host:does-not-exist');
    expect(absent.status).toBe(404);
    expect(absent.body.message).toBe(cross.body.message);
    // A PATCH aimed at the foreign entry is refused the same way and changes nothing.
    const crossPatch = await jsonFetch<ErrorBody>('/host/openwop-app/roster/host:foreign-fern', { method: 'PATCH', body: JSON.stringify({ label: 'hijacked' }) });
    expect(crossPatch.status).toBe(404);
    expect((await getRosterEntry('roster-foreign-t', 'host:foreign-fern'))?.label).toBeUndefined();
  });

  it('refuses a PATCH rename onto another member\'s persona with 409 (ADR 0414 M3-2, route half)', async () => {
    const rhea = await jsonFetch<{ rosterId: string }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({ persona: 'Rhea', agentRef: { agentId: 'core.openwop.agents.brief-writer' } }),
    });
    const remy = await jsonFetch<{ rosterId: string }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({ persona: 'Remy', agentRef: { agentId: 'core.openwop.agents.brief-writer' } }),
    });
    expect([rhea.status, remy.status]).toEqual([201, 201]);
    const res = await jsonFetch<ErrorBody>(`/host/openwop-app/roster/${remy.body.rosterId}`, {
      method: 'PATCH',
      body: JSON.stringify({ persona: 'rhea' }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
    expect(res.body.message).toBe('Persona `rhea` is already used by another agent in this workspace.');
    expect(res.body.details?.persona).toBe('rhea');
    // The refused rename left Remy as he was.
    expect((await jsonFetch<{ persona: string }>(`/host/openwop-app/roster/${remy.body.rosterId}`)).body.persona).toBe('Remy');
  });

  it('validates avatarUrl and round-trips a valid data URI through PATCH→GET', async () => {
    const goodUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const created = await jsonFetch<{ rosterId: string }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({ persona: 'Pia', agentRef: { agentId: 'core.openwop.agents.brief-writer' } }),
    });
    expect(created.status).toBe(201);
    const id = created.body.rosterId;

    const SHAPE_MSG = 'Field `avatarUrl` MUST be a `data:image/(png|jpeg|webp);base64,…` URI.';
    const patchAvatar = (avatarUrl: string) =>
      jsonFetch<ErrorBody>(`/host/openwop-app/roster/${id}`, { method: 'PATCH', body: JSON.stringify({ avatarUrl }) });
    // A non-data: URL (would invite SSRF / off-row bytes) is refused.
    const remote = await patchAvatar('https://evil.example/x.png');
    expect(remote.status).toBe(400);
    expect(remote.body.message).toBe(SHAPE_MSG);
    // A non-image data URI is refused.
    const html = await patchAvatar('data:text/html;base64,YQ==');
    expect(html.status).toBe(400);
    expect(html.body.message).toBe(SHAPE_MSG);
    // An oversized (otherwise well-formed) payload is refused by the length cap.
    const huge = await patchAvatar(`data:image/png;base64,${'A'.repeat(700_001)}`);
    expect(huge.status).toBe(400);
    expect(huge.body.message).toBe('Field `avatarUrl` exceeds the 700000-character limit. Crop or shrink the image.');
    // None of the refusals touched the row.
    expect((await jsonFetch<{ avatarUrl?: string }>(`/host/openwop-app/roster/${id}`)).body.avatarUrl).toBeUndefined();

    // A valid small data URI is accepted and round-trips on the next GET.
    const ok = await jsonFetch(`/host/openwop-app/roster/${id}`, { method: 'PATCH', body: JSON.stringify({ avatarUrl: goodUri }) });
    expect(ok.status).toBe(200);
    expect((await jsonFetch<{ avatarUrl?: string }>(`/host/openwop-app/roster/${id}`)).body.avatarUrl).toBe(goodUri);

    // null clears it.
    await jsonFetch(`/host/openwop-app/roster/${id}`, { method: 'PATCH', body: JSON.stringify({ avatarUrl: null }) });
    expect((await jsonFetch<{ avatarUrl?: string }>(`/host/openwop-app/roster/${id}`)).body.avatarUrl).toBeUndefined();
  });

  it('round-trips heartbeatIntervalMs + autonomyLevel through PATCH→GET and validates them', async () => {
    const created = await jsonFetch<{ rosterId: string }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({ persona: 'Hb', agentRef: { agentId: 'core.openwop.agents.brief-writer' } }),
    });
    expect(created.status).toBe(201);
    const id = created.body.rosterId;

    // A negative cadence is rejected (-1 is the ADR 0313 OFF sentinel; other negatives still reject).
    const neg = await jsonFetch<ErrorBody>(`/host/openwop-app/roster/${id}`, { method: 'PATCH', body: JSON.stringify({ heartbeatIntervalMs: -2 }) });
    expect(neg.status).toBe(400);
    expect(neg.body.details?.field).toBe('heartbeatIntervalMs');

    // A positive cadence + autonomy level persist and round-trip on GET.
    const ok = await jsonFetch(`/host/openwop-app/roster/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ heartbeatIntervalMs: 900_000, autonomyLevel: 'review' }),
    });
    expect(ok.status).toBe(200);
    const after = await jsonFetch<{ heartbeatIntervalMs?: number; autonomyLevel?: string }>(`/host/openwop-app/roster/${id}`);
    expect(after.body.heartbeatIntervalMs).toBe(900_000);
    expect(after.body.autonomyLevel).toBe('review');

    // 0 disables the heartbeat (the field is cleared, not stored as 0).
    await jsonFetch(`/host/openwop-app/roster/${id}`, { method: 'PATCH', body: JSON.stringify({ heartbeatIntervalMs: 0 }) });
    expect((await jsonFetch<{ heartbeatIntervalMs?: number }>(`/host/openwop-app/roster/${id}`)).body.heartbeatIntervalMs).toBeUndefined();
  });

  it('decorates GET responses with the resolved heartbeat cadence (ADR 0313 D3)', async () => {
    const created = await jsonFetch<{ rosterId: string; heartbeat?: { effectiveIntervalMs: number; agentTurnFallback: boolean } }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({ persona: 'HbChip', agentRef: { agentId: 'core.openwop.agents.brief-writer' } }),
    });
    const id = created.body.rosterId;

    // Unconfigured entry ⇒ the host default (10 min in this test env) surfaces read-time.
    const fresh = await jsonFetch<{ heartbeatIntervalMs?: number; heartbeat?: { effectiveIntervalMs: number; agentTurnFallback: boolean } }>(`/host/openwop-app/roster/${id}`);
    expect(fresh.body.heartbeatIntervalMs).toBeUndefined(); // decoration, never stored
    expect(fresh.body.heartbeat?.effectiveIntervalMs).toBe(600_000);
    expect(typeof fresh.body.heartbeat?.agentTurnFallback).toBe('boolean');

    // The -1 sentinel resolves to 0 (checks off) on the wire.
    const off = await jsonFetch<{ heartbeat?: { effectiveIntervalMs: number } }>(`/host/openwop-app/roster/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ heartbeatIntervalMs: -1 }),
    });
    expect(off.body.heartbeat?.effectiveIntervalMs).toBe(0);

    // The list surface carries the same decoration.
    const list = await jsonFetch<{ roster: Array<{ rosterId: string; heartbeat?: { effectiveIntervalMs: number } }> }>('/host/openwop-app/roster');
    const row = list.body.roster.find((r) => r.rosterId === id);
    expect(row?.heartbeat?.effectiveIntervalMs).toBe(0);
  });

  it('does NOT fire the trigger when the bound roster member is disabled (RFC 0086 §A)', async () => {
    const triggerWorkflowId = (await jsonFetch<{ fixtures?: string[] }>('/.well-known/openwop')).body.fixtures?.[0];
    // A disabled member.
    const sam = await jsonFetch<{ rosterId: string }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Sam',
        agentRef: { agentId: 'core.openwop.agents.brief-writer' },
        workflows: [triggerWorkflowId],
        enabled: false,
      }),
    });
    const board = await jsonFetch<{ id: string }>('/host/openwop-app/kanban/boards', {
      method: 'POST',
      body: JSON.stringify({ name: "Sam's board", rosterId: sam.body.rosterId }),
    });
    const card = await jsonFetch<{ id: string }>(`/host/openwop-app/kanban/boards/${board.body.id}/cards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'x', columnId: 'doing' }),
    });
    const moved = await jsonFetch<{ triggeredRunId: string | null }>(`/host/openwop-app/kanban/cards/${card.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId: 'todo' }),
    });
    // Card still moved, but the disabled member's portfolio trigger is inert.
    expect(moved.body.triggeredRunId).toBeNull();
  });
});
