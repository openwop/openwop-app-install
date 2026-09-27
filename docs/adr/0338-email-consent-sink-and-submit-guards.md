# ADR 0338 — Email opt-in sink + submit-guard seam on the forms primitive

**Status:** Accepted (2026-07-10; implementation same day)
**Depends on:** ADR 0330 (submission sinks — second/third registrants; resolves
its multi-sink open question), ADR 0017 (alt-4 anti-spam hook — closed here),
ADR 0019/0227 (email marketing + per-channel consent), ADR 0020 (consent),
ADR 0008 (CRM contact — the subject key)
**Toggles:** `forms` + `email` (STABLE). Host-ext, no wire, no RFC.

## Decision

**D1 — per-form email opt-in designation.** `FormDef.emailOptInField?: string`
names one of the form's `checkbox` fields (sanitized on create/update: must
reference an existing checkbox field; cleared when the field is removed — the
`intakeBinding` precedent). Builder UI: a select of checkbox fields, rendered
only when the tenant's `email` toggle is on (the ADR 0330 §D4 crm pattern).

**D2 — the `email-consent` sink** (registered by the email feature at boot —
integrator → primitive). Acts only when ALL hold: the form designates an
opt-in field · the submitted value is exactly `true` (an explicit grant, never
inferred — unchecked/absent is a silent skip, NOT an opt-out) · the tenant's
`email` toggle is on · `submission.contactId` is set (the crm sink ran first).
It then writes through the ONE consent service: latest-wins full-replace with
the preserve-prior-analytics discipline (the AUDIT-5 gotcha), umbrella
`marketing: true` + `marketing.email: true`, `legalBasis: 'consent'`,
`source: 'form-optin:<formId>'`, subject = the contactId (the email
preference-center keying). Returns no marker.

**D3 — sink ordering is registration order** (documented on the seam):
`runSubmissionSinks` iterates the registry in registration order and applies
markers in-loop, so a later sink sees an earlier sink's `contactId`.
`BACKEND_FEATURES` registers crm before email; the email sink additionally
fail-softs when `contactId` is absent (CRM off ⇒ no subject ⇒ skip — a grant
needs an identity).

**D4 — submit-guard seam** (forms-owned, closes ADR 0017 alt-4).
`registerSubmitGuard({ id, check(form, values, meta) })` runs in the public
submit AFTER the honeypot, BEFORE validation; any `deny` short-circuits with
the honeypot's bot posture (silent 200, no row — never an oracle for spam
tooling). No default guards ship; a CAPTCHA/turnstile provider is a follow-on
registrant, not a seam change.

## Alternatives

A subscriber-list store (rejected — email audiences already resolve live from
CRM; a list would be a parallel store); opt-in inferred from any email field
(rejected — consent must be explicit); guards after validation (rejected —
spend nothing on bots); a 4xx deny (rejected — oracle).

## Open questions

- [ ] Double opt-in (confirmation email before the grant) — needs ADR 0019's
      send path; recorded follow-on.
- [ ] Guard telemetry (denied counts on the submissions inbox) — follow-on.

## Implementation record

| Piece | Evidence |
|---|---|
| D1 | `formsService` `emailOptInField` sanitize + `FormsPage` checkbox-field select (email-gated) + i18n ×4 |
| D2/D3 | `email/formsConsentSink.ts` registered in `email/feature.ts`; ordering note on `submissionSinks.ts`; tests `forms-email-consent-sink.test.ts` |
| D4 | `forms/submitGuards.ts` + routes wiring; tests in the same file |
