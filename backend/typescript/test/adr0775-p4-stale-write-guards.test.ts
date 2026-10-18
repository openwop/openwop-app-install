/**
 * ADR 0775 P4 (`ARWF-11`) — agent-area edits no longer overwrite each other.
 *
 * Each race test injects the concurrent write INSIDE the victim's
 * read→write window (the first compare-and-swap it attempts), which is the only
 * way to witness a lost update deterministically. Before P4 these writers did
 * get→put, and the injected write was silently discarded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetRosterStore,
  createRosterEntry,
  getRosterEntry,
  recordHeartbeat,
  rosterEtag,
  updateRosterEntry,
} from '../src/host/rosterService.js';
import {
  __resetAgentProfileStore,
  agentProfileEtag,
  getAgentProfile,
  putAgentProfileMerged,
  setAgentMemoryScope,
  upsertAgentProfile,
  type AgentProfileInput,
} from '../src/host/agentProfileService.js';
import { entityEtag, parseIfMatch } from '../src/host/entityVersion.js';
import type { UserAgentRecord } from '../src/types.js';

const T = 'tenant-p4';
const storage = openSqliteStorage(':memory:');

/** Run `concurrent` once, just before the first swap on a key containing `marker`. */
function injectBeforeFirstSwap(marker: string, concurrent: () => Promise<void>): void {
  const realCas = storage.kvCompareAndSwap.bind(storage);
  let fired = false;
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
    if (!fired && key.includes(marker)) {
      fired = true;
      await concurrent();
    }
    return realCas(key, expected, next);
  });
}

beforeAll(() => initHostExtPersistence(storage));
afterAll(async () => {
  __resetHostExtPersistence();
  await storage.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  initHostExtPersistence(storage);
  await __resetRosterStore();
  await __resetAgentProfileStore();
});

async function member(): Promise<string> {
  const e = await createRosterEntry({
    tenantId: T,
    persona: 'Pat',
    agentRef: { agentId: 'core.openwop.agents.brief-writer', channel: 'stable' },
    workflows: ['wf.a'],
  });
  return e.rosterId;
}

describe('entity versions', () => {
  it('ignores key order and omitted keys, and parses every If-Match spelling', () => {
    expect(entityEtag({ a: 1, b: 2 })).toBe(entityEtag({ b: 2, a: 1 }));
    expect(entityEtag({ a: 1, t: 'x' }, ['t'])).toBe(entityEtag({ a: 1, t: 'y' }, ['t']));
    expect(entityEtag({ a: 1 })).not.toBe(entityEtag({ a: 2 }));
    expect(parseIfMatch('"abc"')).toBe('abc');
    expect(parseIfMatch('W/"abc"')).toBe('abc');
    expect(parseIfMatch('abc')).toBe('abc');
    expect(parseIfMatch('*')).toBeUndefined();
    expect(parseIfMatch(undefined)).toBeUndefined();
  });
});

describe('roster (ARWF-11)', () => {
  it('a heartbeat stamp does not change the version; an edit does', async () => {
    const id = await member();
    const before = rosterEtag((await getRosterEntry(T, id))!);
    await recordHeartbeat(T, id);
    expect(rosterEtag((await getRosterEntry(T, id))!)).toBe(before);
    await updateRosterEntry(T, id, { label: 'New' });
    expect(rosterEtag((await getRosterEntry(T, id))!)).not.toBe(before);
  });

  it('a stale If-Match is refused with 409 and the row is untouched', async () => {
    const id = await member();
    const stale = rosterEtag((await getRosterEntry(T, id))!);
    await updateRosterEntry(T, id, { label: 'First editor' });
    await expect(updateRosterEntry(T, id, { label: 'Second editor' }, { ifMatch: stale })).rejects.toMatchObject({
      httpStatus: 409,
      details: { reason: 'stale_write' },
    });
    expect((await getRosterEntry(T, id))?.label).toBe('First editor');
  });

  it('a current If-Match is accepted', async () => {
    const id = await member();
    const current = rosterEtag((await getRosterEntry(T, id))!);
    expect((await updateRosterEntry(T, id, { label: 'Ok' }, { ifMatch: current }))?.label).toBe('Ok');
  });

  it('a heartbeat does not overwrite a pause that lands inside its read→write window', async () => {
    const id = await member();
    injectBeforeFirstSwap(id, async () => {
      vi.restoreAllMocks(); // the pause itself must not re-enter the injection
      await updateRosterEntry(T, id, { enabled: false });
      injectBeforeFirstSwap('never-matches', async () => undefined);
    });
    await recordHeartbeat(T, id);
    const row = await getRosterEntry(T, id);
    expect(row?.enabled).toBe(false);
    expect(row?.lastHeartbeatAt).toBeDefined();
  });

  it('two PATCHes to different fields both land', async () => {
    const id = await member();
    injectBeforeFirstSwap(id, async () => {
      vi.restoreAllMocks();
      await updateRosterEntry(T, id, { description: 'from the other tab' });
    });
    await updateRosterEntry(T, id, { label: 'from this tab' });
    const row = await getRosterEntry(T, id);
    expect(row).toMatchObject({ label: 'from this tab', description: 'from the other tab' });
  });

  it('a PATCH with If-Match that loses the race is refused, not applied', async () => {
    const id = await member();
    const version = rosterEtag((await getRosterEntry(T, id))!);
    injectBeforeFirstSwap(id, async () => {
      vi.restoreAllMocks();
      await updateRosterEntry(T, id, { label: 'other' });
    });
    await expect(updateRosterEntry(T, id, { label: 'mine' }, { ifMatch: version })).rejects.toMatchObject({ httpStatus: 409 });
    expect((await getRosterEntry(T, id))?.label).toBe('other');
  });
});

const BASE_PROFILE: AgentProfileInput = {
  roleKey: 'custom',
  autonomy: { specLevel: 'draft-only' },
};

describe('agent profile PUT (ARWF-11)', () => {
  it('merges: a field the caller omits is kept, a cleared one is removed', async () => {
    await upsertAgentProfile(T, 'p1', {
      ...BASE_PROFILE,
      channels: { approval: 'slack' },
      hitl: ['refund'],
      metrics: ['m1'],
    });
    const saved = await putAgentProfileMerged(T, 'p1', { ...BASE_PROFILE, hitl: ['refund', 'delete'] }, {
      clear: new Set(['metrics'] as const),
    });
    expect(saved.channels).toEqual({ approval: 'slack' }); // omitted → kept
    expect(saved.hitl).toEqual(['refund', 'delete']); // sent → replaced
    expect(saved.metrics).toBeUndefined(); // cleared → removed
  });

  it('a stale If-Match is refused with 409', async () => {
    const p = await upsertAgentProfile(T, 'p2', BASE_PROFILE);
    const stale = agentProfileEtag(p);
    await putAgentProfileMerged(T, 'p2', { ...BASE_PROFILE, hitl: ['a'] });
    await expect(putAgentProfileMerged(T, 'p2', { ...BASE_PROFILE, hitl: ['b'] }, { ifMatch: stale })).rejects.toMatchObject({
      httpStatus: 409,
      details: { reason: 'stale_write' },
    });
    expect((await getAgentProfile(T, 'p2'))?.hitl).toEqual(['a']);
  });

  it('keeps a subsystem write (memory scope) that lands inside the PUT window', async () => {
    await upsertAgentProfile(T, 'p3', BASE_PROFILE);
    injectBeforeFirstSwap('p3', async () => {
      vi.restoreAllMocks();
      await setAgentMemoryScope(T, 'p3', 'per-user', BASE_PROFILE);
    });
    await putAgentProfileMerged(T, 'p3', { ...BASE_PROFILE, hitl: ['x'] });
    const p = await getAgentProfile(T, 'p3');
    expect(p).toMatchObject({ memoryScope: 'per-user', hitl: ['x'] });
  });

  it('a subsystem write does not overwrite a PUT that lands inside its window', async () => {
    await upsertAgentProfile(T, 'p4', BASE_PROFILE);
    injectBeforeFirstSwap('p4', async () => {
      vi.restoreAllMocks();
      await putAgentProfileMerged(T, 'p4', { ...BASE_PROFILE, hitl: ['from-editor'] });
    });
    await setAgentMemoryScope(T, 'p4', 'per-user', BASE_PROFILE);
    expect(await getAgentProfile(T, 'p4')).toMatchObject({ memoryScope: 'per-user', hitl: ['from-editor'] });
  });
});

describe('user-agent storage compare-and-swap (ARWF-11)', () => {
  const record: UserAgentRecord = {
    agentId: 'user.p4-agent',
    tenantId: T,
    persona: 'p4-agent',
    modelClass: 'chat',
    systemPrompt: 'v1',
    toolAllowlist: [],
    memoryShape: { scratchpad: false, conversation: false, longTerm: false },
    createdAt: new Date(0).toISOString(),
  };

  it('updates only while every editable column still equals `expected`', async () => {
    await storage.insertUserAgent(record);
    const read = (await storage.getUserAgent(T, record.agentId))!;
    // Another editor lands first.
    expect(await storage.updateUserAgent(T, { ...read, systemPrompt: 'theirs' }, read)).toBe(true);
    // This editor's swap against the stale read must not match.
    expect(await storage.updateUserAgent(T, { ...read, systemPrompt: 'mine' }, read)).toBe(false);
    expect((await storage.getUserAgent(T, record.agentId))?.systemPrompt).toBe('theirs');
    // Without `expected` the legacy unconditional update still works.
    expect(await storage.updateUserAgent(T, { ...read, systemPrompt: 'forced' })).toBe(true);
  });
});
