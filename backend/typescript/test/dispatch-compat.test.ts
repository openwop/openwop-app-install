/**
 * `compat` provider dispatch — RFC 0108 (self-hosted / OpenAI-compatible
 * provider class) + ADR 0121. Covers the two guards the managed providers
 * don't have: the SSRF egress check on the operator-supplied base URL, and the
 * §D `self-hosted-endpoint-no-disclosure` scrubbing (the endpoint location must
 * never appear in an error). Exercised through the public `dispatchChat`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { dispatchChat } from '../src/providers/dispatch.js';

/** Minimal OpenAI-compatible SSE chat server for the happy path. */
function mockCompatServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

const base = {
  provider: 'compat' as const,
  model: 'llama3',
  apiKey: 'k',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('dispatchChat compat provider (RFC 0108 / ADR 0121)', () => {
  const prev = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = prev;
  });

  it('rejects a private/denied host when private egress is OFF, without leaking the URL (SSRF + §D)', async () => {
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    const err = await dispatchChat({ ...base, baseUrl: 'https://10.0.0.5/v1' }).then(() => null, (e) => e as Error);
    expect(err?.message).toBe('compat_endpoint_blocked');
    expect(err?.message).not.toContain('10.0.0.5'); // §D: the host must not appear in the error
  });

  it('rejects http when private egress is OFF (https required)', async () => {
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    await expect(dispatchChat({ ...base, baseUrl: 'http://example.com/v1' })).rejects.toThrow('compat_insecure_endpoint');
  });

  it('rejects a missing or invalid base URL', async () => {
    await expect(dispatchChat({ ...base, baseUrl: undefined })).rejects.toThrow('compat_no_base_url');
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    await expect(dispatchChat({ ...base, baseUrl: 'not a url' })).rejects.toThrow('compat_invalid_base_url');
  });

  it('dispatches against a reachable compat endpoint (happy path, private egress allowed)', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const { server, baseUrl } = await mockCompatServer();
    try {
      const out = await dispatchChat({ ...base, baseUrl });
      expect(out.provider).toBe('compat');
      expect(out.completion).toBe('hello world');
      expect(out.usage?.outputTokens).toBe(2);
    } finally {
      server.close();
    }
  });

  it('§D: a transport failure is scrubbed to a generic error (no endpoint URL/host)', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const baseUrl = 'http://127.0.0.1:1/v1'; // closed port → connection refused
    const err = await dispatchChat({ ...base, baseUrl }).then(() => null, (e) => e as Error);
    expect(err?.message).toBe('compat_transport_error');
    expect(err?.message).not.toContain('127.0.0.1');
  });
});
