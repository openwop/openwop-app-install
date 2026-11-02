/**
 * ADR 0175 Phase 3 — conversational-resume DECISION. `pickResumeInterrupt` resumes a
 * connection's active run only when it is non-terminal AND has an open interrupt awaiting
 * input; otherwise a new run starts. The actual resolve+resume rides the already-tested
 * host `resolveAndResume`, so this unit-tests the routing decision with a fake run store.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { pickResumeInterrupt, __setInboundSessionForTest, __resetInboundStore } from '../src/features/connections/inboundWebhooks.js';
import { pairConnection, getPairing, sendOutbound, setMessagingTransport, __resetMessagingOutbound, type OutboundMessage } from '../src/features/connections/messagingOutbound.js';
import type { RunStatus } from '../src/types.js';
import type { Storage } from '../src/storage/storage.js';

// The inbound-session and pairing stores are host-ext DurableCollections, so the
// host-ext persistence is all this needs — not a full createApp boot (w72).
beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetInboundStore();
});

/** A fake Storage exposing just the two reads `pickResumeInterrupt` uses.
 *  FIXTURE-HONESTY LIMIT (w72, recorded B†): `pickResumeInterrupt` takes the whole
 *  `Storage`, so a two-method fake needs this one cast; the statuses it returns
 *  are typed as the real `RunStatus`. */
function fakeStorage(run: { status: RunStatus } | null, interrupts: { interruptId: string }[]): Storage {
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

  // The app's REAL terminal statuses — the old fixture used 'succeeded', which
  // this host never writes, so dropping 'completed' from the terminal set stayed
  // green (w72 probe mgr-completed).
  it.each(['completed', 'failed', 'cancelled'] as const)('does NOT resume a terminal run (%s) — starts a new run instead', async (status) => {
    await __setInboundSessionForTest(`conn:b-${status}`, `run:b-${status}`);
    expect(await pickResumeInterrupt(fakeStorage({ status }, [{ interruptId: 'int:x' }]), `conn:b-${status}`)).toBeNull();
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
