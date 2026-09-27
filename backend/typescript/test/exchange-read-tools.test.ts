/**
 * LLM-EXCHANGE-AUDIT Wave 4 — the READ side of the exchange (XCH-HOLE-1..5 +
 * XCH-DOCS-1): agents can now ASK the app what exists before authoring.
 * Every tool is read-only, registered through the ADR 0308 seam, and mirrors
 * its HTTP route's access predicate exactly (the shared-helper design):
 *  - goals.list / proposals.list — tenant-scoped
 *  - projects.list — per-project resolveProjectAccess for the ACTING USER
 *  - tasks.deck — the route's IDOR ownership filter (own runs + children)
 *  - conversations.search — the ADR 0043 visibility predicate
 *  - documents.get / documents.list-templates — org RBAC read
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { GOALS_LIST_TOOL_ID } from '../src/features/goals/agentTools.js';
import { PROJECTS_LIST_TOOL_ID } from '../src/features/projects/agentTools.js';
import { PROPOSALS_LIST_TOOL_ID } from '../src/features/proposals/agentTools.js';
import { TASKS_DECK_TOOL_ID } from '../src/features/task-deck/agentTools.js';
import { CONVERSATIONS_SEARCH_TOOL_ID } from '../src/features/conversation-search/agentTools.js';
import { DOCUMENTS_GET_TOOL_ID, DOCUMENTS_LIST_TEMPLATES_TOOL_ID, DOCUMENTS_DRAFT_TOOL_ID } from '../src/features/documents/agentTools.js';
import { MEDIA_LIST_TOOL_ID } from '../src/features/media/agentTools.js';
import { CHANNELS_LIST_TOOL_ID } from '../src/features/channels/agentTools.js';
import { CREATIVE_BRIEFS_LIST_TOOL_ID } from '../src/features/creative-briefs/agentTools.js';
import { INTENT_LEDGER_GET_TOOL_ID } from '../src/features/intent-ledger/agentTools.js';
import { CDP_IDENTITY_RESOLVE_TOOL_ID } from '../src/features/cdp/agentTools.js';
import { createProject, setProjectVisibility } from '../src/features/projects/projectsService.js';
import { createOrg, createCustomRole, createMember } from '../src/host/accessControlService.js';
import { createAsset } from '../src/features/media/mediaService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import { saveLedger } from '../src/features/intent-ledger/ledgerStore.js';

const TENANT = 'default';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const run = (name: string, input: Record<string, unknown> = {}, scope: { actingUserId?: string } = {}) =>
  createAgentToolProvider({ tenantId: TENANT, runId: 'run-xch-w4', ...scope }).executeTool({ name, input });
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

describe('the Wave 4 read tools are registered (ADR 0308 seam)', () => {
  it('all seven ids resolve as builtin agent tools', () => {
    const ids = builtinAgentToolIds();
    for (const id of [GOALS_LIST_TOOL_ID, PROJECTS_LIST_TOOL_ID, PROPOSALS_LIST_TOOL_ID, TASKS_DECK_TOOL_ID, CONVERSATIONS_SEARCH_TOOL_ID, DOCUMENTS_GET_TOOL_ID, DOCUMENTS_LIST_TEMPLATES_TOOL_ID]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });
});

describe('tenant-scoped reads return honest shapes', () => {
  it('goals.list returns a goals array (empty workspace)', async () => {
    const out = parse(await run(GOALS_LIST_TOOL_ID));
    expect(Array.isArray(out.goals)).toBe(true);
  });
  it('proposals.list returns a proposals array', async () => {
    const out = parse(await run(PROPOSALS_LIST_TOOL_ID));
    expect(Array.isArray(out.proposals)).toBe(true);
  });
});

describe('acting-user gating (fail EMPTY, never open)', () => {
  it('tasks.deck without an acting user returns the empty deck + note', async () => {
    const out = parse(await run(TASKS_DECK_TOOL_ID));
    expect(out.note).toContain('no acting user');
    expect((out.deck as { buckets: Record<string, unknown[]> }).buckets.running).toEqual([]);
  });
  it('conversations.search without an acting user returns no hits + note', async () => {
    const out = parse(await run(CONVERSATIONS_SEARCH_TOOL_ID, { query: 'anything' }));
    expect(out.hits).toEqual([]);
    expect(out.note).toContain('no acting user');
  });
  it('projects.list without an acting user returns nothing', async () => {
    const out = parse(await run(PROJECTS_LIST_TOOL_ID));
    expect(out.projects).toEqual([]);
  });
});

describe('projects.list honors private visibility (ADR 0054 D5)', () => {
  it('a private project the user is not a member of never surfaces', async () => {
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-owner', name: 'XCH Org', ownerSubject: 'u-owner' });
    const pOrg = await createProject(TENANT, org.orgId, { name: 'Org-visible project' });
    const pPriv = await createProject(TENANT, org.orgId, { name: 'Private project' });
    await setProjectVisibility(TENANT, pPriv.id, 'private');

    // The org OWNER sees both (write authority).
    const owner = parse(await run(PROJECTS_LIST_TOOL_ID, {}, { actingUserId: 'u-owner' }));
    const ownerNames = (owner.projects as Array<{ name: string }>).map((p) => p.name);
    expect(ownerNames).toContain('Org-visible project');
    expect(ownerNames).toContain('Private project');

    // A NON-MEMBER outsider sees neither (no org access at all → 'none').
    const outsider = parse(await run(PROJECTS_LIST_TOOL_ID, {}, { actingUserId: 'u-outsider' }));
    const outsiderNames = (outsider.projects as Array<{ name: string }>).map((p) => p.name);
    expect(outsiderNames).not.toContain('Private project');
    void pOrg;
  });
});

describe('documents read tools (XCH-DOCS-1)', () => {
  it('documents.get round-trips a draft the draft tool just created (read-before-revise)', async () => {
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-writer2', name: 'Docs Org', ownerSubject: 'u-writer2' });
    const draft = parse(await run(DOCUMENTS_DRAFT_TOOL_ID, { title: 'Q3 Plan', contentMarkdown: '# Plan\nShip.', orgId: org.orgId }, { actingUserId: 'u-writer2' }));
    expect(draft.documentId).toBeTruthy();
    const got = parse(await run(DOCUMENTS_GET_TOOL_ID, { documentId: draft.documentId }, { actingUserId: 'u-writer2' }));
    expect(got.title).toBe('Q3 Plan');
    expect(got.content).toContain('Ship.');
  });

  it('documents.get denies a user with no access to the document org (no existence leak)', async () => {
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-writer3', name: 'Sealed Org', ownerSubject: 'u-writer3' });
    const draft = parse(await run(DOCUMENTS_DRAFT_TOOL_ID, { title: 'Secret', contentMarkdown: 'x', orgId: org.orgId }, { actingUserId: 'u-writer3' }));
    const out = await run(DOCUMENTS_GET_TOOL_ID, { documentId: draft.documentId }, { actingUserId: 'u-stranger' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('not_found');
  });

  it('documents.list-templates reports hasOutputSchema honestly', async () => {
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-writer4', name: 'Tmpl Org', ownerSubject: 'u-writer4' });
    const out = parse(await run(DOCUMENTS_LIST_TEMPLATES_TOOL_ID, { orgId: org.orgId }, { actingUserId: 'u-writer4' }));
    expect(Array.isArray(out.templates)).toBe(true);
    for (const t of out.templates as Array<{ hasOutputSchema: boolean }>) {
      expect(typeof t.hasOutputSchema).toBe('boolean');
    }
  });
});

// ── LLM-EXCHANGE-AUDIT round 3 (XCH-HOLE-6/7) — media / channels /
//    creative-briefs / intent-ledger / cdp. Same seam, same conventions:
//    LIST tools fail EMPTY + note without an acting user; by-id GETs deny
//    structured (IDOR-safe not_found); toggled features fail closed in run. ──
describe('the round-3 read tools are registered (ADR 0308 seam)', () => {
  it('all five ids resolve as builtin agent tools', () => {
    const ids = builtinAgentToolIds();
    for (const id of [MEDIA_LIST_TOOL_ID, CHANNELS_LIST_TOOL_ID, CREATIVE_BRIEFS_LIST_TOOL_ID, INTENT_LEDGER_GET_TOOL_ID, CDP_IDENTITY_RESOLVE_TOOL_ID]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });
});

describe('media.list (org RBAC + safe summary)', () => {
  it('without an acting user returns empty + note (LIST convention)', async () => {
    const out = parse(await run(MEDIA_LIST_TOOL_ID));
    expect(out.assets).toEqual([]);
    expect(String(out.note)).toContain('No acting user');
  });
  it('lists org assets for a member and NEVER exposes storageRef/serveToken', async () => {
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-media', name: 'Media Org', ownerSubject: 'u-media' });
    await createAsset({
      tenantId: TENANT, orgId: org.orgId, name: 'hero.png', contentType: 'image/png', sizeBytes: 123,
      storageRef: 'blob:SECRET-STORAGE-REF', serveToken: 'SECRET-SERVE-TOKEN', uploadedBy: 'u-media', tags: ['hero'],
    });
    const res = await run(MEDIA_LIST_TOOL_ID, { orgId: org.orgId }, { actingUserId: 'u-media' });
    const out = parse(res);
    const names = (out.assets as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain('hero.png');
    expect(res.content).not.toContain('SECRET-STORAGE-REF');
    expect(res.content).not.toContain('SECRET-SERVE-TOKEN');
  });
  it('denies an outsider with the org-not-found shape (no existence leak)', async () => {
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-media2', name: 'Media Org 2', ownerSubject: 'u-media2' });
    const out = await run(MEDIA_LIST_TOOL_ID, { orgId: org.orgId }, { actingUserId: 'u-media-stranger' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('not_found');
  });

  it('requires EXACTLY workspace:read — a write-only custom role is denied, matching the route (grade-pass 2026-07-15)', async () => {
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-media3', name: 'Media Org 3', ownerSubject: 'u-media3' });
    const role = await createCustomRole({ orgId: org.orgId, tenantId: TENANT, name: 'write-only-contributor', scopes: ['workspace:write'] });
    await createMember({ orgId: org.orgId, tenantId: TENANT, displayName: 'Write Only', subject: 'u-write-only', roles: [role.roleId] });
    const out = await run(MEDIA_LIST_TOOL_ID, { orgId: org.orgId }, { actingUserId: 'u-write-only' });
    expect(out.isError).toBe(true); // requireOrgScope('workspace:read') would 403 this caller; the tool must not be laxer
  });
});

describe('channels.list (viewer-scoped by the SAME service predicate as the route)', () => {
  it('without an acting user returns empty + note, never the public-only view', async () => {
    const out = parse(await run(CHANNELS_LIST_TOOL_ID));
    expect(out.channels).toEqual([]);
    expect(String(out.note)).toContain('No acting user');
  });
  it('with an acting user returns the discovery rows array', async () => {
    const out = parse(await run(CHANNELS_LIST_TOOL_ID, {}, { actingUserId: 'u-chan' }));
    expect(Array.isArray(out.channels)).toBe(true);
  });
});

describe('creative-briefs.list (toggle-in-run fail-closed)', () => {
  it('reports feature_disabled while the toggle is off (the default)', async () => {
    const out = await run(CREATIVE_BRIEFS_LIST_TOOL_ID, {}, { actingUserId: 'u-cb' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('feature_disabled');
  });
  it('lists briefs once the toggle is on (org RBAC read)', async () => {
    await saveConfig({ id: 'creative-briefs', status: 'on', bucketUnit: 'tenant', salt: 'xch-r3' }, 'test');
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-cb2', name: 'CB Org', ownerSubject: 'u-cb2' });
    const out = parse(await run(CREATIVE_BRIEFS_LIST_TOOL_ID, { orgId: org.orgId }, { actingUserId: 'u-cb2' }));
    expect(Array.isArray(out.briefs)).toBe(true);
  });
});

describe('intent-ledger.get (the route\'s visibility predicate, IDOR-safe not_found)', () => {
  it('requires an acting user — a system turn cannot read legacy UNOWNED conversations (grade-pass 2026-07-15)', async () => {
    await ensureConversationMeta(TENANT, 'conv-il-unowned', { type: 'person' }); // no ownerUserId — isVisibleToAsync(…, undefined) would admit it
    const out = await run(INTENT_LEDGER_GET_TOOL_ID, { conversationId: 'conv-il-unowned' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('acting_user_required');
  });

  it('an unknown conversation and a stranger\'s conversation are indistinguishable', async () => {
    const unknown = await run(INTENT_LEDGER_GET_TOOL_ID, { conversationId: 'conv-nope' }, { actingUserId: 'u-il' });
    expect(unknown.isError).toBe(true);
    expect(parse(unknown).error).toBe('not_found');
    await ensureConversationMeta(TENANT, 'conv-il-private', { type: 'person', ownerUserId: 'u-il-owner' });
    const stranger = await run(INTENT_LEDGER_GET_TOOL_ID, { conversationId: 'conv-il-private' }, { actingUserId: 'u-il-stranger' });
    expect(stranger.isError).toBe(true);
    expect(parse(stranger).error).toBe('not_found');
  });
  it('the conversation owner reads their mission contract', async () => {
    await ensureConversationMeta(TENANT, 'conv-il-mine', { type: 'person', ownerUserId: 'u-il-me' });
    await saveLedger({
      ledgerId: 'il-1', tenantId: TENANT, conversationId: 'conv-il-mine',
      goal: 'Ship the Q3 launch page', allowed: ['core.openwop.http.*'], forbidden: ['core.email.*'],
      requireApproval: [], successCriteria: ['page is live'], status: 'approved', proposedBy: 'user', createdAt: 'x',
    });
    const out = parse(await run(INTENT_LEDGER_GET_TOOL_ID, { conversationId: 'conv-il-mine' }, { actingUserId: 'u-il-me' }));
    expect((out.ledger as { goal: string }).goal).toBe('Ship the Q3 launch page');
    expect((out.ledger as { forbidden: string[] }).forbidden).toEqual(['core.email.*']);
  });
});

describe('cdp.identity.resolve (ALWAYS masked; toggle-in-run fail-closed)', () => {
  it('reports feature_disabled while the toggle is off (the default)', async () => {
    const out = await run(CDP_IDENTITY_RESOLVE_TOOL_ID, { type: 'email', value: 'x@y.z' }, { actingUserId: 'u-cdp' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('feature_disabled');
  });
  it('never returns unmasked PII — the agent is a scope-limited caller by construction', async () => {
    await saveConfig({ id: 'cdp', status: 'on', bucketUnit: 'tenant', salt: 'xch-r3' }, 'test');
    await createContact({ tenantId: TENANT, name: 'Ada Lovelace', email: 'ada.lovelace@example.com' });
    const res = await run(CDP_IDENTITY_RESOLVE_TOOL_ID, { type: 'email', value: 'ada.lovelace@example.com' }, { actingUserId: 'u-cdp' });
    const out = parse(res);
    expect(out.masked).toBe(true);
    // The raw PII must be absent from the ENTIRE tool payload (the resolvedBy
    // echo included) — a deterministic pseudonym stands in for it.
    expect(res.content).not.toContain('ada.lovelace@example.com');
    expect(res.content).not.toContain('Ada Lovelace');
  });
  it('requires an acting user (structured deny, by-value GET convention)', async () => {
    const out = await run(CDP_IDENTITY_RESOLVE_TOOL_ID, { type: 'email', value: 'x@y.z' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('acting_user_required');
  });
});
