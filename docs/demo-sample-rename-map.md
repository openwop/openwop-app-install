# Demo / Sample → openwop-app Rename Map (canonical)

Companion to `demo-sample-purge-audit.md`. This is the authoritative target-string
map the productionization uses. Driver: make this a credible white-label app — no
"demo"/"sample"/"not-production-hardened" framing; a neutral, honest vendor identity.

**Vendor identifier:** `sample` → **`openwop-app`** (per user directive). This is the
reference host's default vendor prefix; white-label deployers override it via
`OPENWOP_SERVICE_VENDOR`.

## Wire / identifier literals (codemod, longest-first)

| Old | New | Notes |
|---|---|---|
| `/v1/host/sample` | `/v1/host/openwop-app` | route prefix (covers trailing `/` and `'`) |
| `local.sample.demo.` | `local.openwop-app.` | node typeIds; drops `demo` segment |
| `vendor.openwop-sample.` | `vendor.openwop-app.` | vendor node ns + emitted event |
| `sample.demo.` | `openwop-app.` | workflow IDs (uppercase, approval-gate, …); drops `demo` |
| `sample.agents.` | `openwop-app.agents.` | work-twin workflow IDs |
| `sample.conversation` | `openwop-app.conversation` | + `.test` suffix variant |
| `sample.chat.turn` | `openwop-app.chat.turn` | chat transport workflow |
| `sample.web.` | `openwop-app.web.` | web.research / web.search-only |
| `sample.trigger.` | `openwop-app.trigger.` | trigger workflows (tests) |
| `sample.knowledge` | `openwop-app.knowledge` | |
| `sample.notes` | `openwop-app.notes` | capability key |
| `sample.openwop.evals.` | `openwop-app.evals.` | eval suite id |
| `openwop.sample.` | `openwop-app.` | localStorage ns (de-dups leading `openwop.`); needs migration |
| `openwop-workflow-engine-sample` | `openwop-workflow-engine` | OPENWOP_SERVICE_NAME default |
| `openwop-samples` | `openwop-app` | OPENWOP_SERVICE_VENDOR default (matches `vendor.openwop-app.*`) |

## Conformance compatibility (REQUIRED)

The pinned `@openwop/openwop-conformance` suite calls `/v1/host/sample/test/*` and FAILS
on 404 for any seam whose capability flag is advertised. Mitigation: mount the renamed
test-seam router **also** at `/v1/host/sample/test/*` as a back-compat alias (internal,
commented) so certification keeps passing. New product surface uses `/v1/host/openwop-app/`.

## Identifier (symbol) renames — phase 2

`SAMPLE_*` consts, `Demo*` components, demo-seed files. Tracked separately so the
literal codemod can land + go green first.

## "Demo mode" is a KEPT, required deployment posture (user directive)

Running the app in **demo mode** at `app.openwop.dev` is a hard requirement. So we
do NOT purge "demo" as a *deployment-posture* concept — only as *product/white-label*
framing. The distinction that resolves the whole effort:

| Concept | Name | Why |
|---|---|---|
| Deployment posture gate | **`demoMode()` / `OPENWOP_DEMO_MODE`** (KEPT) | It genuinely IS a demo deployment. Gates auto-seed + banner + relaxed enforcement. Advertised as the `demoMode` capability field. |
| Seedable showcase content | **"example data"** (renamed) | Neutral, so a white-label admin can load example data with no "demo" framing. `exampleDataSeed`, `ExampleDataPage`, `exampleAgents.json`, `EXAMPLE_DATA_SEEDERS`, … |

Relationship: `demoMode()` ON → auto-loads example data + shows the in-memory host
banner + relaxes enforcement (the app.openwop.dev showcase). `demoMode()` OFF
(white-label default) → clean, production-grade, no demo framing; an admin can still
explicitly load **example data** via the neutrally-named dashboard.

→ **Phase 2 correction:** the posture gate was briefly renamed to `exampleDataMode`;
reverted to `demoMode` so the live `OPENWOP_DEMO_MODE=true` deploy keeps working and
the mode stays first-class.

## Env / KV / agentRef — phase 3 (REVISED)

- **KEEP** `OPENWOP_DEMO_MODE` and `OPENWOP_DEMO_SEED_ENABLED` — demo-deployment
  switches; renaming would break the live `app.openwop.dev` config. (Dropped the
  earlier plan to rename these.)
- `demo:seed-claimed:{tenant}` KV marker and `host:demo-<role>` agentRef: only ever
  written by the example-data seeder. Rename to `host:example-<role>` /
  `example-data:seed-claimed:{tenant}` **with old-key fallback** so existing demo
  tenants keep working — or defer (low white-label visibility). Decide in Phase 3.

## Example-data capability disposition

NOT deleted — renamed to neutral **"example data"** (an optional, clearly-labeled,
loader an enterprise can use to preview, then clear). Demo mode auto-invokes it; purge
only the framing that leaks into the *white-label/production* experience
("demo-grade", "not production-hardened", "this sample"). Demo-mode-only copy (the
in-memory host banner shown solely when `demoMode()` is on) stays — it's accurate there.
