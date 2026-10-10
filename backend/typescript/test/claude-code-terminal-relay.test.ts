/**
 * ADR 0785 P2 — the terminal relay, unit-level, including the CROSS-INSTANCE path.
 *
 * Two TerminalRelay instances share one in-process bus, standing in for two
 * Cloud Run instances on one Postgres LISTEN. What is pinned:
 *   - same-instance output never touches the bus (the Q2 database-budget concern);
 *   - a viewer on instance B sees output from a device on instance A, only after
 *     B declared interest, and in NOTIFY-sized chunks;
 *   - a re-attaching viewer gets the replay FIRST and never a duplicate of bytes
 *     already inside it (the ordering argument in terminalRelay.ts);
 *   - input from a remote viewer reaches the device.
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, TerminalRelay, type RelayConn } from '../src/features/claude-code/terminalRelay.js';

function bus() {
  const subs = new Map<string, Set<(p: string) => void>>();
  const published: { channel: string; payload: string }[] = [];
  return {
    published,
    publish: async (channel: string, payload: string) => {
      published.push({ channel, payload });
      for (const h of [...(subs.get(channel) ?? [])]) h(payload);
    },
    subscribe: async (channel: string, handler: (p: string) => void) => {
      const set = subs.get(channel) ?? new Set();
      set.add(handler); subs.set(channel, set);
      return async () => { set.delete(handler); };
    },
  };
}

function conn() {
  const json: unknown[] = []; const bin: Buffer[] = []; const closed: [number, string][] = [];
  const c: RelayConn & { json: unknown[]; bin: Buffer[]; closed: [number, string][]; text: () => string } = {
    json, bin, closed,
    sendJson: (m) => json.push(m), sendBinary: (d) => bin.push(Buffer.from(d)), close: (code, reason) => closed.push([code, reason]),
    text: () => Buffer.concat(bin).toString(),
  };
  return c;
}
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('ADR 0785 P2 — terminal relay', () => {
  it('same instance: output reaches the viewer and the bus is never used for bytes', async () => {
    const b = bus();
    const relay = new TerminalRelay({ instanceId: 'A', publish: b.publish, subscribe: b.subscribe });
    const device = conn(); const viewer = conn();
    await relay.attachDevice('d1', device);
    const viewerId = await relay.attachViewer('s1', 'd1', viewer);
    expect(device.json).toContainEqual({ type: 'attach', sessionId: 's1', viewerId });
    await relay.onDeviceFrame({ type: 'replay', sessionId: 's1', viewerId, data: b64('history ') });
    await relay.onDeviceFrame({ type: 'output', sessionId: 's1', data: b64('live') });
    expect(viewer.text()).toBe('history live');
    expect(b.published.filter((p) => p.channel.startsWith('cc:term:'))).toEqual([]);
  });

  it('REPLAY ORDER: output before the replay is dropped (it is inside the replay), never duplicated', async () => {
    const b = bus();
    const relay = new TerminalRelay({ instanceId: 'A', publish: b.publish, subscribe: b.subscribe });
    const device = conn(); const viewer = conn();
    await relay.attachDevice('d1', device);
    const viewerId = await relay.attachViewer('s1', 'd1', viewer);
    // The device emitted this before it snapshotted — so the snapshot contains it.
    await relay.onDeviceFrame({ type: 'output', sessionId: 's1', data: b64('abc') });
    await relay.onDeviceFrame({ type: 'replay', sessionId: 's1', viewerId, data: b64('abc') });
    await relay.onDeviceFrame({ type: 'output', sessionId: 's1', data: b64('def') });
    expect(viewer.text()).toBe('abcdef');
  });

  it('CROSS-INSTANCE: a viewer on B sees a device on A, in NOTIFY-sized chunks, and its input reaches the device', async () => {
    const b = bus();
    const A = new TerminalRelay({ instanceId: 'A', publish: b.publish, subscribe: b.subscribe });
    const B = new TerminalRelay({ instanceId: 'B', publish: b.publish, subscribe: b.subscribe });
    const device = conn(); const viewer = conn();
    await A.attachDevice('d1', device);

    // Before anyone on B watches, A publishes no bytes.
    await A.onDeviceFrame({ type: 'output', sessionId: 's1', data: b64('nobody-watching') });
    expect(b.published.some((p) => p.channel === 'cc:term:s1')).toBe(false);

    const viewerId = await B.attachViewer('s1', 'd1', viewer);
    expect(device.json).toContainEqual({ type: 'attach', sessionId: 's1', viewerId });

    // A large replay crosses the bus in chunks that fit NOTIFY.
    const big = 'x'.repeat(CHUNK_BYTES * 2 + 17);
    await A.onDeviceFrame({ type: 'replay', sessionId: 's1', viewerId, data: b64(big) });
    await A.onDeviceFrame({ type: 'output', sessionId: 's1', data: b64('!') });
    expect(viewer.text()).toBe(`${big}!`);
    for (const p of b.published) expect(Buffer.byteLength(p.payload)).toBeLessThan(8000);

    await B.viewerInput('s1', Buffer.from('ls\r'));
    expect(device.json).toContainEqual({ type: 'input', sessionId: 's1', data: b64('ls\r') });

    await A.onDeviceFrame({ type: 'exit', sessionId: 's1', code: 0, requested: false });
    expect(viewer.json).toContainEqual({ type: 'exit', code: 0, requested: false });
  });

  it('a second connection for the same device replaces the first', async () => {
    const b = bus();
    const relay = new TerminalRelay({ instanceId: 'A', publish: b.publish, subscribe: b.subscribe });
    const first = conn(); const second = conn();
    await relay.attachDevice('d1', first);
    await relay.attachDevice('d1', second);
    expect(first.closed[0]?.[0]).toBe(4000);
    await relay.detachDevice('d1', first); // the stale socket's close handler must not evict the new one
    expect(relay.hasLocalDevice('d1')).toBe(true);
  });

  it('closeDevice reaches a device held on another instance (revocation)', async () => {
    const b = bus();
    const A = new TerminalRelay({ instanceId: 'A', publish: b.publish, subscribe: b.subscribe });
    const B = new TerminalRelay({ instanceId: 'B', publish: b.publish, subscribe: b.subscribe });
    const device = conn();
    await A.attachDevice('d1', device);
    await B.closeDevice('d1', 'revoked');
    expect(device.closed).toEqual([[4001, 'revoked']]);
  });

  it('the last viewer leaving drops the bus subscription', async () => {
    const b = bus();
    const A = new TerminalRelay({ instanceId: 'A', publish: b.publish, subscribe: b.subscribe });
    const B = new TerminalRelay({ instanceId: 'B', publish: b.publish, subscribe: b.subscribe });
    await A.attachDevice('d1', conn());
    const viewer = conn();
    const vid = await B.attachViewer('s1', 'd1', viewer);
    await B.detachViewer('s1', vid);
    expect(B.localViewerCount('s1')).toBe(0);
    await A.onDeviceFrame({ type: 'output', sessionId: 's1', data: b64('late') });
    expect(viewer.bin).toEqual([]);
  });
});
