/**
 * Manual model-evaluation transport (ADR 0853 P3 / ADR 0855 P2-P3) — TST-DAD-6.
 *
 * `requestEvalText` feeds the team-ledger eval gates (decision suggester, drift
 * check). A transport failure must ABORT the evaluation with a typed
 * `EvalInfrastructureError`, never reach the verdict parser as a model answer
 * (a 401/429 error body scored as a "negative verdict" would fail or pass a gate
 * on infrastructure noise), and its message must never carry the key, the
 * request text or the provider's response body. Malformed but SUCCESSFUL model
 * text still goes to the real verdict parser.
 *
 * Red when (sabotage-witnessed, wave 70): a non-OK status is not refused; a raw
 * network/abort error escapes unsanitised; a stalled body is reported as a
 * response fault instead of a timeout; a non-string text block is accepted; an
 * unparseable success body is returned as text.
 */
import { describe, expect, it, vi } from 'vitest';
import { EvalInfrastructureError, requestEvalText } from '../scripts/eval-anthropic-http.mjs';

const input = { apiKey: 'secret-test-key', model: 'test-model', maxTokens: 200, system: 'private-system', user: 'private-message' };
const message = (text: string): Response => Response.json({ type: 'message', content: [{ type: 'text', text }] });

describe('manual evaluation HTTP evidence', () => {
  it.each([401, 429, 503])('aborts HTTP %i before an error body can count as a negative verdict', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: input.apiKey } }, { status }));
    await expect(requestEvalText(input, { fetchImpl })).rejects.toEqual(new EvalInfrastructureError('http', status));
  });

  it('sanitizes network failures instead of printing provider/key/request details', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${input.apiKey} ${input.user}`));
    await expect(requestEvalText(input, { fetchImpl })).rejects.toEqual(new EvalInfrastructureError('network'));
  });

  it.each([null, {}, { type: 'error', content: [{ type: 'text', text: 'no' }] }, { type: 'message', content: [] }, { type: 'message', content: [{ type: 'text', text: 42 }] }])('aborts malformed response envelopes', async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    await expect(requestEvalText(input, { fetchImpl })).rejects.toEqual(new EvalInfrastructureError('response'));
  });

  it('aborts non-JSON successful responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('provider-secret-detail'));
    await expect(requestEvalText(input, { fetchImpl })).rejects.toEqual(new EvalInfrastructureError('response'));
  });

  it('bounds a hung request and sends the cancellation signal', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(input.apiKey)), { once: true });
    }));
    await expect(requestEvalText(input, { fetchImpl, timeoutMs: 5 })).rejects.toEqual(new EvalInfrastructureError('timeout'));
  });

  it('bounds a stalled response body too', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const response = message('unused');
      vi.spyOn(response, 'json').mockImplementation(async () => new Promise<unknown>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(input.user)), { once: true });
      }));
      return response;
    });
    await expect(requestEvalText(input, { fetchImpl, timeoutMs: 5 })).rejects.toEqual(new EvalInfrastructureError('timeout'));
  });

  it.each(['not valid model JSON', ''])('preserves successful malformed model text for the real verdict parser', async (text) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(message(text));
    await expect(requestEvalText(input, { fetchImpl })).resolves.toBe(text);
  });
});
