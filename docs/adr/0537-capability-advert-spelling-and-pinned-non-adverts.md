# ADR 0537 — Capability-advert spelling canon, and pinning deliberate non-adverts as tests

Status: implemented (2026-08-09)

Related: RFC 0137 gap G16 (upstream, RESOLVED 2026-08-05) · RFC 0111 §"Context economy" ·
RFC 0073 §"Document-root layout" · ADR 0148 Phase 3 · ADR 0531 (RFC 0140 advert)

## Context

Two defects in this host's capability adverts, found while verifying a claim about a
*different* RFC. Both share one root cause: **a recorded decision drifted out from under
the comment and the test that recorded it, and nothing could notice.**

### 1. `forms` was advertised on a spelling this host uses nowhere else

`routes/discovery.ts` emitted `'host.forms'` — a dotted key — while every other family
this host advertises (`artifactTypes`, `blobStorage`, `queueBus`, `vectorStore`, …) is
spelled plain. The dotted spelling was deliberate and *correct when written*: the comment
recorded that the RFC 0137 conformance helper "reads exactly `capabilities['host.forms']`",
so a plain advert would have made the behavioral leg soft-skip — a green witnessing nothing.

**That premise expired four days later.** RFC 0137 gap **G16** (resolved 2026-08-05) settled
the plain family name as the canonical discovery key: `capabilities.schema.json` declares
80+ properties and **zero** dotted `host.*` keys, and the `host.` prefix is the capability
IDENTIFIER notation (prose §headings, pack `peerDependencies`, `error.capability`), not the
document key. The helper now resolves **plain-root → dotted-root → plain-wrapper →
dotted-wrapper**. Measured: this host was being found on **arm 2 of 4 — the migration arm**.

Nothing in this repo could observe the premise expiring, so the comment went on arguing for
the outlier spelling on grounds that no longer existed.

### 2. The test meant to catch that was pinned to the wrong arm

`form-content-seam.test.ts` asserted `doc.capabilities['host.forms']` — the **last** of the
four arms, on the RFC 0073-deprecated `capabilities` wrapper. Its stated purpose is "so a
regression is caught here rather than in someone else's suite." It could not have done that:
it would have stayed green if root emission broke **outright**, since the wrapper mirror
alone satisfied it.

Generalizing: **a permissive multi-arm resolver hides which arm a host is actually on.** Four
ways to be found and one that is canonical means any assertion pinned to a fallback reports
green forever, in this repo and in the published suite alike.

### 3. The same failure, one layer up — RFC 0111

Separately and on the same day, this host's deliberate **non-advert** of RFC 0111
`multiAgentExecution.contextBudget` was re-opened as "in-flight host work" and claimed to a
peer session before verification caught it. The spec is unambiguous — *"A host whose
multi-agent orchestrator loop does not run real model turns (e.g. a mock supervisor with no
live inference) MUST NOT advertise `contextBudget`"* — and `core.orchestrator.supervisor`
(`bootstrap/nodes.ts`) is exactly that mock, echoing a config `mockDispatchPlan`.

The disposition was **already recorded in three places**: `host/transcriptBudget.ts`'s scope
note (which also records *why the alternative would be dishonest*), ADR 0148's Phase-3
correction note, and the upstream session's own register. The information was not missing.
Nobody retrieved it.

**Prose that records a decision cannot fail, so it decays silently.** Three notes did not
prevent the fourth re-opening, and a fourth note would not prevent a fifth.

## Decision

**1. Plain is canonical; dotted is a deprecated mirror.** Emit `forms: { contentPacks: true }`
at the document root, and retain `'host.forms'` as a `@deprecated` mirror for the v1.x
window — the same treatment this file already gives the `capabilities` wrapper.

**Why keep the mirror at all, given G16?** Not for the helper — it finds plain first. For a
*reader*: `host-capabilities.md:505` still SHOWS the dotted spelling in prose, so someone
implementing from that snippet looks for the dotted key. The mirror is droppable the moment
that prose is corrected, and not before. This is the upstream migration's ordering
constraint, recorded here so the removal is a deliberate act rather than a cleanup guess.

**2. Assert the canonical arm, and assert the mirrors separately.** A test that witnesses a
permissively-resolved advert MUST assert the arm the resolver tries **first**. Mirrors get
their own assertions so that removing one is a visible, intentional change.

**3. A deliberate non-advert is pinned as a test, not as a comment** —
`test/rfc0111-context-budget-non-advert.test.ts`, two legs:

- **Leg 1**: no `contextBudget` / `transcriptWindow` on any surface (root, wrapper, dotted,
  prefixed) — so a future advert cannot smuggle itself in on a fallback arm.
- **Leg 2**: the **premise** as its own assertion — the supervisor echoes a config
  `mockDispatchPlan` verbatim, with no provider credentials configured.

Leg 2 is what makes this **not a permanent veto**. Ship a supervisor that runs real model
turns and leg 2 goes red — the signal to revisit the advert deliberately, with
`contextBudget`'s honesty conditions re-read, rather than to delete the file. The RFC's
posture for this host is *correctly parked, not blocked*: nothing to build, something to
wait for, and now recorded in a form that cannot rot into a rediscovered "task".

## Alternatives weighed

| Option | Why not |
|---|---|
| Migrate to plain, drop the dotted key now | Breaks a reader implementing from the still-dotted prose snippet at `host-capabilities.md:505`. The mirror costs one key. |
| Keep dotted only; wait for upstream | Ratifies a spelling G16 explicitly demoted, and permanently forks the key convention for one family. |
| Ask upstream for a schema carve-out for dotted `host.forms` | Rejected in the 0142 exchange: root `additionalProperties: true` already makes the outlier non-invalid, so a carve-out buys nothing and enshrines the residue. |
| Record the RFC 0111 non-advert as a fourth prose note | This is the artifact that already failed three times. |
| Record it as a permanent "never advertise" assertion | Dishonest in the other direction — the RFC's condition is about the orchestrator, which can change. Hence leg 2. |

## Consequences

- The `forms` advert is found on the canonical arm; this host's key spelling is uniform.
- One deliberate non-advert is enforced rather than remembered. **This is the pattern to
  copy for the next one** — a non-advert that exists only as an omission is invisible, and
  therefore trivially "fixed" by a future session acting in good faith.
- Cost: one extra discovery key until the upstream prose lands.
- Not addressed here: the other capability families' arms are unaudited. This ADR fixes the
  one measured instance and names the class; a sweep is separate work.

  **RESIDUE CLOSED 2026-08-09 — and the hazard was real, not hypothetical.** The sweep found
  no second dotted family (`host.forms` is the only one; the other dotted strings in
  `discovery.ts` are envelope types, a different map). It found something worse:
  **14 in-repo test files assert discovery capabilities through `doc.capabilities.<family>`,
  the DEPRECATED wrapper** — every one of them would stay green if root emission broke
  outright, exactly the defect this ADR fixed in `form-content-seam.test.ts`, replicated
  fourteen times.

  Rewriting those 14 was rejected: it fixes 14 call sites and leaves the 15th to be written
  wrong. A wrapper assertion is only dangerous because root and wrapper can DIVERGE, so the
  fix pins them together — `test/discovery-root-mirror-parity.test.ts`, three assertions:
  every wrapper family is mirrored at the root; the values are identical; and no NEW dotted
  family key appears (allowlisting only the `host.forms` mirror, which must always be paired
  with plain `forms`). With that invariant held, a wrapper read is provably equivalent to a
  root read, and the single `return { ...advertisement, ...advertisement.capabilities }`
  cannot regress silently.

  Sabotage-verified three ways, distinct causes: drop the root spread → 41 families reported
  wrapper-only; add `'host.widgets'` → dotted-key assertion red; make one family diverge
  between arms → parity assertion names `cache`. Leg 1 also carries a non-vacuity floor
  (>20 families), so a doc that lost its wrapper cannot pass by iterating nothing.

## Implementation record

| Change | File | Verified by |
|---|---|---|
| Plain `forms` key + deprecated dotted mirror | `src/routes/discovery.ts` | `form-content-seam.test.ts` leg 1 |
| Comment corrected — expired G16 premise | `src/routes/discovery.ts` | — |
| Test moved off the wrapper onto plain-root | `test/form-content-seam.test.ts` | sabotage: drop the plain key → red; drop the RFC 0073 root spread → red |
| RFC 0111 non-advert pinned | `test/rfc0111-context-budget-non-advert.test.ts` | sabotage: advertise `contextBudget` → leg 1 red; supervisor stops echoing config → leg 2 red |

Every assertion added here was sabotage-verified — each fix has a matching sabotage that
turns its own assertion red, with a distinct cause. Non-vacuity is the point: the defects
this ADR fixes were **green tests and confident comments**, not red ones.
