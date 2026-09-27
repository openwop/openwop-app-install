// ADR 0182 — the loopback OpenAI-compatible endpoint (ADR 0756: Codex only).
//
// SECURITY (architect ruling): binds 127.0.0.1 ONLY. It drives a subscription
// CLI, so exposing it on the network would be a credential-proxy hole. The
// inbound Authorization header is NOT required (the vendor CLI owns auth); an
// optional shared token (OPENWOP_SUBSCRIPTION_SHIM_TOKEN) adds defense-in-depth
// so only the co-located backend that knows it can drive the shim.
//
// Streaming: v1 is turn-atomic (non-streaming) — see ADR 0182 OQ "streaming
// fidelity". Requests with stream:true still get a single, complete response.

import { createServer } from 'node:http';
import { runCodex, CliError } from './cliRunner.js';

const LOOPBACK = '127.0.0.1';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Map assistant text to an OpenAI Chat Completion response shape. */
function openaiResponse(text, model) {
  return {
    id: `chatcmpl_shim_${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'codex',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Build the request handler. `deps` injects the CLI runners for testing.
 * `token` (optional) is a shared secret required on inbound requests.
 */
export function createHandler({ runCodexFn = runCodex, token = null } = {}) {
  return async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true });
      if (token) {
        const auth = req.headers['authorization'] || '';
        if (auth !== `Bearer ${token}`) return json(res, 401, { error: { type: 'unauthorized', message: 'shim token required' } });
      }
      if (req.method !== 'POST') return json(res, 405, { error: { type: 'method_not_allowed', message: 'POST only' } });

      const raw = await readBody(req);
      let body;
      try { body = raw ? JSON.parse(raw) : {}; }
      catch { return json(res, 400, { error: { type: 'invalid_request', message: 'body must be JSON' } }); }
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return json(res, 400, { error: { type: 'invalid_request', message: '`messages` (non-empty array) required' } });
      }

      // ADR 0756 — the `/v1/messages` → `claude -p` route is REMOVED: Anthropic's
      // terms prohibit routing requests through Claude consumer-plan credentials
      // on behalf of an application's users. Only the Codex route remains.
      if (req.url === '/v1/chat/completions') {
        const text = await runCodexFn({ messages, model: body.model }, undefined);
        return json(res, 200, openaiResponse(text, body.model));
      }
      return json(res, 404, { error: { type: 'not_found', message: 'unknown endpoint; use /v1/chat/completions' } });
    } catch (err) {
      if (err instanceof CliError) {
        // Surface an auth failure distinctly so the operator knows to re-login.
        const status = err.isAuth ? 401 : 502;
        return json(res, status, {
          error: { type: err.isAuth ? 'subscription_login_required' : 'harness_error', message: err.message, harness: err.harness },
        });
      }
      return json(res, 500, { error: { type: 'internal_error', message: 'shim failure' } });
    }
  };
}

/** Start the loopback server. Resolves { server, port }. */
export function startServer({ port = 8790, ...opts } = {}) {
  const server = createServer(createHandler(opts));
  return new Promise((resolve) => {
    // Bind LOOPBACK ONLY — never 0.0.0.0 (architect security ruling).
    server.listen(port, LOOPBACK, () => resolve({ server, port: server.address().port }));
  });
}
