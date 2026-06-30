/**
 * SSE event stream — `GET /v1/runs/{runId}/events`.
 *
 * Implements the four canonical stream modes per spec/v1/stream-modes.md:
 *   - values   — final node outputs only
 *   - updates  — every state transition (default)
 *   - messages — only `*.message` and chat-shaped events
 *   - debug    — full event log, no filtering
 *
 * Last-Event-ID resume: client reconnects with the header set; we
 * replay events with sequence > parsed value, then attach to the live
 * stream.
 *
 * Mode is selected via `?mode=<modes,comma,separated>` (default updates).
 */

import type { Express, Response } from 'express';
import type { StreamMode } from '@openwop/openwop';
import type { Storage } from '../storage/storage.js';
import { OpenwopError, type EventRecord } from '../types.js';
import { getEventLog } from '../executor/eventLog.js';
import { loadReadableRun } from '../host/runAccess.js';
import { mintRunStreamToken } from '../host/runStreamToken.js';
import { openSseChannel } from '../host/sseChannel.js';
import { projectA2uiDelivery, a2uiDeltaTransportEnabled, type A2uiDeltaState, type A2uiSurfacePayload } from '../host/a2uiSurfaceDelta.js';

const VALID_MODES: readonly StreamMode[] = ['values', 'updates', 'messages', 'debug'];

interface Deps {
  storage: Storage;
}

export function registerStreamRoutes(app: Express, deps: Deps): void {
  const { storage } = deps;

  // Mint a run-scoped stream capability for the cross-origin SSE. SAME-ORIGIN
  // (via /api) so an owner — including a BYOK-anon owner whose cookie can't
  // follow to *.run.app — passes the normal tenant gate here, then presents the
  // returned token on the cross-origin `…/events?streamToken=…` request. A
  // non-owner 404s on loadReadableRun and never gets a token (see
  // host/runStreamToken). Registered before the `/events` route; the extra path
  // segment keeps them distinct regardless of order.
  app.get('/v1/runs/:runId/events/token', async (req, res, next) => {
    try {
      await loadReadableRun(req, storage, req.params.runId);
      res.json({ streamToken: mintRunStreamToken(req.params.runId) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/runs/:runId/events', async (req, res, next) => {
    try {
      // Authorize the READ before anything streams: scope seam (RFC 0049) +
      // tenant ownership, the same gate the JSON poll / GET / debug-bundle use.
      // Without it the live event stream was the one run-read path with zero
      // authorization (architecture review #1).
      const run = await loadReadableRun(req, storage, req.params.runId);

      // Stream-mode validation runs BEFORE content negotiation so that
      // bad streamMode values 400 regardless of Accept header. Otherwise
      // a client requesting JSON with an invalid streamMode would get
      // 200 JSON (the negotiation branch ignores the bad param), which
      // breaks the strict `stream-modes.md §Mode selection` contract.
      const modes = parseModes(
        (req.query.streamMode ?? req.query.mode) as string | undefined,
      );

      // Content negotiation per `rest-endpoints.md §"GET /v1/runs/{runId}
      // /events"`: when the client asks for JSON (Accept: application/
      // json), return the event log as a single JSON envelope
      // `{events: RunEventDoc[]}`. Default behavior (or
      // Accept: text/event-stream) returns SSE. The JSON path is the
      // "I just want the current state" sibling of the SSE path's
      // "give me live updates."
      const acceptHeader = req.header('accept') ?? '';
      if (acceptHeader.includes('application/json') && !acceptHeader.includes('text/event-stream')) {
        const allEvents = await storage.listEvents(run.runId, { fromSeq: 0, limit: 100_000 });
        const isComplete = ['completed', 'failed', 'cancelled'].includes(run.status);
        res.status(200).json({ events: allEvents, isComplete });
        return;
      }

      // Aggregation-hint per `stream-modes.md §Aggregation hint`. Valid
      // range is 1..5000 ms. Out-of-range surfaces as 400; absent →
      // no aggregation (live events as they arrive). When set, events
      // accumulate in an internal buffer and flush in a single
      // `event: batch\ndata: [<events>]` SSE frame at the cadence.
      const bufferMsRaw = req.query.bufferMs;
      let bufferMs = 0;
      if (bufferMsRaw !== undefined) {
        const parsed = Number(bufferMsRaw);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5000) {
          throw new OpenwopError(
            'validation_error',
            `bufferMs MUST be a number in [1, 5000]; got ${JSON.stringify(bufferMsRaw)}.`,
            400,
            { min: 1, max: 5000 },
          );
        }
        bufferMs = parsed;
      }

      // Last-Event-ID resume: SSE clients send the header with the last
      // sequence they saw. Replay anything > that, then attach live.
      // Validate strictly — silently coercing malformed values to 0 would
      // mask broken clients that resume from the start every reconnect.
      const lastEventIdHeader = req.header('last-event-id');
      let fromSeq = 0;
      if (lastEventIdHeader != null) {
        if (!/^\d+$/.test(lastEventIdHeader)) {
          throw new OpenwopError(
            'invalid_request',
            `Last-Event-ID header MUST be a non-negative integer; got "${lastEventIdHeader}"`,
            400,
            { header: 'Last-Event-ID', value: lastEventIdHeader },
          );
        }
        fromSeq = Number(lastEventIdHeader);
      }

      // Shared SSE lifecycle (host/sseChannel): canonical headers (incl.
      // X-Accel-Buffering), 15s heartbeat, per-tenant connection cap, teardown.
      const channel = openSseChannel(req, res, { heartbeatMs: 15_000 });

      // Aggregation buffer for `?bufferMs=N`. When set, events
      // accumulate here between flushes; on each tick (or on terminal)
      // the buffer flushes as a single `event: batch\ndata: [<evs>]`
      // SSE frame.
      const pendingBatch: EventRecord[] = [];
      const flushBatch = (): void => {
        if (pendingBatch.length === 0) return;
        const payload = JSON.stringify(pendingBatch);
        res.write(`event: batch\ndata: ${payload}\n\n`);
        pendingBatch.length = 0;
      };

      // RFC 0114 — opt-in a2ui delta transport. Gated on the SAME predicate as
      // the capability advert (`a2uiDeltaTransportEnabled()`), so serving and
      // advertising can never drift (honest-advert rule). Per-connection state
      // carries the last full surface delivered to THIS subscriber (delta is a
      // per-subscriber choice). Not applied in the aggregation (`bufferMs>0`)
      // path — batches carry full events; delta is a live-stream optimization.
      const a2uiDelta =
        req.query.a2uiDelta === '1' && a2uiDeltaTransportEnabled() && bufferMs === 0;
      const a2uiState: A2uiDeltaState = {};

      // Replay buffered events.
      const buffered = await storage.listEvents(run.runId, { fromSeq, limit: 10_000 });
      for (const ev of buffered) {
        if (passesModeFilter(ev, modes)) {
          if (bufferMs > 0) pendingBatch.push(ev);
          else deliverEvent(res, ev, a2uiDelta, a2uiState);
        }
      }

      // Aggregation tick — only when bufferMs > 0. Flushes the batch
      // even if no events arrived this interval (the consumer counts
      // batch frames, so empty intervals would skew the count). Skip
      // if buffer empty to avoid wire chatter.
      const aggTick = bufferMs > 0
        ? setInterval(() => { flushBatch(); }, bufferMs)
        : null;

      // Subscribe to live events for the same run.
      const unsubscribe = getEventLog().subscribe((ev) => {
        if (ev.runId !== run.runId) return;
        if (passesModeFilter(ev, modes)) {
          if (bufferMs > 0) {
            pendingBatch.push(ev);
            // Terminal events force-flush the batch so consumers don't
            // wait for the next tick to see run.completed.
            if (TERMINAL_EVENT_TYPES.has(ev.type)) {
              flushBatch();
            }
          } else {
            deliverEvent(res, ev, a2uiDelta, a2uiState);
          }
        }
        // Close the stream once we've observed a terminal event — the channel
        // clears the heartbeat + releases the cap slot and runs the teardown
        // below (aggregation tick + subscription).
        if (TERMINAL_EVENT_TYPES.has(ev.type)) channel.close();
      });

      // Route-specific teardown — run once by the channel on client disconnect
      // or channel.close().
      const routeTeardown = (): void => {
        if (aggTick) clearInterval(aggTick);
        unsubscribe();
      };
      channel.onClose(routeTeardown);
      // The replay `await` above is a window in which the client could have
      // disconnected before onClose was registered; if so, tear down now (the
      // aggTick/subscription created since would otherwise leak).
      if (channel.closed) { routeTeardown(); return; }

      // If the run is already terminal, flush + close.
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        if (bufferMs > 0) flushBatch();
        channel.close();
      }
    } catch (err) {
      next(err);
    }
  });
}

const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled']);

function parseModes(raw: string | undefined): readonly StreamMode[] {
  if (!raw) return ['updates'];
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  // Strict validation per `stream-modes.md §Mode selection`: an
  // unsupported mode in the comma-separated list MUST surface as a
  // 400 with `unsupported_stream_mode` (not silently dropped to
  // `updates`). The conformance suite asserts this directly via
  // `streamMode=does-not-exist` and the `streamMode=values,updates`
  // ordering check.
  const invalid = parts.filter((m) => !(VALID_MODES as readonly string[]).includes(m));
  if (invalid.length > 0) {
    throw new OpenwopError(
      'unsupported_stream_mode',
      `streamMode value(s) not supported: ${invalid.join(', ')}`,
      400,
      { supported: [...VALID_MODES], unsupported: invalid },
    );
  }
  // `values` is exclusive per `stream-modes.md §Mixed mode` — it
  // represents a strict subset of `updates` and combining it with
  // another mode is meaningless (the engine would emit the more
  // permissive set, so the `values` constraint adds nothing). Refuse
  // the combination so clients catch the mistake early.
  if (parts.length > 1 && parts.includes('values')) {
    throw new OpenwopError(
      'unsupported_stream_mode',
      "streamMode=values is exclusive and MUST NOT be combined with other modes",
      400,
      { supported: [...VALID_MODES], conflict: parts },
    );
  }
  return parts as StreamMode[];
}

function passesModeFilter(ev: EventRecord, modes: readonly StreamMode[]): boolean {
  if (modes.includes('debug')) return true;
  if (modes.includes('values') && (ev.type === 'node.completed' || ev.type === 'run.completed')) {
    return true;
  }
  if (modes.includes('messages') && (ev.type.endsWith('.message') || ev.type.includes('.message.'))) {
    return true;
  }
  if (modes.includes('updates')) {
    // `updates` = every state transition. In this sample, that's every
    // event except node-internal partials (none in the minimal node set).
    return true;
  }
  return false;
}

function writeSseEvent(res: Response, ev: EventRecord): void {
  res.write(`id: ${ev.sequence}\n`);
  res.write(`event: ${ev.type}\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/** True when the event carries a recorded `ui.a2ui-surface` payload. */
function isA2uiSurfaceEvent(ev: EventRecord): ev is EventRecord & { payload: A2uiSurfacePayload } {
  const p = ev.payload as Partial<A2uiSurfacePayload> | undefined;
  return ev.type === 'ui.a2ui-surface' && !!p && typeof p.catalogVersion === 'string' && 'surface' in p;
}

/**
 * RFC 0114 — deliver an event to ONE subscriber, applying the host-side a2ui
 * delta transport when the subscriber opted in (`?a2uiDelta=1`). The RECORDED
 * event is untouched; this only changes the bytes on THIS connection: a
 * subsequent surface for the chain is sent as a `ui.a2ui-surface.delta` frame
 * (transport-only, never recorded). Everyone else / the first surface / a
 * catalog bump get the full event. Non-a2ui events pass straight through.
 */
function deliverEvent(res: Response, ev: EventRecord, deltaEnabled: boolean, state: A2uiDeltaState): void {
  if (deltaEnabled && isA2uiSurfaceEvent(ev)) {
    const decision = projectA2uiDelivery(state, ev.eventId, ev.payload, true);
    if (decision.kind === 'delta') {
      // Transport-only frame; distinct SSE event type so the consumer knows to
      // apply a patch (then re-validate against the closed catalog, fail-closed).
      res.write(`id: ${ev.sequence}\n`);
      res.write(`event: ui.a2ui-surface.delta\n`);
      res.write(`data: ${JSON.stringify(decision.frame)}\n\n`);
      return;
    }
  }
  writeSseEvent(res, ev);
}
