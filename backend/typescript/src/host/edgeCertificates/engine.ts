/**
 * ADR 0906 D3/D4 — the edge step engine: moves one LIVE domain row's `edge`
 * sub-object forward through prepare → issue → status, writing the row after
 * EVERY step (compare-and-swap), so a crash at any point resumes at the next
 * step against the same deterministic resources.
 *
 * Rules:
 *   - only `status === 'live'` rows are advanced (no certificate for an
 *     unproven claim, D2; the TXT stays the single ownership authority);
 *   - `manual` returns before any call and writes nothing (golden: the row is
 *     byte-identical to before ADR 0906);
 *   - a provider not ready (`loadEdgeConfig` reported a reason) writes nothing
 *     and calls nothing;
 *   - `active` and `releasing` rows are left alone here (status polling of
 *     those, and release, are the lifecycle's job — P3);
 *   - a provider error is recorded on `edge.issue` without moving `tls`.
 */
import { createLogger } from '../../observability/logger.js';
import type { CustomDomainEdge, EdgeCertificateProvider, EdgeTlsState } from './port.js';
import { edgeResourceIds } from './gcpCertificateManager.js';

const log = createLogger('host.edgeCertificates');

/** The slice of the domain row the engine reads and writes. */
export interface EdgeRow {
  hostname: string;
  status: string;
  edge?: CustomDomainEdge;
}

export interface EdgeEngineDeps<R extends EdgeRow> {
  provider: EdgeCertificateProvider;
  get(hostname: string): Promise<R | null>;
  compareAndSwap(expected: R, next: R): Promise<boolean>;
  now?: () => Date;
}

const DETAIL_MAX = 300;
/** D5 — an authorization still failing this long after the state began is a configuration problem. */
export const DNS_NOT_CONFIGURED_AFTER_MS = 24 * 60 * 60 * 1000;
const SETTLED: ReadonlySet<EdgeTlsState> = new Set(['active', 'releasing']);

/**
 * Merge `patch` into the row's edge and write it. On a lost swap, re-read and
 * re-apply once — every step is idempotent, so applying the same patch to a
 * newer row is safe. Returns the written row, or null when the row is gone or
 * stopped being advanceable (deleted, demoted, or moved to releasing).
 */
async function writeEdge<R extends EdgeRow>(deps: EdgeEngineDeps<R>, row: R, patch: Partial<CustomDomainEdge>): Promise<R | null> {
  let current: R | null = row;
  for (let attempt = 0; attempt < 2 && current; attempt++) {
    const nowIso = (deps.now ?? (() => new Date()))().toISOString();
    const prev: CustomDomainEdge = current.edge ?? { provider: deps.provider.id, tls: 'not_requested', checkedAt: nowIso };
    const merged: CustomDomainEdge = { ...prev, ...patch, provider: deps.provider.id, checkedAt: nowIso };
    if (patch.tls && patch.tls !== prev.tls) merged.tlsSince = nowIso;
    if (patch.issue === undefined) delete merged.issue; // a step that made progress clears the old issue
    const next = { ...current, edge: merged } as R;
    if (await deps.compareAndSwap(current, next)) return next;
    current = await deps.get(row.hostname);
    if (current && (current.status !== 'live' || (current.edge && SETTLED.has(current.edge.tls)))) return null;
  }
  if (!current) {
    // The row vanished mid-flight. Resources are recomputable from the
    // hostname, so the lifecycle's release can still find them (P3).
    log.warn('edge_orphan_candidate', { hostname: row.hostname, ids: edgeResourceIds(row.hostname) });
  }
  return null;
}

function errorIssue(err: unknown): CustomDomainEdge['issue'] {
  const detail = err instanceof Error ? err.message : String(err);
  return { reason: 'provider_error', detail: detail.slice(0, DETAIL_MAX) };
}

/** Advance one hostname as far as it can go right now. Returns the latest row (or null if gone). */
export async function advanceEdge<R extends EdgeRow>(hostname: string, deps: EdgeEngineDeps<R>): Promise<R | null> {
  if (deps.provider.id === 'manual') return deps.get(hostname);
  let row = await deps.get(hostname);
  if (!row || row.status !== 'live') return row;
  if (row.edge && SETTLED.has(row.edge.tls)) return row;

  try {
    // Step 1 — DNS authorization (D2: only now that ownership is proven).
    if (!row.edge?.dnsAuthName || !row.edge.dnsAuthRecord) {
      const prepared = await deps.provider.prepare(row.hostname);
      if (!prepared.done) return await writeEdge(deps, row, { tls: 'awaiting_dns' });
      const record = prepared.value.dnsRecords.find((r) => r.purpose === 'certificate');
      const written = await writeEdge(deps, row, {
        tls: 'awaiting_dns',
        ...(prepared.value.handle.dnsAuthName ? { dnsAuthName: prepared.value.handle.dnsAuthName } : {}),
        ...(record ? { dnsAuthRecord: record } : {}),
      });
      if (!written) return null;
      row = written;
    }

    // Step 2 — certificate + map entry.
    if (!row.edge?.certName || !row.edge.mapEntryName) {
      const issued = await deps.provider.issue(row.hostname, {
        ...(row.edge?.dnsAuthName ? { dnsAuthName: row.edge.dnsAuthName } : {}),
        ...(row.edge?.certName ? { certName: row.edge.certName } : {}),
      });
      if (!issued.done) return await writeEdge(deps, row, {});
      const written = await writeEdge(deps, row, {
        ...(issued.value.certName ? { certName: issued.value.certName } : {}),
        ...(issued.value.mapEntryName ? { mapEntryName: issued.value.mapEntryName } : {}),
      });
      if (!written) return null;
      row = written;
    }

    // Step 3 — read the certificate's state.
    const status = await deps.provider.status({
      ...(row.edge?.dnsAuthName ? { dnsAuthName: row.edge.dnsAuthName } : {}),
      ...(row.edge?.certName ? { certName: row.edge.certName } : {}),
      ...(row.edge?.mapEntryName ? { mapEntryName: row.edge.mapEntryName } : {}),
    });
    // D5 — still unauthorized a day after asking: say so plainly and stop polling.
    const since = Date.parse(row.edge?.tlsSince ?? '');
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    if (status.tls === 'awaiting_dns' && status.issue && row.edge?.tls === 'awaiting_dns'
      && Number.isFinite(since) && nowMs - since > DNS_NOT_CONFIGURED_AFTER_MS) {
      return await writeEdge(deps, row, {
        tls: 'failed',
        issue: { reason: 'dns_not_configured', detail: `The certificate CNAME was not found after 24 hours (${status.issue.reason}).` },
      });
    }
    return await writeEdge(deps, row, { tls: status.tls, issue: status.issue });
  } catch (err) {
    log.warn('edge_step_failed', { hostname, error: err instanceof Error ? err.message : String(err) });
    return await writeEdge(deps, row, { issue: errorIssue(err) });
  }
}

/** True when the provider holds (or may hold) resources for this row. */
export function hasEdgeResources(edge: CustomDomainEdge | undefined): boolean {
  return Boolean(edge && edge.provider !== 'manual' && edge.tls !== 'not_requested');
}

/**
 * D4 — release the row's provider resources. The `releasing` state (with its
 * intent) is CAS-written BEFORE any delete, so a crash leaves a row the sweep
 * resumes, never resources with no row. Returns `released` (resources gone;
 * the caller finishes the intent), `partial` (attempt counted; the sweep
 * retries) or `gone` (the row no longer exists).
 */
export async function releaseEdge<R extends EdgeRow>(
  hostname: string,
  intent: NonNullable<CustomDomainEdge['releaseIntent']>,
  deps: EdgeEngineDeps<R>,
  casRetries = 2,
): Promise<{ outcome: 'released' | 'partial' | 'gone'; row: R | null }> {
  let row = await deps.get(hostname);
  if (!row) return { outcome: 'gone', row: null };
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const edge = row.edge;
  if (edge?.tls !== 'releasing' || edge.releaseIntent !== intent) {
    // A delete/expire outranks a reissue already in flight; never the reverse.
    const keep = edge?.tls === 'releasing' && edge.releaseIntent !== 'reissue' && intent === 'reissue';
    if (!keep) {
      const next = {
        ...row,
        edge: {
          ...(edge ?? { provider: deps.provider.id, checkedAt: nowIso }),
          tls: 'releasing',
          releaseIntent: intent,
          releaseAttempts: edge?.tls === 'releasing' ? (edge.releaseAttempts ?? 0) : 0,
          tlsSince: edge?.tls === 'releasing' ? (edge.tlsSince ?? nowIso) : nowIso,
          checkedAt: nowIso,
        } satisfies CustomDomainEdge,
      } as R;
      if (!(await deps.compareAndSwap(row, next))) {
        if (casRetries <= 0) return { outcome: 'partial', row: await deps.get(hostname) };
        return releaseEdge(hostname, intent, deps, casRetries - 1);
      }
      row = next;
    }
  }
  // An edge written by another provider (the operator switched providers) cannot be released here.
  let outcome: 'released' | 'partial';
  try {
    outcome = row.edge && row.edge.provider !== deps.provider.id ? 'partial' : await deps.provider.release(row.hostname);
  } catch (err) {
    log.warn('edge_release_failed', { hostname, error: err instanceof Error ? err.message : String(err) });
    outcome = 'partial';
  }
  if (outcome === 'released') return { outcome, row };
  const cur = await deps.get(hostname);
  if (!cur) return { outcome: 'gone', row: null };
  const attempts = (cur.edge?.releaseAttempts ?? 0) + 1;
  const next = {
    ...cur,
    edge: {
      ...cur.edge!,
      releaseAttempts: attempts,
      checkedAt: nowIso,
      issue: {
        reason: row.edge && row.edge.provider !== deps.provider.id ? 'provider_changed' : 'release_incomplete',
        detail: `Removing the certificate did not finish (attempt ${attempts}); it will be retried.`,
      },
    },
  } as R;
  await deps.compareAndSwap(cur, next);
  return { outcome: 'partial', row: next };
}
