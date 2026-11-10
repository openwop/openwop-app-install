/**
 * Build guard: a sign-in-gated production build must carry Firebase Auth
 * (incident: myndhyve.ai, 2026-11-07; fix #5651, resolve-only test #5678). The
 * myndhyve-prod API key lives in a gitignored
 * `.env.production.local`; a build from a checkout without it shipped
 * `isAuthConfigured() === false`, so every app route showed "Firebase Auth is
 * not configured" and nobody could sign in, until the next good build.
 *
 * Proven here:
 *   1. the guard lists exactly the variables `readConfigFromEnv` requires (read
 *      from its source, so the two cannot drift);
 *   2. it fires ONLY for gate `sign-in`, and a blank value counts as missing;
 *      `none` and `password` (white-label, adopter, demo) never fire;
 *   3. the message names the variables (its "never a value" half is held by the
 *      signature, which receives names only; case 4 is the real leak check);
 *   4. resolving the REAL vite.config.ts for a production build refuses a
 *      sign-in build with an empty API key, without echoing any configured value;
 *   5. the same resolve succeeds (exit 0) for a gate-less build with no Firebase
 *      at all. Neither case bundles: the guard runs inside defineConfig.
 *      The child gets no inherited `VITE_*` variable (Vite's loadEnv lets the
 *      process env override the env file), so a developer shell or CI that
 *      exports one cannot flip either case.
 *
 * Sabotage (each witnessed red): drop the gate-mode check (2, 5); drop `.trim()`
 * (2); drop a key from FIREBASE_ENV_KEYS (1, 2); stop naming the variables (3,
 * 4); print the env in vite.config.ts's error (4); delete the guard call in
 * vite.config.ts (4).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FIREBASE_ENV_KEYS, missingSignInFirebaseEnv, signInFirebaseEnvError } from '../firebaseEnvGuard.js';

const FE = join(__dirname, '..', '..', '..');
const ALL = { VITE_FIREBASE_API_KEY: 'k-123', VITE_FIREBASE_AUTH_DOMAIN: 'auth.example.test', VITE_FIREBASE_PROJECT_ID: 'proj-x' };

describe('firebaseEnvGuard', () => {
  it('1. guards exactly the variables readConfigFromEnv requires', () => {
    const src = readFileSync(join(FE, 'src', 'auth', 'firebase.ts'), 'utf8');
    const fn = src.slice(src.indexOf('function readConfigFromEnv'), src.indexOf('export function isAuthConfigured'));
    const read = [...fn.matchAll(/import\.meta\.env\.(VITE_FIREBASE_[A-Z_]+)/g)].map((m) => m[1]).sort();
    expect(read.length).toBeGreaterThan(0);
    expect([...FIREBASE_ENV_KEYS].sort()).toEqual(read);
  });

  it('2. fires only behind the sign-in gate; a blank value counts as missing', () => {
    expect(missingSignInFirebaseEnv({ ...ALL, VITE_FIREBASE_API_KEY: '' }, 'sign-in')).toEqual(['VITE_FIREBASE_API_KEY']);
    expect(missingSignInFirebaseEnv({ ...ALL, VITE_FIREBASE_PROJECT_ID: '   ' }, 'sign-in')).toEqual(['VITE_FIREBASE_PROJECT_ID']);
    expect(missingSignInFirebaseEnv({}, 'sign-in')).toEqual([...FIREBASE_ENV_KEYS]);
    expect(missingSignInFirebaseEnv(ALL, 'sign-in')).toEqual([]);
    expect(missingSignInFirebaseEnv({}, 'none')).toEqual([]);
    expect(missingSignInFirebaseEnv({}, 'password')).toEqual([]);
  });

  it('3. names the variables, never a value', () => {
    const msg = signInFirebaseEnvError(missingSignInFirebaseEnv({ ...ALL, VITE_FIREBASE_API_KEY: '' }, 'sign-in'));
    expect(msg).toContain('VITE_FIREBASE_API_KEY is not set');
    for (const v of Object.values(ALL)) expect(msg).not.toContain(v);
  });
});

// The guard throws inside vite.config.ts's defineConfig callback, so resolving
// the production build config is the whole claim: no bundle is needed. Until
// 2026-11-07 these cases spawned a real `vite build`, and case 5 let it bundle
// the whole app for up to 25 s before killing it. In a single-worker lane that
// child reached ~2.9 GiB RSS plus esbuild and tripped the runner's memory
// guard. Its assertions also held if the child died of OOM after printing
// "transforming", because nothing checked the exit.
const RESOLVED = 'fb-guard: build config resolved';
const RESOLVE_CHILD =
  "import { resolveConfig } from 'vite';\n" +
  "await resolveConfig({ mode: 'production', logLevel: 'silent' }, 'build');\n" +
  `console.log(${JSON.stringify(RESOLVED)});\n`;

/** The parent env without any `VITE_*` key: the env file is the only source. */
function childEnv(envDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITE_')) env[k] = v;
  env.OPENWOP_VITE_ENV_DIR = envDir;
  return env;
}

function resolveBuildConfig(envFile: string) {
  const envDir = mkdtempSync(join(tmpdir(), 'fb-guard-'));
  try {
    writeFileSync(join(envDir, '.env.production'), envFile);
    // cwd is frontend/react, so `vite` and vite.config.ts resolve from there.
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', RESOLVE_CHILD], {
      cwd: FE,
      env: childEnv(envDir),
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
}

describe('firebaseEnvGuard in the real Vite config', () => {
  it('4. refuses a sign-in build with an empty API key at config time, without echoing values', () => {
    const { status, out } = resolveBuildConfig(
      'VITE_OPENWOP_BASE_URL=https://api.example.test\nVITE_BRAND_APP_GATE_MODE=sign-in\n' +
        'VITE_FIREBASE_API_KEY=\nVITE_FIREBASE_AUTH_DOMAIN=guard-domain.example.test\nVITE_FIREBASE_PROJECT_ID=guard-project-x\n',
    );
    expect(status, out.slice(-2000)).not.toBe(0);
    expect(out).not.toContain(RESOLVED);
    expect(out).toContain('the app gate is "sign-in"');
    expect(out).toContain('VITE_FIREBASE_API_KEY is not set');
    expect(out).not.toContain('guard-domain.example.test');
    expect(out).not.toContain('guard-project-x');
  }, 90_000);

  it('5. resolves the build config for a gate-less build with no Firebase at all', () => {
    const { status, out } = resolveBuildConfig('VITE_OPENWOP_BASE_URL=https://api.example.test\nVITE_BRAND_APP_GATE_MODE=none\n');
    expect(status, out.slice(-2000)).toBe(0);
    expect(out).toContain(RESOLVED);
    expect(out).not.toContain('Production build aborted');
  }, 90_000);
});
