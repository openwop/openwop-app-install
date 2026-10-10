/**
 * ADR 0351 Phase 4 / CSG-KB-8 — the EXTERNAL (connection) reranker.
 *
 * End-to-end against a mock Cohere /v2/rerank (loopback under
 * OPENWOP_WEBHOOK_ALLOW_PRIVATE, the ads-adapter test pattern):
 *   1. honest-off — `rerank:{kind:'connection'}` is 422-rejected while no
 *      `cohere-rerank` connection exists (the knob is never dishonest);
 *   2. with a connection, the config persists and a `hybrid+rerank` search
 *      reranks THROUGH the vendor (order follows the vendor's ranking, the
 *      broker injects the Bearer key, the secret never leaks into the result);
 *   3. a vendor failure degrades HONESTLY to the local deterministic reranker,
 *      labeled `applied:'local-degraded'` — search never fails on a reranker.
 *
 * Each case owns its tenant + collection (independent, any order). Sabotage
 * (wave-6 /grade-tests): drop the connection pre-check ⇒ honest-off red; drop the
 * topN clamp ⇒ the vendor sees top_n 3 ⇒ red; ignore the vendor result ⇒ red.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { createCollection, ingestDocument, setRetrievalConfig, searchDetailed } from '../src/features/kb/kbService.js';
import { OpenwopError } from '../src/types.js';

const ORG = 'org-rrk';
let tn = 0;

describe('KB external (connection) reranker — CSG-KB-8', () => {
  let mock: http.Server;
  let hits: Array<{ auth?: string; body: Record<string, unknown> }> = [];
  let respond: (body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  const prevAllowPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;

  /** A fresh tenant + collection per case, so every case runs alone and in any order. */
  async function corpus(opts: { connection: boolean }): Promise<{ tenantId: string; collectionId: string }> {
    const tenantId = `trr-${tn++}`;
    if (opts.connection) await createSecretConnection({ tenantId, provider: 'cohere-rerank', kind: 'api_key', secret: 'RRK-SECRET', scope: 'workspace' });
    const col = await createCollection(tenantId, ORG, 'tester', { name: 'Rerank corpus' });
    await ingestDocument(tenantId, ORG, 'tester', col.collectionId, { title: 'Alpha', text: 'alpha document about migration runbooks and rollout plans' });
    await ingestDocument(tenantId, ORG, 'tester', col.collectionId, { title: 'Beta', text: 'beta document about migration checklists and rollout notes' });
    await ingestDocument(tenantId, ORG, 'tester', col.collectionId, { title: 'Gamma', text: 'gamma document about unrelated weather chatter' });
    return { tenantId, collectionId: col.collectionId };
  }

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    await createApp({ port: 18993, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __resetConnectionsStore();

    mock = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        hits.push({ auth: req.headers.authorization, body });
        const out = respond(body);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_KB_RERANK_ENDPOINT = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v2/rerank`;
  });
  afterAll(async () => {
    delete process.env.OPENWOP_KB_RERANK_ENDPOINT;
    // The SSRF loopback allowance must not outlive this file in its vitest worker.
    if (prevAllowPrivate === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = prevAllowPrivate;
    await new Promise<void>((r) => mock.close(() => r()));
  });
  beforeEach(() => { hits = []; respond = () => ({ status: 200, body: {} }); });

  it('honest-off: rejects rerank:{kind:connection} with 422 while no cohere-rerank connection exists', async () => {
    const { tenantId, collectionId } = await corpus({ connection: false });
    const err = await setRetrievalConfig(tenantId, ORG, collectionId, 'tester', { mode: 'hybrid+rerank', rerank: { kind: 'connection' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect((err as OpenwopError).httpStatus).toBe(422);
    expect(String((err as Error).message)).toContain('cohere-rerank');
  });

  it('rejects a per-collection connectionId pin (broker-selected only)', async () => {
    const { tenantId, collectionId } = await corpus({ connection: true });
    const err = await setRetrievalConfig(tenantId, ORG, collectionId, 'tester', { rerank: { kind: 'connection', connectionId: 'conn:x' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(String((err as Error).message)).toContain('connectionId');
  });

  it('reranks through the vendor: order follows the vendor ranking, Bearer injected, labeled', async () => {
    const { tenantId, collectionId } = await corpus({ connection: true });
    const col = await setRetrievalConfig(tenantId, ORG, collectionId, 'tester', { mode: 'hybrid+rerank', rerank: { kind: 'connection', topN: 2 } });
    expect(col.retrievalConfig?.rerank).toEqual({ kind: 'connection', topN: 2 });

    // The vendor ranks the LAST document first — an order the local scorers
    // would never produce for this query, so vendor application is observable.
    respond = (body) => {
      const docs = body.documents as string[];
      return { status: 200, body: { results: [{ index: docs.length - 1, relevance_score: 0.99 }, { index: 0, relevance_score: 0.42 }] } };
    };
    const out = await searchDetailed(tenantId, ORG, collectionId, 'migration rollout', 3, 'hybrid+rerank');
    expect(out.rerank).toEqual({ requested: 'connection', applied: 'connection' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.body.top_n, 'the configured topN reached the vendor').toBe(2);
    expect(out.hits.length).toBe(2);
    const sent = hits[0]!.body.documents as string[];
    expect(out.hits[0]!.text, 'the vendor-promoted candidate leads').toBe(sent[sent.length - 1]);
    expect(out.hits[0]!.score).toBeCloseTo(0.99, 5);
    expect(hits[0]!.auth).toBe('Bearer RRK-SECRET');
    expect(hits[0]!.body.query).toBe('migration rollout');
    expect(JSON.stringify(out)).not.toContain('RRK-SECRET');
  });

  it('degrades honestly to local when the vendor fails, labeled local-degraded', async () => {
    const { tenantId, collectionId } = await corpus({ connection: true });
    await setRetrievalConfig(tenantId, ORG, collectionId, 'tester', { mode: 'hybrid+rerank', rerank: { kind: 'connection' } });
    respond = () => ({ status: 500, body: { message: 'rerank down' } });
    const out = await searchDetailed(tenantId, ORG, collectionId, 'migration rollout', 3, 'hybrid+rerank');
    expect(hits.length, 'the vendor was tried before the degrade').toBe(1);
    expect(out.rerank).toEqual({ requested: 'connection', applied: 'local-degraded' });
    expect(out.hits.length).toBeGreaterThan(0); // local rerank still served
  });

  it('local rerank stays the default and is labeled', async () => {
    const { tenantId, collectionId } = await corpus({ connection: true });
    await setRetrievalConfig(tenantId, ORG, collectionId, 'tester', { rerank: { kind: 'local' } });
    const out = await searchDetailed(tenantId, ORG, collectionId, 'migration rollout', 3, 'hybrid+rerank');
    expect(out.rerank).toEqual({ requested: 'local', applied: 'local' });
    expect(hits.length).toBe(0); // zero vendor calls
  });
});
