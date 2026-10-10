/**
 * ADR 0805 § Follow-up — the host-extension trigger-subscription DELETE.
 *
 * `DELETE /host/openwop-app/trigger-subscriptions/{id}` (registered on the
 * vendor twin, reached at the canonical unversioned path): webhooks:manage,
 * tenant-bound, and it removes everything the host keeps for the subscription —
 * the row, its RFC 0232 dead-letter records and its sealed signing secret (a
 * signed post to the old ingest URL is then the indistinguishable 404).
 *
 * Driven on the v1-retired host, because the route exists so the certification
 * cut can clean up there. (It was driven twice, with 1.x live as well, until
 * ADR 0812 P3c removed major 1.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

const OP = 'k-op-0805d-operator';
const TB = 'k-tb-0805d-tenant-b';

for (const v1Retired of [true]) {
  describe('trigger-subscription DELETE (v1 RETIRED)', () => {
    let server: http.Server; let base = '';
    const saved: Record<string, string | undefined> = {};
    const KEYS = ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE', 'OPENWOP_TRIGGER_INBOUND_SIGNING'];

    const v2 = async (method: string, path: string, key = OP, body?: unknown) => {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'OpenWOP-Version': '2', authorization: `Bearer ${key}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await r.text();
      let json: Record<string, any> = {}; try { json = JSON.parse(text); } catch { /* 204 / 410 */ }
      return { status: r.status, body: json };
    };
    const register = async () => {
      const r = await v2('POST', '/trigger-subscriptions', OP, { source: 'webhook', workflowId: 'openwop-app.uppercase', verification: { mode: 'required' } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { subscription: { subscriptionId: string }; binding: { ingestUrl: string } };
    };
    const refuse = async (ingestUrl: string) => (await fetch(`${base}${ingestUrl}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': `msg_${randomBytes(12).toString('hex')}`, 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
      body: '{}',
    })).status;
    const del = (bound: string, key = OP) => v2('DELETE', `/host/openwop-app/trigger-subscriptions/${projectBoundId(bound)}`, key);

    beforeAll(async () => {
      for (const k of KEYS) saved[k] = process.env[k];
      process.env.OPENWOP_STORAGE_DSN = 'memory://';
      process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
      process.env.OPENWOP_API_KEYS = `${OP}:*,${TB}:tenant-b`;
      process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
      process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
      process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = 'true';
      const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
      await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('deletes the subscription, its dead letters and its signing secret; a second delete is 404', async () => {
      const { subscription, binding } = await register();
      const bound = subscription.subscriptionId;
      expect(await refuse(binding.ingestUrl), 'a refused post dead-letters').toBe(401);
      const before = await v2('GET', `/trigger-subscriptions/${projectBoundId(bound)}/dead-letters`);
      expect(before.body.deliveries).toHaveLength(1);

      const gone = await del(bound);
      expect(gone.status, JSON.stringify(gone.body)).toBe(204);
      expect((await v2('GET', `/trigger-subscriptions/${projectBoundId(bound)}`)).status).toBe(404);
      expect((await v2('GET', `/trigger-subscriptions/${projectBoundId(bound)}/dead-letters`)).status).toBe(404);
      // The sealed secret is gone too: the ingest URL is now the indistinguishable 404.
      expect(await refuse(binding.ingestUrl)).toBe(404);
      expect((await del(bound)).status, 'idempotent from the caller\'s side: nothing left to delete').toBe(404);
    });

    it('is tenant-bound: another tenant\'s bound id is 403 id_tenant_mismatch, and nothing is deleted', async () => {
      const { subscription } = await register();
      const bound = subscription.subscriptionId;
      const foreign = await del(bound, TB);
      expect(foreign.status).toBe(403);
      expect(foreign.body.error).toBe('id_tenant_mismatch');
      const opaque = bound.slice(bound.indexOf('/') + 1);
      expect((await del(`tenant-b/${opaque}`, TB)).status, 'the caller\'s own tenant around a foreign opaque resolves to nothing').toBe(404);
      expect((await v2('GET', `/trigger-subscriptions/${projectBoundId(bound)}`)).status, 'still there').toBe(200);
    });

    it('a malformed ~ escape is 400; an unknown id is 404', async () => {
      expect((await v2('DELETE', '/host/openwop-app/trigger-subscriptions/bad~ZZ')).status).toBe(400);
      // The caller's OWN tenant segment around an opaque id never minted.
      const { subscription } = await register();
      const ownTenant = subscription.subscriptionId.slice(0, subscription.subscriptionId.indexOf('/'));
      const unknown = await del(`${ownTenant}/tgsub-${randomBytes(8).toString('hex')}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('not_found');
    });

    if (v1Retired) {
      it('the /v1 twin of the route is retired (410): only the vendor home serves it', async () => {
        const { subscription } = await register();
        const r = await fetch(`${base}/v1/host/openwop-app/trigger-subscriptions/${projectBoundId(subscription.subscriptionId)}`, {
          method: 'DELETE', headers: { authorization: `Bearer ${OP}` },
        });
        expect(r.status).toBe(410);
        expect((await v2('GET', `/trigger-subscriptions/${projectBoundId(subscription.subscriptionId)}`)).status, 'a retired path deletes nothing').toBe(200);
      });
    }
  });
}
