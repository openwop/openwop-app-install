# ADR 0261 — Shared people-picker: resolve users by name, never by raw id

**Status:** Accepted — implemented (2026-07-05)

## Context

Several surfaces across the app asked a human to **type or paste a user
identifier** (a subject / principal id) into a free-text box, rather than pick a
teammate by name:

- **Approval delegation** (`notifications/DelegationSection`) — "Delegate to
  (user id)", placeholder `e.g. usr-a1b2c3`.
- **Strategy / initiative owner** (`features/strategy/StrategyPage`, two fields)
  — "Owner (user id)".
- **CRM deal owner** (`features/crm/DealDetailPage`) — free-text "Assign an
  owner…".
- **CMS locale grants** (`features/cms/CmsLanguageSettings`) — already a member
  dropdown when the org's members loaded, but it **fell back to a raw-subject
  text input** when the list was empty.

Typing an opaque id is user-hostile (nobody memorises `usr-a1b2c3`), error-prone
(a typo silently assigns nobody), and inconsistent with the surfaces that already
do it right: `kanban/AssigneeControl` (a native `<select>` of workspace members)
and `chat/conversations/MemberPickers` (the searchable multi-select). Both resolve
**names** and were built on the same data source — the org's members
(`accessClient.listMembers`, `OrgMember { subject, displayName, email }`).

Two other id inputs were **deliberately left as raw-id fields** (they are
identity-by-design, not people-lookups):

- **Users admin** (`features/users/UsersPage`) "Principal id" — *provisions a new
  user record* keyed by an external identity; there is no existing user to look
  up.
- **Consent lookup** (`features/consent/ConsentPage`) "visitor cookie / user id"
  — consent subjects include **anonymous visitors** with no name or account.

## Decision

Add one shared, reusable **`orgs/UserPicker`** — a single-select control that
offers the org's members **by display name** and emits the member **`subject`**
(the principal the backend already stores). Wire it into the four people-lookup
surfaces above; leave the two identity-by-design inputs unchanged.

Rather than a fourth bespoke picker, `UserPicker` is built on the existing
seams so behaviour can't drift:

- **Data:** a small module-cached `orgs/orgMembers.loadOrgMembers(orgId?)` over
  `accessClient.listMembers` — the same source `AssigneeControl` uses, generalised
  from its active-workspace-only cache to an org-keyed one. When `orgId` is
  omitted it resolves the active workspace's root org (id ≡ tenant, ADR 0015),
  matching `AssigneeControl`. `listMembers` is core RBAC and is **always
  available** — unlike `features/users`'s `listUsers()`, which 404s when the
  `users` toggle is off, so a picker built on it would couple CRM/Strategy/etc. to
  that toggle. Members without a `subject` are filtered out (nothing to assign).
- **Presentation:** rendered via `ui/Field`'s `SelectField` when a `label` is
  supplied (Strategy, whose siblings are already `ui/Field`) and as a bare
  `<select aria-label>` for inline rows (CRM, CMS, matching their hand-rolled
  `u-label-sm` labels). No new CSS; no `jsx-a11y/label-has-associated-control`
  violation (the labeled path is `Field`; the inline path uses `aria-label`).
- **No lost data:** an existing `value` that resolves to no current member (a
  legacy free-text owner, or a member since removed) is preserved as its own
  option instead of snapping to empty on the next save; a members-load failure
  degrades to that preserved value rather than wiping the field.

Shared copy (`userPickerNone` = "Unassigned") lives in the `common` i18n
namespace across all four locales; each feature keeps its own field label (now
reworded to drop the "(user id)" suffix). A required picker (delegation) passes an
`emptyLabel` "choose a person…" prompt instead of "Unassigned".

### Why no RFC

Nothing here touches the OpenWOP wire. `listMembers` and the stored `subject` /
`ownerUserId` values are unchanged; this is a pure front-end presentation change
over existing host-extension routes. No capability, event, or endpoint contract is
added — so this is host work under an ADR, no RFC required.

## Consequences

- One name-resolving control replaces four raw-id inputs; new "assign a person"
  UI should reuse `UserPicker` (single-select) or `chat` `MemberPicker`
  (multi-select), never a fresh text box.
- The picker emits a `subject`, so CRM `deal.owner` and Strategy `ownerUserId`
  now store principals consistently (CRM's own test fixture already used
  `user:alice`); neither value is rendered raw in a list view, so no display
  regression.
- The two identity-by-design inputs (new-user principal id, consent visitor
  lookup) intentionally remain free-text — a name lookup is semantically wrong
  there.

## Implementation

| Piece | Location |
| --- | --- |
| Member loader (cached) | `frontend/react/src/orgs/orgMembers.ts` |
| Shared picker | `frontend/react/src/orgs/UserPicker.tsx` |
| Shared i18n (`userPickerNone`) | `frontend/react/src/i18n/locales/{en,es,fr,pt-BR}/common.ts` |
| Delegation wiring | `notifications/DelegationSection.tsx` + `notifications/i18n/*` |
| Strategy wiring (2 fields) | `features/strategy/StrategyPage.tsx` + `features/strategy/i18n/*` |
| CRM deal-owner wiring | `features/crm/DealDetailPage.tsx` |
| CMS grant wiring (drops raw fallback) | `features/cms/CmsLanguageSettings.tsx` + `features/cms/i18n/*` |
| Tests | `orgs/__tests__/UserPicker.test.tsx`, `features/crm/__tests__/DealDetailPage.test.tsx` |
