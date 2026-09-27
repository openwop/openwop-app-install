# ADR 0691 — the peer-build window must span the deploy, not a fixed guess

Status: Accepted (implemented; see § Implementation record)

## Context

`verify-deploy.sh`'s H90 check asks one question: **did anyone else build while
my deploy was running?** The commit stamps cannot answer it — a clobbering
deploy's own stamps are internally consistent — so this is the only leg that can
see a parallel session landing on top of you.

It measured that with a fixed `PEER_BUILD_WINDOW_MIN=20`, and MEASURED on the
2026-09-15 deploy of `e972b27de`:

| | |
| --- | --- |
| backend build created | `2026-09-15T16:03:38Z` |
| verify ran | `2026-09-15T16:24:30Z` |
| elapsed | **21 minutes** — one minute outside the window |

So the window query returned zero, and H92's arm fired correctly: *"0 builds in
the last 20m, but a deploy JUST RAN, so at minimum your own build must be
here."* Every substantive leg passed — both halves at the right commit, bundle
digest, claims, wire, SPA shell, v2 origin — and the deploy reported
`DEPLOYED BUT NOT VERIFIED`.

**The 20 was not wrong when it was written; the deploy got longer.** Certify
(~10 min) and the ADR 0687 major-2 ratchet (~2 min) now run *ahead* of the
build, and the frontend half runs *after* it. The constant was calibrated
against a deploy that no longer exists.

## Decision

**`deploy.sh` stamps `DEPLOY_START_EPOCH` and exports
`PEER_BUILD_WINDOW_MIN` sized to its own elapsed time + 5 minutes.** The
question is "during MY deploy", and only the deploy knows how long that was. A
constant can only ever approximate it, and will drift again the next time a gate
is added to the front of the run.

`verify-deploy.sh`'s own default moves `20 → 45`, but only as the fallback for a
**hand-run** verify; a real deploy now passes the measured value.

**An operator-set value still wins** (`if [ -z "${PEER_BUILD_WINDOW_MIN:-}" ]`).
The override exists to widen a legitimately slow build, and silently recomputing
it would take that away.

## Why this is worth a fix rather than a waiver

A gate that **cannot pass** is worse than a miscalibrated one, and in a specific
way: it trains everyone to read `NOT VERIFIED` as noise. This particular check
is the only thing standing between us and the 2026-08-03 double-clobber, where
asset-hash equality reported success throughout while two sessions deployed over
each other. Its whole value is that a failure means something.

That is the same argument H92 makes one level down — it exists because the
window arm used to print `OK` for zero, and zero is never a clean result after
your own build. This ADR is the other half: H92 made zero fatal, and a window
too short to contain your own build made zero *inevitable*. Both halves have to
be right or the check is either blind or broken.

**The wider window trades a false negative for a false positive, deliberately.**
A 45-minute fallback can flag a peer's 40-minute-old build as concurrent. That
is the safe direction: it fails loud and a human looks, rather than passing
quietly while someone clobbers production.

## Implementation record

| change | file | witness |
| --- | --- | --- |
| stamp the deploy's start | `scripts/deploy.sh` | harness: "stamps when it started" |
| size the window from it | `scripts/deploy.sh` | harness: "spans the whole run" + the arithmetic case |
| do not overwrite an operator value | `scripts/deploy.sh` | harness: "does NOT overwrite" (sabotage-proved) |
| widen + document the hand-run fallback | `scripts/verify-deploy.sh` | — |

Four cases in `scripts/test-deploy-gates.sh` (111 passed, 0 failed). The two
structural cases pass against a formula that computes the *wrong number*, so the
arithmetic is asserted separately: a 21-minute deploy — the one that produced
this ADR — must yield a window that covers it.

Sabotage: forcing `deploy.sh` to recompute over an operator-set value reds the
override case (110 passed, 1 failed).

## The transferable part

**A constant that encodes a duration is a measurement with no expiry date.**
Nothing about `20` was checkable; it agreed with reality until a gate was added
in front of it, and then disagreed silently for exactly one minute's worth of
margin. The fix is not a bigger constant — it is to measure the thing the check
is actually about, which the script already knew and was throwing away.
