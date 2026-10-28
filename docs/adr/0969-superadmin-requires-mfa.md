# ADR 0969 — Superadmin requires a verified second factor (opt-in)

**Status:** Accepted (2026-10-23 — the KickTodo owner asked for it after a 2FA best-practice review)
**Date:** 2026-10-23
**Feature:** host access control (`host/superadmin.ts`, ADR 0028), account security (ADR 0389)
**RFC verdict:** **host-extension — no RFC.** The refusal is a host-local 403 on
`/v1/host/openwop-app/*` admin routes, and `superadminNeedsMfa` is an additive, host-local
field on the caller's own `/access/effective` response. No run event, capability advert,
endpoint contract or normative behavior changes.

## Context

A 2FA best-practice review of a production deployment (kicktodo.com) found that the
host's most powerful role needs no second factor. `requireSuperadmin` checks the
`OPENWOP_SUPERADMIN_TENANTS` allowlist and nothing else. Governance policy, feature
toggles, the operator connections panel and every other host-global admin surface
answer a single-factor session.

Only one superadmin path asked for MFA: ADR 0910's operator-access activation (G3).
That made the narrowest privileged act stricter than the broadest.

The review's sources were NIST SP 800-63B-4 (MFA at AAL2 for privileged access), the
OWASP MFA Cheat Sheet ("require MFA for administrative accounts"), and CISA's guidance
that privileged accounts are the first to protect.

ADR 0389 shipped the parts this needs:
- TOTP enrollment (P1);
- `req.mfaVerified`, decided by the host from the verified ID token's
  `firebase.sign_in_second_factor` claim (bearer) or the session's `mfa` mark stamped
  from it (cookie);
- the tenant `requireMfa` gate (P4), which covers SHARED workspaces only. Superadmin
  authority follows the person into their personal tenant, so P4 never reached it.

## Decision

**D1 — an opt-in flag.** `OPENWOP_SUPERADMIN_REQUIRE_MFA=true`, the exact string, turns
it on. The default is **off**.

A default-on requirement would lock out every superadmin on any deployment whose
identity project has MFA disabled. That is Identity Platform's own default, and it was
kicktodo-prod's state until 2026-10-23. Turning the flag on is an operator decision
with two preconditions, both stated in `.env.example` and the README: enable TOTP on
the identity project, and enroll every listed superadmin.

**D2 — the rule, inside `isSuperadmin`.** With the flag on, `isSuperadmin(req)` is
false when ALL of these hold:
- the principal is a **person session** (`auth.kind === 'subject'`, covering both the
  bearer and cookie paths);
- it is **not break-glass** (`principalId` not `breakglass:*`);
- `req.mfaVerified !== true`.

The rule sits in the predicate, not only in `requireSuperadmin`. About 40 files call
`isSuperadmin` directly as a gate, and the SPA's `/access/effective` projection reads
it too. One rule in the one shared gate (ADR 0028's reason for extracting it) means no
call site can drift.

**D3 — what is exempt, and why.**
- **API keys, the env key and the wildcard bearer** are tooling, not people. They are
  governed by their own scopes and narrowing (ADR 0561, ADR 0795). Whoever mints a key
  in a superadmin tenant is a person, and protecting key creation with MFA is a
  separate decision (see Consequences).
- **Break-glass** (ADR 0389 P3) is the door for when normal sign-in, and so the second
  factor, is unavailable. It is already single-use, ten minutes, non-refreshing,
  allowlist-bound, audited and notified. Requiring MFA there would remove the only
  recovery path the requirement itself makes more necessary.
- **`isListedSuperadmin`** (the plan paywall, ADR 0419, and operator-access eligibility,
  ADR 0910 G1) is unchanged. Entitlement is not an administrative act, and operator
  activation already has its own MFA gate (G3).

**D4 — the refusal names the fix.** When the caller WOULD be a superadmin but for the
second factor (`superadminNeedsMfa(req)`), `requireSuperadmin` throws 403 `forbidden`
with `details: { code: 'mfa_required', settingsUrl: '/settings#security', hint }`.
That's the same `code` operator access uses (`routes/operatorAccess.ts:50`). An
unlisted caller still gets the plain superadmin refusal: telling them to add MFA would
not help, and it would disclose that MFA is the only thing missing.

**D5 — the SPA can say why.** The caller's own `/access/effective` response gains
`superadminNeedsMfa: true` only in that case (additive, absent otherwise). Without it, a
single-factor superadmin sees every admin surface vanish with no explanation, the same
failure the 2026-09-23 "superadmin follows the person" fix existed to end. The Security
panel notice that reads it is a follow-up, after #5157, which touches the same file.

## Consequences

- **Deployments that leave the flag off see no change.** That's the default and is
  test-pinned.
- **Admin surfaces, never features.** With the flag on, a single-factor operator loses
  every admin surface but keeps the plan-paywall exemption. That exemption reads
  `isListedSuperadmin` (`entitlementGuard.ts:44`, `billing/routes.ts:160`) and
  `isListedSuperadminTenant` (`billingService.ts:871`), which D3 leaves unchanged on
  purpose. So the operator never sees their own features locked behind a second factor.
  `test/adr0969-paywall-untouched.test.ts` pins this with billing forced on and a plan
  that allows nothing, plus a customer control.
- **Break-glass cannot be spoofed by an IdP subject.** The exemption matches the
  `breakglass:` principal prefix, which only `routes/authBreakGlass.ts` mints. An IdP
  token whose raw `sub` is literally `breakglass:x` resolves to a namespaced principal
  and still needs MFA. Pinned over HTTP; loosening the match to a substring turns it red.
- **kicktodo.com:** set the flag only after the owner has enrolled TOTP (D1's
  preconditions). Its identity project has TOTP enabled with `adjacentIntervals: 1` as
  of 2026-10-23.
- **Residual: keys.** A person in a superadmin tenant can mint an API key while MFA'd
  and then use it without a second factor. That's acceptable, since keys are scoped,
  revocable and audited. Requiring MFA at key creation is the natural next step and is
  not decided here.
- **Residual: dev-open.** `OPENWOP_FEATURE_TOGGLES_DEV_OPEN` is a local-dev switch that
  makes every caller a superadmin. With both flags on, single-factor callers are still
  refused. That combination is meaningless in production, which never sets dev-open.

## Tests

`backend/typescript/test/adr0969-superadmin-requires-mfa.test.ts` (17 cases) and
`backend/typescript/test/adr0969-paywall-untouched.test.ts` (2 cases):
- the predicate: flag off unchanged; flag on refuses single-factor and admits MFA; the
  unlisted caller is not told to add MFA; api-key and env-key unaffected; break-glass
  exempt; only the exact `"true"` turns it on;
- the `requireSuperadmin` refusal shape;
- over HTTP, through the real auth middleware and a synthetic OIDC issuer: 403
  `mfa_required` on `GET /governance/policy` for a single-factor token, and 200 for the
  same subject with the verified claim; forged MFA headers change nothing; flag off
  passes as before; an IdP `sub` of `breakglass:x` still needs MFA; `/access/effective`
  projects `superadminNeedsMfa` only when true;
- the paywall exemption survives the flag for a single-factor operator in a customer's
  workspace.

Sabotage-witnessed: dropping the term from `isSuperadmin`, removing the break-glass
exemption, loosening it to a substring match, routing the paywall through
`isSuperadmin`, widening to key principals, reading the flag as default-on, and removing the
`mfa_required` branch each turn a case red.
