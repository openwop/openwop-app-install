/**
 * RFC 0113 — Memory injection budget. The memory read honors `tokenBudget`
 * (unit = content chars; same `budgetByChars` primitive as ADR 0148 A4): the
 * highest-priority (recency) entries are kept within budget, over-budget entries
 * are OMITTED WHOLE (never truncated), and ≥1 is always kept. Advert declares
 * `memory.injectionBudget: { supported: true, tokenCounter: "chars" }`.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { writeMemoryEntry, listMemoryEntries, clearMemoryScope, MEMORY_DEMO_REF } from '../src/host/inMemorySurfaces.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const TENANT = 'default'; // wildcard api-key principal resolves here

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jsonGet<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as T };
}

/** Seed N recency-ordered rows of a fixed content size into the demo ref. */
function seed(sizes: number[]): void {
  clearMemoryScope(TENANT, MEMORY_DEMO_REF);
  // Oldest first so the LAST seeded is newest; explicit createdAt pins order.
  sizes.forEach((size, i) => {
    writeMemoryEntry(TENANT, MEMORY_DEMO_REF, {
      content: 'x'.repeat(size),
      tags: ['rfc0113'],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  });
}

describe('RFC 0113 — injectionBudget advert', () => {
  it('declares memory.injectionBudget with an honest tokenCounter unit', async () => {
    const d = (await jsonGet('/.well-known/openwop')).body as { capabilities: { memory?: { injectionBudget?: { supported?: boolean; tokenCounter?: string } } } };
    const ib = d.capabilities.memory?.injectionBudget;
    expect(ib?.supported).toBe(true);
    expect(ib?.tokenCounter).toBe('chars'); // this host counts chars, not BPE tokens
  });
});

describe('RFC 0113 — listMemoryEntries tokenBudget (unit)', () => {
  it('keeps the newest entries within budget and OMITS the over-budget one whole', () => {
    seed([100, 100, 100]); // 3 rows, newest last
    const all = listMemoryEntries(TENANT, MEMORY_DEMO_REF);
    expect(all.length).toBe(3); // recency: newest first
    // budget 250 → newest two (100+100=200) fit; the third (would be 300) is dropped whole.
    const budgeted = listMemoryEntries(TENANT, MEMORY_DEMO_REF, { tokenBudget: 250 });
    expect(budgeted.length).toBe(2);
    expect(budgeted.every((r) => r.content.length === 100)).toBe(true); // not truncated
  });

  it('always keeps ≥1 entry even when the first alone exceeds the budget', () => {
    seed([500]);
    const budgeted = listMemoryEntries(TENANT, MEMORY_DEMO_REF, { tokenBudget: 10 });
    expect(budgeted.length).toBe(1);
    expect(budgeted[0]!.content.length).toBe(500); // whole, never truncated
  });

  it('no budget ⇒ unchanged full list', () => {
    seed([10, 20, 30]);
    expect(listMemoryEntries(TENANT, MEMORY_DEMO_REF).length).toBe(3);
  });
});

describe('RFC 0113 — GET /v1/host/openwop-app/memory?tokenBudget', () => {
  it('applies the budget over the wire (recency-ranked, whole entries)', async () => {
    seed([100, 100, 100]);
    const full = await jsonGet('/v1/host/openwop-app/memory');
    expect((full.body.entries as unknown[]).length).toBe(3);
    const budgeted = await jsonGet('/v1/host/openwop-app/memory?tokenBudget=250');
    expect(budgeted.status).toBe(200);
    expect((budgeted.body.entries as Array<{ content: string }>).length).toBe(2);
    expect((budgeted.body.entries as Array<{ content: string }>).every((e) => e.content.length === 100)).toBe(true);
  });

  it('rank=recency is accepted; an unknown rank falls back to recency (graceful)', async () => {
    seed([10, 20]);
    const r1 = await jsonGet('/v1/host/openwop-app/memory?rank=recency');
    expect(r1.status).toBe(200);
    const r2 = await jsonGet('/v1/host/openwop-app/memory?rank=relevance'); // not offered → recency
    expect(r2.status).toBe(200);
    expect((r2.body.entries as unknown[]).length).toBe(2);
  });
});
