# ADR 0757 — GitHub Copilot: the RFC 0121 cleared `subscription` provider

**Status:** implemented — 2026-09-26 (code, tests, sidecar; merged #4136, `890e45f0`). OAuth App registered + client env set; **dark in production** — no sidecar deployed and the scopeless test is pending a Copilot-entitled account (§Registration).
**Depends on / extends:** ADR 0179 (the §B.8 scope rail), ADR 0180 (the at-own-risk path this is deliberately NOT), ADR 0182 (the "no vendor-CLI spawn in the backend" boundary), ADR 0756 (anthropic/google prohibited). RFC 0121 (`Active`), RFC 0067 (`authModes`), RFC 0199 (one fixed redirect URI per provider).
**Surface:** host runtime + a new loopback sidecar (`clients/copilot-provider`) + one BYOK frontend card. **NON-NORMATIVE — no new RFC**: rides RFC 0121's existing `subscription` value; no wire field, capability, event or label names the mechanism (RFC 0121 gap G2).

## Why this exists

RFC 0121 was held `Active` on UQ1: *does any provider permit a third-party host to use a user's consumer subscription?* On 2026-09-26 the steward's research found one provider whose **own documentation** sanctions exactly that, and the steward named it (the lifting of the RFC 0121 hold, for this provider only):

> GitHub Copilot SDK — authentication (<https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate>, fetched 2026-09-26): the **GitHub OAuth App** method is for "Apps acting on behalf of users via OAuth", *Copilot Subscription Required: Yes* — "This enables your application to make Copilot API requests on behalf of users who authorize your app." When to use it: "SaaS applications building on top of Copilot" and "Any multi-user application where you need to make requests on behalf of different users."

This is a citation of the provider's sanctioned-integration documentation, which RFC 0121's UQ1 criterion accepts in its own words — **not** a legal review, and this ADR does not claim one. Scope: Copilot **individual** plans (Free/Pro/Pro+); an org-paid Business/Enterprise seat works only as far as the organization's Copilot policy allows.

## Decision

Provider id **`github.copilot`** (a vendor-prefixed RFC 0067 extension id; clients MUST tolerate unknown ids).

### 1. Advertisement — its own gate, dark by default (§B.7, §B.9)
`aiProviders/copilotSubscription.ts`. Advertised **only** when both halves of the mechanism exist: the OAuth client (`OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID` / `_SECRET`) **and** a loopback sidecar (`OPENWOP_COPILOT_ENDPOINT`). When lit, `github.copilot` appears in `aiProviders.supported` (RFC 0067: `authModes` keys and `byok` ⊆ `supported`), in `byok` (§B.7), and in `authModes` as **`["subscription"]` only** — never `apiKey`. It never rides the ADR 0180 at-own-risk flags and never shows the ToS-risk consent: it is cleared, not waived. Listing it in `OPENWOP_SUBSCRIPTION_PROVIDERS` does nothing (ADR 0756 filter).

### 2. Acquisition — GitHub OAuth, least scope, principal-bound (§B.8)
`byok/copilotOAuth.ts` + routes in `routes/agents.ts`:
- `POST /host/openwop-app/subscription/github.copilot/authorize` → `{ authorizeUrl }` (registered on its ADR 0654 `/v1` twin via `vendorTwin()`, like every vendor route through the overlap). Refused unless the caller is signed in **and** has a durable personal `user:` tenant (`assertSubscriptionStorageTenant`).
- `GET …/github.copilot/callback` — the ONE fixed redirect URI (RFC 0199 rule 5), base from `callbackBaseUrl` (never the request origin in production). The URI registered with GitHub uses the **canonical** vendor root `/host/openwop-app/…` (ADR 0652), not the `/v1` twin — the twin retires with `/v1`, and a registered redirect URI that stopped resolving would silently break every future connect. A booted-app test proves the canonical path reaches the route.
- `POST …/github.copilot/disconnect` — removes the user's stored token.
- Authorization code + **PKCE S256**; **no `scope` parameter** (a scopeless user token — no repository or private-data access). `state` is single-use (the delete is the claim), expires after 10 minutes, and is bound to the initiating **principal and personal tenant**: a different principal completing the callback stores nothing (login-CSRF / grant fixation).
- The token is exchanged host-side (`guardedEgressFetch`) and stored **only** via `storeSubscriptionCredential` at the originating user's personal tenant. Never logged, never returned.
- The bind seam refuses a **pasted** Copilot token (`validation_error`): least scope is guaranteed only by our own registration, so a broad-scope PAT is impossible to bind. The empty-value §B.8 probe still answers.

### 3. Dispatch — the official SDK, in a loopback sidecar only (gap G2)
- `host/exchange/dispatchTurn.ts`: a `subscription:github.copilot` credentialRef resolves the user's token at `run.tenantId` and calls `dispatchChat({ provider: 'copilot', baseUrl: OPENWOP_COPILOT_ENDPOINT, apiKey: token })`.
- `providers/dispatch.ts` `dispatchCopilotSidecar` **refuses any non-loopback base URL** (`127.0.0.1` / `::1` / `localhost`, parsed, no userinfo). The user's GitHub token can therefore physically reach only the co-located sidecar — never an arbitrary host through a config typo (architect CRITICAL-1). The generic `compat` path was rejected for this reason: it is operator-configurable to any URL.
- `clients/copilot-provider` (the sidecar) runs each turn through **`@github/copilot-sdk@1.0.14`** — GitHub's official client, which drives the Copilot runtime. RFC 0121 gap G2 (ruled 2026-09-18) requires exactly this shape: an official-client harness; direct API calls under a borrowed session are out of scope. The **backend never imports the SDK and never calls Copilot over HTTP**; ADR 0182's "no vendor-CLI spawn in the backend" boundary holds (the runtime process lives only in the sidecar).
- Multi-user lock-down (architect CRITICAL-2 — the Copilot runtime is a coding agent with shell/file tools by default): `mode: "empty"`, `availableTools: []` (the SDK flips tool filtering to deny-wins in empty mode), every permission request **rejected**, no config discovery, no custom instructions, no MCP servers, a private runtime home, a fresh empty working directory per turn, the system message **appended** (never `replace`, which strips the SDK's guardrails), `useLoggedInUser: false`.
- The token rides the **session-level `gitHubToken`** ("different sessions can have different GitHub identities", SDK docs). **Verified against the real runtime on 2026-09-26** (SDK 1.0.14, darwin-arm64): the client starts in empty mode and answers `ping`; the locked-down session config is accepted; a fake `gho_` token reaches GitHub and is refused `401 Bad credentials`, classified as an auth failure. The experimental `gitHubTokenProvider` was tried first and **never delivered a token** ("No GitHub OAuth token or Copilot HMAC key provided") — so it is not used.
- Wire: `POST /v1/chat/completions` → `text/event-stream` chunks + `[DONE]`, the shape `dispatchOpenAICompatible` parses. Streams the SDK's `assistant.message_delta` events.

### 4. Frontend
`byok/CopilotConnectCard.tsx`, composed by `SubscriptionCredentialCard`: a cleared provider gets **Connect / Disconnect** (no paste field, no risk checkbox) and an honest note that it requests no scopes and counts toward the user's Copilot allowance; it never appears in the at-own-risk picker. 4-locale i18n. The at-own-risk intro no longer cites "Claude Pro/Max" (ADR 0756).

## The G2 drift guard — written, not just claimed

RFC 0121's G2 ruling says this host "shipped consistently … with a drift guard asserting no login code". **That guard did not exist.** ADR 0180's commit message states "A drift-guard test asserts no such code exists", but no test in that commit — or since — asserted it (checked 2026-09-26 against `f17cce965` and HEAD). This ADR writes it, `backend/typescript/test/rfc0121-subscription-mechanism-guard.test.ts`, and scopes it deliberately rather than as a blanket "no login code" (which Copilot's OAuth flow would now violate by design):

| Assertion | Pins |
|---|---|
| no provider-private consumer endpoint (claude.ai API, ChatGPT/Gemini web backends, `githubcopilot.com`, `copilot_internal`) in backend `src/`, the ADR 0182 shim, or the sidecar | no borrowed-session code anywhere on the rail |
| the backend never imports `@github/copilot-sdk`; the sidecar imports it only in `bin.js` and has no `fetch`/`https`/`undici` | Copilot is reached ONLY through the official SDK harness (G2) |
| `src/{aiProviders,byok,providers,host/exchange}` import no `child_process` | ADR 0182's no-vendor-CLI-spawn boundary |
| exactly one backend file names a GitHub OAuth endpoint (`byok/copilotOAuth.ts`), and it sets no `scope` | the single sanctioned login flow, least scope |

A vacuous walk fails (the guard asserts each tree is present and non-empty). **Sabotage (2026-09-26):** adding a direct `api.githubcopilot.com` fetch to the sidecar, a `child_process` import to `byok/`, and a second GitHub OAuth endpoint turned 4 of 7 assertions red; reverting turned all 7 green.

## Registration — what the steward does before this lights (not done by this ADR)

1. **Register a GitHub OAuth App** (github.com → Settings → Developer settings → OAuth Apps), owned by the steward's account/org. Homepage `https://app.openwop.dev`. **Authorization callback URL:** `<OPENWOP_OAUTH_CALLBACK_BASE_URL>/host/openwop-app/subscription/github.copilot/callback` — in production `https://app.openwop.dev/api/host/openwop-app/subscription/github.copilot/callback` (the canonical, version-agnostic vendor root). Leave "Enable Device Flow" off.
2. **Set secrets/env on the backend:** `OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID`, `OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET` (a secret), `OPENWOP_COPILOT_ENDPOINT=http://127.0.0.1:8791/v1`.
3. **Deploy the sidecar** (`clients/copilot-provider/Dockerfile`) as a second container in the backend's Cloud Run service (shared localhost). The runtime package for linux-x64 is in the committed lockfile.
4. **Empirical least-scope check:** connect a Copilot-entitled account and run one chat turn. If Copilot refuses the scopeless token, record the minimal scope that works here (a correction note) and add it to `beginCopilotAuthorization` — never a broad default.

> **Registration record (2026-09-26).** Step 1 is DONE: the steward registered the GitHub OAuth App under the `openwop` org — client id `Ov23liWQlBEFHmpjaYO7`, callback `https://app.openwop.dev/api/host/openwop-app/subscription/github.copilot/callback`. (Device flow was enabled at registration; this host uses the authorization-code + PKCE flow only.) Step 2 is PARTLY done: `OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID` and a Secret Manager binding for `OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET` (`openwop-copilot-oauth-client-secret`) are set on `openwop-app-backend`; `OPENWOP_COPILOT_ENDPOINT` is deliberately NOT set, so the provider stays **dark** (§B.9) until step 3.
>
> **Step 4 — scopeless: PENDING, not refuted.** A device-flow token issued with an EMPTY scope was run through `@github/copilot-sdk@1.0.14` (session `gitHubToken`, `useLoggedInUser: false`, isolated home). It was refused with "Authorization error" — and so was the steward's broad-scoped `gh` CLI token. A malformed token errors differently ("No GitHub OAuth token …"), so both were real refusals. The cause is the account, not the scope: `/copilot_internal/user` reports `access_type_sku: "no_access"` and `can_signup_for_limited: true` — the steward account has no Copilot plan. **The no-scope default stands; re-test once the steward account has Copilot Free.** Until a Copilot-entitled token succeeds, this ADR claims nothing about which scope Copilot needs.

> **Step 4 — follow-up (2026-09-26, same day): Copilot Free enabled, still refused — the witness needs an account whose Copilot entitlement actually works through the CLI.** After the steward enabled Copilot Free, `/copilot_internal/user` reported `access_type_sku: "free_limited_copilot"`, `chat_enabled: true`, and the account's Copilot settings showed **Copilot CLI: Enabled**. Every path was still refused at the first model call:
> - `@github/copilot-sdk@1.0.14` with the scopeless token: authenticates (`getAuthStatus` → `isAuthenticated: true`), then `models.list` → `403 unauthorized: not authorized to use this Copilot feature`; a session with an explicit model (`gpt-4.1`, `gpt-5-mini`, `claude-haiku-4.5`) is created but the first send → "Authorization error".
> - The standalone `@github/copilot@1.0.88` CLI with the scopeless token (`COPILOT_GITHUB_TOKEN`) → `Access denied by policy settings`.
> - **Copilot's own first-party `/login`** in the steward's terminal → the same `403 … not authorized to use this Copilot feature`.
>
> The broad-scoped token and the scopeless one fail identically at the same step, so **scope is not the variable**; and the first-party login fails too, so **neither this OAuth App nor this code is the variable**. The refusal is the account's server-side Copilot entitlement for the CLI/SDK surface — whether activation lag on a just-enabled Free plan or Free not granting that surface to this account is not determined here.
>
> **Requirement for the RFC 0121 witness:** the certifying run (and step 4's scope check) MUST use a GitHub account for which **Copilot's own CLI answers a prompt** — verify first with `npx -y @github/copilot` → `/login` → any prompt. An account that fails that check cannot witness anything about this provider, and a refusal from such an account is recorded as *account not entitled*, never as a scope or implementation finding. Candidates: the steward account once its Free entitlement works through the CLI, the steward account on Copilot Pro (an individual plan within the cleared scope), or another individually-entitled account that authorizes this OAuth App once.

## Known limits (named, not hidden)

- **Personal workspace only.** Dispatch resolves the token at `run.tenantId`; a run in a shared `ws:` workspace fails closed with `credential_unavailable`. Reaching into a user's personal tenant from run metadata was rejected — run metadata is not an authenticated principal (architect MEDIUM-7).
- **DONE 2026-09-26 (follow-up PR) — chat-wizard selection.** The note below also understated the gap: the chat binding (`PUT /byok/active-config`, `setChatByokConfig`) refused every provider outside `anthropic|openai|google|minimax`, so Copilot could not be selected through the binding API either. Now: (1) the binding accepts `provider: github.copilot` only with `credentialRef: subscription:github.copilot`, only when the host serves Copilot (§B.9), and only when the connected token resolves in that tenant; a stored binding reads unusable once the host stops serving Copilot (`test/chat-byok-copilot-binding.test.ts`). (2) The wizard's provider grid shows a GitHub Copilot tile only when discovery advertises it AND the user has connected it, and binds `model: "default"` with no key step; the sidecar maps `default` to no model so Copilot picks the plan's default (`clients/copilot-provider` test). (3) The Copilot catalog entry lives in the SPA only (`byok/lib/providers.ts` `SUBSCRIPTION_PROVIDERS`), never in `providers.json`, which the backend reads for its model catalog. (4) Removing the chat binding for Copilot unbinds WITHOUT deleting the GitHub connection ("Stop using"; Disconnect stays on the keys page). Tests: `frontend/react/src/byok/__tests__/CopilotPickerTile.test.tsx` (dropping the connected-gate fails it).
- **Chat-wizard selection is a follow-up.** The BYOK chat wizard (`providers.json` tiles) has no OAuth-subscription tile type yet, so Copilot is connected on the keys page and selected by `credentialRef: "subscription:github.copilot"` via the conversation API. A tile type for OAuth-connected providers is the named follow-up.
- **Text only.** The sidecar flattens the transcript to text; tools are disabled by design.

## Tests

| Test | Pins |
|---|---|
| `test/rfc0121-copilot-subscription.unit.test.ts` (13) | §B.9 dark/lit gate; subscription-only `authModes`; loopback-only URL parsing; `dispatchChat(copilot)` refuses a non-loopback URL before any network call and streams from a local fake sidecar with the token only as its bearer; OAuth: not-configured/anonymous/non-`user:` refusals, no `scope`, S256, fixed callback, store at the originating tenant only, single-use state, principal mismatch stores nothing, expired/denied/refused exchange store nothing |
| `test/rfc0121-subscription-at-own-risk.test.ts` (+5, booted app) | the canonical callback path reaches the route (bad state → 302 `copilot=error`); discovery: dark by default; when configured in `supported` + `byok` + `authModes: ["subscription"]`, every `authModes` key ⊆ `supported`; pasted Copilot token refused while the empty probe answers; authorize 404 when dark, 403 for a non-`user:` principal |
| `test/rfc0121-subscription-mechanism-guard.test.ts` (7) | the G2 drift guard above |
| `clients/copilot-provider` `node --test` (13) | empty-mode client, no client-wide token, the full session lock-down, per-session token isolation across turns, SSE framing + `[DONE]`, `ghp_` refused, error scrubbing, loopback bind |
| `frontend/react/src/byok/__tests__/SubscriptionCredentialCard.test.tsx` (+3) | Connect button with no paste/consent; Connect navigates to the host-minted URL; the cleared provider never appears in the at-own-risk picker |
