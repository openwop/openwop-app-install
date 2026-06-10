# Seed data — the brand-authoring surface

This directory holds the demo **content** the reference host seeds for a
first-time visitor, kept as **data, not code** (the same principle as
myndhyve's `src/seeds/SEEDING.md`: *do not hard-code seed content in runtime
modules*). A white-label deployer re-skins the demo by editing these files —
not by hand-editing the seeding logic in `../demoSeed.ts`.

Proportionate to this host: there is **no generator script, Firestore, or
admin panel** (myndhyve's `.ts → JSON → Cloud Function → Firestore` pipeline).
The JSON here is consumed directly — `esbuild --bundle` inlines it into
`lib/index.js` at build time, and `demoSeed.ts` writes it through the durable
host-extension stores.

## Files

| File | Seeds | Consumed by |
|---|---|---|
| `demoAgents.json` | The five demo personas (roster entries), each with a role, board cards, schedules, and an org-chart position | `../demoSeed.ts` → `seedDemoAgents()` |
| `workforces.json` | The five governed workforces (purpose/policy, agent cluster, decision boundaries). Each carries an optional `historyRunCount` — when `> 0` the workforce ships that many synthetic runs (telemetry + the graduation curve); when absent/0 it's a stand-up template with no sample history. | `../workforceService.ts` → `seedWorkforceEntities()` + `seedWorkforceHistory()` |

> The runnable workflow definitions a persona's portfolio points at live in
> `../demoWorkflows.ts` (executable node graphs, not brand content). Their
> human-facing `name`/`purpose` strings can be edited there.

## To re-brand the demo content

1. **Edit `demoAgents.json`** — change personas, descriptions, system
   prompts, card titles, schedule labels, department names. The shape is
   validated against the `SeedAgent` type in `demoSeed.ts` at compile time
   (`tsc`/CI), so a malformed edit fails the build.
   - **`autonomyLevel`** (optional, per persona): omit or `"auto"` to start
     heartbeat picks immediately; `"review"` ships the persona in the
     "agents propose, humans dispose" mode — its heartbeat queues a proposal
     to the approval inbox instead of running it. The stock seed ships **Nora**
     in `review` so the approval flow is demoable out of the box.
2. **Rebuild** the backend (`npm run build`) and redeploy — the JSON is
   bundled, so the new content ships with the image.

## The demo-seeder registry (`../demoSeeders.ts`)

The `/demo-data` dashboard is **registry-driven**: each seedable kind of demo
data is one `DemoSeeder` entry —

```ts
interface DemoSeeder {
  id: string;            // 'agents', 'workforces', …
  label: string;
  description: string;
  count(tenantId, storage): Promise<number>;   // live "N present" on the dashboard
  seed(tenantId, storage):  Promise<{ created: number; details? }>;
  clear(tenantId, storage): Promise<{ cleared: number; details? }>;
}
```

The status / run / clear endpoints and the dashboard all derive from the
`DEMO_SEEDERS` array, so **adding a new demo data type is one entry** — no
endpoint or UI edits:

1. Implement `count` / `seed` / `clear` (reuse the per-domain services; keep
   `seed` idempotent and `clear` scoped to the canonical demo entities only).
2. Append the entry to `DEMO_SEEDERS`. It appears on `/demo-data` automatically
   with its live count, a checkbox, dry-run, load, and clear.

Endpoints (host extension): `GET /v1/host/sample/demo/status`,
`POST …/demo/run` (`{steps?, dryRun?}` → `{results, summary}`),
`POST …/demo/clear`. The legacy `POST …/demo/seed` remains for back-compat
(auto-seed + tests).

## Two switches: demo deployment vs. clean install

| Env var | Default | Controls |
|---|---|---|
| `OPENWOP_DEMO_MODE` (`../demoMode.ts`) | **off** | Everything AUTOMATIC: the boot `__showcase__` seed, the workforce showcase fallback, and the frontend's silent auto-seed. **Off ⇒ a clean / white-label install boots empty** — production-grade out of the gate. The public demo sets it `true` (and the synthetic data it surfaces is BADGED illustrative). |
| `OPENWOP_DEMO_SEED_ENABLED` (`../demoSeed.ts`) | on | Whether explicit, user-triggered seeding is *available at all* (the `/demo-data` dashboard + "Load demo data" actions). A hardened production deploy can set this `false` to remove the capability entirely. |

So: **clean install** = `DEMO_MODE` off → nothing auto-seeds, no showcase
data, honest empty states; demo data is still loadable on demand from
`/demo-data` (unless `DEMO_SEED_ENABLED=false`). **Public demo** = `DEMO_MODE=true`
→ populated + badged.

## To ship NO demo content (clean tenant)

`OPENWOP_DEMO_MODE` already defaults off, so a fresh deploy auto-seeds nothing.
To also remove the explicit "Load demo data" capability, set — no code edit, no
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
