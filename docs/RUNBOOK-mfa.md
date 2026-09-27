# Runbook — MFA (TOTP) enablement + lockout recovery

> Owner: the deployment operator. Scope: the MFA tasks that require console/CLI/API
> access the application deliberately does not have. Grounded in the 2026-07-19
> evidence pass recorded in `docs/adr/0389-account-security-and-secrets-depth.md`
> § Correction.
>
> **Why the app can't do these for you:** ADR 0026 removed the host credential store —
> Firebase/Identity Platform owns the second factor, and `routes/account.ts:17` records
> the deliberate decision not to run `firebase-admin` server-side. Every task below is
> therefore an identity-provider operation, by design.

| § | Task | ID | Status |
|---|---|---|---|
| 1 | Enable TOTP | `OPS-1` | **Blocked** — console offers SMS only; REST path unverified |
| 2 | Lockout recovery | `OPS-1b` | Ready — procedure below |
| 3 | Turn on `requireMfa` | — | Ready, after §1 |
| 4 | SAML assurance flip | `ENG-3` | Ready — one env var |
| 5 | Probe `MANDATORY` | `OPS-1c` | Ready — **throwaway project only** |
| 6 | Deliberately not adopted | — | Reference |

---

## 1 · Enable TOTP MFA (`OPS-1`) — unblocks the shipped enrollment surface

Until this is done, `/settings#security` renders an honest operator notice
("Multi-factor authentication isn't enabled for this deployment…") and **all of ADR 0389
Phase 1 is view-only**. The Phase-4 `requireMfa` tenant gate is enforceable but
meaningless, because nobody *can* enroll.

**Steps** (Google Cloud console, project `openwop-dev`):

1. **Upgrade Firebase Authentication → Identity Platform.**
   → <https://console.firebase.google.com/project/openwop-dev/authentication> — accept
   the Identity Platform upgrade prompt. TOTP MFA is a GCIP feature; plain Firebase Auth
   does not have it. **Read the pricing page before accepting**:
   <https://cloud.google.com/identity-platform/pricing> (the figures in the cost note
   below are secondary-source triangulations, not verified primaries).
2. **Enable the second factor — and expect the console NOT to offer TOTP.**
   → <https://console.cloud.google.com/customer-identity/mfa?project=openwop-dev>

   > **Observed 2026-07-19 on `openwop-dev`:** this page renders **exactly one** card —
   > *"SMS based Multi-Factor Authentication"* with a single **Enable** button. There is
   > no TOTP / authenticator-app control anywhere on it, and no TOTP option appears
   > under Providers. The project is already on Identity Platform (the Providers / MFA /
   > Users / Settings / **Tenants** nav is present), so this is **not** a missing-upgrade
   > symptom — the console simply does not expose TOTP.

   This is the same lag documented in ADR 0389 § Correction item 7: the **Admin SDK**
   exposes only `factorIds: ['phone']`, and the **console** likewise offers only SMS,
   while **Identity Toolkit REST v2** documents TOTP under `mfa.providerConfigs[]`.
   Three surfaces, three different levels of support.

   **Do not enable SMS as a workaround.** It is a NIST Restricted Authenticator (see
   below) and enabling it does not unlock TOTP.

3. **Enable TOTP via the REST API.** `[unverified — see below]` The documented shape is
   a `PATCH` on the project config with an updateMask covering `mfa`:

   ```
   PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/openwop-dev/config?updateMask=mfa
   Authorization: Bearer $(gcloud auth print-access-token)
   X-Goog-User-Project: openwop-dev
   Content-Type: application/json
   ```

   Reference: [Config REST v2](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config)
   — `MultiFactorAuthConfig` carries `state`, `enabledProviders[]`, and
   `providerConfigs[]` (where the TOTP settings live, including a configurable
   verification interval).

   > **This exact call has NOT been executed successfully against `openwop-dev`, and the
   > TOTP request-body shape has not been verified.** Read the current config with a
   > `GET` on the same URL first, then PATCH the minimum delta. If the `GET` round-trips
   > but the TOTP PATCH is rejected, that is a genuine finding — record it here and
   > treat TOTP as unavailable on this stack until Google exposes it, rather than
   > working around it with SMS.

   **IAM prerequisite (hit in practice).** The caller needs `roles/identityplatform.admin`
   *and* `roles/serviceusage.serviceUsageConsumer` on the project — a `GET` from
   `admin@myndhyve.ai` on 2026-07-19 returned `403 USER_PROJECT_DENIED` for the latter.
   Note this project already has a **split-account** gotcha recorded in `CLAUDE.md`
   (the project owner is not the Cloud Run deployer); confirm which account actually
   holds Identity Platform admin before assuming a permissions bug.
   → <https://console.cloud.google.com/iam-admin/iam?project=openwop-dev>

4. **TOTP parameters**, if the API accepts them: 6 digits, 30-second period, adjacent-
   window tolerance of 1 (the defaults; the app's enrollment UI assumes standard
   `otpauth://` semantics).
5. **Verify.** Sign in to the app → Settings → Security. The operator notice should be
   replaced by an **Add authenticator app** button. Enroll one factor end to end, then
   sign out and back in to confirm the challenge fires.
6. **Enroll a second factor and confirm the backup copy appears.** This is not optional
   polish — a second factor is the *only* self-service recovery path that exists (§2),
   so the operator should verify the affordance works before any user depends on it.

**Cost note (verify before committing).** Identity Platform is a paid tier above the
Firebase Auth free tier — the free allowance is ~50k MAU with per-MAU pricing in bands
above that, and SAML/OIDC seats are priced separately. TOTP verification itself carries
no documented per-verification charge. **These figures were triangulated from secondary
sources during the research pass and the primary pricing page did not render** — open
the Identity Platform pricing page yourself before treating any number as authoritative.

**Why not SMS.** NIST SP 800-63B Rev 4 (final 2025-07-31) classifies SMS as a
**Restricted Authenticator** — permitted, but the verifier must offer a non-restricted
alternative, give risk notice, and publish a migration plan. SMS is also metered per
message. TOTP avoids all of that.

**Why not passkeys (asked and answered).** Identity Platform supports **only SMS and
TOTP**. Passkey/WebAuthn support has been an open Firebase feature request since 2019
(`firebase-js-sdk#2123`) with no announced date; a *mock* implementation exists in the
Auth emulator only. See the ADR correction for why a self-hosted WebAuthn relying party
is foreclosed by ADR 0026.

---

## 2 · A user is locked out of their second factor

**First: this is usually avoidable.** The Security panel prompts every user with a single
enrolled factor to add a **backup authenticator**, and a second enrolled factor is the
self-service recovery path (NIST 800-63B-4 §4.2.2's "one recovery code plus a
single-factor authenticator" shape). Check whether the user has a second factor before
escalating — they can remove the lost one themselves after signing in with the backup.

**If the user has no second factor**, Identity Platform is explicit that it *"does not
provide a built-in mechanism for recovering second factors"* and that the user *"will be
locked out."* Password reset does **not** bypass MFA. The out-of-band path:

1. **Verify the human.** Use a channel independent of the account (a known-good video
   call, an existing ticket thread with the employer, an SSO-backed identity). The 2023
   help-desk social-engineering attacks that cost one operator ~$100M ran exactly this
   play — treat an unverified "I lost my phone" request as hostile.
2. **Remove the enrolled factor** in the Google Cloud console: Identity Platform → Users
   → find the user → remove the second factor from their MFA enrollment.
3. **Tell the user out-of-band** that their factor was removed, who removed it, and when.
   Do not rely on in-app notification alone for a recovery event.
4. **Record it.** Note the actor, the subject, the verification method used, and the
   timestamp in your operator log. (The app's own security-audit seam does not see
   console actions — this record is yours to keep.)
5. **Have them re-enroll immediately**, and this time enroll **two** factors.

> **Escalation:** if lockouts become routine, the recorded next step is an in-app
> admin-mediated reset — deliberately deferred because it reverses `account.ts:17`
> (server-side `firebase-admin`). That work needs its own ADR and must ship with the four
> guardrails the evidence names: step-up re-auth on the reset action, audit of the acting
> admin, independent-channel notification, and last-admin protection. Do not add it
> quietly as a dependency.

---

## 3 · Turning on enforcement (`requireMfa`)

Per-tenant enforcement already ships (ADR 0389 P4): Connections → Governance →
**Require MFA**. When on, a session without a verified second factor is refused with a
`401 mfa_required` deep-linked to `/settings#security`.

**Sequence it in this order** — the evidence is unambiguous that mandates work (GitHub's
mandatory 2FA reached ~95% compliance where voluntary programs sit at 2–22%), *and* that
they only reduce support load when self-service recovery exists first:

1. Enable TOTP (§1) and confirm enrollment works end to end.
2. Announce, and give a real enrollment window — GitHub used 45 days with a nag and a
   snooze before blocking.
3. Ask users to enroll **two** factors (the panel prompts for this).
4. Then flip `requireMfa` per tenant.

Exempt-by-design paths remain reachable while enforcement is on, so a user can never be
locked out of fixing their own state: `/users/auth`, `/users/me/security`,
`/me/workspaces`, and workspace switching. Personal tenants are exempt entirely.

**Known limitation.** Machine credentials (API keys) are *not* subject to `requireMfa` —
a documented exemption tracked as `DECIDE-5` in `docs/steward/TODO.md`. If any tenant needs
MFA-bound API keys, that requires mint-time MFA stamping on key rows.

---

## 4 · SAML assurance posture (`ENG-3`) — one env var, code already shipped

Today `OPENWOP_SAML_ASSUME_MFA` defaults to `true`: the host *assumes* an SSO tenant's
IdP enforced a second factor. Setting it to `false` switches to judging the assertion's
`AuthnContextClassRef` — already implemented at `routes/authSamlSso.ts:81`.

**Why this works here when it wouldn't through Firebase.** GCIP surfaces no `amr`/`acr`
claim and its SAML docs never mention `AuthnContextClassRef`, so a Firebase-brokered
integration is blind to federated assurance. This app parses assertions **host-side**,
so the context class is directly readable. The honest posture is reachable *because* of
the split model, not despite it.

```
gcloud run services update openwop-app-backend \
  --update-env-vars OPENWOP_SAML_ASSUME_MFA=false \
  --region us-central1 --project openwop-dev
```

Use `--update-env-vars`, **never** `--set-env-vars` — the latter wipes the 7-secret
binding (CLAUDE.md § deploy).

> **Coordinate before flipping.** Any SSO tenant whose IdP does not emit an MFA-bearing
> `AuthnContextClassRef` starts failing the gate the moment this lands. That is the
> correct behavior, but it must not be a surprise — notify SSO tenants first, and be
> ready to flip back (the variable is the whole switch).

---

## 5 · Probing GCIP `MANDATORY` enforcement (`OPS-1c`)

> ### ⚠ Do NOT run this against `openwop-dev`
> Setting `mfa.state = MANDATORY` on a project where nobody has enrolled can lock out
> **every user, including you**. There is no built-in second-factor recovery (§2). Use a
> **throwaway project** you are willing to abandon.

**Why probe at all.** ADR 0389 §3(d)/Phase 4 assumed the host must own MFA enforcement.
Identity Toolkit REST v2 documents a third state — `MANDATORY` ("Multi-factor
authentication is required for this project") — that the guide-level docs omit and the
Admin SDK cannot express. What it does to an *unenrolled* user's sign-in is undocumented.
Until that is known, `refuseIfMfaRequired` (`middleware/auth.ts:127`) stays the control
and is **not** demoted to defense-in-depth.

**Procedure**

1. Create a throwaway GCP project; enable Identity Platform; create one password user
   and **do not** enroll a factor.
2. `GET https://identitytoolkit.googleapis.com/admin/v2/projects/<THROWAWAY>/config` —
   capture the baseline.
3. `PATCH …/config?updateMask=mfa` with `{"mfa":{"state":"MANDATORY"}}`. REST only —
   the Admin SDK exposes just `DISABLED|ENABLED`.
4. Attempt a password sign-in with the **unenrolled** user. **Record the exact error
   code and message verbatim.**
5. Repeat with a **federated** sign-in, where a second factor is meaningless.

**Interpreting the result**

| Outcome | Meaning |
|---|---|
| Clean enrollment-required error, with a path to enroll | `MANDATORY` is real. Keep the host gate anyway (one owner), now backed by the IdP. |
| Hard refusal, no enrollment path | Unusable for a live tenant — the host gate remains the sole control. |
| Silent no-op | The guide prose was right; the enum is aspirational. Close the question. |

Record the finding in `docs/adr/0389-account-security-and-secrets-depth.md`
§ Correction item 7, which is flagged `[unverified]` pending exactly this.

---

## 6 · Deliberately NOT adopted (and why)

Recorded so these are re-decided on evidence rather than rediscovered as ideas.

- **Blocking Functions (`beforeSignIn`).** Expressive — GA, fires *after* second-factor
  verification, can deny and set `sessionClaims`, and is the only place reCAPTCHA
  Enterprise's `recaptchaScore` is readable. **But** `firebase.json` declares *hosting
  only*: there is no `functions/` directory, so this is a **third deploy surface**
  beside Cloud Run and Firebase Hosting. It also creates a **second enforcement owner**
  alongside `refuseIfMfaRequired`, on a different runtime and release cadence — the
  drift-prone dual-owner shape ARCHITECTURE.md exists to prevent. Revisit only if §5
  shows `MANDATORY` is unusable *and* a concrete policy need exceeds what the host gate
  can express. Constraints if adopted: 7s budget, 2000 req/min per project.
  → <https://docs.cloud.google.com/identity-platform/docs/blocking-functions>
- **GCIP multi-tenancy for per-tenant `mfaConfig`.** Genuinely first-class at the IdP,
  but this app's tenancy is its own (`user:<hash>`), not GCIP's. Adopting it is an
  identity re-architecture affecting every account, to obtain a per-tenant policy the
  shipped `requireMfa` already provides.
- **reCAPTCHA Enterprise step-up.** Gated behind blocking functions (the score is only
  readable there). Also note the **phone/SMS half is still Preview** under Pre-GA terms.
  → <https://docs.cloud.google.com/identity-platform/docs/recaptcha-enterprise>
- **Passkeys / WebAuthn.** Not available. Open since 2019 (`firebase-js-sdk#2123`); the
  only 2025–26 movement is an Auth *emulator* mock in CLI v15.21.0 (June 2026). An
  emulator mock is not a ship date — do not hold a design slot for it.
- **Staff hardware-key enforcement (different plane, real value).** Cloud Identity
  Premium + Context-Aware Access can gate *operator staff* on
  `request.auth.claims.crd_str.hwk` (hardware security key), with an IAP-fronted app
  reading `access_levels` from `x-goog-iap-jwt-assertion`. This governs Google-identity
  principals reaching IAP-fronted admin surfaces — it does **not** apply to GCIP
  end-users. It requires the ALB migration, which per the infra assessment converges
  with Cloud Armor and customer custom domains: sequence all three together rather than
  paying for the load balancer three times.
  → [editions](https://docs.cloud.google.com/identity/docs/editions) ·
  [access-level spec](https://docs.cloud.google.com/access-context-manager/docs/custom-access-level-spec) ·
  [IAP signed headers](https://docs.cloud.google.com/iap/docs/signed-headers-howto)
