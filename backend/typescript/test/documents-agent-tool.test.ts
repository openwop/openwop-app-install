/**
 * ADR 0308 P0/P1 — tool-grounded commitments + the `openwop:documents.draft`
 * agent deliverable tool.
 *
 * P0: every composed chat scaffold (agent-scoped AND generic — voice composes
 * through the same owner) carries the anti-fabrication contract.
 * P1: the feature-registered builtin behaves draft-only, toggle-honest,
 * acting-user-required, org-RBAC'd — and actually writes the document.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { composeChatContext, TOOL_GROUNDED_COMMITMENTS } from '../src/host/chatContext.js';
import { createAgentToolProvider, builtinAgentToolIds, builtinToolNamespaces } from '../src/host/agentToolProvider.js';
import { DOCUMENTS_DRAFT_TOOL_ID, EMAIL_DRAFT_TOOL_ID, DOCUMENTS_GENERATE_FROM_TEMPLATE_TOOL_ID, DOCUMENTS_GET_TEMPLATE_TOOL_ID } from '../src/features/documents/agentTools.js';
import { NOTIFY_ME_TOOL_ID, AGENT_DELIVERABLE_NOTIFICATION_TYPE, isSafeInAppPath } from '../src/features/notifications/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { listDocumentsForTenant, listVersions, createTemplate } from '../src/features/documents/documentsService.js';

const TENANT = 'default';

let server: http.Server;
beforeAll(async () => {
  // Boot the REAL app: host-ext persistence + feature init — which is exactly
  // where `registerDocumentsAgentTools()` runs (the ADR 0308 D2 seam under test).
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setDocuments = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('documents');
  if (d) await saveConfig({ ...d, status }, 'test');
};

async function runDraft(input: Record<string, unknown>, scope: { actingUserId?: string; agentProfileId?: string }): Promise<{ content: string; isError?: boolean }> {
  const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-adr0308', ...scope });
  return provider.executeTool({ name: DOCUMENTS_DRAFT_TOOL_ID, input });
}

describe('ADR 0308 P0 — the anti-fabrication contract rides every composed scaffold', () => {
  it('generic (unscoped) scaffold carries TOOL_GROUNDED_COMMITMENTS', async () => {
    const ctx = await composeChatContext(TENANT, {});
    expect(ctx.systemPrompt).toContain(TOOL_GROUNDED_COMMITMENTS);
  });

  it('agent-scoped scaffold carries it too (even when the persona misses)', async () => {
    const ctx = await composeChatContext(TENANT, { agentId: 'no-such-agent' });
    expect(ctx.systemPrompt).toContain(TOOL_GROUNDED_COMMITMENTS);
    // The contract's load-bearing sentences are present verbatim.
    expect(ctx.systemPrompt).toContain('A bare unfiled promise is forbidden');
    expect(ctx.systemPrompt).toContain('tool call in this same turn');
  });
});

describe('ADR 0308 P1 — openwop:documents.draft (feature-registered deliverable tool)', () => {
  it('registers into the builtin surface (allowlist/firewall see it like any builtin)', () => {
    expect(builtinAgentToolIds()).toContain(DOCUMENTS_DRAFT_TOOL_ID);
    // The ADR 0102 per-tool gate derives namespaces — the new one is picked up.
    expect(builtinToolNamespaces()).toContain('openwop:documents');
  });

  it('fails closed when the documents toggle is OFF (structured, not a throw)', async () => {
    await setDocuments('off');
    const out = await runDraft({ title: 'T', contentMarkdown: 'Body' }, { actingUserId: 'u-1' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
  });

  it('requires a human-initiated turn (no acting user ⇒ no draft)', async () => {
    await setDocuments('on');
    const out = await runDraft({ title: 'T', contentMarkdown: 'Body' }, {});
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('creates a real DRAFT document + first version in the sole org, RBAC-checked', async () => {
    await setDocuments('on');
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-writer', name: 'Acme', ownerSubject: 'u-writer' });
    const out = await runDraft(
      { title: 'Q3 rollout uptime report', contentMarkdown: '## Uptime\n99.95% …' },
      { actingUserId: 'u-writer', agentProfileId: 'host:iris' },
    );
    expect(out.isError, out.content).toBeFalsy();
    const payload = JSON.parse(out.content) as { documentId: string; title: string; status: string };
    expect(payload.title).toBe('Q3 rollout uptime report');
    expect(payload.status).toBe('draft');
    const docs = await listDocumentsForTenant(TENANT);
    const doc = docs.find((d) => d.documentId === payload.documentId);
    expect(doc?.orgId).toBe(org.orgId);
    expect(doc?.createdBy).toBe('u-writer');
    // Agent provenance — the draft says WHO produced it.
    expect(doc?.provenance.producedBy).toEqual({ kind: 'agent', id: 'host:iris' });
    const versions = await listVersions(TENANT, org.orgId, payload.documentId);
    expect(versions[0]?.content).toContain('99.95%');
  });

  it('denies a member without workspace:write (same RBAC as the HTTP path)', async () => {
    await setDocuments('on');
    const org = (await createOrg({ tenantId: TENANT, createdBy: 'u-owner2', name: 'Second Org', ownerSubject: 'u-owner2' })).orgId;
    await createMember({ tenantId: TENANT, orgId: org, displayName: 'Viewer', subject: 'u-viewer', roles: ['viewer'] });
    const out = await runDraft({ title: 'T', contentMarkdown: 'B', orgId: org }, { actingUserId: 'u-viewer' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'forbidden_scope' });
  });

  it('with several orgs and no orgId, asks instead of guessing', async () => {
    await setDocuments('on');
    // Two orgs exist from the cases above — no orgId must NOT silently pick one.
    const out = await runDraft({ title: 'T', contentMarkdown: 'B' }, { actingUserId: 'u-writer' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'org_required' });
  });
});

describe('ADR 0308 P2 — openwop:email.draft (an email-draft Document; never sends — OQ-1)', () => {
  async function runEmailDraft(input: Record<string, unknown>, scope: { actingUserId?: string; agentProfileId?: string }): Promise<{ content: string; isError?: boolean }> {
    const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-adr0308-p2', ...scope });
    return provider.executeTool({ name: EMAIL_DRAFT_TOOL_ID, input });
  }

  it('registers as a DISTINCT tool id (own allowlist/firewall identity)', () => {
    expect(builtinAgentToolIds()).toContain(EMAIL_DRAFT_TOOL_ID);
    expect(builtinToolNamespaces()).toContain('openwop:email');
  });

  it('creates an email-draft KIND document with the To/Subject header + body', async () => {
    await setDocuments('on');
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-mailer', name: 'Mail Org', ownerSubject: 'u-mailer' });
    const out = await runEmailDraft(
      { to: 'platform-team@acme.test', subject: 'Mitigation plans for the Q3 rollout', bodyMarkdown: 'Hi team,\n\nCould you share the current mitigation plans?', orgId: org.orgId },
      { actingUserId: 'u-mailer', agentProfileId: 'host:iris' },
    );
    expect(out.isError, out.content).toBeFalsy();
    const payload = JSON.parse(out.content) as { documentId: string; title: string; kind: string; status: string };
    expect(payload.kind).toBe('email-draft');
    expect(payload.title).toBe('Mitigation plans for the Q3 rollout');
    expect(payload.status).toBe('draft');
    const versions = await listVersions(TENANT, org.orgId, payload.documentId);
    expect(versions[0]?.content).toContain('**To:** platform-team@acme.test');
    expect(versions[0]?.content).toContain('**Subject:** Mitigation plans');
    expect(versions[0]?.content).toContain('Could you share the current mitigation plans?');
    // The draft-never-send invariant is visible in the artifact itself.
    expect(versions[0]?.content).toContain('review, then send');
  });

  it('shares the deliverable governance: toggle-off fails closed; no acting user refuses', async () => {
    await setDocuments('off');
    const off = await runEmailDraft({ subject: 'S', bodyMarkdown: 'B' }, { actingUserId: 'u-mailer' });
    expect(JSON.parse(off.content)).toMatchObject({ error: 'feature_disabled' });
    await setDocuments('on');
    const noUser = await runEmailDraft({ subject: 'S', bodyMarkdown: 'B' }, {});
    expect(JSON.parse(noUser.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('validates subject + body', async () => {
    await setDocuments('on');
    const out = await runEmailDraft({ subject: '  ', bodyMarkdown: '' }, { actingUserId: 'u-mailer' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });

  it('an IDENTICAL retried call reuses the same document — no duplicate drafts (grade-pass GD-0308-1)', async () => {
    await setDocuments('on');
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-retry', name: 'Retry Org', ownerSubject: 'u-retry' });
    const input = { title: 'Retry-safe report', contentMarkdown: 'Same payload.', orgId: org.orgId };
    const scope = { actingUserId: 'u-retry', agentProfileId: 'host:iris' };
    const first = JSON.parse((await runDraft(input, scope)).content) as { documentId: string };
    const second = JSON.parse((await runDraft(input, scope)).content) as { documentId: string };
    expect(second.documentId).toBe(first.documentId);
    expect((await listVersions(TENANT, org.orgId, first.documentId)).length).toBe(1);
    // A DIFFERENT draft in the same run still gets its own document.
    const third = JSON.parse((await runDraft({ ...input, contentMarkdown: 'Different payload.' }, scope)).content) as { documentId: string };
    expect(third.documentId).not.toBe(first.documentId);
  });

  it('returns a REAL ?org=&doc= deep-link (ADR 0308 P3 — DocumentsPage consumes it one-shot)', async () => {
    await setDocuments('on');
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-linker', name: 'Link Org', ownerSubject: 'u-linker' });
    const out = await runDraft({ title: 'Linked', contentMarkdown: 'B', orgId: org.orgId }, { actingUserId: 'u-linker' });
    const payload = JSON.parse(out.content) as { documentId: string; url: string };
    expect(payload.url).toBe(`/documents?org=${encodeURIComponent(org.orgId)}&doc=${encodeURIComponent(payload.documentId)}`);
  });

  it('collapses newlines in to/subject — header fields cannot break out of the draft header (review fix)', async () => {
    await setDocuments('on');
    const org = await createOrg({ tenantId: TENANT, createdBy: 'u-mailer2', name: 'Mail Org 2', ownerSubject: 'u-mailer2' });
    const out = await runEmailDraft(
      { to: 'a@x.test,\nb@x.test', subject: 'Line one\nLine two', bodyMarkdown: 'Body.', orgId: org.orgId },
      { actingUserId: 'u-mailer2' },
    );
    expect(out.isError, out.content).toBeFalsy();
    const payload = JSON.parse(out.content) as { documentId: string; title: string };
    expect(payload.title).toBe('Line one Line two');
    const versions = await listVersions(TENANT, org.orgId, payload.documentId);
    expect(versions[0]?.content).toContain('> **To:** a@x.test, b@x.test');
    expect(versions[0]?.content).toContain('> **Subject:** Line one Line two');
  });
});

describe('C2 (chat-first port) — openwop:documents.generate-from-template + get-template (igniting the node as a chat tool)', () => {
  async function runGenerate(input: Record<string, unknown>, scope: { actingUserId?: string; agentProfileId?: string; runId?: string }): Promise<{ content: string; isError?: boolean }> {
    const { runId = 'run-c2', ...rest } = scope;
    const provider = createAgentToolProvider({ tenantId: TENANT, runId, ...rest });
    return provider.executeTool({ name: DOCUMENTS_GENERATE_FROM_TEMPLATE_TOOL_ID, input });
  }
  async function runGetTemplate(input: Record<string, unknown>, scope: { actingUserId?: string }): Promise<{ content: string; isError?: boolean }> {
    const provider = createAgentToolProvider({ tenantId: TENANT, ...scope });
    return provider.executeTool({ name: DOCUMENTS_GET_TEMPLATE_TOOL_ID, input });
  }
  // A shared org + template — required params drive the closed-world validation.
  async function seedTemplate(owner: string, orgName: string): Promise<{ orgId: string; templateId: string; kind: string }> {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: owner, name: orgName, ownerSubject: owner })).orgId;
    const tmpl = await createTemplate({
      tenantId: TENANT, orgId, name: 'Statement of Work', kind: 'sow', outputFormat: 'markdown', createdBy: owner,
      promptBody: 'Write a SOW for {{clientName}} covering {{scope}}.',
      parameters: { required: ['clientName'], properties: { clientName: { type: 'string' }, scope: { type: 'string' } } },
    });
    return { orgId, templateId: tmpl.templateId, kind: tmpl.kind };
  }

  it('registers both ids into the builtin surface (allowlist/firewall see them)', () => {
    expect(builtinAgentToolIds()).toContain(DOCUMENTS_GENERATE_FROM_TEMPLATE_TOOL_ID);
    expect(builtinAgentToolIds()).toContain(DOCUMENTS_GET_TEMPLATE_TOOL_ID);
    expect(builtinToolNamespaces()).toContain('openwop:documents');
  });

  it('fails closed when the documents toggle is OFF (structured, not a throw)', async () => {
    await setDocuments('off');
    const out = await runGenerate({ templateId: 'tmpl:whatever', contentMarkdown: 'Body' }, { actingUserId: 'u-1' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setDocuments('on');
  });

  it('WF-DOC-5 — the READ tools honor the toggle too (a feature-off tenant is not agent-readable)', async () => {
    // Born-red witnessed: before the shared read gate, all three read tools
    // skipped the toggle entirely — this test failed with a successful read.
    const { orgId, templateId } = await seedTemplate('u-read-toggle', 'ReadToggle Co');
    await setDocuments('off');
    try {
      const provider = createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-read-toggle' });
      for (const [name, input] of [
        ['openwop:documents.get', { documentId: 'doc:whatever' }],
        ['openwop:documents.list-templates', { orgId }],
        [DOCUMENTS_GET_TEMPLATE_TOOL_ID, { templateId, orgId }],
      ] as const) {
        const out = await provider.executeTool({ name, input: input as Record<string, unknown> });
        expect(out.isError, `${name} must refuse when the feature is off`).toBe(true);
        expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
      }
    } finally {
      await setDocuments('on');
    }
    // Polarity: with the toggle back on, the same read succeeds.
    const provider = createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-read-toggle' });
    const ok = await runGetTemplate({ templateId, orgId }, { actingUserId: 'u-read-toggle' });
    expect(ok.isError, ok.content).toBeUndefined();
    void provider;
  });

  it('requires a human-initiated turn (no acting user ⇒ no draft)', async () => {
    await setDocuments('on');
    const out = await runGenerate({ templateId: 'tmpl:whatever', contentMarkdown: 'Body' }, {});
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('generates a DRAFT stamped with the template — kind, format, templateId, agent provenance', async () => {
    await setDocuments('on');
    const { orgId, templateId, kind } = await seedTemplate('u-c2-a', 'C2 Org A');
    const out = await runGenerate(
      { templateId, orgId, params: { clientName: 'Acme', scope: 'platform' }, contentMarkdown: '# SOW — Acme\n\nScope: platform …', title: 'Acme SOW' },
      { actingUserId: 'u-c2-a', agentProfileId: 'host:iris' },
    );
    expect(out.isError, out.content).toBeFalsy();
    const payload = JSON.parse(out.content) as { documentId: string; title: string; kind: string; templateId: string; status: string };
    expect(payload.title).toBe('Acme SOW');
    expect(payload.kind).toBe(kind);
    expect(payload.templateId).toBe(templateId);
    expect(payload.status).toBe('draft');
    const doc = (await listDocumentsForTenant(TENANT)).find((d) => d.documentId === payload.documentId);
    expect(doc?.orgId).toBe(orgId);
    expect(doc?.templateId).toBe(templateId);
    expect(doc?.format).toBe('markdown');
    expect(doc?.provenance.producedBy).toEqual({ kind: 'agent', id: 'host:iris' });
    const versions = await listVersions(TENANT, orgId, payload.documentId);
    expect(versions[0]?.content).toContain('Scope: platform');
  });

  it('a MISSING required parameter is a typed validation_error (the closed-world node check, not success-with-empty)', async () => {
    await setDocuments('on');
    const { orgId, templateId } = await seedTemplate('u-c2-b', 'C2 Org B');
    // `clientName` is required by the template — omit it.
    const out = await runGenerate({ templateId, orgId, params: { scope: 'x' }, contentMarkdown: 'Body' }, { actingUserId: 'u-c2-b' });
    expect(out.isError).toBe(true);
    const payload = JSON.parse(out.content) as { error: string; message: string };
    expect(payload.error).toBe('validation_error');
    expect(payload.message).toContain('clientName');
  });

  it('rejects an unknown templateId with not_found', async () => {
    await setDocuments('on');
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-c2-c', name: 'C2 Org C', ownerSubject: 'u-c2-c' })).orgId;
    const out = await runGenerate({ templateId: 'tmpl:nope', orgId, contentMarkdown: 'Body' }, { actingUserId: 'u-c2-c' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });

  it('an IDENTICAL retried generation reuses the same document — no duplicate drafts', async () => {
    await setDocuments('on');
    const { orgId, templateId } = await seedTemplate('u-c2-d', 'C2 Org D');
    const input = { templateId, orgId, params: { clientName: 'Acme' }, contentMarkdown: 'Same body.', title: 'Retry SOW' };
    const scope = { actingUserId: 'u-c2-d', agentProfileId: 'host:iris' };
    const first = JSON.parse((await runGenerate(input, scope)).content) as { documentId: string };
    const second = JSON.parse((await runGenerate(input, scope)).content) as { documentId: string };
    expect(second.documentId).toBe(first.documentId);
    expect((await listVersions(TENANT, orgId, first.documentId)).length).toBe(1);
  });

  it('get-template reads the template body + parameters (read-before-write), read RBAC enforced', async () => {
    await setDocuments('on');
    const { orgId, templateId } = await seedTemplate('u-c2-e', 'C2 Org E');
    const ok = await runGetTemplate({ templateId, orgId }, { actingUserId: 'u-c2-e' });
    expect(ok.isError, ok.content).toBeFalsy();
    const tmpl = JSON.parse(ok.content) as { promptBody: string; parameters: { required: string[] }; kind: string };
    expect(tmpl.promptBody).toContain('{{clientName}}');
    expect(tmpl.parameters.required).toContain('clientName');
    expect(tmpl.kind).toBe('sow');
    // A member without read scope cannot read it (same RBAC as the HTTP path).
    await createMember({ tenantId: TENANT, orgId, displayName: 'Nobody', subject: 'u-c2-none', roles: [] });
    const denied = await runGetTemplate({ templateId, orgId }, { actingUserId: 'u-c2-none' });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content)).toMatchObject({ error: 'forbidden_scope' });
  });
});

describe('ADR 0308 P3 — openwop:notifications.notify-me (self-scope inbox deliverable)', () => {
  async function runNotify(input: Record<string, unknown>, scope: { actingUserId?: string; agentProfileId?: string }): Promise<{ content: string; isError?: boolean }> {
    const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-adr0308-p3', ...scope });
    return provider.executeTool({ name: NOTIFY_ME_TOOL_ID, input });
  }

  it('registers as a builtin (namespace derived for the per-tool gate)', () => {
    expect(builtinAgentToolIds()).toContain(NOTIFY_ME_TOOL_ID);
    expect(builtinToolNamespaces()).toContain('openwop:notifications');
  });

  it('refuses without a human-initiated turn (self-scope has no self)', async () => {
    const out = await runNotify({ title: 'T' }, {});
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('rejects non-in-app urls — the inbox must never link off-app (phishing floor)', async () => {
    for (const url of ['https://evil.example/login', '//evil.example', 'javascript:alert(1)', '/ok but spaced', '/tab\tchar', 'documents']) {
      const out = await runNotify({ title: 'T', url }, { actingUserId: 'u-inbox' });
      expect(out.isError, url).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'invalid_url' });
    }
    // The pure guard, exhaustively.
    expect(isSafeInAppPath('/documents?org=o&doc=d')).toBe(true);
    expect(isSafeInAppPath('/')).toBe(true);
    expect(isSafeInAppPath('//x')).toBe(false);
    expect(isSafeInAppPath('/a\\b')).toBe(false);
    expect(isSafeInAppPath(`/${'a'.repeat(600)}`)).toBe(false);
  });

  it('emits an addressed notification to the ACTING USER with the deep-link', async () => {
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const out = await runNotify(
      { title: 'Your Q3 uptime report is ready', body: 'Draft created for review.', url: '/documents?org=o1&doc=doc:1' },
      { actingUserId: 'u-inbox', agentProfileId: 'host:iris' },
    );
    expect(out.isError, out.content).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ delivered: true });
    const rows = await hostExtStorage().listNotifications({ tenantId: TENANT, recipientUserId: 'u-inbox' });
    const row = rows.find((n) => n.title === 'Your Q3 uptime report is ready');
    expect(row?.recipientUserId).toBe('u-inbox');
    expect(row?.type).toBe(AGENT_DELIVERABLE_NOTIFICATION_TYPE);
    expect(row?.actionUrl).toBe('/documents?org=o1&doc=doc:1');
    expect(row?.metadata).toMatchObject({ producedBy: 'host:iris', runId: 'run-adr0308-p3' });
  });
});
