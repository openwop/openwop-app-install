/**
 * Anon→user adoption persona-dedup (2026-07-16) — the fix for the
 * agent-allowlists "Chief of Staff ×N" duplication.
 *
 * `reassignTenant` folds an anon tenant into a user tenant by rewriting
 * tenant_id; per-persona demo entities (user_agents, roster) have anon-embedded
 * or random ids, so N adopted sessions fold in as N duplicate rows. This dedups
 * BEFORE the fold: an anon row whose persona the user already has is deleted.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createRosterEntry, listRoster } from '../src/host/rosterService.js';
import { dedupePersonasBeforeAdopt } from '../src/host/adoptDedup.js';
import type { Storage } from '../src/storage/storage.js';
import type { UserAgentRecord } from '../src/types.js';

let storage: Storage;

const ua = (tenantId: string, persona: string, sid: string): UserAgentRecord => ({
  agentId: `user.${tenantId}.${persona.toLowerCase()}-${sid}`,
  tenantId, persona, modelClass: 'reasoning', systemPrompt: 'x', toolAllowlist: [],
  memoryShape: { scratchpad: false, conversation: false, longTerm: false }, createdAt: '2026-07-16T00:00:00Z',
});

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
beforeEach(async () => { __resetHostExtPersistence(); initHostExtPersistence(storage); });

describe('dedupePersonasBeforeAdopt — user_agents', () => {
  it('drops an anon agent whose persona the user already has; keeps a new one', async () => {
    const USER = 'user:real', ANON = 'anon:sid1';
    await storage.insertUserAgent(ua(USER, 'Iris', 'own'));       // the user's own Iris
    await storage.insertUserAgent(ua(ANON, 'Iris', 'a1'));        // anon dup → must be dropped
    await storage.insertUserAgent(ua(ANON, 'Sally', 'a1'));       // anon-only → must survive

    const res = await dedupePersonasBeforeAdopt(ANON, USER, storage);
    expect(res.userAgentsDropped).toBe(1);

    const anonLeft = (await storage.listUserAgents(ANON)).map((a) => a.persona).sort();
    expect(anonLeft, 'the duplicate-persona anon agent is gone, the unique one stays to fold in').toEqual(['Sally']);
    // The user tenant is untouched by the dedup itself (the fold moves Sally later).
    expect((await storage.listUserAgents(USER)).map((a) => a.persona)).toEqual(['Iris']);
  });

  it('is idempotent — a second run finds the anon side already drained', async () => {
    const USER = 'user:r2', ANON = 'anon:sid2';
    await storage.insertUserAgent(ua(USER, 'Iris', 'own'));
    await storage.insertUserAgent(ua(ANON, 'Iris', 'a2'));
    expect((await dedupePersonasBeforeAdopt(ANON, USER, storage)).userAgentsDropped).toBe(1);
    expect((await dedupePersonasBeforeAdopt(ANON, USER, storage)).userAgentsDropped).toBe(0);
  });

  it('a user tenant with NO agents yet keeps ALL anon agents (one copy each)', async () => {
    const USER = 'user:empty', ANON = 'anon:sid3';
    await storage.insertUserAgent(ua(ANON, 'Iris', 'a3'));
    await storage.insertUserAgent(ua(ANON, 'Sally', 'a3'));
    const res = await dedupePersonasBeforeAdopt(ANON, USER, storage);
    expect(res.userAgentsDropped, 'nothing to dedup against ⇒ all fold in').toBe(0);
    expect((await storage.listUserAgents(ANON)).length).toBe(2);
  });
});

describe('dedupePersonasBeforeAdopt — roster', () => {
  it('drops an anon roster entry whose persona the user already has', async () => {
    const USER = 'user:rr', ANON = 'anon:rr';
    await createRosterEntry({ tenantId: USER, persona: 'Iris', agentRef: { agentId: 'a', version: '1.0.0' } });
    await createRosterEntry({ tenantId: ANON, persona: 'Iris', agentRef: { agentId: 'a', version: '1.0.0' } });
    await createRosterEntry({ tenantId: ANON, persona: 'Otto', agentRef: { agentId: 'b', version: '1.0.0' } });

    const res = await dedupePersonasBeforeAdopt(ANON, USER, storage);
    expect(res.rosterDropped).toBe(1);
    expect((await listRoster(ANON)).map((e) => e.persona).sort()).toEqual(['Otto']);
    expect((await listRoster(USER)).map((e) => e.persona)).toEqual(['Iris']);
  });
});
