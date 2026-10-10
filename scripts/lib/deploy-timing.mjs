#!/usr/bin/env node
/**
 * Pure helpers for scripts/deploy.sh (ADR 0802). No network, no clock of their
 * own: everything is passed in, so scripts/test-deploy-gates.sh can drive them.
 *
 *   node scripts/lib/deploy-timing.mjs hour-wait <epochSeconds> [leadSeconds]
 *       → seconds to wait before starting the backend build (0 = go now)
 *   node scripts/lib/deploy-timing.mjs previous-serving <createdRevision> < service.json
 *       → the revision that held traffic before this deploy, or nothing
 */
import { readFileSync } from 'node:fs';
import { isEntryModule } from './entry-module.mjs';

/** Minutes before the hour, and after it, in which a new instance must not BOOT. */
export const QUIET_BEFORE_MIN = 10;
export const QUIET_AFTER_MIN = 15;
/** How long after `gcloud run deploy --source` starts the new instance boots. */
export const DEFAULT_BOOT_LEAD_S = 8 * 60;

/**
 * Seconds to wait so that a build started then boots OUTSIDE the top-of-hour
 * window. MEASURED 2026-10-02: at the top of every wall-clock hour the schedule
 * daemon fires its hourly jobs and the 4-connection pool queues (449 callers at
 * 18:00Z; ~10 minutes of 0.5 s reads on one instance). A boot adds its own
 * burst and, until the previous revision's instance is gone, a second copy of
 * every daemon. The two must not land together.
 */
export function hourWindowWaitSeconds(nowEpochS, leadS = DEFAULT_BOOT_LEAD_S) {
  const bootAt = nowEpochS + leadS;
  const intoHour = ((bootAt % 3600) + 3600) % 3600;
  const before = QUIET_BEFORE_MIN * 60;
  const after = QUIET_AFTER_MIN * 60;
  if (intoHour >= 3600 - before) return 3600 - intoHour + after; // before the hour: past it, then past the window
  if (intoHour < after) return after - intoHour;                 // just after the hour
  return 0;
}

/**
 * The revision that served before this deploy: the one entry in
 * `status.traffic` with a positive percent that is not the revision just
 * created. Returns null when that is not exactly one untagged revision — a
 * split, a tag, or nothing readable is not something to delete on a guess.
 */
export function previousServingRevision(serviceDoc, createdRevision) {
  const traffic = Array.isArray(serviceDoc?.status?.traffic) ? serviceDoc.status.traffic : [];
  const serving = traffic.filter((t) => Number(t?.percent) > 0 && typeof t?.revisionName === 'string');
  const tagged = new Set(traffic.filter((t) => typeof t?.tag === 'string' && t.tag !== '').map((t) => t.revisionName));
  const others = serving.filter((t) => t.revisionName !== createdRevision);
  if (others.length !== 1) return null;
  const name = others[0].revisionName;
  return tagged.has(name) ? null : name;
}

if (isEntryModule(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'hour-wait') {
    const now = Number(a);
    if (!Number.isFinite(now)) { console.error('hour-wait: epoch seconds required'); process.exit(2); }
    process.stdout.write(String(hourWindowWaitSeconds(now, b === undefined ? DEFAULT_BOOT_LEAD_S : Number(b))));
  } else if (cmd === 'previous-serving') {
    let doc;
    try { doc = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
    const prev = previousServingRevision(doc, a ?? '');
    if (prev) process.stdout.write(prev);
  } else {
    console.error('usage: deploy-timing.mjs hour-wait <epochS> [leadS] | previous-serving <created> < service.json');
    process.exit(2);
  }
}
