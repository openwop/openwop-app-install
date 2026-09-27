# ADR 0498 — Chain node config conformance: required config, provider defaults, and the authoring→dispatch gap

Status: **implemented** — P1–P3 + P5 shipped 2026-07-28 (#2652), corrected by the grade trio (#2661) and by the §Open follow-ups (#2671). P4 (flip the report to a throw) is BLOCKED on **42** config nodes + **72** unbound-input nodes; see §Open for the live composition.

> **Renumber note (2026-07-28):** this ADR was authored as **0497** and collided
> with `0497-toast-queue-and-focus-on-dismiss.md`, which two peer sessions landed
> the same night (00:45 vs 02:04). `check-adr-refs` was RED on `main` as a result.
> Per the checker's own policy — first-created keeps the number — the toast ADR
> retains 0497 and this one moved to 0498. Only the number changed; no decision,
> phase, or status was touched. Cite this work as **ADR 0498** going forward.

## Why this exists

A production run of `wf.exec-ops-daily-briefing` failed with:

```
provider_not_supported: Provider "undefined" is not in the host's aiProviders.supported list.
```

There is no provider called `undefined`. That string is a JavaScript `undefined`
interpolated into an error template — a MISSING value rendered as a BOGUS one.

The chain of causes, each verified rather than assumed:

1. `packs/core.openwop.ai/schemas/chat-completion.config.json` declares
   `required: ["provider","model"]`.
2. `examples/workflow-chain-packs/exec-ops/pack.json` shipped that node with
   `config: {}` — schema-INVALID against the node type's own contract.
3. `chatCompletion()` destructures `const { provider, model } = ctx.config` and
   passes both to `ctx.callAI` unchecked.
4. `assertProviderSupported` interpolated the undefined into its message.
5. **Nothing validated chain node config against the node type's `configSchema`
   between authoring and dispatch.** `expandChain` refuses an unresolvable
   *typeId* (RFC 0013 R8) but never looked at *config*.

Scanning every chain pack against every node type's `configSchema.required`:
**125 nodes across 33 packs** shipped without required config — roughly 90 of
them AI nodes that could never run. The shipped gallery's AI workflows were
broadly non-functional.

## Decision

### D1 — Absence is not a value (P1)

`assertProviderSupported` now distinguishes an ABSENT provider from an
UNSUPPORTED one, throwing `invalid_request` with a message naming the real fault.
`invalid_request` already exists in `AiProviderErrorCode` and already maps to
`category:'config' / action:'reconfigure'`, so this adds no code and no wire
surface.

### D2 — Validate node config at the expansion seam, REPORT-ONLY (P2)

`findMissingRequiredConfig(chain, requiredConfigKeysFor)` is the one rule;
`expandChain` reports through it when a caller supplies the key source
(`nodeCatalogBuilder.requiredConfigKeysFor`, memoized like `nodeRoleMap`).

**It reports; it does not refuse.** See D5.

The NO-GROWTH ratchet `chain-config-conformance.test.ts` is what makes
report-only bite: the count may only shrink.

### D3 — Fix the content with PARAMETERS, not hard-coded vendor ids (P3)

The ~78 AI nodes now bind `config.provider` / `config.model` to
`{{params.provider}}` / `{{params.model}}`, with the chain declaring those
parameters **with defaults** (`anthropic` / `claude-sonnet-4-6` —
`providers.json`'s own `recommended` entry).

Expansion FREEZES the resolved value into the definition, which is what keeps
replay deterministic: `aiProvidersHost`'s `providerKey` hashes provider+model
into the Layer-2 invocation-log cache key, so resolving per-dispatch instead
would make a catalog change silently re-dispatch on replay.

> **The default is load-bearing.** A whole-value `{{params.X}}` token with no
> value resolves to `undefined` (`resolveTokenString`), so parameterizing WITHOUT
> a default reproduces the bug one layer along. Three in-tree packs
> (`production-plan`, `creative-briefs-reel`, `kicktodo-challenge-factory`) had
> exactly that shape and were cited by the author as the "established pattern"
> before the flaw was noticed.

### D4 — No-defensible-default config becomes a REQUIRED parameter (P5)

41 more nodes — `core.trigger.{event,webhook,schedule}` (`eventName`/`path`/
`cron`), `email-send.from`, `slack-message.channel` — take a declared-**required**
chain parameter with no default. A wrong cron runs at the wrong time and a wrong
`from` mails from the wrong address, so inventing a value is worse than leaving a
blank the author completes in the builder (where the preflight modal already
renders it as required).

### D5 — Required-param enforcement was REVERTED, deliberately

An earlier cut made `expandChain` refuse a Path-A expansion whose required
params were unresolved. It was reverted after it broke two documented contracts:

- **"Use template = just copy — copies without a form"**, asserted by
  `workflow-from-chain-route.test.ts` and stated in `TemplatePreflightModal`.
- **`seedWorkflows.ts:71`** expands every seeded chain with `expandChain(chain, {})`,
  so a throw would fail workspace seeding for every chain with a required param.

The incident is fixed by content carrying real defaults, not by refusing the copy.

## Correction record (what the reviews caught)

| # | Defect in the fix | Correction |
|---|---|---|
| HIGH | The runtime check was wired to the sub-chain branch of `from-chain` — the branch **2 of 169** chains take, excluding the incident chain. The fix had the built-but-unreachable shape it was written to remove. | Wired to both branches. |
| HIGH | The name-matched transform put `default:"anthropic"` on `creative-briefs-reel`'s `provider`, which is a **video** provider (`heygen`/`replicate`) — substituting a WRONG value for a missing one, the very class D1 exists to eliminate. | Hunk reverted. |
| HIGH | Nested sub-chain recursion dropped the flags. | Report forwarded; enforcement deliberately NOT (children expand with `params:{}` by design — `kicktodo.lesson-batch` requires 3 params and would have broken). |
| MED | Only the mechanism was tested, never the wiring — which is how the HIGH above survived. | Route-level tests POST `from-chain` and assert the minted definition. |
| MED | 73 packs duplicate a `providers.json` value the model sweep won't update. | Drift ratchet asserts every pack default still exists in the catalog. |
| — | A `json.dumps` round-trip reformatted the packs into a 5,858-line diff. | Formatting-preserving text transform; 505 lines, zero value changes. |

## Correction record 2 — what the grade trio caught (2026-07-28)

Three graders ran independently and two reached the same conclusion by different
methods: **the ratchet was measuring the wrong artifact.**

| # | Finding | Correction |
|---|---|---|
| **Blocker** | The rule counted a `{{params.X}}` token as present whenever X was declared required. But D5 reverted enforcement and `seedWorkflows` expands with `{}`, so expansion DROPS the key and the minted node ships `config: {}` — the incident shape. Proven by execution on `commerce.post-purchase-thankyou`. `/grade-code` computed the honest ceiling as **46**; `/grade-data` independently measured undefined-frozen config keys going **63 → 98** while the ratchet read 125 → 6. **A gate that improves while the thing it gates gets worse is not a gate.** | Rule + runtime report now evaluate the **expanded definition** of a blank copy. Ceiling honestly **46**. D4's required-param exemption removed. |
| **Blocker (UX)** | After Confirm, nothing said the workflow was incomplete — no badge, no banner, an enabled Run button. The host computed the finding and only `log.warn`ed it. | `from-chain` returns `incompleteNodes` (additive, same shape as `warnings`); the builder toasts the missing fields. Route-tested both ways. |
| **High** | `packs/feature.kicktodo.nodes` defaulted to `claude-sonnet-5` at 4 sites — a model in no catalog — reachable from 2 chains. | → `claude-sonnet-4-6`. |
| **High** | Five of my own `webhookPath` defaults violate the node's own `configSchema` pattern `^/…`. Nothing validated config VALUES against the schema. | Prefixed; value-level pattern check added. |
| **High** | Corrupt JSON shipped: **three** duplicate `"default"` keys in one object, from my repair script running non-idempotently. `JSON.parse` is last-wins, so the shipped value was right **by luck**. | Collapsed; raw-text duplicate-key scan added (JSON.parse cannot see these). |
| **Med** | The modal's Inputs blurb promised *"every run asks for what it still needs"* — false under Path A. The component docblock had been corrected; the four user-facing locale strings had not. | Rewritten ×4. |
| **Med** | A green *"ready to go"* chip rendered above blank required fields on 117 chains. | `zeroConfig` now includes `missingRequired`. |
| **Med** | The flow's only failure state was silent to screen readers. | `Notice announce` added. |
| **Med** | A comment claimed the route ENFORCES required params and refuses with `chain_missing_required_param` — a code that exists nowhere. | Corrected in place. |

## Open

> Live as of #2671. The two ratchets are the source of truth
> (`chain-config-conformance.test.ts`); this list is their composition, and the
> earlier version of this section went stale within a day of being written — it
> still listed the predicates, the seed lane and "inputs are unratcheted" as open
> after #2671 closed all three. Numbers here are computed, not remembered.

### Read these numbers as EXPANDED, not authored

The single most confusing thing about this table, and a careful `/architect` pass
got it wrong: **`email-send` ×13 does not mean 13 chains forgot to set `from`.**
All 13 DO set it — `"from": "{{params.senderEmail}}"`. But `senderEmail` has no
default, required-param enforcement was reverted (D5), and the documented "just
copy" path expands with `params: {}` — so the token resolves to `undefined` and
expansion DROPS the key. The node that actually ships carries no `from`.

Authored-conformant and expanded-broken are different states, and only the second
one runs. Measuring the first is what produced the dishonest 6 (see Correction
record 2). Every count below is the expanded form.

### Missing required CONFIG — ceiling 42

| Node type | Count | Nature |
|---|---:|---|
| `integration.email-send` (`from`) | 13 | tenant sender address — see the contract question below |
| `trigger.event` (`eventName`) | 12 | author-knowable per chain |
| `trigger.schedule` (`cron`) | 6 | author-knowable; a wrong cron runs at the wrong time |
| `integration.slack-message` (`channel`) | 4 | tenant/operator value |
| `http.fetch` | 3 | author-knowable |
| `trigger.form` (`formSchema`) | 2 | structured; needs real authoring |
| `http.openapi-call` | 2 | author-knowable |

### Unbound required INPUTS (missing 2+) — ceiling 72

| Node type | Count |
|---|---:|
| `integration.notification-push` | **55** |
| `integration.email-send` | 10 |
| `market-intel.*` | 5 |
| `storage.blob-put`, `http.webhook-verify` | 2 |

### The 55 are a CONTRACT defect, not content debt

`notification-push` declares `required: ["deviceToken","title"]` and the pack
passes `ctx.inputs.deviceToken` straight to the Expo adapter. **Zero of the 55
shipped nodes bind `deviceToken`, and none plausibly could** — a device token is
a per-recipient RUNTIME value, not something a chain author knows. With it
undefined the adapter POSTs `to: undefined`, Expo errors, and the node returns
`status:'success'` with `sent:false`: a run whose only outbound action failed
completes GREEN.

So "author the bindings" is the wrong fix for the largest item on this list.

**`/architect` ruling (2026-07-29): the schema is RIGHT and the chains are wrong.**
`deviceToken` genuinely is required for an Expo/APNS *device push*. What the 55
chains want is an **in-app inbox notification** — `workflow-chain-knowledge-inbox.test.ts`
even calls it "in-app notification-push". That concept already has exactly one
owner, `notifications/emitter.ts` (durable row + SSE + Web Push + Teams + email),
and **no node exposes it**. The fix is a host-owned `feature.notifications.nodes`
node over the existing emitter, with the recipient taken from the RUN
(`actingUserId`) and no recipient input at all — the same self-scope floor
`notifications/agentTools.ts` already uses. Then retarget the 55.

Three findings from that pass that change the shape of the work:

1. **Nothing validates node `inputs` against `inputSchemaRef` anywhere in the
   executor.** `required` on a node-pack input schema is, today, a documentation
   claim with zero runtime enforcement. So relaxing the schema would buy no
   behaviour at all — and the real ratchet is an Ajv gate at dispatch, which is
   pure host work with no pack or RFC dependency.
2. **`packs/` in THIS repo is not the SSoT.** `scripts/sync-packs.sh` does
   `rm -rf packs/core.openwop.*` before re-copying from `../openwop-registry`, so
   an in-repo edit to a `core.openwop.*` pack is destroyed on the next sync. Any
   fix to those packs is a registry change + a signed republish + a re-vendor.
3. **`emitRunCompletedNotification` has zero production callers** — a
   platform-level surfacing floor that was written and never wired.

Also: the 3 `email-send` nodes that DO bind inputs bind `from`/`body`, neither of
which is a property of `email-send.input.json` (`additionalProperties: false`),
and its `anyOf: [text | html]` is satisfied by none of the 13 — so even the
"good" ones would send an empty body.

**No RFC.** `ctx.notification` is host-local and appears nowhere in
`../openwop/spec/v1/` or `RFCS/`; node-pack schemas are not the wire.

The same question, smaller, for `email-send`: `to`/`subject` ARE chain-derivable,
but `from` is a tenant sender address that arguably belongs in an operator
setting (the BYOK/Stripe pattern) rather than chain config.

### Still open elsewhere

- **No app-tier migration** for `from-chain` instances minted before #2652: they
  keep `config: {}` and stay dead, now with a better error. An `APP_MIGRATIONS`
  entry re-expanding `wfreg:` rows must be guarded by a run-existence check —
  rewriting a definition under a recorded run is the hazard #2671 just closed.
- **Cross-tenant write on shared `wf.seed.*` rows** — one global definition row,
  and `isWriteProtected` deliberately lets a seeding tenant self-overwrite, so
  tenant A's builder autosave rewrites what tenant B runs. Pre-existing; wants
  its own ADR (copy-on-write on first edit).
- **A sweep for other tests that pin a defect as a contract.** Eight execution
  test files asserted `provider_not_supported` under names like *"fails cleanly
  at the AI node (no provider configured)"* — that is why a broadly broken
  gallery survived review after review. Fixed there; the pattern is almost
  certainly not confined to those eight.

## Correction record 3 — the INPUT half, and the branch nobody could take (2026-07-30)

The sweep this ADR asked for ("a sweep for other tests that pin a defect as a
contract", above) found the config half was only half the class. Two families,
both of which ran GREEN:

**1. `core.flow.if` never took its `then` branch — 4 chains.** #2671 fixed these
nodes' empty `config` (a hard TypeError). That stopped the crash and left the
defect: the inbound edge was portless, so `buildInputs` landed the payload on
port `input` (`scheduler.ts`) while `ifNode` reads `ctx.inputs.value`. The
predicate evaluated `undefined`, every op returns false for `undefined`, and the
node returned `branch: 'else'` on every run — forever, silently, because `else`
is a legitimate verdict.

| Chain | What the dead `then` branch cost |
|---|---|
| `starters.verified-webhook-router` | every webhook it just verified as VALID was dropped |
| `support.kb-answer` | a high-confidence answer was never delivered |
| `support.sentiment-escalation` | every message escalated, regardless of brand risk |
| `marketing.ad-optimization` | a change inside the guardrail never auto-applied |

Fixed by pointing each edge at the port the node reads (e.g.
`diagnose.content → guard.value`). Ratcheted structurally
(`chain-branch-node-reachability.test.ts`) and behaviourally
(`chain-branch-node-execution.test.ts` drives the real `ifNode` with the real
expanded edges and asserts BOTH branches are reachable).

**2. The `email-send` envelope — 13 chains, not 3.** The §Open note above was
right that the three binding nodes bound `from`/`body`, neither a property of
`email-send.input.json` (`additionalProperties:false`, and the impl destructures
`text`/`html`). It understated the rest: the other ten bound **nothing at all**
— no `to`, no `subject`, no body. Every email-sending chain in the shipped
gallery sent to nobody. `ctx.email.send` degrades an unconfigured provider to
`{sent:false, error:'email_not_connected'}` without echoing the attempted
recipient, so no real-executor test could tell "right recipient, no connection"
from "`to: undefined`" — which is why `campaign-journeys`' test asserted the
degrade as the contract.

The claim that blocked it — *"no pack.json-only edge/config combination
populates them"* — was false twice over: a dot-notation edge does not need key
names to align, and the producer already existed. The eligibility node's own
docstring reads *"Eligible ⇒ outputs {email, name} **for the downstream send
step**"*. Built, documented, never connected — the same failure as
`feature.kb.nodes.rag` (#2692).

Fixed: `campaign-journeys` takes `to` from its gate's `email` output; the other
ten declare a `recipientEmail` param (no upstream producer exists) plus a
defaulted `emailSubject`, and take the body from their drafting node's `content`
(the approval gate outputs only `{decision, approved, …}` — it does not forward
the draft). Ratcheted by `chain-email-envelope-wiring.test.ts`.

> **Caveat, added by the 2026-07-31 grade pass — read this before trusting the
> word "fixed" above.** That ratchet reads the AUTHORED `node.inputs` keys, and so
> does `unboundInputs`. Path A freezes `{{params.X}}`, and a param with no value
> resolves to `undefined`, so expanding a blank copy yields a node whose `to` is
> not usable. **Correction (2026-08-01): the key is NOT dropped — it survives
> holding `undefined`** (`hasOwnProperty('to') === true`, `typeof inputs.to ===
> 'undefined'`). The earlier "dropped" wording here came from reading
> `JSON.stringify(inputs)`, which omits undefined-valued keys and prints
> `{"subject":"…"}`. The distinction matters: present-and-undefined is STRICTLY
> WORSE than absent, because a key-presence ratchet reports it as BOUND — the
> `Provider "undefined"` shape one layer along. **This is Correction record 2's mistake recurring in the input
> half: a gate that improves while the thing it gates does not.** It is not a
> silent failure — ADR 0504's `findUnfilledExpansionParams` names exactly these
> params on the `from-chain` response, and `missingRequired` feeds the preflight
> chip — but the honest claim is narrower than "fixed": a FORM-INSTANTIATED chain
> now works, and a blank copy is still incomplete with the host saying so by name.
> The durable fix is to evaluate `expandChain(chain, {params:{}})` the way the
> CONFIG ratchet already learned to. Tracked as `GRD-5` in `docs/steward/CODEBASE-ASSESSMENT.md`.

**The generalisable lesson.** Both families were *already documented* — one in
this ADR, one in a test docblock — and both were understated because the person
writing the note measured the instance in front of them rather than the shape.
`email-send` ×10 in the §Open table was read as content debt; it was a total
outage of every email path in the gallery. **When a defect is documented, scan
for its shape before believing the count.**

Publishing note: `examples/workflow-chain-packs/` is signature-verified only when
installed from the registry (`root === registryInstallDir`), so these in-repo
edits load as-is. Pushing them to packs.openwop.dev is a separate signed
republish.

## Correction record 4 — DATA-1 (Phase D), and the retarget's own collateral (2026-08-02)

**DATA-1 shipped, but not as designed — and the phase that preceded it had to be
repaired first.**

### The design that was rejected

Phase D's job: tenants seeded before the Phase B/C retarget still hold definitions
carrying `core.openwop.integration.notification-push` (`seedWorkflows` is "seeded
once, never rewritten"). The first implementation re-expanded the chain and
replaced the whole persisted definition, guarded per-run — because
`deterministicExpansionId` hashes `chainId@version:params` and all 23 packs were
bumped, so every node id changed (`157849946cdb` → `8f254cf75b30`), and any run
resolving HEAD would find no matching checkpoints (#2671).

Two independent reviews killed it:

- **`/ux-review`** found the consequence the guard's own docblock did not mention:
  these `wf.seed.*` rows are tenant-owned and builder-editable (`recordOwnership`),
  so a wholesale rebuild REVERTS tenant edits and drops everything in `metadata`
  except `name` — `requiresAgentId` ("erasing it silently stops enforcement"),
  `retention.ttlDays`, `lifecycle`, the walkthrough binding. That reclassifies the
  change from *incomplete coverage* to *data loss*.
- **`/architect`** named the dominant force — single source of truth for
  tenant-authored content — and pointed out that the guard already conceded the
  heaviest users stay broken forever. An approach that strands them AND destroys
  everyone else's edits has nothing to recommend it.

### What shipped instead

A **surgical** edit. `git show 91e398f52 -- examples/workflow-chain-packs` shows
the retarget was purely node-local: same node id, same position, same edges, only
`typeId`/`config`/`inputs` moved, and all 55 nodes had `config:{}`+`inputs:{}`
before. So the migration copies exactly those three fields onto the existing node
and touches nothing else. The pack node id is recovered from the row's OWN
`metadata.chainId`/`expansionId` (the prefix rule at
`workflowChainPackLoader.ts:894`), not by suffix matching, which would collide.

Because node ids are preserved, `hydrateSnapshot`'s by-node-id checkpoint overlay
still matches — **both run guards were deleted** and every affected install is
repaired. A no-match or a ref-bearing replacement is skipped and counted, never
synthesized.

> **Correction (grade-data `WF-MIG15-1`) — the guard that replaced them was
> VACUOUS.** The first cut of this design kept one skip, on `workflowRoomLive`,
> citing ADR 0481 D2. But `workflowCollabResource.ts:45` refuses
> `^(wf\.seed\.|tmpl\.|openwop-app\.)` outright, so **no collab room can ever
> exist for a `wf.seed.*` id** — the branch was unreachable in production, and the
> test "proving" it passed only because it mocked `workflowRoomLive` to return
> true. A guard that tests only itself. It also pointed at the wrong racer: the
> real one is the builder's REST autosave, which `routes/workflows.ts:185`
> deliberately permits for a tenant's own seeded copy, with no CAS.
>
> Replaced by a **re-read immediately before the write**, with the patch built
> from the latest copy — which narrows the window to two awaits and *preserves* a
> concurrent save instead of clobbering it. This is the "sabotage probes can be
> vacuous" lesson recurring: my probe disabled the branch and the test went red,
> which proved the assertion was load-bearing **on the mock**, not that the branch
> could ever execute.

**Honest scope:** this fixes HEAD, so new runs, unpinned resumes and branch forks.
A run that pinned `definitionRevision` resolves its own content-addressed row and
keeps the old node. It also covers `wf.seed.*` only — 42 parameterized
notify-carrying chains reach tenants as `wf.<slug>.<uuid>` `from-chain` copies
(`GRD-9`).

### The prerequisite nobody had noticed: the retarget left ADR 0341

`feature.notifications.nodes.notify` matched no pattern in
`executor/sideEffects.ts`, whose `^core\.openwop\.integration\.` family had
covered the retired node. So #2871 silently moved 55 nodes OUT of replay-fork
protection, while the new node's own docblock claimed *"outputs are recorded so
replay/fork read the recorded verdict rather than re-notifying."* A pack `.mjs`
node cannot self-declare (`NodeModule.sideEffecting` is programmatic-only), which
is why `feature.whatsapp.nodes.send` needed the same explicit entry. Fixed, and
ratcheted by a rule anchored on the emitter seam rather than on node names.

### The retarget corrupted 65 nodes it was not supposed to touch

The #2871 commit message confessed three scripted-substitution mistakes. It missed
the biggest: the same position-anchored regex wrote onto NEIGHBOURING nodes.
Measured against `91e398f52^`:

| | before | after |
|---|---|---|
| non-notify nodes with `config.audience` | 0 | **24** |
| non-notify nodes with a stray `inputs.title` | 0 | **41** |
| notify nodes titled with the WRONG chain's label | 0 | **6** |

That is **65 stray keys across 58 nodes** (7 received both), plus the 6 swapped
titles. #2871's writes were purely ADDITIVE — no authored value was destroyed by
it.

> **Correction (same-day, from the grade pass).** An earlier draft of this record
> claimed #2871 had *replaced* `strategy.board-pack#persist`'s authored
> `config.title: "Board pre-read"`. It had not — that value is intact at
> `origin/main`; #2871 only appended a stray `inputs.title` alongside it. **The
> destruction was my repair script**, three paragraphs below, which then caught
> and reverted it. The draft attributed my own mistake to the commit I was
> auditing, while confessing the same mistake immediately afterward — a record
> that contradicted itself within one section. Fixed here rather than silently
> edited, because the misattribution is the more interesting failure.

Runtime impact was nil — no affected node type declares a `title` input, and ADR
0498's own config check is report-only for MISSING required keys — but 6 wrong
notification titles are user-visible (`inputs.title` is the bold inbox row title,
so a finished "Release Notes Drafter" run announced itself as "CI Failure
Explainer"; `devops.release-notes` and `devops.ci-failure-explainer` were a
cross-labelled pair). All 65 repaired by an evidence-driven per-node diff against
the parent commit; 19 packs bumped.

**And the repair script made the same class of mistake once** — a key-name regex
scoped to the node span matched `config.title` before `inputs.title` and deleted
the authored value. Caught only because the verification re-diffed every node
rather than trusting the edit. That is the generalisable lesson, again: *the fix
for a scripted-edit defect is not a better regex, it is a verification pass that
compares the result to what it should have been.*

New gate, `chain-node-undeclared-keys.test.ts`: a chain may not author a key its
node type does not declare, wherever the schema says `additionalProperties:false`.
`chain-config-conformance.test.ts` is key-presence-of-required only and is
structurally blind to this direction. It carries an evidenced 8-entry baseline of
PRE-EXISTING violations that may only shrink (`GRD-8`) — one of which,
`core.storage.kv-{get,set}.config.key`, is confirmed a schema gap, since
`packs/core.openwop.storage/index.mjs:17` spreads `{...ctx.config, ...ctx.inputs}`
into the host call.

That closed-world check catches only **15 of the 65** strays, because most
receiving nodes declare `additionalProperties: true` — so the other 50 are pinned
by SHAPE in the same file (both `config.audience` and `inputs.title`, the latter
being 41 of the 65, with the 4 legitimate pre-existing notebook titles enumerated
rather than counted). Two assertions, because one corpus does not cover the
defect. Fixture-guard thresholds sit just under the real corpus (551 nodes / 364
closed-world checks), after the grade pass measured that a threshold of 100
against a reality of 364 still passes with `additionalProperties` handling
inverted — a slack threshold is a guard that has already stopped guarding.

**The ADR 0341 ratchet had the same over-claim.** Its emitter-seam scan greps pack
`.mjs` sources, and the grade pass immediately produced a counterexample it cannot
see: `feature.kicktodo.nodes.session-reminder` reaches the emitter through
`features/kicktodo-accountability/sessionService.ts`, a HOST surface, with clean
pack source. That node was likewise unclassified and is now classified explicitly;
the scan's docblock now states the one lane it actually covers. This is the repo's
own recurring lesson — *a check's summary line must describe the corpus it
actually scanned* — recurring inside the check written to enforce it.

### Residuals found by the grade pass, filed not fixed

- **The builder strips node `inputs` on save** (`builder/schema/serialize.ts`
  emits `inputs` zero times, while the definition schema lists it as required). A
  user who opens a repaired workflow and saves re-breaks it — the notify node
  returns `{emitted:false, reason:'title_required'}` under a green run,
  reconstructing the exact defect DATA-1 removes. **Pre-existing and wider than
  this ADR**: it equally threatens Correction record 3's email-envelope `inputs`.
  Tracked as `NOTIF-UX-3`.
- **A tenant who disabled the `feature.notifications.nodes` pack** gets a typeId
  absent from their per-tenant catalog after the migration, and
  `builder/schema/deserialize.ts` THROWS on an unresolved typeId — so the workflow
  refuses to OPEN, where before it opened and merely ran broken. Runs are
  unaffected (the catalog filter is authoring-only). Narrow, operator-induced,
  tracked as `NOTIF-UX-6`/`HV-NOTIF-1` for a live check before the next deploy.
- **No notify node authors `inputs.message`** (0 of 55), so every workflow
  notification is a bare headline over an empty body element (`NOTIF-UX-2`), and a
  chain LABEL is gallery copy rather than outcome copy for a headline
  (`NOTIF-UX-1`).
- **The window's collateral is not repaired** (`WF-MIG15-2`). Of the 65 strays and
  6 wrong titles that were live for a day, **9 stray-key nodes across 5 zero-config
  chains and 3 of the 6 wrong titles** froze into `wf.seed.*` rows before the fix.
  Migration 15 cannot reach them: such a row already has `typeId === NOTIFY`, so it
  counts `alreadyClean` and skips. Bounded — nothing validates node config/inputs
  at run time — but 3 wrong notification titles are durable user-visible text.
  A backfill needs a predicate that can tell frozen corruption from a tenant's own
  edit; "the title equals a DIFFERENT chain's label" is that predicate, and it is
  the natural shape for the `GRD-9` pass rather than a same-PR bolt-on.
- **A stale installed chain pack silently defeats the migration** (`WF-MIG15-5`).
  `defaultWorkflowChainPackRoots()` puts `~/.openwop-packs` ahead of `examples/`,
  first-root-wins, shadow logged not raised — so an older installed
  `core.openwop.workflows.*` expands the stale chain, yields no replacement, sends
  every chain to `skippedUnmatchedNode`, and the migration still records itself
  complete forever. Prod is not exposed (its pin list covers node packs only; the
  chain packs are vendored into the image), a self-hosted install is. Mitigated
  here by a loud `notify_retarget_unmatched` warning naming the likely cause,
  because the counter alone reads as a clean run.

## RFC gate

**No RFC.** Node-pack config schemas and chain-pack *content* are not the OpenWOP
wire; RFC 0013 governs the chain *format*, which is unchanged. `invalid_request`
is a re-classification within an existing error union, not a new code. The
edge/param edits in Correction record 3 are chain *content* under the unchanged
RFC 0013 format.
