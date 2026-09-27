/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the CMS agents' real conversational tools.
 *
 * The exchange contract under test: the `feature.cms.agents` localizer +
 * content-editor allowlist `openwop:cms.<verb>` ids that RESOLVE at dispatch
 * (the allowlist-resolution tripwire's positive case), each gated exactly like
 * the HTTP editor path — reads FAIL EMPTY without an acting user, writes fail
 * TYPED, translation is `cms-localization`-gated, and the write verbs DRAFT +
 * SUBMIT only (there is NO publish tool). Boots the REAL app so the
 * `registerFeatureAgentTool` registration seam is what runs.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  CMS_GET_PAGE_TOOL_ID,
  CMS_LIST_PAGES_TOOL_ID,
  CMS_GET_DRAFT_PAGE_TOOL_ID,
  CMS_TRANSLATE_SECTION_TOOL_ID,
  CMS_UPDATE_SECTION_DRAFT_TOOL_ID,
  CMS_SUBMIT_PAGE_TOOL_ID,
} from '../src/features/cms/agentTools.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createPage } from '../src/features/cms/cmsService.js';

const TENANT = 'default';
const ALL_IDS = [
  CMS_GET_PAGE_TOOL_ID,
  CMS_LIST_PAGES_TOOL_ID,
  CMS_GET_DRAFT_PAGE_TOOL_ID,
  CMS_TRANSLATE_SECTION_TOOL_ID,
  CMS_UPDATE_SECTION_DRAFT_TOOL_ID,
  CMS_SUBMIT_PAGE_TOOL_ID,
];

let server: http.Server;
let orgId: string;
let pageId: string;
let sectionId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP editor path — the sole org auto-resolves
  // and its owner (`u-1`) holds workspace:write.
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
  const page = await createPage({
    tenantId: TENANT,
    orgId,
    title: 'Landing',
    sections: [{ type: 'hero', data: { heading: 'Hello world' } }],
    createdBy: 'u-1',
  });
  pageId = page.pageId;
  sectionId = page.sections[0]!.sectionId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('CFP-1 — CMS agent tools register into the builtin surface', () => {
  it('all six ids are offerable to a live turn', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });
});

describe('CFP-1 — reads FAIL EMPTY without an acting user (no system-turn enumeration)', () => {
  it('get-page / list-pages / get-draft-page return empty, not tenant data', async () => {
    const p = provider();
    expect(JSON.parse((await p.executeTool({ name: CMS_GET_PAGE_TOOL_ID, input: { slug: 'landing' } })).content)).toEqual({ page: null, locale: null });
    expect(JSON.parse((await p.executeTool({ name: CMS_LIST_PAGES_TOOL_ID, input: {} })).content)).toEqual({ pages: [] });
    expect(JSON.parse((await p.executeTool({ name: CMS_GET_DRAFT_PAGE_TOOL_ID, input: { pageId } })).content)).toEqual({ page: null });
  });
});

describe('CFP-1 — reads (workspace:read) with an acting user', () => {
  it('get-draft-page returns the draft page RAW sections', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CMS_GET_DRAFT_PAGE_TOOL_ID, input: { pageId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { page: { status: string; sections: { sectionId: string }[] } | null };
    expect(res.page?.status).toBe('draft');
    expect(res.page?.sections[0]?.sectionId).toBe(sectionId);
  });

  it('list-pages is published-only (a draft page is not listed)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CMS_LIST_PAGES_TOOL_ID, input: {} });
    expect(JSON.parse(out.content)).toEqual({ pages: [] });
  });

  it('validation error when a required input is missing', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CMS_GET_PAGE_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });
});

describe('CFP-1 — translate-section is cms-localization-gated', () => {
  it('fails closed with feature_disabled when localization is off (the default)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CMS_TRANSLATE_SECTION_TOOL_ID,
      input: { sectionType: 'hero', data: { heading: 'Hello' }, targetLocale: 'es' },
    });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
  });
});

describe('CFP-1 — governed writes: DRAFT + SUBMIT only, typed failures', () => {
  it('update-section-draft requires a human-initiated turn', async () => {
    const out = await provider().executeTool({ name: CMS_UPDATE_SECTION_DRAFT_TOOL_ID, input: { pageId, sectionId, data: { heading: 'X' } } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('update-section-draft patches a DRAFT section (sanitized like an editor save)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CMS_UPDATE_SECTION_DRAFT_TOOL_ID,
      input: { pageId, sectionId, data: { heading: 'Updated heading' } },
    });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ updated: true });
  });

  it('update-section-draft on a missing page is a typed, repairable error (never a throw)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CMS_UPDATE_SECTION_DRAFT_TOOL_ID,
      input: { pageId: 'page:does-not-exist', sectionId, data: { heading: 'X' } },
    });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content).error).toBeTruthy();
  });

  it('submit-page submits the draft for review (the terminal action; no publish)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CMS_SUBMIT_PAGE_TOOL_ID, input: { pageId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { submitted: boolean; status?: string };
    expect(res.submitted).toBe(true);
  });
});
