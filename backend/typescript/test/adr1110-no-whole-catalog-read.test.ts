/**
 * ADR 1110 P3 — the whole-catalog read is gone and stays gone.
 *
 * A catalog can hold 500,000 products per org, so nothing on a request path may read it
 * whole. Pins:
 *  - `listProducts` (the old whole-catalog read) does not exist;
 *  - nothing lists `commerce.product` rows through the kernel's whole-type reads
 *    (`products.listForTenant`, `listSystemEntities`/`listLiveEntities` of the type);
 *  - every file that walks the whole catalog (`iterateCatalog` / `collectCatalog`) is a
 *    job or a seeder named below with its reason. A new caller fails here until it is
 *    classified, which is the moment to ask whether it runs inside a request.
 *
 * Sabotage, each restored, each red: an exported `listProducts` brought back; a
 * `products.listForTenant(` call in commerceService; an unlisted `iterateCatalog` caller.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));

/** Every file allowed to walk the whole catalog, and why it is not a request path. */
const WHOLE_CATALOG_WALKERS: Record<string, string> = {
  'features/commerce/commerceService.ts': 'defines iterateCatalog / collectCatalog',
  'features/campaign-connectors/catalogFeed.ts': 'the ad-platform feed: streamed by batch to the feed fetcher, walked by an operator push',
  'features/discovery/productEmbeddingIndex.ts': 'the embedding rebuild: inside a request only for catalogs of SYNC_REBUILD_MAX or fewer, else the background refresh',
  'features/commerce/ucp/referenceUcpMerchant.ts': 'reference merchant seed (its own fixture catalog)',
  'host/commerceShowcaseSeed.ts': 'demo seed, keeps only its own actor’s rows',
  'host/demoCommerceDepthSeed.ts': 'demo seed, keeps only its own actor’s rows',
  'host/demoContentMarketingSeed.ts': 'demo seed, keeps only its own actor’s rows',
  'host/demoMerchandisingSeed.ts': 'demo seed, keeps only its own actor’s rows',
};

describe('ADR 1110 P3 — no whole-catalog read', () => {
  it('listProducts is gone', () => {
    const hits = files.filter((f) => /export\s+(async\s+)?function\s+listProducts\s*\(/.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual([]);
    expect(files.filter((f) => /\blistProducts\s*\(/.test(f.text)).map((f) => f.rel)).toEqual([]);
  });

  it('nothing reads commerce.product through a whole-type kernel read', () => {
    const svc = files.find((f) => f.rel === 'features/commerce/commerceService.ts');
    expect(svc).toBeDefined();
    expect(svc?.text).not.toMatch(/\bproducts\.listForTenant\s*\(/);
    const typeReads = files.filter((f) => /\b(listSystemEntities|listLiveEntities)\s*\([^)]*(commerce\.product|COMMERCE_PRODUCT_TYPE)/.test(f.text)).map((f) => f.rel);
    expect(typeReads).toEqual([]);
  });

  it('every whole-catalog walker is a classified job or seeder', () => {
    const walkers = files.filter((f) => /\b(iterateCatalog|collectCatalog)\s*\(/.test(f.text)).map((f) => f.rel).sort();
    expect(walkers.length).toBeGreaterThan(3); // the census is not vacuous
    expect(walkers.filter((w) => !WHOLE_CATALOG_WALKERS[w])).toEqual([]);
    expect(Object.keys(WHOLE_CATALOG_WALKERS).filter((k) => !walkers.includes(k))).toEqual([]);
  });
});
