# ADR 0743 — The OIDC lane is advertised as `exp-only`, and the window is enforced

Status: implemented

## Context

This host verifies Firebase ID tokens (`middleware/oidcVerifier.ts`) and has always
served that front door, but it **omitted the `oidc` lane from its v2 advertisement**
(ADR-less, recorded in a 30-line comment in `routes/discovery.ts`). The reason was
honesty, not oversight: `identity.md` §2.2's `revocation` vocabulary had nine members and
none described what this host does — verify signature, `iss`, `aud`, `exp`, and never ask
the trust root again. `exp-and-recheck` promises a recheck that does not happen;
`next-request` promises a per-request refusal; `short-lived` promises a credential
lifetime this host neither mints nor bounds. Omitting the lane under-claimed a lane we
serve, which is the safe direction.

RFC 0210 (corpus `v2.36.0`, tag `21f518e4`) closes the vocabulary gap with **`exp-only`** —
"honours `exp`, re-checks the trust root never" — which is exactly this host's behaviour.
The RFC exists because the gap was being resolved in the *unsafe* direction elsewhere:
MyndHyve advertises `short-lived` with a 3600 s window while calling `verifyIdToken`
without `checkRevoked`, so nothing on that host ever asks whether the subject was revoked.

RFC 0200 separately makes a host with an `oauth2`/`oidc` lane an OAuth **protected
resource**: it must serve RFC 9728 metadata at the URL derived from its resource
identifier, and refuse with a `WWW-Authenticate` challenge that points there.

## Decision

Advertise the `oidc` lane with `revocation: "exp-only"` and
`revocationWindowSeconds: 3600`, **and ship the four things that make that advertisement
true in the same change** — the order WHD-31 insists on, because `exp-only` is the one
member of the vocabulary that costs something. On an `exp-only` lane the host never
re-checks, so a subject revoked upstream keeps access for the credential's full remaining
life and the window is the ONLY bound on that.

1. **The lane** (`routes/discovery.ts` `v2AuthFamily`), gated on the verifier actually
   being configured — an advertised lane whose issuer this host does not verify against
   is a lane nobody can use. `issuers` is the one configured issuer.
2. **The lifetime bound** (`middleware/oidcVerifier.ts`), refusing with the registered
   code `credential_lifetime_exceeded`. **TWO comparisons, a disjunction, neither
   implying the other:** `exp − iat > window` (a ten-year token minted ten years ago has
   a short remaining life and an unbounded lifetime) and `exp − now > window` (a freshly
   minted ten-year token in its ninth year is the mirror). A token carrying **no `iat`**
   is refused with the same code — the first bound is unevaluable without it, and §2.1
   fails closed rather than skipping a bound it cannot check.
3. **The metadata** (`/.well-known/oauth-protected-resource`, plus the RFC 9728 §3.1
   sub-path form `…/api` this host is reached at behind the Hosting rewrite),
   unauthenticated, listing exactly the lane issuers and inventing nothing else.
4. **The challenge** (`middleware/authChallenge.ts`, called from every API 401),
   carrying `resource_metadata` always and `error="invalid_token"` only when a credential
   was actually presented.

**ONE constant, `OIDC_REVOCATION_WINDOW_S`, is read by both the advert and the refusal.**
Drift between "what we advertise" and "what we enforce" is the entire defect class this
RFC addresses, and a second literal anywhere reintroduces it — the same discipline the
`workload` lane already uses with `MAX_CREDENTIAL_TTL_S`.

**No clock-skew tolerance is added to the lifetime bound**, unlike the `exp`/`nbf`
checks. Tolerating δ would mean accepting `window + δ` of remaining life while
advertising `window` — a quiet over-claim of exactly the kind being corrected. A host
whose clock lags the issuer therefore refuses slightly early: the fail-closed direction.
3600 s is chosen because it is exactly what Firebase mints (`exp − iat === 3600`), so
real tokens sit on the boundary rather than outside it, and RFC 0210 §C.7 asks for "one
hour or less" while deliberately setting no MUST ceiling.

**The lifetime refusal is terminal in both cookie postures.** The existing fallthrough
(a momentarily-stale bearer may still reach a healthy session cookie) is deliberate and
untouched for every other verification failure. An over-lifetime credential is a
different thing: serving the request anyway would make the advertised window a number we
print. The suite presents its probe with no cookie at all, so a fallthrough would answer
`201` and the row would go red honestly.

## Correction to the plan: WHD-31 specified the wrong bound

The checklist in `docs/steward/TODO.md` (written before the RFC landed) said to refuse
when `exp − iat > window` **AND** `exp − now > window`. **That conjunction is wrong and
would have failed the suite.** Read from the shipped scenario
(`v2-lane-exp-only-bound.test.ts`, suite 2.36.0): the two legs are constructed so that
each satisfies exactly ONE bound — the total-lifetime leg has `exp − now` INSIDE the
window, and the remaining-lifetime leg has `exp − iat` inside it. Under a conjunction
both would be served. The requirement is a **disjunction**, and the row has been
corrected.

This is the CLAUDE.md lesson about citations applying to a checklist written by this
project: the plan was a claim, the scenario was the evidence, and they disagreed. The
scenario ships as TypeScript under `src/`, so reading it costs nothing.

## Not done, and why

- **`scopes_supported` is omitted** from the metadata. This host enforces no OAuth
  scopes on its routes, so listing any would be invented. The suite's §B insufficient-scope
  leg is consequently gated on `OPENWOP_TEST_LOW_SCOPE_KEY`, which this host does not
  configure, and records `blocked` — the honest verdict. `setBearerChallenge` accepts an
  `insufficient_scope` + `scope` shape so the day a scope gate lands the challenge is
  already correct, but nothing calls it yet and no test claims otherwise.
  > **CORRECTED 2026-09-24 (ADR 0745 D2) — "this host enforces no OAuth scopes" was
  > true of the RBAC flag and false of the premise.** `requireProtocolScope` does gate
  > four protocol scopes; it was a no-op in the default posture, and a self-service
  > `owk_` key's declared scopes were ignored on protocol routes. ADR 0745 makes key
  > narrowing unconditional, publishes exactly those four as `scopes_supported`,
  > attaches the `insufficient_scope` challenge to the key-scope refusal as #4113 does to the membership one, and gives the
  > harness a low-scope key — so the `blocked` above is now `executed-pass`.
  >
  > **Also missed here: the whole Verification section measured the conformance
  > posture (cookies off), and production runs cookie mode**, where a credential-less
  > request was minted an anonymous tenant and `challenge-401` answered `404`. See
  > ADR 0750 (#4106) — ADR 0745 D1 withdrew its own fix in its favour.
- **No binding claims** (`dpop_bound_access_tokens_required`,
  `tls_client_certificate_bound_access_tokens`): the lane's `minimumAssurance` is
  `bearer`, and claiming a binding it does not require is the
  `sender-constraint-no-bearer-downgrade` violation.
- **The v1 advertisement is untouched.** `openwop-auth-oidc-user-bearer` needs no
  revocation rule, which is why omitting the v2 lane was survivable for so long.

## Verification

- `backend/typescript/test/rfc0200-oidc-lane-and-challenges.test.ts` (18): the four
  lifetime legs against a REAL synthetic issuer (RSA keypair, signed JWT, live JWKS
  endpoint — not a re-implementation of the comparisons), each isolating one bound with
  the suite's own `iat` skew; a control that a credential inside the window is accepted;
  `expired` still distinguishable from the lifetime code; the RFC 9728 URL form; the
  challenge shapes; and HTTP legs for the advert, both metadata paths, the 401 challenges
  and the terminal refusal.
- Sabotage (each reverted, each reddening exactly ONE leg): delete the `exp − iat`
  comparison → only the total-lifetime leg reds; delete `exp − now` → only the
  remaining-lifetime leg reds; delete the terminal branch in `auth.ts` → only the
  no-fallthrough HTTP leg reds.
- Two harness defects were found and fixed while building this, both of which had
  produced a passing test that asserted nothing: a `continue` guard that skipped both
  challenge legs while they returned 400, and `OPENWOP_AUTH_DISABLE_COOKIES` set after
  `createApp` (the posture is captured at construction). Recorded here because the tests
  looked green in both states.

## Correction (2026-09-23, handover): the major-2 lane was never run, and it was red

> The "Verification" above measured the major-1 conformance lane (541/2) and this
> repo's own tests. **`npm run ci` stops at the first red lane, and major 1 was red on
> the trace carrier, so `check-conformance-major2.sh` never executed for this ADR.**
> Run on the rebased branch with the 2.36.1 pin it showed three UNLISTED reds, none of
> which the prior reports mentioned:
>
> - **`v2-lane-exp-only-bound` (4/4 red, control included) — run-order, not
>   enforcement.** Run in isolation (`--filter v2-lane-exp-only-bound`) it passes 4/4,
>   so the disjunction above is correct. The cause: the suite's synthetic issuer mints
>   every instance with kid `openwop-conformance-key-0` and a fresh key at the same URL,
>   and `OidcVerifier` cached the previous scenario's key under that kid for the whole
>   10-minute TTL — a kid-miss refetch cannot see a re-used kid. Fixed in the host: a
>   signature failure against a CACHED key triggers ONE refetch, bounded by a 30 s
>   cooldown (`JWKS_SIG_REFETCH_COOLDOWN_MS`) so a forged signature cannot buy an
>   outbound fetch per request. Pinned by `test/oidc-verifier-kid-reuse.test.ts`
>   (sabotage: reverting the verifier reds 2 of its 3 legs). The kid reuse is also a
>   suite defect, reported upstream.
> - **`v2-oidc-id-token-audience` — a real host gap.** A verified token for another
>   relying party answered `unauthenticated` with `details.reason: wrong_audience`; RFC
>   0200 §D requires the registered top-level `audience_mismatch`. `auth.ts` now maps it
>   (`details.reason` kept for the v1 shape). `auth-oidc.test.ts` pins the code.
> - **`v2-lane-issuer-advertised` — a real host gap, predating this ADR, exposed by the
>   2.36 pin.** The `workload` lane advertised `short-lived` + a window (ADR 0730 C.3);
>   identity.md §2.2's workload row names only `delegation-expiry`, which names no
>   window. Now advertised as `delegation-expiry` with no window; the ADR 0730 test is
>   corrected in place and configures the oidc lane so its windowed-rule leg still
>   ranges over a non-empty set. **Not changed, flagged:** the `scim` lane advertises
>   `next-request` where §2.2 says `bound-connection`; the conformance boot does not
>   advertise scim so the suite never measures it, and switching it would be a claim
>   about binding behaviour nobody here has verified.

## Correction (2026-09-25): the insufficient-scope challenge now has its caller

> "Not done" above said `setBearerChallenge` accepts an `insufficient_scope` +
> `scope` shape "so the day a scope gate lands the challenge is already correct,
> but nothing calls it yet", and that this host "enforces no OAuth scopes". The
> second half was wrong: a scope gate had already landed. `requireProtocolScope`
> (`host/protocolAuthorization.ts`, RFC 0049 / ADR 0006) refuses a missing
> `runs:create` / `runs:read` with `403 forbidden` whenever
> `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`. It just refused without the RFC 0200
> §B.1 challenge. Its deny path now sets
> `Bearer error="insufficient_scope", scope="<scope>", resource_metadata=…`. The
> body stays `forbidden` (§B.4), and a resource-binding 403 is thrown elsewhere, so
> it cannot carry the challenge. Pinned by
> `test/rfc0200-insufficient-scope-challenge.test.ts` (enforcement on, a
> non-wildcard key with no membership; reverting the call fails the challenge leg,
> 1 of 2). Enforcement stays OFF by default, and in the conformance boot, so this
> changes nothing observable until an operator turns it on. Wiring the boot so
> `0200.challenge-403-scope` executes is a separate change: it flips the
> advertised authorization capability, and `auth-api-key-rotation`'s secondary key
> must then be seeded as a member.
