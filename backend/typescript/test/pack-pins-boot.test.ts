/**
 * ADR 0919 correction — a `createApp()` boot reads NO pack pin.
 *
 * ADR 0919 moved pins into `features/packPins.ts` so a pin bump would stop
 * re-running every boot. P2 measured it did not: `createApp()` (not only
 * `main()`) called `ensureRegistryPacksInstalled(featurePackRefs())`, which
 * resolved every pin, so 1,165 of 1,567 footprints executed `pinnedPackRef`.
 * The installer now takes names and resolves a pin only for a pack absent on
 * disk. This is the witness: a boot with its packs present resolves zero pins.
 * Sabotage (run by hand, recorded in ADR 0919): restoring
 * `featurePackRefs()` at the call site reds this case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { featurePackNames } from '../src/features/index.js';
import { pinResolutionCount } from '../src/features/packPins.js';
import { resolveDefaultPackDir } from '../src/packs/registryInstaller.js';

let server: Server | undefined;
let before = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  before = pinResolutionCount();
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}, 60_000);
afterAll(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); });

describe('ADR 0919 correction — boot does not depend on any pin', () => {
  it('a createApp() boot resolves zero pins when its required packs are on disk', () => {
    const dir = resolveDefaultPackDir();
    const absent = featurePackNames().filter((n) => !existsSync(join(dir, n)));
    // Only an ABSENT pack may resolve its pin (the installer must know what to fetch).
    expect(pinResolutionCount() - before, `pins resolved at boot; packs absent from ${dir}: ${absent.join(', ') || 'none'}`).toBe(absent.length);
    expect(absent, 'control: the test pack dir carries every required pack, so the count above is 0').toEqual([]);
  });
});
