/**
 * Offline / in-process demo-tenant seeder (ADR 0292, DG-SEED-6).
 *
 * Seeds a tenant WITHOUT the HTTP path — so it dodges the 30s request timeout
 * and the ~60s `/api` proxy budget that block the heavy seeders over the wire.
 * Boots just enough of the backend (host-ext persistence + the compiled toggle
 * defaults) and calls the same `runExampleDataSeed` the route uses.
 *
 * Usage (via tsx — handles the TS + JSON imports, like `npm run dev`):
 *   OPENWOP_STORAGE_DSN=<dsn> npm run seed:tenant -- --tenant <tenantId> [flags]
 *
 * Against prod, tunnel the DSN with cloud-sql-proxy first (see CLAUDE.md /
 * prod-superadmin memory) and point OPENWOP_STORAGE_DSN at 127.0.0.1.
 *
 * Flags:
 *   --tenant <id>     (required) the tenant to seed
 *   --dsn <dsn>       storage DSN (else OPENWOP_STORAGE_DSN; else memory:// = a no-op dry demo)
 *   --steps a,b,c     only these seeders (+ their dependsOn ancestors); default = all
 *   --provision       enable the demo feature toggles for this tenant first (DG-SEED-7)
 *   --dry-run         report what each step WOULD do; write nothing
 */

import { dirname, resolve as resolvePath } from 'node:path';
import { initHostExtPersistence } from '../host/hostExtPersistence.js';
import { openStorage } from '../storage/index.js';
import { initInMemorySurfaces } from '../host/inMemorySurfaces.js';
import { configureSecretResolver } from '../byok/secretResolver.js';
import { BACKEND_FEATURES } from '../features/index.js';
import { registerToggleDefault } from '../host/featureToggles/registry.js';
import { runExampleDataSeed } from '../host/exampleDataSeeders.js';
import { provisionDemoFeatures } from '../host/demoProvision.js';

interface Args {
  tenant?: string;
  dsn?: string;
  steps?: string[];
  provision: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { provision: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--dsn') args.dsn = argv[++i];
    else if (a === '--steps') args.steps = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--provision') args.provision = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant) {
    process.stderr.write('error: --tenant <tenantId> is required\n');
    process.exitCode = 2;
    return;
  }
  const dsn = args.dsn ?? process.env.OPENWOP_STORAGE_DSN ?? 'memory://';
  const tenantId = args.tenant;

  // Boot: enough of the app for every seeder to run — host-ext persistence, the
  // in-memory host surfaces (agents/advisors/merch build a surface bundle), the
  // BYOK secret resolver (ucp merchant), and the compiled toggle defaults (so
  // gated seeders resolve exactly as they do at app boot — no drift).
  const storage = await openStorage(dsn);
  const dataDir = dsn.startsWith('sqlite://')
    ? dirname(resolvePath(dsn.slice('sqlite://'.length)))
    : resolvePath('./data');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir });
  configureSecretResolver({ storage, dataDir });
  for (const feature of BACKEND_FEATURES) {
    if (feature.toggleDefault) registerToggleDefault(feature.toggleDefault);
  }

  process.stdout.write(`seeding tenant ${tenantId} via ${dsn.split('@').pop() ?? dsn}${args.dryRun ? ' (dry-run)' : ''}\n`);

  if (args.provision && !args.dryRun) {
    const p = await provisionDemoFeatures(tenantId, 'cli:seed-tenant');
    process.stdout.write(`provisioned: enabled ${p.enabled.length}, already-on ${p.alreadyOn.length}, unknown ${p.unknown.length}\n`);
  }

  const result = await runExampleDataSeed(tenantId, storage, {
    steps: args.steps,
    dryRun: args.dryRun,
    onStep: (r) => { process.stdout.write(`  ${r.step.padEnd(28)} ${r.action.padEnd(8)} ${r.message}\n`); },
  });

  const { created, skipped, errors, total } = result.summary;
  process.stdout.write(`done: ${created} created, ${skipped} skipped, ${errors} errors (${total} steps)\n`);
  process.exitCode = errors === 0 ? 0 : 1;
}

void main().catch((err) => {
  process.stderr.write(`seed-tenant failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
