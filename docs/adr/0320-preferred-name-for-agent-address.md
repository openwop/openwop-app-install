# ADR 0320 — Preferred name: how agents address the user

Status: implemented

## Context

Agents address the human by their identity `displayName` verbatim. The chat
scaffolds (`host/agentPromptScaffold.ts` and `host/chatContext.ts`) both emit
`You are talking to a human user named ${name}. Address them as ${name}.` — so a
user whose `displayName` is "David Tufts" is greeted "David Tufts" on every turn,
including in live voice ("Loud and clear, David Tufts!"). There was **no** setting
to make agents use a first name / preferred name; the only lever was editing the
identity `displayName`, which changes the name everywhere (directory, mentions,
audit) — not what the user wants.

## Decision

Add a self-service **preferred name** the user controls, separate from identity:

1. **Storage** — a `preferredName?: string` field on the descriptive `Profile`
   (`features/profiles`), NOT on the identity `User`. It is a preference about how
   to be *addressed*, confers no authority, and never mutates the identity record —
   consistent with the ADR 0005 descriptive-only boundary. Self-editable through the
   existing `PATCH /profiles/me` → `updateOwnProfile` path (bounded + secret-scrubbed
   like the other free-text fields).

2. **Address-name resolution** — a new `resolveCallerAddressName(tenantId, userId)`
   in `chatContext.ts` returns `profile.preferredName` when set, else `null`. Both
   scaffolds now take an optional `addressName` and compute the address as
   `addressName ?? firstNameOf(displayName)` — so the **default changes to the first
   name** even with no preferred name set, while the `named …` reference keeps the
   full `displayName`. `firstNameOf` (exported from `agentPromptScaffold.ts`) is the
   first whitespace token, falling back to the whole name for single-token names.

   Result: `You are talking to a human user named David Tufts. Address them as David.`
   — and "Ada Lovelace" who sets preferred name "Ada L." gets "Address them as Ada L."

3. **UI** — a "Preferred name" input on the profile page (`ProfilePage.tsx`), under
   the display-name field, with the hint "What agents should call you. Defaults to
   your first name." Localized ×4 (en/es/fr/pt-BR).

This flows through **both** the typed chat turn and the realtime-voice mint, because
both compose through `composeChatContext` (ADR 0199) — one seam, one behavior.

## Alternatives considered

- **Change identity `displayName` to a first name** — rejected: it is identity data
  used across the directory, mentions, and audit; a display preference must not
  overwrite it.
- **A global "first name only" default with no field** — rejected: some users want
  full or custom forms; the field is cheap and the first-name default already covers
  the common case with no configuration.
- **Store on `User` (identity)** — rejected: `User` has no self-service edit surface
  and identity is the wrong owner for an address preference (ADR 0005 boundary).

## Scope / non-goals

- No wire change: `preferredName` is a host-extension profile field and the address
  name only shapes prompt text. No RFC needed.
- Per-agent overrides (an agent that must use a formal name) are out of scope; the
  persona prompt can already instruct a specific style if needed.

## Implementation

| Area | Change |
|---|---|
| Model | `Profile.preferredName?` + `ProfilePatch.preferredName` (`profilesService.ts`) |
| Route | `PATCH /profiles/me` accepts `preferredName` (`profiles/routes.ts`) |
| Resolve | `resolveCallerAddressName` + `firstNameOf`; both scaffolds take `addressName` and default to the first name (`chatContext.ts`, `agentPromptScaffold.ts`) |
| UI | Preferred-name input on `ProfilePage.tsx`; `profilesClient` types; i18n ×4 |

Address name = `preferredName` ?? first token of `displayName`; the full name is
still used for the "named …" reference so the model knows the whole name.
