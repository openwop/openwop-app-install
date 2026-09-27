# ADR 0306 — App-Builder GitHub Publish (governed vendor write)

Status: implemented (2026-07-07) — core in PR #1460 (governed adapterOnly provider + create-only pushes). The recorded follow-ons (OAuth PKCE, run-node publish) were later delivered as part of ADR 0393's two-way GitHub sync + MCP lane (PR #1968).

> **Cross-ref 2026-07-17:** **ADR 0393** extends this seam with TWO-WAY sync on a
> bound branch (`githubSync.ts` — one atomic Git-Data-API marker commit, inbound
> HMAC webhook → governed CAS apply). This ADR's create-only publish, its
> `github-publish` `adapterOnly` governance, and its injection-skip pins are
> unchanged; both lanes share the exported `gh()` broker.

## Context

ADR 0173 shipped code export as a ZIP download and explicitly deferred
`DeploymentService`/GitHub-push. ADR 0190:95 separately recorded GitHub-authenticated
writes as a deliberate non-ship ("deferred until an MCP-reach connection binding has
a chain precedent"). ADR 0305 Phase G closes both — **this ADR supersedes the
ADR 0190:95 gate** for the narrow, host-pinned publish below.

The security posture follows the ADR 0292 finding verbatim: a governance-gated
vendor WRITE is bypassable through the generic `core.openwop.http.fetch` node unless
the provider is marked **`adapterOnly`** (`matchAllowedProvider` skips such
manifests, so `ctx.http.safeFetch` can never carry the token).

## Decision

1. **Provider**: a built-in `github` connection manifest — `bearer` (fine-grained
   PAT, `manual` auth flow), write scope `repo.push`, `apiHosts: ['api.github.com']`
   (host-pinned egress), **`adapterOnly: true`**, `consumerNodes: []`. A test pins
   the injection-skip. *OAuth (PKCE) is a recorded follow-on* — an OAuth app needs
   operator client-id provisioning; a PAT is day-1-honest (the work-twin
   day-1-honesty precedent).
2. **Publish path**: a feature route `POST …/canvases/:canvasId/publish` gated by a
   NEW toggle **`code-publish`** (OFF, tenant, Canvases) + `workspace:write`. The
   service reuses the ONE export-security step (`generateScrubbed` — the same
   scrub + caps as the ZIP path, extracted so they cannot diverge), then via
   **`brokeredFetch`** (token never leaves `api.github.com`, never reaches the
   client, never logged): resolve the login (`GET /user`), create the repo
   (`POST /user/repos`; an already-existing repo is REUSED and flagged
   `repo: 'reused'` in the result — loud, never silent), then create-only
   per-file `PUT /repos/{owner}/{repo}/contents/{path}` (base64). An existing
   path (422) becomes a per-file warning — **no silent overwrite** in v1.
   Publish is capped at **200 files** (GitHub secondary-rate-limit headroom;
   generators emit ~5–25).
3. **Governance distinction (explicit)**: this route-side publish carries NO
   ADR 0028 run-governance approval interrupt — the acting human triggers it
   directly with `workspace:write` plus a consented write-scope connection, like
   every other feature route that calls a provider. ADR 0028 governs
   *run/node-initiated* vendor writes — which remain impossible here by
   construction (`adapterOnly` + zero consumer nodes). A future run-initiated
   publish node would need the destination-sync-style approval-gated adapter.
4. **No connection → 424** (`failed_dependency`) with an actionable
   connect-GitHub-first message. Provider errors surface status + message,
   never the token.
5. **FE**: a Publish control in the editor header (visible only when
   `code-publish` resolves on), a small modal (repo name `^[A-Za-z0-9._-]{1,100}$`,
   private checkbox, framework target), success toast with the repo URL.

## Alternatives considered

- **OAuth PKCE app** — deferred (operator provisioning burden; PAT is honest now).
- **Git Data API single-commit push** — deferred; the Contents API is simpler and
  sufficient at ≤200 files; revisit if publish grows.
- **Run-node publish (workflow-initiated)** — deliberately NOT shipped; would
  require the ADR 0028 approval-gated adapter pattern (bigquery-write precedent).

## Phase → commit

| Piece | Status |
|---|---|
| Provider manifest + injection-skip pin · publishService + route + toggle · FE modal · tests | PR #1460 |
| OAuth PKCE flow · run-node publish via approval-gated adapter | delivered via ADR 0393 (PR #1968) |
