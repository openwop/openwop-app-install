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
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID } from '../src/features/kicktodo-engagement/agentTools.js';
import { KICKTODO_COMMUNITY_REVIEWS_TOOL_ID } from '../src/features/kicktodo-community/agentTools.js';
import { KICKBOT_READ_TOOLS } from '../src/features/kicktodo-core/kickbotService.js';

const TENANT = 'default';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('participant-lane read tools resolve + are on KickBot (G6/G7)', () => {
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
    const out = await provider().executeTool({ name: KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ optedIn: false, boards: [], awards: [] });
  });

  it('reads the acting user\'s own view when enabled (not opted in ⇒ honest empty)', async () => {
    await setToggle('kicktodo-engagement', 'on');
    const out = await provider({ actingUserId: 'user:p-1' }).executeTool({ name: KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { optedIn: boolean; boards: unknown[]; awards: unknown[] };
    // ADR 0641 d13 — read from the opt-in ROW, so this stays false even though
    // `leaderboard()` no longer throws for an enrolled-but-not-opted-in caller.
    expect(parsed.optedIn).toBe(false); // no opt-in yet
    expect(Array.isArray(parsed.boards)).toBe(true);
    expect(Array.isArray(parsed.awards)).toBe(true);
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
    const parsed = JSON.parse(out.content) as { reviews: unknown[]; aggregate: unknown; note?: string };
    expect(parsed.reviews).toEqual([]);
    expect(parsed.aggregate, 'a refusal counts nothing — no fabricated statistic').toBeNull();
    expect(parsed.note, 'and says so, so a model cannot read it as an answer').toMatch(/not a statement/i);
  });

  it('validation_error on a missing challengeId (never success-with-empty)', async () => {
    await setToggle('kicktodo-community', 'on');
    const out = await provider({ actingUserId: 'user:p-1' }).executeTool({ name: KICKTODO_COMMUNITY_REVIEWS_TOOL_ID, input: {} });
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });

  it('returns the closed review projection for a challenge (empty when none)', async () => {
    await setToggle('kicktodo-community', 'on');
    const out = await provider({ actingUserId: 'user:p-1' }).executeTool({ name: KICKTODO_COMMUNITY_REVIEWS_TOOL_ID, input: { challengeId: 'no-such-challenge' } });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { reviews: unknown[]; aggregate: { count: number; average: number | null } };
    expect(parsed.reviews).toEqual([]);
    expect(parsed.aggregate).toEqual({ count: 0, average: null });
  });
});
