// ADR 0757 — the loopback OpenAI-compatible SSE endpoint for GitHub Copilot.
//
// SECURITY:
//   - Binds 127.0.0.1 ONLY. It receives a user's GitHub OAuth token on every
//     request, so it must be reachable only by the co-located backend (a Cloud
//     Run sidecar shares the backend's network namespace).
//   - `Authorization: Bearer <token>` carries the USER's token (the backend's
//     OpenAI-compatible dispatcher sends the credential there). There is no second
//     shared secret: the dispatcher cannot send one, and the loopback bind plus the
//     backend's loopback-only dispatch arm are the control.
//   - The token is never logged, echoed in a response, or included in an error.
//
// Wire: `POST /v1/chat/completions` → `text/event-stream` of OpenAI
// chat.completion.chunk objects, terminated by `data: [DONE]` — the shape the
// backend's `dispatchOpenAICompatible` parses. `GET /healthz` → `{ ok: true }`.

import { createServer } from 'node:http';
import { CopilotTurnError } from './copilot.js';

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** GitHub token prefixes the Copilot SDK accepts (classic `ghp_` is not supported). */
const ACCEPTED_TOKEN = /^(gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('payload too large')); req.destroy(); return; }
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

function chunk(id, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'copilot',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** Build the request handler. `runTurn` is injected (tests use a fake). */
export function createHandler({ runTurn }) {
  return async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true });
      if (req.method !== 'POST') return json(res, 405, { error: { type: 'method_not_allowed', message: 'POST only' } });
      if (req.url !== '/v1/chat/completions') {
        return json(res, 404, { error: { type: 'not_found', message: 'unknown endpoint; use /v1/chat/completions' } });
      }
      const auth = String(req.headers['authorization'] ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!ACCEPTED_TOKEN.test(token)) {
        return json(res, 401, { error: { type: 'copilot_login_required', message: 'a GitHub user token (gho_/ghu_/github_pat_) is required' } });
      }
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); }
      catch { return json(res, 400, { error: { type: 'invalid_request', message: 'body must be JSON' } }); }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json(res, 400, { error: { type: 'invalid_request', message: '`messages` (non-empty array) required' } });
      }
      const model = typeof body.model === 'string' && body.model && body.model !== 'unknown' ? body.model : undefined;
      const id = `chatcmpl_copilot_${Date.now().toString(36)}`;
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(chunk(id, model, { role: 'assistant' }));
      };
      try {
        await runTurn({
          token,
          model,
          messages: body.messages,
          onDelta: (delta) => { start(); res.write(chunk(id, model, { content: delta })); },
        });
      } catch (err) {
        if (!started) {
          const isAuth = err instanceof CopilotTurnError && err.isAuth;
          return json(res, isAuth ? 401 : 502, {
            error: { type: isAuth ? 'copilot_login_required' : 'copilot_error', message: err instanceof Error ? err.message : 'copilot failure' },
          });
        }
        // Mid-stream failure: close the stream with an error finish.
        res.write(chunk(id, model, {}, 'error'));
        res.end('data: [DONE]\n\n');
        return undefined;
      }
      start();
      res.write(chunk(id, model, {}, 'stop'));
      res.end('data: [DONE]\n\n');
      return undefined;
    } catch {
      if (!res.headersSent) return json(res, 500, { error: { type: 'internal_error', message: 'sidecar failure' } });
      res.end();
      return undefined;
    }
  };
}

/** Start the loopback server. Resolves { server, port }. */
export function startServer({ port = 8791, ...opts }) {
  const server = createServer(createHandler(opts));
  return new Promise((resolve) => {
    // Bind LOOPBACK ONLY — never 0.0.0.0.
    server.listen(port, LOOPBACK, () => resolve({ server, port: server.address().port }));
  });
}
