# ADR 1139 — App Builder QA: a computer-use session on the workspace's own share link

Status: Accepted (2026-11-16, user decision on [ADR 1136](1136-browser-executors-for-computer-use.md)
open question 3). Narrows [ADR 0894](0894-computer-use-session-authority.md) D5 by one named
exception. Not implemented. It ships with ADR 1136 P3 or later, when a person can watch and stop
the browser.

Host extension only. The exception lives in `features/computer-use` and reads
`features/sharing`. Nothing reaches `/.well-known/openwop` and no RFC is needed.

## Context

A founder builds an app in App Builder and wants the agent to click through it and report what
breaks. ADR 0894 D5 refuses the app's own origin (`publicBaseUrl()`) in `allowedOrigins`. The rule is
right: on the host's origin the browser can reach the person's signed-in session, every admin
screen, and the routes that change the app the agent runs inside.

Read from `origin/main` on 2026-11-16, the collision is narrower than ADR 1136 assumed:

- **"Publish" is a GitHub export** (`app-builder/publishService.ts`). A deployed copy lives on its own
  origin, such as a Pages or Vercel domain, and 0894 already allows that. No exception is needed.
- **The public share link is the one case on the host's origin.** `/shared/:token` renders the app in
  the bare `PublicShell` (`App.tsx`), reading `GET /host/openwop-app/shared/:token`. The link is an
  `app_builder_canvas` `ShareLink` (`sharing/sharingService.ts`), so it is tenant-bound, revocable,
  can expire, and can carry a view cap.

## Decision

### D1 — One exception: this workspace's live App Builder share link, by path

A session may start on `${publicBaseUrl()}/shared/<token>` when all of these hold at start:

- `resolveActiveResource(token, 'app_builder_canvas')` resolves (live, not revoked, not expired);
- the link's `tenantId` and `orgId` are the session's;
- the opener may read that canvas (the share's own `entitlement(…, 'read')`);
- the link has no `maxViews`. A QA run must not spend a customer's view cap. A capped link is refused
  `qa_link_capped`, and the person mints an uncapped QA link instead.

The allowance is the **path prefix** `/shared/<token>` on the host's origin, plus the share
document's own reads (`/host/openwop-app/shared/<token>` and its `/card` and `/frame-view`). The host
origin stays in the D5 refusal for everything else. The predicate takes origin plus path, not origin
alone.

### D2 — The executor runs that session with no host session

The browser profile for a QA session is fresh and cookieless for the host's origin. Lane A uses a
throwaway profile, never the person's per-workspace profile. Lane B starts a new context. So a
navigation that slips the path check still reaches nothing a signed-out visitor could not. Each
executor enforces this itself, as it enforces private and loopback refusals itself (ADR 1136 P2).

### D3 — Off the path fails closed

Every reported URL and every navigation runs the same check (0894 D5 already runs it on each
provider-reported URL). A host-origin URL outside the prefix fails the session closed, the same way
an off-allowlist origin does. In lane B the network-layer allowlist (ADR 1136 D6) blocks host-origin
requests outside the prefix too.

### D4 — Tiers are unchanged

QA is not a lighter tier. An observe or interact step needs no approval, a commit-tier step still
does, and credentials are still refused. A shared app's actions run against the redacted share
projection and its mocks (ADR 0345), so they write nothing durable, but the classifier does not
assume that.

### D5 — The view counts honestly

A QA session's views are real views and are counted as such. The share's frame-view analytics record
them like any visitor's. The session's trajectory names the link label so the founder can tell
their own QA run apart.

## Alternatives weighed

- **Allow the whole host origin for a workspace's own sessions.** That reopens what 0894 D5 closed:
  admin screens, the person's session, and self-modification.
- **Serve shares from a separate origin (`share.<host>`).** It would remove the need for the
  exception, and it is the better long-term shape. But it is a hosting, cookie, CSP and deep-link
  migration across every share type. If it ever lands, this ADR is superseded by a plain allowlist
  entry.
- **QA only against a GitHub-published deploy.** It already works, but it makes a founder publish
  and deploy before the agent can look, which is the opposite of a quick check.

## Implementation plan

| Phase | Scope | Tests and witnesses |
|---|---|---|
| P1 | `qaShareAllowance(tenantId, orgId, startUrl, opener)` in `features/computer-use`; `parseAllowedOrigins` and `originAllowed` take origin plus path; session start accepts the share URL; `qa_link_capped`; a typed refusal for every failed condition | a live own-workspace link starts; another workspace's link, a revoked, an expired, a capped and a non-App Builder link each refuse with no existence leak; `/dashboard` on the host origin still refuses at start and mid-session; sabotage: drop the path check and the mid-session leg reds |
| P2 | Executor cookieless profile for QA sessions (lane A companion and desktop, lane B context) | a host cookie set in the person's profile is absent in the QA context; a navigation to `/` from the share reads signed-out |
| P3 | App Builder "Test with the agent" entry that mints an uncapped QA link and opens the chat scoped to the QA agent (ADR 0073 embed, no second chat) | the entry is absent with `computer-use` off; 4-locale i18n parity; `npm run build` |

## Open questions

- [ ] Should a QA link be a distinct `label`, such as "QA (agent)", so the founder's share list shows
  it apart? Recommended: yes, minted by P3.
- [ ] The `share.<host>` origin split. It is out of scope here; record it if share hosting is ever
  revisited.
