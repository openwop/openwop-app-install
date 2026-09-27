# ADR 0505 — Tell the truth about the pinned AI provider

Status: Accepted

Closes ADR 0502 §Open-2. Adds a correction note to **ADR 0498** and records a
scope limitation in the RFC 0031 capability gate.

## Context

29 chain packs pin `provider: "anthropic"`, so every seeded AI workflow fails
`byok_required` for any tenant without an Anthropic key — including every
signed-in user on the managed free tier. Reproduced live (prod rev `00581-2nl`,
2026-07-29): the Challenge Factory's `extract-claims` node died with

```
byok_required: No credential available for provider "anthropic".
The host looks up secrets[provider] then any secret prefixed with
"anthropic-" or "anthropic:". Available refs: (none).
```

The obvious reading — "the hard-coded default is an oversight, remove it" — is
**wrong**, and acting on it would have regressed a fixed production outage.

## What the investigation found

**The pin is deliberate and load-bearing.** `"default": "anthropic"` is ADR 0498's
fix for a real outage (`provider_not_supported: Provider "undefined"`, 125 AI
nodes across 33 packs shipping `config:{}`). `chain-ai-provider-resolution.test.ts`
states why freezing matters: `providerKey` hashes provider+model into the
Layer-2 invocation-log cache key, and LLM nodes re-execute live on replay, so
resolving per-dispatch would produce a cache miss and **silently substitute a
model on replay/fork**.

**There is already a ruling on the fallback question.** `aiProvidersHost.ts:565`
records DEBT-3 (ADR-0355-thread architect review, 2026-07-12) as *decided
won't-fix*: do not fill a catalog default at dispatch; the only sanctioned route
is "a model-independent cache-key sentinel that records the resolved model in the
cached value."

**Per-tenant resolution at instantiation is worse, not better.** Node ids derive
from `deterministicExpansionId(chain, params)`, so a per-tenant provider forks
every node id — and the seeded lane writes **one global `wfreg:` row keyed by
workflowId with no tenant component**. Tenants would overwrite each other's
definitions: verbatim the incident `seedWorkflows.ts` already documents.

**So the failure is correct behaviour.** What was wrong was everything the app
*said* about it.

## Decision

Fix the honesty, not the pin.

1. **27 packs described the param as "Defaults to the host's chat-class
   preference."** They do not — they freeze the literal `anthropic`. The text read
   as plausible only because `MODEL_CLASS_DEFAULTS.chat` happens to hold the same
   value, describing a mechanism that was never wired. Replaced across 70
   occurrences with what actually happens, including the consequence: whichever
   provider you pick, the workspace needs a key for it, and there is no fallback.
2. **`byok_required` now names the two real exits** — add a key in Settings →
   Secrets Vault, or re-create the workflow on a provider you have — and states
   plainly that it will not fall back on its own, so the reader knows retrying
   cannot help. The old text narrated the resolver's internals
   (`secrets[provider]`, prefix matching) to someone who cannot act on them.
   `availableRefs` stays in `details` for operators: ref **names** only, never
   values.
3. **A ratchet** pins both, with a corpus-loaded precondition so an empty sweep
   cannot read as clean.

### Explicitly NOT done

**No silent fallback to the managed tier.** It is the won't-fixed DEBT-3, and it
would turn a loud correct refusal into a quiet model downgrade — the
"looks-like-it-worked" family this line of work exists to remove.

**No `credentialRef: managed:openwop-free` on the evidence nodes.** It is
otherwise the right convention — it is authored config, so replay-neutral, and the
managed path already owns sign-in gating and daily caps, which answers the
unattributed-cost objection. But `claim-extract` dispatches with a live
`responseSchema`, and `openwop-free` is absent from `PROVIDER_CAPABILITIES`
entirely: it advertises **no** model capabilities. Pinning it there would work
today only because the node omits `requiredModelCapabilities` — i.e. by accident,
via a missing declaration. Left for a deliberate cost decision.

**No bare `requiredModelCapabilities` declaration** — see below. It would not do
what it appears to do.

## Correction note — the RFC 0031 capability gate is host-scoped, not node-scoped

The plan for this change included declaring
`requiredModelCapabilities: ['structured-output']` on schema-bound nodes, so a
future managed pin could not silently degrade them. **That would have been
decorative.**

`executor.ts:334` evaluates the gate against `gateConfig.defaultProvider` /
`defaultModel`, and `modelCapabilityGateConfig.pickDefaultProvider` returns a
single host-wide provider (`OPENWOP_DEFAULT_AI_PROVIDER`, else
`supportedProviders[0]`). It never sees the node's own `{{params.provider}}` or
`credentialRef` — `executor.ts:325` names intercepting those as "a future
refinement requiring `dispatchPlain()` interception."

So the declaration would be checked against the host default (Anthropic, which
*has* `structured-output`), pass, and protect nothing — while looking like a
guard. Adding it was dropped for exactly the reason this ADR exists.

## Implementation record

| Phase | Change | Test |
|---|---|---|
| 1 | 70 false descriptions across 27 packs replaced | `provider-pin-honesty.test.ts` |
| 2 | `byok_required` names both exits + the no-fallback fact | same |
| 3 | Ratchet with a corpus-loaded precondition | same |

Sabotage-probed: reintroducing the false claim in one pack failed only the pack
assertion; restoring the old error text failed only the internals assertion.

## Open questions

1. **The capability gate cannot see per-node providers.** Until `dispatchPlain()`
   interception lands, `requiredModelCapabilities` is only meaningful against the
   host default. Any future work relying on it to protect a specific node is
   building on sand.
2. **`claim-extract` uses `responseSchema` and declares no capability
   requirement.** Honest only by omission; it becomes a real gap the moment the
   gate gains node scope.
3. **Zero-BYOK users still cannot run the Challenge Factory.** That is the honest
   state: the Factory needs structured output and the free tier cannot truthfully
   claim it. Changes if `openwop-free` earns a verified `PROVIDER_CAPABILITIES`
   entry.
4. **DEBT-3's sentinel** — recording the resolved model in the cached value would
   unlock a replay-safe host default and supersede much of this.
