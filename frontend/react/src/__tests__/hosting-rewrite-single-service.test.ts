import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * check-hosting-wire-rewrites (4): every Cloud Run rewrite names ONE target.
 *
 * MEASURED 2026-10-25 on a white-label sync: an adopter's firebase.json renames
 * every serviceId to its own service, and the sync auto-merged two new upstream
 * rewrites still naming `openwop-app-backend`. Every other assertion in the check
 * passed; Firebase refused the release at finalize, after the backend had shipped.
 *
 * The fixture is the REAL firebase.json with one rewrite retargeted, so the case
 * stays production-shaped as rewrites are added. The fixture lives in a temp dir
 * with no schemas/ or features/, so the script would exit 1 there for an unrelated
 * reason (no path manifest) if (4) were gone. The test therefore asserts (4)'s
 * MESSAGE and the offending source, not only the exit code.
 *
 * Sabotage (witnessed): delete the (4) block → both red cases fail (the exit is
 * still 1, but from the manifest read, and the message assertions catch it);
 * compare serviceId only → the region case fails.
 */
const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = resolve(__dirname, '../../scripts/check-hosting-wire-rewrites.cjs');

type Rewrite = { source?: string; run?: { serviceId?: string; region?: string } };
const real = JSON.parse(readFileSync(resolve(ROOT, 'firebase.json'), 'utf8')) as { hosting: { rewrites: Rewrite[] } };

function runWith(mutate: (rewrites: Rewrite[]) => string) {
  const cfg = structuredClone(real);
  const source = mutate(cfg.hosting.rewrites);
  const dir = mkdtempSync(join(tmpdir(), 'hosting-rewrites-'));
  const fb = join(dir, 'firebase.json');
  writeFileSync(fb, JSON.stringify(cfg, null, 2));
  const r = spawnSync(process.execPath, [SCRIPT, fb], { encoding: 'utf8' });
  return { source, status: r.status, stderr: r.stderr };
}

describe('check-hosting-wire-rewrites — one Cloud Run target', () => {
  it('the real firebase.json passes, so the red cases below are about the mutation', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('one rewrite naming another serviceId fails and names that source', () => {
    const { source, status, stderr } = runWith((rws) => {
      const rw = rws.filter((x) => x.run)[3]!;
      rw.run!.serviceId = 'some-other-backend';
      return rw.source!;
    });
    expect(status).toBe(1);
    expect(stderr).toContain('Cloud Run rewrites name 2 different targets');
    expect(stderr).toMatch(/1 rewrite\(s\) → some-other-backend @ /);
    expect(stderr).toContain(`      ${source}`);
  });

  it('a different region alone is a different target too', () => {
    const { source, status, stderr } = runWith((rws) => {
      const rw = rws.filter((x) => x.run)[5]!;
      rw.run!.region = 'europe-west1';
      return rw.source!;
    });
    expect(status).toBe(1);
    expect(stderr).toMatch(/1 rewrite\(s\) → \S+ @ europe-west1:/);
    expect(stderr).toContain(`      ${source}`);
  });
});
