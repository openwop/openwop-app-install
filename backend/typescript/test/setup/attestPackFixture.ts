/**
 * Make a synthetic pack fixture loadable under the ADR 0555 P0 trust policy.
 *
 * Since P0, executable packs must be attested before the loaders will import
 * their code or register their agents. Vendored packs are attested by
 * `packs/.steward-manifest.json`; registry installs are attested by their
 * `.openwop-installed.json` marker. A pack a test writes into a temp dir is
 * neither, so it classifies `untrusted` and — correctly — does not load.
 *
 * This helper writes a REAL install marker over the fixture's real bytes, so
 * the pack classifies `operator-trusted` through the ordinary code path. It
 * does not bypass, stub, or relax anything: `verifyContentHashes()` still runs
 * and still fails if the fixture is mutated afterwards.
 *
 * Deliberately NOT provided: a way to force a tier, and any use of
 * `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED`. The break-glass disables the policy for
 * the whole process, so a test that reached for it would quietly void the trust
 * assertions of every later file in the same vitest worker — the failure shape
 * `test/setup/isolatePackDir.ts` exists to prevent for OPENWOP_PACK_DIR.
 *
 * Call it AFTER the fixture's files are final. Mutating a file afterwards is a
 * legitimate thing to test (it should then classify untrusted), but if you did
 * not mean to, the symptom is a pack that stops loading.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const MARKER = '.openwop-installed.json';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every regular file under `dir`, relative-pathed, excluding the marker. */
function walk(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === MARKER || name === 'node_modules' || name === '.git') continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else if (st.isFile()) out.push(relative(base, abs));
  }
}

/**
 * Write a valid install marker over a pack fixture so it classifies
 * `operator-trusted`.
 *
 * Hashes EVERY file, not just `pack.json` + `index.mjs` the way the real
 * installer does. That makes fixtures strictly stricter than production, which
 * is the right direction for a test helper: a fixture that mutates an auxiliary
 * module will correctly stop being trusted here.
 */
export function attestPackDir(packDir: string): void {
  if (!existsSync(join(packDir, 'pack.json'))) {
    throw new Error(`attestPackDir: ${packDir} has no pack.json — not a pack fixture`);
  }
  const files: string[] = [];
  walk(packDir, packDir, files);

  const manifest = JSON.parse(readFileSync(join(packDir, 'pack.json'), 'utf-8')) as {
    name?: string;
    version?: string;
  };

  const contentHashes: Record<string, string> = {};
  for (const rel of files.sort()) contentHashes[rel] = sha256(join(packDir, rel));

  writeFileSync(
    join(packDir, MARKER),
    JSON.stringify(
      {
        name: manifest.name ?? 'test.fixture',
        version: manifest.version ?? '0.0.0',
        integrity: 'sha256-test-fixture',
        publicKeyRef: 'test-fixture-key',
        registry: 'https://packs.invalid.test',
        installedAt: new Date(0).toISOString(),
        contentHashes,
      },
      null,
      2,
    ),
  );
}
