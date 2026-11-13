# ADR 1107 — Adopter shell seams: the shell's organization, an adopter home, adopter wording, app-scoped tokens

Status: Accepted (2026-11-12). The user accepted the recommended answer to all
four open questions (recorded at the end). Nothing is built yet.

Requested in openwop/openwop-app#5788 (casavoga-0e, from CasaVoga's audit of the
signed-in app as a white-label adopter; its local version is CasaVoga ADR
CV-0187). It is the companion to #5786, whose menu and core decisions are ADR
1106. It is a separate ADR because it changes different code (the org
selection, the home route and dashboard, i18n loading, CSS tokens). The two
share only the ADR 1031 adopter seam. Host-internal and presentation-only: no
wire change, no RFC, and no authorization change.

#5788 §4's one upstream bug (Needs-you showing workflow ids) shipped in #5791.

## Context

An adopter's own pages (`src/adopter/features/*`, ADR 1031) run inside the stock
shell. Four things they need from it are missing:

1. **No shell organization.** `ui/useOrgSelection.ts` is the ONE org selector
   (18 features, rendered by `ui/OrgSelectionState.tsx`), but its choice is
   per-page `useState` that defaults to the first org. Every page asks again, so
   CasaVoga draws three pickers in three page headers. The sidebar's
   `WorkspaceSwitcher` is a different thing: it picks the workspace (the tenant,
   ADR 0015), not an organization inside it.
2. **No adopter home.** After sign-in a person lands on the stock dashboard. An
   adopter can ADD tiles (`FrontendFeature.dashboardTiles`, ADR 1031 D5), but
   not change which stock tiles are on by default (`defaultLayoutFrom` reads
   each tile's `defaultEnabled`/`defaultOrder`), and not change the landing
   route.
3. **No adopter wording for stock pages.** An adopter's i18n catalogs live in
   their own namespaces. `i18n/resources.ts` throws if one shadows an existing
   namespace, so an adopter can rename a menu entry (ADR 1106 D2) but not the
   page under it.
4. **Shared tokens move the public site.** The type and radius tokens serve both
   the app and the `.fp-*` public site. CasaVoga scoped its values with
   `:root:has(.app-shell)`. Six values had no token at all:
   - the page-title face and weight;
   - the label face and case;
   - the chip radius;
   - the focus ring;
   - the control height;
   - the in-app footer text, which today reuses the site's `footerText`.

## Decision

### D1 — The shell holds the selected organization

`useOrgSelection` keeps its contract and states, and gains one source of truth
for the choice: a shell-level `OrgSelectionProvider` mounted in the app shell.

- **Read:** a page's `initialOrgId` defaults to the shell's selection, and the
  hook still checks that the org is in the caller's list. An unknown or stale id
  falls back to the first org, as today.
- **Write:** choosing an org on any page sets the shell's selection.
- **Persistence:** per workspace, per person, in the browser only (`localStorage`
  keyed `${tenantId}:${userId}`). It is a convenience, never an authority:
  every read still goes through each route's own org check.
- **The seam:** `useShellOrg()` returns `{ orgId, setOrgId }` for adopter pages.
  A page may still render the shared picker. Q1 decides whether the shell shows
  one control of its own.

This is presentation and convenience only. It does not change which orgs a
person can read, so it is not an authorization change.

### D2 — An adopter home: same address, the adopter's element

> **AMENDED 2026-11-11, before decision (#5793 part 3).** The first draft let an
> adopter move the landing route. CasaVoga built a home locally and found the
> address is known in three places: `/` redirects to `/dashboard`
> (`RootRedirect`), the sidebar logo links to `/dashboard`, and the pinned menu
> entry is declared by the dashboard feature. Keeping the address and swapping
> only the element left all three, and their tests, alone. That is the smaller
> seam, so it replaces the path option.

A new adopter seam file, `frontend/react/src/adopter/home.ts`, exporting
`ADOPTER_HOME` with two optional fields:
- **`element`:** a lazy component rendered at `/dashboard` in place of
  `DashboardPage`. The route, its tier, `RootRedirect`, the logo link and the
  pinned entry are unchanged. The adopter's home may still embed the stock
  dashboard or its tiles.
- **`tiles`:** when there is no `element`, per stock tile id
  `{ enabled?, order?, size? }` over `defaultLayoutFrom`. A person's saved
  layout still wins. An unknown tile id fails the build, because tile ids are
  persisted layout keys (ADR 1031).

Absent file means today's behaviour, byte for byte.

### D3 — Adopter wording for the shell's own namespaces

A new adopter seam file, `frontend/react/src/adopter/i18n/overrides/<locale>.ts`,
exporting `{ [namespace]: { [key]: string } }`. It is merged over the stock
catalogs after they load, by i18next `addResourceBundle(…, deep, overwrite)`.
Three rules keep it honest:
- **The key must exist upstream.** An override of a missing key fails the build,
  so a renamed upstream key cannot silently leave adopter text dead.
- **Placeholders must match.** The override's `{{param}}` set must equal the
  stock string's, or the build fails.
- **Scope:** it covers every namespace except the two that carry security or
  legal copy, `auth` and `consent`, which an adopter could otherwise rewrite
  into a false claim (Q2). Error messages are out of its reach anyway: the
  server localizes them (ADR 0143).

The duplicate-namespace guard stays: an adopter still cannot replace a whole
namespace, only named keys in it.

### D4 — App-scoped tokens, and the six missing ones

**Scoping.** The app gets aliases `--app-<token>` that fall back to the shared
token (for example `--app-text-body: var(--text-body)`). The app's rules read
the alias. A brand can then set `--app-*` to restyle the app without moving the
`.fp-*` site, or set the shared token to move both. `:root:has(.app-shell)`
scoping stops being necessary.

**New tokens,** each defaulting to today's computed value, so the stock build
does not change:

| Token | Today |
|---|---|
| `--page-title-font`, `--page-title-weight` | `.page-header__title` uses `var(--sans)` at `--weight-marquee` |
| `--label-font`, `--label-case` | field labels, group names and select values: mono, uppercase |
| `--chip-radius` | pills by rule |
| `--focus-ring-color`, `--focus-ring-width`, `--focus-ring-offset` | set per component |
| `--control-height` | 32–36px; follows `--hit-target` after this |

**App footer.** The brand config gains `appFooterText`, which may be empty, and
`--app-footer-font` and `--app-footer-case`. The site's `footerText` stays the
public site's.

**Status chips.** `StatusBadge` (a filled block) and `.chip` (an outlined pill)
are two status primitives. DESIGN.md picks one for status (Q3), and the other
becomes a migration with a ratchet.

The sidebar foot overlapping the last entries at a larger type scale is checked
in a browser in the D4 PR. It is not guessed from CSS.

## Alternatives

- **Org in the URL** (`?org=` on every page) instead of shell state. Rejected as
  the default: it changes every org-scoped route's URL and breaks saved links.
  Pages that already take an org in their path keep doing so and seed the shell.
- **Let an adopter replace whole namespaces.** Rejected: one missed key falls
  back to the raw key on screen, and upstream keys keep changing.
- **Adopter CSS overrides by selector** (what CasaVoga does now). Rejected:
  selector overrides break silently when markup changes. Tokens are the
  contract.

## Phases

| Phase | What | Tests / witnesses |
|---|---|---|
| P0 | This ADR, Proposed | — |
| P1 | D4 tokens: app aliases, the six new tokens, `appFooterText` | `check-css-tokens` resolves every new token. A computed-style test shows the stock values unchanged. A brand fixture sets `--app-text-body` and the `.fp-*` site's computed size stays the same. DESIGN.md updated |
| P2 | D1 shell org | Hook test: a choice on page A is page B's initial; a stale stored id falls back to the first org; a failed org read keeps the `orgsFailed` state (`OrgSelectionState` order). Route test: a stored id for an org the person cannot read changes nothing server-side |
| P3 | D2 adopter home | A fixture `element` renders at `/dashboard`, and `/`, the logo and the pinned entry still reach it. An unknown tile id fails the build. A saved personal layout beats `tiles`. An absent file reproduces today's dashboard (`defaultLayoutFrom` parity) |
| P4 | D3 wording overrides | Build fixture: a missing key fails, mismatched placeholders fail, and an `auth` override fails. A real override shows in the page. 4-locale parity unchanged |
| P5 | CasaVoga swaps its three header pickers, its `:root:has(.app-shell)` rules and its class overrides for the seams | CasaVoga's own tests; then it drops CV-0187's local version |

## Open questions (the user's decisions)

1. **Shell org control:** a picker in the shell header for every org-scoped page,
   or only the shared state, with pages keeping their own picker?
2. **Wording scope:** exclude `auth` and `consent` from adopter overrides, or
   allow everything?
3. **One status primitive:** filled `StatusBadge` or outlined `.chip`?
4. **Home:** an adopter element at `/dashboard`, keeping the address (recommended,
   from #5793 part 3), or a separate landing path?

## Decisions (2026-11-12)

The user accepted the recommended answer to each question:

1. **Shell org control:** shared state only. Pages keep the shared picker; the
   shell adds no header control (the sidebar's workspace switcher already sits
   there, and a second switcher would blur workspace and organization). A header
   control can be added later without breaking anything.
2. **Wording scope:** `auth` and `consent` are excluded from adopter overrides.
3. **One status primitive:** `.chip` (in 256 production `.tsx` files against 36
   for `StatusBadge`; DESIGN.md §7). `StatusBadge` migrates to it under a
   no-growth ratchet.
4. **Home:** an adopter element at `/dashboard`, keeping the address (D2 as
   amended).
