# ADR 0616 — CHAIN-EMBED-1's fix is absent from deferred mode, which is the fix CHAIN-EMBED-1 proposed

Status: Accepted

## Context

`CHAIN-EMBED-1` (ADR 0507) named a fabrication class: an EMBEDDED `{{params.x}}`
whose param has no value freezes to `''` — a valid string — so nothing fails.
`finance.invoice-ap` ships `"Extract vendor, line items, amounts, and totals from
the invoice. Invoice: {{params.invoiceText}}"`; instantiate it without the invoice
and a model is asked to extract line items from nothing, obliges, and the
fabrication reaches an approval gate for a human to rubber-stamp.

ADR 0507 shipped detection plus a remediation: `MISSING_REQUIRED_MARKER` degrades
a missing REQUIRED embedded param to `[missing: name]` instead of `''`. The
`requiredNames` argument that arms it is OPTIONAL — "omitted ⇒ today's behaviour,
so every non-chain caller is unaffected."

**Five call sites pass it. Two do not, and both are in DEFERRED mode**
(`workflowChainPackLoader.ts:1173` `materializeInputs`, `:1235` `deferredConfig`).

That matters more than an ordinary gap, because deferred mode is the remediation
`TODO.md` recommends for this very class: *"(2) instantiate content-bearing chains
in deferred mode from `from-chain`."* **The prescribed cure carries the disease**
for every position deferred mode cannot actually defer.

### What deferred mode defers, and what it does not

| authored position | deferred outcome | safe? |
|---|---|---|
| whole-value `node.inputs` token | variable-sourced `PortValue` | yes |
| `config.systemPrompt` / `config.userPrompt` | lifted into a minted PromptTemplate, token intact | yes |
| **everything else** | **expansion-time freeze, no `requiredNames`** | **no** |

`LIFTABLE_PROMPT_BODY_KEYS` is exactly `{systemPrompt, userPrompt}`. Any other
string config key carrying an embedded token takes the fallback.

### Measured

13 locations across 7 chains carry an embedded REQUIRED token in a non-liftable
key (both pack roots scanned; `packs/` has none, and no chain registered through
the unconditionally-deferred `buildChainBackedDefinition` is affected).

Expanding each with no params, the two modes disagree:

| location | non-deferred | deferred |
|---|---|---|
| `devops.stale-issues` `config.url` | `.../repos/[missing: repo]/issues` | `.../repos//issues` |
| `finance.month-end-close` `config.query` | `... [missing: period]` | `... ` |
| `it-support.incident-triage` `config.summary` | `On-call incident: [missing: alert]` | `On-call incident: ` |
| `people-hr.onboarding` `config.summary` | `Onboarding tasks: [missing: newHireName]` | `Onboarding tasks: ` |
| `support.ticket-routing` `config.summary` | `Customer request: [missing: requestText]` | `Customer request: ` |
| `content.feed-watch` `config.key` + `inputs.key` | `seen:[missing: feedUrl]` | `seen:` |
| `content.page-watch` `config.key` + `inputs.key` | `snap:[missing: pageUrl]` | `snap:` |

**Two of these are not fabrication at all — they are state collision.** `config.key`
is a KV key. `seen:` is not a degraded key, it is a *shared* one: every deferred
instantiation of `content.feed-watch` reads and writes the same row, so one
tenant's seen-set is another's. That is a data-mixing bug the fabrication framing
does not cover, and it is the reason this ADR is not merely tidying a message.

### Reachability, stated narrowly

`from-chain` defers only when the caller passes `deferred: true`
(`routes/workflows.ts:811`). The seeding path is gated by `isZeroConfig`, so a
chain with required params is never seeded, and no affected chain is registered
through `buildChainBackedDefinition`. So this needs a caller who opts into
deferred mode and omits a required param — **exactly the caller TODO.md tells
people to be.** Real, and narrower than "every instantiation".

## Decision

Pass `requiredParamNames` at both deferred call sites, so the two modes agree.

**This makes a latent breakage VISIBLE; it does not make it work.** A frozen
`"seen:[missing: feedUrl]"` never receives the value either — the position was
frozen, so no run-time supply can reach it. The choice is between a workflow that
is visibly broken at instantiation and one that silently collides on a shared key
or files a ticket titled `On-call incident: `. Visible loses nothing and stops the
silent case.

### Rejected: defer these positions properly

The complete fix is to make an embedded token in ANY string config position
deferrable — lift arbitrary config strings into templates, or materialize them as
variables — so the value can arrive at run time. That is right, and it is an
RFC 0124 extension with a migration story for already-minted definitions. It does
not belong in a patch that closes a mode disagreement, and shipping the marker
first does not foreclose it: the marker is what an unsupplied value looks like
under either design.

### Rejected: block instantiation when a required param is missing

`routes/workflows.ts` carries a §Correction recording that this enforcement was
already tried and reverted in the same commit, because it broke the stated
"Use template = just copy" product contract. Re-litigating that is out of scope.

## Consequences

- The two expansion modes stop disagreeing, so a reader of one cannot infer the
  wrong behaviour for the other.
- `content.feed-watch` / `content.page-watch` stop sharing a KV key across
  deferred instantiations.
- A deferred instantiation missing a required param now carries a greppable
  `[missing: name]` where it previously carried nothing.

## Verification

- Born-red: a test asserting mode agreement over all 13 locations fails before
  the change and passes after.
- Sabotage: reverting either call site independently must red the test — the two
  are separate arguments and a fix to one must not appear to cover the other.

## Correction note — three vacuous zeros while measuring this

The survey returned `0 affected chains` three times, each for a different reason
in my own instrument, and each would have been reported as "deferred mode is
fine":

1. `chain.params.required` — wrong path; the field is `chain.parameters.required`
   (`withRequired=0` across 180 chains).
2. `chain.nodes` — wrong path; nodes live under `chain.dag`
   (`withAuthoredEmbeddedRequired=0` while `finance.invoice-ap` visibly carries
   one).
3. A per-PARAM "deferred keeps the token" check that searched the whole
   serialized definition. A chain carrying the same param in BOTH a lifted
   `systemPrompt` and a frozen `config.url` reported "token kept" on the strength
   of the prompt alone — **checks-one-implies-all, inside the instrument built to
   find it.** Only a per-LOCATION comparison exposed the 13.

What caught all three was refusing to accept a zero without a positive control:
the survey must first reproduce the KNOWN figure (36 chains, ADR 0507) before its
novel figure means anything. **A zero from an unvalidated probe is not evidence of
absence; it is evidence of nothing.**

### A fourth instance, in the test written to catch the third

The first draft of `chain-embed-deferred-parity.test.ts` listed all 9 `config`
locations and none of the 4 `inputs` ones. It passed. **Reverting
`materializeInputs` left it passing** — so the test covered `deferredConfig`
only, and would have certified a half-fix as complete.

`config` and `inputs` are handled by two different functions with two separate
`substituteTokensDeep` arguments. Fixing both and testing one produces exactly the
evidence a correct fix produces. The sabotage is what told them apart, and only
because it reverted each call site INDEPENDENTLY rather than reverting "the fix".

With the 4 `inputs` rows added, the two sabotages red disjoint sets — 4 failures
vs 10 — which is the property worth asserting: not merely that each sabotage
fails, but that they fail DIFFERENT tests. Two sabotages reddening the same set
would mean one coverage, not two.

**Sabotage one call site, not one change.** A change that touches N places needs N
independent reversions; reverting the change as a whole tests only that something
in it mattered.
