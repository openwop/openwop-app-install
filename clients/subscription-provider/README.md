# @openwop/subscription-provider — ADR 0182 Phases 2–4

A loopback OpenAI-compatible endpoint that drives the user's **own
logged-in** Codex CLI. It is the self-hosted executor that makes
RFC 0121 `subscription` auth work **without** any provider-private-API code: the
subscription token never leaves the vendor CLI — the shim only shells out to
`codex exec` under the login the CLI already holds.

> **ADR 0756 (2026-09-26): the Claude Code harness is removed.** Anthropic's
> terms prohibit third-party developers routing requests through Free, Pro or
> Max plan credentials on behalf of their users; the `/v1/messages` → `claude -p`
> route and the Claude login detection are gone, and the backend refuses to
> advertise, store or dispatch an `anthropic` (or `google`) subscription.

## Run

```bash
cd clients/subscription-provider
node src/bin.js            # or: npm start  (add --port <n>)
# → listening on http://127.0.0.1:8790
```

Then point a **self-hosted** OpenWOP backend at it:

```bash
OPENWOP_SUBSCRIPTION_ENDPOINT=http://127.0.0.1:8790 \
OPENWOP_SUBSCRIPTION_AT_OWN_RISK=true \
OPENWOP_SUBSCRIPTION_PROVIDERS=openai \
OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN=true \
  ...start the backend...
```

The backend's `subscription`-mode dispatch (ADR 0180/0121) then flows:
`ctx.callAI` → this loopback shim → the vendor CLI (your login) → the provider.
`OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN` (ADR 0182 Phase 1) makes the backend
advertise `subscription` only when a login is actually detected.

## Endpoints

| Method + path | Maps to | Wire shape out |
|---|---|---|
| `POST /v1/chat/completions` | `codex exec` (provider `openai`) | OpenAI Chat Completion |
| `GET /healthz` | — | `{ ok: true }` |

## Security

- **Binds `127.0.0.1` only** — never `0.0.0.0`. It drives a subscription CLI, so
  network exposure would be a credential-proxy hole.
- Optional shared token: set `OPENWOP_SUBSCRIPTION_SHIM_TOKEN` and the shim
  requires `Authorization: Bearer <token>` (defense-in-depth on loopback).
- Reads **no** token material — `src/detect.js` checks login *presence* only.

## Honesty / ToS

This ships **mechanism only** — no reverse-engineered provider API. Reusing a
personal subscription for API-shaped automation may violate the provider's terms
and risk account suspension; that is the **user's at-own-risk** decision, gated
by the backend's off-by-default ADR 0180 flags. See ADR 0182 for the full
posture.

## Streaming

v1 is **turn-atomic** (non-streaming); `stream: true` still returns a single
complete response. Streaming is an ADR 0182 open question.

## Tests

`npm test` (`node --test`) — 21 assertions: file-only detection fixtures, the
`claude -p` / `codex exec` wire mapping (mocked CLI, no real subscription), the
loopback bind, the auth-error → `subscription_login_required` mapping, and the
shared-token gate. Not imported by `backend/` or `frontend/`; not in `scripts/ci.sh`.
