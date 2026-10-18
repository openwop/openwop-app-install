/**
 * CLNP-2(c) — the network inspector's SSE timeline actually populates.
 *
 * It never could: its only writer had no caller, and the row was closed when the
 * headers arrived, so appends were dropped anyway. These drive the REAL recorder over
 * a stubbed `fetch` returning a real `text/event-stream` body, because both halves of
 * the defect were wiring, not parsing.
 *
 * Every case owns its stream (no shared state across cases — the file passes shuffled).
 * Sabotage that turns it red: normalising a trailing lone `\r` eagerly (a split `\r\n`
 * then reads as a false frame end), not forwarding the caller's bytes, dropping the
 * Response `url`, ignoring the sink's stop signal, ending the row at the event cap
 * instead of at stream end, closing the row when headers arrive, or changing the
 * timeline/mirror caps.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { frameData, tapSseResponse } from '../sseCapture.js';

const enc = new TextEncoder();

/** A stream whose chunks the test pushes, so frame boundaries can be split on purpose. */
function controllable() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; }, cancel });
  return { body, push: (s: string) => ctl.enqueue(enc.encode(s)), close: () => ctl.close(), cancel };
}

describe('frameData', () => {
  it('joins multi-line data, strips one leading space, ignores comments', () => {
    expect(frameData('event: x\ndata: {"a":1}')).toBe('{"a":1}');
    expect(frameData('data: one\ndata:two')).toBe('one\ntwo');
    expect(frameData(': ping')).toBeNull();
  });
});

describe('tapSseResponse', () => {
  it('parses frames split across chunks (incl. a CRLF split), and the caller still reads every byte', async () => {
    const s = controllable();
    const got: string[] = [];
    const onEnd = vi.fn();
    const res = new Response(s.body, { headers: { 'content-type': 'text/event-stream' } });
    Object.defineProperty(res, 'url', { value: 'http://h/runs/r1/events' });
    const out = tapSseResponse(res, { onEvent: (d) => { got.push(d); return true; }, onEnd });
    expect(out.url).toBe('http://h/runs/r1/events'); // a constructed Response would be ''
    // The `\r` ending chunk 1 is half of a `\r\n` LINE end (not a blank line): the frame
    // continues with a second data line. Normalising the lone `\r` eagerly would read
    // `\r` + `\n` as a frame end and split it into two events.
    s.push('data: {"n":1}\r');
    s.push('\ndata: {"m":1}\r\n\r\ndata: {"n"');
    s.push(':2}\n\n: ping\n\n');
    s.close();
    const callerText = await out.text();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledWith(undefined));
    expect(got).toEqual(['{"n":1}\n{"m":1}', '{"n":2}']);
    expect(callerText).toBe('data: {"n":1}\r\ndata: {"m":1}\r\n\r\ndata: {"n":2}\n\n: ping\n\n');
  });

  it('past the cap it stops PARSING but the caller still gets every byte, and onEnd fires at the REAL end', async () => {
    const s = controllable();
    const onEnd = vi.fn();
    const onEvent = vi.fn(() => false); // the sink is full after the first event
    const out = tapSseResponse(new Response(s.body), { onEvent, onEnd });
    const reader = out.body!.getReader();
    const dec = new TextDecoder();
    let caller = '';
    s.push('data: 1\n\n');
    caller += dec.decode((await reader.read()).value);
    s.push('data: 2\n\n');
    caller += dec.decode((await reader.read()).value);
    // Both chunks have now passed the transform (it parses as it forwards).
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEnd, 'stopping capture is NOT the stream ending').not.toHaveBeenCalled();
    s.close();
    expect((await reader.read()).done).toBe(true);
    expect(caller).toBe('data: 1\n\ndata: 2\n\n');
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledWith(undefined));
  });
});

describe('recorder wiring — the timeline fills and the row closes at STREAM end', () => {
  /** The stream the stubbed fetch serves next; each case installs its own. */
  let next = controllable();
  let rec: typeof import('../networkRecorder.js');

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(next.body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    rec = await import('../networkRecorder.js');
    rec.installNetworkRecorder();
  });

  const entryAt = (path: string) => rec.listNetworkEntries().find((e) => e.path === path)!;

  it('records events onto the entry and only then stamps finishedAt', async () => {
    const s = (next = controllable());
    const res = await window.fetch('/api/runs/r1/events', { headers: { accept: 'text/event-stream' } });
    const entry = () => entryAt('/api/runs/r1/events');
    expect(entry().kind).toBe('sse');
    expect(entry().status).toBe(200);
    expect(entry().finishedAt).toBeUndefined(); // headers arrived; the stream is still open
    const reading = res.text();
    s.push('data: {"type":"run.started"}\n\n');
    await vi.waitFor(() => expect(entry().sseEvents?.map((e) => e.data)).toEqual(['{"type":"run.started"}']));
    expect(entry().finishedAt).toBeUndefined();
    s.close();
    await reading;
    await vi.waitFor(() => expect(entry().finishedAt).toBeTypeOf('number'));
  });

  it('at the event cap the row is TRUNCATED but stays open until the stream really ends', async () => {
    const s = (next = controllable());
    const res = await window.fetch('/api/runs/r2/events');
    const reading = res.text();
    const entry = () => entryAt('/api/runs/r2/events');
    for (let i = 0; i < 105; i++) s.push(`data: ${i}\n\n`);
    await vi.waitFor(() => expect(entry().sseEventsTruncated).toBe(true));
    expect(entry().sseEvents).toHaveLength(100);
    expect(entry().finishedAt).toBeUndefined(); // capture stopped; the stream did not
    s.close();
    await reading;
    await vi.waitFor(() => expect(entry().finishedAt).toBeTypeOf('number')); // grade-ux F3
  });

  it('the saved copy keeps the FIRST 20 events and says how many it dropped', async () => {
    const s = (next = controllable());
    const res = await window.fetch('/api/runs/r3/events');
    const reading = res.text();
    for (let i = 0; i < 105; i++) s.push(`data: ${i}\n\n`);
    s.close();
    await reading;
    await vi.waitFor(() => {
      const saved = JSON.parse(window.sessionStorage.getItem('openwop.networkRecorder.v1') ?? '[]') as Array<{ path: string; finishedAt?: number; sseEvents?: Array<{ data: string }>; sseEventsDropped?: number }>;
      const row = saved.find((e) => e.path === '/api/runs/r3/events');
      expect(row?.finishedAt).toBeTypeOf('number');
      expect(row?.sseEvents?.map((e) => e.data).slice(0, 2)).toEqual(['0', '1']);
      expect(row?.sseEvents).toHaveLength(20);
      expect(row?.sseEventsDropped).toBe(80);
    });
  });
});
