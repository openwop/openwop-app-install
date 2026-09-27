# Seed data — the brand-authoring surface

This directory holds the example **content** the reference host seeds for a
first-time visitor, kept as **data, not code** (the same principle as
myndhyve's `src/seeds/SEEDING.md`: *do not hard-code seed content in runtime
modules*). A white-label deployer re-skins the example content by editing these files —
not by hand-editing the seeding logic in `../exampleDataSeed.ts`.

Proportionate to this host: there is **no generator script, Firestore, or
admin panel** (myndhyve's `.ts → JSON → Cloud Function → Firestore` pipeline).
The JSON here is consumed directly — `esbuild --bundle` inlines it into
`lib/index.js` at build time, and `exampleDataSeed.ts` writes it through the durable
host-extension stores.

## Files

| File | Seeds | Consumed by |
|---|---|---|
| `exampleAgents.json` | The five example personas (roster entries), each with a role, board cards, schedules, and an org-chart position | `../exampleDataSeed.ts` → `seedDemoAgents()` |
| `workforces.json` | The five governed workforces (purpose/policy, agent cluster, decision boundaries). Each carries an optional `historyRunCount` — when `> 0` the workforce ships that many synthetic runs (telemetry + the graduation curve); when absent/0 it's a stand-up template with no sample history. | `../workforceService.ts` → `seedWorkforceEntities()` + `seedWorkforceHistory()` |
| `featurePages.json` | The public, **host-global** "Features" CMS page (ADR 0027) documenting every feature the app offers — grouped feature entries (name + tagline + `appPath`, optional add-on flag) plus hero/intro/CTA copy. Authored in the typed-section model and published at **`/p/features`**. | `../featuresPage.ts` → `ensureFeaturesPage()` |

> **Host-global vs per-tenant.** `featurePages.json` (like the system home page) seeds **host-global** content into the reserved system-site org (`host-site`, ADR 0027) — shared across the whole deployment, not per tenant. Its seeder's `clear()` is a deliberate no-op (clearing per-tenant would remove the public page for everyone), and it's published via the normal CMS publish transition (not a raw status write). After editing `featurePages.json`, bump `SEED_VERSION` in `../featuresPage.ts` so a redeploy refreshes the live page — but only while it has never been hand-edited in the CMS (a human edit freezes it).

> The runnable workflow definitions a persona's portfolio points at live in
> `../exampleWorkflows.ts` (executable node graphs, not brand content). Their
> human-facing `name`/`purpose` strings can be edited there.

## To re-brand the example content

1. **Edit `exampleAgents.json`** — change personas, descriptions, system
   prompts, card titles, schedule labels, department names. The shape is
   validated against the `SeedAgent` type in `exampleDataSeed.ts` at compile time
   (`tsc`/CI), so a malformed edit fails the build.
   - **`autonomyLevel`** (optional, per persona): omit or `"auto"` to start
     heartbeat picks immediately; `"review"` ships the persona in the
     "agents propose, humans dispose" mode — its heartbeat queues a proposal
     to the approval inbox instead of running it. The stock seed ships **Nora**
     in `review` so the approval flow is exercisable out of the box.
2. **Rebuild** the backend (`npm run build`) and redeploy — the JSON is
   bundled, so the new content ships with the image.

## The example-data seeder registry (`../exampleDataSeeders.ts`)

The `/example-data` dashboard is **registry-driven**: each seedable kind of example
data is one `ExampleDataSeeder` entry —

```ts
interface ExampleDataSeeder {
  id: string;            // 'agents', 'workforces', …
  label: string;
  description: string;
  count(tenantId, storage): Promise<number>;   // live "N present" on the dashboard
  seed(tenantId, storage):  Promise<{ created: number; details? }>;
  clear(tenantId, storage): Promise<{ cleared: number; details? }>;
}
```

A seeder may declare `dependsOn?: string[]` (ids of seeders whose data it builds
on). Since 2026-07-06 (grade-data), `dependsOn` is **enforced on seed**: running a
selection auto-includes each step's transitive ancestors, in registry order, and
marks them `autoIncluded: true` in the step results — so seeding `workforces`
alone also (idempotently) seeds `agents` first, and a dependent seeder never
lands its rows under a fallback scope because its substrate was missing.
**Clearing never expands**: a destructive operation stays exactly the explicit
selection (dependents of a cleared step may keep now-dangling demo refs — they
are demo rows; re-seed or clear them explicitly).

The status / run / clear endpoints and the dashboard all derive from the
`EXAMPLE_DATA_SEEDERS` array, so **adding a new example data type is one entry** — no
endpoint or UI edits:

1. Implement `count` / `seed` / `clear` (reuse the per-domain services; keep
   `seed` idempotent and `clear` scoped to the canonical example entities only).
2. Append the entry to `EXAMPLE_DATA_SEEDERS`. It appears on `/example-data` automatically
   with its live count, a checkbox, dry-run, load, and clear.

Endpoints (host extension): `GET /v1/host/openwop-app/demo/status`,
`POST …/demo/run` (`{steps?, dryRun?}` → `{results, summary}`),
`POST …/demo/clear`. The legacy `POST …/demo/seed` remains for back-compat
(auto-seed + tests).

## Two switches: demo deployment vs. clean install

| Env var | Default | Controls |
|---|---|---|
| `OPENWOP_DEMO_MODE` (`../demoMode.ts`) | **off** | Everything AUTOMATIC: the boot `__showcase__` seed, the workforce showcase fallback, and the frontend's silent auto-seed. **Off ⇒ a clean / white-label install boots empty** — production-grade out of the gate. The public demo sets it `true` (and the synthetic data it surfaces is BADGED illustrative). |
| `OPENWOP_DEMO_SEED_ENABLED` (`../exampleDataSeed.ts`) | on — **except the enterprise (`auth`) posture, where it defaults OFF** (DUR-3, ADR 0195) | Whether explicit, user-triggered seeding is *available at all* (the `/example-data` dashboard + "Load example data" actions). Opt-in under `OPENWOP_DEPLOY_POSTURE=auth` (set `true` explicitly to enable); set `false` to remove the capability on any posture. |

So: **clean install** = `DEMO_MODE` off → nothing auto-seeds, no showcase
data, honest empty states; example data is still loadable on demand from
`/example-data` (unless `DEMO_SEED_ENABLED=false`). **Public demo** = `DEMO_MODE=true`
→ populated + badged. **Enterprise (`auth` posture)** = seeding OFF unless
`DEMO_SEED_ENABLED=true` is set explicitly.

## To ship NO example content (clean tenant)

`OPENWOP_DEMO_MODE` already defaults off, so a fresh deploy auto-seeds nothing.
To also remove the explicit "Load example data" capability, set — no code edit, no
rebuild:

```
OPENWOP_DEMO_SEED_ENABLED=false
```

`seedDemoAgents()` then returns `{ seeded: false, agents: 0 }` and writes
nothing. (Incremental Cloud Run env update; preserves all other config.)

## Idempotency

Seeding is **per-persona idempotent** and **non-destructive**: each persona is
created only if missing, so a re-seed never duplicates and never clobbers a
user's own edits. There is no version/hash gate (unlike myndhyve's workflow
content-hash gate) — the empty-roster check is the whole contract.

## Seeder safety invariants (the `demo-*` phases — learned the hard way)

Two rules every `demo-*` seeder MUST follow. Both come from real review blockers
(#1344 CRITICAL/HIGH) and prevent one tenant's seed from corrupting another's —
or a seed's `clear()` from deleting a user's own data:

1. **Never mint a fixed id on a store whose `DurableCollection` key isn't
   tenant-prefixed.** `access-orgs` is keyed by `orgId` alone and `deleteOrg`
   cascades by `orgId` alone, so a fixed per-tenant id (`org-solstice-demo`) lets
   tenant B's seed overwrite tenant A's row — and B's `clear()` cascade-delete
   A's teams/members. Let the service mint its random id and mark ownership with a
   `createdBy`/actor marker instead. Fixed ids are ONLY for deliberately
   **host-global** rows (`host-site`, ADR 0027). Check the collection's key
   function before choosing a fixed id.

2. **Never delete a by-natural-key-matched entity (name, code, shared key)
   without an ownership marker.** If a seeder REUSES a name/code-matched
   pre-existing entity (a user's own "Sales" team, a shared coupon code, a
   like-named pipeline), `clear()` deleting it by that same key destroys user
   data. Delete only rows carrying your `createdBy`/actor marker, or (where the
   store has no creator field) a full canonical-value match that a user's row
   can't accidentally satisfy, or namespace your ids/codes (`SOLSTICE-*`,
   `demo-<phase>-<slug>`). When neither is possible, leave the residue and
   document it — never a blind name/code delete.

Corollaries: **`deleteOrg` refuses while the org holds business rows** (#1370,
returns `blocked:{rows}`) — a per-feature `clear()` must treat that as an honest
skip, not an error (the registry's reverse-order full clear empties dependents
first). And **`dependsOn` is load-bearing**: `runExampleDataSeed` auto-includes
transitive `dependsOn` ancestors on seed (#1362), so declare them accurately.
