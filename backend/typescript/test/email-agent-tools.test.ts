/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1, port map E5) — the Email Copywriter's real
 * chat tools.
 *
 * The exchange contract under test: the copywriter agent's allowlisted tools
 * are REGISTERED builtins (so they survive `filterTools` in chat dispatch —
 * the drop this sweep fixes), the model can READ a draft (+ its template)
 * before authoring, and PERSIST copy only as a DRAFT (never a send) through
 * closed-world validation with structured error feedback — all gated exactly
 * like the HTTP routes (per-tenant `email` toggle, acting user, org RBAC).
 * Boots the REAL app (the ADR 0308 D2 registration seam is what's under test).
 *
 * Sabotage-witnessed (w9 grade-tests): a pack allowlist drift, dropping the
 * registration, the read path's toggle / acting-user empties, the draft-only list
 * filter, the `stage` defect, the per-run idempotency id, the update write, the
 * update not_found, the missing-id empty read, and the toolkit's acting_user_required
 * each turn a case red. Recorded DOUBLE GUARD: save-draft's own `emailEnabled` check is
 * shadowed by `resolveActionOrgScope`'s toggle check (same typed `feature_disabled`),
 * so "fails closed when the toggle is off" cannot fail on either one alone.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { EMAIL_GET_CAMPAIGN_TOOL_ID, EMAIL_SAVE_DRAFT_TOOL_ID } from '../src/features/email/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, listOrgs } from '../src/host/accessControlService.js';
import {
  getCampaign, getTemplate, setSenderAddress, createTemplate, createCampaign, sendCampaign,
} from '../src/features/email/emailService.js';

const TENANT = 'default';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP route path — the sole org auto-resolves
  // and its owner (`u-1`) holds workspace:write.
  await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setEmail = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('email');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('CFP-1 — the email agents pack rides the real registered tools', () => {
  const packDir = new URL('../../../packs/vendor.openwop-app.email.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
    agents: { toolAllowlist: string[]; systemPromptRef: string }[];
  };

  it('the allowlist is exactly the two registered tool ids (no un-resolvable node typeIds)', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual(
      [EMAIL_GET_CAMPAIGN_TOOL_ID, EMAIL_SAVE_DRAFT_TOOL_ID].sort(),
    );
  });

  it('both tools register into the builtin surface (survive chat filterTools)', () => {
    const ids = builtinAgentToolIds();
    for (const id of [EMAIL_GET_CAMPAIGN_TOOL_ID, EMAIL_SAVE_DRAFT_TOOL_ID]) expect(ids).toContain(id);
  });
});

describe('CFP-1 — get-campaign: the app-state read path', () => {
  it('fails EMPTY (not typed) when the toggle is off — a read never derails the loop; the write stays typed', async () => {
    await setEmail('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: EMAIL_GET_CAMPAIGN_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ campaigns: [], templates: [] });
    // (the write path's typed feature_disabled is the "fails closed when the toggle is off" case)
    await setEmail('on');
  });

  it('fails EMPTY (not error) without an acting user — tenant rows never leak to a system turn', async () => {
    await setEmail('on');
    const out = await provider().executeTool({ name: EMAIL_GET_CAMPAIGN_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ campaigns: [], templates: [] });
  });

  it('lists the org\'s draft campaigns + templates for grounding', async () => {
    await setEmail('on');
    const p = provider({ actingUserId: 'u-1', runId: 'run-get-list' });
    const draft = JSON.parse((await p.executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 'Fall sale', body: 'Hi {{contact.name}}, save now.' } })).content) as { campaignId: string };
    // A NON-draft campaign in the same org, so the draft-only filter can fail: an empty
    // audience exhausts on the first pass, which marks the campaign 'sent'.
    const orgId = (await listOrgs(TENANT))[0]!.orgId;
    await setSenderAddress(TENANT, orgId, 'news@acme.test', 'u-1');
    const prevBase = process.env.OPENWOP_EMAIL_LINK_BASE_URL;
    process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
    let sentId = '';
    try {
      const tpl = await createTemplate({ tenantId: TENANT, orgId, name: 'Sent one', subject: 'Done', body: 'x', createdBy: 'u-1' });
      const cmp = await createCampaign({ tenantId: TENANT, orgId, templateId: tpl.templateId, createdBy: 'u-1' });
      sentId = cmp.campaignId;
      const sent = await sendCampaign(TENANT, orgId, sentId, { provider: { id: 'test-transport', send: async () => {} } });
      expect(sent?.status, 'precondition: the fixture campaign is no longer a draft').toBe('sent');
    } finally {
      if (prevBase === undefined) delete process.env.OPENWOP_EMAIL_LINK_BASE_URL; else process.env.OPENWOP_EMAIL_LINK_BASE_URL = prevBase;
    }
    const out = await p.executeTool({ name: EMAIL_GET_CAMPAIGN_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { campaigns: { campaignId: string; status: string }[]; templates: { subject: string }[] };
    const ids = res.campaigns.map((c) => c.campaignId);
    expect(ids).toContain(draft.campaignId);
    expect(ids, 'a sent campaign is not a draft to ground on').not.toContain(sentId);
    expect(res.templates.some((t) => t.subject === 'Fall sale')).toBe(true);
  });

  it('reads one draft + its template by campaignId; a missing id is empty, not an error', async () => {
    await setEmail('on');
    const p = provider({ actingUserId: 'u-1', runId: 'run-get-one' });
    const created = JSON.parse((await p.executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 'Welcome', body: 'Glad you joined.' } })).content) as { campaignId: string };
    const out = await p.executeTool({ name: EMAIL_GET_CAMPAIGN_TOOL_ID, input: { campaignId: created.campaignId } });
    const res = JSON.parse(out.content) as { campaign: { campaignId: string }; template: { subject: string } };
    expect(res.campaign.campaignId).toBe(created.campaignId);
    expect(res.template.subject).toBe('Welcome');

    const missing = await p.executeTool({ name: EMAIL_GET_CAMPAIGN_TOOL_ID, input: { campaignId: 'cmp:nope' } });
    expect(missing.isError).toBeFalsy();
    expect(JSON.parse(missing.content)).toMatchObject({ campaign: null });
  });
});

describe('CFP-1 — save-draft: validate → persist a DRAFT, never a send', () => {
  it('requires a human-initiated turn (action tools fail TYPED)', async () => {
    await setEmail('on');
    const out = await provider().executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 'x', body: 'y' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('fails closed when the toggle is off', async () => {
    await setEmail('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 'x', body: 'y' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setEmail('on');
  });

  it('returns typed validation defects the model can act on (the repair loop), never success-with-empty', async () => {
    await setEmail('on');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: '  ', body: 'has body', stage: 'prospect' } });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content) as { error: string; defects: string[] };
    expect(parsed.error).toBe('validation_error');
    expect(parsed.defects.join(' ')).toContain('subject');
    expect(parsed.defects.join(' ')).toContain('stage');
  });

  it('creates a DRAFT template + DRAFT campaign through the owning service (status=draft, never sent)', async () => {
    await setEmail('on');
    const out = await provider({ actingUserId: 'u-1', runId: 'run-create' }).executeTool({
      name: EMAIL_SAVE_DRAFT_TOOL_ID,
      input: { subject: 'Q3 launch', body: 'Big news, {{contact.name}}.', format: 'markdown', stage: 'lead' },
    });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { campaignId: string; templateId: string; created: boolean };
    expect(res.created).toBe(true);
    // Read the persisted rows back through the owning service (the sole org).
    const orgId = (await listOrgs(TENANT))[0]!.orgId;
    const cmp = await getCampaign(TENANT, orgId, res.campaignId);
    expect(cmp?.status).toBe('draft');
    const tpl = await getTemplate(TENANT, orgId, res.templateId);
    expect(tpl?.subject).toBe('Q3 launch');
    expect(tpl?.format).toBe('markdown');
  });

  it('is idempotent within a run (retries do not mint duplicate drafts)', async () => {
    await setEmail('on');
    const p = provider({ actingUserId: 'u-1', runId: 'run-idem' });
    const a = JSON.parse((await p.executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 'Same', body: 'Same body' } })).content) as { campaignId?: string; created?: boolean };
    const b = JSON.parse((await p.executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 'Same', body: 'Same body' } })).content) as { campaignId?: string };
    // Both failing would make the ids equal as `undefined` — the first call must be a real create.
    expect(a.created).toBe(true);
    expect(a.campaignId).toMatch(/^cmp:agent:/);
    expect(b.campaignId).toBe(a.campaignId);
  });

  it('updates the copy of an existing DRAFT campaign (read-before-write pairing)', async () => {
    await setEmail('on');
    const p = provider({ actingUserId: 'u-1', runId: 'run-update' });
    const created = JSON.parse((await p.executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 'v1', body: 'first' } })).content) as { campaignId: string };
    const upd = await p.executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { campaignId: created.campaignId, subject: 'v2', body: 'second' } });
    expect(upd.isError).toBeFalsy();
    expect(JSON.parse(upd.content)).toMatchObject({ campaignId: created.campaignId, updated: true });
    const orgId = (await listOrgs(TENANT))[0]!.orgId;
    const cmp = await getCampaign(TENANT, orgId, created.campaignId);
    const tpl = await getTemplate(TENANT, orgId, cmp!.templateId);
    expect(tpl?.subject).toBe('v2');
    expect(tpl?.body).toBe('second');
  });

  it('a missing campaignId on update is a typed not_found, not a silent create', async () => {
    await setEmail('on');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { campaignId: 'cmp:ghost', subject: 's', body: 'b' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});
