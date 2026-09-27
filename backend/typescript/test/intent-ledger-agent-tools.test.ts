/**
 * CFP A13 — the intent-ledger drafting agent tool.
 *
 * The exchange contract under test: `openwop:intent-ledger.draft-contract` replaces
 * the modal's bespoke `llmExtractLedger` REST call. The chat agent (which IS the
 * model) authors the contract fields IN-CONVERSATION; the tool mirrors the /draft
 * route's owner predicate, validates closed-world (typed defect on bad input), and
 * persists a DRAFT only — it NEVER approves (approval stays a human action). The
 * conversation is the UNFORGEABLE run scope (ADR 0309), not model-supplied.
 * Boots the REAL app (the ADR 0308 registration seam).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { INTENT_LEDGER_GET_TOOL_ID, INTENT_LEDGER_DRAFT_TOOL_ID } from '../src/features/intent-ledger/agentTools.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import { getLedger, saveLedger } from '../src/features/intent-ledger/ledgerStore.js';

const TENANT = 'default';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const run = (input: Record<string, unknown> = {}, scope: { actingUserId?: string; conversationId?: string } = {}) =>
  createAgentToolProvider({ tenantId: TENANT, runId: 'run-il-draft', ...scope }).executeTool({ name: INTENT_LEDGER_DRAFT_TOOL_ID, input });
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

describe('intent-ledger.draft-contract is a registered agent tool (ADR 0308 seam)', () => {
  it('both the read + the draft ids resolve as builtins', () => {
    const ids = builtinAgentToolIds();
    expect(ids).toContain(INTENT_LEDGER_GET_TOOL_ID);
    expect(ids).toContain(INTENT_LEDGER_DRAFT_TOOL_ID);
  });
});

describe('the draft tool mirrors the /draft owner predicate (fails TYPED)', () => {
  it('an action tool without an acting user fails TYPED (never a silent empty)', async () => {
    const out = await run({ goal: 'Ship it' }, { conversationId: 'c-noauth' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('acting_user_required');
  });

  it('a turn not bound to a conversation cannot draft', async () => {
    const out = await run({ goal: 'Ship it' }, { actingUserId: 'u-a' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('conversation_required');
  });

  it('an unknown conversation and a stranger\'s conversation are indistinguishable (IDOR-safe not_found)', async () => {
    const unknown = await run({ goal: 'g' }, { actingUserId: 'u-a', conversationId: 'c-nope' });
    expect(parse(unknown).error).toBe('not_found');
    await ensureConversationMeta(TENANT, 'c-owned-by-other', { type: 'person', ownerUserId: 'u-owner' });
    const stranger = await run({ goal: 'g' }, { actingUserId: 'u-stranger', conversationId: 'c-owned-by-other' });
    expect(stranger.isError).toBe(true);
    expect(parse(stranger).error).toBe('not_found');
  });
});

describe('the draft tool validates + persists a DRAFT (never approves)', () => {
  it('invalid model input is a TYPED validation defect, not success-with-empty', async () => {
    await ensureConversationMeta(TENANT, 'c-mine-1', { type: 'person', ownerUserId: 'u-me' });
    const out = await run({ allowed: ['x'] }, { actingUserId: 'u-me', conversationId: 'c-mine-1' }); // no goal
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('validation_error');
    expect(await getLedger(TENANT, 'c-mine-1')).toBeNull(); // nothing persisted on a defect
  });

  it('the owner drafts a contract — status DRAFT, proposedBy extractor, persisted for approval', async () => {
    await ensureConversationMeta(TENANT, 'c-mine-2', { type: 'person', ownerUserId: 'u-me' });
    const out = parse(await run(
      { goal: 'Ship the Q3 launch page', allowed: ['core.openwop.http.get'], forbidden: ['core.email.send'], successCriteria: ['page is live'] },
      { actingUserId: 'u-me', conversationId: 'c-mine-2' },
    ));
    expect(out.drafted).toBe(true);
    expect((out.ledger as { status: string }).status).toBe('draft');
    const saved = await getLedger(TENANT, 'c-mine-2');
    expect(saved).toMatchObject({ status: 'draft', proposedBy: 'extractor', goal: 'Ship the Q3 launch page' });
    // NEVER approves — no approvedBy, and the status stays a draft the human must approve.
    expect(saved?.approvedBy).toBeUndefined();
  });

  it('refuses to clobber an APPROVED contract (owner must revoke first)', async () => {
    await ensureConversationMeta(TENANT, 'c-approved', { type: 'person', ownerUserId: 'u-me' });
    await saveLedger({ ledgerId: 'il-x', tenantId: TENANT, conversationId: 'c-approved', goal: 'Live mission', allowed: [], forbidden: [], requireApproval: [], successCriteria: [], status: 'approved', proposedBy: 'user', createdAt: 'x' });
    const out = await run({ goal: 'sneaky replacement' }, { actingUserId: 'u-me', conversationId: 'c-approved' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('conflict');
    expect((await getLedger(TENANT, 'c-approved'))?.goal).toBe('Live mission'); // untouched
  });
});
