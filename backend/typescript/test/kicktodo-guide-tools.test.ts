/**
 * ADR 0442 Guide wave — KickBot's added grounding reads fail EMPTY without an
 * acting human principal (the vuln-scan posture the today/progress/circles tools
 * already hold: a scheduled/system turn must never enumerate a participant's
 * journal, forward plan, or coach proposals). This pins that contract for the
 * three NEW self-scoped reads + their registration, so a later change can't
 * silently turn one into a system-readable surface.
 *
 * (Engagement standing + awards ride the chat-first-port `engagement-summary`
 * tool — the Guide wave deliberately adds no separate achievements/leaderboard
 * tool, so those aren't retested here.)
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn } from '../src/features/kicktodo-core/todayService.js';

const TENANT = 'default';

const JOURNAL = 'openwop:kicktodo.journal';
const PLAN = 'openwop:kicktodo.plan';
const PROPOSALS = 'openwop:kicktodo.proposals';

/** A REAL participant with data — so "a system turn reads NOTHING" is not just
 *  an empty tenant, and the 31-day cap has something a wider window would return. */
const PARTICIPANT = 'user:kt-guide';
const NOTE = 'tired today but did it';
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  const draft = await createDraft({
    tenantId: TENANT, title: 'Guide grounding', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'walk', day: 1, title: 'Morning walk', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(TENANT, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: TENANT, ownerSubject: PARTICIPANT, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  const card = (await todayFor(TENANT, PARTICIPANT)).enrollments.find((e) => e.enrollmentId === enrollment.id)?.actions[0]?.occurrence.cardId;
  if (!card) throw new Error('the day-1 action must be due today');
  await submitCheckIn(TENANT, PARTICIPANT, card, { note: NOTE });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function runTool(name: string, input: Record<string, unknown>, scope: { actingUserId?: string }): Promise<{ content: string; isError?: boolean }> {
  const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-guide', ...scope });
  return provider.executeTool({ name, input });
}

describe('ADR 0442 Guide wave — KickBot grounding reads register + fail empty', () => {
  // Twin: kicktodo-participant-lane-tools.test.ts "every KickBot read resolves"
  // (iterates KICKBOT_READ_TOOLS, which holds these three; both red under
  // w41g2-gt-register / -cover). Kept as this file's own registration pin.
  it('the new reads are registered host agent tools', () => {
    const ids = builtinAgentToolIds();
    for (const id of [JOURNAL, PLAN, PROPOSALS]) {
      expect(ids, `${id} must be a registered feature agent tool`).toContain(id);
    }
  });

  it('a system turn (no acting user) reads NOTHING from any of them', async () => {
    // Positive control: the SAME tools, for the participant, DO return their data —
    // so the empty results below are the refusal, not an empty tenant.
    const own = { actingUserId: PARTICIPANT };
    expect(JSON.stringify(JSON.parse((await runTool(JOURNAL, {}, own)).content))).toContain(NOTE);
    const ownPlan: { plan: unknown[] } = JSON.parse((await runTool(PLAN, {}, own)).content);
    expect(ownPlan.plan.length).toBeGreaterThan(0);
    // HONEST CEILING (double guard): each tool's `!scope.actingUserId` early return is
    // shadowed by the self-scoping read beneath it — journalFor/planFor/
    // listEnrollmentsFor filter `ownerSubject === actingUserId`, which matches no row
    // for `undefined`. Deleting the early return cannot change this output (round-1
    // probe w41g2-gt-journal-guard: vacuous). The guard that holds is the owner
    // filter in `listEnrollmentsFor` (enrollmentService.ts) — plus, for the journal,
    // journalFor's per-check-in `ownerSubject` re-check (a third copy). A probe on the
    // filter alone cannot reach this case while the early return still exists.
    expect(JSON.parse((await runTool(JOURNAL, {}, {})).content)).toEqual({ journal: [] });
    expect(JSON.parse((await runTool(PLAN, {}, {})).content)).toEqual({ plan: [] });
    expect(JSON.parse((await runTool(PROPOSALS, {}, {})).content)).toEqual({ proposals: [] });
  });

  it('a real participant with no data gets a valid EMPTY shape, never an error', async () => {
    const scope = { actingUserId: 'user:kt-nobody' };
    for (const [name, key] of [[JOURNAL, 'journal'], [PLAN, 'plan'], [PROPOSALS, 'proposals']] as const) {
      const r = await runTool(name, {}, scope);
      expect(r.isError, `${name} must not error for an empty participant`).toBeUndefined();
      expect(JSON.parse(r.content)).toEqual({ [key]: [] });
    }
  });

  it('the Plan read refuses a span wider than 31 days (bounded scan)', async () => {
    const now = Date.now();
    const scope = { actingUserId: PARTICIPANT };
    // Positive control: a ≤31-day window around today returns the participant's action…
    const inCap: { plan: unknown[] } = JSON.parse((await runTool(PLAN, { from: iso(now - 3 * DAY), to: iso(now + 14 * DAY) }, scope)).content);
    expect(inCap.plan.length).toBeGreaterThan(0);
    // …and a window that CONTAINS that same action but spans > 31 days returns nothing.
    const wide = await runTool(PLAN, { from: iso(now - 100 * DAY), to: iso(now + 100 * DAY) }, scope);
    expect(JSON.parse(wide.content)).toEqual({ plan: [] });
  });
});
