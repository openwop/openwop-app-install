/** ADR 0904 P6/P7: both operator APIs (Document AI pages, Vertex ranking queries)
 * reserve their existing daily counters before dispatch. Independent SQLite
 * connections witness last-slot contention (both counter reads are FORCED to land
 * before either CAS, and exactly one call is made), lost commit acknowledgements,
 * unsuccessful paid attempts that keep their slot, the replay refusal, and the
 * unreadable-counter and anonymous-tenant refusals.
 * Sabotage-witnessed per lane (w74): a blind put for the CAS, a lost ack read as success,
 * the cap compare removed, a refund on an HTTP failure or on a thrown/malformed answer,
 * the replay refusal removed, and the anonymous-tenant check removed. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage, type Storage } from '../src/storage/index.js';
import { parseWithDocumentAi } from '../src/features/kb/parsers/documentAi.js';
import { vertexRerank } from '../src/features/kb/vertexReranker.js';

let a: Storage; let b: Storage;
beforeEach(async () => {
  const url = `sqlite://${join(mkdtempSync(join(tmpdir(), 'kb-operator-cap-')), 'primary.db')}`;
  a = await openStorage(url); b = await openStorage(url); initHostExtPersistence(a);
});
afterEach(async () => { initHostExtPersistence(a); await b.close(); await a.close(); });
const bind = (target: Storage, prop: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, prop);
  return typeof value === 'function' ? value.bind(target) : value;
};
const metadata = { accessToken: async () => 'fixture-token', metadataText: async () => 'fixture-project', invalidate: () => {} };
type Fetch = (url: string, init: { body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const date = '2026-01-03';
const lanes = [
  {
    name: 'Document AI', namespace: 'kb:docaiusage', field: 'pages',
    answer: { document: { documentLayout: { blocks: [{ pageSpan: { pageStart: 1 }, textBlock: { text: 'Parsed fixture.' } }] } } },
    async invoke(tenant: string, fetchImpl: Fetch) {
      const out = await parseWithDocumentAi(tenant, Buffer.from('fixture'), 'application/pdf', 1, {
        env: { OPENWOP_KB_DOCAI_PROCESSOR: 'projects/p/locations/us/processors/fixture', OPENWOP_KB_DOCAI_PAGES_PER_DAY: '1' },
        metadata, fetchImpl, now: () => new Date(`${date}T12:00:00Z`),
      });
      return out.kind === 'parsed';
    },
  },
  {
    name: 'Vertex ranking', namespace: 'kb:vertexrerankusage', field: 'queries',
    answer: { records: [{ id: 'a', score: 0.8 }] },
    async invoke(tenant: string, fetchImpl: Fetch) {
      return await vertexRerank(tenant, 'fixture query', [{ id: 'a', text: 'fixture document' }], 1, {
        env: { OPENWOP_KB_VERTEX_RERANK: '1', OPENWOP_KB_VERTEX_RERANK_DAILY_CAP: '1' },
        metadata, fetchImpl, now: () => new Date(`${date}T12:00:00Z`),
      }) !== null;
    },
  },
];

for (const lane of lanes) describe(lane.name, () => {
  const counterKey = (tenant: string) => `hostext:${lane.namespace}:${tenant}:${date}`;
  it('two independent writers authorize only one call for the last daily slot', async () => {
    let reads = 0; let writes = 0; let calls = 0;
    // Force the race: the first counter read is held (after it has read) until the second
    // writer's read arrives, so both read the empty counter before either CAS (2 s fallback).
    let arrivals = 0; let firstParked = false; let releasedWithBoth = false;
    let release: () => void = () => {};
    const parked = new Promise<void>(r => { release = r; });
    const fallback = setTimeout(() => release(), 2000);
    initHostExtPersistence(new Proxy(a, { get(target, prop) {
      if (prop === 'kvGet') return async (...args: Parameters<Storage['kvGet']>) => {
        const value = await (reads++ % 2 ? a : b).kvGet(...args);
        if (args[0] === counterKey('last-slot')) {
          arrivals += 1;
          if (arrivals === 1) { firstParked = true; await parked; firstParked = false; }
          else if (arrivals === 2) { releasedWithBoth = firstParked; release(); }
        }
        return value;
      };
      if (prop === 'kvCompareAndSwap') return (...args: Parameters<Storage['kvCompareAndSwap']>) => (writes++ % 2 ? a : b).kvCompareAndSwap(...args);
      return bind(target, prop);
    } }));
    const fetchImpl: Fetch = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify(lane.answer) }; };
    const outcomes = await Promise.all([lane.invoke('last-slot', fetchImpl), lane.invoke('last-slot', fetchImpl)]);
    clearTimeout(fallback);
    expect(releasedWithBoth, 'both writers read the counter before either CAS').toBe(true);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(calls).toBe(1);
    const row = await b.kvGet(counterKey('last-slot')); if (!row) throw new Error('missing durable reservation');
    expect(JSON.parse(row)[lane.field]).toBe(1);
  });

  it('a lost commit acknowledgement refuses dispatch and preserves the slot across restart', async () => {
    let lost = false; let calls = 0;
    initHostExtPersistence(new Proxy(a, { get(target, prop) {
      if (prop === 'kvCompareAndSwap') return async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
        const result = await a.kvCompareAndSwap(...args);
        if (!lost && args[0] === counterKey('lost-ack') && result.swapped) { lost = true; throw new Error('lost acknowledgement'); }
        return result;
      };
      return bind(target, prop);
    } }));
    const fetchImpl: Fetch = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify(lane.answer) }; };
    expect(await lane.invoke('lost-ack', fetchImpl)).toBe(false); expect(lost).toBe(true);
    initHostExtPersistence(b);
    expect(await lane.invoke('lost-ack', fetchImpl)).toBe(false); expect(calls).toBe(0);
    const row = await b.kvGet(counterKey('lost-ack')); if (!row) throw new Error('missing committed reservation');
    expect(JSON.parse(row)[lane.field]).toBe(1);
  });

  it.each(['http', 'timeout', 'malformed'] as const)('a %s failure retains attempted spend and prevents another call', async failure => {
    let calls = 0;
    const fetchImpl: Fetch = async () => {
      calls++;
      if (failure === 'timeout') throw new Error('uncertain provider timeout');
      return { ok: failure !== 'http', status: failure === 'http' ? 503 : 200, text: async () => failure === 'malformed' ? '{' : '{}' };
    };
    expect(await lane.invoke('failed', fetchImpl)).toBe(false);
    initHostExtPersistence(b);
    expect(await lane.invoke('failed', fetchImpl)).toBe(false); expect(calls).toBe(1);
  });

  it('an unclassified replay cannot reserve or spend through the provider', async () => {
    let calls = 0;
    const fetchImpl: Fetch = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify(lane.answer) }; };
    const accepted = await runWithEffectContext({ runId: 'replay-fixture', nodeId: 'unclassified-read', tenantId: 'replay', replaying: true }, () => lane.invoke('replay', fetchImpl));
    expect(accepted).toBe(false); expect(calls).toBe(0);
    expect(await b.kvGet(counterKey('replay'))).toBeNull();
  });

  it('an unreadable counter and an anonymous tenant cannot dispatch', async () => {
    initHostExtPersistence(new Proxy(a, { get(target, prop) {
      if (prop === 'kvGet') return async () => { throw new Error('unreadable counter'); };
      return bind(target, prop);
    } }));
    let calls = 0;
    const fetchImpl: Fetch = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify(lane.answer) }; };
    expect(await lane.invoke('unreadable', fetchImpl)).toBe(false);
    initHostExtPersistence(b);
    expect(await lane.invoke('anon:fixture', fetchImpl)).toBe(false); expect(calls).toBe(0);
  });
});
