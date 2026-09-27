/**
 * @openwop/cdp-collect (ADR 0269 / CDP-G) — a zero-dependency CDP client.
 *
 * A thin, typed wrapper over the CDP host-ext endpoints (collect / identity-resolve /
 * schema-register), usable from Node or bundled for a server-side app. Auth is a
 * bearer token (a CDP-H scoped API key). A miss on resolve is a normal `null`, not an
 * error. No external deps — pass a `fetchImpl` to inject/test.
 *
 * @example
 *   import { createCdpClient } from '@openwop/cdp-collect';
 *   const cdp = createCdpClient({ baseUrl: 'https://app.example.dev', token: 'owk_...' });
 *   await cdp.collect('signup', { orderId: 'o1', email: 'a@x.test' });
 *   const rec = await cdp.resolveIdentity('email', 'a@x.test');
 */
export function createCdpClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new Error('createCdpClient: baseUrl is required');
  const url = String(baseUrl).replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const BASE = '/v1/host/openwop-app/cdp';

  const post = async (path, body) => {
    const res = await fetchImpl(`${url}${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body: parsed };
  };
  const get = async (path) => {
    const res = await fetchImpl(`${url}${BASE}${path}`, { headers });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body: parsed };
  };

  return {
    /** Ingest an event (schema-validated at the host). */
    collect: (eventType, payload) => post('/collect', { eventType, payload }),
    /**
     * Batch-ingest events (the same schema-enforced path, per row). Best-effort:
     * the response `{ accepted, rejected, results }` reports each row's outcome, so a
     * single bad row doesn't sink the batch. Capped host-side (≤100/req) — parse a CSV
     * to an array of `{ eventType, payload }` client-side and chunk to the cap.
     */
    collectBatch: (events) => post('/collect/batch', { events }),
    /** Resolve a customer's golden record by identifier; null on a 404 miss. */
    async resolveIdentity(type, value) {
      const r = await get(`/identity/resolve?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`);
      return r.status === 404 ? null : r.body;
    },
    /** Register (a new version of) an event type's JSON Schema. */
    registerSchema: (eventType, schema) => post('/event-schemas', { eventType, schema }),
  };
}
