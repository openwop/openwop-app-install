/**
 * Claude Opus 5.5 / Fable 5.1 — thinking is ADAPTIVE AND ALWAYS ON, and the API
 * answers a manual `thinking: {type:"enabled", budget_tokens}` with a 400
 * ("thinking.type.enabled" is not supported for this model).
 * https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5
 *
 * The dispatcher sent exactly that shape to every `claude-*-[4-9]` model whenever
 * reasoning was requested — which the BYOK chat does by default — so selecting
 * Fable 5.1 (already in the catalog) or Opus 5.5 failed every reasoning turn.
 * These pin: the flagged models get NO `thinking` field; the older models keep the
 * manual budget; an UNFLAGGED id that refuses it is retried once without it; any
 * other 400 is still reported.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchChat } from '../src/providers/dispatch.js';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const OK_STREAM = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');
const REFUSED = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.' },
});

type Body = { model?: string; max_tokens?: number; thinking?: { type?: string; budget_tokens?: number } };

/** Capture every Anthropic request body; `answer(n)` decides the n-th response. */
function mockAnthropic(answer: (n: number, body: Body) => Response): Body[] {
  const bodies: Body[] = [];
  global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('api.anthropic.com')) {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return answer(bodies.length, body);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return bodies;
}
const ok = () => new Response(OK_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });

async function dispatch(model: string) {
  return dispatchChat({ provider: 'anthropic', model, apiKey: 'k', reasoningVerbosity: 'full', messages: [{ role: 'user', content: 'hi' }] });
}

describe('Anthropic thinking — adaptive-only models (providers.json adaptiveThinkingOnly)', () => {
  it.each(['claude-opus-5-5', 'claude-fable-5-1'])('%s: no `thinking` field, output floor still raised', async (model) => {
    const bodies = mockAnthropic(() => ok());
    const r = await dispatch(model);
    expect(r.completion).toBe('ok');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.thinking, 'a manual budget is a 400 on this model').toBeUndefined();
    expect(bodies[0]!.max_tokens, 'the model still thinks, so visible text needs the raised floor').toBe(8192);
  });

  it('an older model keeps the manual budget (non-vacuity: the flag, not a blanket removal)', async () => {
    const bodies = mockAnthropic(() => ok());
    await dispatch('claude-opus-4-8');
    expect(bodies[0]!.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
  });

  it('an UNFLAGGED id that refuses the manual shape is retried ONCE without it', async () => {
    const bodies = mockAnthropic((n) => (n === 1 ? new Response(REFUSED, { status: 400 }) : ok()));
    const r = await dispatch('claude-opus-9-custom');
    expect(r.completion).toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.thinking?.type).toBe('enabled');
    expect(bodies[1]!.thinking).toBeUndefined();
  });

  it('any OTHER 400 is reported unchanged, with no retry', async () => {
    const other = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: at least one message is required' } });
    const bodies = mockAnthropic(() => new Response(other, { status: 400 }));
    await expect(dispatch('claude-opus-9-custom')).rejects.toThrow(/anthropic_400: .*at least one message/);
    expect(bodies).toHaveLength(1);
  });
});
