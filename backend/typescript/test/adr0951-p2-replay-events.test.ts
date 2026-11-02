import { gunzipSync, gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeReplayEventsGzip, parseReplayEventsJson, REPLAY_EVENT_LIMITS as L,
  ReplayEventFormatError } from '../src/features/analytics/replayEvents.js';

// Call real zlib and observe where refusal occurs. A generic parser rejection
// alone would still pass after removing the inflation-time allocation bound.
vi.mock('node:zlib', async importOriginal => {
  const original = await importOriginal<typeof import('node:zlib')>();
  return { ...original, gunzipSync: vi.fn(original.gunzipSync) };
});
beforeEach(() => { vi.clearAllMocks(); });

const root = () => ({ id: 1, parent: null, kind: 'box', x: 0, y: 0, width: 800, height: 1200 });
const mask = () => ({ id: 2, parent: 1, kind: 'masked', x: 16, y: 32, width: 64, height: 16 });
const frame = () => ({ type: 'frame', at: 0, viewport: { width: 800, height: 600 }, nodes: [root(), mask()] });
const chunk = () => ({ version: 1, events: [frame(), { type: 'pointer', at: 10, action: 'move', x: 24, y: 40 },
  { type: 'scroll', at: 20, x: 0, y: 160 }] });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const parse = (value: unknown) => parseReplayEventsJson(encode(value));

describe('ADR 0951 P2 geometry-only recording contract', () => {
  it('round-trips a masked layout and bounded interaction through real gzip', () => {
    expect(decodeReplayEventsGzip(gzipSync(encode(chunk())))).toEqual(chunk());
  });

  it.each(['text', 'html', 'value', 'class', 'idAttribute', 'style', 'src', 'href', 'data-owx-unmask', '__proto__'])
  ('refuses captured content or attributes under %s without echoing them', field => {
    const payload = { ...mask(), [field]: 'PRIVATE poison https://private.invalid/?token=secret' };
    const bytes = encode({ version: 1, events: [{ ...frame(), nodes: [root(), payload] }] });
    expect(() => parseReplayEventsJson(bytes)).toThrow(ReplayEventFormatError);
    try { parseReplayEventsJson(bytes); } catch (error) { expect(String(error)).not.toContain('PRIVATE'); }
  });

  it('refuses metadata containers at every level, including page URLs and event payloads', () => {
    for (const value of [
      { ...chunk(), url: 'https://private.invalid/person' },
      { version: 1, events: [{ ...frame(), url: '/account' }] },
      { version: 1, events: [{ ...frame(), viewport: { ...frame().viewport, style: 'url(https://private.invalid)' } }] },
      { version: 1, events: [frame(), { type: 'pointer', at: 10, action: 'down', x: 0, y: 0, value: 'password' }] },
      { version: 1, events: [frame(), { type: 'scroll', at: 10, x: 0, y: 0, target: 'person-email' }] },
    ]) expect(() => parse(value)).toThrow(ReplayEventFormatError);
  });

  it('refuses text-shaped mask sizes and descendants inside an opaque placeholder', () => {
    for (const node of [{ ...mask(), width: 72 }, { ...mask(), height: 24 }]) {
      expect(() => parse({ version: 1, events: [{ ...frame(), nodes: [root(), node] }] })).toThrow(ReplayEventFormatError);
    }
    expect(() => parse({ version: 1, events: [{ ...frame(), nodes: [root(), mask(), { ...mask(), id: 3, parent: 2 }] }] })).toThrow(ReplayEventFormatError);
  });

  it('requires one preceding structural root and rejects duplicate, cyclic and future node references', () => {
    for (const nodes of [[mask()], [root(), root()], [root(), { ...mask(), parent: 2 }],
      [root(), { ...mask(), parent: 3 }], [{ ...root(), parent: 2 }], [{ ...root(), x: 8 }]]) {
      expect(() => parse({ version: 1, events: [{ ...frame(), nodes }] })).toThrow(ReplayEventFormatError);
    }
  });

  it('bounds depth and both per-frame and total chunk nodes', () => {
    const nested = Array.from({ length: L.depth + 1 }, (_, i) => ({ ...root(), id: i + 1, parent: i ? i : null }));
    expect(() => parse({ version: 1, events: [{ ...frame(), nodes: nested }] })).toThrow(ReplayEventFormatError);
    const many = [root(), ...Array.from({ length: L.nodesPerFrame }, (_, i) => ({ ...mask(), id: i + 2 }))];
    expect(() => parse({ version: 1, events: [{ ...frame(), nodes: many }] })).toThrow(ReplayEventFormatError);
    const full = { ...frame(), nodes: many.slice(0, L.nodesPerFrame) };
    expect(parse({ version: 1, events: [full] }).events).toHaveLength(1);
    expect(() => parse({ version: 1, events: Array.from({ length: 6 }, () => full) })).toThrow(ReplayEventFormatError);
  });

  it('refuses unsafe coordinates, non-grid precision, invalid kinds and out-of-viewport pointers', () => {
    for (const node of [{ ...mask(), x: -8 }, { ...mask(), x: 1 }, { ...mask(), x: L.coordinate },
      { ...mask(), width: 0 }, { ...mask(), kind: 'script' }, { ...mask(), id: 'person' }]) {
      expect(() => parse({ version: 1, events: [{ ...frame(), nodes: [root(), node] }] })).toThrow(ReplayEventFormatError);
    }
    expect(() => parse({ version: 1, events: [frame(), { type: 'pointer', at: 10, action: 'move', x: 808, y: 0 }] })).toThrow(ReplayEventFormatError);
    expect(() => parse({ version: 1, events: [frame(), { type: 'scroll', at: 10, x: 8, y: 0 }] })).toThrow(ReplayEventFormatError);
    expect(() => parse({ version: 1, events: [frame(), { type: 'scroll', at: 10, x: 0, y: 608 }] })).toThrow(ReplayEventFormatError);
    expect(() => parse({ version: 1, events: [{ ...frame(), nodes: [root(), { ...mask(), x: 800 }] }] })).toThrow(ReplayEventFormatError);
    expect(() => parse({ version: 1, events: [{ ...frame(), viewport: { width: L.viewport + 8, height: 600 } }] })).toThrow(ReplayEventFormatError);
  });

  it('requires an independently decodable starting frame, bounded monotone time and a closed event vocabulary', () => {
    for (const event of [{ type: 'html', at: 10 }, { type: 'scroll', at: 9, x: 0, y: 0 },
      { type: 'scroll', at: L.durationMs + 10, x: 0, y: 0 },
      { type: 'pointer', at: 10, action: 'keypress', x: 0, y: 0 }]) {
      expect(() => parse({ version: 1, events: [frame(), event] })).toThrow(ReplayEventFormatError);
    }
    expect(() => parse({ version: 1, events: [{ type: 'scroll', at: 0, x: 0, y: 0 }] })).toThrow(ReplayEventFormatError);
    expect(() => parse({ version: 1, events: [{ ...frame(), at: 20 }, { type: 'scroll', at: 10, x: 0, y: 0 }] })).toThrow(ReplayEventFormatError);
    expect(() => parse({ version: 1, events: [frame(), ...Array.from({ length: L.events }, () => ({ type: 'scroll', at: 10, x: 0, y: 0 }))] })).toThrow(ReplayEventFormatError);
  });

  it('stops expansion inside real zlib, with a valid JSON control at the exact decoded limit', () => {
    const json = encode(chunk());
    const atLimit = Buffer.concat([json, Buffer.alloc(L.decodedBytes - json.length, 32)]);
    expect(parseReplayEventsJson(atLimit)).toEqual(chunk());
    expect(decodeReplayEventsGzip(gzipSync(atLimit))).toEqual(chunk());
    expect(vi.mocked(gunzipSync).mock.results.at(-1)?.type).toBe('return');
    vi.clearAllMocks();

    const bomb = gzipSync(Buffer.concat([atLimit, Buffer.from(' ')]));
    expect(bomb.length).toBeLessThan(L.compressedBytes);
    expect(() => decodeReplayEventsGzip(bomb)).toThrow(ReplayEventFormatError);
    expect(gunzipSync).toHaveBeenCalledTimes(1);
    // Removing maxOutputLength makes real zlib return successfully, even though
    // the later decoded-size guard still rejects the same input.
    expect(vi.mocked(gunzipSync).mock.results.at(-1)?.type).toBe('throw');
  });

  it('bounds input bytes and refuses invalid UTF-8, non-gzip and truncated gzip', () => {
    expect(() => parseReplayEventsJson(Buffer.alloc(L.decodedBytes + 1))).toThrow(ReplayEventFormatError);
    expect(() => decodeReplayEventsGzip(Buffer.alloc(L.compressedBytes + 1))).toThrow(ReplayEventFormatError);
    expect(() => parseReplayEventsJson(Buffer.from([0xff, 0xfe]))).toThrow(ReplayEventFormatError);
    expect(() => decodeReplayEventsGzip(encode(chunk()))).toThrow(ReplayEventFormatError);
    expect(() => decodeReplayEventsGzip(gzipSync(encode(chunk())).subarray(0, 20))).toThrow(ReplayEventFormatError);
  });
});
