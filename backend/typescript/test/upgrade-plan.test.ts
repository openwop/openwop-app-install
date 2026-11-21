/**
 * Upgrade planner + release-manifest validator (ADR 0052 §D2a; gap-closure plan
 * section 01, S01-R2 / witness S01-T2; audit OPS-02).
 *
 * The defect: v0.2.0 renames an `invocation_log` column, so a 0.1.0 process
 * sharing the upgraded database fails. Its notes said "stop the 0.1.0 binary
 * first", while `releases.json` said `requiredStop: false` and had no field for
 * the rest. An upgrade tool reading the manifest (what ADR 0052 §D2 says it is
 * for) would have offered a rolling 0.1 → 0.2 upgrade. Skipping straight to a
 * later version did not avoid it either: the rename still replays on boot.
 *
 * Proven here, on the REAL manifest and on fixtures:
 *   - the manifest validates, and the validator catches the exact contradiction
 *     (0.2.0 flipped back to rollingSafe:true goes red, naming 0.2.0);
 *   - EVERY supported source → target pair plans, with contiguous steps, each
 *     crossed release's operator actions exactly once, and a stop-the-old-binary
 *     step if and only if a crossed release is not rolling-safe;
 *   - a required stop splits a skip-version upgrade at that version;
 *   - a downgrade is refused with the restore instruction (§D3), not planned;
 *   - the CLI agrees with the library (exit codes and output).
 *
 * Sabotage-witnessed (8f W6): the rolling-safe prose check, the stop-old-binary
 * flag, the skip-past stop (a hop that only checks its own endpoint), the
 * required-stop split, the per-hop operator actions, the downgrade refusal, the
 * CLI's exit 2, and the requiredStopReason and newest-first rules each red a case.
 * Re-graded (wave 108, TST-8W6-1): the 0.1.0 case now derives the expected stop
 * reasons from releases.json (one per crossed not-rolling-safe release, so keeping only
 * the last one reds it), and the printed plan orders breaking configuration after the
 * backup and any old-binary stop and before the new binary starts (ADR 0981 P3;
 * printing it after the Start line reds both rows).
 * Re-graded (wave 118, TST-8W6-1): 0.14.0 is the first REQUIRED stop (ADR 1045
 * CHAN-F18, the last release with the legacy env-key id rewrite). An upgrade that
 * crosses it lands on it first, its step carries the requiredStop flag and reason,
 * and the printed plan says REQUIRED STOP; the 0.1.0 case counts one step per
 * required stop crossed (counted from releases.json, not from the planner). A
 * planner that ignores requiredStop, drops the flag or the reason, or a manifest
 * that clears 0.14.0's flag each red the 0.14.0 case.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  validateReleases,
  planUpgrade,
  formatPlan,
  readManifest,
  PlanError,
  type ReleaseEntry,
  type ReleaseManifest,
} from '../../../scripts/upgrade-plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'upgrade-plan.mjs');
const real = readManifest();
const clone = (): ReleaseManifest => JSON.parse(JSON.stringify(real)) as ReleaseManifest;

describe('the real releases.json', () => {
  it('validates', () => {
    expect(validateReleases(real)).toEqual([]);
  });

  it('records v0.2.0 as not rolling-safe, and flipping it back is caught', () => {
    const v020 = real.releases.find((r) => r.version === '0.2.0')!;
    expect(v020.rollingSafe).toBe(false);
    expect(v020.rollingUnsafeReason).toMatch(/invocation_log/);
    const m = clone();
    const r = m.releases.find((x) => x.version === '0.2.0')!;
    r.rollingSafe = true;
    r.rollingUnsafeReason = null;
    expect(validateReleases(m)).toEqual([expect.stringMatching(/0\.2\.0.*not rolling-safe, but rollingSafe is true/)]);
  });

  it('a 0.1.0 install must stop the old binary whether it lands on 0.2.0 or skips past it', () => {
    // One step per required stop crossed, plus the last hop (0.14.0 became the
    // first required stop at the 0.15.0 cut, CHAN-F18). The hop that crosses
    // 0.2.0 is the first, and it must stop the old binary.
    const stopsBefore = (to: string) => real.releases
      .filter((r) => r.requiredStop && compareVersions(r.version, '0.1.0') > 0 && compareVersions(r.version, to) < 0)
      .length;
    for (const to of ['0.2.0', real.latest]) {
      const plan = planUpgrade(real, '0.1.0', to);
      expect(plan.steps.length, to).toBe(stopsBefore(to) + 1);
      expect(plan.steps[0]!.stopOldBinary, to).toBe(true);
    }
    expect(planUpgrade(real, '0.1.0', '0.2.0').steps[0]!.stopOldBinaryBecause).toEqual([expect.stringMatching(/^0\.2\.0: /)]);
    // Skipping past 0.2.0 still carries its reason, beside one per later not-rolling-safe release crossed.
    const crossedUnsafe = real.releases
      .filter((r) => !r.rollingSafe && compareVersions(r.version, '0.1.0') > 0 && compareVersions(r.version, real.latest) <= 0)
      .map((r) => r.version)
      .sort(compareVersions);
    const because = planUpgrade(real, '0.1.0', real.latest).steps.flatMap((s) => s.stopOldBinaryBecause);
    expect(because.map((b) => b.split(':')[0]).sort(compareVersions)).toEqual(crossedUnsafe);
    expect(because).toEqual(expect.arrayContaining([expect.stringMatching(/^0\.2\.0: /)]));
    // From 0.2.0 on, the old binary must stop only when a later not-rolling-safe release is crossed.
    const after020 = real.releases.map((r) => r.version).filter((v) => compareVersions(v, '0.2.0') > 0).sort(compareVersions)[0]!;
    expect(planUpgrade(real, '0.2.0', after020).steps[0]!.stopOldBinary).toBe(false);
    expect(planUpgrade(real, '0.2.0').steps.some((s) => s.stopOldBinary)).toBe(crossedUnsafe.some((v) => v !== '0.2.0'));
  });

  it('every supported source → target pair plans completely', () => {
    const versions = real.releases.map((r) => r.version).sort(compareVersions);
    const byV = new Map(real.releases.map((r) => [r.version, r]));
    let pairs = 0;
    for (const from of versions) {
      for (const to of versions.filter((v) => compareVersions(v, from) > 0)) {
        pairs++;
        const plan = planUpgrade(real, from, to);
        const crossed = versions.filter((v) => compareVersions(v, from) > 0 && compareVersions(v, to) <= 0).map((v) => byV.get(v)!);
        // contiguous hops from → … → to
        expect(plan.steps[0]!.from).toBe(from);
        expect(plan.steps.at(-1)!.to).toBe(to);
        plan.steps.forEach((s, i) => { if (i > 0) expect(s.from).toBe(plan.steps[i - 1]!.to); });
        // every crossed release's actions, once each, nothing extra
        const want = crossed.flatMap((r) => r.breakingConfig.map((c) => `${r.version}: ${c}`));
        expect(plan.steps.flatMap((s) => s.operatorActions)).toEqual(want);
        // stop-old-binary iff a crossed release is not rolling-safe
        expect(plan.steps.some((s) => s.stopOldBinary), `${from}→${to}`).toBe(crossed.some((r) => !r.rollingSafe));
        // schema ranges run from the source's to the target's
        expect(plan.steps[0]!.schema.postgres[0]).toBe(byV.get(from)!.schemaVersion.postgres);
        expect(plan.steps.at(-1)!.schema.postgres[1]).toBe(byV.get(to)!.schemaVersion.postgres);
      }
    }
    expect(pairs).toBe((versions.length * (versions.length - 1)) / 2);
  });

  // ADR 1045 CHAN-F18 — 0.14.0 is the last release with the legacy env-key id
  // rewrite, so an upgrade that crosses it must land there. A synthetic release
  // one minor ABOVE `latest` goes on top of the REAL entries, so the case holds
  // whatever has shipped since (a literal 0.15.0 duplicated the real one at the
  // 0.15.0 cut and broke the newest-first rule).
  it('an upgrade crossing 0.14.0 lands on it first (the legacy bearer-id rewrite stop)', () => {
    const v0140 = real.releases.find((r) => r.version === '0.14.0')!;
    expect(v0140.requiredStop).toBe(true);
    expect(v0140.requiredStopReason).toMatch(/OPENWOP_LEGACY_BEARER_REWRITE/);
    const m = clone();
    const top = m.releases.find((r) => r.version === m.latest)!;
    const [maj, min] = top.version.split('.').map(Number) as [number, number];
    const target = `${maj}.${min + 1}.0`;
    m.releases.unshift({ ...top, version: target, date: '2099-01-01', requiredStop: false, requiredStopReason: null, breakingConfig: [], notes: '' });
    m.latest = target;
    expect(validateReleases(m)).toEqual([]);
    // Every release after 0.14.0 is a single hop from it unless it is itself a stop.
    const laterStops = m.releases
      .filter((r) => compareVersions(r.version, '0.14.0') > 0 && compareVersions(r.version, target) < 0 && r.requiredStop)
      .map((r) => r.version)
      .sort(compareVersions);
    for (const from of ['0.13.0', '0.1.0']) {
      const plan = planUpgrade(m, from, target);
      expect(plan.steps.map((s) => s.to), from).toEqual(['0.14.0', ...laterStops, target]);
      expect(plan.steps[0]!.requiredStop, from).toBe(true);
      expect(plan.steps[0]!.requiredStopReason, from).toMatch(/OPENWOP_LEGACY_BEARER_REWRITE/);
    }
    expect(formatPlan(planUpgrade(m, '0.13.0', target))).toMatch(/REQUIRED STOP: Last release with the one-time legacy env-key id rewrite/);
    // From 0.14.0 itself the legacy stop is behind it.
    expect(planUpgrade(m, '0.14.0', target).steps.map((s) => s.to)).toEqual([...laterStops, target]);
  });

  it('a downgrade or an unknown version is refused, not planned', () => {
    expect(() => planUpgrade(real, real.latest, '0.2.0')).toThrow(PlanError);
    expect(() => planUpgrade(real, real.latest, '0.2.0')).toThrow(/restore the backup/);
    expect(() => planUpgrade(real, '9.9.9')).toThrow(/unknown source version/);
    expect(planUpgrade(real, real.latest).steps).toEqual([]);
  });
});

describe('required stops and validation rules (fixtures)', () => {
  const rel = (version: string, over: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
    version, date: '2026-01-01', requiredStop: false, requiredStopReason: null, rollingSafe: true, rollingUnsafeReason: null,
    schemaVersion: { sqlite: 1, postgres: 1 }, appMigrationVersion: 0, breakingConfig: [], notes: '', ...over,
  });
  const manifest = (...rs: ReleaseEntry[]): ReleaseManifest => ({ latest: rs[0]!.version, releases: rs });

  it('a required stop splits a skip-version upgrade at that version', () => {
    const m = manifest(
      rel('1.3.0', { breakingConfig: ['C'] }),
      rel('1.2.0', { requiredStop: true, requiredStopReason: 'long backfill', breakingConfig: ['B'] }),
      rel('1.1.0', { breakingConfig: ['A'] }),
      rel('1.0.0'),
    );
    expect(validateReleases(m)).toEqual([]);
    const plan = planUpgrade(m, '1.0.0');
    expect(plan.steps.map((s) => [s.from, s.to, s.requiredStop])).toEqual([['1.0.0', '1.2.0', true], ['1.2.0', '1.3.0', false]]);
    expect(plan.steps.map((s) => s.operatorActions)).toEqual([['1.1.0: A', '1.2.0: B'], ['1.3.0: C']]);
  });

  // ADR 0981 P3 — breaking configuration can be a boot prerequisite, so the printed plan
  // must order it after the backup (and after the old-binary stop, when there is one) and
  // before the new binary starts. The order is read off the text the operator follows.
  it.each([
    [true, ['backup', 'configure', 'start']],
    [false, ['backup', 'stop', 'configure', 'start']],
  ] as const)('rollingSafe=%s: applies required startup configuration before starting the new binary', (rollingSafe, expected) => {
    const action = 'Set OPENWOP_AUTHORIZATION_ENFORCEMENT=true before starting';
    const m = manifest(
      rel('1.1.0', { breakingConfig: [action], rollingSafe, rollingUnsafeReason: rollingSafe ? null : 'schema rename' }),
      rel('1.0.0'),
    );
    const instructions = formatPlan(planUpgrade(m, '1.0.0'));
    const marks: Record<string, string> = {
      backup: 'Back up the database',
      stop: 'STOP every 1.0.0 instance',
      configure: action,
      start: 'Start 1.1.0.',
    };
    // Each marker printed once at most; the ones present, in printed order.
    for (const text of Object.values(marks)) expect(instructions.split(text).length, text).toBeLessThanOrEqual(2);
    const order = Object.keys(marks)
      .filter((k) => instructions.includes(marks[k]!))
      .sort((a, b) => instructions.indexOf(marks[a]!) - instructions.indexOf(marks[b]!));
    expect(order).toEqual(expected);
  });

  it('rejects the manifest shapes an upgrade tool could not trust', () => {
    expect(validateReleases(manifest(rel('1.1.0', { requiredStop: true }), rel('1.0.0')))).toEqual([expect.stringMatching(/requiredStopReason/)]);
    expect(validateReleases(manifest(rel('1.1.0', { rollingSafe: false }), rel('1.0.0')))).toEqual([expect.stringMatching(/rollingUnsafeReason/)]);
    expect(validateReleases(manifest(rel('1.0.0'), rel('1.1.0')))).toEqual([expect.stringMatching(/newest-first/)]);
    expect(validateReleases(manifest(rel('1.1.0', { schemaVersion: { sqlite: 1, postgres: 0 } }), rel('1.0.0')))).toEqual([expect.stringMatching(/postgres went backwards/)]);
    expect(validateReleases({ ...manifest(rel('1.1.0'), rel('1.0.0')), latest: '1.0.0' })).toEqual([expect.stringMatching(/latest/)]);
  });
});

describe('the CLI', () => {
  it('--check passes on the real tree; a plan prints the stop; a downgrade exits 2', () => {
    expect(execFileSync('node', [SCRIPT, '--check'], { encoding: 'utf8' })).toMatch(/releases\.json OK/);
    expect(execFileSync('node', [SCRIPT, '0.1.0'], { encoding: 'utf8' })).toMatch(/STOP every 0\.1\.0 instance/);
    const down = spawnSync('node', [SCRIPT, real.latest, '0.1.0'], { encoding: 'utf8' });
    expect(down.status).toBe(2);
    expect(down.stderr).toMatch(/downgrade/);
  });
});
