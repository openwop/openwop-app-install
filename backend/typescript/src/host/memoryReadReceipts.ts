/**
 * ADR 0944 D6 — read receipts: what a client run's agent actually recalled.
 *
 * Model calls replay from the invocation log, but memory and knowledge are read
 * live, so before this a `replay` fork re-read memory that had changed since
 * (finding M3), and nothing recorded what an approved decision rested on. Each
 * dispatch in a CLIENT run (memory scope `org:<orgId>`) now writes one receipt:
 * the ids of the memory rows and KB chunks it recalled and a hash of their text.
 * No wire field is added; the receipt is host storage.
 *
 * On a `replay` fork the dispatch is served FROM the source run's receipt, by
 * id:
 *  - a memory row is re-read by its id; a row that was erased, evicted, or
 *    changed since is served ABSENT and the model is told its memory is partially unavailable.
 *    Erasure wins over replay fidelity: a receipt holds ids, never content, so it
 *    cannot resurrect anything;
 *  - KB chunks are retrieved live and kept only if the receipt names them AND
 *    their text, trust and title still match the recorded commitment;
 *  - missing item commitments fail closed; drift is logged `memory_receipt_drift`.
 * A `branch` fork reads live memory on purpose (it is a new decision).
 *
 * Receipts carry `orgId` (so `deleteOrg` sees them), are keyed
 * `tenant::runId::nodeId::ordinal`, and age out after the run-history window.
 *
 * @see docs/adr/0944-client-scoped-agent-memory.md §D6
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { getMemoryEntry } from './inMemorySurfaces.js';
import { hasLegacyAutoExtractedPrefix } from './memoryTrust.js';
import { MEMORY_UNTRUSTED_TAG, type AgentKnowledgeRetrieve, type AgentMemoryPort } from './agentDispatch.js';
import { registerKvAgeOut } from './kvAgeOut.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.memoryReadReceipts');

/** Receipts live as long as the run history they explain. */
export const RECEIPT_TTL_DAYS = 90;

export interface MemoryReadReceipt {
  key: string;
  tenantId: string;
  runId: string;
  nodeId: string;
  ordinal: number;
  orgId: string;
  scope: string;
  entryIds: string[];
  kbChunkIds: string[];
  /** Per-item commitments exclude changed text or changed trust from replay. */
  entryHashes?: Record<string, string>;
  kbChunkHashes?: Record<string, string>;
  /** sha256 over the recalled (id, text) pairs, order-free. */
  contentHash: string;
  at: string;
}

const COLLECTION = 'agent-memory:read-receipt';
const receipts = new DurableCollection<MemoryReadReceipt>(COLLECTION, (r) => r.key, undefined, (r) => r.tenantId);
// Client off-boarding uses the tenant index; the existing age-out seam deletes
// through this collection, including its markers (covered by the sweep test).
registerKvAgeOut({ id: COLLECTION, prefix: `hostext:${COLLECTION}:`, ttlDays: RECEIPT_TTL_DAYS, timestampField: 'at', acceptIndexed: true });

const keyOf = (tenantId: string, runId: string, nodeId: string, ordinal: number): string => `${tenantId}::${runId}::${nodeId}::${ordinal}`;

// The background sweep bounds storage; read authorization cannot wait for it.
const withinReceiptWindow = (r: MemoryReadReceipt, now: number): boolean => {
  const at = Date.parse(r.at);
  return Number.isFinite(at) && at <= now && now - at < RECEIPT_TTL_DAYS * 86_400_000;
};

export async function getReadReceipt(tenantId: string, runId: string, nodeId: string, ordinal = 1): Promise<MemoryReadReceipt | null> {
  const r = await receipts.get(keyOf(tenantId, runId, nodeId, ordinal));
  return r && r.tenantId === tenantId && r.runId === runId && r.nodeId === nodeId && r.ordinal === ordinal && withinReceiptWindow(r, Date.now()) ? r : null;
}

export async function listRunReadReceipts(tenantId: string, runId: string): Promise<MemoryReadReceipt[]> {
  const now = Date.now();
  return (await receipts.listByPrefix(`${tenantId}::${runId}::`)).filter((r) => r.tenantId === tenantId && r.runId === runId && withinReceiptWindow(r, now));
}

/** Every receipt naming this client (ADR 0944 D8 off-boarding). */
export async function deleteClientReadReceipts(tenantId: string, orgId: string): Promise<number> {
  let n = 0;
  for (const r of await receipts.listForTenantIndexed(tenantId)) {
    if (r.tenantId !== tenantId || r.orgId !== orgId) continue;
    if (await receipts.delete(r.key)) n += 1;
  }
  return n;
}

/** Order-free: the same rows recalled by a different path hash the same. */
const hashOf = (memory: ReadonlyMap<string, string>, kb: ReadonlyMap<string, string>): string =>
  createHash('sha256').update([
    ...[...memory].map(([id, c]) => `m\u0000${id}\u0000${c}`),
    ...[...kb].map(([id, c]) => `k\u0000${id}\u0000${c}`),
  ].sort().join('\u0001')).digest('hex');

interface Recalled { memory: Map<string, string>; kb: Map<string, string> }
const itemHash = (content: string, trust: 'trusted' | 'untrusted' = 'trusted', title?: string): string =>
  createHash('sha256').update(JSON.stringify([content, trust, title ?? null])).digest('hex');

/** Wrap a dispatch's memory port + knowledge retriever so what they return is
 *  recorded, then write ONE receipt per dispatch (first write wins). */
export function recordingRecall(input: { memory: AgentMemoryPort; knowledgeRetrieve?: AgentKnowledgeRetrieve | undefined }): {
  memory: AgentMemoryPort;
  knowledgeRetrieve?: AgentKnowledgeRetrieve;
  write: (at: { tenantId: string; runId: string; nodeId: string; ordinal: number; orgId: string; scope: string }) => Promise<void>;
} {
  const seen: Recalled = { memory: new Map(), kb: new Map() };
  const hashes = { memory: new Map<string, string>(), kb: new Map<string, string>() };
  const note = (kind: 'memory' | 'kb', id: string | undefined, content: string, trust?: 'trusted' | 'untrusted', title?: string): void => {
    if (id && !seen[kind].has(id)) { seen[kind].set(id, content); hashes[kind].set(id, itemHash(content, trust, kind === 'kb' ? title : undefined)); }
  };
  const memory: AgentMemoryPort = {
    async read(scope, query) {
      const entries = await input.memory.read(scope, query);
      for (const e of entries) note('memory', e.id, e.content, e.contentTrust);
      return entries;
    },
    write: (scope, entry) => input.memory.write(scope, entry),
  };
  const knowledgeRetrieve: AgentKnowledgeRetrieve | undefined = input.knowledgeRetrieve
    ? async (query, onSourceError) => {
        const out = await input.knowledgeRetrieve!(query, onSourceError);
        for (const c of out) note(c.kind, c.id, c.content, c.contentTrust, c.title);
        return out;
      }
    : undefined;
  return {
    memory,
    ...(knowledgeRetrieve ? { knowledgeRetrieve } : {}),
    async write(at) {
      const row: MemoryReadReceipt = {
        key: keyOf(at.tenantId, at.runId, at.nodeId, at.ordinal),
        tenantId: at.tenantId, runId: at.runId, nodeId: at.nodeId, ordinal: at.ordinal,
        orgId: at.orgId, scope: at.scope,
        entryIds: [...seen.memory.keys()], kbChunkIds: [...seen.kb.keys()],
        entryHashes: Object.fromEntries(hashes.memory), kbChunkHashes: Object.fromEntries(hashes.kb),
        contentHash: hashOf(seen.memory, seen.kb), at: new Date().toISOString(),
      };
      try {
        await receipts.compareAndSwap(null, row);
      } catch (err) {
        log.warn('memory_receipt_write_failed', { tenantId: at.tenantId, runId: at.runId, nodeId: at.nodeId, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

const trustOfRow = (tags: readonly string[], content: string): 'trusted' | 'untrusted' =>
  tags.includes(MEMORY_UNTRUSTED_TAG) || hasLegacyAutoExtractedPrefix(content) ? 'untrusted' : 'trusted';

/**
 * Serve a `replay` fork's recall from the source run's receipt. `partial()` is
 * true when anything the receipt names could not be served (erased, evicted, or
 * no longer retrieved): the caller tells the model.
 */
export function servedFromReceipt(input: {
  tenantId: string;
  receipt: MemoryReadReceipt;
  memory: AgentMemoryPort;
  knowledgeRetrieve?: AgentKnowledgeRetrieve | undefined;
}): { memory: AgentMemoryPort; knowledgeRetrieve?: AgentKnowledgeRetrieve; partial: () => boolean; finish: () => void } {
  const { tenantId, receipt } = input;
  let missing = 0;
  const served: Recalled = { memory: new Map(), kb: new Map() };
  let memoryRows: Promise<Array<{ id: string; content: string; contentTrust: 'trusted' | 'untrusted' }>> | null = null;
  const rows = (): Promise<Array<{ id: string; content: string; contentTrust: 'trusted' | 'untrusted' }>> => {
    memoryRows ??= (async () => {
      const out: Array<{ id: string; content: string; contentTrust: 'trusted' | 'untrusted' }> = [];
      for (const id of receipt.entryIds) {
        const row = await getMemoryEntry(tenantId, receipt.scope, id);
        if (!row) { missing += 1; continue; }
        const trust = trustOfRow(row.tags, row.content);
        if (receipt.entryHashes?.[id] !== itemHash(row.content, trust)) { missing += 1; continue; }
        out.push({ id, content: row.content, contentTrust: trust });
        served.memory.set(id, row.content);
      }
      return out;
    })();
    return memoryRows;
  };
  const memory: AgentMemoryPort = {
    // The receipt's rows, by id, whatever the scope now holds.
    async read(scope) {
      return scope === receipt.scope ? rows() : [];
    },
    // A replay never writes (the runner skips the summary on a replay too).
    async write() { /* no-op on replay */ },
  };
  const wanted = new Set(receipt.kbChunkIds);
  const knowledgeRetrieve: AgentKnowledgeRetrieve | undefined = input.knowledgeRetrieve
    ? async (query, onSourceError) => {
        const live = await input.knowledgeRetrieve!(query, onSourceError);
        const kb = live.filter((c) => c.kind === 'kb' && c.id !== undefined && wanted.has(c.id)
          && receipt.kbChunkHashes?.[c.id] === itemHash(c.content, c.contentTrust, c.title));
        missing += wanted.size - new Set(kb.map((c) => c.id)).size;
        for (const c of kb) served.kb.set(c.id!, c.content);
        // The memory leg is served from the receipt, never from live recall.
        const mem = (await rows()).map((r) => ({ content: r.content, kind: 'memory' as const, contentTrust: r.contentTrust, id: r.id }));
        return [...kb, ...mem];
      }
    : undefined;
  return {
    memory,
    ...(knowledgeRetrieve ? { knowledgeRetrieve } : {}),
    partial: () => missing > 0,
    finish: () => {
      if (missing > 0 || hashOf(served.memory, served.kb) !== receipt.contentHash) {
        log.info('memory_receipt_drift', { tenantId, sourceRunId: receipt.runId, nodeId: receipt.nodeId, missing, expectedHash: receipt.contentHash });
      }
    },
  };
}
