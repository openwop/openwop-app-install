/**
 * ADR 0997 D6 — delete the rows the retired derived index left behind.
 *
 * ADR 0112 Phase 1 copied message text into the tenant `db.search` surface, index
 * `chat-search`. On a durable surface backend those copies are `host_ext_kv` rows
 * `hostsurf:search:<tenant>:chat-search:<conv>%00<msg>` (`host/durable/durableData.ts`),
 * readable by any workflow run in the tenant through `core.db.search-query` and never
 * cleaned up by a delete or a DSAR erasure. Nothing writes them any more; this removes
 * what an older build wrote. Prod held 0 on 2026-10-28; an adopter may hold some.
 *
 * Runs once per process, on the first search, after boot has wired the durable
 * store. Idempotent across instances. Best-effort: a failure is logged and retried
 * on the next search, never thrown into the request.
 */
import { scanPrefix, tryDurableStorage } from '../../host/durable/durableStore.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('conversation-search');

const PREFIX = 'hostsurf:search:';
/** The retired engine's index name (`encodeURIComponent` leaves it unchanged). */
const LEGACY_INDEX = 'chat-search';

let done: Promise<void> | null = null;

/** True for `hostsurf:search:<tenant>:chat-search:<id>`. The tenant segment is
 *  URI-encoded, so it holds no `:`, and only this exact index segment matches. */
export function isLegacyChatSearchKey(key: string): boolean {
  if (!key.startsWith(PREFIX)) return false;
  return key.slice(PREFIX.length).split(':')[1] === LEGACY_INDEX;
}

async function purge(storage: NonNullable<ReturnType<typeof tryDurableStorage>>): Promise<void> {
  const stale: string[] = [];
  for await (const row of scanPrefix(PREFIX, { op: 'conversation-search.legacy-purge' })) {
    if (isLegacyChatSearchKey(row.key)) stale.push(row.key);
  }
  let deleted = 0;
  for (const key of stale) if (await storage.kvDelete(key)) deleted++;
  if (stale.length > 0) log.info('conversation_search_legacy_index_purged', { deleted });
}

export function purgeLegacySearchIndexOnce(): Promise<void> {
  const storage = tryDurableStorage();
  if (!storage) return Promise.resolve(); // durable store not wired: nothing to purge yet
  done ??= purge(storage).catch((err: unknown) => {
    done = null;
    log.warn('conversation_search_legacy_purge_failed', { error: String(err) });
  });
  return done;
}

/** Test hook: forget that this process already purged. */
export function __resetLegacyPurge(): void {
  done = null;
}
