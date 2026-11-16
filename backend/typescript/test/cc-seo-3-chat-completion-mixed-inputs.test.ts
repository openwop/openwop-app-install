/**
 * CC-SEO-3 — `core.ai.chatCompletion` after a port-less edge from web search sent
 * only `engine: "exa"` to the model: `toMessages` picked the FIRST string-valued
 * field as the whole user turn and dropped `results`. On prod (bff8b2dfd5, run
 * f59ea44d) the SEO brief was saved as a refusal ("no search results came
 * through, only the word exa"). A lone string is still sent bare; mixed outputs
 * are serialized whole, so the results reach the model.
 *
 * Red before the fix: the user turn was exactly "exa".
 */
import { describe, expect, it } from 'vitest';
import { chatCompletion } from '../../../packs/core.openwop.ai/index.mjs';

type Msg = { role: string; content: string };

async function userTurn(inputs: Record<string, unknown>): Promise<string> {
  let seen: Msg[] = [];
  await chatCompletion({
    inputs,
    config: { systemPrompt: 'Write a brief from the search results.' },
    callAI: async (req: { messages: Msg[] }) => { seen = req.messages; return { content: 'ok', finishReason: 'stop' }; },
  } as never);
  return seen.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
}

describe('CC-SEO-3 — chatCompletion never drops upstream fields after a port-less edge', () => {
  it('web search output: query, engine AND results all reach the model', async () => {
    const turn = await userTurn({
      query: 'sustainable office furniture for small design studios',
      engine: 'exa',
      results: [{ url: 'https://recess.com.au/products/the-studio-set', rank: 1, title: 'The Studio Set' }],
    });
    expect(turn).not.toBe('exa');
    expect(turn).toContain('recess.com.au/products/the-studio-set');
    expect(turn).toContain('sustainable office furniture');
  });

  it('a lone string field is still sent bare (no JSON wrapping)', async () => {
    expect(await userTurn({ summary: 'Three findings about invoicing.' })).toBe('Three findings about invoicing.');
  });

  it('a named port still wins over other fields', async () => {
    expect(await userTurn({ prompt: 'Use this prompt.', results: [{ url: 'https://x.test' }] })).toBe('Use this prompt.');
  });
});
