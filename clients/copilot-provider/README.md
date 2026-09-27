# @openwop/copilot-provider — ADR 0757

The GitHub Copilot **sidecar** for RFC 0121 `subscription` dispatch. A
loopback-only, OpenAI-compatible **SSE** endpoint that runs each chat turn through
GitHub's official [`@github/copilot-sdk`](https://github.com/github/copilot-sdk)
under the **calling user's own** GitHub OAuth token.

GitHub sanctions this pattern: an OAuth App "enables your application to make
Copilot API requests on behalf of users who authorize your app" — for "SaaS
applications building on top of Copilot" and "any multi-user application"
([docs](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)).

## How it fits

```
backend ctx turn ──(subscription:github.copilot)──► dispatchChat('copilot')
   │  refuses any non-loopback base URL; the token is sent ONLY here
   ▼
http://127.0.0.1:8791/v1/chat/completions   ◄── this sidecar (Authorization: Bearer <user token>)
   ▼
@github/copilot-sdk  →  Copilot runtime (bundled)  →  GitHub Copilot
```

The backend never imports the SDK and never calls Copilot over HTTP itself
(RFC 0121 gap G2: an official-client harness only). A drift guard
(`backend/typescript/test/rfc0121-subscription-mechanism-guard.test.ts`) pins it.

## Run

```bash
cd clients/copilot-provider
npm ci
node src/bin.js            # → http://127.0.0.1:8791 ; set OPENWOP_COPILOT_ENDPOINT=http://127.0.0.1:8791/v1
```

On Cloud Run, deploy it as a **sidecar container** in the backend's service
(containers in one instance share `localhost`); see `Dockerfile`.

## Security

- Binds **127.0.0.1 only**.
- Multi-user lock-down: `mode: "empty"`, `availableTools: []` (deny-wins), every
  permission request rejected, no config discovery / custom instructions / MCP,
  a private runtime home and a fresh empty working directory per turn, the
  system message **appended** (never `replace`, which strips the SDK guardrails).
- The token rides only the per-session `gitHubToken`; it is never logged or
  echoed, and runtime error text is scrubbed of anything credential-shaped.
- Accepts `gho_` / `ghu_` / `github_pat_` tokens; classic `ghp_` is refused (the
  SDK does not support it).

## Tests

`node --test` — a fake SDK client; no runtime, no network, no real token.
