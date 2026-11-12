/** ADR 0951 P2.1 — the closed, geometry-only recording format
 * (src/features/analytics/replayEvents.ts). A chunk is refused unless it is
 * exactly the inert layout/pointer/scroll vocabulary: no captured text,
 * attributes or URLs; masks are fixed-size opaque leaves; one structural root
 * precedes every node; geometry and time are on their grid and bounded; and
 * gzip inflation is capped inside zlib before any byte is parsed. A refusal
 * never echoes the refused content.
 *
 * Sabotage witnesses (w103; replayEvents.ts): echoing the input in the error
 * reds the no-echo case; relaxing the closed key set reds the content and
 * metadata cases; dropping the mask-size or masked-leaf check reds the mask
 * case; dropping the root, duplicate-id or child-inside-root check reds the
 * structure and coordinate cases; dropping the depth, per-frame or per-chunk
 * node bound reds the bounds case; dropping the geometry grid, the pointer or
 * scroll bound, or the viewport limit reds the coordinate case; dropping
 * monotone time, the time grid, the duration bound, the event bound or the
 * closed `else` reds the vocabulary case; dropping `maxOutputLength` reds the
 * zlib case; dropping the compressed-size or decoded-size precheck, or letting
 * a zlib error escape untyped, reds the input-bytes case; zeroing scroll
 * output reds the round trip. */
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
/** Deterministic (xorshift-seeded) JSON whitespace: about two bits of entropy per byte. */
const WHITESPACE = [32, 9, 10, 13] as const;
function whitespace(length: number): Buffer {
  const out = Buffer.alloc(length);
  let s = 0x2545f491;
  for (let i = 0; i < length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; out[i] = WHITESPACE[s & 3] ?? 32; }
  return out;
}

describe('ADR 0951 P2 geometry-only recording contract', () => {
  it('round-trips a masked layout and bounded interaction through real gzip', () => {
    expect(decodeReplayEventsGzip(gzipSync(encode(chunk())))).toEqual(chunk());
  });

  it.each(['text', 'html', 'value', 'class', 'idAttribute', 'style', 'src', 'href', 'data-owx-unmask', '__proto__'])
  ('refuses captured content or attributes under %s without echoing them', field => {
    const payload = { ...mask(), [field]: 'PRIVATE poison https://private.invalid/?token=secret' };
    const bytes = encode({ version: 1, events: [{ ...frame(), nodes: [root(), payload] }] });
    const refused = (() => { try { parseReplayEventsJson(bytes); return undefined; } catch (error) { return error; } })();
    expect(refused).toBeInstanceOf(ReplayEventFormatError);
    expect(String(refused)).not.toContain('PRIVATE');
    expect(String(refused)).not.toContain('private.invalid');
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
    for (const nodes of [[mask()], [root(), root()], [root(), mask(), mask()], [root(), { ...mask(), parent: 2 }],
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
    // The root is as wide as the viewport, so only the viewport limit can refuse it.
    expect(() => parse({ version: 1, events: [{ ...frame(), viewport: { width: L.viewport + 8, height: 600 }, nodes: [{ ...root(), width: L.viewport + 8 }] }] })).toThrow(ReplayEventFormatError);
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
    // Valid JSON one byte over the decoded bound: only the size precheck can refuse it.
    const json = encode(chunk());
    expect(() => parseReplayEventsJson(Buffer.concat([json, Buffer.alloc(L.decodedBytes + 1 - json.length, 32)]))).toThrow(ReplayEventFormatError);
    // A valid gzip of a valid chunk whose COMPRESSED size is over the bound (seeded
    // JSON whitespace barely compresses): refused before zlib runs at all.
    const oversized = gzipSync(Buffer.concat([json, whitespace(1_600_000)]));
    expect(oversized.length).toBeGreaterThan(L.compressedBytes);
    vi.clearAllMocks();
    expect(() => decodeReplayEventsGzip(oversized)).toThrow(ReplayEventFormatError);
    expect(gunzipSync).not.toHaveBeenCalled();
    expect(() => parseReplayEventsJson(Buffer.from([0xff, 0xfe]))).toThrow(ReplayEventFormatError);
    expect(() => decodeReplayEventsGzip(encode(chunk()))).toThrow(ReplayEventFormatError);
    expect(() => decodeReplayEventsGzip(gzipSync(encode(chunk())).subarray(0, 20))).toThrow(ReplayEventFormatError);
  });
});
