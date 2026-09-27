/**
 * CMNT-3 — a comment read must never scan the whole `comments:thread` collection
 * across all tenants.
 *
 * `listThread` was `comments.list()` — one `kvList` over the entire namespace, a
 * decode of every row in every tenant, then an in-memory filter — on the hot path
 * of every `/comments` render, every inline expand, and every
 * `openwop:comments.list` tool turn. `deleteComment`'s reply lookup and
 * `deleteSubjectComments` had the same shape (the eraser once per resolved
 * subject key). The collection was constructed WITH `tenantOf` and the retention
 * purger already read through `listForTenantIndexed`, so the bounded lane existed
 * the whole time and was simply unused.
 *
 * Asserted at the STORAGE layer, following `crm-merge-bounded-reads.test.ts`: a
 * source grep passes the moment someone re-spells the call, and what matters is
 * the key space actually read. A whole-collection read is recognisable by SHAPE
 * (`hostext:<name>:` with nothing after it), so the rule needs no allowlist —
 * which is precisely how the CRM version of this gate walked past a live offender.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __hostExtStorage, DurableCollection } from '../src/host/hostExtPersistence.js';
import { createPage, __resetCms } from '../src/features/cms/cmsService.js';
import {
  createComment, deleteComment, listThread, deleteSubjectComments, __resetCommentsStore,
  type Comment,
} from '../src/features/comments/commentsService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';

/** ADR 0659 D1 — `listThread` now answers `null` when the target is absent OR invisible.
 *  Every fixture here creates a real resource and is not testing that gate, so a null is
 *  a genuine failure rather than an expected branch. */
async function listThreadOrFail(...args: Parameters<typeof listThread>): Promise<NonNullable<Awaited<ReturnType<typeof listThread>>>> {
  const rows = await listThread(...args);
  if (rows === null) throw new Error('listThread resolved no target — the fixture did not create it');
  return rows;
}

const T = 'cmt-bounded-tenant';
const OTHER = 'cmt-bounded-other';
let server: http.Server;
let real: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  real = __hostExtStorage()!;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __resetCommentsStore(); await __resetCms(); });
afterEach(() => { initHostExtPersistence(real); });

/** Record every `kvList` prefix issued while `fn` runs. */
async function recordListPrefixes(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  initHostExtPersistence(new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'kvList') {
        return async (prefix: string) => { seen.push(prefix); return (target as Storage).kvList(prefix); };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Storage);
  try { await fn(); } finally { initHostExtPersistence(real); }
  return seen;
}

/** A whole-collection read: `hostext:<name>:` (optionally one more segment for a
 *  two-part namespace like `comments:thread`) with nothing tenant-scoped after it. */
function unboundedScans(prefixes: readonly string[]): string[] {
  return prefixes.filter((p) => /^hostext(?:idx)?:[^:]+(?::[^:]+)?:$/.test(p) && !p.startsWith('hostextidxmeta:'));
}

/** `ensureTenantIndex()` does ONE full `list()` ever (sentinel-guarded) to mint
 *  markers for pre-index rows. That is a genuine one-shot backfill, not a
 *  per-read scan — but it is indistinguishable from one inside a probe window,
 *  so warm it first and measure the steady state, as the CRM probe does. */
async function warmTenantIndex(): Promise<void> {
  await new DurableCollection<Comment>('comments:thread', (c) => c.commentId, undefined, (c) => c.tenantId).ensureTenantIndex();
}

async function seedThread(tenantId: string): Promise<{ pageId: string; rootId: string }> {
  const page = await createPage({ tenantId, orgId: 'o1', title: 'Doc', createdBy: 'owner' });
  const root = await createComment({ tenantId, orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'root', authorId: 'A' , caller: { subject: 'A' }});
  await createComment({ tenantId, orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, parentId: root.comment.commentId, body: 'reply', authorId: 'A' , caller: { subject: 'A' }});
  return { pageId: page.pageId, rootId: root.comment.commentId };
}

describe('CMNT-3 — comment reads are tenant-bounded', () => {
  it('listThread issues NO whole-collection scan', async () => {
    const { pageId } = await seedThread(T);
    await seedThread(OTHER); // a second tenant's rows exist to be (not) scanned
    await warmTenantIndex();

    const prefixes = await recordListPrefixes(async () => {
      expect((await listThreadOrFail(T, 'o1', 'cms_page', pageId, PREAUTHORIZED_CALLER)).length).toBe(2);
    });

    expect(prefixes.length, 'the probe must have captured kvList calls').toBeGreaterThan(0);
    expect(
      [...new Set(unboundedScans(prefixes))].sort(),
      'listThread MUST read through listForTenantIndexed — never comments.list()',
    ).toEqual([]);
  });

  it('deleteComment’s reply lookup issues NO whole-collection scan', async () => {
    const { rootId } = await seedThread(T);
    await seedThread(OTHER);
    await warmTenantIndex();

    const prefixes = await recordListPrefixes(async () => {
      expect(await deleteComment(T, 'o1', rootId, { userId: 'A', isAdmin: false }, PREAUTHORIZED_CALLER)).toBe(true);
    });

    expect(prefixes.length).toBeGreaterThan(0);
    expect([...new Set(unboundedScans(prefixes))].sort()).toEqual([]);
  });

  it('deleteSubjectComments (the DSAR eraser) issues NO whole-collection scan', async () => {
    await seedThread(T);
    await seedThread(OTHER);
    await warmTenantIndex();

    const prefixes = await recordListPrefixes(async () => {
      expect(await deleteSubjectComments(T, 'A')).toBe(2);
    });

    expect(prefixes.length).toBeGreaterThan(0);
    expect([...new Set(unboundedScans(prefixes))].sort()).toEqual([]);
  });

  it('the bounded lane still returns the right rows, and only this tenant’s', async () => {
    // The perf property must not have been bought with a correctness regression:
    // the tenant index is a bounded SCAN, so an absent marker means an absent row.
    const mine = await seedThread(T);
    const theirs = await seedThread(OTHER);
    expect((await listThreadOrFail(T, 'o1', 'cms_page', mine.pageId, PREAUTHORIZED_CALLER)).length).toBe(2);
    // ADR 0659 D1 — another tenant's page is not merely an empty thread here, it is a
    // uniform not-found: the resolver never finds the target in THIS tenant.
    expect(await listThread(T, 'o1', 'cms_page', theirs.pageId, PREAUTHORIZED_CALLER)).toBeNull();
    expect((await listThreadOrFail(OTHER, 'o1', 'cms_page', theirs.pageId, PREAUTHORIZED_CALLER)).length).toBe(2);
  });

  it('an unscoped read fails closed rather than falling back to a full scan — and never reaches a resolver', async () => {
    await seedThread(T);
    // ADR 0659 D1 — `null`, not `[]`: an unscoped read is a refusal. The guard runs BEFORE
    // the target resolver, which would otherwise hand an empty tenantId to another
    // feature's store (this assertion caught exactly that regression).
    expect(await listThread('', 'o1', 'cms_page', 'anything', PREAUTHORIZED_CALLER)).toBeNull();
    expect(await deleteSubjectComments('', 'A')).toBe(0);
  });
});
