# ADR 0712 — A run names its BYOK key with `configurable.ai.credentialRef`, and the host honours it

Status: **Accepted — Phase 1 (backend) and Phase 2 (SPA) implemented** 2026-09-16 (two PRs; deploy backend first)
Authors: Claude (session with David), from ADR 0706 OQ5 and a steward `/architect` options pass
Relates: ADR 0706 (Challenge Factory provider choice; OQ5 is this ADR's origin), ADR 0089 (run-credential registration), ADR 0517 (deterministic `byok:<provider>` refs), ADR 0499 (credentialRef consumers), RFC 0124 (sensitive deferred params), RFC 0171 §D.1 (closed v2 `configurable`)

## Correction — dedicated campaign callers (2026-11-06, source candidate)

The earlier builder Run options reachability does not cover dedicated campaign
autopilot or the Campaign Strategist run tool. Their candidate integration uses
existing configurable.ai credential declarations through a feature-owned admission
helper, with explicit provider/model coherence before ignition. The page consumes
the exact shared name-only picker/loader from the reviewed KB extraction rather
than creating another vault UI. Blank retains prior defaults; a selected reference
is a name, never key material. Dedicated detached stages inherit a narrow stored
source AI projection, including the managed sentinel, not a fresh binding lookup.
See ADR 0961's correction for new legacy-stage refusal, reuse and qualification
limits. No protocol or generic run-creation contract changes. Execution pending.

## 1. Context — the spec already defines the field, and the host ignored it

A run gets only the BYOK secrets it **declares**. `executor.ts prepareRunSecrets` resolved
refs listed in `node.config.credentialRefs` or `run.configurable.credentialRefs`, and the
AI adapter's `resolveCredential` reads that set, not the tenant vault. Every host-side run
starter that binds a key (the agent-mention lane, ADR 0089; the Challenge Author's run
tool, ADR 0706) registers it through `host/runCredentials.ts byokRunConfigurable`.

A run started over HTTP had no way to do the same:

- The SPA speaks **v2** (`client/runsClient.ts`), whose `configurable` is CLOSED
  (`schemas/v2/configurable.schema.json`). `credentialRefs` is not a v2 key, so the
  host-internal spelling is a `400 validation_error` on the wire.
- The spelling the wire DOES define — `configurable.ai.credentialRef` — was
  schema-valid and **read by nothing**. Both majors make it normative:
  - v1 `spec/v1/run-options.md:110`: "Opaque host-issued reference to a stored
    credential … MUST reference a credential of a provider in
    `Capabilities.aiProviders.byok`; servers reject mismatched-provider refs with
    `credential_forbidden`."
  - v2 `spec/v2/core/runs.md:60`: "`credentialRef` MUST reference a provider in
    `aiProviders.byok`, else `403 credential_forbidden`; it never carries key material."

So a Challenge Factory run (or `creative-briefs-reel`) started from the `/` picker or
the builder's Run reached its first AI node with an empty secret set and died
`byok_required_but_unresolved` (ADR 0706 OQ5). Typing a ref into the rendered
`credentialRef` variable put a string in `inputs` and registered nothing.

**No RFC is needed.** This honours a field both majors already lock; the host was
out of compliance, not short of wire.

## 2. Options weighed

| Option | Cost now | Debt / forecloses | Verdict |
|---|---|---|---|
| **A. Honour `configurable.ai.credentialRef`** | one reader + a create/fork check | none — closes a compliance gap | **chosen** |
| B. Infer: register any input named `credentialRef`, or a pack marker `x-openwop-app-credential-ref` | a magic variable name, or a pack-format extension (RFC 0013 revision) | a SECOND declaration model beside the wire field; drifts | rejected |
| C. A + B | B's cost | B's debt permanently | rejected |
| D. Picker unsupported; hide the variable | nil | forecloses every BYOK chain from `/` | rejected |

The dominant force is single source of truth: the wire already names the run's
credential, so a host-invented second name can only disagree with it.

## 3. Decision

### 3.1 One reader — `host/runCredentials.ts`

- `runAiCredentialRef(configurable)` — the wire field, as a NAME; empty, non-string,
  dotted (`'ai.credentialRef'`) and managed (`managed:*`) values are not a run credential.
- `declaredRunCredentialRefs(configurable)` — the ONE answer to "which secrets does this
  run declare?": the wire ref FIRST, then `credentialRefs[]`, deduped. `prepareRunSecrets`
  resolves exactly this list (fail-closed, as before), and `bootstrap/nodes.ts
  inheritedCredentialRefs` hands exactly this list to a child run — the two used to be
  separate readers of `credentialRefs` only.
- `runAiCredentialRefViolation(configurable, tenantId, byokProviders)` — the create/fork
  check (§3.3).

### 3.2 The ladder gains a run rung — `aiProviders/credentialRefLadder.ts`

Registration alone is not enough. The ADR 0517 wizard names keys `byok:<provider>`, and
the ladder's exact/prefix rungs (`google`, `google-*`, `google:*`) never match that, so a
node passing no ref would still miss the run's key. And with two keys for one provider,
first-match would pick whichever the secret map lists first.

`pickCredentialRef(provider, credentialRef, availableRefs, runCredentialRef?)`:

1. explicit node ref — unchanged, still wins;
2. **run** — `runCredentialRef`, iff it NAMES this provider (`refNamesProvider`) and is in
   `availableRefs`. A run key for Google is never sent to Anthropic; an unregistered one
   falls through;
3. exact, 4. prefix — unchanged.

`refNamedProvider(ref, providers)` is the one mapping from a ref name to a provider:
`<p>`, `<p>-…`, `<p>:…`, `byok:<p>`, `byok:<p>:…`. It is pure, so every attempt and every
fork reads the same answer. The Challenge Author's pre-flight ownership check
(`kicktodo-creator/agentTools.ts`) now calls `refNamesProvider` instead of its own
inline copy — which also lets it accept a `byok:<provider>` ref it used to refuse unless
that ref was the workspace default.

The executor threads `AdapterScope.runCredentialRef` from `runAiCredentialRef(run.configurable)`.

### 3.3 Create and fork refuse, before a run exists — `routes/runs.ts`

On `POST /v1/runs` (both majors, after the v2 closed-schema check and the RFC 0124
sensitive-param check) and on a `:fork` whose `runOptionsOverlay` carries `ai`:
`403 credential_forbidden` when `ai.credentialRef` is present and

- empty / not a string;
- managed (`managed:*` is not a BYOK credential);
- names no provider in `advertisedByokProviders()` — the SAME function the discovery
  document's `aiProviders.byok` is built from, pinned equal by a test;
- does not resolve via `resolveSecret(ref, { tenantId })` for the tenant the route
  **already authorized** (the fork uses `sourceRun.tenantId`, which `loadOwnedRun`
  proved is the caller's).

**Tenant isolation.** The resolver only sees the authorized tenant, so another
workspace's ref and a ref that never existed produce the identical refusal — the check
cannot be used to probe for key names. Only the NAME is ever persisted on the run.

### 3.4 Replay and fork

`configurable` is frozen at create and copied verbatim on `:fork`; the ref name is
re-resolved to a value at each run start, exactly as `credentialRefs[]` already was. The
run rung is a pure function of the frozen `configurable` and the resolved set, so a
replay reads the same rung. A branch overlay that swaps the ref is checked (§3.3).

### 3.5 Conformance interaction — recorded, not hidden

`@openwop/openwop-conformance` `redaction.test.ts` plants an **unresolvable** canary
(`cred_…`) as `configurable.ai.credentialRef` on a v1 create and, on a non-201,
**soft-skips** its "credentialRef never reaches the event stream" leg. Honouring the MUST
means this host now answers 403, so that leg no longer executes here. The property it
guards is re-pinned host-side: `test/adr0712-run-ai-credential-ref.test.ts` creates a run
with a VALID ref, polls its events, and asserts the ref name appears in none of them.

## 4. Phases

| Phase | Scope | State |
|---|---|---|
| 1 | backend: §3.1–§3.4 + tests | **implemented** (this ADR's PR) |
| 2 | **implemented (separate PR).** SPA: a workflow whose variables declare `credentialRef` renders a picker of the tenant's stored refs (`GET /v1/host/openwop-app/byok/secrets`) instead of a free-text field, and the run starters that use `RunInputsDialog` / the chat mention lane send `configurable: { version: 1, ai: { credentialRef } }` beside the input. The variable name drives only which CONTROL renders; registration stays the wire field and the server stays the authority. Deploy after Phase 1 (a v2 body the old backend ignores is harmless, but the picker is pointless until it is honoured). | open |

> **Phase 2 as built (2026-09-16).** Three things differ from the row above, each found while building it:
> - **The key never rides the node input.** `ui/RunInputsForm.tsx splitRunCredential` puts a picked key on `configurable.ai.credentialRef` and DROPS an optional credential variable from `inputs`. A ref sent as the node's own `credentialRef` hits the ladder's EXPLICIT rung, which does not check the provider — a Google key picked for an Anthropic-pinned chain would be sent to Anthropic. The run rung (§3.2) is provider-checked. A required credential variable stays an input (the run cannot start without it). See OQ4.
> - **The chat mention lane (`/` picker) has no form**, so it uses the chat's own durable ADR 0517 binding (`GET …/byok/active-config`) — only when the server reports it `valid` and it is not managed — and only for a workflow that declares an unset `credentialRef`.
> - **Starters wired:** `RunInputsDialog` → `ProjectWorkflowsTab`, `AgentWorkflowPortfolioPanel`; chat `useWorkflowRunMentions`. `RunsIndexPage`, `BuilderShell` and `TemplatePreflightModal` do not render the dialog and are unchanged.
> - Tests: `ui/__tests__/runInputsCredential.test.tsx` (8), `agents/__tests__/agentWorkflowRunInputs.test.tsx` (+1, dialog → `createRun`), `chat/hooks/__tests__/useChatSession.integration.test.tsx` (+2). Sabotaged independently: input strip, managed guard, picker branch, deferred-name mapping, authored-value retention, stored-keys load, dialog submit, panel pass-through, chat pass-through, chat `valid` guard, chat managed guard — each red. `ProjectWorkflowsTab`'s pass-through mirrors the pinned agent panel and is not separately pinned.

Phase 2 is deliberately NOT "send the active BYOK config on every run": a stale ADR 0517
pointer or a key named without a provider would turn today's working runs into 403s.

## 5. Test record (Phase 1)

`test/adr0712-run-ai-credential-ref.test.ts` — 12 tests: naming map; run rung (own
provider only, explicit wins, unregistered falls through); declared-refs order/dedupe;
adapter dispatch sends the RUN key upstream (`x-goog-api-key`, fetch stubbed); executor
registers `ai.credentialRef` beside `credentialRefs[]` and a no-ref node dispatches with
it; HTTP: advert parity, v1 accept, v2 accept, foreign ≡ missing (403, same code),
provider-less 403, managed/empty 403, fork overlay 403 + no event echo.

**Sabotage record** (each call site broken independently; each reddens ≥1 test):
create check (3 red), fork check (1), executor registration (1), executor → adapter
threading (1), adapter run rung (1), ladder rung (1), `byok:` prefix mapping (3),
resolve-in-authorized-tenant (4).

**Not independently pinned:** `bootstrap/nodes.ts inheritedCredentialRefs` now reads
`declaredRunCredentialRefs`; its pre-existing `credentialRefs[]` leg stays covered by
`chain-backed-flagship-e2e`, the new wire-ref leg is not.

## 6. Open questions

- **OQ1** A child run inherits the parent's refs into its `credentialRefs[]` but NOT the
  run rung (the child has no `ai.credentialRef`). Children in shipped chains pass the ref
  explicitly, so nothing breaks today; a child node that passes none would fall back to
  exact/prefix. Decide when a chain needs it.
- **OQ2** `aiProviders.byok` advertises `anthropic, openai, google` while `supported`
  includes `minimax`; a MiniMax key therefore cannot be a run credential. That is the
  advertisement's call, not this ADR's — revisit if MiniMax BYOK is advertised.
- **OQ3** v2 `ai.provider` / `ai.model` are also schema-valid and unread. Out of scope
  here; the same compliance audit applies.
- **OQ4** The ladder's EXPLICIT rung (`pickCredentialRef`) does not check that a node's
  own `credentialRef` names the provider it dispatches to, so a mis-paired ref sends one
  vendor's key to another (it fails upstream, but the key has left for the wrong vendor).
  Pre-existing; Phase 2 routes around it rather than fixing it. Fix: refuse an explicit
  ref whose `refNamedProvider` is a DIFFERENT known provider (a provider-less name stays
  allowed). Needs its own sabotage-verified change across `aiProvidersHost` and the
  Challenge Author pre-flight, which already applies this check by hand.

  > **CLOSED 2026-09-17.** `resolveCredential` now refuses, before reading any secret, an
  > explicit ref whose NAME carries a different known provider
  > (`credentialRefLadder.ts explicitRefNamesOtherProvider`, the same `refNamedProvider`
  > rule, over the chat + image + video + speech provider lists derived in
  > `aiProvidersHost.ts`). Typed `byok_required_but_unresolved` with
  > `reason: 'explicit_ref_wrong_provider'` — an existing code, so no mapper changes — and a
  > message naming the key's vendor and that it was not sent. Deliberately narrow: a
  > provider-less name (`my-key`), `compat` (an OpenAI-compatible endpoint may take any
  > vendor's key), `mock` and managed refs are untouched. The Challenge Author pre-flight's
  > stricter `ownsRef` check is unchanged. Witness:
  > `test/adr0712-oq4-explicit-ref-provider.test.ts` (4 — a Google step carrying an
  > Anthropic key throws and **nothing reaches `fetch`**; own-provider and provider-less keys
  > still dispatch). Sabotage: bypassing the call site reddens 1, dropping the own-provider
  > exemption reddens 2. Credential suites unchanged (ladder 8, dispatch 3, ADR 0712 12,
  > ai-providers 17, challenge-author tools 22, image 8, video 15, flagship e2e 2).

## Correction — explicit builder run option (BYOK-2, 2026-11-05)

The Phase2 picker only existed for workflows declaring a credentialRef variable.
Builder Run did not use that dialog or declare a key, even when its imported
Campaign Studio nodes fixed Google as their provider. The run therefore had no
secret, despite a valid labeled Google key in the workspace vault. Provider/model
defaulting (ADR0903) does not declare a stored key; the existing credential ladder
already recognizes provider:label names when registered.

Plan: extend the shared RunInputsDialog with an optional separate AI-key run
option and use it at builder launch. Bind only the selected name through the
existing configurable.ai.credentialRef field, not through chain params or node
inputs. Keep the existing declared-variable picker as the sole control when one
is present. Preserve default inputs, registration CAS, collaboration, draft
launch metadata and ordinary non-AI Run behavior. Unknown/indirect graph calls
must have an explicit Run options affordance without inferring readiness.

No automatic key selection, vault-value enumeration, aliases, credential binding
writes, pack edits or executor fallback. A blank choice retains existing declared
keys/managed behavior; copy states that it does not supply a workspace key. Mixed
provider graphs must explain that one run key applies only to matching-provider
steps. A key list failure is an honest retry state, not a keyless workspace;
workspace/auth changes clear the selected option and ignore stale reads. The
server's existing tenant/provider validator remains authoritative. Selection is
stamped in the run create request; fork inherits it, never reselecting the latest
workspace binding. This uses the existing accepted run option and needs no RFC.

Independent architecture review precedes implementation. Original-source RED,
fixed focused UI and local-library credential/fork checks, source/UX review and
root-owned canonical composition gate/deployed acceptance remain required.

Implementation record: builder Run now opens the shared dialog when a provider/
model is explicit, a credential variable is declared, or catalog AI metadata
indicates usage. Explicit Run options remains available for unknown/indirect
graphs. The graph fingerprint excludes snapshot-generated timestamps, is checked
after async preflight and inside the serialized registration turn, and identity
changes cancel the pending option. Only the explicitly selected key requires a
verified list; blank No key override remains runnable during list failure, with
honest retry copy. Optional canonical variables without required normalize false.

Focused evidence: original shared-dialog source fails6newcases; original builder
source fails3of4launchcases (non-AI control passes). Restored final source passes
20cases across actual BuilderShell integration, shared key-option and existing
credential-form tests. Changed frontend ESLint passes. These are diagnostic only;
no compiler/build/full gate or new backend execution claimed. Existing backend
ADR0712 tenant/dispatch/fork controls are unchanged and await composed execution.
Independent architecture/code/UX review is recorded with campaign acceptance
evidence. Root owns canonical qualification and deployed live acceptance.


### Correction — 2026-11-07: pending Builder options retain their launch identity

The Builder's pending run-options record must capture the launch identity when
it opens. Clearing React state on an auth/workspace change does not synchronously
unmount the old form: a blank/default choice submitted in that same turn could
call the parent launcher, which then captured the new identity and registered
the workflow. The parent now compares the pending record's captured identity
before calling the launcher, for both blank and selected choices. Existing
after-await identity checks, server ownership, credential admission and default
resolution remain unchanged. A real-dialog same-turn regression reproduced one
unwanted registration before the correction; a separate unchanged-identity blank
control protects the normal default launch. Focused results and canonical gate
evidence are recorded separately; this correction is not yet deployed.
