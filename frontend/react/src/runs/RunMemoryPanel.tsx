/**
 * Memory ledger (app-ux §A3).
 *
 * Read-only view of the tenant's RFC 0004 memory entries (host-extension
 * GET /v1/host/openwop-app/memory), tied to the run you're looking at.
 *
 * Attribution (RFC 0057). When the host advertises
 * `capabilities.memory.attribution.emitsWriteEvents`, this panel reads the
 * run's `memory.written` events to determine — *authoritatively* — which
 * entries this run wrote and which node wrote each one, replacing the older
 * `run-id:<runId>` tag heuristic (kept as the fallback for hosts that don't
 * advertise attribution). The event is content-free by invariant
 * (`memory-attribution-no-content`): it carries `{ memoryRef, memoryId,
 * nodeId?, agentId?, tags? }` only, never the entry content — so we read the
 * content from the read-side (already SR-1-redacted) and use the event purely
 * to attribute it. A `[REDACTED:…]` SR-1 marker is surfaced as a badge.
 *
 * Companion to the RunTimeline memory-write markers (#192), which read the
 * same `memory.written` events to mark *where* a write happened; this marks
 * *which entries* a run wrote and by which node.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunEventDoc } from '@openwop/openwop';
import { listMemory, getCapabilities, type MemoryEntry } from '../client/runsClient.js';
import { LockIcon, PencilIcon } from '../ui/icons/index.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import i18n from '../i18n/index.js';
import { formatDateTime } from '../i18n/format.js';

interface Props {
  runId: string;
  /** The run's event log (from RunDetailPage). `memory.written` events here
   *  drive authoritative write-attribution when the host advertises it. */
  events: readonly RunEventDoc[];
  /** Refetch when the run reaches a terminal status (the run-summary is
   *  written on completion, so it only exists once the run finishes). */
  status?: string | undefined;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

interface WriteAttribution {
  nodeId?: string;
  agentId?: string;
}

function isRedacted(content: string): boolean {
  return /\[REDACTED:[^\]]*\]/.test(content);
}

// Fold the run's `memory.written` events (RFC 0057) into a memoryId → who-wrote
// map. The events passed in are already scoped to this run, so every entry is a
// write this run made. `nodeId` is read from the canonical payload (RFC 0057
// §B SHOULD) with the event envelope's `nodeId` as a fallback.
function buildAttribution(events: readonly RunEventDoc[]): Map<string, WriteAttribution> {
  const byMemoryId = new Map<string, WriteAttribution>();
  for (const ev of events) {
    if (ev.type !== 'memory.written') continue;
    const p = (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as {
      memoryId?: unknown;
      nodeId?: unknown;
      agentId?: unknown;
    };
    if (typeof p.memoryId !== 'string') continue;
    const nodeId = typeof p.nodeId === 'string' ? p.nodeId : ev.nodeId;
    const attr: WriteAttribution = {};
    if (nodeId) attr.nodeId = nodeId;
    if (typeof p.agentId === 'string') attr.agentId = p.agentId;
    byMemoryId.set(p.memoryId, attr);
  }
  return byMemoryId;
}

/** Column set for the memory ledger DataTable. Factory so the Content cell can
 *  attribute each entry via the run's `memory.written` map. Order-preserving:
 *  no sortValue (entries keep their server order). */
function MEMORY_COLUMNS(attribution: Map<string, WriteAttribution>): DataColumn<MemoryEntry>[] {
  return [
    {
      key: 'content',
      header: i18n.t('runs:memoryColContent'),
      render: (e) => {
        const attr = attribution.get(e.id);
        return (
          <>
            {isRedacted(e.content) && (
              <span className="memory-redacted-badge" title={i18n.t('runs:memoryRedactedTitle')}>
                <LockIcon size={12} /> {i18n.t('runs:memoryRedacted')}
              </span>
            )}
            {attr?.nodeId && (
              <span
                className="memory-wrote-badge"
                title={attr.agentId
                  ? i18n.t('runs:memoryWrittenByNodeAgent', { nodeId: attr.nodeId, agentId: attr.agentId })
                  : i18n.t('runs:memoryWrittenByNode', { nodeId: attr.nodeId })}
              >
                <PencilIcon size={12} /> {attr.nodeId}
              </span>
            )}
            <span className="memory-content">{e.content}</span>
          </>
        );
      },
    },
    {
      key: 'tags',
      header: i18n.t('runs:memoryColTags'),
      render: (e) => (
        <div className="memory-tags">
          {e.tags.map((tag) => (
            <span key={tag} className="memory-tag">{tag}</span>
          ))}
        </div>
      ),
    },
    {
      key: 'created',
      header: i18n.t('runs:memoryColCreated'),
      render: (e) => (
        <span className="memory-created" title={e.createdAt}>
          {formatDateTime(e.createdAt)}
          {e.expiresAt && (
            <span className="muted" title={i18n.t('runs:memoryExpires', { at: e.expiresAt })}> {i18n.t('runs:memoryTtlSuffix')}</span>
          )}
        </span>
      ),
    },
  ];
}

export function RunMemoryPanel({ runId, events, status }: Props) {
  const { t } = useTranslation('runs');
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = not yet known; consume the attribution events only once we've
  // confirmed the host advertises them, so non-advertising hosts keep the
  // tag-heuristic behaviour rather than silently showing zero writes.
  const [attributionAdvertised, setAttributionAdvertised] = useState<boolean | null>(null);
  const terminal = status ? TERMINAL.has(status) : false;

  useEffect(() => {
    let cancelled = false;
    listMemory({ limit: 50 })
      .then((res) => {
        if (!cancelled) setEntries(res.entries);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // Refetch when the run finishes so the on-completion run-summary appears.
  }, [runId, terminal]);

  useEffect(() => {
    let cancelled = false;
    getCapabilities()
      .then((caps) => {
        if (cancelled) return;
        const attribution = (
          caps as { capabilities?: { memory?: { attribution?: { emitsWriteEvents?: unknown } } } }
        ).capabilities?.memory?.attribution;
        setAttributionAdvertised(attribution?.emitsWriteEvents === true);
      })
      .catch(() => {
        // Discovery failed — fall back to the tag heuristic.
        if (!cancelled) setAttributionAdvertised(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const attribution = useMemo(() => buildAttribution(events), [events]);

  const thisRunTag = `run-id:${runId}`;
  // Authoritative when the host advertises attribution AND we've actually
  // received write events for this run; otherwise the tag heuristic.
  const useEvents = attributionAdvertised === true && attribution.size > 0;
  const mineFor = (e: MemoryEntry): boolean =>
    useEvents ? attribution.has(e.id) : e.tags.includes(thisRunTag);

  const { fromThisRun, total } = useMemo(() => {
    const list = entries ?? [];
    const count = list.filter((e) =>
      useEvents ? attribution.has(e.id) : e.tags.includes(thisRunTag),
    ).length;
    return { fromThisRun: count, total: list.length };
  }, [entries, useEvents, attribution, thisRunTag]);

  // Nothing to show and no error → the host doesn't expose memory, or it's
  // empty. Stay quiet rather than render an empty card.
  if (!error && (entries === null || entries.length === 0)) return null;

  return (
    <div className="card">
      <div className="u-flex u-items-baseline u-gap-2">
        <h2 className="u-flex-1">{t('memoryLedger')}</h2>
        {!error && (
          <span className="muted u-fs-12">
            {fromThisRun > 0 ? `${t('memoryFromThisRun', { count: fromThisRun })} · ` : ''}
            {t('memoryEntryCount', { count: total })}
          </span>
        )}
      </div>
      <p className="muted runmem-subhead">
        {t('memoryTenantPrefix')}{' '}
        {useEvents ? t('memoryHighlightAttributed') : t('memoryHighlightSimple')}
      </p>
      {error ? (
        <div className="alert error">{error}</div>
      ) : (
        <DataTable<MemoryEntry>
          caption={t('memoryTableCaption')}
          rows={entries ?? []}
          rowKey={(e) => e.id}
          rowClassName={(e) => (mineFor(e) ? 'memory-row-mine' : undefined)}
          columns={MEMORY_COLUMNS(attribution)}
        />
      )}
    </div>
  );
}
