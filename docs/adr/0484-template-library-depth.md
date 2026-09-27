# ADR 0484 — Template library depth: gap-category chain packs (T8)

Status: Accepted — implemented (this PR)
Date: 2026-07-24
Relates: ADR 0163 (workflow-chain packs), ADR 0190 (the pack tiers), RFC 0013
(the chain format), the 2026-07-24 re-assessment (whitespace item 6: T8 was
B− — "the mechanism is done; the LIBRARY is the gap" — n8n ships ~10.9k
templates).

## Decision

Close T8 with QUALITY, not a count race. Eight new galleries in categories
the library had ZERO templates for, all built on the **portable node
palette** every existing passing pack draws from — no invented typeIds (a
typo'd typeId ships a silently degraded template, ADR 0163 R6):

- **customer-onboarding** (3) — welcome email, kickoff checklist, 30-day
  health check
- **feedback-triage** (2) — classify→route→task, weekly theme digest
- **incident-postmortem** (2) — blameless draft, action items→tasks
- **seo-content-ops** (2) — research-grounded brief, draft→publish gate
- **meeting-ops** (2) — agenda from goal, notes→owned actions
- **release-comms** (2) — release notes from changelog, internal announce
- **sales-outreach** (2) — researched first-touch, quiet-thread nudge
- **weekly-digest** (2) — topic watch, team status roll-up

17 chains, taking the vendored library 147→164 chains / 46→54 packs.

Every chain honors the standing contracts, TEST-PINNED
(`workflow-chain-gap-packs.test.ts`, the support/starters suite's shape):
each loads, references only shipped typeIds, expands to a frozen validated
`WorkflowDefinition`, and every external-send sink (`email-send`,
`slack-message`) sits behind a human `core.chat.approvalGate` with the
`side-effectful` capability — draft-only (`core.email.draft`) and in-app
(`notification-push`) sinks are exempt (the it-support precedent). Research
chains ground on live `core.web.search` with a "don't fabricate a source"
system prompt (the LLM-exchange grounding doctrine). All tenant values are
run parameters frozen into `config` (RFC 0013 Path A — replay-deterministic).

## What this is NOT

Not a count race to n8n's ~10.9k — these are 17 genuinely-runnable,
human-gated, grounded templates in real gaps, not thin variations. Publishing
the packs to packs.openwop.dev (the signed-registry lane) is the recorded
follow-on (in-repo example packs are unsigned by convention; signing is at
publish).

## Implementation record

This PR: 8 pack manifests + the portability/gating/expansion test (76 cases)
+ FEATURES.md + the assessment T8 row.
