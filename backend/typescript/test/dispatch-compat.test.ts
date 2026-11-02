/**
 * `compat` provider dispatch — RFC 0108 (self-hosted / OpenAI-compatible
 * provider class) + ADR 0121. Covers the two guards the managed providers
 * don't have: the SSRF egress check on the operator-supplied base URL, and the
 * §D `self-hosted-endpoint-no-disclosure` scrubbing (the endpoint location must
 * never appear in an error). Exercised through the public `dispatchChat`.
 *
 * TST-CVG-18. Every guard error is asserted by its EXACT message, so an error
 * that echoes the endpoint (`compat_insecure_endpoint: http://…`) is red, not a
 * substring match. Red when: the SSRF host check or the https check is dropped
 * or echoes the URL, the missing / invalid base-URL guards are dropped or echo,
 * or a transport failure is rethrown unscrubbed. Fixture hosts are RFC 6761
 * `.invalid` so a sabotaged guard can never reach a real domain. The transport-
 * scrub case overlaps `compat-endpoints.test.ts` "§D end-to-end" (that one goes
 * through a configured endpoint); both are kept (dedupe-needs-human-ask row
 * TST-CVG-18a).
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
    const err = await dispatchChat({ ...base, baseUrl: 'http://compat-endpoint.invalid/v1' }).then(() => null, (e) => e as Error);
    expect(err?.message).toBe('compat_insecure_endpoint'); // exact: §D, no URL echoed
  });

  it('rejects a missing or invalid base URL', async () => {
    const missing = await dispatchChat({ ...base, baseUrl: undefined }).then(() => null, (e) => e as Error);
    expect(missing?.message).toBe('compat_no_base_url');
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const invalid = await dispatchChat({ ...base, baseUrl: 'not a url' }).then(() => null, (e) => e as Error);
    expect(invalid?.message).toBe('compat_invalid_base_url'); // exact: §D, the raw value is never echoed
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
