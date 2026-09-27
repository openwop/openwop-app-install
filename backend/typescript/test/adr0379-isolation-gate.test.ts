/**
 * ADR 0379 Phase 1 — the tenant-isolation gate, both halves:
 *
 *  1. STRUCTURAL probes: the storage/service predicates themselves refuse
 *     cross-tenant reads/writes (null/false, indistinguishable from absent) —
 *     the invariant no longer lives in caller-side post-checks.
 *  2. TRIPWIRES (the repo's drift-guard idiom): source scans that fail if a
 *     future change re-introduces a by-id-alone path — a second roster
 *     collection, a raw `roster.get` outside the service, a new caller of the
 *     ONE `getUserAgentAnyTenant` escape hatch, or a binding surface that
 *     resolves agents without the shared visibility rule.
 *  3. ROUTE probes: the HTTP boundary answers uniform 404 (never data, never
 *     the old 403 existence-oracle) for another tenant's agent/roster ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  createRosterEntry, getRosterEntry, updateRosterEntry, recordHeartbeat,
  deleteRosterEntry, __resetRosterStore,
} from '../src/host/rosterService.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureUserAgentRegistered } from '../src/routes/userAgents.js';
import { agentVisibleToTenant, resolveAgentForTenant } from '../src/host/agentVisibility.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { APP_MIGRATIONS } from '../src/host/appMigrations.js';
import type { UserAgentRecord } from '../src/types.js';

const SRC = join(__dirname, '../src');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('ADR 0379 P1 — tripwires (source scan)', () => {
  const files = walkTs(SRC);

  it('the roster DurableCollection and its raw get/delete live ONLY in rosterService.ts', () => {
    const offenders = files.filter((f) => !f.endsWith('host/rosterService.ts')).filter((f) => {
      const text = readFileSync(f, 'utf8');
      // Grade-pass widening: quote-agnostic — a second collection declared with
      // "roster" or `roster` slipped the original single-quote-only regex.
      return /DurableCollection<RosterEntry>\s*\(\s*['"`]roster['"`]/.test(text)
        || /\broster\.(get|delete|put|list|listByPrefix|compareAndSwap)\(/.test(text);
    });
    expect(offenders, `raw roster-store access outside rosterService: ${offenders.join(', ')}`).toEqual([]);
  });

  it('getUserAgentAnyTenant has exactly ONE consumer: the registry miss-hook hydrate', () => {
    // Grade-pass widening: scan EVERY src file (including the storage dir) for
    // call sites `.getUserAgentAnyTenant(`; the interface declaration + the two
    // adapter implementations define `async getUserAgentAnyTenant(` and don't
    // match the dot-call form, so no exclusion list is needed.
    const callers = files.filter((f) => /\.getUserAgentAnyTenant\s*\(/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => f.slice(SRC.length + 1)).sort()).toEqual(['routes/userAgents.ts']);
  });

  it('no NEW tenant-less registry resolve appears outside the dispositioned callers', () => {
    // Grade-pass widening: the original pin covered only the two known binding
    // surfaces — a NEW surface using a raw single-arg resolve was exactly the
    // drift mode the ADR narrates. Every `.resolve(<one arg>)` on the agent
    // registry must be in the allowlist of audited tenant-less callers
    // (pack-agent-only paths, each with its disposition recorded in the ADR).
    const ALLOWED = new Set([
      'host/a2aServer.ts',            // a2a: pack agents only (documented)
      'host/workforceEval.ts',        // eval harness: pack agent
      'host/agentVisibility.ts',      // the '*' wildcard path itself
      'routes/agents.ts',             // verify-run harness agent (pack)
    ]);
    const offenders = files.filter((f) => {
      const text = readFileSync(f, 'utf8');
      // A resolve with NO comma before the closing paren = tenant-less.
      return /getAgentRegistry\(\)\.resolve\(\s*[^,()]+\s*\)/.test(text) && !ALLOWED.has(f.slice(SRC.length + 1));
    });
    expect(offenders.map((f) => f.slice(SRC.length + 1)), 'new tenant-less resolve — thread the tenant or disposition it here + in the ADR').toEqual([]);
  });

  it('agent-binding surfaces use the shared visibility rule, not raw registry resolve', () => {
    for (const rel of ['features/scheduled-agent-chats/routes.ts', 'features/channels/channelService.ts']) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(text.includes('agentVisibility.js'), `${rel} must import host/agentVisibility`).toBe(true);
      expect(/executor\/agentRegistry\.js/.test(text), `${rel} must not raw-import the registry`).toBe(false);
    }
  });
});

const AGENT = (tenantId: string, slug: string): UserAgentRecord => ({
  agentId: `user.${tenantId}.${slug}`,
  tenantId,
  persona: `P-${slug}`,
  modelClass: 'chat',
  systemPrompt: 'x',
  toolAllowlist: [],
  memoryShape: { scratchpad: false, conversation: false, longTerm: false },
  createdAt: new Date().toISOString(),
});

describe('ADR 0379 P1 — storage predicates (user_agents)', () => {
  let storage: Storage;
  beforeAll(async () => { storage = await openStorage('memory://'); });
  afterAll(async () => { await storage.close(); });

  it('cross-tenant get/delete/update are null/false — indistinguishable from absent', async () => {
    const rec = AGENT('t-a', 'iris');
    await storage.insertUserAgent(rec);

    expect(await storage.getUserAgent('t-b', rec.agentId)).toBeNull();
    expect(await storage.deleteUserAgent('t-b', rec.agentId)).toBe(false);
    expect(await storage.updateUserAgent('t-b', { ...rec, persona: 'stolen' })).toBe(false);
    // The row is untouched and still owner-readable.
    expect((await storage.getUserAgent('t-a', rec.agentId))?.persona).toBe('P-iris');

    // The expected-tenant predicate is what makes the legacy `_anon` tenant
    // move EXPLICIT: it only matches when the old tenant is named.
    const legacy = AGENT('_anon', 'probe');
    await storage.insertUserAgent(legacy);
    expect(await storage.updateUserAgent('default', { ...legacy, tenantId: 'default' })).toBe(false);
    expect(await storage.updateUserAgent('_anon', { ...legacy, tenantId: 'default' })).toBe(true);
    expect((await storage.getUserAgent('default', legacy.agentId))?.tenantId).toBe('default');
  });
});

describe('ADR 0379 P2 (PR-A) — collision-by-construction substrate', () => {
  it('composite PK: the SAME agent_id coexists under two tenants', async () => {
    const storage = await openStorage('memory://');
    try {
      const shared = 'user.iris'; // the Phase-2 persona-scoped shape
      await storage.insertUserAgent({ ...AGENT('t-a', 'x'), agentId: shared });
      await storage.insertUserAgent({ ...AGENT('t-b', 'x'), agentId: shared });
      expect((await storage.getUserAgent('t-a', shared))?.tenantId).toBe('t-a');
      expect((await storage.getUserAgent('t-b', shared))?.tenantId).toBe('t-b');
      // Deleting one tenant's row leaves the other's.
      expect(await storage.deleteUserAgent('t-a', shared)).toBe(true);
      expect((await storage.getUserAgent('t-b', shared))?.tenantId).toBe('t-b');
    } finally { await storage.close(); }
  });

  it('registry: the SAME user agentId resolves per tenant; pack agents stay tenant-blind', async () => {
    const reg = getAgentRegistry();
    const mk = (tenant: string): Parameters<typeof reg.register>[0] => ({
      agentId: 'user.probe-shared', persona: `P-${tenant}`, modelClass: 'chat',
      systemPrompt: 'x', toolAllowlist: [], packName: `user:${tenant}`,
      packVersion: '0.0.0', ownerTenant: tenant,
    } as Parameters<typeof reg.register>[0]);
    reg.register(mk('t-a'));
    reg.register(mk('t-b'));
    expect(reg.get('user.probe-shared', 't-a')?.persona).toBe('P-t-a');
    expect(reg.get('user.probe-shared', 't-b')?.persona).toBe('P-t-b');
    expect(reg.get('user.probe-shared')).toBeNull(); // tenant-less sees packs only
    expect(reg.remove('user.probe-shared', 't-a')).toBe(true);
    expect(reg.get('user.probe-shared', 't-b')?.persona).toBe('P-t-b');
    reg.remove('user.probe-shared', 't-b');
  });

  it('roster: the SAME rosterId coexists under two tenants (tenant-qualified key)', async () => {
    const storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    try {
      // ADR 0379 P2 PR-B: the mint is DETERMINISTIC per persona — the same
      // persona in two tenants shares the id VALUE (`host:iris`) but owns an
      // independent row under its tenant-qualified key.
      const a = await createRosterEntry({ tenantId: 'kt-a', persona: 'Iris', agentRef: { agentId: 'p.k.i' } });
      const b = await createRosterEntry({ tenantId: 'kt-b', persona: 'Iris', agentRef: { agentId: 'p.k.i' } });
      expect(a.rosterId).toBe('host:iris');
      expect(b.rosterId).toBe('host:iris'); // same VALUE, different row
      await updateRosterEntry('kt-a', 'host:iris', { label: 'A-side' });
      expect((await getRosterEntry('kt-a', 'host:iris'))?.label).toBe('A-side');
      expect((await getRosterEntry('kt-b', 'host:iris'))?.label).toBeUndefined(); // isolated
      // Within a tenant, a duplicate persona is a 409 (collision-by-construction).
      await expect(createRosterEntry({ tenantId: 'kt-a', persona: 'Iris', agentRef: { agentId: 'p.k.i' } }))
        .rejects.toThrow(/already exists/);
    } finally { await __resetRosterStore(); __resetHostExtPersistence(); await storage.close(); }
  });

  it('sqlite mig 36 rebuilds user_agents with data surviving + the composite PK live', async () => {
    const { legacyDbAtVersion } = await import('./_legacyDbFixture.js');
    const { applyMigrations } = await import('../src/storage/sqlite/schema.js');
    const db = legacyDbAtVersion(35);
    db.prepare(`INSERT INTO user_agents (agent_id, tenant_id, persona, model_class, system_prompt, created_at)
                VALUES ('user.mig-t.probe', 'mig-t', 'P', 'chat', 'x', '2026-01-01T00:00:00Z')`).run();
    applyMigrations(db);
    // The row survived the table rebuild…
    const row = db.prepare(`SELECT tenant_id FROM user_agents WHERE agent_id = 'user.mig-t.probe'`).get() as { tenant_id: string };
    expect(row.tenant_id).toBe('mig-t');
    // …and the PK is now composite: same agent_id under another tenant inserts.
    db.prepare(`INSERT INTO user_agents (agent_id, tenant_id, persona, model_class, system_prompt, created_at)
                VALUES ('user.mig-t.probe', 'other-t', 'P2', 'chat', 'x', '2026-01-01T00:00:00Z')`).run();
    expect((db.prepare(`SELECT count(*) AS n FROM user_agents WHERE agent_id = 'user.mig-t.probe'`).get() as { n: number }).n).toBe(2);
    db.close();
  });

  it('app-migration v5 rekeys old-shape roster rows idempotently', async () => {
    const storage = await openStorage('memory://');
    try {
      const entry = { rosterId: 'host:iris-abc123', tenantId: 'mig-t', persona: 'Iris', agentRef: { agentId: 'p.k.i' }, workflows: [], enabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      await storage.kvSet('hostext:roster:host:iris-abc123', JSON.stringify(entry));
      const mig = APP_MIGRATIONS.find((m) => m.name === 'rekey-roster-rows-tenant-qualified')!;
      await mig.run(storage);
      expect(await storage.kvGet('hostext:roster:host:iris-abc123')).toBeNull();
      const moved = await storage.kvGet('hostext:roster:mig-t:host:iris-abc123');
      expect(moved && (JSON.parse(moved) as { persona: string }).persona).toBe('Iris');
      await mig.run(storage); // idempotent no-op
      expect(await storage.kvGet('hostext:roster:mig-t:host:iris-abc123')).not.toBeNull();
    } finally { await storage.close(); }
  });
});

describe('ADR 0379 P1 — roster service fail-closed accessors', () => {
  beforeAll(async () => {
    const storage = await openStorage('memory://');
    initHostExtPersistence(storage);
  });
  afterAll(async () => { await __resetRosterStore(); __resetHostExtPersistence(); });

  it('cross-tenant get/update/heartbeat/delete refuse; the row survives', async () => {
    const a = await createRosterEntry({ tenantId: 't-a', persona: 'Iris', agentRef: { agentId: 'p.k.iris' } });

    expect(await getRosterEntry('t-b', a.rosterId)).toBeNull();
    expect(await updateRosterEntry('t-b', a.rosterId, { persona: 'stolen' })).toBeNull();
    expect(await recordHeartbeat('t-b', a.rosterId)).toBeNull();
    expect(await deleteRosterEntry('t-b', a.rosterId)).toBe(false);

    const mine = await getRosterEntry('t-a', a.rosterId);
    expect(mine?.persona).toBe('Iris');
    expect(mine?.lastHeartbeatAt).toBeUndefined();
    expect(await deleteRosterEntry('t-a', a.rosterId)).toBe(true);
  });
});

describe('ADR 0379 P1 — the ONE visibility rule (all binding surfaces share it)', () => {
  it('pack agents are global; user agents owner-only; "*" is the explicit admin escape', () => {
    const pack = { agentId: 'core.x.helper', persona: 'H' } as Parameters<typeof agentVisibleToTenant>[0];
    const owned = { agentId: 'user.t-a.iris', persona: 'I', ownerTenant: 't-a' } as Parameters<typeof agentVisibleToTenant>[0];
    expect(agentVisibleToTenant(pack, 't-b')).toBe(true);
    expect(agentVisibleToTenant(owned, 't-a')).toBe(true);
    expect(agentVisibleToTenant(owned, 't-b')).toBe(false);
    expect(agentVisibleToTenant(owned, '*')).toBe(true);
    expect(agentVisibleToTenant(owned, undefined)).toBe(false);
  });

  it('resolveAgentForTenant is fail-closed: cross-tenant and absent are the same null', async () => {
    const storage = await openStorage('memory://');
    await ensureUserAgentRegistered(storage, AGENT('t-a', 'scoped-probe'));
    expect(await resolveAgentForTenant('user.t-a.scoped-probe', 't-a')).not.toBeNull();
    expect(await resolveAgentForTenant('user.t-a.scoped-probe', 't-b')).toBeNull();
    expect(await resolveAgentForTenant('user.t-a.absent-probe', 't-a')).toBeNull();
  });
});

describe('ADR 0379 P1 — route boundary: uniform 404, no existence oracle', () => {
  let server: http.Server;
  let BASE: string;
  let storage: Storage;

  // Grade-pass fix: `memory://` mints a FRESH sqlite per openStorage() call, so
  // the original probe seeded its "foreign" row into a database the app never
  // read — the 404 came from plain absence and the probe was vacuous. A shared
  // FILE-backed sqlite makes the app and the test see the SAME rows, so the
  // probe actually distinguishes tenant-scoping from absence.
  const DB_PATH = join(tmpdir(), `adr0379-gate-${process.pid}.sqlite`);
  beforeAll(async () => {
    rmSync(DB_PATH, { force: true });
    process.env.OPENWOP_STORAGE_DSN = `sqlite://${DB_PATH}`;
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0, storageDsn: `sqlite://${DB_PATH}`, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
    });
    storage = await openStorage(`sqlite://${DB_PATH}`);
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    await storage.close();
    rmSync(DB_PATH, { force: true });
  });

  const call = async (path: string, init: RequestInit = {}) =>
    fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers ?? {}) } });

  it("PATCH/DELETE another tenant's user agent → 404 (was 403: an existence oracle)", async () => {
    // Seed the foreign row directly (the bearer caller lands in tenant 'default').
    const foreign = AGENT('t-foreign', 'secret-agent');
    await storage.insertUserAgent(foreign);

    const patch = await call(`/v1/host/openwop-app/agents/${foreign.agentId}`, {
      method: 'PATCH', body: JSON.stringify({ systemPrompt: 'stolen' }),
    });
    expect(patch.status).toBe(404);

    const del = await call(`/v1/host/openwop-app/agents/${foreign.agentId}`, { method: 'DELETE' });
    expect(del.status).toBe(404);

    // Untouched.
    expect((await storage.getUserAgent('t-foreign', foreign.agentId))?.systemPrompt).toBe('x');
  });

  it("GET/PATCH/DELETE another tenant's roster member → 404; row survives", async () => {
    const foreign = await createRosterEntry({ tenantId: 't-foreign', persona: 'Covert', agentRef: { agentId: 'p.k.covert' } });

    expect((await call(`/v1/host/openwop-app/roster/${foreign.rosterId}`)).status).toBe(404);
    expect((await call(`/v1/host/openwop-app/roster/${foreign.rosterId}`, {
      method: 'PATCH', body: JSON.stringify({ persona: 'stolen' }),
    })).status).toBe(404);
    expect((await call(`/v1/host/openwop-app/roster/${foreign.rosterId}`, { method: 'DELETE' })).status).toBe(404);

    expect((await getRosterEntry('t-foreign', foreign.rosterId))?.persona).toBe('Covert');
  });
});
