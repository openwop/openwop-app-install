# ADR 0168 — Headless capability profile + first-party CLI

Status: Part A (A1, A2) **implemented**; Part B (the CLI) **WITHDRAWN** — superseded by the
pre-existing `@openwop/cli` (see the 2026-06-29 correction note under Part B).

> **Correction note (2026-06-29) — Part B was redundant; reverted.** Part B built a new
> first-party CLI (`@openwop/app-cli` under `clients/cli/`, shipped as PRs #1010/#1011/#1014 +
> the CLI bits of #1013). That was a mistake: **the OpenWOP CLI already exists and ships** —
> `@openwop/cli` (repo `openwop/openwop-cli`, bin `openwop`, **published on npm**, with its own
> `publish.yml`). It is explicitly "the local control plane for the OpenWOP demo app
> (app.openwop.dev) and a client for any OpenWOP host," and already implements `caps`/`run`/
> `workflow`/`agent`/`chat` (the same RFC 0005 conversation gate) plus ~25 more command
> families. `@openwop/app-cli` was a strict subset — a "second system" duplication, the exact
> anti-pattern this app's architecture forbids (ARCHITECTURE.md "no second system"; ADR 0001).
> This ADR's own Alternative #3 flagged the risk ("revisit if a generic OpenWOP CLI emerges
> upstream") and it was dismissed without checking the sibling repos. A gap-check against
> `@openwop/cli` found **nothing worth contributing upstream** (it already covers everything,
> and the headless profile needs no CLI change — `caps` reflects whatever the host advertises).
> So `clients/cli/` + its CI/e2e wiring were reverted. **Part A (the `OPENWOP_PROFILE=headless`
> host profile) stands** — it is genuinely additive host code, not duplicated, and `@openwop/cli`
> surfaces it for free. For any future CLI need: **extend `@openwop/cli`, do not fork a CLI here.**

## Context

A stated product goal is that openwop-app can run **100% headless** and be **driven from a
CLI** — not only as the browser SPA. An architecture audit (2026-06-29) found that the app is
**already headless-by-construction**, with no decision that locks it to a browser:

- **The backend (`backend/typescript/`) is the headless host.** It is a standalone Express +
  workflow-engine server (`index.ts:152` `createApp` → `:629` `app.listen`), deployed as a
  Cloud Run service with no display. It has **zero browser-global runtime dependencies** (every
  `window`/`document`/`navigator` reference is either the word "window" in a comment, or the
  `chat-widget` feature *emitting* a browser embed snippet as a string) and **zero
  `backend → frontend` imports**. The React SPA is purely a view over the API ("backend is
  authority").
- **A non-browser drive path is already first-class.** `middleware/auth.ts` supports a
  **Bearer-token / `OPENWOP_API_KEYS`** mode "for the conformance harness + curl," with
  `OPENWOP_AUTH_DISABLE_COOKIES=true` for curl-only deploys; cookie auth is only the browser
  fallback. The whole surface is REST + SSE (`/v1/runs`, `/v1/workflows`, `/v1/agents`,
  conversations via the RFC 0005 `core.conversationGate`).
- **Proven headless.** The OpenWOP conformance harness drives the deployed host entirely
  headlessly via `--base-url --api-key` (no browser) — that is already a headless CLI client.

The audit surfaced **two soft spots** (neither a lock-in; both additive) that keep
"100% headless / CLI" from being a *first-class, polished* mode rather than just a working
reality:

1. **No first-party CLI.** "Run from a CLI" today means curl, the `@openwop` SDK, or the
   conformance harness against the API. There is no `bin/` CLI in the repo.
2. **Client-presentation capabilities are advertised unconditionally.** Three capabilities are
   *client-rendering* concerns the backend **serves but does not depend on**, yet are advertised
   hardcoded at the discovery root regardless of deployment:
   - `uiPlugins` — `host/uiPluginRpc.ts:uiPluginsCapability()` returns `supported:true` hardcoded
     (RFC 0117/0119 front-end plugin packs render in a cross-origin iframe).
   - `realtimeVoice` — hardcoded in `routes/discovery.ts` (ADR 0109/0138; browser mic capture).
   - `chatWidget` / `chat-widget/publicGateway.ts` — emits a browser embed snippet.

   A purely-headless deployment therefore advertises browser-render capabilities it has no client
   surface to honor — a mild **honest-advertisement** wrinkle (`capabilities.md`: advertise only
   what you honor), not a functional limit.

This ADR scopes the two additive moves that make headless/CLI a first-class profile.

## Decision

Two self-contained, additive parts. **Neither changes the OpenWOP wire** (see "RFC call" below).

### Part A — Headless capability profile (`OPENWOP_PROFILE`)

Introduce a single host-config knob that makes the discovery advertisement **reflect the
deployment's actual presentation surfaces**, single-sourced so advertise/serve cannot drift.

- `OPENWOP_PROFILE=full` (**default** — current behavior, no change) | `headless`.
- In `headless`, the three **client-presentation** surfaces are **both** withheld from the
  `/.well-known/openwop` discovery document **and** their routes/seams left unmounted (don't serve
  what you don't advertise — honest + smaller attack surface):
  - `uiPlugins` (the `ui-plugin/1` RPC seam + the `uiPlugins` capability block),
  - `realtimeVoice` (the voice seams + the `aiProviders.realtimeVoice` advert),
  - `chatWidget` (the public embed gateway + its advert).
- The gate is read once at capability-assembly time and threaded through the **existing
  single-source capability functions** (`uiPluginsCapability()`, the `realtimeVoice` block,
  `chatWidget`), NOT a parallel discovery document. A capability is emitted iff the profile
  presents it.
- **Per-capability override** (escape hatch): `OPENWOP_PRESENTATION_<CAP>=on|off` lets an operator
  run, e.g., headless-but-with-uiPlugins. Profile sets the defaults; the override wins.
- Everything else — runs, workflows, agents, conversation primitive, dispatch fan-out (ADR 0165),
  storage, auth — is unaffected. `headless` only subtracts the three client-presentation surfaces.

**Why subtract, not add:** advertising a **subset** of optional capabilities is always
conformant (capability handshake — a host MAY omit any optional capability). The profile makes the
advert honest for a deployment with no rendering client; it never claims anything new.

> **Correction note (Phase A1 implementation, 2026-06-29).** Mapping the real code before
> implementing surfaced three shape differences from this section's premise; the gate
> (`host/hostProfile.ts:presentationEnabled(cap)`) is threaded faithfully to intent at each
> actual site:
> - **`chatWidget` is NOT advertised in `/.well-known/openwop`.** It gates exposure *per-widget*
>   at runtime (enabled widget + valid `wgt_` token + Origin allowlist), advertising no blanket
>   discovery capability. So "withhold the advert" is a no-op for it; A1 co-gates only its **public
>   embed gateway** (`chat-widget/publicGateway.ts` — the browser-render surface), leaving the
>   org-scoped **admin CRUD** routes mounted (a normal authenticated API, not a presentation surface).
> - **`realtimeVoice` is an inline object literal** under `capabilities.aiProviders` (not a
>   function), and its routes are the **`voice` `BackendFeature`** (already `toggle`-gated at request
>   time, default off). A1 wraps the inline advert in the gate and early-returns the feature's
>   `registerRoutes` in `headless`, so the surface is *absent* (unmounted) rather than merely
>   toggled-off.
> - **`uiPlugins`** matches the premise exactly (a root-level `uiPluginsCapability()` advert + an
>   always-mounted RPC route module) — co-gated at both sites.

### Part B — First-party CLI (`openwop-app` CLI)

A thin client over the **existing** HTTP API — no new server surface, no parallel auth/run model.

- Lives in a new `clients/cli/` package (or `cli/`), published separately; depends on the
  `@openwop` TypeScript SDK (`OpenwopClient`) where it exists, falling back to `fetch` for
  host-extension routes under `/v1/host/openwop-app/*`.
- **Auth = the existing Bearer path:** `OPENWOP_API_KEY` env / `--api-key` flag → `Authorization:
  Bearer`. No new credential model; reuses `middleware/auth.ts`. Never persists keys to disk by
  default; reads from env/flag/`stdin`.
- **Command surface mirrors the API** (illustrative, not exhaustive):
  - `openwop-app discover` → `GET /.well-known/openwop` (pretty-print capabilities/profile).
  - `openwop-app run create|get|list|watch` → `/v1/runs` (+ SSE `watch` streams run events).
  - `openwop-app workflow list|register|run` → `/v1/workflows`.
  - `openwop-app chat` → drives the RFC 0005 `core.conversationGate` (open/exchange/close) — a
    headless conversation REPL, the CLI analogue of the SPA chat (NOT a second chat system; same
    wire contract).
  - `openwop-app agent list` → `/v1/agents`.
- **No browser, no SSE-via-`/api` assumptions:** the CLI talks to the backend base URL directly
  (the Cloud Run `*.run.app` or any host), so it inherits none of the SPA's Firebase-rewrite /
  CDN-SSE-bypass deployment specifics.
- Output is human-readable by default with a `--json` mode for scripting/piping.

## Boundaries & duplication (the lead check)

- **CLI is a pure client.** It introduces no second run/conversation/auth/credential model — it
  calls the existing endpoints with the existing Bearer auth. The `chat` command rides the **one**
  conversation primitive (RFC 0005), not a parallel chat. This satisfies the ARCHITECTURE.md
  "no second system" contract: it makes the existing API *more reachable*, not a smaller copy.
- **Profile gates the existing single source.** It conditions the **existing**
  `uiPluginsCapability()` / `realtimeVoice` / `chatWidget` emission, so advertise and serve stay
  co-gated; it does not fork a second discovery path.
- **No `src/core` → feature up-dependency**, no route-table collisions (the profile *removes*
  mounts; the CLI adds no backend routes).

## RFC call (needs-RFC vs host-only)

**Neither part needs an OpenWOP RFC; both are host-only:**

- **Part A** advertises a *subset* of already-Accepted capabilities. Omitting optional
  capabilities is always conformant under `capabilities.md` (advertise only what you honor) — no
  new field, event, endpoint, or MUST. *If* we later want a **named** `headless` profile in the
  spec's `profiles.md` (so other hosts can claim it), that is a separate, optional RFC; this ADR
  does **not** require it — an unnamed deployment-config subset is sufficient and honest.
- **Part B** is a client over the existing API; it touches no wire surface.

## Alternatives considered

1. **Per-capability env flags only (no profile).** Rejected as the *sole* mechanism — operators
   would hand-set three flags to get "headless," easy to get partially wrong. A profile gives one
   honest default; per-capability override remains for the long tail. (We ship both: profile +
   override.)
2. **Hide capabilities from discovery but keep routes mounted.** Rejected — advertise/serve would
   drift (a route reachable but unadvertised is the inverse of the dishonesty we're fixing and a
   needless attack surface). Co-gate both.
3. **Put the CLI in the `@openwop` SDK repo, not here.** Reasonable, but the CLI also needs the
   non-normative `/v1/host/openwop-app/*` routes, so it belongs with this host. Revisit if a
   generic OpenWOP CLI emerges upstream.
4. **No CLI; document curl/SDK recipes.** Rejected as the goal is a *first-class* CLI; recipes
   don't meet it. (Recipes remain valid in the interim.)

## Phased implementation plan

| Phase | Scope | Gate |
|---|---|---|
| **A1 — ✅ implemented** | `OPENWOP_PROFILE=full\|headless` + `OPENWOP_PRESENTATION_<CAP>` override (`host/hostProfile.ts`); co-gates uiPlugins (discovery + RPC route module), realtimeVoice (discovery + the `voice` feature mount), chatWidget (the public embed gateway); `test/headless-profile.test.ts` — a unit gate test (all 3 caps × full/headless/override) + a `createApp`-boot integration test (headless discovery omits uiPlugins+realtimeVoice AND their routes 404 even with the voice toggle ON; override re-presents). 9 tests; tsc clean; 126 discovery/voice/widget regression tests green | small, host-only, no new deps |
| **A2 — ✅ implemented** | `DEPLOY.md` § "Headless profile" — how to run a headless Cloud Run revision (`OPENWOP_PROFILE=headless`, Bearer-only, per-cap override) | docs |
| **B1/B2a/B2b/B3 — ⛔ WITHDRAWN** | A first-party `@openwop/app-cli` (`clients/cli/`) covering `discover`/`run`/`workflow`/`agent`/`chat` was built (PRs #1010/#1011/#1014 + the CLI bits of #1013) and then **reverted** — it duplicated the already-published, far more capable **`@openwop/cli`** (`openwop/openwop-cli`), which drives this same app. See the correction note at the top. Never published; reverted in full. For a CLI need, **extend `@openwop/cli`** | superseded by `@openwop/cli`; "no second system" |

## Open questions / decisions checklist

- [x] Profile name/values: **`OPENWOP_PROFILE=full|headless`** (A1) — `full` is the default and an
      unrecognized value fails open to `full`. Per-cap `OPENWOP_PRESENTATION_<CAP>=on|off` is the
      granular escape hatch; rejected a separate `OPENWOP_SURFACES` list as redundant.
- [x] Does `headless` also gate **any** other browser-leaning surface? **No (A1):** gate only the
      three presentation capabilities; auth flows (Bearer/SAML ACS) stay intact (Bearer is headless).
      The chat-widget *public gateway* is gated (browser-render); its *admin CRUD* is a normal API and
      stays mounted.
- [ ] CLI package name + repo location (`clients/cli/` here vs upstream SDK repo).
- [ ] CLI `chat` UX: one-shot exchange vs interactive REPL (start one-shot; REPL in B2).
- [ ] Do we want a **named** `headless` profile in upstream `profiles.md` (separate RFC), or keep
      it an unnamed deployment config? Default: unnamed config now; RFC only if a second host wants
      to claim the profile.
- [x] Confirm gating a capability removes its routes without shadowing others (A1): the uiPlugins
      `ROUTE_MODULES` entry now no-ops its `register` in headless (the entry stays in the ordered list,
      so no reindex/shadow of neighbors); the voice/chat-widget gates live inside each
      `BackendFeature.registerRoutes`, so feature composition order is untouched. Verified by the boot
      test (the three surfaces 404 in headless; everything else still 200/registers).
- [ ] Replay/security (Part B): confirm the CLI never writes API keys to disk (reads env/flag/stdin).

## Consequences

- Headless becomes a **declared, honest** deployment mode (discovery reflects no rendering
  client), not an incidental property.
- The CLI makes the existing API a first-class operator/automation surface and doubles as a
  headless end-to-end smoke harness.
- Fully reversible: `OPENWOP_PROFILE=full` (the default) is exactly today's behavior; the CLI is a
  separate package that can be dropped without touching the host.
