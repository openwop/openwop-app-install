# ADR 1158 — A request sent straight to the backend host carries the active workspace

Status: Accepted (2026-11-23). Implemented in the PR that carries this ADR.

Host-internal auth plumbing: a new request header and a field on the
`/host/openwop-app/me/workspaces` response. No OpenWOP wire change, so no RFC.

## Context

A white-label adopter's owner, with a shared workspace active, clicked Clear on
the Example data page. Every streamed Clear, Load and provision-demo was refused
409 `example_data_workspace_mismatch` by `requireExpectedSeedTenant`
(`routes/agentOps.ts`), three times in a row, with nothing changed.

The streamed seed writes go straight to the Cloud Run host (`config.sseBaseUrl`)
to dodge the CDN rewrite's 60 s cap (ADR 0292, ADR 0321). The active workspace
lives only on the `openwop.session` cookie: the bearer lane reads
`cookieSession.tenantId` and re-checks membership for a shared workspace on
every request (`middleware/auth.ts`). Cookies are per host. The workspace switch
went through `/api`, so it updated the app-origin cookie. The backend host has
its own host-only cookie, which still names the personal workspace, or none at
all when third-party cookies are blocked. So `tenantOf(req)` was the personal
tenant while the page asserted the shared one, and the guard refused every
write. No header carried the selection, and the run-event stream's token
(`runStreamToken`) binds to a run, not to a workspace.

## Decision

| # | Decision |
|---|---|
| D1 | **A workspace selection token.** `host/workspaceSelectionToken.ts`: an HMAC (session secret, `workspace-select:v1:` prefix) over the caller's personal tenant, the workspace and an expiry 10 minutes out. Stateless, verifiable on any instance. |
| D2 | **Minted where the cookie IS sent.** `GET /host/openwop-app/me/workspaces` returns `selectionToken` when a signed-in caller's active workspace is a shared one, which the auth middleware has just membership-checked for this request. None for the personal workspace or an anonymous caller. |
| D3 | **Accepted in place of the cookie's selection, and checked the same way.** On the bearer lane, the `x-openwop-workspace-selection` header, when its token is valid for this identity's personal tenant, is the `requested` workspace instead of `cookieSession.tenantId`. The SAME `isWorkspaceMember` check then decides, and a non-member falls back to the personal workspace exactly as with a stale cookie. A token minted for another identity, tampered with, or expired is ignored. The token grants nothing a member's own cookie would not. |
| D4 | **Per request.** The token never rewrites the cookie: the cookie re-mint keeps the cookie's own selection, so a later direct request without the token is in the workspace the cookie names, as before. |
| D5 | **The guard is unchanged.** `requireExpectedSeedTenant` still compares the page's assertion with the resolved tenant. The token only lets the resolved tenant be the workspace the person is actually in. |
| D6 | **The client.** `withExampleDataScope` already reads `/me/workspaces` before every write; it now passes the token as `scope.selectionHeaders`, which the direct writes (`streamSeed`, `seedExampleAgents`) send. The CORS allow-list admits the header (it is preflighted). |
| D7 | **The page says why.** The Example data page's error Notice now sits beside the action bar that caused it and is announced; above a 33-row list with focus left on the button, the refusal read as a dead button. |

## Alternatives weighed

- **A plain workspace header (`x-openwop-workspace: <id>`), membership-checked.**
  Rejected: it lets any bearer request name any workspace and turns the active
  workspace into per-request input everywhere. The token keeps the selection a
  same-origin decision, bound to one identity and short-lived.
- **Route the streamed writes through `/api`.** Not possible: the CDN rewrite
  cuts at 60 s and buffers, which is why the direct host exists (ADR 0292).
- **Relax the guard on the direct host.** Rejected: the guard is what stopped a
  write landing in the personal workspace while the person believed they were
  in a shared one.
- **Reuse `runStreamToken`.** Rejected: it authorizes one run's event stream,
  and a seed write has no run.

## Trade-offs

- The token is readable by the page's JavaScript, unlike the HttpOnly cookie.
  Exposure is bounded: it is useless without the same identity's bearer, the
  member check runs on each use, and it expires in 10 minutes.
- Other direct-host callers (kanban, notifications, channels, voice) do not send
  it yet. They are workspace-scoped too, so they likely have the same defect
  wherever a route depends on the active workspace. Out of scope here; each can
  adopt `selectionToken` the same way.

## Implementation record

| Phase | Commit | Tests |
|---|---|---|
| D1–D7 | (this PR) | `backend/typescript/test/example-data-workspace-scope.test.ts` (ADR 1158 block), `frontend/react/src/client/__tests__/exampleDataScope.test.ts` (ADR 1158 block) |
