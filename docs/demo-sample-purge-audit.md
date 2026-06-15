# Demo / Sample Purge Audit

**Status:** Inventory (Phase 1 of cleanup — identification only, no edits yet)
**Date:** 2026-06-14
**Audited tree:** `origin/main` @ `59ce1c2` (detached worktree)
**Scope:** Whole repo except `node_modules`, `dist`, `.git`, `*.lock`

This is the first cleanup step: **find and record** every use of "demo", "sample",
and adjacent placeholder/seed terms across file names, identifiers (class / function /
variable / type / route / env-var), folder names, structured data, and prose — so a
follow-up PR can purge or rename them deliberately.

> **Important:** Not every hit is a purge target. The audit separates **PURGE**
> (demo/sample *product framing*) from **KEEP** (protocol-normative conformance
> vocabulary, JSON-Schema keywords, HTML attributes, domain enums, math/stats terms).
> Read §5 before touching anything — several "sample"/"mock" uses are wire-normative
> and removing them is a dishonest-host change.

---

## 1. Gross match counts (case-insensitive, excl. node_modules/dist/.git/lock)

| Term | backend/ | frontend/ | data+config | docs (*.md) | Verdict summary |
|---|---|---|---|---|---|
| **demo** | 940 | 316 | 26 | 197 | Almost entirely PURGE |
| **sample** | 2166 | 321 | 18 | 314 | PURGE except wire route prefix¹ + stats/English |
| **seed** | ~934 | 162 | 9 | 77 | SPLIT — demo-seeding PURGE; crypto/ad/form-init KEEP |
| **mock** | 445 | 65 | 72 | 10 | Mostly KEEP (RFC 0023 conformance + test mocks) |
| **fixture** | 278 | 2 | ~50 | 121 | KEEP — conformance test vocabulary |
| **stub** | (w/ fixture) | 14 | 6 | 56 | Mostly KEEP — throw-on-use adapter pattern |
| **placeholder** | (functional) | 204 | 12 | 20 | Mostly KEEP — HTML attr / template / SQL |
| **example** | n/a | 30 | ~25 | n/a | SPLIT — JSON-Schema kw + RFC 2606 KEEP |
| **acme** | 129 | 19 | 5 | 16 | SPLIT — `brand-acme` PURGE; naming-illustrations KEEP |
| **fake** | 68 | 2 | 0 | 8 | KEEP — test helpers + "no fake X" ethics prose |
| **faux** | 3 | 2 | 0 | 1 | KEEP — CSS faux-bold typography only |
| dummy / foobar / lorem / john-doe / jane-doe | ~1 | 2 | 0 | ~1 | jane-doe = HTML placeholder attr (KEEP) |

¹ `/v1/host/sample/*` is the spec-designated host-extension namespace (~178 routes).
It is a deliberate rename, not a deletion — see §3.1 and `MIGRATION-TODO.md` item 4.

---

## 2. PURGE LIST — the canonical terms to eliminate / rename

Add these to the purge vocabulary. Each links to its detailed inventory below.

| # | Term / pattern | Kind | Where | Action |
|---|---|---|---|---|
| 1 | `/v1/host/sample/*` | route prefix | everywhere (BE routes, FE clients, all ADRs, docs) | rename prefix (coordinated, breaking) — §3.1 |
| 2 | `local.sample.demo.*` | node typeIds | BE nodes, FE nodeCatalog, conformance fixtures | rename namespace — §3.2 |
| 3 | `sample.agents.*`, `sample.demo.*`, `sample.conversation`, `sample.chat.turn`, `sample.web.research` | workflow IDs | BE demoWorkflows/host, FE transport | rename — §3.2 |
| 4 | `vendor.openwop-sample.*` | vendor node ns | BE, FE nodeCatalog | rename — §3.2 |
| 5 | `openwop.sample.*` | localStorage keys | FE storage/chat/builder | rename namespace (migration) — §4.2 |
| 6 | the whole **demo-seed subsystem** | files+symbols | BE `host/demo*.ts`, `seedEverything.ts`, `seed-data/`, `routes/demoSummary.ts` | delete/rename — §3.3 |
| 7 | `OPENWOP_DEMO_MODE`, `OPENWOP_DEMO_SEED_ENABLED` | env vars | BE, `.env.example`, docs, FE vite | rename (breaking config) — §3.4 |
| 8 | `demo:seed-claimed:{tenantId}` | KV marker key | BE seed, ADR 0031/0032 | rename (tenant migration) — §3.4 |
| 9 | `host:demo-chief-of-staff`, `host:demo-<key>` | agentRef format | BE seed, ADR 0023, DESIGN.md | rename (persisted id migration) — §3.4 |
| 10 | `openwop-demo-app` | build artifact name | `scripts/build-whitelabel-zip.sh`, `publish-install-repo.sh` | rename — §3.5 |
| 11 | `"Demo host"` default instance name | brand default | FE `brand/defaults.ts`, `check-branding.sh`, WHITE-LABEL.md | rename default — §4.1 |
| 12 | **"demo-grade" / "sample-grade"** framing | prose label | docs, BE comments, surface labels | reword → "in-memory tier" / "memory tier" — §3.6 |
| 13 | `samplePrompts.ts` / `SAMPLE_PROMPTS` | file+const | FE prompts | rename — §4.1 |
| 14 | `DemoDataPage`, `DemoHostBanner`, `AutoSeedDemoData`, `demoMode.ts`, `demoDataClient.ts`, `.demo-host-banner`, `.demodata-*` | FE files/components/CSS | FE | delete/rename — §4.1 |
| 15 | `brand-acme`, `ds-acme-v2`, `"ACME QBR"`, `"Follow up with ACME"` | hardcoded fake brand | BE launchStudioSurface, seed-data, FE AgentIntegrationsPanel | replace — §3.7 |
| 16 | `sample-token`, `bearer-demo` tenant, `"hello demo"` | test creds/values | docs, BE | rename — §3.7 |
| 17 | `sample-grade` / `demo-handoff` / `seeded-id` / `local.sample.demo.mock-ai` | conformance fixture labels | `conformance-fixtures/*.json` | rename (host-local, non-normative) — §3.8 |

---

## 3. Backend + data/config inventory

### 3.1 The `/v1/host/sample/*` route namespace (highest-impact)

~178 Express route registrations carry the `/v1/host/sample/` prefix. This is the
spec's host-extension prefix (advertised in `schemas/capabilities.schema.json`,
`discovery.ts` OpenAPI with `tags: ['sample-extension']`). Renaming touches BE routes,
every FE client base URL, all feature ADRs (0004–0039), README/ARCHITECTURE/FEATURES/
DEPLOY/DEPLOY-SMOKE, CLAUDE.md/AGENTS.md, and the sibling `openwop` spec
(`spec/v1/host-sample-test-seams.md`). **Coordinated, breaking — likely its own PR per
`MIGRATION-TODO.md` item 4.**

Route-owning files (each registers `/v1/host/sample/...`):
`routes/{demoSummary,sampleChat,testSeam,roster,workforces,workspaces,account,governance,daemonStatus,migrate,authSaml,agentProfile,interrupts,workspace,mediaAssets}.ts`,
`features/{assistant,sharing,goals,crm,orgs,connections,users}/routes.ts`,
`features/users/authRoutes.ts`, plus the `discovery.ts` advertisement.

### 3.2 Node typeIds & workflow IDs (wire identifiers)

- Node typeIds: `local.sample.demo.mock-ai`, `local.sample.demo.uppercase`,
  `local.sample.demo.image-emit`, `local.sample.demo.memory-write`,
  `vendor.openwop-sample.chat-responder` (alias `n.chat-responder`).
  In `bootstrap/nodes.ts`, `host/inMemorySurfaces.ts`; consts `sampleMockAiNode`,
  `sampleUppercaseNode`, `sampleImageEmitNode`, `sampleMemoryWriteNode`.
- Workflow IDs: the `sample.agents.*` family (lead-routing, crm-hygiene,
  follow-up-reminder, ticket-classification, priority-escalation, support-response,
  invoice-extraction, approval-gate, spend-anomaly, release-checklist, incident-summary,
  code-review-handoff, campaign-brief, content-approval, channel-publish) — note many
  already alias to `n*` ids in current code. Plus `sample.demo.uppercase`,
  `sample.demo.approval-gate`, `sample.web.research`, `sample.chat.turn`,
  `sample.conversation` in `host/index.ts`.
- Consts: `SAMPLE_INGEST_WORKFLOW_ID` (`routes/triggerBridge.ts`),
  `CHAT_RESPONDER_TYPE_ID` (`providers/managedProvider.ts`),
  `OPENWOP_MESSAGING_WORKFLOW_ID` default (`routes/registerAllRoutes.ts`).

### 3.3 Demo-seed subsystem (files & symbols — PURGE wholesale)

Files that exist **only** for demo content:
- `src/host/demoMode.ts` — `demoMode()`
- `src/host/demoSeed.ts` — `SeedResult`, `SeedOptions`, `demoPersonaNames()`,
  `SEED_AGENTS`, `seedDemoAgents()`, `clearDemoAgents()`, `countDemoAgents()`, …
- `src/host/demoSeeders.ts` — `DemoSeeder`, `DEMO_SEEDERS`, `DemoStepStatus`, `demoStatus()`
- `src/host/seedEverything.ts` — `DEMO_SEED_DOMAINS`, `DemoSeedDomain`,
  `SeedEverythingResult`, `seedEverything()`
- `src/host/demoWorkflows.ts` — `DemoWorkflowSpec`, `DemoRoleKey`, `DEMO_WORKFLOWS`,
  `getDemoWorkflow()`, `demoWorkflowsForRole()`, `mockAiWorkflow()`
- `src/host/seed-data/` — `demoAgents.json`, `workforces.json`, `SEEDING.md`
- `src/routes/demoSummary.ts` — `registerDemoSummaryRoutes()`, `buildDemoSummary()`
- `src/host/examples/widgetService.ts` (+ `src/routes/widgets.ts` seed route)
- Seed helpers riding other files: `workforceHistory.ts` `seedWorkforceHistory()`,
  `workforceService.ts` `seedWorkforceEntities()`/`seedWorkforceHistory()`
- Tests of the above: `test/agents-demo.test.ts`, `demo-seed-*.test.ts`,
  `demo-seeder-registry.test.ts`, `demo-summary.test.ts`, `sample-chat-sessions.test.ts`,
  `host-sample-conformance-seams.test.ts`, `workforce-showcase-fallback.test.ts`,
  `sample-media.test.ts`

Heavy-but-mixed (purge demo parts, keep core): `bootstrap/nodes.ts`,
`host/inMemorySurfaces.ts`, `host/index.ts`, `src/index.ts`,
`routes/registerAllRoutes.ts`, `routes/discovery.ts`, `routes/workforces.ts`,
`routes/agentOps.ts`, `routes/mediaAssets.ts`, `host/surfaceBackends.ts`,
`host/knowledgeSurface.ts`, `host/webResearchSurface.ts` ("Deterministic demo snippet").

### 3.4 Env vars, KV keys, agentRefs (breaking — need migrations)

- `OPENWOP_DEMO_MODE`, `OPENWOP_DEMO_SEED_ENABLED` (BE + `.env.example` + FE vite + docs)
- `demo:seed-claimed:{tenantId}` KV idempotency marker (ADR 0031/0032) — renaming
  invalidates existing tenants' markers unless migrated
- `host:demo-chief-of-staff` / `host:demo-<key>` agentRef format (ADR 0023, DESIGN.md) —
  persisted in tenant KV; needs a migration
- `OPENWOP_SERVICE_NAME=openwop-workflow-engine-sample`,
  `OPENWOP_SERVICE_VENDOR=openwop-samples` (WHITE-LABEL.md defaults)

### 3.5 Build / ops scripts

- `scripts/build-whitelabel-zip.sh`, `scripts/publish-install-repo.sh` — artifact
  `openwop-demo-app` (zip name, dir prefix, GitHub release URL) → rename
- `scripts/check-branding.sh` — greps for `"Demo host"`; update when default renamed
- `providers.json` (×3) — `"Your key stays in the sample server's …"` help text
- `Dockerfile` L9 — comment "deployed sample BE can stand in as …"

### 3.6 "demo-grade" / "sample-grade" prose (reword, don't delete the code)

Pervasive label for the in-memory / non-persistent tier. In BE: `host/index.ts`,
`surfaceBackends.ts`, `inMemorySurfaces.ts`, `a2aSurface.ts` ("honest demo stubs").
In docs: DEPLOY.md ("From demo-grade to production-grade", "demo tier"),
DEPLOY-SMOKE.md, deploy/README.md ("Demo-grade default" column),
ARCHITECTURE.md ("In-memory host surfaces (demo-grade)", "Sample impl" column),
README.md, executive-assistant gap analysis. → reword to "in-memory / memory tier".

### 3.7 Hardcoded fake brand / test values (PURGE)

- `host/launchStudioSurface.ts:32-33` — `brand-acme`, `ds-acme-v2`
- `host/seed-data/demoAgents.json` — `"ACME QBR"` task title
- `routes/triggerBridge.ts:320` — default `'in.example.com'`
- `bootstrap/nodes.ts:1896` — fake web-research result URLs `https://example.com/...`
- README/DEPLOY — `Bearer sample-token`, `tenantId:"demo"`, `"hello demo"`,
  `bearer-demo` tenant (HOST-EXTENSIONS.md)

### 3.8 Conformance fixtures (host-local labels — rename, NON-normative)

These are host-side fixture *labels*, not wire-normative, so they're safe to rename:
- `conformance-fixtures/conformance-prompt-{all-four-kinds,end-to-end}.json` —
  `typeId: "local.sample.demo.mock-ai"`
- `conformance-fixtures/conformance-agent-reasoning.json` — `"reason":"demo-handoff"`
- `conformance-fixtures/conformance-phase4-nondet-tool.json` — `"…for sample-grade"`
- `conformance-fixtures/conformance-subworkflow-mid-run-mutation.json` —
  `"seeded-id"` (low priority; could be `"initial-id"`)

---

## 4. Frontend inventory

### 4.1 Files / components / CSS that are PURE demo scaffolding (delete or rename)

- `src/settings/DemoDataPage.tsx` (33 hits) — the demo-seeding dashboard UI
- `src/client/demoDataClient.ts` — `getDemoStatus/runDemoSeed/clearDemoData`, `DemoStep`
- `src/client/demoMode.ts` — `demoModeCached()`, `loadDemoMode()`
- `src/chrome/AutoSeedDemoData.tsx` — silent auto-seed on load
- `src/builder/DemoHostBanner.tsx` — "Anonymous demo." banner; `DISMISS_KEY`
- `src/prompts/samplePrompts.ts` — `SAMPLE_PROMPTS` bundled prompt library
- CSS classes in `styles/global.css`: `.demo-host-banner*` (6), `.demodata-*` (5)
- Route `/demo-data` (`chrome/features.tsx`, `e2e/a11y.spec.ts`)
- `brand/defaults.ts` — `instanceName: 'Demo host'`,
  `footerText: 'Sample / template code. Not production-hardened.'`
- Exported helpers: `agents/rosterClient.ts` `seedDemoAgents()`,
  `builder/persistence/localStore.ts` `topUpSeededWorkflows()`,
  `mockAiToChatMigration()` + `LS_MIGRATION_MOCK_AI_TO_CHAT`

### 4.2 `openwop.sample.*` localStorage namespace + workflow-id consts

`platform/storage.ts` and friends use the `openwop.sample.*` key namespace:
`byok.activeConfig`, `byok.pendingManaged`, `chat.session`, `chat.sessions-index`,
`prompts.user`, `builder.workflows`, `builder.workflows.seeded`, `lastSuccessAt`,
plus `chat.leftRail.activeTab` etc. (`chat/ChatSidebar.tsx`),
channel `'openwop-sample-chat'` (`useChatSessions.ts`),
`CONVERSATION_WORKFLOW_ID = 'sample.conversation'` (`chat/conversationTransport.ts`),
node typeIds in `builder/palette/nodeCatalog.ts`. Also `demoBannerDismissed`
(`openwop:demo-banner:dismissed`). Renaming needs a localStorage migration.

### 4.3 User-visible UI copy (high priority — strings users read)

Buttons/labels/body text containing demo/sample (rename copy):
- "Load demo data" / "Load demo agents" / "Load all demo data" / "Clear demo data"
  (`DemoDataPage`, `WorkforceOverviewPage`, `WorkforcesGalleryPage`, `AgentDashboardPage`)
- "Anonymous demo." / "Anonymous demo state is wiped every 24h." (`DemoHostBanner`,
  `SignInButton`)
- "Demo data" nav label + "Re-seed the built-in demo roster" (`chrome/features.tsx`,
  `ui/CommandPalette.tsx`)
- "Demo simulation" / "Demo" chips, "Simulated Discord tasks (demo)",
  "…is a built-in demo agent…" (`AgentIntegrationsPanel`, `AgentInstructionsPanel`)
- "About this sample", "Submit a workflow on the live sample host…" (`RunsIndexPage`,
  `CommandPalette`)
- "Waking up your demo server", "The demo is resting", "…keep the sample cheap to host."
  (`BackendStatusCard`)
- "the sample server forwards each request…" (`ProviderGrid`)
- "Try the live demo" / "Open the live demo →" (`FrontPage`)
- "the demo's primary sign-in." (`SsoPanel`)
- "Illustrative sample data — not derived from live records" (`IllustrativeBadge` tooltip)

### 4.4 FE KEEP (do NOT purge)

- `placeholder="…"` HTML attrs (204) incl. `"Jane Doe"`, `"Acme"`, `"Acme Corp"`,
  `"controller@example.com"` — legitimate input hints (review *values* only if desired)
- Local variable `seed` for form-state init in `ProfilePage`, `TeamPage`,
  `CommentsPage`, `RefinementForm`, `defaultCards`, `CommandCenterPage`
- Test mocks: `vi.mock`, `fetchMock`, `vi.stubGlobal`, `vi.useFakeTimers`, `mockFetch`
- CSS `faux`-bold / font-synthesis comments; "no fake affordances" prose
- `examples/hosts/postgres` doc references; `https://collect.example/t` test domain
- `scripts/check-{spacing-literals,built-css}.mjs` — `const samples = []` generic var

---

## 5. KEEP LIST — do NOT purge (protocol-normative / legitimate)

Removing these would break conformance or make a dishonest wire claim.

1. **`core.conformance.mock-agent`** typeId + `bootstrap/conformanceMockAgent.ts`
   (`MockBehavior`, `MockProgram`, `registerMockAgentNode`, `SYNTHETIC_AGENT_ID_PREFIX`)
   — RFC 0023 normative. Tests: `conformance-mock-agent.test.ts`.
2. **`providers/dispatchMock.ts`** (`programMock`, `dispatchMock`, `resetMockPrograms`) +
   `MockProvider`/`mockProvider` in `schemas/run-options.schema.json` +
   `mockProviders`/`mockTestKeyPrefix`/`mockAgent` in `capabilities.schema.json` — the
   spec-canonical test AI backend (provider `"mock"`, model `"mock-mini"`).
3. **`schemas/core-conformance-mock-agent-config.schema.json`** — IS the spec
   (`mockReasoning`, `mockToolCalls`, `mockHandoff`, `mockDecision`, `mockConfidence`).
4. **`conformance-fixtures/`** tree — protocol test vectors; `fixture` is the term of art.
   All `mock*` fields inside fixtures are normative.
5. **JSON-Schema `examples` keyword** in `schemas/*.schema.json` — 2020-12 metadata.
6. **`stub: true` web-search field** (`packs/core.openwop.web-search/schemas/search.output.json`)
   + `engine: "stub"` — wire-format flag for deterministic fallback (rename only the
   *prose* that says "in the demo").
7. **Throw-on-use `stub` adapters** — `identityResolver`, `connectorInvoker`, email
   provider, MCP completion: intentional fail-closed pattern (ADR 0030/0033/0037).
   `stubFromSchema()`/`stubScalar()` in `host/agentDispatch.ts` are functional utilities.
8. **Domain enum values**: `"demo"` CTA (market-intel-ad-angles), `"product-demo"` video
   style (ads-video-generate), `"demo"` sales call type (sales-coach) — real business
   vocabulary.
9. **Functional `seed`**: coin-flip crypto seed (`core.openwop.examples`),
   image/video generation `seed`/`seedImageBase64`, ad-tech "seed audience" enum.
10. **Stats/English `sample`**: `core.obs.metric-histogram` "histogram sample",
    `logSampleIds`/`sampleQuotes` analytics fields, "a style sample", "sample rendering".
11. **`vendor.acme.*`** naming-convention illustrations in schema `description` strings
    (agent-ref, prompt-ref, run-event, node-pack-manifest, etc.) — standard placeholder.
12. **`.example` / `example.com` / `host.example`** — RFC 2606 reserved domains in docs,
    OAuth fixtures, deploy comments. (Purge only under a zero-tolerance policy.)
13. **`fake`/`faux`**: `makeFakePool()`/`makeFakeRunner()` test helpers, "no fake X"
    ethics prose, CSS faux-bold.

---

## 6. ADR / spec significance (renames that ripple)

| ADR | Defines | Rename impact |
|---|---|---|
| 0014 | `host.sample.*` workflow-surface namespace | discovery + capability advert + every surface ADR |
| 0015 | `OPENWOP_DEMO_MODE` posture, "Demo (app.openwop.dev)" | breaking env var; posture table; WHITE-LABEL/DEPLOY |
| 0023 | `host:demo-chief-of-staff` agentRef | persisted id migration; FEATURES/DESIGN |
| 0031/0032 | `demoAgents.json`, `demo:seed-claimed:{tenantId}`, `DEMO_SEEDERS`, ten-twin seed | KV marker migration; file + module renames |
| 0038 | "demo honesty" principle (advertise-only-honored) | rename concept → "honesty"/"fidelity" |
| 0039 | `spec/v1/host-sample-test-seams.md` (sibling spec) | cross-repo rename |
| 0004–0039 (all) | `/v1/host/sample/<feature>/*` routes | the universal prefix rename (§3.1) |

`MIGRATION-TODO.md` already lists items 20–21 as the sample→prod wire-identifier rename
and the README de-"demo" rewrite — this audit is the detailed backing for those items.

---

## 7. Suggested purge sequencing (for the follow-up PR(s))

1. **Low-risk, no wire impact:** FE pure-demo files/CSS/copy (§4.1, §4.3), build artifact
   name (§3.5), "demo-grade" prose reword (§3.6), hardcoded fake brand values (§3.7),
   conformance fixture labels (§3.8).
2. **Demo-seed subsystem removal** (§3.3) — delete files + their tests + call sites in
   `index.ts`/`registerAllRoutes.ts`/`workforces.ts`.
3. **localStorage namespace** (§4.2) — rename with a one-time migration shim.
4. **Breaking wire/config renames (own PR, coordinate with `openwop` spec):**
   `/v1/host/sample/*` prefix (§3.1), node/workflow IDs (§3.2), env vars + KV marker +
   agentRef (§3.4). These need RFC/spec alignment per CLAUDE.md.
5. **Docs sweep** — README, ARCHITECTURE, FEATURES, DEPLOY(-SMOKE), ADRs, WHITE-LABEL,
   SEEDING.md, STORAGE.md, agent instruction files.

Throughout: consult §5 KEEP list before every rename so conformance/honesty surfaces stay intact.
