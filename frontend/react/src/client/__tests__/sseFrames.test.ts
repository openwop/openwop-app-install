/**
 * The shared SSE frame reader behind the run-event stream and the notification
 * feed (#108, credentialed fetch-stream SSE; WHATWG / RFC 8895 line grammar).
 * Breaks it: frames lost across chunk boundaries, CRLF streams that never
 * dispatch, multi-line data joined wrongly, a named event leaking onto the next
 * frame, or a partial line at EOF dispatched as if complete.
 */
import { describe, it, expect } from 'vitest';
import { readSseFrames, type SseFrame } from '../sseFrames.js';

/** Build a ReadableStream that emits each string as one UTF-8 chunk. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of readSseFrames(streamOf(chunks))) out.push(f);
  return out;
}

describe('readSseFrames', () => {
  it('parses a single event+data frame', async () => {
    const frames = await collect(['event: notification\ndata: {"a":1}\n\n']);
    expect(frames).toEqual([{ event: 'notification', data: '{"a":1}' }]);
  });

  it('joins multiple data lines with a newline', async () => {
    const frames = await collect(['data: line1\ndata: line2\n\n']);
    expect(frames).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('defaults event to "message" when no event field is sent', async () => {
    // Twin: 'joins multiple data lines with a newline' asserts the same default
    // on its own fixture; this is the single-line, single-frame form.
    const frames = await collect(['data: hi\n\n']);
    expect(frames).toEqual([{ event: 'message', data: 'hi' }]);
  });

  it('a named event does not leak onto the next frame — the default is restored after every dispatch', async () => {
    const frames = await collect(['event: notification\ndata: 1\n\ndata: 2\n\n']);
    expect(frames).toEqual([{ event: 'notification', data: '1' }, { event: 'message', data: '2' }]);
  });

  // Honest ceiling (double guard): a `:` line has an EMPTY field name, which the
  // field dispatch ignores anyway, so deleting the explicit comment skip is
  // behaviour-neutral (probe w48g3-sse-comment: vacuous by design). What this
  // case can catch is a comment that dispatches or corrupts the next frame.
  it('skips `:` keep-alive comment lines (heartbeats)', async () => {
    const frames = await collect([': heartbeat\n\n', 'event: notification\ndata: {}\n\n']);
    expect(frames).toEqual([{ event: 'notification', data: '{}' }]);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const frames = await collect(['event: notif', 'ication\nda', 'ta: {"x":', '2}\n\n']);
    expect(frames).toEqual([{ event: 'notification', data: '{"x":2}' }]);
  });

  it('handles CRLF line endings', async () => {
    const frames = await collect(['event: notification\r\ndata: {"y":3}\r\n\r\n']);
    expect(frames).toEqual([{ event: 'notification', data: '{"y":3}' }]);
  });

  it('dispatches a trailing frame whose final line lacks a blank-line terminator', async () => {
    // The data line IS newline-terminated; the frame just isn't followed by
    // the usual blank line before EOF — the end-flush still dispatches it.
    const frames = await collect(['data: tail\n']);
    expect(frames).toEqual([{ event: 'message', data: 'tail' }]);
  });

  it('discards an incomplete final line with no newline at all', async () => {
    // Per the SSE spec, a partial line at EOF is an incomplete event → dropped.
    const frames = await collect(['data: par']);
    expect(frames).toEqual([]);
  });

  it('strips exactly one leading space after the field colon', async () => {
    // "data:  x" (two spaces) → value keeps one leading space.
    const frames = await collect(['data:  x\n\n']);
    expect(frames[0]!.data).toBe(' x');
  });
});
