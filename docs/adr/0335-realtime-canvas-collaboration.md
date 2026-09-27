# ADR 0335 — Real-time canvas collaboration (the Yjs program): shared CRDT co-editing across chat + all canvas types

**Status:** implemented (2026-07-12) — Phases 1–2 shipped here; **Phases 3–4 (all canvas types) + the derive/authority model shipped via ADR 0359** (chassis-core standardization, PRs #1741–#1763 incl. the two-client e2e enable-gate + the pg-budget reconciliation; Phase 5 chat presence remains the recorded non-goal). Toggle still OFF — enabling is a product decision. Original status line follows:
**(was)** implementing (2026-07-11) — **Phase 1 + Phase 2 COMPLETE (dormant, toggle OFF).** Phase 1: 1a auth boundary + 1b-i per-instance CRDT sync + persistence + 1b-ii cross-instance NOTIFY fan-out. Phase 2: 2a-i `useCollab` seam + 2a-ii-A y-prosemirror binding primitive + 2a-ii-B `DocumentEditorSurface` integration (loading gate, per-user undo, FE-save suppression) + 2b CAS seeder-election. **Before enabling in prod:** a browser/e2e pass (live two-client sync/cursors/undo) + the pg connection-budget reconciliation; optional 2c (backend host.canvas derive). Phases 3–5 (other canvas types + chat presence) reuse the transport. **Enable-gate:** do NOT enable `realtime-collab` in prod until 1b-ii ships (single-instance sync split-brains across the ≤5 Cloud Run instances) AND the pg connection budget is reconciled. Below: "the dormant auth boundary (Phase 1a) is shipped" (`host/collab/collabServer.ts` — the WebSocket `upgrade` handler with Origin/CSWSH + `verifySession` + `realtime-collab` toggle + `getCanvasForTenant` auth-on-connect + per-tenant cap; route-level WS test proves 101/401/403/404; NO Yjs sync yet). Next: the CRDT sync + `NOTIFY` fan-out + snapshot persistence, then the FE `useCollab` seam + `y-prosemirror` binding (Phase 2). A cross-cutting infrastructure **program**, not a single feature. This is ADR 0334 Phase 7, split out as its own ADR per that ADR's phasing (Phase 7 "own ADR, RFC-gated if cross-host").
**Date:** 2026-07-10
**Depends on / composes:** ADR 0310 (canvas chassis + `host.canvas` CAS), ADR 0334 (the `canvas.document` rich-text type — the forcing function; TipTap/ProseMirror chosen precisely to keep this seam open), ADR 0067 (the RFC 0005 conversation primitive — chat is the other consumer), ADR 0013 (Sharing — presence on shared views). **Research:** `docs/research/documents-best-in-class.md` §2 (the ProseMirror↔Yjs binding, awareness, relative-position anchors, snapshot persistence, per-user undo — the technical dossier this ADR decides on).
**Toggle:** `realtime-collab` (planned) · default **OFF** · `bucketUnit: tenant`
**Surface:** a NEW backend sync service (WebSocket) + host persistence of Yjs docs; the FE chassis gains a `useCollab` hook. **RFC-gated** (see §RFC verdict) — any cross-host presence/co-edit *advertisement* needs an `../openwop` RFC first; a host-internal collaboration transport does not.

---

## Context

Every best-in-class document (Google Docs) and design tool (Figma) is real-time-multiplayer, and it is the single largest "best-in-class" gap the `documents-best-in-class.md` research names (§1.5). But it is **net-new infrastructure with app-wide scope**: the same CRDT/presence stack wants to serve chat, `canvas.document`, slides, app-builder, drawings, cad, and campaign — not just documents. ADR 0334 deliberately shipped `canvas.document` **single-writer** on `host.canvas` (CAS + 409 + version history) and chose **TipTap/ProseMirror** so the Yjs binding (`y-prosemirror`, `Y.XmlFragment`) is a drop-in later — i.e. this program was designed-for, not designed-around. The ADR 0310 research doc (line 301) already flagged "the CAS+versions model is the foundation" for exactly this.

**Why a separate ADR (not ADR 0334 Phase 7 inline):** the blast radius is the whole app (a new stateful WebSocket service, a new persistence model that is NOT `host.canvas` CAS, an auth/tenant-isolation boundary on the socket, and a presence protocol), and it is genuinely multi-week. Folding it into the document ADR would understate the cross-cutting risk. The single-owner rule: this program owns the **collaboration transport + CRDT persistence**; each canvas type + chat remains the owner of its **document model** and simply binds to the shared transport.

## Decision (proposed)

Adopt **Yjs** as the app's one collaboration CRDT, bound per surface, behind a chassis `useCollab` seam, with a self-hosted sync service and snapshot-based persistence. Ship it **surface-by-surface** starting with `canvas.document` (the type that motivated it), each behind the `realtime-collab` toggle.

### The stack (research §2 — decided)
- **CRDT: Yjs** (not Automerge — 25× smaller bundle, faster, the deepest editor-binding ecosystem). `Y.XmlFragment` per rich-text/tree doc.
- **Editor binding: `y-prosemirror`** for `canvas.document` (and any future ProseMirror surface): `ySyncPlugin` (doc↔fragment), `yCursorPlugin` (remote carets as decorations), `yUndoPlugin`. Other surfaces bind their own model (slides/app-builder tree → `Y.Map`/`Y.Array`; chat → its message log).
- **Presence: the Yjs awareness protocol** — a SEPARATE, ephemeral, non-persisted channel (cursor, selection, user color/name); dropped after 30 s stale. Never conflated with the document CRDT (conflating bloats history + breaks version semantics).
- **Durable anchors: relative positions** (`Y.createRelativePositionFromTypeIndex`) for cursors AND comment/suggestion anchors — bind to an immutable item id, resolve to `null` when deleted. This is what lets ADR 0334 Phase 6b (inline comments) + track-changes survive concurrent edits; **retrofitting anchors is why the anchor model is decided now, before 6b.**
- **Per-user undo: `Y.UndoManager` + `trackedOrigins`** — disable `prosemirror-history`/the chassis history once collab is on (a global undo is a correctness bug in multiplayer). This SUPERSEDES the ADR 0334 undo-ownership rule when collab is active: the EditorSurface swaps its local history for the UndoManager.
- **Transport + server: self-hosted `Hocuspocus`** (MIT, WebSocket) — or `y-sweet`/PartyKit if we prefer managed. Auth + tenant isolation enforced ON CONNECT (see §Security). `y-indexeddb` for offline.
- **Persistence: snapshot + update-log with `doc.gc = false`** (snapshots reference item ids; GC would purge restorable history) + `permanentUserData` for author attribution. Compact with `Y.mergeUpdates`. This is a NEW store — **NOT** `host.canvas` whole-doc CAS (CAS is the single-writer fallback; the two coexist, the CRDT store is authoritative when collab is on).

### The seam
- **FE:** a chassis `useCollab({ canvasId, enabled })` hook alongside `useCanvasDoc`. When `enabled` (toggle on + surface opted in), it provisions the Yjs doc + provider + awareness and the EditorSurface binds via `y-prosemirror` instead of the CAS working copy; when off, the existing single-writer path is unchanged. One seam, every surface opts in incrementally.
- **BE:** the sync service authenticates the socket (session cookie → tenant/org), authorizes the canvas (tenant-scoped, the `getCanvasForTenant` check), and persists per-doc updates. `host.canvas` version snapshots are derived from CRDT snapshots so the existing History/Compare UI keeps working.

### Phasing (surface-by-surface, each toggle-gated)
1. **Infra**: the sync service + auth/tenant-isolation + persistence + the `useCollab` seam (no surface wired yet — advertise nothing).
2. **`canvas.document`**: bind via `y-prosemirror`; remote cursors; per-user undo; offline. The witness surface.
3. **Comments/track-changes over CRDT** (unblocks ADR 0334 Phase 6b's durable anchors).
4. **Other canvas types** (slides/app-builder tree, drawings/cad/campaign elements) bind their models.
5. **Chat** presence/co-editing (if desired) reuses the same transport.

### Phase 1 design — accepted 2026-07-11 (the mandated "before any code" security review)

`/architect` reviewed the Phase 1 design (infra + seam, dormant — toggle OFF, no
surface bound, advertises nothing). **Verdict: PROCEED with three required
security additions + an enable-gate.** Verified live infra: `sessionAffinity=true`,
`maxScale=5`, `minScale=1`, `concurrency=80`; Cloud SQL present; `document-collab`
path unclaimed; `verifySession()` yields `tenantId`.

- **Owner:** a **host module** `host/collab/` (cross-cutting boot infra that
  attaches to the http.Server), NOT a feature package. The `document-editor`
  feature stays the document-*model* owner; collab owns only the *transport*.
- **Integration point:** `createApp()` returns `Express` and `main()`'s
  `app.listen()` (index.ts:750) **discards the Server**. Do NOT change
  `createApp`'s signature (tests depend on `Express`); instead `main()` captures
  `const server = app.listen(…)` and calls `attachCollabWebSocket(server, deps)`;
  socket route-tests do the same on their own `app.listen(0)`.
- **Auth on connect (load-bearing):** on the `upgrade` for
  `/v1/host/openwop-app/document-collab/:canvasId` — **(1) Origin-check the
  upgrade against the allowed-origins allowlist (close 4403)** — CORS does NOT
  govern WebSockets, so this is the **CSWSH** (cross-site-WebSocket-hijacking)
  defense the raw upgrade would otherwise bypass; **(2)** replicate the ADR-0295
  custom-domain/host guard (raw upgrade bypasses `customDomainMiddleware`);
  **(3)** parse `__session` → `verifySession()` → tenant (close 4401 if
  absent/invalid); **(4)** `getCanvasForTenant(tenantId, canvasId)` → uniform
  close 4404 if not found for this tenant or `canvasTypeId !== 'canvas.document'`
  (room joinable only AFTER the tenant check → no cross-tenant join); **(5)**
  per-IP/tenant connection rate-limit; **(6)** refuse unless the `realtime-collab`
  toggle is enabled for the tenant.
- **Connection-budget enable-gate (CRITICAL):** `poolMax=10 × maxScale=5 = 50`
  already exceeds the db-f1-micro ≈22 guideline ([pg-connection-exhaustion]).
  Rules: `NOTIFY` rides the existing pool (transient); `LISTEN` uses **one
  dedicated connection per instance** (never per-room) → net +1/instance. Because
  Phase 1 is **dormant**, it adds **zero** load until a tenant enables collab +
  a client connects — so it is safe to BUILD now, but **reconciling the pg budget
  (lower `OPENWOP_PG_POOL_MAX`, cap `maxScale`, or a larger tier) is a
  precondition to ENABLING collab in prod**, not to landing the infra.
- **Data integrity:** dormant staging is the safe cut — no live Y.Doc exists
  until a surface opts in (Phase 2), so there is no second authority to diverge
  from `host.canvas` CAS; the CAS→CRDT one-way seed is Phase 2.
- **Wire:** host-internal transport under `/v1/host/openwop-app/*` — no OpenWOP
  wire, **no RFC**; advertises nothing cross-host; runs/`:fork` unaffected.
- **First increment (security-first) — SHIPPED (Phase 1a):** the **dormant auth
  boundary** — the `realtime-collab` toggle (OFF) + `host/collab/collabServer.ts`
  `attachCollabWebSocket(server)` (wired in `main()` post-`app.listen`) doing
  **auth-on-connect only**: Origin allowlist (reused `originPolicy()` from
  `cors.ts` — one origin policy, CSWSH defense) → `verifySession(__session)` →
  `realtime-collab` toggle (`resolveOne`) → `getCanvasForTenant` (tenant + type) →
  per-tenant connection cap; every failure **rejects the HTTP upgrade** (never
  completes the handshake for an unauthorized socket) and fails closed. **No Yjs
  sync yet.** Proven by `test/collab-authboundary.test.ts` (valid → 101 open; no
  cookie → 401; disallowed Origin → 403; cross-tenant/wrong-type canvas → 404;
  toggle OFF → 404).
- **Phase 1b-i — SHIPPED:** per-instance **Yjs CRDT sync + snapshot persistence**
  (`host/collab/collabRoom.ts`). The backend is **schema-agnostic** — it relays
  Yjs sync/update/awareness bytes between a room's sockets and persists the merged
  `Y.Doc` state (`gc:false`) as an opaque base64 snapshot in a `DurableCollection`
  (backend-agnostic; debounced 2 s save; restored into a fresh room on reopen).
  The FE seeds a room by syncing its loaded document on first bind (Phase 2), so
  the backend needs no ProseMirror schema. **Echo-prevention** via the Yjs
  transaction origin (a local `update` is broadcast only when its origin is a
  local socket, never the `REMOTE` sentinel). DoS guards: `maxPayload` (4 MB
  frame cap) + **idle-room eviction** (drop the `Y.Doc` after the last socket
  closes, post a final save). Proven by `test/collab-sync.test.ts` (two clients
  converge on an edit; the snapshot persists + restores into a fresh room).
- **Phase 1b-ii — SHIPPED:** cross-instance **fan-out**, **signal-not-payload**
  (the `NOTIFY` 8 KB cap can't carry a Yjs update): a genuinely-local edit writes
  the update to a durable `collab:update` `DurableCollection` keyed by a generated
  id, then publishes `{canvasId, updateId, originId}`; a receiver on another
  instance fetches the update and applies it with the `REMOTE` origin (so it is
  relayed to that instance's local sockets but NOT re-fanned — the loop guard),
  skipping its own `originId` (echo guard); the writer self-prunes the row after
  30 s. **Reuses the storage pub/sub** (`publishHostExtEvent`/`subscribeHostExtEvent`
  — one multiplexed, self-healing `LISTEN` connection per instance on Postgres, an
  in-process emitter on memory/sqlite), so there is **no new dedicated pg
  connection** and it is testable in-process on memory storage. Proven by
  `test/collab-fanout.test.ts` (a peer update applies + relays to a local client;
  an own-origin notify is skipped). **Follow-up:** a periodic sweep for
  writer-crash-orphaned `collab:update` rows (self-prune is best-effort). **Enable
  still gated** on the pg connection-budget reconciliation. Next: Phase 2 (FE
  `useCollab` seam + `y-prosemirror` binding + remote cursors + per-user undo).

### Phase 2 design — accepted 2026-07-11 (`/architect`)

> **Correction (2026-07-12 — ADR 0359):** Phase 2's *wiring ownership* is corrected,
> not its technical decisions. 2a-ii-B placed the toggle-resolve + `useCollab` +
> claim-seed + CAS-save-suppression logic inside the `document-editor` feature
> (`DocumentEditorSurface`); **ADR 0359** hoists that provisioning into the canvas
> chassis (`CanvasEditorPage` + `EditorSurfaceProps.collab`) so every canvas type binds
> through one seam, generalizes the backend `canvas.document` pins into a
> collab-capable type registry (path `document-collab` → `canvas-collab`), and promotes
> the optional Phase 2c (`host.canvas` derive) to **required**. Phases 3–4 of this ADR
> are implemented by ADR 0359; the transport, auth boundary, persistence model, and the
> Phase 2 rulings (undo swap, seeder election, save coexistence) are unchanged.

Bind `canvas.document` to the transport (the witness surface). **Verdict: PROCEED,
split 2a / 2b** at real data-integrity gates. Required corrections:

- **[CRITICAL save coexistence]** When collab is on, the FE **must NOT** run the
  chassis `host.canvas` CAS save — N clients each saving → 409 storms +
  double-authority. The Phase 1b-i **CRDT snapshot is the durable authority**;
  deriving `host.canvas` (version-history/Compare) moves **backend-side** →
  **2b**. Reconciles with ADR 0334: CAS is the dormant-mode authority, the CRDT
  supersedes it while a room is live.
- **[CRITICAL seeding race]** A naive FE empty-check double-seeds (two clients
  both seed a fresh room → duplicated content; CRDT can't dedupe a "seed once").
  Use a **durable seeder election** — claim a `collabSeeded` marker via the
  storage **CAS** (`host_ext_kv` compare-and-swap); only the winner seeds from
  `host.canvas`. Involved → **2b**; **2a** binds/syncs an existing-or-empty room.
- **[HIGH undo-ownership]** Swap `prosemirror-history` → `yUndoPlugin` when collab
  on (a global history lets one user undo another's edits — a multiplayer bug);
  supersedes the ADR 0334 rule while collab is active. **Resolve collab-on ONCE
  at mount** (gate the surface render until the toggle resolves, then create the
  editor once with the final extension set) — never recreate mid-session.
- **[HIGH bundle]** `useCollab` **dynamic-`import()`s** yjs/y-prosemirror/
  y-websocket only when `enabled`, so they load only when a collab session
  actually starts — out of the entry (186 kB) budget entirely.
- **[PASS WS auth]** The SPA→`*.run.app` WS reuses the SSE cross-origin cookie
  posture (browser auto-sends `__session`; `OPENWOP_CORS_ORIGINS` already lists
  the SPA origin for Phase 1a's Origin check). The browser WS API can't set
  headers, so the SSE SameSite=None config is the prerequisite (already met).
- **Boundary:** `useCollab` in `canvas/` (chassis seam); `document-editor`
  consumes it; no chat coupling.
- **Phase 2a-i — SHIPPED:** the `useCollab({canvasId, enabled})` chassis seam
  (`canvas/useCollab.ts`). When enabled it **dynamically imports** yjs +
  y-websocket + y-protocols (kept out of the entry chunk — verified: yjs absent
  from `index-*.js`, entry 185.7 kB) and provisions a `Y.Doc` +
  `WebsocketProvider` (direct to `config.sseBaseUrl`, http→ws, room = canvasId —
  the Phase 1 auth-boundary WS; browser auto-sends `__session` per the SSE
  posture) + `Awareness`, returning typed handles; disabled ⇒ `{enabled:false}`
  no-op (single-writer path untouched); tears everything down on unmount.
  Unit-tested (disabled / no-canvasId / provision+teardown with the provider
  mocked); the live FE↔backend sync is a browser/e2e concern (the backend room is
  unit-tested in `backend/test/collab-*.test.ts`).
- **Phase 2a-ii-A — SHIPPED:** the y-prosemirror **binding primitive**
  (`collabExtension.ts`) — one TipTap `Extension` wrapping
  `ySyncPlugin(yXmlFragment 'doc')` + `yCursorPlugin(awareness)` + `yUndoPlugin`
  (per-user undo; supersedes the ADR 0334 rule while collab is on). Unit-tested by
  mounting a real editor over a `Y.Doc`: the y-sync plugin installs and an editor
  edit reaches the shared `Y.XmlFragment` (the hard ProseMirror↔Yjs binding,
  verified in jsdom). Kept out of the entry chunk. With 2a-i (the `useCollab`
  transport seam), **both hard technical halves — client transport + editor
  binding — are now built and independently tested.**
- **Phase 2a-ii-B — SHIPPED:** the surface **integration**. An outer
  `DocumentEditorSurface` resolves the `realtime-collab` toggle + `useCollab`
  behind a loading gate (**resolve-collab-once at mount**; the SOLO path — toggle
  off/resolving — never gates, so it is unchanged) and renders the body (inner,
  keyed) that, when collab is on: uses `documentExtensions({history:false})` +
  `collabExtension`, omits the `content` prop (the CRDT is the source),
  **suppresses the FE CAS save** (no 409 storms; the snapshot is authoritative),
  and disables the re-seed effect. **Solo-path regression guard: the full 58-test
  doc-editor suite stays green.**
- **Phase 2b — SHIPPED:** the **seeder election** — a `POST …/document-collab/
  :canvasId/claim-seed` verb (toggle-gated, tenant-scoped, uniform 404) backed by
  an insert-if-absent `DurableCollection.compareAndSwap` (`claimCollabSeed`),
  correct across the ≤5 instances. The first-ever opener wins `{seed:true}` and
  writes the loaded `host.canvas` doc into the `Y.Doc` (`setContent` →
  ySyncPlugin); every later client gets `{seed:false}` and receives it by sync.
  The **CAS**, not an emptiness check, is the authority (ySync populates an empty
  paragraph on bind). Unit-tested (CAS election + route authz/toggle/404).
- **Remaining before ENABLING in prod (dormant until then):** (1) a **browser/e2e
  pass** verifying live two-client sync, remote cursors, per-user undo (the unit
  suites can't drive a live provider); (2) the **pg connection-budget
  reconciliation** (`poolMax×maxScale` vs the ~22 db-f1-micro guideline); (3)
  optional **2c** — a backend derive of `host.canvas` from the CRDT snapshot for
  version-history/Compare parity (the snapshot is already the durable authority).
  Phases 3–5 (other canvas types + chat presence) reuse this same transport.

## Architect analysis (Track A + B — the risks that gate this program)

- **CRITICAL Security / tenant isolation (Track A):** the WebSocket is a NEW authenticated surface. It MUST authenticate on connect (session cookie, same identity as HTTP), authorize the specific canvas per-tenant (uniform close on mismatch — no cross-tenant doc join), and rate-limit connections. A Yjs room = one canvas; room ids must be unguessable / tenant-checked, never a bare canvasId a cross-tenant client could join. This is the load-bearing review before any code.
- **CRITICAL Data integrity / persistence:** `gc=false` + snapshot/update-log is a different durability model than CAS; the migration/coexistence with `host.canvas` (which is authoritative when collab is off) must be exact — one document must never have two divergent authorities. Decision: when a canvas has an active CRDT doc, the CRDT is authoritative and `host.canvas` snapshots are derived; converting a single-writer doc to collaborative is a one-way seed.
- **CRITICAL Replay/fork (Track B):** run-produced canvases (`from-artifact`) remain deterministic; a collaborative doc's history is the CRDT update log, not the run event log — the wire's replay/fork is unaffected because collaboration is host-internal (no run event carries CRDT state).
- **HIGH Accessibility:** live multiplayer generates an `aria-live` firehose (research §8 open slot) — presence/remote-edit announcements MUST be throttled/summarized, and the comment/suggestion review surface kept linear for screen readers. Budget this explicitly.
- **HIGH Scale/cost:** a stateful socket service changes the deploy profile (the Cloud Run + Cloud SQL budget, private memory `pg-connection-exhaustion`); connection caps + Redis fan-out (`Hocuspocus` scales with Redis) are part of Phase 1.

## RFC verdict (the wire gate — explicit)

**Host-internal collaboration transport = NO new RFC.** A WebSocket sync service under the app's own origin, persisting Yjs docs for THIS host's own canvases, touches no OpenWOP wire surface — it is host-extension infrastructure (the ADR 0310/0333 precedent for non-normative surfaces).

**The RFC trigger (deferred, explicit):** advertising **cross-host presence or co-editing** as a capability (a peer host MUST interoperate on a shared live document, a normative presence/awareness event, or a `capabilities.realtime*` flag in `/.well-known/openwop`) touches the wire → a **new `../openwop` RFC first**, reaching `Accepted` before/with the advertisement (`OPENWOP_REQUIRE_BEHAVIOR=true` honesty). Until then this program advertises nothing cross-host.

## Alternatives considered
1. **Operational Transform (Google-Docs/ShareDB style).** Rejected — requires a central authority to order ops, merges diverged offline edits poorly, and the ecosystem has converged on CRDTs for web rich text (research §2.3). Only correct if extending an existing OT system, which we are not.
2. **Automerge instead of Yjs.** Rejected for web rich-text — 25× larger bundle, slower, weaker editor bindings (research §2.2). Automerge wins only for git-like branchable JSON, which is not this use case.
3. **Build collaboration inside the `documents` / `document-editor` feature.** Rejected — it is app-wide infrastructure; a per-feature copy would be the parallel-system anti-pattern (the very reason this is a program ADR, not ADR 0334 Phase 7 inline).
4. **Extend `host.canvas` CAS to multi-writer.** Rejected — whole-doc CAS + 409 is last-writer-wins with lost updates under true concurrency; it is the single-writer fallback, not a collaboration substrate.
5. **A managed provider (Liveblocks) instead of self-hosting.** Open — viable (`@liveblocks/yjs`), trades infra for cost + a third-party data-plane; decide at Phase 1 against the white-label/self-host posture.

## Open questions
- [ ] Self-hosted Hocuspocus vs y-sweet (S3 persistence, Figma-like) vs managed Liveblocks — decide at Phase 1 against the deploy/white-label constraints.
- [ ] The exact `host.canvas` ↔ CRDT authority handoff (one-way seed vs live mirror) + how History/Compare reads CRDT snapshots.
- [ ] Accessible-multiplayer design (throttled presence announcements; linear SR review surface) — the research §8 open differentiation slot, ours to take.
- [ ] Whether chat co-presence rides this transport or keeps its SSE model.

## Status note

**No code ships with this ADR.** It is the Phase-7 decision record + build plan; implementation is the multi-phase program above, each phase toggle-gated and separately reviewed (/architect on the sync-service security threat model is REQUIRED before Phase 1 code). ADR 0334 Phases 0–6 (the single-writer editor) are implemented and independent of this program.
