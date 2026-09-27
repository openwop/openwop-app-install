# ADR 0644 — Sharing: the resolver read contract, and a card lane that enforces the cap

Status: implemented
Date: 2026-09-09
Feature: Sharing (ADR 0013) · FEATURES.md ordinal 6 of 71
Supersedes nothing · Extends ADR 0013 · Composes ADR 0464 (erasure), ADR 0643 (KB subject binding)
Source: `/grade-workflows` re-grade 2026-09-09 (`docs/steward/WORKFLOWS-ASSESSMENT.md`, ids `SHWF-1..15`)

## Context

Sharing owns the ADR 0013 resolver registry: a static, exhaustive
`Record<ResourceType, ShareResolver>` (`sharingService.ts:126`) with three hooks per
resource — `validate` (mint time, has a caller), `load` (public read, no caller) and
`card` (public social-card metadata, no caller). #3340 centralized the *toggle* gate into
`resolveActiveLink` and made `load`/`card` agree on it.

The 2026-09-09 re-grade found that centralization is sound and the registry is closed by
the type system — a new `ResourceType` cannot compile without a resolver and a declared
gate, and is born-red against three tests. What the centralization does **not** reach is
each resolver's own visibility contract. Three of twelve break it, and one public lane
enforces no view cap at all.

### The boundaries audit (Step 3)

- **No namespace collision.** `/v1/host/openwop-app/shared/*` has exactly one registrant
  (`features/sharing/routes.ts:70,78,86`).
- **No concept duplication.** Sharing is the single owner of share links; the 11 delete
  cascades call *into* it. Prompt visibility is owned by `promptLibraryService.readableBy`
  (`:118-119`) — this ADR **composes** that predicate rather than restating it.
- **Helper reuse.** The status-allowlist shape already exists as
  `documentsService.SHAREABLE_STATUSES` (`:46`); the caller-threading already exists as
  `ShareResolver.validate`'s 4th arg, used by `kb_collection` (`sharingService.ts:284`).
  Both are reused, not reinvented.
- **RFC verdict: host-extension, NO RFC.** Every route touched is under
  `/v1/host/openwop-app/*`, non-normative. No wire field, capability, or event changes.

## Decision

### D1 — `validate` is the entitlement hook; `load`/`card` are not (closes `SHWF-1`)

Establish explicitly, in the `ShareResolver` docblock, that:

> **`validate` answers "may this actor grant public access to this resource?"** It has a
> caller and MUST apply the resource's own visibility predicate.
> **`load`/`card` answer "what does this already-granted link show?"** They have no caller
> and MUST NOT re-apply a caller-relative predicate — the minted link is the grant.

`prompt.validate` (`sharingService.ts:389`) becomes caller-aware and refuses when the
entry is `visibility:'private'` and the actor is not its creator. `load`/`card` keep the
unfiltered read, which is correct: an owner sharing their own private prompt is a
legitimate use that a filtered read at `load` would break.

This is the narrow fix. The `promptLibraryService.ts:121-124` rationale ("a minted public
link IS the grant") is sound for the read hooks and **circular for the mint hook**, where
the open question is precisely whether the minter was entitled to mint.

### D2 — the card lane enforces `maxViews` without consuming it (closes `SHWF-2`)

`resolveSharedCard` (`:1085`) gains the same non-authoritative pre-check `resolveShared`
already has at `:1062`: refuse with the uniform 404 when `viewCount >= maxViews`. It does
**not** call `countShareViewOrThrow` — the documented exemption exists so an unfurl does
not burn a recipient's slot, and that intent is preserved. The bug was that "does not
burn a slot" had been implemented as "does not enforce one", so an exhausted
burn-after-reading link kept serving live title and description forever, unauthenticated.

### D3 — `commerce_quote` gets a shareable-status allowlist (closes `SHWF-3`)

Mirroring `document`: `SHAREABLE_QUOTE_STATUSES = ['sent','accepted','converted']` out of
the six `QUOTE_STATUSES` (`quotes.ts:35`). `load` and `card` return `null` outside it, so
the public viewer gets the existing machine-readable `reason:'resource-gone'`.

**`accepted` and `converted` are in the allowlist deliberately.** `acceptQuote`
(`quotes.ts:239`) CAS's `sent → accepted`, so an allowlist of `['sent']` — the naive
reading of the mint-time `validate` — would 404 the buyer's page at the instant they
accept. `draft`, `declined` and `expired` darken.

### D4 — pin the centralization the gate depends on (closes `SHWF-4`)

Add behavioural toggle-off assertions for the three public entry points that have none:
`recordSharedFrameView`, `assertLiveLinkFor`, `resolveActiveResource`. Today, moving
`owningFeatureEnabled` out of `resolveActiveLink` into the two resolve methods leaves the
entire suite green while those three lanes go ungated. The centralization is the argument
for not testing each of the eight gated types; nothing currently pins it.

### D5 — witness the eraser and teardown wiring (closes `SHWF-5`, `SHWF-6`)

- Drive `host/subjectErasure.ts`'s `eraseSubject` end to end and assert Sharing links were
  revoked, so a no-op registration body goes red. Today only the source-scan ratchet sees it.
- Seed `sharing:link` + `sharing:frameview` rows and run `purgeTenantHostExt`, falsifying
  the intricate raw-`kvDelete`-branch claim at `sharingService.ts:496-513`. The same
  last-construction-wins mechanic already produced one inert hook
  (`hostExtPersistence.ts:87-93`), so this claim should not rest on prose.

### D6 — a real concurrency witness for the cap (closes `SHWF-7`)

`Promise.all` two `resolveShared` calls against a `maxViews:1` link. `countShareViewOrThrow`
(`:594-620`) has genuine `await` boundaries between read and swap, so this interleaves for
real; replacing the CAS with a plain `put` is currently undetected by every test.

### D7 — replace the two false cascade witnesses (closes `SHWF-8`)

`sharing-route.test.ts:196-199` and `creative-briefs-rbac-purge.test.ts:114` both claim to
witness the delete cascade while asserting only the resolver's fail-closed 404, which
arrives from a `null` load whether or not `purgeLinksForResource` ran. Assert the link
**row** is gone, and give `hasActiveLinkForResource` its first test.

## Alternatives weighed

- **Filter `prompt.load` too.** Rejected — it has no caller, so the only available filter
  is "never serve a private prompt", which breaks the owner's own valid share. D1's split
  is the honest boundary.
- **Count views on the card path.** Rejected — burns a recipient's slot on every unfurl,
  which is what the exemption was written to prevent.
- **Allowlist `['sent']` for quotes.** Rejected — falsified against `quotes.ts:239`; it
  breaks the accept flow.
- **Give `cms_page` a status filter.** Rejected — draft sharing is the documented feature
  (`FEATURES.md:173`) and the missing kill-switch is honest-by-measurement, not an omission.

## Open questions

- `SHWF-11` (KB subject binding evaluated at mint only) is deferred: re-resolving the
  subject at `load` needs a caller-free authority the ADR 0643 seam does not yet expose.
- `SHWF-15` (no test drives the retention daemon tick) is repo-wide, not Sharing-specific.

## Phased plan

| Phase | Scope | Gap ids |
|---|---|---|
| P1 | The three read-contract fixes + their born-red witnesses | `SHWF-1`, `SHWF-2`, `SHWF-3` |
| P2 | Pin the centralization; witness eraser + teardown | `SHWF-4`, `SHWF-5`, `SHWF-6` |
| P3 | Concurrency witness; replace the false cascade witnesses | `SHWF-7`, `SHWF-8` |
| P4 | `conversation` legacy owner gate + the nice-to-haves | `SHWF-9`, `SHWF-10`, `SHWF-13`, `SHWF-14` |


## Implementation record

| Phase | Decision | Change | Witness |
|---|---|---|---|
| P1 | D1 `SHWF-1` | `prompt.validate` composes the exported `promptLibraryService.readableBy`; `load`/`card` unchanged | `sharing-prompt.test.ts` — born-red, the failure output printed the intruder's minted token |
| P1 | D2 `SHWF-2` | `resolveSharedCard` enforces the cap without consuming a slot | `sharing-route.test.ts` — **the old test PINNED the defect** (`.toBe(200)` after exhaustion, comment "does not consume OR ENFORCE"); corrected + a both-halves test added |
| P1 | D3 `SHWF-3` | `SHAREABLE_QUOTE_STATUSES` in `quotes.ts`, applied at `load`+`card` | `commerce-phase-c.test.ts` — born-red on the demoted quote, with the `sent` and `converted` legs green |
| P2 | D4 `SHWF-4` | (test only) | `sharing-owning-feature-gate.test.ts` — **sabotage-proved**: moving the gate out of the chokepoint leaves the other 8 tests green and reddens only this one |
| P2 | D5 `SHWF-5` | (test only) | eraser wiring driven through host `eraseSubject`; **sabotage-proved** by no-op'ing the registration body |
| P2 | D5 `SHWF-6` | (test only) | teardown seeds both Sharing stores and runs `purgeTenantHostExt` |
| P3 | D6 `SHWF-7` | (test only) | service-level `Promise.allSettled`; **sabotage-proved** by replacing the CAS with a plain put |
| P3 | D7 `SHWF-8` | (test only) | link-ROW assertion + first-ever `hasActiveLinkForResource` test; **sabotage-proved** by disabling the CMS cascade |
| P4 | `SHWF-10`, `SHWF-13` | doc drift + two tolerant assertions pinned | — |

### Correction note — D6's first witness was VACUOUS, and only sabotage found it

The concurrency test was first written at the **route** level (`Promise.all` of two
`GET /shared/:token` on a `maxViews:1` link). It passed. Replacing
`countShareViewOrThrow`'s compare-and-swap with a plain `put` — the exact regression it
exists to catch — **left it green**: two requests routed through HTTP do not interleave at
the read-modify-write. Driven at the **service** level the same sabotage reddens it. The
vacuous version was removed and a comment left at its old site so it is not "restored".

This is the second time in two iterations that a probe which *ran* proved nothing. A test
that passes is not evidence; a test that fails when you break the thing it names is.

### Deliberately NOT closed

- **`SHWF-14`** (a conversation with no `meta.ownerUserId` is mintable by any member):
  fixing it means choosing what an *unowned legacy row* means, and both readings have a
  real cost — fail-closed strands users who can no longer share their own old
  conversations, with no recourse, and there is no ownership record to fall back on.
  That is a product decision, not a defect fix. Left open with the reasoning recorded.
- **`SHWF-11`** (KB subject binding re-checked only at mint) needs a caller-free authority
  the ADR 0643 seam does not expose. **`SHWF-15`** is repo-wide, not Sharing.


## D8 — the cap class, not the cap instance (added 2026-09-09 after the code grade)

The `/grade-code` pass on this same branch found that **D2 fixed an instance and
called it a class.** The argument D2 makes — *"'does not burn a slot' had been
implemented as 'does not enforce one'"* — applies verbatim to three more public
lanes that D2 never touched, because the cap check was written into
`resolveSharedCard` instead of into `resolveActiveLink`, the chokepoint SHARE-1
built precisely so that *"a new resource type cannot be added ungated and `load`
and `card` can never disagree."*

The sharpest consequence was an **oracle**: `POST /shared/:token/frame-view` is
unauthenticated and returned `204` for a spent-but-real token while a fabricated
one got `404` — exactly the distinction the uniform-404 posture exists to deny,
in the one place nobody was looking. `assertLiveLinkFor` and
`resolveActiveResource` were likewise uncapped, and `commerce/routes.ts:339`
**documented a view-cap gate that had never existed.**

**Decision.** The cap moves to `resolveActiveLink`, default ON, and the two
capability-proof lanes opt out with `{ enforceViewCap: false }`.

**The obvious fix — enforce it everywhere — is an ATTACK, and this is the third
time in one iteration that a prescribed fix was one.** A `maxViews:1` quote link
spends its only view the moment the buyer *opens* the quote, so a capped
`assertLiveLinkFor` refuses the Accept they were invited to make. A cap limits how
many times an offer may be **read**; it is not an authorization boundary on the
action the recipient was invited to take. Pinned end to end in
`commerce-phase-c.test.ts` — view first, then accept, and the accept must be 200.

Making the default ON and the exemption explicit means a newly added lane is
capped unless someone writes down why it should not be. `SHCD-16`'s duplication
dissolves as a side effect.

## D9 — the boot migration must not swallow its own failure (`SHCD-2`, Blocker)

`feature.ts` ran `void rekeySharingAtRest().then(backfillLinkDeadAt).catch(() => undefined)`,
hiding two different failures behind one silent catch:

1. A failed re-key leaves the **raw bearer token** in durable legacy rows, so the
   ADR 0448 P2 "never at rest" invariant stays violated indefinitely with nobody
   told — only rows someone happens to resolve get migrated by the lazy fallback.
2. Because the backfill was **chained behind it**, a rejected re-key skipped
   `backfillLinkDeadAt` entirely, leaving every pre-`deadAt` dead row invisible to
   `registerKvAgeOut` forever — the exact "silent retention regression that would
   have looked like success" the backfill's own docblock exists to prevent.

Both remain best-effort and ordered; failure is now logged, and the second pass no
longer depends on the first succeeding.

## D10 — refusals are now diagnosable (`SHCD-3`)

The wire stays a uniform, reason-less 404 — that posture is deliberate and
unchanged. But the *justification* for collapsing nine refusals on the wire is
that the server still knows which fired, and it did not: eight of nine logged
nothing, so "the link my client had stopped working" was undiagnosable. `gone()`
now takes a reason and emits `shared_link_refused`. The reason goes to the log,
never to the envelope; `tokenPrefix` is a prefix of the stored hash, never of the
raw token.

## D11 — the owner surface stopped calling a dead link "Live" (`SHUX-5`, Blocker)

`linkStatus` never compared `viewCount` to `maxViews`, so an exhausted link
rendered a green **Live** chip under "Active links" — inviting the owner to
re-send a URL the server refuses. D2 and D8 made that worse, not better: the link
is now dark on *every* lane while the row still claimed it worked. This is the
precise class of lie `sharingClient.ts`'s own docblock says the function exists to
remove; the cap was the one case left out. New terminal `cap-reached` state,
ranked below revoked/expired and above the reversible `feature-off`, with a row
explanation and all four locales.

## D12 — two public types no longer render a blank page (`SHUX-4`, Blocker)

`booking_manage` and `sign_request` carry no markdown body, so they fell through
the viewer's generic branch to "Nothing to show here." — on a page whose only
other reading is "your booking/signature link is broken." Their real surfaces,
`/book/manage/:token` and `/sign/:token`, take the **same token** and carry the
actions the recipient needs. The viewer now redirects rather than rendering a
degraded read-only copy.

Also closed: `SHUX-1`/`SHUX-2` (the uniform-404 copy blamed revocation for what is
now also cap exhaustion, and its inline fallback had drifted from the catalog),
`SHUX-9` (the public quote's *failure* was silent to assistive tech while its
success announced — cohort row deleted and the gate baseline lowered with it,
176 → 175), `SHUX-10` (an empty `<h1>` above the quote's real one).
