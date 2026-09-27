/**
 * Channels runtime — per-run typed-state channels for the workflow-engine
 * sample, per `spec/v1/channels-and-reducers.md`.
 *
 * Holds the per-run channel projections that `GET /v1/runs/{runId}`
 * surfaces as `RunSnapshot.channels` (run-snapshot.schema.json
 * §channels: "Present when the workflow declares channel-aware
 * mode."). Today the sample materializes channels through the
 * canonical `message` reducer (Multi-Agent Shift Phase 1):
 *
 *   - Append-only — new messages land at the end of the list.
 *   - Idempotent on `messageId` — a duplicate emission folds to a
 *     single entry (`channels-and-reducers.md` §`message`).
 *   - Replay-deterministic — the same emission sequence produces the
 *     same final channel value.
 *
 * NOTE: `core.channelWrite` (the §append + §TTL reducer family) keeps
 * its existing variable-bag storage (`variablesRuntime.ts`) — the
 * conformance channel-ttl contract reads that surface via
 * `RunSnapshot.variables`. This module is the `message`-reducer
 * sibling that projects to `RunSnapshot.channels`.
 *
 * DURABILITY (CS-WF-1, mirroring variablesRuntime's ENG-3): the in-process Map
 * is a write-through CACHE in front of the kv Storage. `appendChannelMessage`
 * persists the run's channels (fire-and-forget), and `hydrateRunChannels`
 * reloads them — the executor hydrates before executing a run, and the run
 * snapshot route hydrates before reading, so a run re-dispatched by the
 * sweeper on ANOTHER instance (or snapshotted from a non-executing instance)
 * recovers its channel state instead of reporting none. Without wired storage
 * (a unit test without host-ext init) it degrades to in-memory-only, exactly
 * as before. Bound: whole-state persist is skipped past MAX_PERSIST_BYTES
 * (warned once per run) — a very long conversation's truth is the durable
 * EVENT LOG; this projection is a snapshot convenience, not the record.
 */

import { tryDurableStorage } from './durable/durableStore.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.channelsRuntime');

/** A `message`-reducer channel entry per `channels-and-reducers.md`
 *  §`message` (`ConversationMessage`). `messageId` is the idempotency
 *  key; everything else is the conversational payload. */
export interface ConversationMessage {
  messageId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; [k: string]: unknown }>;
  agentId?: string;
  timestamp: string;
  toolName?: string;
  toolCallId?: string;
}

const runChannels = new Map<string, Map<string, ConversationMessage[]>>();

const KEY_PREFIX = 'runchans:';
const key = (runId: string): string => `${KEY_PREFIX}${runId}`;

/** Whole-state persist ceiling — past this the write-through is skipped (the
 *  event log remains the durable record; re-persisting an ever-growing array
 *  per append would be O(n²) bytes over a long conversation). */
const MAX_PERSIST_BYTES = 256 * 1024;
const persistCapWarned = new Set<string>();

/** Write-through the run's whole channel state to durable storage
 *  (fire-and-forget, size-capped). No-op when storage isn't wired. */
function persistChannels(runId: string): void {
  const storage = tryDurableStorage();
  if (!storage) return;
  const channels = runChannels.get(runId);
  const obj = channels ? Object.fromEntries(channels.entries()) : {};
  const raw = JSON.stringify(obj);
  if (raw.length > MAX_PERSIST_BYTES) {
    if (!persistCapWarned.has(runId)) {
      persistCapWarned.add(runId);
      log.warn('run_channels_persist_capped', { runId, bytes: raw.length, cap: MAX_PERSIST_BYTES });
    }
    return;
  }
  void storage.kvSet(key(runId), raw).catch((err) => {
    log.warn('run_channels_persist_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * Load a run's channel state from durable storage into the in-memory cache —
 * the executor calls this before executing a (possibly re-dispatched) run, and
 * the snapshot route before reading, so channels survive a cross-instance
 * hand-off (CS-WF-1). A run already in the cache is left as-is (the live
 * state wins). No-op without storage.
 */
export async function hydrateRunChannels(runId: string): Promise<void> {
  if (runChannels.has(runId)) return;
  const storage = tryDurableStorage();
  if (!storage) return;
  try {
    const raw = await storage.kvGet(key(runId));
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, ConversationMessage[]>;
    runChannels.set(runId, new Map(Object.entries(obj)));
  } catch (err) {
    log.warn('run_channels_hydrate_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Apply the canonical `message` reducer: append `message` to the named
 * channel unless an entry with the same `messageId` already exists
 * (duplicate emissions fold to a single entry — the idempotency
 * invariant the agentMessageReducer conformance scenario pins).
 */
export function appendChannelMessage(
  runId: string,
  channelName: string,
  message: ConversationMessage,
): void {
  let channels = runChannels.get(runId);
  if (!channels) {
    channels = new Map<string, ConversationMessage[]>();
    runChannels.set(runId, channels);
  }
  const current = channels.get(channelName) ?? [];
  if (current.some((m) => m.messageId === message.messageId)) return;
  channels.set(channelName, [...current, message]);
  persistChannels(runId);
}

/**
 * Snapshot every channel for `runId` as a plain object (the
 * `RunSnapshot.channels` projection). Returns `null` when the run has
 * no channel state — `JSON.stringify` collapse keeps the snapshot
 * field absent, matching the schema's "present when channel-aware"
 * semantics. Cross-instance readers should `hydrateRunChannels(runId)`
 * first (the run snapshot route does).
 */
export function snapshotRunChannels(runId: string): Record<string, unknown> | null {
  const channels = runChannels.get(runId);
  if (!channels) return null;
  return Object.fromEntries(channels.entries());
}

/** Drop channel state for `runId` (memory + durable). Safe on absent runIds. */
export function clearRunChannels(runId: string): void {
  runChannels.delete(runId);
  persistCapWarned.delete(runId);
  const storage = tryDurableStorage();
  if (storage) {
    void storage.kvDelete(key(runId)).catch((err) => {
      log.warn('run_channels_delete_failed', { runId, error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/** Test-only: drop EVERY run's channel state (in-memory cache only). */
export function __resetAllRunChannelsForTests(): void {
  runChannels.clear();
  persistCapWarned.clear();
}
