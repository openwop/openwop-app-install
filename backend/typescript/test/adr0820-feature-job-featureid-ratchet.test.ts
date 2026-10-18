/**
 * ADR 0820 §7 / G6 — a FEATURE that registers a scheduler job must stamp the job
 * with its `featureId`, so the schedule daemon resolves that feature (toggle +
 * plan) at every fire and can auto-pause it when the plan lapses. Without the
 * stamp the job fires and fails on every tick after a lapse (the Gmail sync job
 * did exactly that).
 *
 * This ratchet scans every `registerJob({ … })` call under `src/features/**`. A
 * call whose object literal does not name `featureId` must be listed below with
 * a reason. A NEW unstamped call fails until it stamps or is classified here.
 * (A listed file that later starts stamping does NOT fail, so the list must be
 * SHRUNK by hand when one does: wave 35 removed the two scheduled-agent-chats
 * entries after ADR 0820 §8.2 stamped all three of their calls — while listed,
 * dropping one of those stamps stayed green.)
 *
 * Sabotage witnesses (w35): deleting `featureId` from the CRM Gmail sync job, from
 * `knowledgeSyncService` (an unlisted file — a NEW violator), or from a
 * scheduled-agent-chats follow-up job reds "every unstamped call is classified".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const FEATURES = join(SRC, 'features');

/** file (relative to src/) → [max unstamped calls, reason]. */
const UNSTAMPED_ALLOWED: Record<string, [number, string]> = {
  'features/assistant/loops.ts': [1, 'assistant is core (no toggle); its loops are gated by their own actor/connection checks'],
  'features/kb/kbService.ts': [1, 'kb is core; the reindex driver deliberately carries NO featureId (see its docblock)'],
  'features/goals/goalsService.ts': [1, 'goals is core (no toggle)'],
  'features/projects/projectScheduleService.ts': [1, 'projects is core (no toggle)'],
  'features/portability/portabilityService.ts': [1, 'an import restores a user schedule verbatim and DISABLED; user schedules carry no featureId'],
  'features/kicktodo-core/kickbotCoachTurnService.ts': [1, 'KickTodo distribution feature, not in a sellable bundle; its workflows gate per node'],
  'features/kicktodo-core/agentTools.ts': [1, 'KickTodo distribution feature, not in a sellable bundle'],
  'features/kicktodo-core/enrollmentService.ts': [1, 'KickTodo distribution feature, not in a sellable bundle'],
  'features/kicktodo-integrations/calendarSyncService.ts': [1, 'KickTodo distribution feature, not in a sellable bundle'],
  'features/kicktodo-accountability/sessionService.ts': [1, 'KickTodo distribution feature, not in a sellable bundle'],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...walk(p));
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** The `{ … }` argument of each `registerJob(` call, brace-matched, comments stripped. */
function registerJobArgs(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: string[] = [];
  const re = /\bregisterJob\s*\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let depth = 0;
    const start = m.index + m[0].length - 1;
    let i = start;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.push(code.slice(start, i + 1));
  }
  return out;
}

describe('ADR 0820 §7 / G6 — feature-registered scheduler jobs carry featureId', () => {
  const unstamped: Record<string, number> = {};
  let totalCalls = 0;
  for (const file of walk(FEATURES)) {
    const args = registerJobArgs(readFileSync(file, 'utf8'));
    totalCalls += args.length;
    const n = args.filter((a) => !/\bfeatureId\b/.test(a)).length;
    if (n > 0) unstamped[relative(SRC, file)] = n;
  }

  it('the scan sees the calls (cannot pass by finding nothing)', () => {
    expect(totalCalls).toBeGreaterThanOrEqual(15);
  });

  it('the CRM Gmail sync job is stamped', () => {
    expect(unstamped['features/crm/gmailSyncService.ts']).toBeUndefined();
  });

  it('every unstamped call is classified', () => {
    const offenders = Object.entries(unstamped)
      .filter(([f, n]) => !UNSTAMPED_ALLOWED[f] || n > UNSTAMPED_ALLOWED[f]![0])
      .map(([f, n]) => `${f}: ${n} unstamped registerJob call(s) — add featureId, or classify in UNSTAMPED_ALLOWED with a reason`);
    expect(offenders).toEqual([]);
  });
});
