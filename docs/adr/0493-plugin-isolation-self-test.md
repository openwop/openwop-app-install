# ADR 0493 — The plugin-isolation page checks what it can, and says what it can't

Status: implemented

## Context

`/ui-plugins` is the **reachable witness** for the front-end-plugin isolation boundary
(ADR 0300, RFC 0117/0119). It lists four falsifiable legs —

- **isolated** — an opaque origin (`allow-scripts` without `allow-same-origin`)
- **egress-denied** — `default-src 'none'`, no `connect-src`
- **allowlist-bound** — an undeclared `ui-plugin/1` method → `method_not_allowed`
- **no-BYOK** — no credential-bearing method exists in the host allowlist

— **as prose**, beside a mounted reference plugin. Nothing verified any of it.

PR #2559 fixed the adjacent problem: the page used to render *nothing* when the witness
couldn't mount, so an operator who came to check that isolation holds saw an
unremarkable page and could conclude it was fine. That made the absence honest. It did
not make the claims checked.

This is the same defect family the 2026-07-25 programme kept finding — **a claim
asserted rather than read** — but pointed at ourselves: the page asserts four security
properties and verifies none.

## Decision

Add a **self-test** that mechanically checks the three legs that can honestly be
checked, and **explicitly refuses to check the fourth**.

### The probe does not run inside the real plugin document

Injecting probe script into a downloaded, untrusted plugin's `srcdoc` would mean
**editing a security-critical mount in order to test it** — changing the thing under
test, on the one file where that is least acceptable.

Instead the self-test mounts **its own first-party probe document** under the **same
exported `PLUGIN_SANDBOX` and `PLUGIN_CSP` constants** the real frame uses. They are
imported, never copied, so the test cannot drift from the boundary: **weaken either
constant and the self-test goes red.** That makes it a regression guard on the
configuration, not just a demo.

### `no-BYOK` is not probed, and does not get a tick

It is the **absence** of a credential-bearing method from a closed allowlist — a
property of the schema, not something a probe can demonstrate. A green checkmark there
would be decorative.

**Four ticks where one is decorative is worse than the prose it replaced.** It is
exactly the "assert what you did not verify" defect this programme has spent its time
closing, and shipping it onto a *security* page would be the worst possible place to do
it. The leg renders as **ASSERTED** — visually distinct from PASS, with the reason
stated inline.

### Verdicts are computed by the host, not reported by the frame

The probe reports **observations** (`origin`, `blocked`), never a verdict. The host
decides pass/fail. An untrusted-shaped surface must not be able to self-certify, even
when it is first-party today.

### An unanswered probe is INCONCLUSIVE, never a pass

A 4s timeout marks the leg "no answer". A probe that never replies proves nothing in
either direction, and defaulting it to green is the same failed-read-as-success shape
found across the rest of the programme.

## Alternatives considered

- **Probe from inside the real plugin frame.** Rejected — see above. Modifying the
  security-critical mount to observe it is the wrong trade.
- **A backend conformance test instead of an in-page check.** Rejected as a
  *replacement*, not as an addition: the value of this page is that an operator can see
  the boundary hold **in their own browser, on their own deployment**. A CI assertion
  does not tell them that. (A backend self-test remains worth having separately.)
- **Show four ticks and footnote the fourth.** Rejected — a footnote does not undo a
  green tick; readers scan the marks, not the note.

## Consequences

- The three checked legs now **fail loudly** if the boundary regresses, including via
  an innocuous-looking edit to `PLUGIN_SANDBOX`/`PLUGIN_CSP`.
- Message authentication is **by window reference**, not `event.origin` — the frame is
  an opaque origin, so `origin` is `"null"` and cannot authenticate anything. Tested.
- The self-test is **opt-in per visit** (a button), not automatic: it mounts a frame and
  attempts a network request, and doing that on every page load would be surprising.

## Implementation record

| Phase | Change | Verify |
|---|---|---|
| P1 | `IsolationSelfTest.tsx` — probe doc + host-side verdicts | 9 cases in `IsolationSelfTest.test.tsx` |
| P2 | Wired into `UiPluginsPage` under the prose legs | frontend build green |
| P3 | 13 keys × 4 locales | `check-i18n` |

The allowlist leg exercises the **real** `makePluginMessageHandler` — the same function
the live channel uses — against a plugin whose declared `hostApi` omits the probed
method, and asserts both that it was refused **and** that `forward` was never called.
A refusal that still contacted the host would not be a pass.
