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
    const frames = await collect(['data: hi\n\n']);
    expect(frames[0]!.event).toBe('message');
  });

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
