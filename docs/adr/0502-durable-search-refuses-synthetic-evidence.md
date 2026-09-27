# ADR 0502 — A durable search caller refuses rather than receiving synthetic evidence

Status: Accepted

Supersedes nothing. Adds correction notes to **ADR 0101 Phase 4**, **ADR 0494**, and
**ADR 0498**.

## Context

On 2026-07-29 the Challenge Factory was driven end-to-end against production
(`openwop-app-backend-00581-2nl`) for the first time since the ADR 0494 evidence
pipeline shipped. The deployed chain was confirmed complete —
`research-frame → search → normalize → fetch → extract-claims → verify-claims →
evidence-graph → plan-generate`, with `missingNodeTypeIds: []`. The run still
produced no evidence, and the reason was not the one the ADRs predicted.

**No web-search key is configured on the deployment.** `core.web.search` returned
`engine: "demo"` and a single synthetic result:
`https://duckduckgo.com/?q=walking+20+minutes+a+day+for+health`. That is a
*search-results page*, not a source. What happened next is the defect:

- `core.web.fetch` **fetched it successfully** — `pages: 1, failed: []`. Nothing in
  the pipeline distinguishes a synthetic placeholder from a real source, because a
  DuckDuckGo query URL is a perfectly valid, fetchable HTTP resource.
- `extract-claims` then **started**, spending a model call extracting "claims" from
  a search-engine results page.
- The `engineIsDurable` guard in `recordResearch` would only have refused at
  `evidence-graph` — **two nodes and one model call later**.

So the pipeline was fail-closed in the end, but only after paying to process
fabricated input. That is the wrong place for the gate.

### Why the existing mechanism did not fire

ADR 0101 Phase 4 introduced exactly the right concept — `suitability: 'durable'`,
a licensing predicate for callers that will *store* citations. It shipped correct
and **completely dormant on the one pipeline it was built for**. Two independent
reasons, both required:

1. **The Factory chain never asked.** Its search node authored only
   `inputs: { query, maxResults }` — no `suitability` — so it defaulted to
   `answer-only`.
2. **Asking would not have helped.** `suitability` gated only *which native
   provider qualified*. Both demo fallbacks in `search()` — the no-adapter path and
   the provider-error path — returned `exampleSearch()` regardless of suitability.
   `research()`, the composed op an evidence pipeline is most likely to reach for,
   did not forward the parameter at all.

A third signal confirms the leak was known and worked around rather than fixed:
`examples/workflow-chain-packs/research/pack.json` instructs its synthesis model in
the *prompt* to notice `engine: 'demo'` and disclaim its own output. Asking the
model to detect that the host lied to it is not a gate.

## Decision

**A `durable` search caller receives a typed refusal, never a demo marker.**

1. `webResearchSurface.search()` throws `DurableSearchUnavailableError` on both
   fallback paths when `suitability === 'durable'`, carrying a `reason`
   (`no_adapter` | `provider_failed`) and the code `research_adapter_unconfigured`.
2. `research()` forwards `suitability` instead of dropping it.
3. `core.web.search` reads `suitability` from **`inputs` as well as `config`**, and
   maps the typed error to a `research_adapter_unconfigured` node failure rather
   than a generic `internal_error`.
4. The two evidence-storing chains — `kicktodo-challenge-factory` and
   `kicktodo-research`, both of which terminate in `evidence-graph` →
   `recordResearch` — declare `suitability: "durable"`.
5. A pack-level test asserts (4) directly, separately from the mechanism tests.

The `answer-only` default is unchanged: an ordinary lookup still degrades to the
honest demo marker, which is the correct behaviour for a caller that displays
results rather than storing them.

### The principle

> "No evidence" and "synthetic evidence" must never be the same value.

A consumer that can degrade should degrade. A consumer that will persist a claim
and put it in front of a human approver cannot. Refusing for durable callers is
precisely what makes the demo marker *safe to keep* for everyone else.

## Alternatives considered

| Option | Why not |
|---|---|
| Gate at `recordResearch` only (status quo) | Correct outcome, wrong place — the run pays for fetch + a model call on fabricated input first, and the error names an internal store rather than the missing configuration. |
| Make `exampleSearch()` return an unfetchable URL | Treats the symptom. Any durable caller would still receive a result object it believes is evidence. |
| Refuse in `core.web.search` at the call site | Would need copying into every caller of the surface; ADR 0101 established the surface as the single owner of this predicate. |
| Prompt the model to detect `engine: 'demo'` | The existing workaround in the `research` pack. Delegates a host invariant to model compliance — the exact pattern `docs/steward/LLM-EXCHANGE-AUDIT.md` forbids. |

## Correction notes

**ADR 0101 Phase 4** — the Phase 4 record claims the durable suitability gate
protects storable-citation consumers. It defined the predicate but wired it only
into the *agent-tool pre-flight*. Any caller reaching the chain lane (the builder
gallery, `POST …/workflows/from-chain`, a scheduled run) bypassed it entirely, and
the surface would have returned demo results even if asked for durable. The
mechanism was real; the coverage claim was not.

**ADR 0494** — Phase 2's evidence pipeline is correct and now demonstrably
deployed, but its guarantees were never exercised in production because the
pipeline's *first* node silently supplied synthetic input. Building claim
extraction and entailment on top of an ungated source lane meant the strongest
part of the system was defending the wrong boundary.

**ADR 0498** — the report-only missing-required-config check did not fire for this
defect, and would not have. It reads `node.config` against the catalog's
`configSchema.required`; `core.web.search` is an in-tree builtin with no
`configSchema`, and its `query` rides `inputs`. Confirmed empirically: zero
`chain_node_missing_required_config` log lines for an instantiation whose search
node had `query: ""`. This is the ADR 0498 lesson — *a gate that measures the wrong
artifact is not a gate* — recurring one layer over. Closing it is tracked
separately (see Open questions).

## Implementation record

| Phase | Change | Test |
|---|---|---|
| 1 | `DurableSearchUnavailableError`; both `search()` fallbacks refuse for durable callers | `durable-search-gate.test.ts` — refusal, reason, provider-failure, no-false-refusal |
| 2 | `research()` forwards `suitability` | same file — forwarding test |
| 3 | `core.web.search` reads `inputs.suitability`; maps the typed error | same file |
| 4 | Factory + research chains declare `durable` | same file — pack-level assertions |

Each assertion was sabotage-probed independently: stripping the pack flag failed
only the pack test; un-forwarding `research()` failed only the forwarding test;
neutering the no-adapter throw failed exactly the three tests that depend on it,
leaving the provider-failure and live-provider assertions green.

## Open questions

1. **The ADR 0498 gate's blind spots** — extend the missing-required-config check
   to `inputs` and to builtin nodes with no `configSchema`, and enforce at **run
   start** rather than instantiation (instantiation-time refusal is what the
   ADR 0498 revert established would break "Use template = just copy"). Not in this
   change.
2. **The Factory hard-defaults to `provider: "anthropic"`**, so it fails
   `byok_required` for any user on the managed free provider — including every
   signed-in user who has not added an Anthropic key. The sim nodes correctly pin
   `credentialRef: managed:openwop-free`; the evidence nodes do not.
3. **Unexplained `node.started` on `decompose`** in a run whose `extract-claims`
   had already failed. Possibly consistent with the documented `none_failed`
   barrier semantics; not reproduced, not diagnosed.
4. **The live pipeline is still unverified end-to-end.** With no key configured, the
   four ADR 0494 unknowns — real-source fetch success rate, `span` quality,
   second-opinion disagreement rate, and cost per run — remain unmeasured. This
   change makes the no-key case fail honestly and early; it does not prove the
   with-key case works.

---

## §Correction 2026-08-02 — the refusal was honest; the CONFIGURATION was still invisible

This ADR made an unconfigured host fail *honestly* at the search node instead of
fabricating a source. Correct, and it holds. But it left the operator with no way
to close the loop, and that gap is what actually kept `OPS-SEARCH-1` open for four
sessions.

**Measured, not assumed.** Probed live on 2026-08-02,
`/readiness` returned `status: ready` with `checks` = `[managedProviders, config,
storage]` — no search signal of any kind. The only way to answer "is the key set?"
was to run a research workflow and read `engine: "demo"` off a run event. So an
admin who had just set the Vault key could not confirm it landed, and the honest
refusal this ADR shipped read the same whether the key was missing, misspelled, or
resolving fine but shadowed by `OPENWOP_BYOK_EPHEMERAL=true`.

`routes/health.ts` had already made exactly this argument for managed providers —
an unconfigured provider "used to be invisible until a user ran a workflow" — so
the fix is that block's sibling, not a new idea: `checks.webSearch`
`{configured, source, probeError?}`.

Three properties, each of which had to be argued rather than assumed:

1. **It is REPORTED, never gating.** Search is optional; a host running
   non-research workflows is genuinely healthy without it. 503-ing would be the
   dishonest inverse of the problem being fixed. Test-enforced *differentially* —
   flipping the key must not move the readiness verdict either way.
2. **It is three-valued.** The vault probe is wrapped in a `try/catch` so it cannot
   500 an unauthenticated endpoint, and the first version of that catch was silent
   — which would have reported a *failed read* as "no key configured", telling an
   operator who HAD set the key that they had not. That is the failed-read-as-empty
   family this codebase keeps re-finding, reintroduced by the very change meant to
   cure it. `probeError` carries the uncertainty forward; the console renders
   "could not check", never "not configured".
3. **It is HOST-scope only and never returns key material.** `/readiness` is
   unauthenticated, so the helper deliberately takes no `tenantId` — a tenant's own
   BYOK key must not be enumerable through it. Arity is pinned by a test so that
   cannot drift.

**Process note worth keeping.** The first version of the "never gates" test passed
against a deliberately sabotaged build that DID gate on the search key. The test
env has no managed provider key, so readiness was already 503 for an unrelated
reason and the gate was invisible: 503 before, 503 after. Seeding `MINIMAX_API_KEY`
in the fixture is what makes the differential real. A green differential assertion
over an already-red baseline measures nothing — the fourth vacuous guard caught by
sabotage this session, and the second where the *baseline*, not the assertion, was
the flaw.

**Outcome, same day.** Deployed on rev `00599-bh8`, and the check did the job it
was built for on its first use: an operator set the Vault key, and
`/readiness` answered `{"configured": true, "source": "host-vault"}` — no chain
run, no reading `engine` off a run event. `OPS-SEARCH-1` is closed.

Open question 4 above still stands: a resolving key proves the CREDENTIAL is
reachable, not that the with-key pipeline is correct. Real-source fetch success
rate, `span` quality, second-opinion disagreement rate and cost per run remain
unmeasured (`VERIFY-SEARCH-1`) — the difference between "the key resolves" and
"the evidence pipeline works" is exactly the gap this ADR keeps insisting on.
