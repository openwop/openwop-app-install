/**
 * A6 (chat-first port) — the `openwop:conversations.export-document` agent tool
 * that ignites the ADR 0119 Phase-3 `exportConversationAsDocument` helper.
 *
 * Contract under test: the tool registers as a builtin (so allowlist/firewall
 * see it), is toggle-honest + acting-user gated, defaults to the CURRENT
 * conversation, enforces the ADR 0043 owner/participant READ predicate (a
 * conversation the caller can't read folds to not_found), writes the transcript
 * through the ONE documents owner, and dedupes an exact re-export in a run.
 * Boots the REAL app — the feature-init registration seam is what's under test.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { CONVERSATIONS_EXPORT_DOCUMENT_TOOL_ID } from '../src/features/chat-export/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import { getDocument, listVersions, listDocumentsForTenant } from '../src/features/documents/documentsService.js';

let server: http.Server;
beforeAll(async () => {
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

/** Seed a chat session (+ two turns) and, optionally, an owned conversation meta. */
async function seedConversation(tenantId: string, sessionId: string, title: string, ownerUserId?: string): Promise<void> {
  const now = new Date().toISOString();
  await hostExtStorage().createChatSession({ sessionId, tenantId, title, createdAt: now, updatedAt: now, messageCount: 0 });
  await hostExtStorage().appendChatMessage({ messageId: `${sessionId}-m0`, sessionId, role: 'user', content: 'draft the rollout plan', meta: null, authorSubject: null, createdAt: now });
  await hostExtStorage().appendChatMessage({ messageId: `${sessionId}-m1`, sessionId, role: 'assistant', content: 'here is the bold rollout plan', meta: null, authorSubject: null, createdAt: now });
  if (ownerUserId) await ensureConversationMeta(tenantId, sessionId, { type: 'person', ownerUserId });
}

function run(tenantId: string, input: Record<string, unknown>, scope: { actingUserId?: string; conversationId?: string; runId?: string } = {}): Promise<{ content: string; isError?: boolean }> {
  return createAgentToolProvider({ tenantId, ...scope }).executeTool({ name: CONVERSATIONS_EXPORT_DOCUMENT_TOOL_ID, input });
}

describe('A6 — openwop:conversations.export-document', () => {
  it('registers into the builtin surface (allowlist/firewall see it like any builtin)', () => {
    expect(builtinAgentToolIds()).toContain(CONVERSATIONS_EXPORT_DOCUMENT_TOOL_ID);
  });

  it('fails closed when the documents (write-target) toggle is OFF', async () => {
    await setDocuments('off');
    const out = await run('a6-toggle', {}, { actingUserId: 'u-1', conversationId: 'conv-anything' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setDocuments('on');
  });

  it('requires a human-initiated turn (no acting user ⇒ refusal)', async () => {
    await setDocuments('on');
    const out = await run('a6-nouser', {}, { conversationId: 'conv-anything' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('needs a conversation to export — no id and no current conversation ⇒ validation_error', async () => {
    await setDocuments('on');
    const out = await run('a6-noconv', {}, { actingUserId: 'u-1' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });

  it('exports the CURRENT conversation (scope.conversationId) as a transcript draft', async () => {
    await setDocuments('on');
    const T = 'a6-happy';
    await seedConversation(T, 'conv-h', 'Planning chat', 'u-owner');
    const org = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Acme', ownerSubject: 'u-owner' })).orgId;
    const out = await run(T, {}, { actingUserId: 'u-owner', conversationId: 'conv-h', runId: 'run-a6' });
    expect(out.isError, out.content).toBeFalsy();
    const payload = JSON.parse(out.content) as { documentId: string; title: string; kind: string; status: string; url: string };
    expect(payload.title).toBe('Planning chat');
    expect(payload.kind).toBe('conversation-transcript');
    expect(payload.status).toBe('draft');
    expect(payload.url).toContain(`org=${encodeURIComponent(org)}`);
    const doc = await getDocument(T, org, payload.documentId);
    expect(doc?.kind).toBe('conversation-transcript');
    const versions = await listVersions(T, org, payload.documentId);
    expect(versions[versions.length - 1]?.content).toContain('bold rollout plan');
  });

  it('never exports a conversation the caller cannot READ — a non-participant folds to not_found (ADR 0043)', async () => {
    await setDocuments('on');
    const T = 'a6-deny';
    await seedConversation(T, 'conv-d', 'Private chat', 'u-owner');
    await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Acme', ownerSubject: 'u-owner' });
    // A different signed-in user asks to export u-owner's private conversation by id.
    const out = await run(T, { conversationId: 'conv-d' }, { actingUserId: 'u-stranger', runId: 'run-a6' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
    // And it never wrote a transcript document into the tenant.
    expect(await listDocumentsForTenant(T)).toEqual([]);
  });

  it('an IDENTICAL re-export in the same run reuses the same document — no duplicate transcripts', async () => {
    await setDocuments('on');
    const T = 'a6-idem';
    await seedConversation(T, 'conv-i', 'Repeat chat', 'u-owner');
    const org = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Acme', ownerSubject: 'u-owner' })).orgId;
    const scope = { actingUserId: 'u-owner', conversationId: 'conv-i', runId: 'run-a6-idem' };
    const first = JSON.parse((await run(T, {}, scope)).content) as { documentId: string };
    const second = JSON.parse((await run(T, {}, scope)).content) as { documentId: string };
    expect(second.documentId).toBe(first.documentId);
    expect((await listVersions(T, org, first.documentId)).length).toBe(1);
  });
});
