/**
 * ADR 0555 P2 — the two things that are only true IN THE DEPLOYED IMAGE, and
 * are therefore invisible to every other test in this repo.
 *
 * Everything else about this adapter is proved by running it. These two cannot
 * be, and both fail in the same direction — silently, on production only, with
 * a green suite:
 *
 *   1. **The worker artifact has to be IN the image.** Vitest never uses the
 *      built lane (there is no `lib/` during a test run), so a Dockerfile that
 *      stopped copying `lib/`, or a build that stopped emitting the worker,
 *      would leave untrusted packs undispatchable in production while every
 *      local gate stayed green. Being REFUSED rather than mis-executed is the
 *      right failure — but discovering it in production is not.
 *   2. **The memory arithmetic has to fit the instance.** `DEPLOY.md` runs
 *      Cloud Run at `--memory=512Mi --cpu=1`. N isolate heaps are charged to
 *      the CONTAINER, so an over-budget configuration OOM-kills the host rather
 *      than the pack — and no test on a 32GB laptop can notice. This caught a
 *      real one: P2 first shipped `4 × 128MB = 512MB`, the entire instance,
 *      with nothing left for the process doing the spawning.
 *
 * The Dockerfile is read as TEXT, the `pack-trust-config.test.ts` precedent: the
 * artifact it describes is not built here, so the claim is pinned at its source.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkIsolationMemoryBudget,
  isolationMemoryBudgetMb,
  logIsolationMemoryBudgetAtBoot,
  maxConcurrentIsolates,
  maxOldSpaceMb,
} from '../src/host/isolation/childProcessAdapter.js';
import { __resetWorkerEntryForTests, resolveWorkerEntry } from '../src/host/isolation/workerEntry.js';
import { ISOLATION_ADAPTER_UNAVAILABLE_CODE, ISOLATION_BUDGET_UNSAFE_CODE } from '../src/host/packWorkerContract.js';
import { runProbe, writeProbePack } from './support/isolatedPack.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf-8');

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENWOP_PACK_ISOLATION_WORKER;
  delete process.env.OPENWOP_PACK_ISOLATION_MAX_CONCURRENT;
  delete process.env.OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB;
  delete process.env.OPENWOP_PACK_ISOLATION_MEMORY_BUDGET_MB;
  __resetWorkerEntryForTests();
});

/* ── 1. the image ─────────────────────────────────────────────────────────── */

describe('the production IMAGE ships the isolation worker', () => {
  it("the runtime stage copies the builder's `lib/`, which is where the worker is emitted", () => {
    // `scripts/build.mjs` writes `lib/packIsolationWorker.mjs` (pinned by
    // `pack-isolation-build-wiring.test.ts`). This is the other half: that the
    // directory it lands in actually reaches the runtime image.
    expect(dockerfile).toMatch(/COPY --from=builder \/app\/lib \.\/lib/);
  });

  it('the runtime stage installs PRODUCTION deps only — so the dev lane cannot be what production uses', () => {
    // `--omit=dev` is why esbuild is absent at runtime, and therefore why the
    // on-demand bundling lane is unreachable in production. If this ever became
    // a full install, a missing build artifact would be silently papered over by
    // the dev lane and the pin above would stop meaning anything.
    expect(dockerfile).toMatch(/npm ci --omit=dev/);
  });

  it('the builder stage has the sources and scripts the worker build needs', () => {
    // The worker entry lives under `src/`, and the shared esbuild options under
    // `scripts/lib/`. A build context missing either fails the image build
    // rather than shipping a worker-less `lib/`, but only if both are copied.
    expect(dockerfile).toMatch(/COPY backend\/typescript\/src \.\/src/);
    expect(dockerfile).toMatch(/COPY backend\/typescript\/scripts \.\/scripts/);
  });
});

describe('a MISSING worker artifact refuses the dispatch — proved by deleting the file', () => {
  it('resolves an explicitly configured worker, then refuses once it is gone', async () => {
    // No mocking. The worker is copied to a temp dir, named explicitly, and then
    // DELETED — so the refusal comes from the real resolver observing a real
    // absent file, which is exactly the production failure being modelled.
    const built = await resolveWorkerEntry({});
    expect(built.ok, 'the dev lane must produce a worker for this test to mean anything').toBe(true);
    if (!built.ok) return;

    const dir = mkdtempSync(join(tmpdir(), 'owp-iso-imgtest-'));
    created.push(dir);
    const copy = join(dir, 'packIsolationWorker.mjs');
    copyFileSync(built.path, copy);

    // Present ⇒ resolved, and it is THE named file (so the env is really used).
    // Compared against the REALPATH, not the literal string: the resolver
    // deliberately resolves symlinks because the permission model matches on
    // real paths, and on macOS `/var` is itself a symlink to `/private/var`.
    process.env.OPENWOP_PACK_ISOLATION_WORKER = copy;
    const present = await resolveWorkerEntry();
    expect(present.ok).toBe(true);
    expect(present.ok && present.path).toBe(realpathSync(copy));

    // …and it really runs, so "refused" below cannot be "this path never worked".
    const pack = writeProbePack('return { status: "success", outputs: { ok: 1 } };');
    created.push(pack);
    const before = await runProbe(pack);
    expect(before.result.status, JSON.stringify(before.result)).toBe('success');

    // Absent ⇒ REFUSED. Not downgraded, not run in-process.
    rmSync(copy, { force: true });
    expect(existsSync(copy)).toBe(false);
    const gone = await resolveWorkerEntry();
    expect(gone.ok).toBe(false);
    expect(gone.ok === false && gone.reason).toContain(copy);

    const after = await runProbe(pack);
    expect(after.result.status).toBe('failure');
    expect(after.result.status === 'failure' && after.result.error.code).toBe(ISOLATION_ADAPTER_UNAVAILABLE_CODE);
    expect(after.reported, 'nothing may execute when the host cannot isolate').toEqual([]);
  }, 40_000);
});

/* ── 2. the memory budget ─────────────────────────────────────────────────── */

describe('the memory budget is checked, not left to the operator', () => {
  it('the SHIPPED defaults fit the documented instance', () => {
    // The regression guard for the real bug: 4 × 128 = 512MB was the entire
    // `--memory=512Mi` instance, leaving nothing for the host that spawns them.
    expect(maxConcurrentIsolates({})).toBe(2);
    expect(maxOldSpaceMb({})).toBe(96);
    expect(isolationMemoryBudgetMb({})).toBe(192);
    expect(maxConcurrentIsolates({}) * maxOldSpaceMb({})).toBeLessThanOrEqual(isolationMemoryBudgetMb({}));
    expect(checkIsolationMemoryBudget({}).ok).toBe(true);

    // And the budget must leave real room inside the deployed instance — a
    // budget that consumed all 512Mi would satisfy the check above while still
    // OOM-killing the container.
    expect(isolationMemoryBudgetMb({})).toBeLessThanOrEqual(256);
  });

  it('an over-budget configuration is caught, and says which knob to turn', () => {
    const check = checkIsolationMemoryBudget({
      OPENWOP_PACK_ISOLATION_MAX_CONCURRENT: '4',
      OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB: '128',
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain('512MB');
    expect(check.reason).toContain('192MB');
    // The consequence is named, because "over budget" alone reads as a tuning
    // nit rather than as a host-level outage.
    expect(check.reason).toContain('OOM-kills the CONTAINER');
    expect(check.reason).toContain('OPENWOP_PACK_ISOLATION_MAX_CONCURRENT');
  });

  it('raising the budget deliberately is what makes a bigger configuration legal', () => {
    expect(checkIsolationMemoryBudget({
      OPENWOP_PACK_ISOLATION_MAX_CONCURRENT: '4',
      OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB: '128',
      OPENWOP_PACK_ISOLATION_MEMORY_BUDGET_MB: '512',
    }).ok).toBe(true);
  });

  it('the BOOT report agrees with the dispatch check — one function, two callers', () => {
    // If these ever diverge, a host boots clean and then refuses every dispatch,
    // or logs a scary line and works fine. Both are worse than either answer.
    const over = { OPENWOP_PACK_ISOLATION_MAX_CONCURRENT: '8', OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB: '256' };
    expect(logIsolationMemoryBudgetAtBoot(over).ok).toBe(checkIsolationMemoryBudget(over).ok);
    expect(logIsolationMemoryBudgetAtBoot({}).ok).toBe(checkIsolationMemoryBudget({}).ok);
    expect(logIsolationMemoryBudgetAtBoot(over).ok).toBe(false);
  });

  it('an over-budget host REFUSES the dispatch rather than spawning anyway', async () => {
    // The behavioural half: the check is not merely reported, it is enforced on
    // the path that would otherwise spawn the isolates.
    process.env.OPENWOP_PACK_ISOLATION_MAX_CONCURRENT = '4';
    process.env.OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB = '128';
    const pack = writeProbePack('return { status: "success", outputs: {} };');
    created.push(pack);
    const run = await runProbe(pack);
    expect(run.result.status).toBe('failure');
    expect(run.result.status === 'failure' && run.result.error.code).toBe(ISOLATION_BUDGET_UNSAFE_CODE);
    expect(run.reported).toEqual([]);
  }, 40_000);
});
