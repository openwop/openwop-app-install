/**
 * ADR 0076 Phase 2 — email DRAFT to mailbox (never sends).
 *
 * Verifies (a) a dedicated `microsoft-graph` builtin provider pinned to
 * graph.microsoft.com with a Mail.ReadWrite (NOT Mail.Send) write scope, and
 * (b) the `core.email.draft` node creates a draft via ctx.connectors at the fixed
 * create-message endpoint, NEVER a send endpoint, maps {draftId, webLink}, and
 * fails closed (no surface / bad config / connector error).
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { getProvider } from '../src/features/connections/providerRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

function makeCtx(over: Partial<NodeContext>): NodeContext {
  const base: NodeContext = {
    runId: 'run_1', nodeId: 'n1', tenantId: 'demo', inputs: {}, configurable: {},
    attempt: 1, secrets: {}, emit: async () => ({ eventId: 'e1', sequence: 1 }),
  };
  return { ...base, ...over };
}

describe('ADR 0076 §2 — microsoft-graph provider (draft, never send)', () => {
  it('is pinned to graph.microsoft.com with Mail.ReadWrite and NO Mail.Send', () => {
    const g = getProvider('microsoft-graph');
    expect(g).toBeTruthy();
    expect(g?.apiHosts).toContain('graph.microsoft.com');
    const writeScopes = (g?.scopes.write ?? []).flatMap((s) => s.scopes);
    expect(writeScopes).toContain('https://graph.microsoft.com/Mail.ReadWrite');
    // Honesty + safety: drafting is a WRITE scope, but NEVER the send scope.
    const allScopes = [...(g?.scopes.read ?? []), ...(g?.scopes.write ?? [])].flatMap((s) => s.scopes);
    expect(allScopes.some((s) => /Mail\.Send/i.test(s))).toBe(false);
  });
});

describe('ADR 0076 §2 — core.email.draft node', () => {
  beforeAll(() => ensureNodesRegistered());
  const getNode = () => {
    const node = getNodeRegistry().get('core.email.draft');
    expect(node).toBeTruthy();
    return node!;
  };

  it('creates a draft at /v1.0/me/messages and NEVER a send endpoint', async () => {
    let invokedUrl = '';
    const ctx = makeCtx({
      config: { to: 'cfo@corp.example', subject: 'Q3 thanks', body: 'Great work.' },
      connectors: {
        invoke: async (_id, request) => {
          invokedUrl = request.url;
          return { ok: true, status: 201, data: { id: 'AAMk-draft-1', webLink: 'https://outlook.office.com/mail/draft' } };
        },
      },
    });
    const out = await getNode().execute(ctx);
    expect(out.status).toBe('success');
    const o = (out as { outputs: Record<string, unknown> }).outputs;
    expect(o.drafted).toBe(true);
    expect(o.draftId).toBe('AAMk-draft-1');
    expect(o.webLink).toBe('https://outlook.office.com/mail/draft');
    expect(o.recipientCount).toBe(1);
    // The NEVER-SEND invariant: the only URL constructed is the create-message
    // endpoint — never /send or /sendMail.
    expect(invokedUrl).toBe('https://graph.microsoft.com/v1.0/me/messages');
    expect(/send/i.test(invokedUrl)).toBe(false);
  });

  it('accepts multiple recipients', async () => {
    let bodySent = '';
    const ctx = makeCtx({
      config: { to: ['a@x.com', 'b@x.com'], subject: 'Hi', body: 'x' },
      connectors: { invoke: async (_id, request) => { bodySent = request.body ?? ''; return { ok: true, data: { id: 'd' } }; } },
    });
    const out = await getNode().execute(ctx);
    expect(out.status).toBe('success');
    expect((out as { outputs: Record<string, unknown> }).outputs.recipientCount).toBe(2);
    expect(JSON.parse(bodySent).toRecipients).toHaveLength(2);
  });

  it('gmail: creates a draft at users/me/drafts ({message:{raw}}), NEVER a send endpoint', async () => {
    let invokedUrl = '';
    let bodySent = '';
    const ctx = makeCtx({
      config: { to: ['a@x.com', 'b@x.com'], subject: 'Congrats', body: '<b>10 years!</b>', bodyFormat: 'HTML', connectorId: 'gmail' },
      connectors: {
        invoke: async (_id, request) => {
          invokedUrl = request.url;
          bodySent = request.body ?? '';
          return { ok: true, status: 200, data: { id: 'draft-gmail-1', message: { id: 'msg-1' } } };
        },
      },
    });
    const out = await getNode().execute(ctx);
    expect(out.status).toBe('success');
    const o = (out as { outputs: Record<string, unknown> }).outputs;
    expect(o.drafted).toBe(true);
    expect(o.draftId).toBe('draft-gmail-1');
    expect(o.recipientCount).toBe(2);
    // never-send BY CONSTRUCTION: the only Gmail URL is the drafts.create endpoint.
    expect(invokedUrl).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(/send/i.test(invokedUrl)).toBe(false);
    // body is {message:{raw: base64url(RFC822)}} — decode + assert the headers round-trip.
    const raw = (JSON.parse(bodySent) as { message: { raw: string } }).message.raw;
    const rfc822 = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(rfc822).toContain('To: a@x.com, b@x.com');
    expect(rfc822).toContain('Subject: Congrats');
    expect(rfc822).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(rfc822).toContain('<b>10 years!</b>');
  });

  it('gmail provider is pinned to gmail.googleapis.com with the narrowest draft scope', () => {
    const g = getProvider('gmail');
    expect(g?.apiHosts).toContain('gmail.googleapis.com');
    const writeScopes = (g?.scopes.write ?? []).flatMap((s) => s.scopes);
    expect(writeScopes).toContain('https://www.googleapis.com/auth/gmail.compose');
    // Honesty: Gmail has no draft-without-send scope, so never-send is by construction
    // (the node only ever builds the drafts URL) — but we still pick the NARROWEST scope
    // and must NOT request the broad gmail.modify or the read-only-incapable gmail scope.
    const allScopes = [...(g?.scopes.read ?? []), ...(g?.scopes.write ?? [])].flatMap((s) => s.scopes);
    expect(allScopes.some((s) => /gmail\.modify/i.test(s))).toBe(false);
  });

  it('rejects a CR/LF in subject or recipient (MIME header-injection guard) before any invoke', async () => {
    let invoked = false;
    const ctx = makeCtx({
      config: { to: 'a@x.com', subject: 'Hi\r\nBcc: evil@x.com', body: 'x', connectorId: 'gmail' },
      connectors: { invoke: async () => { invoked = true; return { ok: true, data: { id: 'd' } }; } },
    });
    const out = await getNode().execute(ctx);
    expect(out.status).toBe('failure');
    expect((out as { error: { code: string } }).error.code).toBe('invalid_config');
    expect(invoked).toBe(false); // never reached the connector — fail-closed before egress
    // And the same guard for a header-breaking recipient.
    const r2 = await getNode().execute(makeCtx({
      config: { to: 'a@x.com\r\nBcc: evil@x.com', subject: 's', body: 'x', connectorId: 'gmail' },
      connectors: { invoke: async () => ({ ok: true, data: { id: 'd' } }) },
    }));
    expect(r2.status).toBe('failure');
  });

  it('fails closed: absent connector surface, missing recipients/subject, connector error', async () => {
    expect((await getNode().execute(makeCtx({ config: { to: 'a@x.com', subject: 's' } }))).status).toBe('failure'); // no connectors
    const noTo = await getNode().execute(makeCtx({ config: { subject: 's' }, connectors: { invoke: async () => ({ ok: true }) } }));
    expect(noTo.status).toBe('failure');
    const noSubj = await getNode().execute(makeCtx({ config: { to: 'a@x.com' }, connectors: { invoke: async () => ({ ok: true }) } }));
    expect(noSubj.status).toBe('failure');
    const connErr = await getNode().execute(makeCtx({ config: { to: 'a@x.com', subject: 's' }, connectors: { invoke: async () => ({ ok: false, error: 'connector_no_connection' }) } }));
    expect(connErr.status).toBe('failure');
    expect((connErr as { error: { code: string } }).error.code).toBe('connector_no_connection');
  });
});
