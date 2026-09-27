/**
 * `scripts/check-branding.sh` §5 (the instance-name check) — #3627 instance 3,
 * ADR 0630.
 *
 * Before: `grep -qiE 'Demo host' dist/assets/*.js`. Two defects, both pinned
 * here by their absence:
 *   - FALSE POSITIVE — it matched dev-tooling prose ("the demo host defaults it
 *     ON") on a build whose instance name WAS set. Fixture 1 carries exactly
 *     that prose and must pass.
 *   - INERT — `BRAND_DEFAULTS.instanceName` has been `OpenWOP` since #260, so
 *     an un-overridden build never contained `Demo host` and the check could
 *     not fire on the thing it existed to catch. Fixture 2 is an un-overridden
 *     build (per the resolved `brand-info.json`) and must FAIL.
 * A dist without `brand-info.json` must not silently pass either: it is not an
 * artifact of the current build, and a green on the wrong artifact is the
 * failure mode this script exists to prevent.
 *
 * Runs the REAL script as a child process against fixture dists. The shell
 * half is skipped (`OPENWOP_SKIP_SHELL_BRANDING=1`) — it scans repo files, not
 * the dist, and is not under test here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-branding.sh');

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'owp-branding-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

/** A fully re-branded dist (title, favicon, domain, manifest all custom) so
 *  that ONLY the instance-name verdict decides the exit code. */
function dist(brandInfo: object | null, jsBody = ''): string {
  const d = mkdtempSync(join(tmp, 'dist-'));
  mkdirSync(join(d, 'assets'));
  writeFileSync(join(d, 'index.html'), '<!doctype html><title>Acme Workspace</title><link rel="icon" href="/acme.svg">');
  writeFileSync(join(d, 'manifest.webmanifest'), JSON.stringify({ name: 'Acme', short_name: 'Acme' }));
  writeFileSync(join(d, 'assets', 'index-abc123.js'), jsBody);
  if (brandInfo) writeFileSync(join(d, 'brand-info.json'), JSON.stringify(brandInfo));
  return d;
}

function run(d: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT, d], {
      cwd: ROOT,
      env: { ...process.env, OPENWOP_SKIP_SHELL_BRANDING: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const PROSE = 'toggle ON for your tenant (the demo host defaults it ON)","Superadmin (demo host: the anonymous session is)';

describe('check-branding §5 — the instance name is read from the resolved brand, not grepped', () => {
  it('a correctly branded build whose bundle carries "demo host" PROSE passes (the false positive is gone)', () => {
    const r = run(dist({ instanceName: 'Acme Workspace', isDefault: { instanceName: false } }, PROSE));
    expect(r.out).not.toContain('instance name');
    expect(r.code, r.out).toBe(0);
  });

  it('an un-overridden instance name FAILS even though no bundle string says so (the check is no longer inert)', () => {
    const r = run(dist({ instanceName: 'OpenWOP', isDefault: { instanceName: true } }, 'nothing to grep here'));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('sidebar instance name is still the stock default (set VITE_BRAND_INSTANCE_NAME)');
  });

  it('a dist without brand-info.json is a hard error, not a pass', () => {
    const r = run(dist(null));
    expect(r.code).toBe(2);
    expect(r.out).toContain('brand-info.json not found');
  });
});
