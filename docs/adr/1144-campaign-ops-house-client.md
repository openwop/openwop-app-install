# ADR 1144 — Campaign ops: a house client for the firm's own business

Status: Accepted (2026-11-16; the user's go to write and build, CC-OPS-2). Implementation: #6066 (all phases).

Amends ADR 0921 D1 (agency client accounts) and ADR 0926 (operator onboarding). Host extension only.

## Context

Campaign Studio acceptance (ledger row CC-OPS-2) found that a firm can't register its own business as a
client, and the copy addresses an "agency admin" the solo founder doesn't have.

- `createClient` refuses the root org (`features/campaign-ops/clientService.ts:55-57`, 400 `root_org_not_client`).
- **Without an `orgId` the service already creates a new sub-org owned by the creator**
  (`clientService.ts:58-61`), but `ClientRegistrationDialog.tsx:26-42` only offers "Choose an existing
  organization". When there is none, it sends the user to Access ("Create a client organization in
  Access first, then return here").
- `isAgencyAdmin` already treats the owner of a personal workspace as an agency admin
  (`features/campaign-ops/routes.ts:59-68`). The model fits a one-person firm; the onboarding doesn't.
- The empty state says clients "appear here once an **agency admin** adds them", next to an Add button
  the admin can see. `registrationDenied` says "workspace administrator", so the same role has two names.

**The root refusal is load-bearing and stays.** ADR 0921 makes `orgId` the only isolation key. If the
root were a client:
- every tenant-wide row would read as "in the house client" (G5);
- client and workspace connections would become indistinguishable (G4);
- every root member's tenant-wide role would apply to the house client, because in a shared workspace
  tenant-wide authority is the root membership (ADR 0815 D1b), which reopens G2;
- ADR 1132's client run stamp could no longer tell house work from tenant-wide work.

## Decision

### D1 — The house client is a real sub-org, created in one step

The empty client list offers agency admins two actions:
- primary, **"Set up your own business"**;
- secondary, **"Add a client"**.

"Set up your own business" creates a non-root org named after the workspace. It uses the existing
`createClient` path with no `orgId`, and stores `house: true` on the `ClientAccount` for display. The
house client sorts first in the switcher with a muted "Your business" chip.

**One house client per workspace**, enforced by a create-if-absent claim on a
`campaign-ops:house::<tenantId>` pointer. Two parallel first clicks converge on one org.

### D2 — Optional brand-kit copy, never a shared fallback

After creation, the dialog offers **"Use your workspace brand kit for it"**: a one-time copy of the root
org's brand record to the house org, through the brand feature's own write path. Connections are not
copied or shared. They are pinned per org, as ADR 0921 D4 requires, and the house client connects its
own.

### D3 — Inline client creation in the registration dialog

`ClientRegistrationDialog` gets two modes:
- **New client:** name only, using `createClient` without an `orgId`.
- **Existing organization:** today's chooser.

There's no detour through Access. This follows the DESIGN.md `CreateDialog` canon.

### D4 — Role-aware copy, one role noun

- Admin, empty: "No clients yet. Add a client, or set up your own business to run campaigns for yourself."
- Non-admin, empty: "No clients yet. Clients you can work for appear here once a workspace admin adds them."
- "Workspace admin" everywhere, replacing "agency admin" in `noClientsBody` and `teamReadOnly`, in all four locales.
- `root_org_not_client` reads: "Your workspace can't be a client itself. Set up your own business as a client instead." It also offers the action.

### Correction note for ADR 0921 D1

ADR 0921 D1 gains an inline correction pointing here. The root stays non-client, for the reasons
above, so a later reader doesn't "fix" the guard. The house client is a flagged sub-org.

## Alternatives weighed

- **Allow root as a client:** reopens G1, G2 and G4 for the house client, and every store would need an `orgId === tenantId` special case. Rejected.
- **A house flag that maps to the root:** the same aliasing, hidden behind a flag. Rejected.
- **Copy-only fix:** necessary but not enough, because a solo firm still has to invent a client for itself. Folded into D3/D4.

## RFC verdict

Host extension, no RFC. Campaign ops advertises nothing on the wire.

## Phases

| Phase | Scope |
|---|---|
| P1 | `house` flag + one-per-workspace claim + "set up your own business" route/service path; route tests incl. personal-workspace owner and concurrency |
| P2 | Dialog modes + empty-state actions + brand-kit copy offer; copy ×4 locales (passes the campaign-ops copy denylist) |
| P3 | ADR 0921 D1 correction note; component tests |

## Open questions

1. Should the house client inherit the workspace's display name live (renames follow), or only at creation? This ADR proposes creation only.

## Implementation record

| Phase | Where |
|---|---|
| All phases | #6066: code, tests, red witness and `ci:quick` evidence in the PR body |
