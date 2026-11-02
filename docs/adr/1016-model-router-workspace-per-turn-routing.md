# ADR 1016 — Model router: one workspace config, a per-turn decision, and only targets the turn can call

**Status:** implemented (2026-10-31; Accepted after the adversarial `/architect` pass recorded below; implementation record at the end)
**Amends:** ADR 0130 (rule-based model router: Phase 2 config keying, Phase 3c lazy stamp), ADR 0714 (fallback filter), ADR 0610 D4 (routable-provider allowlist; write scope)
**Toggle:** `model-router` (unchanged: default ON, `tenant`, Governance bundle; ADR 0820 §8.2)
**RFC verdict:** host extension, **no new RFC**. Every route stays under `/v1/host/openwop-app/model-router/*`. `run.metadata.modelRoute` is non-normative and this ADR stops writing it. The RFC 0109 `agent.model` provenance stamp becomes more accurate, with no change of shape.
**Origin:** feature loop round 2, row 66; `docs/steward/workflows-assessment/2026-10-31-model-router.md` (`MR66WF-1..5`), plus the open `MRC-1` and `MRC-4` (`CODEBASE-ASSESSMENT.md` § Model router, 2026-08-27).

## Context: what was measured

On `origin/main` @ `e6e1e27b2`, with a read-only production read on 2026-10-31:

| Fact | Evidence |
|---|---|
| Configs saved in production | `hostext:modelrouter:config:*` → **0** rows |
| Runs ever routed | runs with `metadata.modelRoute` → **0** |
| Chat runs carry no `scopeId` | 66 of 66 chat runs (`metadata.chatSessionId`) have `scope_id IS NULL`; the SPA never sends one |
| Orgs that are workspace roots | 13 of 30 `access-orgs` rows (`orgId === tenantId`) |

Every defect below is therefore **latent**. Nobody has saved a config, so nothing needs migrating or cleaning up.

1. **The config the console writes is not the config the chat reads (`MR66WF-1`).** The console picks an org from `GET /orgs` and stores `${tenantId}:${orgId}` (`features/model-router/configService.ts:43`, `routes.ts:16`). The only reader, the chat stamp, looks up `${run.tenantId}:${run.scopeId ?? run.tenantId}` (`host/exchange/dispatchTurn.ts:67`). With no `scopeId`, that is the workspace root. A config saved for any other org can never route a turn. The console's empty state tells a tenant with no orgs to create one (`ModelRouterPage.tsx:150`), and that new org is `org-<uuid>` (`host/accessControlService.ts:606`), which can never be read.
2. **The decision ignores the conversation's credential (`MR66WF-2`, `MRC-4`).** `routeTurn` filters by vision only (`routeTurn.ts:111-119`). The run keeps one `credentialRef`.
   - A rule naming a provider that key does not cover is stamped once. Every later turn then fails `credential_unavailable` / `explicit_ref_wrong_provider` (`dispatchTurn.ts:384`), and the stamp is never re-resolved, so the conversation is broken for good.
   - On a managed conversation, `dispatchManagedChat` ignores the stamp, but `resolveModelProvenance` still reads it (`dispatchTurn.ts:101`). The turn's `agent.model` then names a model that did not answer.
3. **"Per turn" is "per conversation" (`MR66WF-3`).** The toggle description, `FEATURES.md:283` and the console lede all promise a choice per chat turn. ADR 0130's own replay section (line 36) says new turns of a forked conversation route "by the rules (a new decision, freshly stamped)". In the code, `maybeStampModelRoute` decides on the first exchange and fast-paths every later one (`dispatchTurn.ts:65`). So `tokensOver`, `difficultyAtLeast` and `attachment` judge only the first message. Turning the router OFF does not un-route a stamped conversation (`applyRoute.ts:23-35`), although the toggle copy promises "Turn OFF and every turn uses its default model".
4. **Vision is judged per provider, never per model (`MR66WF-4`).** This is moot for today's catalog, where every routable model lists `vision`. It is not moot for the free-text model ids the console accepts. Free text also means a typo is stamped permanently.
5. **Anyone with `workspace:write` can re-point every chat in the org (`MRC-1`).** That sends the org's prompts to a different vendor and spends a different key. It is a key-pointing decision, and ADR 0779 D1 / ADR 0943 D6 put every such route behind `requireByokManage`.
6. ~~**The config row is invisible to tenant teardown.**~~ **Withdrawn by the `/architect` pass (M1):** `purgeTenantRows` falls back to the row's own `tenantId` field when a collection has no `tenantOf` (`hostExtPersistence.ts:650`, `:151-155`), and every stored row carries `tenantId`. D1 still adds `tenantOf`, as a bounded tenant index, not as a teardown fix.

### Is a per-turn decision replay-safe?

ADR 0130 stamped the route because "a fork that recomputed it would diverge". That reasoning applies to a turn that is **re-dispatched**. Chat exchanges are not re-dispatched:
- replay reads the recorded turn (ADR 0089 §Q4);
- `:fork` copies the transcript, and only NEW exchanges dispatch (the row-65 measurement, `workflows-assessment/2026-10-29-context-economy-1003.md`);
- what answered each turn is already recorded create-only by `host/turnAttribution.ts` (ADR 0986 D1).

A new exchange on a fork is a new decision. That is exactly what ADR 0130 line 36 specified. The route touches no prompt text, so ADR 1002's run-independence (XCH-ENV-9) is unaffected.

**Verified by the `/architect` pass.** No path re-dispatches a past chat exchange:
- the chat tool loop's adapter scope sets no `replayInvocationsFromRunId` (`conversationToolLoop.ts:477-481`), and `viaReplayLane` serves from the log only when that field is set (`aiProvidersHost.ts:835-841`). On the chat lane, the `toolsRoundDigest` provider/model key (`:642-653`) is therefore written and never read;
- `dispatchReply` never touches the invocation log;
- a committed `exchangeKey` returns the stored turns without re-dispatch (`conversationExchange.ts:290-293`);
- the deep path freezes the model into the nested run's inputs (`:490-509`).

## Decision

### D1 — One config per workspace, keyed on what the chat reads

- The router config belongs to the **workspace** (the active tenant), stored at `${tenantId}:${tenantId}`. The resolver always reads that key and **ignores `run.scopeId`**. _(Corrected by the `/architect` pass, M3: the draft said "no runtime key changes". A conversation created through `POST /runs` with a `scopeId` used to read `${tenantId}:${scopeId}`, which no route can write any more. Ignoring `scopeId` is a deliberate change.)_
- New canonical routes, with no `:orgId`:
  - `GET  /host/openwop-app/model-router/config` → `{ config, canManage }`
  - `PUT  /host/openwop-app/model-router/config`
  - `POST /host/openwop-app/model-router/config/enable`
  - `POST /host/openwop-app/model-router/config/preview` (D6)
- The legacy `…/model-router/orgs/:orgId/config[/enable]` routes stay, as aliases that run the **D2 gates** and then accept **only** `orgId === tenantId`, with **no org-row lookup**. _(Corrected by the `/architect` pass, M2: the old `requireOrgScope` gate 404s unless an org row exists (`accessControlService.ts:674-677`). Most personal workspaces have no root row, so `enable <workspaceId>` would have 404'd.)_ The CLI's `model-router enable <id>` keeps working with a workspace id. Any other org id answers **409 `model_router_workspace_scoped`**, whose message says routing is per workspace. That beats a silent write nobody reads.
- The collection gains `tenantOf: (c) => c.tenantId` so tenant teardown reaches it.

### D2 — Writes need the BYOK-manage authority; reads need `workspace:read`

- **Writes** (`PUT`, `enable`, legacy aliases): `requireFeatureEnabled('model-router')` plus `requireByokManage(req)` (ADR 0779 D1). This is the one predicate for "point work at a stored key", and it closes `MRC-1`.
- **Reads** (`GET`, `preview`): `requireFeatureEnabled` plus `requireTenantScope(req, 'workspace:read')`.
- The `GET` response carries `canManage`. That flag is the same predicate, evaluated and caught, so the console renders read-only for members instead of failing on save.
- The personal-tenant owner short-circuit is inherited from `assertTenantScope`.

### D3 — Decide per turn; never stamp

- `maybeStampModelRoute` and `computeRouteStamp` are deleted.
- **Voice-clip transcription is never routed** _(architect L1)_. It calls `dispatchReply` with no route (`exchange/transcribeAudio.ts:31`). Before, a legacy stamp was what routed it. Transcription is not a chat answer, so this is intended.
- **The read moves onto the ack path** _(architect L3)_. It moves from `finishExchange` (`conversationExchange.ts:686`) to before tool eligibility (`:427`), which is on the synchronous ack path of an async exchange. A managed conversation pays a pure function. A BYOK conversation pays one toggle read and one point read.
- **A composer pick turns the router off for the session** _(architect L5)_. Once a member picks a model in the composer, the SPA sends that override on every later turn until the provider changes (`useComposerModifiers.tsx:78`, `:93`, `:164`). The router stands aside for the rest of the session, which is the correct "user chose" behaviour.
- A new `resolveTurnModelRoute(run, features)` runs **once per exchange** in `handleConversationResolve`, after the conversation meta is composed and **before** tool-loop eligibility (`conversationExchange.ts:427`).
- Its decision becomes the exchange's model selection, with this precedence:

  `user's per-exchange override (ADR 0124)` > **`this turn's route`** > `legacy stamp` > `same-provider class tier` > `run inputs`

- Mechanically (D4b), the route travels as its own `route` value beside `exchangeModelOverride`, to every site that receives the override: the tool-loop eligibility, the deep path, provenance (both), the tool loop, and `dispatchReply`. All of them resolve through the ONE resolver (CS-GB-1), so routing reaches every lane by construction.
- A routed model counts as "chosen", so it suppresses the class-tier bump. A tenant rule wins over that host default, as ADR 0130 Phase 6 states.
- **OFF means OFF.** No toggle, no config, `enabled:false` or no match all return no route, and the turn uses the conversation's own model.
- The cost is one config point-read plus one toggle read per turn. Today's code already pays that on every turn of every unstamped conversation, which is 100% of production.
- **Legacy stamps.** Existing `run.metadata.modelRoute` stamps (0 in production) are still read by `effectiveModelTarget`, so a self-hosted adopter's old conversations do not change model under them. A per-turn route outranks such a stamp. This is the one place "OFF" does not reach, recorded as residue `R1`.

_Architect L4:_ a legacy stamp naming a provider the conversation cannot dispatch still breaks that conversation, and on a managed run it still produces false provenance. So `effectiveModelTarget` also ignores a stamp whenever `dispatchableProviderOf` says the conversation cannot call it. The residue shrinks to stamps the conversation can call.

### D4 — A route may only choose a listed model of the conversation's own provider

_(Retitled by the `/architect` pass, H1. The draft promised "only targets this turn can actually call", but a key can cover a provider and still lack quota for one of its models. D4b is what makes that case degrade instead of fail.)_

`routeTurn`'s eligibility gains two conditions. Both are pure and catalog-backed.

1. **Dispatchable provider.** `dispatchableProviderOf(runInputs)` returns the one provider this conversation can call, or `null`. It uses the same `credentialRef` default `dispatchReply` uses (`managed:openwop-free`).
   - `managed:*`, `subscription:*`, `compat` and `mock` conversations return `null`. The router does not apply to them, which closes `MRC-4` and the false provenance.
   - A BYOK ref returns the provider its name carries: `refNamedProvider(ref, CREDENTIAL_PROVIDERS)`, the SAME provider list the dispatch guard uses (`dispatchTurn.ts:381`, `conversationToolLoop.ts:470`). _(Corrected by the `/architect` pass, M4: the draft said "the catalog's provider ids".)_
   - A provider-less ref (`my-key`) returns the run's own `inputs.provider`. This rule is load-bearing: `explicitRefNamesOtherProvider` lets a provider-less ref through to any vendor (`credentialRefLadder.ts:73-86`), so D4 is the only guard there.
   - The provider is worked out BEFORE the toggle and config reads, so a managed conversation (the default) pays nothing.
   - A target whose provider is not that one is ineligible. Its rule is skipped, never stamped and never refused.
2. **Listed model, with per-model vision.** The target model must be listed for its provider in `providers.json`. An attachment turn needs that model's `vision` capability, not the provider's.

The resolve-time belts in `resolveRoute.ts` (routable provider, vision) stay as defence in depth.

### D4b — The route is its own input to the ONE resolver, and a failing routed model degrades once

_(Added by the `/architect` pass, H1.)_ The draft passed the route in as `exchangeModelOverride`, and that silently drops an existing degrade path:
- `dispatchReply` and the tool loop fall back from the class-tier model to the un-bumped selection on a 429/404 (`dispatchTurn.ts:436-477`, `conversationToolLoop.ts:487-491`).
- With the route posing as the override, the "un-bumped selection" IS the route, so there is nothing to fall back to.
- A rule sending long messages to a pro model that a free-tier key cannot serve would then 502 on every matching turn.

The design instead:
- **Precedence.** `resolveConversationModelTarget` gains a `route` input: `override > route > legacy stamp > class tier > inputs`.
- **No tier bump on a routed turn.** A route counts as "chosen", so it suppresses the tier bump.
- **One fallback per turn.** Each lane works out its selection without the route and without the tier. When either of them changed the model, that selection becomes the fallback model.
- **The override keeps its meaning.** `exchangeModelOverride` still means "the user chose". It is never persisted, emitted, keyed on or budgeted (verified by the `/architect` pass), and the router does not pretend to be it.

### D5 — Closed-world targets and an optional fallback

- `asTarget` (write) refuses a model that is not listed for the provider (400 `validation_error`, `field: …model`). The console offers only catalog choices.
- A stored legacy config with an unlisted model is served as-is. Its rules are inert by D4 and logged once. Any save re-validates the whole config, so it has to clear or replace those rules first. The console marks them "not in the catalog" so the admin knows which ones. _(Architect L6.)_
- **`fallback` becomes optional.** Today a required fallback means enabling the router overrides **every** member's model choice on every turn that matches no rule. With no fallback, a turn that matches no rule keeps the conversation's own model.
- An existing fallback keeps working. The console labels it "Otherwise use …", with "Keep the conversation's model" as the default.

### D6 — Preview: "which model would this message get?"

- `POST …/config/preview { text, hasAttachment?, conversationKind?, provider }` runs the SAME `routeTurn` over the stored config. It returns `{ decision: {provider, model, reason, ruleIndex} | null, why }`.
- It is pure, makes no model call, and needs read scope.
- It gives an admin a way to check a rule before a member's chat proves it. Production showed this matters: zero configs and zero routed runs, and no way to tell whether a saved config would ever apply.

### D7 — Honest copy

The new copy says what the router now does. The toggle description, `FEATURES.md` rows, the console lede, the hints and the Operations-hub card change to say: per message, per workspace, only among models of the provider a conversation's key belongs to, and OFF means every message uses its own model. The Operations hub card claims a per-workspace model "allowlist" in all four locales (`operations/i18n/{en,es,fr,pt-BR}.ts:73`). That allowlist does not exist. _(Architect L2: the draft said fr/es only.)_

This copy ships in 4 locales.

## Alternatives weighed

- **Keep stamp-once and fix only the copy.** Rejected. It keeps a first-message judgement the product never promised, and it keeps the permanent breakage of `MR66WF-2` unless D4 also lands. D4 without D3 still freezes a decision that `attachment`/`tokensOver` rules exist to make per message.
- **Make chat runs carry a `scopeId` so per-org configs are read.** Rejected. It changes run creation for every chat to serve a feature with 0 configs, and "which org is this chat in" has no answer in a personal tenant. The workspace is the unit that owns keys (BYOK is tenant-scoped), so routing belongs to it.
- **A per-target `credentialRef`** (ADR 0130's original data model). This would allow genuine cross-provider routing. Deferred (OQ-1): it needs a key picker, and the ADR 0779 wrong-vendor guard has to judge each target's ref.
- **Stamp per turn into `run.metadata`.** Rejected: unbounded metadata growth, and per-turn attribution already exists in `turnAttribution`.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Stays in `features/model-router/`; the exchange keeps importing the resolver (core→feature edge already present at `dispatchTurn.ts:16-20`, moves to `conversationExchange.ts`). |
| 2 | Toggle | `model-router`, unchanged. |
| 3 | `ctx.<feature>` | None; the router is a chat-dispatch stage, not a workflow surface. Workflow agent nodes are not routed (unchanged; OQ-2). |
| 4 | Node pack | None. |
| 5 | Envelopes | None. |
| 6 | Agent pack | None; the config is an admin decision with spend and egress consequences, so it is not chat-drivable (OQ-3). |
| 7 | Public surface | None. |
| 8 | RBAC | D2: BYOK-manage writes, `workspace:read` reads, active tenant only, fail-closed; legacy alias refuses a non-root org. |
| 9 | Replay / fork | D3: per-exchange decision; chat exchanges are never re-dispatched; attribution recorded per turn (ADR 0986). Legacy stamps still read. |
| 10 | Frontend | Models console Routing tab: no org picker; catalog selects; optional fallback; preview box; read-only for non-managers; 4 locales. |

## Phased plan

| Phase | Scope | Tests (sabotage-witnessed) |
|---|---|---|
| P1 | D4 + D5 in `routeTurn` / `configService` (dispatchable provider, listed model, per-model vision, optional fallback, closed-world write) | `routeTurn` skips another provider's rule, refuses an unlisted model, keeps own model with no fallback |
| P2 | D1 + D2 routes, `tenantOf`, legacy alias 409 | a config saved through the route is the one the exchange reads; a member gets 403 on PUT; non-root org → 409 |
| P3 | D3 per-turn resolve in the exchange; delete the stamp | two turns, short then long, route differently; OFF leaves both unrouted; a managed conversation is never routed; provenance names the routed model |
| P4 | D6 preview + console + D7 copy | FE: no org picker, read-only for `canManage:false`, preview renders the decision |

## Open questions

- **OQ-1** Cross-provider routing through a per-target `credentialRef`. Deferred, see Alternatives.
- **OQ-2** Workflow agent nodes are not routed (unchanged since ADR 0130).
- **OQ-3** Whether an admin agent may draft rules through the chat. Out of scope.
- **OQ-4** A per-turn "routed by rule N" chip in the chat (ADR 0130 OQ-4). The turn already shows which model answered (ADR 0124). The reason would need a field on the attribution record. Filed.

## Adversarial `/architect` pass (2026-10-31, before code)

**No Blockers.** The pass found:

- **One High.** H1: the routed model had no degrade path. D4b fixes it.
- **Four Medium.** Each corrects a factual claim in the draft:
  - M1: teardown. The finding is withdrawn.
  - M2: alias authority.
  - M3: `scopeId`.
  - M4: provider list.
- **Seven Low.**
  - L1 to L6 are recorded at the sections above.
  - L7: two line references in the draft were wrong, at `routeTurn.ts:111-119` and `applyRoute.ts:23-35`.

**Verified clean:**

- Replay and fork. The evidence is under "Is a per-turn decision replay-safe?".
- The override is never persisted.
- `host:byok:manage` belongs only to the built-in admin and owner roles (`accessControlService.ts:118-130`, `:300`), and cannot be minted onto a custom role.
- A shared workspace's scope union counts only root memberships (`:2283-2287`), so a sub-org role cannot reach workspace config.
- `canManage` is the caller's own boolean.

## Residue

- **R1** Legacy `run.metadata.modelRoute` stamps (0 in production) that the conversation can call still pin it, even with the router OFF.
- **R2** `cooldownMs` is accepted and stored but has no production caller (ADR 0714 MRC-6). Unchanged.
- **R3** `@openwop/cli` `model-router enable <org_1>` help text should say workspace id. CLI repo follow-up.
- **R4** Deep investigations (the nested agent run, ADR 0089 Phase 4) run on the conversation's own model, unrouted. The nested run takes its model verbatim and has no degrade-once lane (D4b), so a routed pro model the key cannot serve would fail every deep run. Added by the code grade (`MR66CD-2`).

## Implementation record (2026-10-31, feature loop round 2 row 66)

| Phase | Commit | Witness (sabotage-checked red) |
|---|---|---|
| P1–P3 (D1–D6 backend) | `ac03dd73a` | `adr1016-model-router-routes`, `adr1016-model-router-per-turn`, `adr1016-listed-model-capabilities`, `model-router-{route,resolve,config,conversation-target}` — S1–S11 |
| P4 (console + copy) | `52f40315a` | `model-router/__tests__/*`, `ModelsHubPage.test.tsx` |
| Code-grade fixes | `21384f809`, `9a3b94d0d` | `adr1016-tool-loop-route`, per-turn provenance leg, eraser leg — S12–S14 |
| UX-grade fixes | `276ba0be7` | `loadFailedGuard.test.tsx` (preview staleness, fallback draft, read-only) |

Filed, not done: `MR66UX-11` (rule reordering and a "never reached" marker), `MR66UX-14` (undo on Remove), `MR66UX-16` (console landmark name), `MR66CD-10` (config read-modify-write race), `MR66CD-14`, `MR66CD-15`. Grades and evidence: `docs/steward/workflows-assessment/2026-10-31-model-router.md`.
