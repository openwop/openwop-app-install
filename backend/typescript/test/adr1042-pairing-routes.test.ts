/**
 * ADR 1042 D3 (CHAN-P0-3) — sender binding and sender allowlist routes.
 *
 * Before: a WhatsApp send needed a connection↔sender binding (`pairConnection`)
 * and the only production writer was Discord's `/pair` command, so no API could
 * create one; there was no sender allowlist at all.
 *
 * Red when: the binding route is missing, skips the connection's manage check,
 * skips the workspace write, accepts a malformed sender, or is reachable with
 * both WhatsApp and Channels into chat off; an approval does not record the
 * approver as the paired owner, or a Viewer can approve.
 * Sabotage-witnessed 2026-11-03: removing `authorizeManage` from the binding
 * target, removing `requireTenantWrite` from the senders POST, and making
 * `requireBindingFeature` a no-op each turned their case red.
 * Wave 87: removing `requireTenantWrite` from the binding PUT turns the refusal
 * case red (a Viewer on their OWN connection passes `authorizeManage`, so the
 * write gate is the one that answers; on the editor's connection both guards
 * answer 403 and the body names the manage check).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootChannelHarness, CONN, field, text, type ChannelHarness } from './support/channelCoreHarness.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getPairing } from '../src/features/connections/messagingOutbound.js';

let h: ChannelHarness;
async function setToggle(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('channel-ingress');
  expect(d).toBeTruthy();
  await saveConfig({ ...d!, status }, 'test');
}
beforeAll(async () => { h = await bootChannelHarness('c1042p3'); await setToggle('on'); }, 120_000);
afterAll(async () => { await setToggle('off'); await h.close(); });

async function twilioConnection(cookie: string): Promise<string> {
  const created = await h.call(CONN, cookie, 'POST', { provider: 'twilio', kind: 'basic', secret: 'AC99:authtoken' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return encodeURIComponent(text(field(created.body, 'connectionId')));
}

describe('sender binding (/connections/:id/pairing)', () => {
  it('the connection owner binds the WhatsApp sender number; the send service then sees it', async () => {
    const editor = await h.editor();
    const id = await twilioConnection(editor);
    const put = await h.call(`${CONN}/${id}/pairing`, editor, 'PUT', { provider: 'whatsapp-twilio', channelId: 'whatsapp:+15550001111' });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
    expect(field(put.body, 'pairing', 'channelId')).toBe('+15550001111');
    expect(await getPairing(decodeURIComponent(id))).toMatchObject({ provider: 'whatsapp-twilio', channelId: '+15550001111' });
    expect(field((await h.call(`${CONN}/${id}/pairing`, editor)).body, 'pairing', 'provider')).toBe('whatsapp-twilio');
    expect((await h.call(`${CONN}/${id}/pairing`, editor, 'DELETE')).status).toBe(204);
    expect(await getPairing(decodeURIComponent(id))).toBeNull();
  });

  it('refuses a malformed sender, a non-owner and an outsider', async () => {
    const editor = await h.editor();
    const id = await twilioConnection(editor);
    const bad = await h.call(`${CONN}/${id}/pairing`, editor, 'PUT', { provider: 'whatsapp-twilio', channelId: '5550001111' });
    expect(bad.status).toBe(400);
    expect(field(bad.body, 'details', 'field')).toBe('channelId');
    const viewer = await h.call(`${CONN}/${id}/pairing`, await h.viewer(), 'PUT', { provider: 'whatsapp-twilio', channelId: '+15550002222' });
    expect(viewer.status).toBe(403);
    expect(field(viewer.body, 'error')).toBe('forbidden');
    expect(field(viewer.body, 'message')).toBe('Only the connecting user may manage this connection.');
    // The workspace write is its own gate: a Viewer who OWNS the connection passes
    // the manage check and is refused for the missing workspace:write.
    const { createSecretConnection: mintOwn } = await import('../src/features/connections/connectionsService.js');
    const viewersOwn = await mintOwn({ tenantId: h.ws, provider: 'twilio', kind: 'basic', secret: 'AC97:tok', scope: 'user', userId: h.viewerUserId });
    const noWrite = await h.call(`${CONN}/${encodeURIComponent(viewersOwn.connectionId)}/pairing`, await h.viewer(), 'PUT', { provider: 'whatsapp-twilio', channelId: '+15550002222' });
    expect(noWrite.status, JSON.stringify(noWrite.body)).toBe(403);
    expect(field(noWrite.body, 'details', 'requiredScope')).toBe('workspace:write');
    expect(await getPairing(viewersOwn.connectionId)).toBeNull();
    // The editor can write, but not to SOMEONE ELSE's personal connection.
    const { createSecretConnection } = await import('../src/features/connections/connectionsService.js');
    const theirs = await createSecretConnection({ tenantId: h.ws, provider: 'twilio', kind: 'basic', secret: 'AC98:tok', scope: 'user', userId: h.viewerUserId });
    const notMine = await h.call(`${CONN}/${encodeURIComponent(theirs.connectionId)}/pairing`, editor, 'PUT', { provider: 'whatsapp-twilio', channelId: '+15550002222' });
    expect(notMine.status, JSON.stringify(notMine.body)).toBe(403);
    expect(field(notMine.body, 'error')).toBe('forbidden');
    expect(await getPairing(theirs.connectionId)).toBeNull();
    const outsider = await h.call(`${CONN}/${id}/pairing`, await h.outsider(), 'PUT', { provider: 'whatsapp-twilio', channelId: '+15550002222' });
    expect(outsider.status).toBe(404);
    expect(field(outsider.body, 'error')).toBe('not_found');
    expect(field(outsider.body, 'message')).toBe('Connection not found.');
    expect(await getPairing(decodeURIComponent(id))).toBeNull();
  });

  it('does not exist with both WhatsApp and Channels into chat off', async () => {
    const editor = await h.editor();
    const id = await twilioConnection(editor);
    await setToggle('off');
    try {
      const off = await h.call(`${CONN}/${id}/pairing`, editor, 'PUT', { provider: 'whatsapp-twilio', channelId: '+15550003333' });
      expect(off.status).toBe(404);
      expect(field(off.body, 'error')).toBe('not_found');
      expect(field(off.body, 'message')).toBe('Sender binding is not enabled for this workspace.');
      expect(await getPairing(decodeURIComponent(id))).toBeNull();
    } finally {
      await setToggle('on');
    }
  });
});

describe('sender allowlist (/connections/:id/senders)', () => {
  it('an approval records the approver as the paired owner; revoke removes it', async () => {
    const editor = await h.editor();
    const created = await h.call(CONN, editor, 'POST', { provider: 'telegram', kind: 'bearer', secret: '42:tok' });
    const id = encodeURIComponent(text(field(created.body, 'connectionId')));
    const ok = await h.call(`${CONN}/${id}/senders`, editor, 'POST', { senderId: '12345', label: 'Bo' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(field(ok.body, 'sender', 'ownerUserId')).toBe(h.editorUserId);
    const list = await h.call(`${CONN}/${id}/senders`, editor);
    expect((field(list.body, 'approved') as unknown[]).map((s) => field(s, 'senderId'))).toEqual(['12345']);
    expect((await h.call(`${CONN}/${id}/senders/12345`, editor, 'DELETE')).status).toBe(204);
    expect(field((await h.call(`${CONN}/${id}/senders`, editor)).body, 'approved')).toEqual([]);
  });

  it('a Viewer cannot approve a sender, even on a connection they own', async () => {
    const { createSecretConnection } = await import('../src/features/connections/connectionsService.js');
    const row = await createSecretConnection({ tenantId: h.ws, provider: 'telegram', kind: 'bearer', secret: '43:tok', scope: 'user', userId: h.viewerUserId });
    const res = await h.call(`${CONN}/${encodeURIComponent(row.connectionId)}/senders`, await h.viewer(), 'POST', { senderId: '999' });
    expect(res.status).toBe(403);
    expect(field(res.body, 'details', 'requiredScope')).toBe('workspace:write');
  });
});
