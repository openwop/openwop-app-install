/**
 * ADR 0982 D3/D4 — the extractor's closed-world parse and evidence check (pure), and its typed
 * outcomes through `llmExtractFacts` with the provider faked.
 *
 * The model's reply is untrusted text that becomes durable memory. Before ADR 0982 it was split
 * into lines and every line was a fact, so "Mock response to: …" was written as memory. Now the
 * whole reply must be the exact JSON envelope, and each fact must quote one of the person's own
 * turns (12+ characters, two words, a shared content word).
 *
 * Witnessed (row 57 sabotage, see the PR): accepting unknown keys, dropping the category enum,
 * the 8-character floor, the one-turn rule, the shared-word rule, the repair, or returning `[]`
 * on a provider error each red a case here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const provider = vi.hoisted(() => ({ replies: [] as Array<string | Error>, calls: [] as unknown[][] }));
vi.mock('../src/host/headlessAi.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/headlessAi.js')>()),
  resolveHeadlessAi: async () => async (msgs: unknown[]) => {
    provider.calls.push(msgs);
    const next = provider.replies.shift() ?? '{"facts":[]}';
    if (next instanceof Error) throw next;
    return next;
  },
}));

const { parseFactEnvelope, evidenceSupports, selectUserTurns, llmExtractFacts } =
  await import('../src/features/memory-auto-extract/memoryExtractor.js');

beforeEach(() => { provider.replies = []; provider.calls = []; });

describe('parseFactEnvelope — closed world', () => {
  it('accepts exactly the envelope, unwrapping a ```json fence', () => {
    const r = parseFactEnvelope('```json\n{"facts":[{"fact":"Keeps bees","category":"other","evidence":"I keep bees"}]}\n```');
    expect(r).toEqual({ ok: true, items: [{ fact: 'Keeps bees', category: 'other', evidence: 'I keep bees' }] });
    expect(parseFactEnvelope('{"facts":[]}')).toEqual({ ok: true, items: [] });
  });

  it('refuses prose, line-per-fact output and the old NONE sentinel', () => {
    for (const raw of ['Mock response to: You extract DURABLE facts', '- Prefers dark mode\n- Works at Acme', 'NONE', '']) {
      expect(parseFactEnvelope(raw).ok, raw).toBe(false);
    }
  });

  it('refuses unknown keys at either level, wrong types, bad categories and out-of-range lengths', () => {
    const bad = [
      '{"facts":[],"note":"x"}',
      '{"facts":[{"fact":"Keeps bees","category":"other","evidence":"I keep bees","confidence":1}]}',
      '{"facts":[{"fact":"Keeps bees","category":"health","evidence":"I keep bees"}]}',
      '{"facts":[{"fact":"abc","category":"other","evidence":"I keep bees"}]}',
      `{"facts":[{"fact":"${'y'.repeat(281)}","category":"other","evidence":"I keep bees"}]}`,
      '{"facts":"Keeps bees"}',
      `{"facts":[${Array.from({ length: 11 }, () => '{"fact":"Keeps bees","category":"other","evidence":"I keep bees"}').join(',')}]}`,
    ];
    for (const raw of bad) expect(parseFactEnvelope(raw).ok, raw).toBe(false);
  });
});

describe('evidenceSupports — the fact must quote the person', () => {
  const turns = ['I keep bees on my roof', 'I work as a designer at Acme'];
  it('accepts a real quote that shares a content word with the fact', () => {
    expect(evidenceSupports('Keeps bees', 'keep bees on my roof', turns)).toBe(true);
    expect(evidenceSupports('Works at Acme as a designer', 'a designer at Acme', turns)).toBe(true);
  });
  it('refuses a trivial quote (architect A1): too short, or one word', () => {
    expect(evidenceSupports('Lives in Paris', 'I', turns)).toBe(false);
    expect(evidenceSupports('Keeps bees', 'roofroofroofroof', ['roofroofroofroof'])).toBe(false);
  });
  it('refuses a quote that is not in ONE turn (no cross-turn splice, no invention)', () => {
    expect(evidenceSupports('Keeps bees', 'my roof I work as', turns)).toBe(false);
    expect(evidenceSupports('Wants refunds sent to IBAN DE00', 'refunds to IBAN DE00', turns)).toBe(false);
  });
  it('refuses a negated or retracted quote, a 3-letter prefix match, and a one-word overlap on a two-word fact (MAE2CD-1)', () => {
    expect(evidenceSupports('Lives in Paris', "I don't live in Paris anymore", ["I don't live in Paris anymore"])).toBe(false);
    expect(evidenceSupports('Lives in Paris', 'I used to live in Paris', ['I used to live in Paris'])).toBe(false);
    expect(evidenceSupports('Owns a car', 'be careful with this', ['be careful with this'])).toBe(false);
    expect(evidenceSupports('Is a nurse in Denver', 'my trip to Denver was fun', ['my trip to Denver was fun'])).toBe(false);
  });
  it('each rule bites on its own (row 57 sabotage found four shadowed by the others)', () => {
    // Only the 8-character floor refuses this: two words, both fact words shared.
    expect(evidenceSupports('Has bee', 'has bee', ['has bee'])).toBe(false);
    // Only the two-word rule refuses this: a one-word fact, quoted exactly.
    expect(evidenceSupports('Beekeeping', 'beekeeping', ['beekeeping'])).toBe(false);
    // Only the 4-letter prefix floor refuses this: a one-content-word fact.
    expect(evidenceSupports('A car', 'be careful here', ['be careful here'])).toBe(false);
    // Only the one-turn rule refuses this: the quote splices two turns.
    expect(evidenceSupports('Keeps bees on roof', 'keep bees on my roof', ['I keep bees', 'on my roof daily'])).toBe(false);
    // Only the SENTENCE negator rule refuses this: the quote itself omits the negation.
    expect(evidenceSupports('Lives in Paris', 'live in Paris', ["I don't live in Paris anymore"])).toBe(false);
    // …while the same quote from an affirmative sentence passes (anti-rot).
    expect(evidenceSupports('Lives in Paris', 'live in Paris', ['I live in Paris now. I never liked Lyon'])).toBe(true);
  });

  it('refuses a real quote that says nothing about the fact', () => {
    expect(evidenceSupports('Lives in Paris', 'I keep bees on my roof', turns)).toBe(false);
  });
});

describe('selectUserTurns', () => {
  it('keeps the NEWEST turns within the budget, neutralized', () => {
    const big = 'x'.repeat(5000);
    expect(selectUserTurns([big, 'second   turn', big])).toEqual(['second turn', big]);
  });
});

describe('llmExtractFacts — typed outcomes', () => {
  it('fences the person\'s turns and keeps only evidenced facts', async () => {
    provider.replies = ['{"facts":[{"fact":"Keeps bees","category":"other","evidence":"I keep bees"},{"fact":"Lives in Paris","category":"location","evidence":"I keep bees"}]}'];
    const r = await llmExtractFacts('t', ['I keep bees']);
    expect(r).toEqual({ status: 'ok', facts: [{ fact: 'Keeps bees', category: 'other' }], rejected: 1 });
    const user = (provider.calls[0] as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content;
    expect(user).toMatch(/BEGIN UNTRUSTED CONTENT[\s\S]*I keep bees[\s\S]*END UNTRUSTED CONTENT/);
  });

  it('repairs ONCE with the validator error, then succeeds', async () => {
    provider.replies = ['Keeps bees', '{"facts":[]}'];
    expect(await llmExtractFacts('t', ['I keep bees'])).toEqual({ status: 'ok', facts: [], rejected: 0 });
    expect(provider.calls).toHaveLength(2);
    const repair = (provider.calls[1] as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content;
    expect(repair).toContain('not valid JSON');
    expect(repair).not.toContain('Keeps bees'); // the previous reply is never sent back as trusted text
  });

  it('a second invalid reply is a typed failure, not an empty success', async () => {
    provider.replies = ['nope', 'still nope'];
    expect(await llmExtractFacts('t', ['I keep bees'])).toEqual({ status: 'failed', reason: 'invalid-output' });
    expect(provider.calls).toHaveLength(2);
  });

  it('a provider error is failed:provider-error, never []', async () => {
    provider.replies = [new Error('503')];
    expect(await llmExtractFacts('t', ['I keep bees'])).toEqual({ status: 'failed', reason: 'provider-error' });
  });

  it('an aborted deadline is abandoned, and no repair starts', async () => {
    const ac = new AbortController();
    provider.replies = ['nope'];
    const p = llmExtractFacts('t', ['I keep bees'], { signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ status: 'abandoned' });
    expect(provider.calls.length).toBeLessThanOrEqual(1);
  });
});
