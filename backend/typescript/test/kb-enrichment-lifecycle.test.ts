/** ADR 0904 P4: late model responses cannot restore erased source, and cache
 * identities cannot mix providers, titles, orgs or document incarnations.
 * Real SQLite CAS pins persistence behavior across independent connections. */
import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage, type Storage } from '../src/storage/index.js';
import { createCollection, ingestDocument, deleteDocument, deleteCollection, eraseSubjectKb, getDocument, listDocuments, chunkText, type KnowledgeDocument } from '../src/features/kb/kbService.js';
import { prefixesFor, cachedPrefixesForCollection, type LlmEnricher } from '../src/features/kb/contextualEnrichment.js';

let a: Storage; let b: Storage;
const cap = process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
const docs = new DurableCollection<KnowledgeDocument>('kb:document', d => `${d.tenantId}:${d.orgId}:${d.documentId}`);
const key = (d: KnowledgeDocument) => `${d.tenantId}:${d.orgId}:${d.documentId}`;
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-prefix-life-'));
  initInMemorySurfaces({ dataDir: dir });
  const url = `sqlite://${join(dir, 'primary.db')}`;
  a = await openStorage(url); b = await openStorage(url); initHostExtPersistence(a);
  delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
});
afterEach(async () => {
  initHostExtPersistence(a); await b.close(); await a.close();
  if (cap === undefined) delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
  else process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = cap;
});
async function fixture(org = 'o', documentId = 'same-id') {
  const col = await createCollection('tenant', org, 'owner', { name: 'Manuals' });
  const projected = await ingestDocument('tenant', org, 'author', col.collectionId, { title: 'Meals', text: 'The meal allowance is forty five euros.' }, { documentId });
  const doc = await docs.get(`tenant:${org}:${documentId}`);
  if (!doc) throw new Error('missing fixture document');
  return { col: col.collectionId, doc, projected };
}
const enricher = (prefix: string, provider = 'provider-a'): LlmEnricher => ({ provider, model: 'shared-name', dispatch: async () => prefix });
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(r => { resolve = r; });
  return { promise, resolve };
}
const bind = (target: Storage, prop: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, prop);
  return typeof value === 'function' ? value.bind(target) : value;
};

it.each(['document', 'collection', 'subject'] as const)('a paused provider cannot republish after %s erasure', async kind => {
  const { col, doc } = await fixture('o', kind === 'subject' ? 'profile:author' : 'same-id');
  const answer = deferred(); const started = deferred();
  const pending = prefixesFor('tenant', col, doc, chunkText(doc.text), {
    ...enricher('unused'), dispatch: async () => { started.resolve('started'); return answer.promise; },
  });
  await started.promise;
  if (kind === 'document') await deleteDocument('tenant', 'o', col, doc.documentId);
  else if (kind === 'collection') await deleteCollection('tenant', 'o', col);
  else await eraseSubjectKb('tenant', 'author');
  answer.resolve('Private contextual prefix.');
  expect(await pending).toMatchObject({ complete: false, prefixes: [null], calls: 1 });
  initHostExtPersistence(b);
  expect(await docs.get(key(doc))).toBeNull();
  expect(await b.kvList('hostext:kb:enrichcache:')).toEqual([]);
});

it('deletion between the primary read and cache CAS does not recreate the source row', async () => {
  const { col, doc } = await fixture(); let injected = false;
  initHostExtPersistence(new Proxy(a, { get(target, prop) {
    if (prop === 'kvCompareAndSwap') return async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      if (!injected && args[0].includes('kb:document:') && args[2]?.includes('enrichmentCache')) {
        injected = true; await b.kvDelete(args[0]);
      }
      return a.kvCompareAndSwap(...args);
    };
    return bind(target, prop);
  } }));
  expect(await prefixesFor('tenant', col, doc, chunkText(doc.text), enricher('Private prefix.'))).toMatchObject({ complete: false, prefixes: [null] });
  expect(injected).toBe(true);
  initHostExtPersistence(b); expect(await docs.get(key(doc))).toBeNull();
});

it('an identical-id, identical-body replacement has a distinct cache incarnation', async () => {
  const { col, doc } = await fixture();
  const answer = deferred(); const started = deferred();
  const pending = prefixesFor('tenant', col, doc, chunkText(doc.text), {
    ...enricher('unused'), dispatch: async () => { started.resolve('started'); return answer.promise; },
  });
  await started.promise;
  await docs.put({ ...doc, enrichmentGeneration: 'new-incarnation' });
  answer.resolve('Old incarnation prefix.');
  expect(await pending).toMatchObject({ complete: false, prefixes: [null] });
  expect(await docs.get(key(doc))).toMatchObject({ enrichmentGeneration: 'new-incarnation' });
  expect((await docs.get(key(doc)))?.enrichmentCache).toBeUndefined();
});

it('a lost cache acknowledgement reconciles the immutable winner across restart', async () => {
  const { col, doc } = await fixture(); let lost = false;
  initHostExtPersistence(new Proxy(a, { get(target, prop) {
    if (prop === 'kvCompareAndSwap') return async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      const result = await a.kvCompareAndSwap(...args);
      if (!lost && args[0].includes('kb:document:') && args[2]?.includes('enrichmentCache') && result.swapped) {
        lost = true; throw new Error('lost acknowledgement');
      }
      return result;
    };
    return bind(target, prop);
  } }));
  expect(await prefixesFor('tenant', col, doc, chunkText(doc.text), enricher('First winner.'))).toMatchObject({ complete: true, prefixes: ['First winner.'] });
  expect(lost).toBe(true); initHostExtPersistence(b);
  const fresh = await docs.get(key(doc)); if (!fresh) throw new Error('missing winner');
  expect(await prefixesFor('tenant', col, fresh, chunkText(doc.text), {
    ...enricher('unused'), dispatch: async () => { throw new Error('cache hit must not dispatch'); },
  })).toMatchObject({ complete: true, calls: 0, prefixes: ['First winner.'] });
});

it('provider identity and title changes miss cache, while colliding org document ids remain isolated', async () => {
  const { col, doc } = await fixture(); const other = await fixture('other-org');
  await prefixesFor('tenant', col, doc, chunkText(doc.text), enricher('Provider A prefix.'));
  let fresh = await docs.get(key(doc)); if (!fresh) throw new Error('missing source');
  const result = await prefixesFor('tenant', col, fresh, chunkText(doc.text), enricher('Provider B prefix.', 'provider-b'));
  expect(result).toMatchObject({ calls: 1, prefixes: ['Provider B prefix.'] });
  fresh = await docs.get(key(doc)); if (!fresh) throw new Error('missing source');
  expect((await cachedPrefixesForCollection('tenant', 'o', col, [fresh], enricher('', 'provider-a'))).size).toBe(0);
  expect((await cachedPrefixesForCollection('tenant', 'other-org', other.col, [fresh], enricher('', 'provider-b'))).size).toBe(0);
  expect((await docs.get(key(other.doc)))?.enrichmentCache).toBeUndefined();
  await docs.put({ ...fresh, title: 'Renamed meals' });
  const renamed = await docs.get(key(doc)); if (!renamed) throw new Error('missing renamed source');
  expect(await prefixesFor('tenant', col, renamed, chunkText(doc.text), enricher('New title prefix.', 'provider-b'))).toMatchObject({ calls: 1, prefixes: ['New title prefix.'] });
});

it('public document projections omit cache text and its internal incarnation', async () => {
  const { col, doc, projected } = await fixture();
  await prefixesFor('tenant', col, doc, chunkText(doc.text), enricher('Internal prefix.'));
  const publicRows = [projected, await getDocument('tenant', 'o', col, doc.documentId), ...(await listDocuments('tenant', 'o', col))];
  for (const row of publicRows) {
    expect(row).not.toBeNull(); expect(row).not.toHaveProperty('enrichmentGeneration'); expect(row).not.toHaveProperty('enrichmentCache');
  }
  expect((await docs.get(key(doc)))?.enrichmentCache?.[0]?.prefix).toBe('Internal prefix.');
});
