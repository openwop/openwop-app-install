# ADR 0707 — The widget's cost caps fail open, beside a write cap that fails closed

Status: **implemented** (status corrected 2026-09-17 — see § Status correction)

Feature loop 2026-09, iteration 41 — Embeddable chat widget (`FEATURES.md` ordinal 209,
ADR 0127/0073/0469/0132). Graded at `origin/main` `9e8889c8a`. Ids continue the
2026-08-27 passes (`WGC-`/`WGU-`/`WGWF-`).

## Context

This feature grades **A / A− / A−** and the workflows pass calls it *"the strongest
public-boundary hardening in the app."* That is fair: token-as-192-bit capability,
dot-boundary spoof-proof origin allowlist, host-owned key only, fenced visitor input,
PUBLIC-projection responses, cross-tenant agent block.

Exactly one row stands between it and A, and re-verifying it at HEAD made it sharper
than filed.

## D1 (Blocker on a public surface, `WGC-1` + `WGU-1`)

`capsTracker.ts:148-149`:

```ts
const maxTurns = widget.caps.maxTurnsPerSession ?? Infinity;
const maxSessions = widget.caps.maxSessionsPerDay ?? Infinity;
```

`cleanCaps` (`widgetService.ts:107-121`) only records a cap when the operator supplies a
positive number, so **unset ⇒ `Infinity`** — an internet-reachable, operator-billed LLM
surface with no bound.

### Two things make this more than a cost note

**1. It makes a stated containment bound vacuous.** `publicGateway.ts:107-109` explains
the session model:

> Client-supplied opaque session id buckets the caps. A visitor resetting it is bounded
> by **`maxSessionsPerDay`** + the global per-IP rateLimit.

When the cap is unset — the default — the first half of that sentence does nothing, and
the design's stated answer to "visitor rotates their session id" reduces to the per-IP
limit alone, which rotating IPs defeat. The comment is not wrong about the *design*; it
is wrong about the **default configuration**, which is the one most widgets run.

**2. The rule is already stated and enforced next door, for the weaker threat.**
`cleanCaps:116-119` on the auto-write cap: *"a bound-less auto control is the fail-open
shape the RFC forbids"*, enforced by `assertControlCapsCoherent` in both write paths.
So the principle is articulated, implemented, and simply not applied to the caps that
cost money.

### The design question was already answered — by ADR 0470 P3, in this same file

I was weighing *refuse-on-write* (matching `assertControlCapsCoherent`) against
*default-on-read*, and the trade-off is real: refusing leaves existing widgets uncapped,
defaulting changes live behaviour. **The repo has already decided it, three lines up
from the defect**, for the adjacent cap and the identical threat model
(`capsTracker.ts:89-99`, an architect finding):

> the operator inbox is a PUBLIC-facing flood target, so its bound must **NOT be
> operator-optional**. When `maxWritesPerDay` is unset, a **secure default**
> (`OPENWOP_ANON_WRITE_DEFAULT_PER_DAY`, default 25) applies — an UNCONFIGURED anon
> widget is bounded by default rather than uncapped. The operator's explicit cap (up OR
> down) still wins; the default is only the floor when they set nothing.

With the crucial detail at `:103`:
`if (maxWrites === Infinity) return { allowed: true }; // only if an operator EXPLICITLY set an uncapped value`
— an operator **may** opt out, but **absence is not opt-out**. That is
"[[fail-open-default-is-a-shape]] — DELETION becomes a GRANT" solved correctly, in
code, already.

**So this ADR does not invent a posture. It applies the established one to the two caps
it was never applied to.** An LLM turn is a strictly *worse* thing to leave unbounded
than an inbox row: it bills the operator.

### Decision

- **D1a** — secure defaults at READ, mirroring `DEFAULT_ANON_WRITES_PER_DAY` exactly:
  `OPENWOP_WIDGET_TURNS_DEFAULT_PER_SESSION` (default 20) and
  `OPENWOP_WIDGET_SESSIONS_DEFAULT_PER_DAY` (default 200).
- **D1b** — an operator's explicit value wins in **both** directions, and an explicit
  `Infinity` remains a genuine opt-out — copied from `:103`, because the distinction
  between *unset* and *explicitly unbounded* is the whole point.
- **D1c** — correct `publicGateway.ts:107-109` so the stated bound is true of the
  default configuration, not only of a configured one.
- **D1d** — `WGU-1`: the caps editor pre-fills the defaults, so the operator sees the
  bound that is actually in force rather than an empty field that reads as "no limit".

**Deliberately NOT done:** refusing provisioning without caps
(`assertControlCapsCoherent`'s shape). It is the right shape for an *auto-executing
write* control, where there is no safe default — but here a safe default exists, and
refusing would break every existing operator's save while leaving already-provisioned
widgets uncapped. The precedent chose the default for exactly this reason.

## RFC verdict

**No RFC.** Host-ext throughout: two read-time defaults on an existing non-normative
public route, plus an editor pre-fill. No wire shape, no capability advertisement, no
conformance claim. RFC 0132 §C.3's "no unbounded auto-run control" is *honoured more
fully* by this change, not altered.

## Open questions

1. The default VALUES (20 turns/session, 200 sessions/day) are a product judgement. They
   are deliberately generous — the goal is "bounded", not "tight" — and an operator can
   move them either way. A maintainer may want different numbers.
2. `WGU-2` (the embed runtime ignores `prefers-color-scheme`) — untouched, Nice-to-have.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was **already implemented and
merged**. Evidence: `a0886e798` — *the cost caps failed open beside a write cap that fails closed*, with `test/chat-widget-caps.test.ts` in the tree.

Corrected as part of an ADR-status sweep that found **five** such records (0700, 0701,
0703, 0707, 0708). The failure mode is not cosmetic: `Status:` is the field a planner
reads to pick work, so a stale `Proposed` either sends someone to redo finished work
or tells them a closed defect is still open. `docs/adr/adr-status-not-stale.test.ts`
now fails when an ADR with a merged implementing commit still reads `Proposed`.

Verified per-ADR against the code (`features/chat-widget/capsTracker.ts`), not by counting commits — an early pass
of this sweep matched commit BODIES and produced contaminated counts, and ADR 0700's
own citation belongs to a decision that was renumbered away from it.

