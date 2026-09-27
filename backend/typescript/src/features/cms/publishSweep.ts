/**
 * Scheduled-publish sweep (ADR 0204 C2) — publishes pages whose
 * `scheduledPublishAt` has passed. Modeled on `host/retentionSweepDaemon.ts`
 * (the house pattern for non-workflow periodic work): an unref'd
 * `setInterval` tick + a per-(page, scheduled-time) `claimOnce` lease
 * so multi-instance deploys fire once. There is deliberately NO new scheduler
 * primitive — the core `schedulingService` is cron-cadence workflow-starts;
 * a one-shot content publish is a feature-lifecycle sweep (the Phase-C
 * architecture ruling).
 *
 * Publishing goes through the SAME `transitionPage('publish')` as the route,
 * so version snapshots, lifecycle events (C1), and audit rows (C5) all apply
 * — no side-door. Fail-closed on the approval gate: scheduling is REJECTED at
 * set-time when the tenant's `cms-approval-gate` is ON (mirrors the direct
 * publish 409), and re-checked at fire-time (the gate may have turned ON
 * since) — a gated page is NOT published; its schedule is cleared and the
 * skip audited.
 */

import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { runUnderWorkerContract } from '../../storage/eventEraAdapter.js';
import { createLogger } from '../../observability/logger.js';
import { rejectPendingApprovalForPage } from '../../host/approvalService.js';
import { clearScheduledPublish, clearScheduledUnpublish, listScheduledDuePages, listScheduledDueUnpublishPages, transitionPage } from './cmsService.js';
import { isApprovalGateOn } from './contentApproval.js';

const log = createLogger('feature.cms.publishSweep');

// Minute-granular publish times by default; operator-tunable (CMSGAP-6) —
// e.g. slow it on an idle white-label deploy. Floor 10s (defense against a
// typo'd 0 turning the sweep into a hot loop).
const POLL_INTERVAL_MS = Math.max(10_000, Number(process.env.OPENWOP_CMS_PUBLISH_SWEEP_MS ?? '') || 60_000);
const CLAIM_KEY_PREFIX = 'cms-scheduled-publish:';
/** The sweep actor — audit rows + `updatedBy` stamps carry it. */
export const SCHEDULED_PUBLISH_ACTOR = 'system:cms-scheduler';

export async function processScheduledPublishes(nowMs: number = Date.now()): Promise<void> {
  const storage = hostExtStorage();
  const due = await listScheduledDuePages(new Date(nowMs).toISOString());
  for (const page of due) {
    // Fire-once across instances: the claim key pins (page, scheduled time,
    // set-time) — `updatedAt` changes on every schedule write, so cancelling
    // and re-scheduling the SAME timestamp still gets a fresh claim (review
    // finding: a time-only key would never re-fire).
    const claim = await storage.claimOnce(`${CLAIM_KEY_PREFIX}${page.pageId}:${page.scheduledPublishAt}:${page.updatedAt}`, new Date(nowMs).toISOString());
    if (!claim.claimed) continue;
    try {
      // ADR 0204 C2b window-elapsed rule: if the page's WHOLE embargo window
      // (publish-at .. unpublish-at) already passed — e.g. the instance was
      // down across both fire times — publishing now would resurrect content
      // whose window ended. Skip the publish, consume both schedules, audit.
      if (page.scheduledUnpublishAt && page.scheduledUnpublishAt <= new Date(nowMs).toISOString() && page.scheduledPublishAt && page.scheduledUnpublishAt > page.scheduledPublishAt) {
        await clearScheduledPublish(page.tenantId, page.orgId, page.pageId, SCHEDULED_PUBLISH_ACTOR, 'window-elapsed');
        await clearScheduledUnpublish(page.tenantId, page.orgId, page.pageId, SCHEDULED_PUBLISH_ACTOR, 'window-elapsed');
        continue;
      }
      // ADR 0593 (CMSA-D1) — the ONE gate predicate, shared with the routes and
      // the experiment promote lane (four independent read sites is how CMSA-4 drifted).
      if (await isApprovalGateOn(page.tenantId)) {
        // Gate turned ON after scheduling — fail closed: never publish around
        // the inbox. Clear the schedule and audit the skip.
        await clearScheduledPublish(page.tenantId, page.orgId, page.pageId, SCHEDULED_PUBLISH_ACTOR, 'approval-gate-on');
        continue;
      }
      await transitionPage(page.tenantId, page.orgId, page.pageId, 'publish', SCHEDULED_PUBLISH_ACTOR);
      // ADR 0672 D2 (`CMSAWF-12`) — the FOURTH row-stranding producer. `setScheduledPublish`
      // permits an `in_review` page, so a scheduled publish can fire while a review row is
      // still pending. Four sibling producers already closed their row (deletePage,
      // restoreVersion, unpublish/archive, direct publish); this one did not, and ADR 0593
      // D2's own enumeration named only three. The inbox then advertised an outstanding
      // review for a page that was already live, and the CMS Notice never rendered it
      // because it gates on `status === 'in_review'`, which is now `published`.
      //
      // `superseded: true` is load-bearing and is why this had to land AFTER D3: the sweep
      // publish IS a supersession, so closing the row as a plain rejection would have put
      // "the review was rejected" against a page this very line just published — the exact
      // defect D3 exists to remove, reintroduced on a new lane.
      await rejectPendingApprovalForPage(page.tenantId, page.pageId, 'Superseded by a scheduled publish.', true);
    } catch (err) {
      // 409 (page moved out of a publishable status) or storage hiccup: the
      // schedule stays; the next tick re-claims under a NEW time only if
      // re-scheduled — so log loudly and clear to avoid a retry storm on a
      // permanently unpublishable page.
      log.warn('scheduled publish failed', { pageId: page.pageId, error: err instanceof Error ? err.message : String(err) });
      await clearScheduledPublish(page.tenantId, page.orgId, page.pageId, SCHEDULED_PUBLISH_ACTOR, 'publish-failed').catch(() => undefined);
    }
  }
}

const UNPUBLISH_CLAIM_KEY_PREFIX = 'cms-scheduled-unpublish:';

/** The unpublish lane (ADR 0204 C2b). There is deliberately NO approval-gate
 *  check here: the gate protects the PUBLISH direction (content going public);
 *  a scheduled unpublish REMOVES content — the fail-safe direction. Do not
 *  "fix" this by symmetry with the publish lane above. */
export async function processScheduledUnpublishes(nowMs: number = Date.now()): Promise<void> {
  const storage = hostExtStorage();
  const due = await listScheduledDueUnpublishPages(new Date(nowMs).toISOString());
  for (const page of due) {
    const claim = await storage.claimOnce(`${UNPUBLISH_CLAIM_KEY_PREFIX}${page.pageId}:${page.scheduledUnpublishAt}:${page.updatedAt}`, new Date(nowMs).toISOString());
    if (!claim.claimed) continue;
    try {
      // transitionPage consumes scheduledUnpublishAt on leaving `published`;
      // the marker self-heals at the next due-list read.
      await transitionPage(page.tenantId, page.orgId, page.pageId, 'unpublish', SCHEDULED_PUBLISH_ACTOR);
    } catch (err) {
      log.warn('scheduled unpublish failed', { pageId: page.pageId, error: err instanceof Error ? err.message : String(err) });
      await clearScheduledUnpublish(page.tenantId, page.orgId, page.pageId, SCHEDULED_PUBLISH_ACTOR, 'unpublish-failed').catch(() => undefined);
    }
  }
}

export interface CmsPublishSweepDaemon { stop(): void }

let started: CmsPublishSweepDaemon | null = null;

/** Start the sweep once per process (idempotent — feature registration may run
 *  in tests that build multiple apps). */
export function startCmsPublishSweep(): CmsPublishSweepDaemon {
  if (started) return started;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Publish lane FIRST: its window-elapsed rule consumes a due pair
      // before the unpublish lane could misread the pre-publish status.
      await processScheduledPublishes();
      await processScheduledUnpublishes();
    } catch (err) {
      log.warn('cms publish sweep tick error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runUnderWorkerContract(tick), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('cms scheduled-publish sweep started', { pollIntervalMs: POLL_INTERVAL_MS });
  started = { stop: () => { clearInterval(timer); started = null; } };
  return started;
}
