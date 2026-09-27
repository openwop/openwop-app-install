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
import { budgetByChars } from '../src/host/memoryBudget.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const TENANT = 'default'; // wildcard api-key principal resolves here

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jsonGet<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as T };
}

/** Seed N recency-ordered rows of a fixed content size into the demo ref. */
async function seed(sizes: number[]): Promise<void> {
  await clearMemoryScope(TENANT, MEMORY_DEMO_REF);
  // Oldest first so the LAST seeded is newest; explicit createdAt pins order.
  for (const [i, size] of sizes.entries()) {
    await writeMemoryEntry(TENANT, MEMORY_DEMO_REF, {
      content: 'x'.repeat(size),
      tags: ['rfc0113'],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  }
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
  it('keeps the newest entries within budget and OMITS the over-budget one whole', async () => {
    await seed([100, 100, 100]); // 3 rows, newest last
    const all = await listMemoryEntries(TENANT, MEMORY_DEMO_REF);
    expect(all.length).toBe(3); // recency: newest first
    // budget 250 → newest two (100+100=200) fit; the third (would be 300) is dropped whole.
    const budgeted = await listMemoryEntries(TENANT, MEMORY_DEMO_REF, { tokenBudget: 250 });
    expect(budgeted.length).toBe(2);
    expect(budgeted.every((r) => r.content.length === 100)).toBe(true); // not truncated
  });

  /**
   * CORRECTED BY H49 — this case previously asserted the OPPOSITE, that the
   * read "always keeps ≥1 entry even when the first alone exceeds the budget".
   *
   * That assertion was written from the `budgetByChars` primitive's contract
   * (ADR 0148 A4, a SOFT budget that must never starve a turn of context)
   * rather than from RFC 0113, and so it pinned a live over-claim in place: the
   * host advertises `memory.injectionBudget.supported: true`, and RFC 0113
   * clause 1 says *"A single entry exceeding the budget on its own MUST be
   * omitted (not truncated mid-entry)."* With the old behaviour,
   * `GET …/memory?tokenBudget=10` returned 500 chars. A test derived from the
   * implementation agrees with the bug for as long as the bug exists.
   *
   * The primitive keeps its soft default for knowledge retrieval; the memory
   * read now passes `keepAtLeastOne: false`. An EMPTY slice is the conformant
   * answer here.
   */
  it('OMITS a lone over-budget entry whole — an empty result is the conformant answer (RFC 0113 clause 1)', async () => {
    await seed([500]);
    const budgeted = await listMemoryEntries(TENANT, MEMORY_DEMO_REF, { tokenBudget: 10 });
    expect(budgeted.length, 'a 500-char entry MUST NOT be returned against a 10-char budget').toBe(0);
    // Non-vacuity: the entry IS there, it is the BUDGET that excluded it.
    expect((await listMemoryEntries(TENANT, MEMORY_DEMO_REF)).length).toBe(1);
    // And a budget it DOES fit under returns it whole, never truncated.
    const fits = await listMemoryEntries(TENANT, MEMORY_DEMO_REF, { tokenBudget: 500 });
    expect(fits.length).toBe(1);
    expect(fits[0]!.content.length).toBe(500);
  });

  it('the ADR 0148 soft-budget default is UNCHANGED for every other caller', async () => {
    // The knowledge-retrieval call site (`agentKnowledgeComposition.ts`) relies
    // on the soft policy; H49 must not have changed it as a side effect.
    const items = [{ content: 'y'.repeat(500) }, { content: 'z'.repeat(10) }];
    const soft = budgetByChars(items, 10, (i) => i.content.length);
    expect(soft.length, 'the default policy still keeps the first item').toBe(1);
    const hard = budgetByChars(items, 10, (i) => i.content.length, { keepAtLeastOne: false });
    expect(hard.length, 'the opt-in hard policy drops it').toBe(0);
  });

  it('no budget ⇒ unchanged full list', async () => {
    await seed([10, 20, 30]);
    expect((await listMemoryEntries(TENANT, MEMORY_DEMO_REF)).length).toBe(3);
  });
});

describe('RFC 0113 — GET /v1/host/openwop-app/memory?tokenBudget', () => {
  it('applies the budget over the wire (recency-ranked, whole entries)', async () => {
    await seed([100, 100, 100]);
    const full = await jsonGet('/v1/host/openwop-app/memory');
    expect((full.body.entries as unknown[]).length).toBe(3);
    const budgeted = await jsonGet('/v1/host/openwop-app/memory?tokenBudget=250');
    expect(budgeted.status).toBe(200);
    expect((budgeted.body.entries as Array<{ content: string }>).length).toBe(2);
    expect((budgeted.body.entries as Array<{ content: string }>).every((e) => e.content.length === 100)).toBe(true);
  });

  it('rank=recency is accepted; an unknown rank falls back to recency (graceful)', async () => {
    await seed([10, 20]);
    const r1 = await jsonGet('/v1/host/openwop-app/memory?rank=recency');
    expect(r1.status).toBe(200);
    const r2 = await jsonGet('/v1/host/openwop-app/memory?rank=relevance'); // not offered → recency
    expect(r2.status).toBe(200);
    expect((r2.body.entries as unknown[]).length).toBe(2);
  });
});
