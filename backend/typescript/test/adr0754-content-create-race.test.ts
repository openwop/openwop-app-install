/**
 * ADR 0754 — a protocol content create is CREATE-only, under concurrency too.
 *
 * ADR 0755 made the duplicate-`pageId` and slug checks tenant-wide, but both were
 * READS before the write: two concurrent creates both passed them, then the second
 * write overwrote the first (kernel `put` updates an existing row) or `createPage`
 * silently renamed the slug to `slug-2`. These legs race two creates for real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createProtocolPage, listPages } from '../src/features/cms/cmsService.js';

const TENANT = 'tenant-0754-race';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const create = (pageId: string, slug: string, name: string) =>
  createProtocolPage({ tenantId: TENANT, orgId: TENANT, pageId, slug, name, sectionOrder: ['hero'], createdBy: 'test', baseLocale: 'en' });

function status(r: PromiseSettledResult<unknown>): number | 'ok' {
  return r.status === 'fulfilled' ? 'ok' : (r.reason as { httpStatus?: number }).httpStatus ?? -1;
}

describe('ADR 0754 — concurrent protocol creates', () => {
  it('two creates of ONE pageId: exactly one wins, the other is 409, and the stored page is the winner\'s', async () => {
    const results = await Promise.allSettled([create('race-id', 'race-a', 'First'), create('race-id', 'race-b', 'Second')]);
    expect(results.map(status).sort()).toEqual([409, 'ok'].sort());
    const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ title: string; slug: string }>).value;
    const stored = (await listPages(TENANT, TENANT)).filter((p) => p.pageId === 'race-id');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.title, 'the loser must not have overwritten the winner').toBe(winner.title);
    expect(stored[0]!.slug).toBe(winner.slug);
  });

  it('two creates of ONE slug: never two pages on it, never a renamed slug', async () => {
    const results = await Promise.allSettled([create('slug-x', 'shared-slug', 'X'), create('slug-y', 'shared-slug', 'Y')]);
    for (const r of results) expect([409, 'ok']).toContain(status(r));
    const all = await listPages(TENANT, TENANT);
    expect(all.filter((p) => p.slug === 'shared-slug').length).toBeLessThanOrEqual(1);
    expect(all.filter((p) => /^shared-slug-\d+$/.test(p.slug)), 'no silent rename').toHaveLength(0);
    // A loser that withdrew left nothing behind.
    const ids = all.filter((p) => p.pageId === 'slug-x' || p.pageId === 'slug-y');
    expect(ids.length).toBe(results.filter((r) => r.status === 'fulfilled').length);
  });

  it('CONTROL: a lone create succeeds', async () => {
    await expect(create('alone', 'alone-slug', 'Alone')).resolves.toMatchObject({ pageId: 'alone', slug: 'alone-slug' });
  });
});
