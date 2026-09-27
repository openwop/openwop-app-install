# OPENWOP-SYNC — App-Builder two-way GitHub sync + MCP control (operator guide)

ADR 0393. Two lanes: **files move over git; agents ride MCP.** There is no IDE
extension and none is planned — a spec-compliant MCP server reaches VS Code and
every other MCP-capable editor with zero extension code, and the git lane gives
any editor `git clone`.

## What round-trips (and what does not)

A synced repo has two disjoint regions:

| Region | Direction | Truth |
|---|---|---|
| `app.model.json` | **two-way** | The canonical serialization of the application MODEL (the ADR 0343 document — screens, component tree, data models, operations). **The ONLY file inbound sync imports.** Edit this (or use the builder/MCP tools) to change the app. |
| Generated framework source (`src/…`, `index.html`, …) + `.openwop/generated.json` | **outbound only** | Build output, like a checked-in `dist/` — regenerated on every sync, **ignored on inbound**. Hand-edits to generated files carry no round-trip meaning (the generators are a one-way lossy projection). `.openwop/generated.json` manifests exactly which paths the sync owns, so a later sync deletes only its own stale output — never files you added. |

## Setting up sync (admin)

1. Turn ON the `code-sync` feature toggle (OFF by default — the inbound webhook
   mutates tenant state, so it is an explicit opt-in).
2. Connect the `github-publish` connection (fine-grained PAT, contents:write on
   the target repo) under Connections — the token stays host-side, always.
3. In the App Builder editor, open **Sync** and bind the canvas to
   `owner/repo` + ONE active branch (org admin/owner only — the binding wires a
   durable external write channel). The bind response shows the **webhook
   secret exactly once** — store it.
4. On the GitHub repo, add a **push** webhook pointing at
   `https://<host>/v1/host/openwop-app/app-builder-sync/webhook/<webhookId>`
   (the URL is shown in the Sync dialog) with content type `application/json`
   and that secret.

## Outbound (builder → GitHub)

**Sync now** pushes ONE atomic commit to the active branch:
`app.model.json` + the regenerated source + the manifest. The commit message
carries the `[openwop-sync] model-version=<n>` marker (loop prevention). An
unchanged model is an honest no-op ("Already in sync"). The push is
fast-forward-only: if external commits land mid-push it retries once, then
reports a conflict — it never force-pushes.

## Inbound (GitHub → builder)

A push to the active branch imports `app.model.json`:

- **Our own echo** (marker + matching version) is acked and dropped.
- **Redeliveries** (same delivery id) are no-ops.
- **Basis check (fail-closed):** the manifest's `modelVersion` must equal the
  live canvas version. If the canvas moved since the repo last synced (builder
  edits you haven't pulled), applying would clobber them — the push is NOT
  applied; the pushed commit is preserved on an **`openwop-sync-<timestamp>`
  fallback branch** instead. Sync outbound first, rebase your work on it, push
  again.
- **Validation:** the model must pass the closed-world app validator (and carry
  ≥1 screen with exactly one `isInitial`). Rejections also land on a fallback
  branch — never a partial or empty apply.
- A clean import applies through the same versioned CAS write the editor and
  agent tools use; the canvas version advances.

Every receipt emits a `host.app-builder.sync.*` host event (ADR 0208) you can
webhook or bind a workflow to.

## MCP control lane (agents)

With `OPENWOP_MCP_SERVER_ENABLED=true`, any MCP client (VS Code 1.102+, Cursor,
Claude Code/Desktop — e.g. via `npx mcp-remote <host>/v1/host/openwop-app/mcp`)
gets 7 tools, per-principal gated (authenticated + `app-builder` toggle on):

`app-builder-create-project` · `app-builder-open-project` (list/open) ·
`app-builder-get-design` · `app-builder-catalog` ·
`app-builder-render-design` (normalize → validate → versioned persist; typed
errors feed the client's repair loop) · `app-builder-get-preview-url` ·
`app-builder-resolve-paused-task` (this workspace's app-builder design-chain
interrupts ONLY).

**Deliberately absent:** `read-file` / `write-file` / `diff` / `merge` over
MCP. Write-back to files is git's job (the lane above) — the verified market
boundary (no shipped app-builder exposes builder file-writes over MCP).
