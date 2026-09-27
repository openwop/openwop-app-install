/**
 * ADR 0175 Phase 3 — conversational-resume DECISION. `pickResumeInterrupt` resumes a
 * connection's active run only when it is non-terminal AND has an open interrupt awaiting
 * input; otherwise a new run starts. The actual resolve+resume rides the already-tested
 * host `resolveAndResume`, so this unit-tests the routing decision with a fake run store.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { pickResumeInterrupt, __setInboundSessionForTest, __resetInboundStore } from '../src/features/connections/inboundWebhooks.js';
import { pairConnection, getPairing, sendOutbound, setMessagingTransport, __resetMessagingOutbound, type OutboundMessage } from '../src/features/connections/messagingOutbound.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await __resetInboundStore();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** A fake Storage exposing just the two reads `pickResumeInterrupt` uses. */
function fakeStorage(run: { status: string } | null, interrupts: { interruptId: string }[]): Storage {
  return {
    getRun: async () => run,
    listOpenInterrupts: async () => interrupts,
  } as unknown as Storage;
}

describe('pickResumeInterrupt (Phase 3)', () => {
  it('returns null when the connection has no active session', async () => {
    expect(await pickResumeInterrupt(fakeStorage({ status: 'waiting-input' }, [{ interruptId: 'i1' }]), 'conn:none')).toBeNull();
  });

  it('resumes when the active run is non-terminal AND has an open interrupt', async () => {
    await __setInboundSessionForTest('conn:a', 'run:a');
    const res = await pickResumeInterrupt(fakeStorage({ status: 'waiting-input' }, [{ interruptId: 'int:1' }]), 'conn:a');
    expect(res).toEqual({ runId: 'run:a', interruptId: 'int:1' });
  });

  it('does NOT resume a terminal run (starts a new run instead)', async () => {
    await __setInboundSessionForTest('conn:b', 'run:b');
    expect(await pickResumeInterrupt(fakeStorage({ status: 'succeeded' }, [{ interruptId: 'int:x' }]), 'conn:b')).toBeNull();
  });

  it('does NOT resume when the run has no open interrupt', async () => {
    await __setInboundSessionForTest('conn:c', 'run:c');
    expect(await pickResumeInterrupt(fakeStorage({ status: 'running' }, []), 'conn:c')).toBeNull();
  });

  it('does NOT resume a run that no longer exists', async () => {
    await __setInboundSessionForTest('conn:d', 'run:gone');
    expect(await pickResumeInterrupt(fakeStorage(null, []), 'conn:d')).toBeNull();
  });
});

describe('messaging outbound + pairing (ADR 0175 follow-on)', () => {
  it('pairs a connection, and sends only when paired + a transport is wired', async () => {
    await __resetMessagingOutbound();
    // unpaired → no delivery
    expect(await sendOutbound('conn:x', 'hi')).toEqual({ delivered: false, reason: 'no_pairing' });
    // pair it
    const p = await pairConnection('conn:x', 'discord', 'chan:1');
    expect(p).toMatchObject({ connectionId: 'conn:x', provider: 'discord', channelId: 'chan:1' });
    expect((await getPairing('conn:x'))?.channelId).toBe('chan:1');
    // paired but no transport → honest no-op
    expect(await sendOutbound('conn:x', 'hi')).toEqual({ delivered: false, reason: 'no_transport' });
    // wire a mock transport → delivered
    const sent: OutboundMessage[] = [];
    setMessagingTransport(async (m) => { sent.push(m); return true; });
    expect(await sendOutbound('conn:x', 'hello world')).toEqual({ delivered: true });
    expect(sent[0]).toMatchObject({ channelId: 'chan:1', provider: 'discord', text: 'hello world' });
    await __resetMessagingOutbound();
  });
});
