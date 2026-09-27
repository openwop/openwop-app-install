/**
 * SSE capture for the network inspector (CLNP-2(c)).
 *
 * The inspector's SSE row has always had an event timeline (`sseEvents`, localized in
 * four locales) that could never populate: the only writer, `appendSseEvent`, had no
 * caller, AND the recorder stamped `finishedAt` when the response HEADERS arrived — so
 * even a caller's appends would have hit the "closed; stop scanning" branch and been
 * dropped. This module is the missing tap.
 *
 * Loaded with a dynamic `import()` from the recorder's CAPTURE path only, so the
 * production entry chunk (liveness-only tap, CLNP-8's thin headroom) pays nothing.
 *
 * Mechanism: the body is piped through a PASS-THROUGH `TransformStream` — every chunk
 * is forwarded to the caller untouched and parsed on the way past. This replaced a
 * first cut built on `tee()`, which had three problems a pass-through does not have:
 *   - an unread tee branch buffers every chunk the other branch reads, so it needed an
 *     explicit cancel at the cap — and a branch's cancel() settles only once BOTH
 *     branches cancel, so awaiting it hung the tap;
 *   - once the tap stopped reading at the cap it could no longer see the stream END,
 *     so the row read "still running" forever (grade-ux F3);
 *   - it read ahead of a slow caller; a pass-through reads exactly as fast as the
 *     caller does.
 * Past the cap the transform stops PARSING but keeps forwarding, and `flush` still
 * reports the real end. The returned Response keeps `url` (a constructed Response has
 * `url === ''`, and `ApiError` messages read it).
 */

export interface SseSink {
  /** One parsed event's `data`. Return `false` to stop capturing (parsing stops; the
   *  bytes keep flowing to the caller, and `onEnd` still fires at the real end). */
  onEvent(data: string): boolean;
  /** The stream ended — cleanly, or because the caller cancelled it (`error`). Once. */
  onEnd(error?: string): void;
}

/** A frame larger than this with no terminator is discarded, never buffered further. */
const MAX_PENDING_CHARS = 256 * 1024;

/** Extract the `data` of one SSE frame (RFC: `data:` lines joined by `\n`, one
 *  leading space stripped). Comment/heartbeat frames (`: ping`) carry none. */
export function frameData(frame: string): string | null {
  const lines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === 'data') lines.push('');
    else if (line.startsWith('data:')) lines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Incremental SSE frame parser; stops parsing for good once the sink says stop. */
function frameParser(sink: SseSink): { chunk(bytes: Uint8Array): void; end(): void } {
  const decoder = new TextDecoder();
  let pending = '';
  let capturing = true;
  const emit = (final: boolean): void => {
    // A lone `\r` at the END may be the first half of a `\r\n` split across chunks —
    // normalising it now would read `\r` + `\n` as a blank line, i.e. a false frame end.
    pending = pending.replace(final ? /\r\n?/g : /\r\n|\r(?!$)/g, '\n');
    let cut: number;
    while (capturing && (cut = pending.indexOf('\n\n')) >= 0) {
      const data = frameData(pending.slice(0, cut));
      pending = pending.slice(cut + 2);
      if (data !== null && !sink.onEvent(data)) capturing = false;
    }
    if (capturing && final && pending.trim()) {
      const data = frameData(pending);
      if (data !== null) sink.onEvent(data);
    }
    if (!capturing || final || pending.length > MAX_PENDING_CHARS) pending = '';
  };
  return {
    chunk(bytes) {
      if (!capturing) return;
      pending += decoder.decode(bytes, { stream: true });
      emit(false);
    },
    end() {
      if (!capturing) return;
      pending += decoder.decode();
      emit(true);
    },
  };
}

export function tapSseResponse(res: Response, sink: SseSink): Response {
  if (!res.body) {
    sink.onEnd();
    return res;
  }
  const parser = frameParser(sink);
  let ended = false;
  const end = (error?: string): void => {
    if (ended) return;
    ended = true;
    sink.onEnd(error);
  };
  // `cancel` is in the Streams spec and current engines, but not yet in this
  // TypeScript's DOM lib — declared here, not cast.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel?: (reason: unknown) => void } = {
    transform(chunk, ctl) {
      ctl.enqueue(chunk); // the caller's bytes first, always
      try { parser.chunk(chunk); } catch { /* a parse fault must never break the caller's stream */ }
    },
    flush() {
      try { parser.end(); } catch { /* as above */ }
      end();
    },
    // The caller cancelled (e.g. an aborted run view). Engines without Transformer
    // `cancel` leave the row open — no worse than before this tap existed.
    cancel(reason: unknown) {
      end(reason instanceof Error ? reason.message : 'cancelled');
    },
  };
  const tap = new TransformStream<Uint8Array, Uint8Array>(transformer);
  const out = new Response(res.body.pipeThrough(tap), { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, 'url', { value: res.url });
  return out;
}
