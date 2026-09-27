/**
 * ADR 0518 correction (2026-08-10) — the stamp that reads as fresh while stale.
 *
 * The original module enforced its honesty rule against the UNLIKELY failure (a
 * malformed stamp) and was blind to the LIKELY one (a well-formed stamp that
 * describes the PREVIOUS deploy). `OPENWOP_BUILD_COMMIT` is service config, and
 * a bare `gcloud run deploy` — correct, because passing no `--set-*` is what
 * preserves the live secret + env binding — preserves it. Measured live: rev
 * 00631 ran `e65ff6888` and `/api/readiness` reported `43b539ed2` with
 * `stamped: true`.
 *
 * These tests cover the precedence rule (pure) and the filesystem read (real
 * temp dirs) SEPARATELY, because the mechanism and its wiring fail
 * independently — the lesson of ADR 0502. A pure-logic test alone would pass
 * with the file read deleted entirely.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInfo, readImageCommit, resolveBuildProvenance } from '../src/host/buildInfo.js';

const IMAGE_SHA = 'e65ff6888e1eb6f72474f8606805873591f29091';
const STALE_ENV_SHA = '43b539ed226a4d12e3d58cb1cb4122406a7a08cc';

let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owp-build-meta-'));
  saved = {
    c: process.env.OPENWOP_BUILD_COMMIT,
    m: process.env.OPENWOP_BUILD_META_DIR,
  };
  delete process.env.OPENWOP_BUILD_COMMIT;
  process.env.OPENWOP_BUILD_META_DIR = dir;
});
afterEach(() => {
  if (saved.c === undefined) delete process.env.OPENWOP_BUILD_COMMIT; else process.env.OPENWOP_BUILD_COMMIT = saved.c;
  if (saved.m === undefined) delete process.env.OPENWOP_BUILD_META_DIR; else process.env.OPENWOP_BUILD_META_DIR = saved.m;
  rmSync(dir, { recursive: true, force: true });
});

const writeCommit = (v: string) => writeFileSync(join(dir, 'commit.txt'), v, 'utf8');

describe('resolveBuildProvenance — precedence (pure)', () => {
  it('THE REGRESSION: an image commit WINS over a stale env stamp', () => {
    // This is the 2026-08-10 incident, reproduced exactly. Before the fix the
    // env value was the only source and this reported the wrong commit while
    // claiming to be stamped.
    const r = resolveBuildProvenance(IMAGE_SHA, STALE_ENV_SHA);
    expect(r.commit).toBe(IMAGE_SHA);
    expect(r.commitSource).toBe('image');
    expect(r.commit).not.toBe(STALE_ENV_SHA);
  });

  it('reports `env` when only the deploy-time claim exists — a claim, not corroboration', () => {
    const r = resolveBuildProvenance(null, STALE_ENV_SHA);
    expect(r.commit).toBe(STALE_ENV_SHA);
    expect(r.commitSource).toBe('env');
  });

  it('reports `image` when only the artifact carries it', () => {
    expect(resolveBuildProvenance(IMAGE_SHA, undefined)).toEqual({
      commit: IMAGE_SHA,
      commitSource: 'image',
    });
  });

  it('is `unknown`/`none` when neither source has a value', () => {
    expect(resolveBuildProvenance(null, undefined)).toEqual({
      commit: 'unknown',
      commitSource: 'none',
    });
  });

  it('falls back to a valid env stamp when the IMAGE value is malformed', () => {
    // Shape-invalid image content must not shadow a usable env claim, nor be
    // echoed back. Degrading to `env` is strictly better than `unknown` here.
    const r = resolveBuildProvenance('not-a-sha', STALE_ENV_SHA);
    expect(r.commit).toBe(STALE_ENV_SHA);
    expect(r.commitSource).toBe('env');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a branch name', 'main'],
    ['an uninterpolated placeholder', '$COMMIT_SHA'],
    ['a SHA with trailing junk', `${IMAGE_SHA}-dirty`],
  ])('refuses %s from EITHER source rather than echoing it', (_label, value) => {
    expect(resolveBuildProvenance(value, value)).toEqual({
      commit: 'unknown',
      commitSource: 'none',
    });
  });
});

describe('readImageCommit — the filesystem half (real dirs)', () => {
  it('reads a SHA from commit.txt, tolerating the trailing newline the writer emits', () => {
    writeCommit(`${IMAGE_SHA}\n`);
    expect(readImageCommit(dir)).toBe(IMAGE_SHA);
  });

  it('returns null when the file is absent — the pre-change image, and a clean clone', () => {
    expect(readImageCommit(dir)).toBeNull();
  });

  it('returns null when the directory itself does not exist', () => {
    expect(readImageCommit(join(dir, 'nope'))).toBeNull();
  });

  it('returns null for malformed content rather than echoing it', () => {
    writeCommit('main\n');
    expect(readImageCommit(dir)).toBeNull();
  });

  it('returns null (never throws) when the path exists but cannot be read as a file', () => {
    // Uses a DIRECTORY named commit.txt, not `chmod 000`. The chmod version
    // passed for the WRONG REASON under root (CI and the Docker build both run
    // as uid 0, where the mode bit is ignored): readFileSync would SUCCEED and
    // a bare `not.toThrow()` would still be green, having never entered the
    // catch. EISDIR throws for every uid, so this exercises the real path.
    //
    // Asserting `toBeNull()` rather than `not.toThrow()` for the same reason —
    // "did not throw" is also satisfied by a function that returns garbage.
    mkdirSync(join(dir, 'commit.txt'));
    expect(readImageCommit(dir)).toBeNull();
  });
});

describe('buildInfo — wiring (mechanism + wiring tested separately, ADR 0502)', () => {
  it('surfaces the image commit end-to-end, overriding a stale env var', () => {
    writeCommit(`${IMAGE_SHA}\n`);
    process.env.OPENWOP_BUILD_COMMIT = STALE_ENV_SHA;
    const info = buildInfo();
    expect(info.commit).toBe(IMAGE_SHA);
    expect(info.commitSource).toBe('image');
    expect(info.stamped).toBe(true);
  });

  it('keeps `stamped` truthy for an env-only stamp — the field is UNCHANGED by design', () => {
    // verify-deploy.sh and operator scripts read `stamped`. Narrowing it to mean
    // "corroborated" would silently change what those callers are told. The new
    // distinction lives in `commitSource`, additively.
    process.env.OPENWOP_BUILD_COMMIT = STALE_ENV_SHA;
    const info = buildInfo();
    expect(info.stamped).toBe(true);
    expect(info.commitSource).toBe('env');
  });

  it('reports unknown/none/false when nothing is stamped at all', () => {
    const info = buildInfo();
    expect(info.commit).toBe('unknown');
    expect(info.commitSource).toBe('none');
    expect(info.stamped).toBe(false);
  });

  it('still exposes commit + stamped, so verify-deploy.sh keeps parsing', () => {
    // verify-deploy.sh greps `"commit"\s*:\s*"..."` out of the raw body. This
    // pins the field names it depends on; renaming them breaks our own gate.
    writeCommit(`${IMAGE_SHA}\n`);
    const info = buildInfo();
    expect(Object.keys(info)).toEqual(
      expect.arrayContaining(['commit', 'deployedAt', 'stamped', 'commitSource']),
    );
    expect(JSON.stringify(info)).toMatch(/"commit"\s*:\s*"[0-9a-f]{7,40}"/i);
  });
});
