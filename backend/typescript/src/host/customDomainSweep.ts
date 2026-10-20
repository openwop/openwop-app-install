/**
 * The custom-domain background sweep (ADR 0295; fenced by ADR 0906 D5).
 *
 * Revocation on DNS change: every LIVE domain is re-verified periodically. A
 * clean DNS negative demotes it to `failed`; resolver noise never does. And the
 * edge lifecycle (ADR 0906 D5): a 5-minute poll that advances certificates,
 * finishes releases and expires stale pending claims.
 *
 * The house pattern for non-workflow periodic work (`cms/publishSweep.ts`,
 * `retentionSweepDaemon.ts`): an unref'd `setInterval` whose tick runs under
 * the worker contract, plus a per-(hostname, slot) `claimOnce` lease so N
 * instances check each row once per slot. Before ADR 0906 every instance
 * re-verified every row on every tick. The lease keys are machine-generated
 * (hostname + slot number), never caller-supplied, which is why this file is
 * on the ADR 0549 fire-once-mutex allowlist. The domain logic itself stays in
 * `host/customDomains.ts`; this file owns only the timer and the leases.
 */
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import { hostExtStorage } from './hostExtPersistence.js';
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import { createLogger } from '../observability/logger.js';
import { edgeWorkDue, listAllDomainsForSweep, processEdgeRow, verifyDomain, type TxtResolver } from './customDomains.js';
import { resolveEdgeProvider, type EdgeCertificateProvider } from './edgeCertificates/index.js';

const log = createLogger('host.customDomainSweep');

const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_CUSTOM_DOMAIN_RECHECK_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 6 * 60 * 60 * 1000; // default 6h
})();

const RECHECK_CLAIM_PREFIX = 'custom-domain-recheck:';

/**
 * One pass of the live-domain re-check, leased per (hostname, slot). A crashed
 * holder costs that row one slot: the re-check is idempotent and only a clean
 * DNS negative demotes, so there is nothing to recover early. Returns the
 * hostnames this instance checked.
 */
export async function runCustomDomainRecheck(
  resolveTxt: TxtResolver = dnsResolveTxt,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const storage = hostExtStorage();
  const slot = Math.floor(nowMs / POLL_MS);
  const checked: string[] = [];
  for (const d of await listAllDomainsForSweep()) {
    if (d.status !== 'live') continue;
    const claim = await storage.claimOnce(`${RECHECK_CLAIM_PREFIX}${encodeURIComponent(d.hostname)}:${slot}`, new Date(nowMs).toISOString());
    if (!claim.claimed) continue;
    await verifyDomain(d.tenantId, d.orgId, d.hostname, resolveTxt);
    checked.push(d.hostname);
  }
  return checked;
}

const EDGE_POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_CUSTOM_DOMAIN_EDGE_POLL_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 5 * 60 * 1000; // default 5 min
})();
const EDGE_CLAIM_PREFIX = 'custom-domain-edge:';

export interface EdgePollReport { advanced: string[]; released: string[]; expired: string[] }

/**
 * One pass of the edge lifecycle (ADR 0906 D5), leased per (hostname, slot).
 * The per-row step is `processEdgeRow` in `host/customDomains.ts`.
 */
export async function runCustomDomainEdgePoll(
  provider: EdgeCertificateProvider | null = resolveEdgeProvider(),
  nowMs: number = Date.now(),
): Promise<EdgePollReport> {
  const storage = hostExtStorage();
  const slot = Math.floor(nowMs / EDGE_POLL_MS);
  const report: EdgePollReport = { advanced: [], released: [], expired: [] };
  for (const d of await listAllDomainsForSweep()) {
    if (!edgeWorkDue(d, nowMs)) continue;
    const claim = await storage.claimOnce(`${EDGE_CLAIM_PREFIX}${encodeURIComponent(d.hostname)}:${slot}`, new Date(nowMs).toISOString());
    if (!claim.claimed) continue;
    try {
      const out = await processEdgeRow(d, provider, nowMs);
      if (out) report[out].push(d.hostname);
    } catch (err) {
      log.warn('custom-domain edge poll failed', { hostname: d.hostname, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

let started = false;
export function startCustomDomainSweep(resolveTxt: TxtResolver = dnsResolveTxt): { stop: () => void } | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runCustomDomainRecheck(resolveTxt);
    } catch (err) {
      log.warn('custom-domain recheck failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void runUnderWorkerContract(tick), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  let edgeRunning = false;
  const edgeTick = async (): Promise<void> => {
    if (edgeRunning) return;
    edgeRunning = true;
    try { await runCustomDomainEdgePoll(); } catch (err) {
      log.warn('custom-domain edge poll failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { edgeRunning = false; }
  };
  const edgeTimer = setInterval(() => void runUnderWorkerContract(edgeTick), EDGE_POLL_MS);
  if (typeof edgeTimer.unref === 'function') edgeTimer.unref();
  log.info('custom-domain recheck sweep started', { pollMs: POLL_MS, edgePollMs: EDGE_POLL_MS });
  return { stop: () => { clearInterval(timer); clearInterval(edgeTimer); started = false; } };
}
