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
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { createCollection, ingestDocument, setRetrievalConfig, searchDetailed } from '../src/features/kb/kbService.js';
import { OpenwopError } from '../src/types.js';

const T = 'trr';
const ORG = 'org-rrk';

describe('KB external (connection) reranker — CSG-KB-8', () => {
  let mock: http.Server;
  let hits: Array<{ auth?: string; body: Record<string, unknown> }> = [];
  let respond: (body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  let collectionId = '';

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

    const col = await createCollection(T, ORG, 'tester', { name: 'Rerank corpus' });
    collectionId = col.collectionId;
    await ingestDocument(T, ORG, 'tester', collectionId, { title: 'Alpha', text: 'alpha document about migration runbooks and rollout plans' });
    await ingestDocument(T, ORG, 'tester', collectionId, { title: 'Beta', text: 'beta document about migration checklists and rollout notes' });
    await ingestDocument(T, ORG, 'tester', collectionId, { title: 'Gamma', text: 'gamma document about unrelated weather chatter' });
  });
  afterAll(async () => {
    delete process.env.OPENWOP_KB_RERANK_ENDPOINT;
    await new Promise<void>((r) => mock.close(() => r()));
  });

  it('honest-off: rejects rerank:{kind:connection} with 422 while no cohere-rerank connection exists', async () => {
    const err = await setRetrievalConfig(T, ORG, collectionId, 'tester', { mode: 'hybrid+rerank', rerank: { kind: 'connection' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect((err as OpenwopError).httpStatus).toBe(422);
    expect(String((err as Error).message)).toContain('cohere-rerank');
  });

  it('rejects a per-collection connectionId pin (broker-selected only)', async () => {
    await createSecretConnection({ tenantId: T, provider: 'cohere-rerank', kind: 'api_key', secret: 'RRK-SECRET', scope: 'workspace' });
    const err = await setRetrievalConfig(T, ORG, collectionId, 'tester', { rerank: { kind: 'connection', connectionId: 'conn:x' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(String((err as Error).message)).toContain('connectionId');
  });

  it('reranks through the vendor: order follows the vendor ranking, Bearer injected, labeled', async () => {
    const col = await setRetrievalConfig(T, ORG, collectionId, 'tester', { mode: 'hybrid+rerank', rerank: { kind: 'connection', topN: 2 } });
    expect(col.retrievalConfig?.rerank).toEqual({ kind: 'connection', topN: 2 });

    // The vendor ranks the LAST document first — an order the local scorers
    // would never produce for this query, so vendor application is observable.
    respond = (body) => {
      const docs = body.documents as string[];
      return { status: 200, body: { results: [{ index: docs.length - 1, relevance_score: 0.99 }, { index: 0, relevance_score: 0.42 }] } };
    };
    hits = [];
    const out = await searchDetailed(T, ORG, collectionId, 'migration rollout', 3, 'hybrid+rerank');
    expect(out.rerank).toEqual({ requested: 'connection', applied: 'connection' });
    expect(out.hits.length).toBe(2); // topN capped the cut
    expect(out.hits[0]!.score).toBeCloseTo(0.99, 5);
    expect(hits.length).toBe(1);
    expect(hits[0]!.auth).toBe('Bearer RRK-SECRET');
    expect(hits[0]!.body.query).toBe('migration rollout');
    expect(JSON.stringify(out)).not.toContain('RRK-SECRET');
  });

  it('degrades honestly to local when the vendor fails, labeled local-degraded', async () => {
    respond = () => ({ status: 500, body: { message: 'rerank down' } });
    const out = await searchDetailed(T, ORG, collectionId, 'migration rollout', 3, 'hybrid+rerank');
    expect(out.rerank).toEqual({ requested: 'connection', applied: 'local-degraded' });
    expect(out.hits.length).toBeGreaterThan(0); // local rerank still served
  });

  it('local rerank stays the default and is labeled', async () => {
    await setRetrievalConfig(T, ORG, collectionId, 'tester', { rerank: { kind: 'local' } });
    hits = [];
    const out = await searchDetailed(T, ORG, collectionId, 'migration rollout', 3, 'hybrid+rerank');
    expect(out.rerank).toEqual({ requested: 'local', applied: 'local' });
    expect(hits.length).toBe(0); // zero vendor calls
  });
});
