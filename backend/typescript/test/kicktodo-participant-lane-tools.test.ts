/**
 * chat-first-port G6/G7 — the engagement-summary + community-reviews READ tools.
 *
 * These close two chat-orphaned capabilities (surface-backed nodes existed, but
 * nodes are excluded from the chat tool projection). Boots the REAL app so the
 * `registerFeatureAgentTool` seam is live, then asserts:
 *  - both ids RESOLVE (present in `builtinAgentToolIds()`) — the CFP-1 guarantee;
 *  - toggle-off ⇒ typed `feature_disabled`;
 *  - no acting user ⇒ EMPTY (never another participant's data);
 *  - the happy path returns the closed projection (own view / moderated reviews).
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID } from '../src/features/kicktodo-engagement/agentTools.js';
import { KICKTODO_COMMUNITY_REVIEWS_TOOL_ID } from '../src/features/kicktodo-community/agentTools.js';
import { KICKBOT_READ_TOOLS } from '../src/features/kicktodo-core/kickbotService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll } from '../src/features/kicktodo-core/enrollmentService.js';
import { optIn } from '../src/features/kicktodo-engagement/engagementService.js';

const TENANT = 'default';

/** An enrolled, OPTED-IN participant — the positive control that makes the
 *  no-acting-user empty a refusal rather than an empty tenant. */
const ENGAGED = 'user:p-eng';

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const TOGGLES = ['kicktodo-engagement', 'kicktodo-community'] as const;

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  const draft = await createDraft({
    tenantId: TENANT, title: 'Lane tools', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(TENANT, draft.id, 1);
  await enroll({ tenantId: TENANT, ownerSubject: ENGAGED, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  await optIn(TENANT, ENGAGED, 'Engaged');
});
afterAll(async () => {
  // saveConfig is GLOBAL (not tenant-scoped): put both toggles back to their defaults.
  for (const id of TOGGLES) { const d = getToggleDefault(id); if (d) await saveConfig(d, 'test'); }
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const setToggle = async (id: (typeof TOGGLES)[number], status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`toggle ${id} must be declared`);
  await saveConfig({ ...d, status }, 'test');
};

interface EngagementSummary { optedIn: boolean; boards: Array<{ challengeId: string }>; awards: unknown[] }

function provider(scope: { actingUserId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('participant-lane read tools resolve + are on KickBot (G6/G7)', () => {
  // Twin: the next case (it iterates KICKBOT_READ_TOOLS, which holds both ids).
  // Kept as the explicit CFP-1 pin: these two ids by their OWNING features' exports.
  it('both ids are offerable to a model (present in builtinAgentToolIds)', () => {
    const ids = builtinAgentToolIds();
    expect(ids).toContain(KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID);
    expect(ids).toContain(KICKTODO_COMMUNITY_REVIEWS_TOOL_ID);
  });

  it('KickBot carries both reads AND every KickBot read resolves (no silent drop)', () => {
    const ids = new Set(builtinAgentToolIds());
    expect(KICKBOT_READ_TOOLS).toContain(KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID);
    expect(KICKBOT_READ_TOOLS).toContain(KICKTODO_COMMUNITY_REVIEWS_TOOL_ID);
    for (const t of KICKBOT_READ_TOOLS) expect(ids.has(t)).toBe(true);
  });
});

describe('engagement-summary tool (G6)', () => {
  it('feature_disabled when kicktodo-engagement is off', async () => {
    await setToggle('kicktodo-engagement', 'off');
    const out = await provider({ actingUserId: 'user:p-1' }).executeTool({ name: KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID, input: {} });
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
  });

  it('EMPTY (not another user\'s standing) without an acting user', async () => {
    await setToggle('kicktodo-engagement', 'on');
    // Positive control: the ENGAGED participant has real standing (opted in, on one board).
    const own: EngagementSummary = JSON.parse((await provider({ actingUserId: ENGAGED }).executeTool({ name: KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID, input: {} })).content);
    expect(own.optedIn).toBe(true);
    expect(own.boards).toHaveLength(1);
    const out = await provider().executeTool({ name: KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    // HONEST CEILING (double guard): the `!scope.actingUserId` early return is
    // shadowed by the self-scoped reads beneath it — myOptIn/listAwards are keyed by
    // the subject and listEnrollmentsFor filters `ownerSubject === actingUserId`, so
    // `undefined` reaches no row either way (round-1 probe w41g2-pl-eng-actor:
    // vacuous). The subject-keyed reads are the guard that holds.
    expect(JSON.parse(out.content)).toEqual({ optedIn: false, boards: [], awards: [] });
  });

  it('reads the acting user\'s own view when enabled (not opted in ⇒ honest empty)', async () => {
    await setToggle('kicktodo-engagement', 'on');
    const out = await provider({ actingUserId: 'user:p-1' }).executeTool({ name: KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    // ADR 0641 d13 — read from the opt-in ROW, so this stays false even though
    // `leaderboard()` no longer throws for an enrolled-but-not-opted-in caller.
    // user:p-1 holds no enrollment, so the honest view is fully empty.
    expect(JSON.parse(out.content)).toEqual({ optedIn: false, boards: [], awards: [] });
  });
});

describe('community-reviews tool (G7)', () => {
  it('feature_disabled when kicktodo-community is off', async () => {
    await setToggle('kicktodo-community', 'off');
    const out = await provider({ actingUserId: 'user:p-1' }).executeTool({ name: KICKTODO_COMMUNITY_REVIEWS_TOOL_ID, input: { challengeId: 'c1' } });
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
  });

  it('EMPTY without an acting user — ANNOTATED, with no fabricated aggregate', async () => {
    // KTC2-M1 — this test used to PIN the defect: it asserted
    // `aggregate: { count: 0, average: null }` on the refused path, the exact
    // shape a real zero-review challenge produces (see the projection case
    // below, which is the negative control keeping the two distinguishable).
    // `count: 0` is a statistic; a refusal counts nothing.
    await setToggle('kicktodo-community', 'on');
    const out = await provider().executeTool({ name: KICKTODO_COMMUNITY_REVIEWS_TOOL_ID, input: { challengeId: 'c1' } });
    expect(out.isError).toBeFalsy();
    const parsed: { reviews: unknown[]; aggregate: unknown; note?: string } = JSON.parse(out.content);
    expect(parsed.reviews).toEqual([]);
    expect(parsed.aggregate, 'a refusal counts nothing — no fabricated statistic').toBeNull();
    expect(parsed.note, 'and says so, so a model cannot read it as an answer').toMatch(/not a statement/i);
  });

  it('validation_error on a missing challengeId (never success-with-empty)', async () => {
    await setToggle('kicktodo-community', 'on');
    const out = await provider({ actingUserId: 'user:p-1' }).executeTool({ name: KICKTODO_COMMUNITY_REVIEWS_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toEqual({ error: 'validation_error', message: '`challengeId` is required.' });
  });

  it('returns the closed review projection for a challenge (empty when none)', async () => {
    await setToggle('kicktodo-community', 'on');
    const out = await provider({ actingUserId: 'user:p-1' }).executeTool({ name: KICKTODO_COMMUNITY_REVIEWS_TOOL_ID, input: { challengeId: 'no-such-challenge' } });
    expect(out.isError).toBeFalsy();
    const parsed: { reviews: unknown[]; aggregate: { count: number; average: number | null } } = JSON.parse(out.content);
    expect(parsed.reviews).toEqual([]);
    expect(parsed.aggregate).toEqual({ count: 0, average: null });
  });
});
