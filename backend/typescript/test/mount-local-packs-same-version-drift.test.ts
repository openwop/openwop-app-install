/**
 * WF-CMNT-10 — a pack edited WITHOUT a version bump is inert on a
 * registry-installing host, and nothing said so. This makes it SAY so.
 *
 * THE MECHANISM. The node-pack lane's only precedence rule is
 * `mountLocalPacks.shouldShadow` — `compareSemver(local, installed) > 0`, a
 * STRICT `>`. An EQUAL version leaves the registry-installed copy in place and
 * records the miss in `skipped`: no WARN, no content compare. Every pack is born
 * at 1.0.0, so the common case is exactly this one, and a host that never
 * received a fix looks identical to one that did.
 *
 * ── WHAT THIS DOES AND DOES NOT CLAIM (read before changing an arm) ──
 *
 * The remedy here is a DIAGNOSTIC, deliberately. `driftDetected` reports; nothing
 * is shadowed, renamed, or deleted on drift. An earlier draft of this change DID
 * shadow — parking the signed registry install and symlinking the repo copy over
 * it — and that was withdrawn before merge for three separate reasons, each
 * sufficient on its own:
 *
 *  1. It downgrades trust and can KILL a working pack. The parked dir is
 *     `operator-trusted` (Ed25519 + SRI, re-verified on every load); the symlink
 *     replacing it is `steward` only if `packs/.steward-manifest.json` carries a
 *     matching digest, else `untrusted` → NOT dispatchable (ADR 0555 P0,
 *     `host/packTrust.ts`). Someone who forgot a version bump has almost
 *     certainly not regenerated that manifest either, so the pack goes from
 *     STALE to DEAD — and the parked dir is invisible to every scanner
 *     (`isParkedPackDirName`).
 *  2. `scripts/check-pack-version-bump.mjs`, run from `scripts/ci.sh`, ALREADY
 *     refuses the merge on this exact mistake, fail-closed and repo-wide. A boot
 *     WARN cannot refuse anything and must not pose as the enforcement.
 *  3. It was not needed by its own motivating change: `feature.comments.nodes`
 *     bumped 1.0.0 → 1.1.0, which `shouldShadow` already handles.
 *
 * ── REACHABILITY — DO NOT READ THE STRICT-REGISTRY ARM AS A GUARDRAIL ──
 *
 * `OPENWOP_STRICT_REGISTRY=true` IS THE PRODUCTION CONFIGURATION (DEPLOY.md).
 * The last arm below is not a safety rail protecting an exotic mode; it pins the
 * behaviour of the deployed host. And the honest statement is stronger still:
 * this whole branch requires `dest` to ALREADY EXIST, mount runs BEFORE the
 * registry installer (`index.ts`), so on a fresh Cloud Run container the pack dir
 * is empty and NONE of this fires — with or without the flag.
 *
 * So the population this serves is hosts with a PERSISTENT pack dir: dev boxes,
 * and self-hosted white-label operators on a volume. For production the cure is
 * unchanged and lives elsewhere — republish to the registry and advance the pin
 * (DEPLOY.md § "Vendoring a pack is NOT shipping it"). The WARN is un-gated from
 * `preferLocal` so that a strict-mode host with a persistent dir still gets the
 * diagnostic, which is where it is most informative.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalPacksMounted } from '../src/bootstrap/mountLocalPacks.js';

const made: string[] = [];
const savedEnv = {
  local: process.env.OPENWOP_LOCAL_PACKS_DIR,
  dest: process.env.OPENWOP_PACK_DIR,
  strict: process.env.OPENWOP_STRICT_REGISTRY,
};

function mount(localDir: string, destDir: string) {
  process.env.OPENWOP_LOCAL_PACKS_DIR = localDir;
  process.env.OPENWOP_PACK_DIR = destDir;
  return ensureLocalPacksMounted();
}

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedEnv.local === undefined) delete process.env.OPENWOP_LOCAL_PACKS_DIR;
  else process.env.OPENWOP_LOCAL_PACKS_DIR = savedEnv.local;
  if (savedEnv.dest === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = savedEnv.dest;
  if (savedEnv.strict === undefined) delete process.env.OPENWOP_STRICT_REGISTRY;
  else process.env.OPENWOP_STRICT_REGISTRY = savedEnv.strict;
});

const NAME = 'feature.driftprobe.nodes';

/** A local (repo) pack. `body` is the node source — the thing a fix changes. */
function localPack(root: string, version: string, body: string): string {
  const p = join(root, NAME);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'pack.json'), JSON.stringify({ name: NAME, version }));
  writeFileSync(join(p, 'index.mjs'), body);
  return p;
}

/** A REGISTRY-INSTALLED pack: a real directory carrying the install marker. */
function installedPack(destDir: string, version: string, body: string): string {
  const p = join(destDir, NAME);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'pack.json'), JSON.stringify({ name: NAME, version }));
  writeFileSync(join(p, 'index.mjs'), body);
  writeFileSync(join(p, '.openwop-installed.json'), JSON.stringify({ name: NAME, version }));
  return p;
}

const isSymlink = (p: string): boolean => lstatSync(p).isSymbolicLink();

describe('WF-CMNT-10 — same version, different content', () => {
  it('THE FIX: an edited pack at an UNCHANGED version is REPORTED, and the signed install keeps serving', () => {
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    localPack(local, '1.0.0', 'export const nodes = { fixed: 1 };\n');
    installedPack(dest, '1.0.0', 'export const nodes = { stale: 1 };\n');

    const r = mount(local, dest);

    // Before the fix this landed in `skipped` with no signal at all.
    expect(r.driftDetected).toContain(NAME);
    // BOTH HALVES. The diagnostic must not have become an action: the registry
    // copy is still a real directory serving its own bytes, and the trust marker
    // it carries is untouched. This is the arm that would redden if anyone
    // re-introduced the withdrawn shadow-on-drift behaviour.
    expect(r.shadowed).not.toContain(NAME);
    expect(isSymlink(join(dest, NAME)), 'the signed install must NOT be replaced by an unsigned symlink').toBe(false);
    expect(readFileSync(join(dest, NAME, 'index.mjs'), 'utf8')).toContain('stale');
    expect(readFileSync(join(dest, NAME, '.openwop-installed.json'), 'utf8')).toContain(NAME);
  });

  it('IDENTICAL content at the same version is untouched and SILENT (no false drift)', () => {
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    const body = 'export const nodes = { same: 1 };\n';
    localPack(local, '1.0.0', body);
    installedPack(dest, '1.0.0', body);

    const r = mount(local, dest);

    expect(r.driftDetected ?? []).not.toContain(NAME);
    expect(r.shadowed).not.toContain(NAME);
    expect(r.skipped).toContain(NAME);
    expect(isSymlink(join(dest, NAME))).toBe(false);
  });

  it('the registry’s own bookkeeping file is NOT drift (it exists on one side only)', () => {
    // Without excluding `.openwop-installed.json` every pack on every host would
    // report drift, and the WARN would be worthless from the day it shipped.
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    const body = 'export const nodes = { same: 1 };\n';
    localPack(local, '2.3.4', body);
    installedPack(dest, '2.3.4', body);
    expect((mount(local, dest).driftDetected ?? [])).not.toContain(NAME);
  });

  it('INCIDENTAL working-tree files are NOT drift — the repo side is a working tree, not a tarball', () => {
    // The predicate's only exclusion used to be `.openwop*`, so any file the repo
    // accumulated that the published tarball does not carry read as "somebody
    // edited this pack". A WARN that fires on every machine with a Finder-opened
    // pack folder trains people to ignore the real one.
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    const body = 'export const nodes = { same: 1 };\n';
    const p = localPack(local, '1.0.0', body);
    installedPack(dest, '1.0.0', body);
    writeFileSync(join(p, '.DS_Store'), 'finder junk');
    writeFileSync(join(p, '.pack.json.swp'), 'vim swapfile');
    writeFileSync(join(p, 'index.mjs~'), 'editor backup');
    writeFileSync(join(p, 'build.log'), 'noise');

    expect((mount(local, dest).driftDetected ?? []), 'incidental files must not read as a forgotten version bump').not.toContain(NAME);
  });

  it('a REAL content edit is still caught alongside incidental files (the exclusion is not a blanket)', () => {
    // The guard against over-correcting the arm above into blindness: with the
    // SAME junk present, a genuine change to shipped source must still report.
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    const p = localPack(local, '1.0.0', 'export const nodes = { fixed: 1 };\n');
    installedPack(dest, '1.0.0', 'export const nodes = { stale: 1 };\n');
    writeFileSync(join(p, '.DS_Store'), 'finder junk');
    writeFileSync(join(p, 'index.mjs~'), 'editor backup');

    expect((mount(local, dest).driftDetected ?? [])).toContain(NAME);
  });

  it('a LOWER local version never shadows, drift or not', () => {
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    localPack(local, '1.0.0', 'export const nodes = { older: 1 };\n');
    installedPack(dest, '2.0.0', 'export const nodes = { newer: 1 };\n');

    const r = mount(local, dest);

    expect(r.shadowed).not.toContain(NAME);
    expect(r.driftDetected ?? []).not.toContain(NAME);
    expect(isSymlink(join(dest, NAME))).toBe(false);
  });

  it('a HIGHER local version still shadows, and is NOT reported as drift', () => {
    // The pre-existing `shouldShadow` behaviour, unchanged by this work — and the
    // path a forgotten bump is SUPPOSED to take once the author bumps.
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    localPack(local, '1.1.0', 'export const nodes = { fixed: 1 };\n');
    installedPack(dest, '1.0.0', 'export const nodes = { stale: 1 };\n');

    const r = mount(local, dest);

    expect(r.shadowed).toContain(NAME);
    expect(r.driftDetected ?? []).not.toContain(NAME);
  });

  it('under OPENWOP_STRICT_REGISTRY=true — THE PRODUCTION SETTING — the install still wins AND the drift is still reported', () => {
    // NOT a guardrail arm. `OPENWOP_STRICT_REGISTRY: "true"` is what the deployed
    // Cloud Run service sets (DEPLOY.md), so this pins production behaviour.
    //
    // Two claims, and the second is the change: the signed install keeps serving
    // (unchanged, and correct), and the DIAGNOSTIC is no longer suppressed by the
    // flag. Gating the WARN on `preferLocal` silenced it precisely on the hosts
    // that run the registry copy — the ones where "the repo says X, the host runs
    // Y" is the whole question.
    //
    // Reachability, stated so nobody mistakes this for production coverage: this
    // branch needs `dest` to exist, and a fresh Cloud Run container's pack dir is
    // empty (mount runs BEFORE the installer). What this arm actually protects is
    // a strict-mode host with a PERSISTENT pack dir — a dev box, or a self-hosted
    // operator on a volume.
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    localPack(local, '1.0.0', 'export const nodes = { local: 1 };\n');
    installedPack(dest, '1.0.0', 'export const nodes = { registry: 1 };\n');
    process.env.OPENWOP_STRICT_REGISTRY = 'true';

    const r = mount(local, dest);

    expect(r.shadowed).not.toContain(NAME);
    expect(isSymlink(join(dest, NAME))).toBe(false);
    expect(readFileSync(join(dest, NAME, 'index.mjs'), 'utf8')).toContain('registry');
    expect(r.driftDetected, 'the diagnostic must NOT be gated on preferLocal').toContain(NAME);
  });

  it('strict mode still blocks the version-based shadow (the flag’s actual job)', () => {
    const local = tmp('drift-local-');
    const dest = tmp('drift-dest-');
    localPack(local, '2.0.0', 'export const nodes = { local: 1 };\n');
    installedPack(dest, '1.0.0', 'export const nodes = { registry: 1 };\n');
    process.env.OPENWOP_STRICT_REGISTRY = 'true';

    const r = mount(local, dest);

    expect(r.shadowed).not.toContain(NAME);
    expect(isSymlink(join(dest, NAME))).toBe(false);
  });
});
