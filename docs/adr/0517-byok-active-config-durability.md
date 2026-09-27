# ADR 0517 — The BYOK active-config binding is durable, server-owned, and honest about why it is missing

Status: implemented

## Context

A user reported that their Google API key "won't stay saved" — they had entered it
several times, and periodically the chat asked again. The Secrets Vault told the
real story: **seven** `byok:google:<epoch-ms>` rows for one workspace, minted
2026-06-21, 06-22, 06-30, 07-08 (twice), 07-15 and 07-29. Gaps of 1, 8, 8, 0, 7 and
14 days — re-prompts on *return after a break*, not random churn.

The keys were never lost. Every one of them was still on the server, encrypted, in
the right tenant. What was lost was the **pointer** to which key to use — and the
app could not tell the difference between "lost the pointer" and "never had a key".

Three independent defects composed into the symptom.

**1. The pointer was browser-local.** `useBYOKConfig.ts` kept the active
`{provider, model, credentialRef}` in a bare `localStorage` key,
`openwop-app.byok.activeConfig`. It did not go through `platform/storage.ts`'s
subject-scoping and it never reached the backend. The file's own header admitted
the gap — *"Persisted to localStorage (Phase 1; Phase 2 moves to BE-backed user
prefs)"* — and Phase 2 was never built. A second browser, a second profile, a
private window, cleared site data, or Safari ITP's 7-day eviction of `localStorage`
for a site not recently visited all drop the pointer while the key sits untouched
server-side.

**2. Validity was inferred client-side, and failed closed onto the wizard.**
`ChatTab` gated on `!config || !isValid`, where `isValid` was
`storedRefs.includes(config.credentialRef)` and `storedRefs` came from
`GET /byok/secrets` — scoped to `req.tenantId`, the **active** tenant. The session
cookie lives 24h with a 6h sliding refresh (`cookieSession.ts`); past that,
`middleware/auth.ts` mints a fresh `anon:<sid>`. That request **succeeds** and
returns `[]`, so the `isLoading || error` gate never fires and the surface falls
straight through to the wizard. A workspace switch does the same. The user is shown
"Add your Google API key" — with the anonymous *"Try it free by creating an
account"* upsell above it, which is itself the tell that they had been logged out.

**3. The wizard could only mint, never adopt.** `KeyEntry.tsx` computed
``byok:${provider.id}:${Date.now()}`` unconditionally. `BYOKWizard` could see
`storedRefs` and never consulted them. So every false prompt created a *new* secret
instead of re-binding one that was right there — which is how seven accumulated.

Each defect alone is survivable. Together they form a loop: lose the pointer →
be told you have no key → store a duplicate → lose the pointer again.

`OPENWOP_BYOK_EPHEMERAL` was **not** involved; ephemeral mode would have persisted
nothing at all, and seven durable rows disprove it.

## Decision

**The pointer lives where the key lives, the server owns the verdict, and every
reason the chat might lack a binding gets its own honest surface.**

Four changes, one per defect plus the honesty fix:

- **A. Adopt before asking.** When the picked provider already has a stored key,
  the key step offers *"Use my saved key"* as the primary action. Re-asking for a
  credential the workspace already holds is the failure, not the fallback.
- **B. Deterministic refs.** Keys are stored under `byok:<provider>` — or, when the
  workspace already has a ref for that provider, under *that* ref. A deliberate
  replacement **overwrites** the row the chat is bound to instead of orphaning it.
- **C. Server-owned pointer.** A new per-tenant durable row
  (`host:chatByokConfig`) behind `GET/PUT/DELETE /v1/host/openwop-app/byok/active-config`.
  `localStorage` is demoted to a first-paint cache and a one-way migration source.
- **D. Name the actual cause.** The hook returns a `BYOKStatus`
  (`loading | ready | needs-key | session-expired | error`) instead of a boolean.
  A lapsed session renders a *"Your session ended — your API key is still saved"*
  card with a sign-in action; an outage renders the backend status card. Neither
  can reach the wizard.

The governing invariant: **`needs-key` is reserved for a workspace that genuinely
has nothing to bind.** Never a failed request, never a lapsed session, never while
a usable key sits in the store.

### Why the server owns `valid`

The SPA re-deriving validity from a ref list is defect 2 restated. Any transient or
scope-related absence of the ref reads as "no key". `GET /byok/active-config`
therefore returns a server-computed `valid` (does the bound secret still resolve?)
and `anonymous` (is this an `anon:` tenant?). The client renders that verdict; it
does not compute one.

### Why not just extend the session cookie

Tempting, and wrong. A longer TTL reduces the *frequency* of defect 2 without
touching defects 1 or 3, weakens a security control to paper over a UI bug, and
still leaves a logged-out user staring at a key prompt. The 24h/6h posture stays.

## Alternatives weighed

| Option | Why not |
| --- | --- |
| Subject-scope the `localStorage` key via `platform/storage.ts` | Fixes cross-user bleed on a shared browser, not cross-*device* loss. The pointer is still one browser away from gone. |
| Derive the binding implicitly (newest key wins, no pointer) | Silently changes provider/model under the user when they hold several keys. A binding is a user choice and must be recorded. |
| Reuse `host:headlessAiDefault` for the chat binding | Different lifecycle and different meaning — the headless default is an operator-set fallback for non-conversational ops (ADR 0110). Overloading it couples two unrelated policies. |
| Extend the session cookie TTL | See above — treats the symptom, weakens a control. |
| Auto-delete the duplicate rows on migration | Deleting user credentials without asking is not a migration. The duplicates are inert; ADR 0499's guard now protects the *bound* one. Cleanup stays a deliberate operator action in the vault. |

## Trade-offs accepted

- **One extra round trip** on chat mount (`GET /byok/active-config` alongside the
  existing `GET /byok/secrets`, issued in parallel). Weighed against the
  rate-limit fan-out concern in `middleware/rateLimit.ts`: it is two parallel reads
  on a surface that previously did one, on mount only, and the wizard adds none
  (it is handed `storedRefs` by its caller).
- **The client still keeps a cache.** Removing it entirely would flash a wizard
  before the round-trip lands — reintroducing the exact scare this ADR exists to
  stop. The cache is seed-and-migrate only; it is never an authority, and a
  disagreement always resolves to the server.
- **Two copies of the ref-matching rule** (`host/chatByokConfig.ts#refsForProvider`
  and `useBYOKConfig.ts#refsForProvider`). Deliberate: the server *enforces* the
  binding, the client only *proposes* one. Both are test-pinned to the same cases,
  including the `byok:google` vs `byok:google-vertex` boundary.

## Implementation record

| Phase | What | Where | Test |
| --- | --- | --- | --- |
| A | Wizard offers an existing key | `byok/KeyEntry.tsx`, `byok/BYOKWizard.tsx` | `byok/__tests__/KeyEntry.reuse.test.tsx` |
| B | Deterministic / overwriting refs | `byok/KeyEntry.tsx` | same |
| C | Server-owned pointer + migration | `host/chatByokConfig.ts`, `routes/byok.ts`, `byok/lib/byokClient.ts`, `byok/lib/useBYOKConfig.ts` | `test/byok-active-config-route.test.ts`, `byok/lib/__tests__/byokConfigResilience.test.ts` |
| D | Per-cause surfaces | `chat/SessionExpiredCard.tsx`, `chat/ChatTab.tsx` | `chat/__tests__/ChatTab.byokStates.test.tsx` |
| E | Wait for auth; heal on re-auth (added 2026-08-03) | `byok/lib/useBYOKConfig.ts` | `byok/lib/__tests__/byokConfigResilience.test.ts` |

**Phase E — why fix D was not yet enough.** Shipping D revealed that the
`session-expired` card, while far more honest than the wizard, still fired more
often than the facts warranted. Two causes, both timing:

- The hook read the binding during the boot window, racing
  `reconcileRestoredSession` (ADR 0434 Phase 2), which silently re-promotes the
  backend session from Firebase's restored ID token. The backend answered for
  whichever session existed at that instant, so a returning user could be told
  their session had ended a beat before it was restored.
- Nothing re-read on an identity change, so when the restoration did land it
  changed nothing on screen. Clicking sign-in was the only way out of a card the
  user no longer needed.

So the hook now gates on `useStorageSubject()` (the app's canonical settled
signal, with its own 5s watchdog), re-reads whenever the identity changes, and —
when the backend says `anonymous` while the auth layer says `user` — waits once
for the handshake instead of believing the earlier answer. The grace is a single
bounded retry: if re-auth genuinely failed, the sign-in card is the honest answer,
not an indefinite spinner.

**This is why the 24h session TTL was left alone.** The instinct was to lengthen
it, or build a refresh-token path. Neither was needed: the refresh path already
existed and worked; the BYOK surface simply was not wired to wait for it or react
to it. Lengthening the cookie would have weakened a security control to paper over
a missing subscription.

Cross-cutting registrations, each required by an existing tripwire:

- `registerCredentialRefConsumer('host:chatByokConfig')` — ADR 0499. Deleting the
  key the chat is bound to now 409s with *"active chat binding"* instead of
  silently orphaning it. Pinned in `test/adr0499-credential-ref-integrity.test.ts`.
- `host:chatByokConfig` recorded `REVIEWED_EXEMPT` in
  `test/subject-erasure-coverage.test.ts` — ADR 0464. The row is workspace config;
  it deliberately carries **no** actor field (unlike its `headlessAiDefault`
  sibling), so "no-subject" is literally true rather than an approximation.

Migration is automatic and needs no operator step: on first load after deploy the
hook finds a `localStorage` binding, confirms the ref against the workspace's
stored secrets, and PUTs it. Users whose pointer names a historical
`byok:<provider>:<epoch-ms>` ref keep that exact key — adoption matches both ref
shapes precisely so no one is stranded.

## Open questions

1. ~~**The existing duplicates.** … Should the Keys page surface a "you have N
   unused keys for this provider" affordance so cleanup is discoverable without
   being automatic?~~ **CLOSED (2026-08-03).** Shipped with ADR 0518: a provider
   section holding more than one key now names the ref the chat is actually bound
   to and states that the rest are inactive and safe to remove. When the binding
   cannot be read it says so rather than guessing — naming the wrong key as "in
   use" would invite deleting the live one. Auto-deletion remains rejected for the
   reason in the alternatives table.
2. ~~**Refs remain per-tenant, so a workspace switch still shows a different
   binding.** That is correct behaviour (keys are workspace property), but the
   `session-expired` card does not currently distinguish "you switched workspace"
   from "you were logged out".~~

   **CORRECTION (2026-08-03, while implementing ADR 0518).** This question was
   based on a misreading of the code I had just written, and there is nothing to
   fix. `session-expired` is gated on `envelope.anonymous`, and a workspace switch
   is *not* anonymous — it resolves to a different signed-in tenant. So a switch
   falls to `needs-key` (the honest wizard for a workspace that genuinely has no
   key), and the expired card is unreachable from that path by construction. The
   open question was never real; it is recorded rather than deleted because the
   reasoning trail is the point.
