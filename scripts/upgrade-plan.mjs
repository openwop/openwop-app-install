#!/usr/bin/env node
/**
 * Upgrade planner + release-manifest validator (ADR 0052 §D2 / §D2a; gap-closure
 * plan section 01, S01-R2 / witness S01-T2).
 *
 * `releases.json` carries two DIFFERENT upgrade constraints, and before §D2a it
 * could only say one of them:
 *
 *   - `requiredStop` — you must INSTALL this version before going past it
 *     (a skip-version upgrade lands here first).
 *   - `rollingSafe` — whether the previous release's binary may keep running
 *     against this release's migrated schema. When false, every old instance
 *     stops before the first new one starts, and that holds even when an
 *     upgrade skips straight past this version, because its migrations still
 *     replay on boot.
 *
 * v0.2.0 is the case that forced the split: it renames an `invocation_log`
 * column, its notes said "stop the 0.1.0 binary first", and the manifest said
 * `requiredStop: false` with nowhere to record the rest.
 *
 *   node scripts/upgrade-plan.mjs <from> [<to>]   # <to> defaults to `latest`
 *   node scripts/upgrade-plan.mjs <from> <to> --json
 *   node scripts/upgrade-plan.mjs --check         # validate releases.json only
 *
 * Exit 0 = plan printed (or manifest valid); 1 = invalid manifest; 2 = a plan
 * that cannot be made (unknown version, or a downgrade: ADR 0052 §D3 says roll
 * back by restoring the pre-upgrade backup, never by running an older binary).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} v */
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two X.Y.Z versions. @returns {number} */
export function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`not an X.Y.Z version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Notes that describe a non-rolling-safe release; a manifest that says this in
 *  prose while `rollingSafe` is true is the v0.2.0 contradiction. */
const ROLLING_UNSAFE_PROSE = /not rolling-safe|stop the [\d.]+ binary/i;

/**
 * Validate the manifest. Returns the list of problems (empty = valid).
 * @param {any} manifest
 * @returns {string[]}
 */
export function validateReleases(manifest) {
  const errs = [];
  const rels = manifest?.releases;
  if (!Array.isArray(rels) || rels.length === 0) return ['`releases` must be a non-empty array'];
  rels.forEach((r, i) => {
    const at = `releases[${i}] (${r?.version ?? '?'})`;
    if (typeof r?.version !== 'string' || !parse(r.version)) errs.push(`${at}: version must be X.Y.Z`);
    if (typeof r?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errs.push(`${at}: date must be YYYY-MM-DD`);
    if (typeof r?.requiredStop !== 'boolean') errs.push(`${at}: requiredStop must be boolean`);
    if (r?.requiredStop === true && !(typeof r.requiredStopReason === 'string' && r.requiredStopReason.trim())) errs.push(`${at}: a required stop needs requiredStopReason`);
    if (typeof r?.rollingSafe !== 'boolean') errs.push(`${at}: rollingSafe must be boolean (ADR 0052 §D2a)`);
    if (r?.rollingSafe === false && !(typeof r.rollingUnsafeReason === 'string' && r.rollingUnsafeReason.trim())) errs.push(`${at}: rollingSafe:false needs rollingUnsafeReason`);
    if (r?.rollingSafe === true && r.rollingUnsafeReason != null) errs.push(`${at}: rollingUnsafeReason is set but rollingSafe is true`);
    const sv = r?.schemaVersion;
    if (!Number.isInteger(sv?.sqlite) || !Number.isInteger(sv?.postgres)) errs.push(`${at}: schemaVersion.{sqlite,postgres} must be integers`);
    if (!Number.isInteger(r?.appMigrationVersion)) errs.push(`${at}: appMigrationVersion must be an integer`);
    if (!Array.isArray(r?.breakingConfig)) errs.push(`${at}: breakingConfig must be an array`);
    const prose = [...(Array.isArray(r?.breakingConfig) ? r.breakingConfig : []), r?.requiredStopReason ?? ''].join(' ');
    if (r?.rollingSafe === true && ROLLING_UNSAFE_PROSE.test(prose)) errs.push(`${at}: its notes say it is not rolling-safe, but rollingSafe is true`);
    const next = rels[i + 1];
    if (next && parse(r?.version ?? '') && parse(next.version ?? '')) {
      if (compareVersions(r.version, next.version) <= 0) errs.push(`${at}: releases must be strictly newest-first (${r.version} is not above ${next.version})`);
      if (r.date < next.date) errs.push(`${at}: date ${r.date} is before the older ${next.version}'s ${next.date}`);
      for (const k of ['sqlite', 'postgres']) {
        if (Number.isInteger(sv?.[k]) && Number.isInteger(next.schemaVersion?.[k]) && sv[k] < next.schemaVersion[k]) errs.push(`${at}: schemaVersion.${k} went backwards (${next.schemaVersion[k]} → ${sv[k]}); migrations are forward-only`);
      }
      if (Number.isInteger(r.appMigrationVersion) && Number.isInteger(next.appMigrationVersion) && r.appMigrationVersion < next.appMigrationVersion) errs.push(`${at}: appMigrationVersion went backwards`);
    }
  });
  if (manifest.latest !== rels[0]?.version) errs.push(`latest (${manifest.latest}) must equal the newest release (${rels[0]?.version})`);
  return errs;
}

/**
 * Plan an upgrade. Throws a PlanError for an impossible request.
 * @param {any} manifest
 * @param {string} from
 * @param {string} [to]
 */
export function planUpgrade(manifest, from, to = manifest.latest) {
  const rels = [...manifest.releases].sort((a, b) => compareVersions(a.version, b.version));
  const byVersion = new Map(rels.map((r) => [r.version, r]));
  if (!byVersion.has(from)) throw new PlanError(`unknown source version ${from}; known: ${rels.map((r) => r.version).join(', ')}`);
  if (!byVersion.has(to)) throw new PlanError(`unknown target version ${to}`);
  const cmp = compareVersions(to, from);
  if (cmp < 0) throw new PlanError(`${from} → ${to} is a downgrade. Migrations are forward-only (ADR 0052 §D3): restore the backup taken before the upgrade and redeploy ${to}'s image instead.`);
  if (cmp === 0) return { from, to, steps: [] };

  const crossed = rels.filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0);
  // Each hop ends at a required stop or at the target.
  const steps = [];
  let start = from;
  let batch = [];
  for (const r of crossed) {
    batch.push(r);
    if (r.requiredStop || r.version === to) {
      const unsafe = batch.filter((b) => !b.rollingSafe);
      const startRel = byVersion.get(start);
      steps.push({
        from: start,
        to: r.version,
        requiredStop: r.version !== to,
        requiredStopReason: r.version !== to ? r.requiredStopReason : null,
        // The old binary must be fully stopped when ANY crossed release is not
        // rolling-safe, even one this hop skips: its migrations replay on boot.
        stopOldBinary: unsafe.length > 0,
        stopOldBinaryBecause: unsafe.map((b) => `${b.version}: ${b.rollingUnsafeReason}`),
        backupFirst: true,
        schema: {
          sqlite: [startRel.schemaVersion.sqlite, r.schemaVersion.sqlite],
          postgres: [startRel.schemaVersion.postgres, r.schemaVersion.postgres],
          app: [startRel.appMigrationVersion, r.appMigrationVersion],
        },
        operatorActions: batch.flatMap((b) => b.breakingConfig.map((c) => `${b.version}: ${c}`)),
        releaseNotes: batch.map((b) => b.notes).filter(Boolean),
      });
      start = r.version;
      batch = [];
    }
  }
  return { from, to, steps };
}

export class PlanError extends Error {}

/** @param {ReturnType<typeof planUpgrade>} plan */
export function formatPlan(plan) {
  if (plan.steps.length === 0) return `Already on ${plan.to}; nothing to do.`;
  const out = [`Upgrade ${plan.from} → ${plan.to}: ${plan.steps.length} step(s).`];
  plan.steps.forEach((s, i) => {
    out.push('', `Step ${i + 1}: ${s.from} → ${s.to}${s.requiredStop ? `  (REQUIRED STOP: ${s.requiredStopReason})` : ''}`);
    out.push('  1. Back up the database (and object store) — rollback is a restore, not a downgrade.');
    out.push(s.stopOldBinary
      ? `  2. STOP every ${s.from} instance before starting ${s.to} — not rolling-safe:\n${s.stopOldBinaryBecause.map((b) => `       - ${b}`).join('\n')}`
      : `  2. The schema permits ${s.from} instances during ${s.to} migrations; complete any configuration and data-transition prerequisites below before deploying.`);
    // Breaking configuration can be a boot prerequisite (ADR 0981 P3). Apply
    // it after any required old-binary stop and before starting the new binary.
    if (s.operatorActions.length) out.push('  3. Configure the upgrade before starting the new version:', ...s.operatorActions.map((a) => `       - ${a}`));
    out.push(`  ${s.operatorActions.length ? 4 : 3}. Start ${s.to}. Migrations replay on boot: sqlite ${s.schema.sqlite.join(' → ')}, postgres ${s.schema.postgres.join(' → ')}, app ${s.schema.app.join(' → ')}.`);
    out.push(`  ${s.operatorActions.length ? 5 : 4}. Check /readiness reports version ${s.to}.`);
  });
  return out.join('\n');
}

export function readManifest(path = join(ROOT, 'releases.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (isEntryModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const manifest = readManifest();
  const errs = validateReleases(manifest);
  if (errs.length) {
    console.error(`releases.json is invalid (ADR 0052 §D2a):\n${errs.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  if (args.includes('--check')) {
    console.log(`releases.json OK (${manifest.releases.length} releases, latest ${manifest.latest}).`);
    process.exit(0);
  }
  const [from, to] = args.filter((a) => !a.startsWith('--'));
  if (!from) {
    console.error('usage: node scripts/upgrade-plan.mjs <from> [<to>] [--json] | --check');
    process.exit(2);
  }
  try {
    const plan = planUpgrade(manifest, from, to);
    console.log(args.includes('--json') ? JSON.stringify(plan, null, 2) : formatPlan(plan));
  } catch (e) {
    if (e instanceof PlanError) { console.error(e.message); process.exit(2); }
    throw e;
  }
}
