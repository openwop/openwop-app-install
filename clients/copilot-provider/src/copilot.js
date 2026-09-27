// ADR 0757 — run one chat turn through GitHub's official Copilot SDK under the
// CALLING USER's own OAuth token (the RFC 0121 cleared provider).
//
// GitHub sanctions exactly this pattern: "Use an OAuth GitHub App to authenticate
// users through your application and pass their credentials to the SDK … This
// enables your application to make Copilot API requests on behalf of users who
// authorize your app" (docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate).
//
// SECURITY (architect ruling, ADR 0757 §Sidecar). The Copilot runtime is a
// coding AGENT with shell/file/web tools by default. This is a multi-user
// server, so every session is locked to plain chat:
//   - the client runs in `mode: "empty"` (multi-user server mode), which makes the
//     SDK REQUIRE an explicit `availableTools` per session and flips tool
//     filtering to deny-wins — `availableTools: []` means no tool is reachable;
//   - every permission request is rejected;
//   - no config discovery, no custom instructions, no MCP servers, no session
//     store; a private `baseDirectory` for the runtime and a fresh empty working
//     directory per session;
//   - the system message is APPENDED, never `replace` (replace strips the SDK's
//     own guardrails);
//   - `useLoggedInUser: false` — the runtime never falls back to an ambient login.
//
// The token is handed to the SDK only as the per-session `gitHubToken` and is
// never logged, echoed, or written anywhere by this module.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Reject every tool/permission request — this sidecar serves plain chat only. */
export const rejectAll = () => ({ kind: 'reject', feedback: 'Tools are disabled for this chat-only integration.' });

/** Flatten OpenAI-style `messages[]` into a system text + a prompt transcript. */
export function flattenMessages(messages) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
        : '';
    if (m?.role === 'system') system.push(text);
    else turns.push(`${m?.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
  }
  return { system: system.join('\n').trim(), prompt: turns.join('\n\n').trim() };
}

/** The model id the chat tile binds when the user has not chosen one. */
export const DEFAULT_MODEL = 'default';

/** The per-session config. Exported so a test pins every lock-down field. */
export function sessionConfig({ token, model, system, workingDirectory }) {
  return {
    // `default` (the chat tile's binding) means "let Copilot pick the user's
    // default model" — the model set differs by plan, so the app never guesses ids.
    ...(model && model !== DEFAULT_MODEL ? { model } : {}),
    // The SESSION-level token: "different sessions can have different GitHub
    // identities … the session-level token determines the identity used for
    // content exclusion, model routing, and quota checks" (SDK SessionConfig
    // docs). Verified against the real runtime 2026-09-26: a fake token reaches
    // GitHub and is refused `401 Bad credentials`. The experimental
    // `gitHubTokenProvider` was tried first and never delivered a token
    // ("No GitHub OAuth token or Copilot HMAC key provided").
    gitHubToken: token,
    ...(system ? { systemMessage: { mode: 'append', content: system } } : {}),
    availableTools: [],
    onPermissionRequest: rejectAll,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    workingDirectory,
    streaming: true,
  };
}

export class CopilotTurnError extends Error {
  constructor(message, { isAuth = false } = {}) {
    super(message);
    this.isAuth = isAuth;
  }
}

/**
 * Build a `runTurn({ token, model, messages, onDelta })` backed by ONE shared
 * Copilot client (one runtime process) and one session per turn. `ClientCtor` is
 * injected so tests exercise the mapping and the lock-down without the runtime.
 */
export function createCopilotRunner({ ClientCtor, baseDirectory, timeoutMs = 120_000 } = {}) {
  if (!ClientCtor) throw new Error('createCopilotRunner requires a ClientCtor');
  let clientPromise = null;
  const runtimeHome = baseDirectory ?? mkdtempSync(join(tmpdir(), 'openwop-copilot-home-'));

  async function client() {
    if (!clientPromise) {
      const c = new ClientCtor({ mode: 'empty', useLoggedInUser: false, baseDirectory: runtimeHome, logLevel: 'error' });
      clientPromise = c.start().then(() => c, (err) => { clientPromise = null; throw err; });
    }
    return clientPromise;
  }

  return async function runTurn({ token, model, messages, onDelta }) {
    const { system, prompt } = flattenMessages(messages);
    if (!prompt) throw new CopilotTurnError('empty prompt');
    const c = await client();
    const workingDirectory = mkdtempSync(join(tmpdir(), 'openwop-copilot-turn-'));
    let session;
    try {
      session = await c.createSession(sessionConfig({ token, model, system, workingDirectory }));
      let streamed = '';
      const off = session.on('assistant.message_delta', (event) => {
        const delta = event?.data?.deltaContent;
        if (typeof delta === 'string' && delta.length > 0) {
          streamed += delta;
          onDelta?.(delta);
        }
      });
      try {
        const final = await session.sendAndWait({ prompt }, timeoutMs);
        const content = typeof final?.data?.content === 'string' ? final.data.content : '';
        // If the runtime did not stream, surface the whole answer as one delta.
        if (!streamed && content) onDelta?.(content);
        return streamed || content;
      } finally {
        if (typeof off === 'function') off();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Never echo the token: a runtime error message is passed through only after
      // scrubbing anything that looks like a GitHub credential.
      const scrubbed = msg.replace(/\b(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED]');
      throw new CopilotTurnError(scrubbed, { isAuth: /unauthori[sz]ed|401|bad credentials|authentication|not entitled|no copilot|subscription/i.test(msg) });
    } finally {
      if (session) await session.disconnect().catch(() => {});
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  };
}
