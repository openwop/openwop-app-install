/**
 * CMS page-lifecycle seam (ADR 0392) — the in-process hook by which FEATURE-owned
 * consumers react when a CMS page's publish state changes, WITHOUT `cms`
 * importing features. Identical contract to `host/knowledgeLifecycle.ts` and the
 * canvas/conversation lifecycle seams: KEYED registration (repeat boots
 * overwrite), idempotent bounded handlers, best-effort fan-out that never throws,
 * fired AFTER the page write is durable (from `cmsService.recordCmsAction`).
 *
 * The docs feature (ADR 0392) registers here to keep a managed `docs` KB
 * collection in lockstep with published docs pages — CMS stays ignorant of docs
 * (the handler filters on `collection === 'docs'`).
 *
 * @see host/knowledgeLifecycle.ts (the sibling this mirrors)
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.cmsPageLifecycle');

export type CmsPageLifecycleEvent = 'published' | 'unpublished' | 'archived' | 'deleted';

/** The content-collection discriminator (ADR 0392). Declared HERE (host, below
 *  features) as the single shared type — cms + consumers import it, so adding a
 *  second collection is one edit, not a literal hunt (grade-pass D11). */
export type CmsContentCollection = 'docs';

export interface CmsPageLifecycleChange {
  tenantId: string;
  orgId: string;
  pageId: string;
  slug: string;
  title: string;
  /** The content collection discriminator (ADR 0392) — a consumer filters on
   *  this so CMS need not know which features care about which collections. */
  collection?: 'docs';
  event: CmsPageLifecycleEvent;
}

type Handler = (e: CmsPageLifecycleChange) => Promise<void>;

const handlers = new Map<string, Handler>();

/** A consumer feature registers (idempotently, keyed) its reaction at boot. */
export function onCmsPageLifecycle(key: string, fn: Handler): void {
  handlers.set(key, fn);
}

/** Called by `cms` after a publish/unpublish/archive transition is durable; runs
 *  every registrant best-effort. Never throws (a consumer's failure must not
 *  fail the CMS write) — a swallowed failure is LOGGED with its consumer key. */
export async function fireCmsPageLifecycle(e: CmsPageLifecycleChange): Promise<number> {
  let ran = 0;
  for (const [key, h] of handlers) {
    try {
      await h(e);
      ran += 1;
    } catch (err) {
      log.warn('cms_page_lifecycle_consumer_failed', { consumer: key, tenantId: e.tenantId, pageId: e.pageId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetCmsPageLifecycleHooks(): void {
  handlers.clear();
}
