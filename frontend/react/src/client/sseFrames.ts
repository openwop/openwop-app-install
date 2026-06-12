/**
 * Generic Server-Sent-Events frame reader — the shared line-parsing core
 * behind BOTH the run-event stream (`streamsClient.ts`) and the
 * notification feed (`notifications/notificationsClient.ts`).
 *
 * Yields one `{ event, data }` per dispatched SSE frame. `data` is every
 * `data:` line in the frame joined with '\n' (per the WHATWG/RFC 8895 wire
 * grammar); `event` is the last `event:` field, or `'message'` when none
 * was sent. Comment lines (a `:` prefix — our 15s `: heartbeat` keep-alives)
 * are skipped. Callers do their own `JSON.parse` + shape validation on
 * `data`, so this stays payload-agnostic.
 *
 * Extracting this means CRLF handling, cross-chunk buffering, the leading-
 * space strip, and keep-alive skipping live in exactly one place rather
 * than being copy-pasted per transport (the divergence risk an SSE parser
 * per consumer would invite).
 */

export interface SseFrame {
  /** The `event:` field value, or `'message'` when the frame sent none. */
  event: string;
  /** All `data:` lines in the frame, joined with '\n'. */
  data: string;
}

/**
 * Parse an SSE response body into a stream of frames. Stops when the body
 * ends or `signal` aborts. Releases the reader lock on the way out.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let pendingEvent = 'message';
  let pendingData: string[] = [];

  const flush = (): SseFrame | null => {
    if (pendingData.length === 0) {
      pendingEvent = 'message';
      return null;
    }
    const frame: SseFrame = { event: pendingEvent, data: pendingData.join('\n') };
    pendingEvent = 'message';
    pendingData = [];
    return frame;
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, nlIdx).replace(/\r$/, '');
        buffer = buffer.slice(nlIdx + 1);
        if (rawLine === '') {
          const frame = flush();
          if (frame) yield frame;
          continue;
        }
        if (rawLine.startsWith(':')) continue; // keep-alive comment
        const colon = rawLine.indexOf(':');
        const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
        const valueRaw = colon === -1 ? '' : rawLine.slice(colon + 1);
        const fieldValue = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw;
        if (field === 'event') pendingEvent = fieldValue;
        else if (field === 'data') pendingData.push(fieldValue);
      }
    }
    // Dispatch a trailing frame that wasn't terminated by a blank line.
    const frame = flush();
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}
