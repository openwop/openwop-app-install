# ADR 0573 — An enabled test seam requires a non-anonymous principal

Status: Accepted (implemented)

## Context

`host-sample-test-seams.md` §"Production safety" now requires two things of an
enabled test seam (upstream #1000/#1001, conformance suite `1.106.0`,
invariant `test-seam-authenticated-when-enabled`):

1. an enabled seam **MUST require an authenticated, non-anonymous principal**,
   and a host minting an identity *because* no credential was presented **MUST
   NOT** count it;
2. a host **MUST NOT count two controls that read the same switch as two
   layers.**

Both clauses exist because of defects on this host.

### What was measured

Against the **live deployment**, 2026-08-15:

```
GET https://app.openwop.dev/api/v1/host/openwop-app/test/mock-ai/last-dispatch-budget?nodeId=probe
200  {"maxTokens":null}          # no credentials
```

That is the seam's own JSON, not an SPA-rewrite artifact. Behind it:

| fact | evidence |
|---|---|
| `OPENWOP_TEST_SEAM_ENABLED=true` on the live Cloud Run service | deployed env, 67 vars |
| the registration path's own log line | *"test seam ENABLED — NEVER enable in production."* |
| `POST …/test/mock-ai/program` stages a replay divergence keyed by `nodeId` | node ids are published in the shipped chain packs |
| the `provider: 'mock'` gate read the **same** env var | `aiProvidersHost.ts`, commented *"gated (defense-in-depth)"* |

**Scope, stated as a limit rather than a hedge.** Reachable staging is
*certain* — proven by probe. The end-to-end chain (staging → a run dispatching
on `provider:'mock'`) was **not** demonstrated; closing that gap would have
meant POSTing a program to a production host, which is not a thing to do to
answer a question.

### The correction that made the clause fixable

My first report said the route had *"no authz at all — no tenant resolution, no
principal."* **False.** `authMiddleware()` is global (`index.ts:628`), the seam
prefix is **not** on `PUBLIC_PATH_PREFIXES`, and a tenant *is* resolved. What
happens (`middleware/auth.ts:937`) is that with no bearer and no cookie the
middleware calls `mintAnonSession()` and the caller proceeds as `anon:<sid>`.
Anonymous sessions are a deliberate product feature (ADR 0015).

So **auth ran and succeeded, anonymously** — which is why the steward's first
draft of clause 1 ("the same authentication and tenant resolution as the
canonical surface") would have been satisfied by this host *while it was still
wide open*: RFC 0132 makes anonymous actors legitimate on the canonical surface,
so parity with it is satisfied by construction. The clause was rewritten to bind
a **non-anonymous** principal.

The general shape, which is the durable part: **"the route has a gate" is a
proxy for "an unauthenticated caller is refused", and the proxy failed here in
the reassuring direction.** A proxy that fails alarmingly wastes an afternoon;
one that fails reassuringly ships.

## Decision

**1. `req.anonymousPrincipal`, set from `session.tier`** at the single point that
knows whether a credential was presented — not a `tenantId.startsWith('anon:')`
test at each call site. That would be a classification derived from an
identifier, the same trap that had `core.db.sql-query` filed as a read on the
strength of the word *query*.

**2. `requireNonAnonymousPrincipal(surface)`**, applied to the seam prefix in
**both spellings** — `/v1/host/openwop-app/test` and the `/v1/host/sample`
legacy alias, which rewrites onto the same handlers. Guarding one would leave an
open door beside a shut one.

**3. ONE exemption: `test/login`,** the credential-establishing endpoint. A
guard covering it would be circular — the route that hands out a non-anonymous
identity cannot demand one. This is safe **only** because `test/login` rides a
genuinely separate switch (`OPENWOP_TEST_AUTH_ENABLED`, verified **unset** on
the live deployment while the seam flag was true). If those switches are ever
merged, the exemption becomes the hole — clause 2 pointed at the fix rather than
at the defect.

**4. `mockProviderEnabled()` on its own variable** (`OPENWOP_MOCK_PROVIDER_ENABLED`),
replacing five call sites that read `OPENWOP_TEST_SEAM_ENABLED` under a comment
claiming defense-in-depth. They were one layer wearing two names: a single env
setting opened both the staging seam and the provider consuming what it staged,
so the second control could never catch a failure of the first. Defaults to the
seam flag when unset, so existing postures are unchanged; setting it explicitly
is what makes the two independent.

### Two bugs the gate found in this fix

Recorded because the fix needed the same scrutiny as the defect.

- **The prefix guard caught `test/login`.** I had reasoned the gate was coherent
  because `test/login` rides a different env var — true, but it shares the
  *path prefix*, which is what I guarded. 17 tests across 4 files went red, all
  at the login call.
- **The exemption then matched nothing.** Written against `req.path`, which
  Express rewrites relative to the mount inside `app.use(prefix, mw)` — so it is
  `/login` under one mount and `/test/login` under the other. Matching
  `originalUrl` is the one spelling that means the same thing from both.

### Checked, not assumed

The real conformance harness **already sends a Bearer key**
(`conformance/run.ts:40`), so requiring credentials does not break
certification. The four remaining local failures were tests that had never
authenticated — receiving 200s from an unauthenticated seam was the defect, not
the baseline.

## Alternatives weighed

- **Flip `OPENWOP_TEST_SEAM_ENABLED=false` in production and stop there.**
  Rejected as the *only* action: it fixes this deployment and not the class, and
  the seam has to be enabled for certification runs. Worth doing as well — an
  operator decision, recorded here rather than taken unilaterally.
- **Add the seam prefix to a superadmin check.** Rejected: superadmin is a
  stronger requirement than the clause, and it would lock out the conformance
  harness's API-key principal, which is legitimately non-anonymous.
- **Rely on registration order so `authTestSeam` matches first.** Rejected:
  `app.use` prefix middleware only runs for routes registered after it, so the
  exemption would silently change meaning if the route table were reordered. An
  explicit path set is visible and testable.

## Implementation record

| item | where |
|---|---|
| anonymous mark | `src/middleware/auth.ts` (`anonymousPrincipal`, set from `session.tier`) |
| the guard | `src/middleware/auth.ts` (`requireNonAnonymousPrincipal`) |
| seam wiring + exemption | `src/routes/testSeam.ts` |
| independent mock switch | `src/aiProviders/aiProvidersHost.ts` (`mockProviderEnabled`) |
| tests | `test/test-seam-nonanonymous.test.ts` |
| adapted callers | `test/safefetch-hardening.test.ts` |

The suite asserts the **observable** property — never a 200 to a credential-less
caller — over real HTTP, plus a positive control (an authenticated caller still
gets 200, so "no 200s" cannot pass on a merely-broken seam) and a non-zero-probe
guard.

**Sabotage-proven:**

| sabotage | result |
|---|---|
| seam guard removed | 2 red |
| only the product spelling guarded, alias left open | red, naming the spelling |
| mock gate re-coupled to the seam flag | tripwire red |
| restored | `tsc` rc=0, 6 green |

Full gate green: backend **11392 passed / 69 skipped**, conformance **2564 / 80
skipped**, frontend **4222 passed**.

## Operator follow-up (not taken here)

`OPENWOP_TEST_SEAM_ENABLED=true` remains set on `openwop-app-backend`. This ADR
makes an enabled seam safe; it does not decide whether it should be enabled.
Turning it off is an `--update-env-vars` away and is the operator's call.

## Wire

None on the OpenWOP surface. Host-internal authorization on a non-normative
host-extension prefix; the upstream clauses are satisfied, not extended.
