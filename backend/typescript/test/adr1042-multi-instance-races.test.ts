/**
 * ADR 1042 CHAN-F3 — the multi-instance races in the channel core. Turns are
 * serialised per thread only within ONE process, so each case below is the state
 * a second instance (or a crash) can produce:
 *
 *  (a) runIds read-modify-write: concurrent run recordings on one thread all land
 *      (`recordThreadRun` is a compare-and-swap), it never re-creates an erased
 *      thread, and a racing first message's thread creation never overwrites runs
 *      already recorded (`createThreadOnce`);
 *  (b) N3: over its lane bound the pending-recording budget evicts idle lanes one
 *      at a time, so a lane being flooded stays limited (it used to `clear()` every
 *      lane at once);
 *  (c) a detached turn whose exchange fails is retried, and answered; one that
 *      keeps failing stops after the retries and drops its pending reply; one whose
 *      exchange key another instance holds (`in_progress`) is not retried;
 *  (d) M4 at queued start: a turn that waited behind another on its thread
 *      re-checks the owner's presence when it starts, and runs nothing for an owner
 *      removed meanwhile.
 * H2 (two instances spending one approval) is in `adr1042-single-use-approvals.test.ts`.
 *
 * Red when: run recording goes back to read-then-put, or re-creates a missing
 * thread; thread creation goes back to `put`; the budget map clears instead of
 * evicting; a failed turn is not retried, is retried past its bound, or an
 * `in_progress` conflict is retried; the queued-start presence check is removed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The exchange entry point and the membership check, wrapped so a case can make a
// turn fail, hold a turn mid-flight, or remove an owner at a chosen moment. The
// real implementations run unless a case overrides one call.
const revokedOwners = new Set<string>();
vi.mock('../src/host/conversationExchange.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/conversationExchange.js')>();
  return { ...real, handleConversationResolve: vi.fn(real.handleConversationResolve) };
});
vi.mock('../src/host/accessControlService.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/accessControlService.js')>();
  const isWorkspaceMember: typeof real.isWorkspaceMember = async (...args) =>
    (revokedOwners.has(String(args[0])) ? false : real.isWorkspaceMember(...args));
  return { ...real, isWorkspaceMember };
});

import { bootChannelHarness, CONN, field, text, type ChannelHarness } from './support/channelCoreHarness.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerReplyTransport, type ChannelReply } from '../src/features/connections/messagingOutbound.js';
import { handleConversationResolve } from '../src/host/conversationExchange.js';
import { OpenwopError } from '../src/types.js';
import {
  channelIngressStores, createThreadOnce, exchangeKeyOf, getPendingReply, getThread, putThread, recordThreadRun, type ChannelThread,
} from '../src/features/channel-ingress/stores.js';
import {
  __resetPendingRecordTimes, __setTurnRetryDelaysMs, PENDING_RECORD_LANES_MAX, pendingRecordAllowed,
} from '../src/features/channel-ingress/ingress.js';

const resolveSpy = vi.mocked(handleConversationResolve);
let h: ChannelHarness;
const sent: ChannelReply[] = [];
const TG_SECRET = 'tg-f3-secret-0123456789abcdef';

async function setToggle(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('channel-ingress');
  await saveConfig({ ...d!, status }, 'test');
}
async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 8_000): Promise<T> {
  return vi.waitFor(async () => {
    const v = await fn();
    if (v === undefined) throw new Error('timed out waiting');
    return v;
  }, { timeout: ms, interval: 25 });
}

beforeAll(async () => {
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '10000';
  h = await bootChannelHarness('c1042f3');
  registerReplyTransport('telegram', async (r) => { sent.push(r); return { sent: true, providerRef: `tg-${sent.length}` }; });
  await setToggle('on');
  __setTurnRetryDelaysMs([20, 20]);
}, 120_000);
afterAll(async () => {
  __setTurnRetryDelaysMs([2_000, 8_000]);
  await setToggle('off');
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN;
  await h.close();
});
afterEach(() => { revokedOwners.clear(); });

async function connectionWithSender(senderId: string): Promise<string> {
  const editor = await h.editor();
  const created = await h.call(CONN, editor, 'POST', { provider: 'telegram', kind: 'bearer', secret: '777:tokenvalue' });
  const id = text(field(created.body, 'connectionId'));
  await h.call(`${CONN}/${encodeURIComponent(id)}/inbound`, editor, 'PUT', { signingSecret: TG_SECRET });
  await h.call(`${CONN}/${encodeURIComponent(id)}/channel`, editor, 'PUT', { provider: 'mock', model: 'mock-1' });
  expect((await h.call(`${CONN}/${encodeURIComponent(id)}/senders`, editor, 'POST', { senderId })).status).toBe(201);
  return id;
}
const tg = (updateId: number, fromId: number, msg: string) => ({
  update_id: updateId, message: { message_id: updateId * 10, chat: { id: fromId, type: 'private' }, from: { id: fromId }, text: msg },
});
async function deliver(connectionId: string, body: unknown): Promise<number> {
  const res = await fetch(`${h.base}/host/openwop-app/connections-inbound/${encodeURIComponent(connectionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TG_SECRET }, body: JSON.stringify(body),
  });
  return res.status;
}
const keyOf = (connectionId: string, chatId: number, updateId: number): string =>
  exchangeKeyOf(`conn:${connectionId}`, String(chatId), undefined, String(updateId * 10));
const callsFor = (exchangeKey: string): number =>
  resolveSpy.mock.calls.filter((c) => (c[2] as { exchangeKey?: string } | undefined)?.exchangeKey === exchangeKey).length;

function thread(threadKey: string, extra: Partial<ChannelThread> = {}): ChannelThread {
  const now = '2026-11-10T00:00:00.000Z';
  return {
    threadKey, tenantId: 'tenant:f3-store', lane: { kind: 'connection', connectionId: 'c', provider: 'telegram' } as ChannelThread['lane'],
    chatId: '1', conversationId: `ch-${threadKey}`, ownerUserId: 'user:o', scope: 'narrow', createdAt: now, updatedAt: now, ...extra,
  };
}

describe('(a) the runIds read-modify-write race', () => {
  it('concurrent recordings on one thread all land', async () => {
    await putThread(thread('f3-cas'));
    const ids = Array.from({ length: 12 }, (_, i) => `run_f3_${i}`);
    expect(await Promise.all(ids.map((id) => recordThreadRun('f3-cas', id)))).toEqual(ids.map(() => true));
    expect([...((await getThread('f3-cas'))?.runIds ?? [])].sort()).toEqual([...ids].sort());
  });

  it('never re-creates a thread that is gone (erasure deleted it)', async () => {
    expect(await recordThreadRun('f3-erased', 'run_after_erasure')).toBe(false);
    expect(await getThread('f3-erased')).toBeNull();
  });

  it('a racing first message never overwrites a thread whose runs are recorded', async () => {
    const first = await createThreadOnce(thread('f3-create'));
    expect(await recordThreadRun(first.threadKey, 'run_first')).toBe(true);
    const second = await createThreadOnce(thread('f3-create', { createdAt: '2026-11-10T00:00:01.000Z' }));
    expect(second.runIds).toEqual(['run_first']);
    expect((await getThread('f3-create'))?.runIds).toEqual(['run_first']);
  });
});

describe('(b) N3: the pending-recording budget evicts idle lanes, never every lane', () => {
  it('a lane being flooded stays limited past the lane bound', () => {
    __resetPendingRecordTimes();
    const now = Date.now();
    for (let i = 0; i < 30; i++) expect(pendingRecordAllowed('lane:flooded', now)).toBe(true);
    expect(pendingRecordAllowed('lane:flooded', now)).toBe(false);
    for (let i = 0; i <= PENDING_RECORD_LANES_MAX; i++) {
      expect(pendingRecordAllowed(`lane:other-${i}`, now)).toBe(true);
      // The flood keeps arriving while the other lanes fill the map.
      if (i % 1_000 === 0) expect(pendingRecordAllowed('lane:flooded', now)).toBe(false);
    }
    expect(pendingRecordAllowed('lane:flooded', now)).toBe(false);
    // The idle lane evicted first starts a fresh budget.
    expect(pendingRecordAllowed('lane:other-0', now)).toBe(true);
    __resetPendingRecordTimes();
  });
});

describe('(c) a detached turn is not lost on failure', () => {
  it('a failed exchange is retried and answered', async () => {
    const id = await connectionWithSender('901');
    resetMockPrograms();
    programMock('', [{ content: 'answered after retries' }]);
    resolveSpy.mockRejectedValueOnce(new Error('instance went away')).mockRejectedValueOnce(new Error('again'));
    expect(await deliver(id, tg(91, 901, 'are you there?'))).toBe(202);
    const reply = await waitFor(() => sent.find((r) => r.chatId === '901'));
    expect(reply.text).toBe('answered after retries');
    expect(callsFor(keyOf(id, 901, 91))).toBe(3);
  });

  it('a turn that keeps failing stops after its retries and drops its pending reply', async () => {
    const id = await connectionWithSender('902');
    resolveSpy.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x'));
    expect(await deliver(id, tg(92, 902, 'hello?'))).toBe(202);
    const key = keyOf(id, 902, 92);
    await waitFor(async () => ((await getPendingReply(key)) === null ? true : undefined));
    expect(callsFor(key)).toBe(3);
    expect(sent.filter((r) => r.chatId === '902')).toEqual([]);
  });

  it('an exchange another instance holds (in_progress) is not retried', async () => {
    const id = await connectionWithSender('903');
    resolveSpy.mockRejectedValueOnce(new OpenwopError('conflict', 'an exchange with this key is already in progress', 409));
    expect(await deliver(id, tg(93, 903, 'hi'))).toBe(202);
    const key = keyOf(id, 903, 93);
    await waitFor(() => (callsFor(key) >= 1 ? true : undefined));
    // Give a would-be retry (20 ms) ample time to happen.
    await new Promise((r) => setTimeout(r, 300));
    expect(callsFor(key)).toBe(1);
    // The other instance owns the reply, so this one leaves it.
    expect(await getPendingReply(key)).not.toBeNull();
  });
});

describe('(d) M4 at queued start', () => {
  it('a turn queued behind another runs nothing when its owner was removed meanwhile', async () => {
    const id = await connectionWithSender('904');
    resetMockPrograms();
    programMock('', [{ content: 'first' }, { content: 'second' }]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = resolveSpy.getMockImplementation()!;
    resolveSpy.mockImplementationOnce(async (...args) => { await gate; return real(...args); });

    expect(await deliver(id, tg(94, 904, 'first message'))).toBe(202);
    const first = keyOf(id, 904, 94);
    await waitFor(() => (callsFor(first) === 1 ? true : undefined)); // turn 1 is inside the exchange
    expect(await deliver(id, tg(95, 904, 'second message'))).toBe(202); // queued behind it
    const second = keyOf(id, 904, 95);
    revokedOwners.add(h.editorUserId);
    release();

    await waitFor(async () => ((await getPendingReply(second)) === null ? true : undefined));
    expect(callsFor(second)).toBe(0);
    expect(sent.filter((r) => r.chatId === '904')).toEqual([]); // turn 1's reply is dropped too (the settled observer's check)
    expect((await channelIngressStores.threads.listForTenantIndexed(h.ws)).some((t) => t.chatId === '904')).toBe(true);
  });
});
