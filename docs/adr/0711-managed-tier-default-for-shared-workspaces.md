# ADR 0711: a shared workspace reaches the managed tier without a hand-written binding, and its AI credentials are an operator's to change

Status: **Accepted — BYOK write gating (C + C′) implemented** 2026-09-17

## Context

A participant's chat surfaces (`EmbeddedChatPanel`, `/guide`) gate on the
workspace's chat binding (`GET /byok/active-config`). On kicktodo.com
(2026-09-16) the shared workspace `host-kicktodo` had no binding, so two fresh
strangers met "Connect an AI provider" and a bring-your-own-key wizard, although
the managed free tier was configured and ready server-side. The only managed
affordance outside the wizard renders in demo mode, which is correctly off in
production.

Two defects compounded it:

1. The wizard's own "Try it free" activation was refused 400: it sends the managed
   tile's id (`openwop-free`), which `setChatByokConfig` did not accept. Fixed by
   resolving a managed tile id to its dispatch provider (PR for
   `fix/byok-active-config-accepts-managed-provider`).
2. Even with that fixed, a participant would have to choose a provider before
   talking to a coach the product presents as built in. And in a shared workspace
   the binding is workspace-wide, so whichever member clicks first sets it for all.

The interim on kicktodo.com is an operator-set binding
(`provider: minimax, credentialRef: managed:openwop-free`), reversible.

## Decision drivers

- A participant in a shared workspace should never be asked to pick an AI provider
  to use a built-in coach.
- A workspace-wide binding must not be settable by an arbitrary member (today any
  member's wizard click writes it).
- **The key store has the same exposure, and it is the destructive half.** The binding
  is only a pointer. `DELETE /byok/secrets/:credentialRef` lets any member of a shared
  workspace delete the key the binding points at; its only guard is referential (ADR
  0499: refuse while consumers exist), and `?force=true` overrides that guard.
  `POST /byok/secrets` likewise lets any member add a workspace key. Across the nine
  routes in `routes/byok.ts`, `requireOrgScope` is used zero times (it is used 214 times
  elsewhere). Restricting the binding alone would leave a member able to take the
  workspace's AI down by deleting the key instead. (Found by openwop-app-1.)
- Operators who want BYOK for a workspace must still be able to choose it.
- No wire change.

## Options

| # | Option | Effect |
|---|---|---|
| A | Keep manual: document the operator binding in the deploy runbook | works; easy to forget on a new workspace |
| B | **Default binding**: when a multi-principal workspace has no binding and a managed target is configured, `GET active-config` reports the managed default as effective (not stored) | participants reach the coach; no write by anyone |
| C | B, and restrict **every workspace-scoped BYOK write** in multi-principal tenants to an operator role: `PUT/DELETE active-config`, `POST /byok/secrets`, `DELETE /byok/secrets/:ref` | removes "first member to click sets it for everyone" and "any member can delete the workspace key" |
| C′ | C, and `?force=true` on secret delete requires the operator role **and** is audited, independently of the referential guard | a destructive override that bypasses the only guard a route has gets its own gate |
| D | Per-feature declaration: a feature's default org (ADR 0684) declares its default chat binding | explicit per distribution; more surface |

## Recommendation

**C with C′.** An effective managed default when nothing is bound, every
workspace-scoped BYOK write restricted to operators in shared workspaces, and the
`force` override on secret delete gated and audited on its own. D is compatible later if a
distribution needs a non-managed default.

## Decision (2026-09-17)

**C with C′** is adopted. When a multi-principal workspace has no binding and a managed
target is configured, the managed tier is the effective default.

> **CORRECTED 2026-09-17 — a managed default ALREADY EXISTS at dispatch, so option B is
> smaller than this sentence implies.** `host/exchange/dispatchTurn.ts:236` and
> `bootstrap/nodes.ts:1658-1661` both fall through to `managed:openwop-free` today. What is
> missing is the REPORT, not the resolution: `GET /byok/active-config` returns `config:
> null` when nothing is stored, and the SPA gates on that and shows "Connect an AI
> provider" — blocking the user before a run that would have defaulted to managed anyway.
>
> **B is therefore a one-route reporting change and MUST be built as one.** Measured:
> `getChatByokConfig` has exactly ONE backend reader, the GET route. The binding is an
> advisory UI gate; the real dispatch decision is client-proposed via `run.inputs`. Making
> the server read the binding at dispatch would add a FOURTH owner of "which provider does
> this workspace use" and is a far larger behaviour change than this ADR decides.
>
> A consequence worth stating plainly, because it changes this ADR's threat model: C's gate
> stops a member changing what OTHERS see. It does **not** stop that member spending managed
> tokens — they can put `managed:openwop-free` in their own run and always could. Every workspace-scoped
BYOK write in a shared workspace is restricted to operators. `?force=true` on secret
delete needs the operator role and writes its own audit record, separately from the
referential guard.

Open questions, decided:

1. **Yes.** The settings UI shows the effective default as "Managed (default)", so an
   operator can see that nothing is stored.

> **CORRECTED 2026-09-17 — it renders in the CHAT HEADER's provider card, not in a
> settings page.** `ConfiguredProviderCard` (compact) is what every chat surface shows, and
> it is where a user actually sees which provider is in use, so that is where the signal
> belongs. The wording above survives as the decision; this note records where it landed.
2. **The ADR 0693 per-subject cap is enough to ship.** A per-workspace ceiling is left to
   a later ADR, if metering shows it is needed.

> **CORRECTED 2026-09-17 — THIS ANSWER WAS FALSE WHEN WRITTEN, and it is the sentence
> that justified deferring the ceiling.** The ADR 0693 cap is per-subject only where a
> caller passes `actingSubject`. `providers/managedUsageScope.ts:49` returns the bare
> `tenantId` — the POOLED bucket — on its `!subject` branch, and **NONE of the seven
> `dispatchManagedChat` sites passed one** (its sibling `dispatchManagedToolsRound` was
> already correct at two of three, so tool-carrying agents metered properly; the pooled
> lane was the TOOL-LESS reply branch). The conversation-reply path this ADR's option B
> exists to unblock (`host/exchange/dispatchTurn.ts`) passed none, so a shared workspace
> drew ONE allowance on that lane — the ADR 0693 defect verbatim, under a green test, because
> ADR 0693's witness tests the COMPOSER and never its callers.
>
> Fixed by **ADR 0721**, which threads the subject at four sites and adds a class ratchet
> over the call-site population. The deferral is defensible NOW; it was not when this line
> was written. The lesson is narrower than "check your claims": a cap is a property of the
> CALL, never of the function that computes the key — the same shape as this repo's
> "derive a ratchet from the CALL, not the presence of a name".

## Operational note

kicktodo.com's `host-kicktodo` carries an operator-written binding
(`provider: minimax, credentialRef: managed:openwop-free`, 2026-09-16 14:36Z) that
exists only because the wizard's managed activation was refused.

> **CORRECTED 2026-09-17 — the refusal is already fixed, and the defect CHANGED SHAPE
> rather than closing.** `host/chatByokConfig.ts:95-118` now resolves a managed tile id to
> its dispatch provider before validation and skips the stored-ref existence check for
> managed sentinels, so the 400 is gone. But C shipped `requireTenantScope(req,
> 'host:byok:manage')` on `PUT /active-config`, and `byok/lib/byokClient.ts:62-70` has no
> 403 branch — so in a shared workspace a plain member's "Try it free" click now fails with
> an unexplained error instead of a 400. **The remaining wizard work is the 403 path, not
> the 400.**
>
> Removal order for the hand-written binding matters and is not free: it is safe only AFTER
> option B is deployed and verified. With the binding gone and B absent, every member of
> `host-kicktodo` sees "Connect an AI provider" and, per the 403 above, cannot fix it
> themselves. Once the wizard fix
and option B land, that binding is removable; until then it is intentional, not drift.

## Open questions

1. Should the effective default be visible in the settings UI as "Managed (default)"
   so an operator knows nothing is stored?
2. Does the managed daily cap's per-subject metering (ADR 0693) make the default safe
   at population scale, or does it want a per-workspace ceiling too?

## Implementation record — C + C′ (BYOK writes)

| part | where | proof |
|---|---|---|
| `host:byok:manage` scope, admin-class | `host/accessControlService.ts` `MANAGEMENT_SCOPES` + `ADMIN_SCOPES` | reserved to built-in admin/owner, never mintable onto a custom role — same reasoning as `host:connections:manage` |
| C — every workspace-scoped BYOK **write** gated | `routes/byok.ts`: `POST /secrets`, `DELETE /secrets/:ref`, `PUT /active-config`, `DELETE /active-config` | `adr0711-byok-operator-gate.test.ts` legs 2–5, one leg per route |
| C′ — `?force=true` audited on its own | `routes/byok.ts`, `byok.secret.force_deleted` via `appendAudit` | legs 7–8 |

**Reads stay open** to any member. `GET /secrets` lists refs and never values, and a
member who cannot see which provider their workspace is bound to cannot reason about
their own runs. Leg 1 pins this and is what makes the refusals meaningful: it proves
the editor IS a member, so a 403 on legs 2–5 is the GATE and not absence.

**Why no separate "multi-principal" check was added.** `requireTenantScope` already
short-circuits for a `user:`/`anon:`-shaped PERSONAL workspace, so solo-user and
anon-demo flows are untouched and the gate bites exactly where this ADR says — in a
tenant with more than one human. Adding a second membership-counting predicate would
have been a parallel authority path for the same question.

**The audit is written BEFORE the delete, and deliberately outside both `!force`
branches.** Those branches are the paths `force` SKIPS; appending there would record
every override that had nothing to skip and none of the ones that did. It carries
`referencesKnown` + `consumers`, i.e. what the guard WOULD have said, so the record
shows what was overridden rather than only that an override happened.

### Sabotage record
Each removal reds a DISJOINT set, verified individually rather than as "the change":

| removed | reds |
|---|---|
| gate on `POST /secrets` | leg 2 only |
| gate on `DELETE /secrets/:ref` | leg 3 only |
| gate on `PUT /active-config` | leg 4 only |
| gate on `DELETE /active-config` | leg 5 only |
| the `if (force)` audit append | leg 7 only |

A first pass of this table reported legs 4 and 5 as **unfalsifiable**. That was a
mistargeted probe, not a gate that cannot fail: adding the audit block shifted those
lines, and the sabotage blanked unrelated code. The probe now asserts it hit the
intended line before its result is trusted — a zero from an unvalidated probe is
evidence of nothing.

## Option B — implementation record (2026-09-17)

Built as the correction note above prescribes: a REPORTING change in
`GET /byok/active-config`, nowhere else.

| part | where | proof |
|---|---|---|
| the effective default is reported when nothing is stored | `routes/byok.ts` `effectiveManagedDefault()` | `test/adr0711-managed-default-report.test.ts` **leg 4** (added 2026-09-17) |
| `stored` discriminator on every response | same handler | leg 2 (a real binding flips it) |
| a default is never reported as dispatchable unless the managed key resolves | `getManagedProviderStatuses().ready` | leg 3 |
| the SPA never caches a default as a choice | `byok/lib/useBYOKConfig.ts:216` | `byok/lib/__tests__/adr0711ManagedDefault.test.ts` legs 1-4 |
| the operator-only refusal is legible | `byok/lib/byokClient.ts` `ByokForbiddenError` → `chat/ChatTab.tsx` | `chat:byokForbidden`, 4 locales |

**NO TENANT-SHAPE TEST, and that is the substantive design call.** This ADR framed B as
applying to "multi-principal workspaces". Two predicates in this codebase disagree about
the `default` tenant — `isSinglePrincipalTenant` counts it single-principal,
`isPersonalTenantId` does not — so keying B on either would have imported that
disagreement into a new place. Dispatch consults neither: `dispatchTurn.ts:236` and
`nodes.ts:1658-1661` default unconditionally. The honest report is therefore the
unconditional one, and the predicate split stops being B's problem.

### Sabotage record
| removed | reds |
|---|---|
| the `stored` field | report legs 1 + 2 |
| `stored` hard-coded false | report leg 2 only |
| the managed-readiness check | report leg 3 only |
| `effectiveManagedDefault()` hard-wired to `null` | report leg 4 only |
| the `stored` guard in `useBYOKConfig` | SPA leg 4 only |

**A leg was rewritten for being vacuous before it shipped.** The first version of report
leg 3 branched on whether a default came back and asserted something in each arm — it
passed with the readiness check deleted, so it measured nothing. It now asserts the one
correct answer for a host with no managed key seeded.

## Still open after option B

1. ~~OQ1's "Managed (default)" label is not shipped.~~ **SHIPPED after the UX review.**
   The first cut stopped at the wire: `stored` was on every response and died inside
   `useBYOKConfig`, which did not expose it, so no consumer could render it — and the four
   locales of copy were deleted rather than left as a promise with no renderer. The review
   pointed out the residue was a real honesty gap (the compact card presented "Try it free"
   as though somebody had chosen it), so the flag is now threaded
   `useBYOKConfig → ChatTab → ChatSidebar → ChatHeader → ConfiguredProviderCard` and the
   label renders beside the provider name when `stored === false`. The copy is back in all
   four catalogs, this time with a renderer.
2. **The `default`-tenant authority question is UNRESOLVED.** An architect pass predicted
   that a plain `default`-tenant operator would 403 on every BYOK write after C. Two
   probes were written and BOTH were invalid: the first was green because the test seam's
   first login founds and owns the workspace, so it measured the seam; the second targeted
   a second user who measurably has zero scopes under both identity keys and still was not
   refused, which means that session is not on the tenant the probe assumed. Neither
   confirmed nor refuted. It is recorded here rather than left in a transcript, and the
   next attempt should establish the session's actual tenant FIRST, because both failures
   came from assuming it.

## UX grade follow-up (2026-09-17) — the signal did not land

`/grade-ux` graded the shipped surface **B−** and the reason is worth recording: the
*decision* was right and the one new signal failed to reach a user in three independent
ways, none of which any gate could see.

1. **It was clipped by an ellipsis clamp in the element it was added to.**
   `.configprov-compact > span:not(.configprov-badge)` carries `max-width: 22ch;
   text-overflow: ellipsis` — added to stop a model name wrapping to five lines. The marker
   was a grandchild of that span and shared the budget, so the parenthetical — the half that
   says nobody chose this — was the first text the ellipsis ate, worst in `es`. It now has
   its own slot (`.configprov-default`), escaping the clamp the way `.secondary` already
   does, plus a `title` for hover recovery.
2. **`u-text-muted` is not a class.** Measured: ZERO standalone rules across all four
   stylesheets; the only rule bearing the name is `.mkt-review-head > .u-text-muted`, which
   sets `flex` and `font-size` and **no colour**. It is used in **96 files** that all
   believe they are muting text. Defined properly here, and `check-classnames` tightened —
   it harvested `.u-*` from anywhere in the CSS, so a compound-scoped selector registered as
   a definition, making it unable to fail for the exact failure its own docblock names.
   `u-text-muted` was the ONLY compound-only class in `src/`, so the tightening bites there
   and nowhere else.
3. **A second render site never got the flag.** `tabDeck/TabSession.tsx` renders the same
   compact card; `stored` was optional-with-a-default, so behind the `multi-tab-chat` toggle
   the fallback was presented as a choice again — the laundering this flag exists to prevent,
   surviving in the one place nobody looked. **`stored` is now REQUIRED**, which turned it
   from a thing to remember into a compile error; it immediately surfaced three files.

**The copy changed too.** "Managed (default)" stacked a marketing tile label with an operator
noun and never said the thing that matters. The visible marker is now **"not chosen"** with a
title explaining the fallback and pointing at Change — shorter than the clamp could ever eat,
and it answers the user's actual question rather than ours.

Carried, not fixed: the 403 notice can render above the fold of a tall wizard with no
`scrollIntoView`; the copy names a role ("owner or admin") but not a person; the marker is
decorative text with no programmatic association; and none of `check-live-regions` /
`check-notice-announce` / `check-aria-prohibited` can see any of it.

## Code grade follow-up (2026-09-17) — three claims this work had not proved

`/grade-code` graded the run **B+** and found three properties the work asserted without
witnessing. All three are closed above; the pattern is what matters.

1. **The steward ratchet's "drain to zero" headline was FALSE when written.** Its status test
   was an EXACT match on `Proposed`, so any parenthetical silenced it permanently — no
   baseline row, no exemption, nothing a diff would show. Seven ADRs were live-stale and
   invisible. The file had spent forty lines enumerating a NARROWER blind spot (renames)
   while a wider one sat in the regex beside it. Now a prefix match; the seven are triaged.
2. **ADR 0721's witness mocked the function that owns the metering**, so it proved what
   reached the mock. A leg that drives the real composer and asserts the pooled row stays
   empty now closes it.
3. **This ADR's own proof row cited legs 1 and 3 for "the default is reported" — and leg 3
   asserts `config` is NULL.** There was no happy-path test at all: hard-wiring
   `effectiveManagedDefault()` to `null` killed the feature and left every gate green.

The common shape: **each gate tested the half of the property that was easy to observe.**
Over-reporting was caught and under-reporting was not; the dispatch call was caught and the
meter was not; an exact status string was caught and a decorated one was not.
