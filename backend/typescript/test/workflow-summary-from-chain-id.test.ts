/**
 * The picker-templates ADR (extends ADR 0163) — the workflow summary names the
 * chain template a workflow was instantiated from (`fromChainId`).
 *
 * Why it exists: the chat `/` picker offers chain templates beside the caller's
 * owned workflows. `from-chain` mints a fresh workflow on every call (ADR 0163
 * R2), so without a chain-of-origin on the summary the picker cannot tell that
 * the caller already holds a copy, and every pick would mint a duplicate.
 *
 * Pins three things: an instantiated chain's summary carries `fromChainId`; a
 * hand-made workflow's summary does not; and an ordinary save of the copy (the
 * builder autosave lane, which sends no `fromChainId`) does not erase it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server;
let PORT: number;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const url = (p: string) => `http://127.0.0.1:${PORT}/host/openwop-app${p}`;

async function cookie(): Promise<string> {
  const r = await fetch(url('/workflows'));
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

interface SummaryRow { workflowId: string; fromChainId?: string }

async function summaries(c: string): Promise<Map<string, SummaryRow>> {
  const r = await fetch(url('/workflows'), { headers: { cookie: c } });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { workflows: SummaryRow[] };
  return new Map(body.workflows.map((w) => [w.workflowId, w]));
}

async function instantiate(c: string): Promise<string> {
  const r = await fetch(url('/workflows/from-chain'), {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
    body: JSON.stringify({ chainId: 'market-intel.digest', params: { topic: 'AI ops tooling' } }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { workflowId: string }).workflowId;
}

describe('workflow summary fromChainId (the picker-templates ADR)', () => {
  it('an instantiated chain carries fromChainId; a hand-made workflow does not', async () => {
    const c = await cookie();
    const copyId = await instantiate(c);

    const handMadeId = `wf.blank.${randomBytes(8).toString('hex')}`;
    const created = await fetch(url('/workflows'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({
        workflowId: handMadeId,
        metadata: { name: 'Hand made' },
        nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hold' } }],
        edges: [],
      }),
    });
    expect(created.status).toBe(201);

    const rows = await summaries(c);
    expect(rows.get(copyId)?.fromChainId).toBe('market-intel.digest');
    const handMade = rows.get(handMadeId);
    expect(handMade, 'the hand-made workflow is listed').toBeTruthy();
    expect(handMade).not.toHaveProperty('fromChainId');
  });

  it('an ordinary save of the copy keeps fromChainId (sticky, like authoredVia)', async () => {
    const c = await cookie();
    const copyId = await instantiate(c);
    const def = (await (await fetch(`http://127.0.0.1:${PORT}/workflows/${copyId}`, { headers: { cookie: c } })).json()) as Record<string, unknown>;
    // The builder autosave lane: the definition comes back with no fromChainId of its own.
    const saved = await fetch(url('/workflows'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ ...def, metadata: { ...((def.metadata as Record<string, unknown> | undefined) ?? {}), name: 'Renamed copy' } }),
    });
    expect(saved.status).toBeLessThan(300);
    expect((await summaries(c)).get(copyId)?.fromChainId).toBe('market-intel.digest');
  });
});
