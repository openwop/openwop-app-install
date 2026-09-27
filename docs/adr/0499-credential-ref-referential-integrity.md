# ADR 0499 — Credential-ref referential integrity

Status: Accepted

## Context

A BYOK secret is stored once, in `byok_secrets`, keyed by an opaque
`credentialRef`. Configuration all over the app then *names* that ref:
`voice:realtime-config.credentialRef`, `host:headlessAiDefault.credentialRef`,
a KB collection's `embeddingSpec.credentialRef`, an agent profile's
`configParameters.voice.credentialRef`, and the derived refs owned by
connections, compat endpoints, inbound webhooks, federation peers, and email
bounce webhooks.

Nothing keeps the two sides in agreement. Delete or rename the secret and every
config naming it silently becomes a **dangling reference**: the row still
resolves, still validates, still renders — and `resolveSecret()` returns `null`
only when something finally tries to *use* it, as a 400 far from the change that
caused it.

This is not hypothetical. On 2026-07-28 live voice was dead on the demo deploy
because `hostext:voice:realtime-config:user:c51185…` still held
`credentialRef:"google:myndhyve-key"` (set 2026-06-29) after that secret was
replaced by `google:personal` (2026-07-14). No row matching `%myndhyve%` existed
in `byok_secrets` for any tenant. The failure surfaced a month later as
`POST /voice/realtime/session → 400 credential_unavailable`, with nothing
connecting it to the vault edit that caused it.

Three separate gaps let that happen:

1. **Two delete paths, one guard.** `routes/adminVault.ts` answers this *well* —
   the ENG-2 / SEC-G4 tri-state (`known:true` with consumers / `known:true` empty
   / `known:false`), fail-closed, with the reason logged and audited, and
   `?force=true` to override deliberately. `routes/byok.ts` — the path the Keys
   page uses, and the one that actually deleted this secret — calls
   `removeSecret()` with **no check at all**. The good guard was never reachable
   from the UI people delete keys with.
2. **The guard's index is hand-kept.** `refConsumers()` is a local function
   someone must remember to extend. It had reached two entries (the headless-AI
   default binding and workflow node configs) and knew nothing about realtime
   voice, KB embedding specs, agent voices, compat endpoints, or any derived ref.
   It is precisely the "drift-prone hand-kept cascade list" that the data-grading
   rubric names as a generator of orphans — and the binding it did not know about
   is the one that broke.
3. **The admin surface hides it.** `byok/RealtimeVoiceSettings.tsx` binds
   `<SelectField value={credentialRef}>` against the list of *existing* refs. A
   ref that no longer exists matches no `<option>`, so the select renders
   **blank** — the card reads "not configured yet" rather than "pointing at a
   secret that is gone", and the broken value is invisible.

## Decision

Close the class at the seam where it is created — secret deletion — with an
index that cannot drift, and make the residue visible where it already exists.

**1. A self-registering consumer seam.** `host/credentialRefRegistry.ts` exposes
`registerCredentialRefConsumer({ id, describe })`. Every module that persists a
`credentialRef` registers at module load, exactly as `registerRetentionPurger`
does today. The delete guard fans out across the registry instead of consulting a
list someone has to remember to edit.

The tri-state **contract is unchanged** — this ADR replaces the index behind it,
not the semantics in front of it. `ConsumerLookup` and the honest-scope arms (no
tenant context; host-scoped refs, which resolve for every tenant and so cannot be
enumerated without a cross-tenant scan) move into the registry so both routes
share one definition rather than one route owning it.

**2. Fail-closed, both paths.** `routes/byok.ts` gains its first referential
check, using that same shared lookup. A consumer that throws propagates, and the
route turns it into `known:false` — never `known:true, []`, which is the
permissive answer to an unanswered question.

**3. A source-scan tripwire.** A test walks `src/`, finds every module that both
persists a `credentialRef` and owns a `DurableCollection`, and asserts each one
registers a consumer. The heuristic deliberately over-approximates; a file may opt
out with a greppable justification naming the module that registers on its behalf
(`voiceSession.ts` does, because `AgentVoice` rides the agent profile). A new
credential-holding store cannot ship unregistered — the property is enforced
structurally, not by review.

**4. Honest surfaces.** The realtime-voice admin card renders a configured-but-
missing ref as a visible, labelled broken option plus an error notice, rather than
silently collapsing to the placeholder.

### Alternatives weighed

- **Cascade-clear the referencing configs on delete.** Rejected. A voice provider
  that silently reconfigures itself to `off` is no less surprising than one that
  dangles, and it destroys operator intent with no record. Refusing the delete
  keeps the human in the decision.
- **Validate refs on every read.** Rejected as the primary mechanism: it is N call
  sites, it adds a secret-store read to hot paths, and it still reports the problem
  far from its cause. Surfacing (item 4) is the targeted version of this, applied
  only where an operator can act on it.
- **A migration that repairs existing dangling refs.** Deliberately not done. There
  is no safe automatic answer to "which key did they mean" — the live incident had
  three distinct valid Google keys to choose between. The guard prevents new
  dangling refs; existing ones surface via item 4 and are repaired deliberately.

## Consequences

Deleting a referenced secret now fails by default. That is the intended cost, and
`?force=true` remains for the case where the operator means it. The registry adds
one fan-out read per delete — an admin-rate operation, not a hot path.

The guard is only as complete as the registry, which is why the tripwire is part
of the decision rather than a follow-up: an unregistered holder is the exact
failure mode this ADR exists to eliminate.

## Implementation record

| Phase | What | Commit / test |
| --- | --- | --- |
| P1 | `credentialRefRegistry` seam + fail-closed `lookupCredentialRefConsumers` | `test/adr0499-credential-ref-integrity.test.ts` |
| P2 | Register all 10 holders; retire the hand-kept `refConsumers` | same |
| P3 | Both delete routes gated (`routes/byok.ts` gained its first check) | same |
| P4 | Source-scan tripwire | same |
| P5 | Realtime-voice admin card surfaces a missing ref | `frontend/react/src/byok/__tests__/realtimeVoiceSettings.test.tsx` |
