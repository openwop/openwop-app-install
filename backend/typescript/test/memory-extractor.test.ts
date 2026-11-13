/**
 * ADR 0982 D3/D4 — the extractor's closed-world parse and evidence check (pure), and its typed
 * outcomes through `llmExtractFacts` with the provider faked.
 *
 * The model's reply is untrusted text that becomes durable memory. Before ADR 0982 it was split
 * into lines and every line was a fact, so "Mock response to: …" was written as memory. Now the
 * whole reply must be the exact JSON envelope (one `facts` key, at most 10 items, each exactly
 * {fact 4..280 chars, category from the enum, evidence}), and each fact must quote one of the
 * person's own turns: 8+ characters, two words, no negator in the quote or its sentence, and two
 * shared content words (one for a one-word fact; a 4-letter floor on prefix matches) (MAE2CD-1).
 *
 * Each refusal is asserted by its exact validator message, so a different check cannot stand in
 * for the one a leg names. Sabotages that red a case here (wave 106 probes w106g2-px-*, -ev-*,
 * -st-*, -lx-*): the fence unwrap, the one-key rule, the item-key rule, the category enum, both
 * edges of the fact length and of the 10-item cap, the 8-character floor, the two-word rule, the
 * quote negator, the sentence negator, the one-turn rule, the shared-word count, the 4-letter
 * prefix floor, `shared > 0`, the newest-first budget walk, the untrusted fence, the evidence
 * filter, the one repair and its error text, the invalid-output failure, a provider error read
 * as `[]`, and both deadline checks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../src/providers/dispatch.js';
import type { HeadlessDispatch } from '../src/host/headlessAi.js';

const provider = vi.hoisted(() => {
  const state: { replies: Array<string | Error>; calls: Array<readonly ChatMessage[]>; onCall: (() => void) | null } = { replies: [], calls: [], onCall: null };
  return state;
});
vi.mock('../src/host/headlessAi.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/headlessAi.js')>()),
  resolveHeadlessAi: async (): Promise<HeadlessDispatch> => async (msgs) => {
    provider.calls.push(msgs);
    provider.onCall?.();
    const next = provider.replies.shift() ?? '{"facts":[]}';
    if (next instanceof Error) throw next;
    return next;
  },
}));

const { parseFactEnvelope, evidenceSupports, selectUserTurns, llmExtractFacts } =
  await import('../src/features/memory-auto-extract/memoryExtractor.js');

/** The user-role text of one recorded provider call. */
function userText(call: readonly ChatMessage[] | undefined): string {
  const content = call?.find((m) => m.role === 'user')?.content;
  return typeof content === 'string' ? content : '';
}

const item = (fact: string): string => JSON.stringify({ fact, category: 'other', evidence: 'I keep bees' });

beforeEach(() => { provider.replies = []; provider.calls = []; provider.onCall = null; });

describe('parseFactEnvelope — closed world', () => {
  it('accepts exactly the envelope, unwrapping a ```json fence', () => {
    const r = parseFactEnvelope('```json\n{"facts":[{"fact":"Keeps bees","category":"other","evidence":"I keep bees"}]}\n```');
    expect(r).toEqual({ ok: true, items: [{ fact: 'Keeps bees', category: 'other', evidence: 'I keep bees' }] });
    expect(parseFactEnvelope('{"facts":[]}')).toEqual({ ok: true, items: [] });
  });

  it('accepts the edges: a 4- and a 280-character fact, and exactly ten facts', () => {
    const long = 'y'.repeat(280);
    const facts = ['Bees', long, ...Array.from({ length: 8 }, (_, i) => `Fact number ${i}`)];
    const r = parseFactEnvelope(`{"facts":[${facts.map(item).join(',')}]}`);
    expect(r).toEqual({ ok: true, items: facts.map((fact) => ({ fact, category: 'other', evidence: 'I keep bees' })) });
  });

  it('refuses prose, line-per-fact output and the old NONE sentinel', () => {
    for (const raw of ['Mock response to: You extract DURABLE facts', '- Prefers dark mode\n- Works at Acme', 'NONE', '']) {
      expect(parseFactEnvelope(raw), raw).toEqual({ ok: false, error: 'The reply was not valid JSON.' });
    }
  });

  it('refuses unknown keys at either level, wrong types, bad categories and out-of-range lengths', () => {
    const lengthError = 'facts[0].fact must be a string of 4-280 characters.';
    const bad: Array<[string, string]> = [
      ['{"facts":[],"note":"x"}', 'The object must have exactly one key, "facts".'],
      ['{"facts":[{"fact":"Keeps bees","category":"other","evidence":"I keep bees","confidence":1}]}', 'facts[0] must have exactly the keys fact, category, evidence.'],
      ['{"facts":[{"fact":"Keeps bees","category":"health","evidence":"I keep bees"}]}', 'facts[0].category must be one of preference, role, location, goal, ownership, relationship, other.'],
      ['{"facts":[{"fact":"abc","category":"other","evidence":"I keep bees"}]}', lengthError],
      [`{"facts":[${item('y'.repeat(281))}]}`, lengthError],
      ['{"facts":"Keeps bees"}', '"facts" must be an array.'],
      [`{"facts":[${Array.from({ length: 11 }, () => item('Keeps bees')).join(',')}]}`, '"facts" may hold at most 10 items.'],
    ];
    for (const [raw, error] of bad) expect(parseFactEnvelope(raw), raw.slice(0, 60)).toEqual({ ok: false, error });
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
    // The fact shares two words with the spliced quote, so only the one-turn rule refuses it.
    expect(evidenceSupports('Works at Acme on my roof', 'my roof I work as', turns)).toBe(false);
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
    // Only the QUOTE negator rule refuses this: the sentence spells it "cannot", which the
    // word-bounded negator list does not match (grade-code TST-KZB-1), while the quote starts
    // at "not".
    expect(evidenceSupports('Can swim well', 'not swim well', ['I cannot swim well'])).toBe(false);
    // Only `shared > 0` refuses this: a fact with no content word at all.
    expect(evidenceSupports('Is so', 'I keep bees', ['I keep bees'])).toBe(false);
    // …while the same quote from an affirmative sentence passes (anti-rot).
    expect(evidenceSupports('Lives in Paris', 'live in Paris', ['I live in Paris now. I never liked Lyon'])).toBe(true);
  });

  it('refuses a real quote that says nothing about the fact', () => {
    expect(evidenceSupports('Lives in Paris', 'I keep bees on my roof', turns)).toBe(false);
  });
});

describe('selectUserTurns', () => {
  it('keeps the NEWEST turns within the budget, neutralized', () => {
    // Asymmetric: the oldest and newest big turns differ, so an oldest-first walk shows.
    const oldest = 'a'.repeat(5000);
    const newest = 'b'.repeat(5000);
    expect(selectUserTurns([oldest, 'second   turn', newest])).toEqual(['second turn', newest]);
  });
});

describe('llmExtractFacts — typed outcomes', () => {
  it('fences the person\'s turns and keeps only evidenced facts', async () => {
    provider.replies = ['{"facts":[{"fact":"Keeps bees","category":"other","evidence":"I keep bees"},{"fact":"Lives in Paris","category":"location","evidence":"I keep bees"}]}'];
    const r = await llmExtractFacts('t', ['I keep bees']);
    expect(r).toEqual({ status: 'ok', facts: [{ fact: 'Keeps bees', category: 'other' }], rejected: 1 });
    expect(provider.calls).toHaveLength(1);
    expect(userText(provider.calls[0])).toMatch(/BEGIN UNTRUSTED CONTENT[\s\S]*I keep bees[\s\S]*END UNTRUSTED CONTENT/);
  });

  it('repairs ONCE with the validator error, then succeeds', async () => {
    provider.replies = ['Keeps bees', '{"facts":[]}'];
    expect(await llmExtractFacts('t', ['I keep bees'])).toEqual({ status: 'ok', facts: [], rejected: 0 });
    expect(provider.calls).toHaveLength(2);
    const repair = userText(provider.calls[1]);
    expect(repair).toContain('Your previous reply was rejected: The reply was not valid JSON.');
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
    expect(provider.calls).toHaveLength(1);
  });

  it('an aborted deadline is abandoned, and no repair starts', async () => {
    // Aborted before the first call: no call at all.
    const before = new AbortController();
    provider.replies = ['nope'];
    const p = llmExtractFacts('t', ['I keep bees'], { signal: before.signal });
    before.abort();
    expect(await p).toEqual({ status: 'abandoned' });
    expect(provider.calls).toHaveLength(0);

    // Aborted DURING the first call, whose reply is invalid: the repair never starts.
    provider.calls = [];
    const during = new AbortController();
    provider.replies = ['nope'];
    provider.onCall = () => during.abort();
    expect(await llmExtractFacts('t', ['I keep bees'], { signal: during.signal })).toEqual({ status: 'abandoned' });
    expect(provider.calls).toHaveLength(1);
  });

  it('a provider error after the deadline is abandoned, not provider-error', async () => {
    const ac = new AbortController();
    provider.replies = [new Error('The operation was aborted')];
    provider.onCall = () => ac.abort();
    expect(await llmExtractFacts('t', ['I keep bees'], { signal: ac.signal })).toEqual({ status: 'abandoned' });
    expect(provider.calls).toHaveLength(1);
  });
});
