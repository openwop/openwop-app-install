/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the CMS agents' real conversational tools.
 *
 * The exchange contract under test: the `vendor.openwop-app.cms.agents` localizer +
 * content-editor allowlist `openwop:cms.<verb>` ids that RESOLVE at dispatch
 * (the allowlist-resolution tripwire's positive case), each gated exactly like
 * the HTTP editor path — reads FAIL EMPTY without an acting user, writes fail
 * TYPED, translation is `cms-localization`-gated, and the write verbs DRAFT +
 * SUBMIT only (there is NO publish tool). Boots the REAL app so the
 * `registerFeatureAgentTool` registration seam is what runs.
 *
 * Each case gets its OWN draft page (the submit case moves its page to `in_review`,
 * which used to red the draft cases under shuffle), and one PUBLISHED page exists so
 * the fail-empty and published-only claims have something they could leak or list.
 * That every one of the six ids is offerable is the repo-wide tripwire
 * `agent-allowlist-resolution.test.ts` (the content-editor allowlist names all six).
 *
 * Sabotage (w16 probes, each red here): dropping the no-acting-user early return of
 * get-page / list-pages / get-draft-page; listing drafts; `resolveOrgScope` accepting no
 * user; translate ignoring `cms-localization`; update-section-draft not merging the data;
 * submit-page not transitioning; a missing page thrown instead of `not_found`; a missing
 * slug answered as an empty page.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import {
  CMS_GET_PAGE_TOOL_ID,
  CMS_LIST_PAGES_TOOL_ID,
  CMS_GET_DRAFT_PAGE_TOOL_ID,
  CMS_TRANSLATE_SECTION_TOOL_ID,
  CMS_UPDATE_SECTION_DRAFT_TOOL_ID,
  CMS_SUBMIT_PAGE_TOOL_ID,
} from '../src/features/cms/agentTools.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createPage, getPage, transitionPage } from '../src/features/cms/cmsService.js';

const TENANT = 'default';

let server: http.Server;
let orgId: string;
let liveSlug: string;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP editor path — the sole org auto-resolves
  // and its owner (`u-1`) holds workspace:write.
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
  const live = await createPage({ tenantId: TENANT, orgId, title: 'Live', sections: [{ type: 'hero', data: { heading: 'Live heading' } }], createdBy: 'u-1' });
  await transitionPage(TENANT, orgId, live.pageId, 'publish', 'u-1');
  liveSlug = live.slug;
});

/** A fresh DRAFT page for one case (no case sees another case's writes). */
async function freshDraft(): Promise<{ pageId: string; sectionId: string; slug: string }> {
  const page = await createPage({
    tenantId: TENANT,
    orgId,
    title: `Draft ${n++}`,
    sections: [{ type: 'hero', data: { heading: 'Hello world' } }],
    createdBy: 'u-1',
  });
  return { pageId: page.pageId, sectionId: page.sections[0]!.sectionId, slug: page.slug };
}
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('CFP-1 — reads FAIL EMPTY without an acting user (no system-turn enumeration)', () => {
  it('get-page / list-pages / get-draft-page return empty, not tenant data', async () => {
    const { pageId } = await freshDraft();
    const p = provider();
    expect(JSON.parse((await p.executeTool({ name: CMS_GET_PAGE_TOOL_ID, input: { slug: liveSlug } })).content)).toEqual({ page: null, locale: null });
    expect(JSON.parse((await p.executeTool({ name: CMS_LIST_PAGES_TOOL_ID, input: {} })).content)).toEqual({ pages: [] });
    expect(JSON.parse((await p.executeTool({ name: CMS_GET_DRAFT_PAGE_TOOL_ID, input: { pageId } })).content)).toEqual({ page: null });
    // Positive control: the same reads WITH an acting user do return this tenant's data,
    // so the empty answers above are the guard, not an empty tenant.
    const withUser = provider({ actingUserId: 'u-1' });
    const live = JSON.parse((await withUser.executeTool({ name: CMS_GET_PAGE_TOOL_ID, input: { slug: liveSlug } })).content) as { page: { slug: string } | null };
    expect(live.page?.slug).toBe(liveSlug);
    const draft = JSON.parse((await withUser.executeTool({ name: CMS_GET_DRAFT_PAGE_TOOL_ID, input: { pageId } })).content) as { page: { pageId: string } | null };
    expect(draft.page?.pageId).toBe(pageId);
  });
});

describe('CFP-1 — reads (workspace:read) with an acting user', () => {
  it('get-draft-page returns the draft page RAW sections', async () => {
    const { pageId, sectionId } = await freshDraft();
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CMS_GET_DRAFT_PAGE_TOOL_ID, input: { pageId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { page: { status: string; sections: { sectionId: string }[] } | null };
    expect(res.page?.status).toBe('draft');
    expect(res.page?.sections[0]?.sectionId).toBe(sectionId);
  });

  it('list-pages is published-only (a draft page is not listed)', async () => {
    const { pageId } = await freshDraft();
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CMS_LIST_PAGES_TOOL_ID, input: {} });
    const pages = (JSON.parse(out.content) as { pages: Array<{ pageId: string; slug: string; status: string }> }).pages;
    expect(pages.map((p) => p.slug)).toEqual([liveSlug]);
    expect(pages.every((p) => p.status === 'published')).toBe(true);
    expect(pages.some((p) => p.pageId === pageId)).toBe(false);
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
    const { pageId, sectionId } = await freshDraft();
    const out = await provider().executeTool({ name: CMS_UPDATE_SECTION_DRAFT_TOOL_ID, input: { pageId, sectionId, data: { heading: 'X' } } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
    expect(((await getPage(TENANT, orgId, pageId))!.sections[0]!.data as { heading: string }).heading).toBe('Hello world');
  });

  it('update-section-draft patches a DRAFT section (sanitized like an editor save)', async () => {
    const { pageId, sectionId } = await freshDraft();
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CMS_UPDATE_SECTION_DRAFT_TOOL_ID,
      input: { pageId, sectionId, data: { heading: 'Updated heading', notAHeroField: 'dropped' } },
    });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ updated: true });
    const saved = (await getPage(TENANT, orgId, pageId))!.sections[0]!.data as Record<string, unknown>;
    expect(saved.heading).toBe('Updated heading');
    expect(saved).not.toHaveProperty('notAHeroField');
  });

  it('update-section-draft on a missing page is a typed, repairable error (never a throw)', async () => {
    const { sectionId } = await freshDraft();
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CMS_UPDATE_SECTION_DRAFT_TOOL_ID,
      input: { pageId: 'page:does-not-exist', sectionId, data: { heading: 'X' } },
    });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });

  it('submit-page submits the draft for review (the terminal action; no publish)', async () => {
    const { pageId } = await freshDraft();
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CMS_SUBMIT_PAGE_TOOL_ID, input: { pageId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { submitted: boolean; status?: string };
    expect(res.submitted).toBe(true);
    expect(res.status).toBe('in_review');
    expect((await getPage(TENANT, orgId, pageId))?.status).toBe('in_review'); // reviewed, never published
  });
});
