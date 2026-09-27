# ADR 0497 — Toast queue limit and focus-on-dismiss

Status: **Proposed** — design only; not implemented. Written to be argued with.

## Context

The announcement half of the toast problem is closed. `<Notice>` became opt-in
(#2620) once we established that a live region inserted **already holding its
text** is not announced, and that `role="alert"` is the spec-mandated exception —
so `error` was always fine and the other three variants were silent. #2632
delegated those 315 non-error uses to the shell's primed region and added a
`role="region"` landmark so the stack can be navigated to on demand.

`openwop-app-1` deferred two React Aria behaviours explicitly rather than folding
them into an a11y fix, because both change what a toast *is*:

1. a **visible cap with a queue** beyond it, and
2. **moving focus to the next toast when one is dismissed**.

This ADR is that decision. It is written because the second item is not obviously
an improvement, and shipping it because a respected library does it would be
adopting a mechanism without its preconditions — the failure mode this programme
has hit three times (`role="status"` assumed to announce; `--force-with-lease`
assumed to protect; branch-existence assumed to mean ownership).

### What the code does today

`ui/toast.tsx` has **no cap**. `push()` appends and `emit()` re-renders; the only
bound is `armDismiss`'s TTL (4s success/info, 5s warning, 6s error) and **UI-4
coalescing**, which collapses an identical `variant + message` pair into the
existing toast and refreshes its timer. Focus is never moved. Dismiss is a
per-toast close button.

Coalescing matters to this decision: the motivating case for a queue — a bulk
operation firing N identical toasts — is **already** one toast. What is not
bounded is N *distinct* toasts.

## Decision drivers

- **An unbounded stack can cover the viewport.** Distinct toasts (a batch where
  each row fails differently) stack until their TTLs expire. On a short viewport
  that occludes content and, worse, the controls a user would use to recover.
- **Moving focus is a WCAG hazard in its own right.** SC 3.2.1 (On Focus) and
  2.4.3 (Focus Order) exist because unrequested focus changes disorient — a
  sighted keyboard user loses their place, a screen-reader user is teleported
  mid-sentence. "Accessible" is not a direction; it is a set of trade-offs.
- **React Aria's focus behaviour has a precondition we do not currently meet.**
  Its toast region is focusable and participates in a focus-containment model;
  moving focus to the next toast is *restoration within a region the user is
  already inside*, after the user themselves dismissed one. It is not the app
  reaching out and taking focus from an unrelated task. Adopting the behaviour
  without the precondition inverts it from helpful to hostile.
- **Our toasts auto-dismiss; React Aria's canonical example does not.** A toast
  that disappears on a timer while focus is inside it creates a focus-loss event
  the library's model does not have to solve. This is the sharpest mismatch and
  the reason the two halves cannot simply be adopted together.

## Options

**A. Do nothing.** The landmark already gives an on-demand route back, and
coalescing already handles the common burst. Costs nothing; leaves the viewport
occlusion case open.

**B. Cap + queue only.** Render at most N (proposal: 3); hold the rest and promote
them as slots free. Bounds the viewport damage. No focus semantics change, so no
new WCAG risk. The queued ones still announce via the primed region at `push()`
time, so nothing becomes *less* audible — but a queued toast may expire before it
is ever seen, which is a real loss for a sighted user and must be stated.

**C. B, plus focus-to-next ONLY when focus was already inside the toast region.**
Keyboard-dismiss a toast and focus lands on the next one rather than the document
body. If focus was elsewhere, nothing moves. This keeps the useful half of the
React Aria behaviour and drops the part that requires their containment model.

**D. Full React Aria adoption** — focusable region, containment, queue, focus
management, and disabling auto-dismiss while focus is within. Most faithful,
largest change to what a toast is, and it makes toasts persistent-by-default for
keyboard users.

## Recommendation

**Option C**, with **B shippable independently and first**. The cap is a bounded,
low-risk improvement with no focus semantics; the focus rule is separable and
should not hold it up.

The load-bearing constraint on C, which must survive into the implementation:
**focus moves only if `document.activeElement` was already within the toast
region at dismiss time.** A toast auto-expiring must never move focus. If that
constraint is ever relaxed, C becomes D-without-the-model, which is worse than A.

Option D is not recommended now. Disabling auto-dismiss while focus is inside the
region is defensible, but it changes toast lifetime — and lifetime is what
distinguishes a toast from a `<Notice>` in this design system (`toast.tsx:8`).
That is an ADR 0010-adjacent question about the notification surface as a whole,
not a detail of this component.

## Open questions

- **OQ1 — is N=3 right? ✅ ANSWERED — no, and no cap is.** Measured: the ceiling is
  **2** distinct toasts, at one site. See § Correction below. Option A it is.
- **OQ2 — what happens to a queued toast whose TTL expires before promotion?**
  Drop it silently, or start its clock on promotion? Starting on promotion means
  a slow queue keeps toasts on screen far longer than their nominal TTL.
- **OQ3 — does the landmark make the queue less necessary?** If a user can
  navigate to the region on demand, the cost of a bounded stack is lower than it
  was before #2632.
- **OQ4 — no screen-reader verification exists for any of this.** Three sessions
  have now agreed that a VoiceOver/NVDA pass is the highest-value missing
  evidence in the whole a11y effort and that none of us can produce it. **This ADR
  should not reach Accepted on inference alone** — its focus claims are exactly
  the kind that a real AT pass falsifies.

## Correction — OQ1 measured, and it removes half this ADR (2026-07-28)

**OQ1 is answered, and the answer kills Option B.** Recorded as a correction rather
than an edit to the reasoning above, per the ADR policy: the trail is the point.

The recommendation was Option C — cap-and-queue **plus** the focus rule — with the
cap "shippable first and independently". Measurement says **the cap would never
engage**, so shipping it first would have meant shipping dead code, and shipping it
at all buys a queue whose OQ2 cost (what happens to a queued toast whose TTL
expires before promotion) is paid for nothing.

**What was measured.** A cap only matters if 3+ **distinct** toasts can be live at
once; identical ones already coalesce (UI-4). Two sweeps over `frontend/react/src`:

1. **toast calls inside loop/batch constructs** — 38 sites across 19 files, which
   looked damning. Reading them, essentially all are `try { toast.success } catch
   { toast.error }` — **mutually exclusive branches, never both**. The construct
   that triggered the match was usually unrelated: `DealersPage`'s hit was a
   `companies.map()` in a `useMemo` twelve lines above the toast.
2. **toasts downstream of a stream / subscription / interval handler** — 5 sites,
   all success/error pairs in user-initiated async flows (replay, create,
   approve). **No background handler fires toasts repeatedly.**

**Exactly one site can produce two toasts in a single pass** —
`memory/MemoryInspectorPage.tsx:91-92`, a bulk delete reporting partial failure:

```ts
if (ok > 0)     toast.success(t('bulkDeleteSuccess', …));
if (failed > 0) toast.error(t('bulkDeleteError', …));
```

That is **2**, from one deliberate design choice, and it is the maximum in the
codebase. `N=3` was convention; the real ceiling is 2.

**Revised recommendation: Option A for the queue.** The cap is not justified — not
"deferred", not "later": there is no population for it. If a future surface starts
emitting per-item toasts in a loop, re-running this measurement is the trigger, and
that is cheaper than carrying an unused queue.

**Caveat on the method, stated because the first count was misleading.** The
loop-proximity scan over-reported by roughly 38-to-1, and I nearly wrote "38 sites
can burst" into this file. Both figures came from the same heuristic; only reading
the code separated them. **Treat the 38 as a scanner artifact, not a finding** —
the same trap as 45→80→91 and 264/60 vs 285/82 elsewhere in this programme.

**OQ4 is untouched by this.** The focus half still rests on inference, still has no
screen-reader verification, and still must not reach `Accepted` on that basis.

## Consequences

Shipping B alone: bounded viewport occlusion, no new a11y risk, one new failure
mode (unseen expired queue entries) that OQ2 must answer.

Shipping C: keyboard dismissal stops dumping focus to the body. The constraint
above is the whole safety argument; a review of C that does not check it has not
reviewed C.

Not shipping either remains defensible, and this ADR is written so that
"we measured OQ1 and the cap is unnecessary" is a legitimate outcome rather than
a failure to deliver.
