/**
 * ADR 0440 P4 — the WRITE half of the M7 tenant-isolation fix.
 *
 * `POST /v1/host/openwop-app/workflows` calls `registerWorkflow(def)`, which
 * kv-sets a GLOBAL-by-id key with no tenant component. Without a guard, tenant
 * B could POST under tenant A's workflowId and OVERWRITE A's definition —
 * injecting B's content (prompts, node config, connection refs) into every
 * future run and `:fork` of it, and minting a second ownership row so both
 * tenants "own" the id. The M7 fix closed the READ oracle on GET but explicitly
 * left this write hole "separately tracked". This is that track.
 *
 * The guard reuses the M7 predicate: a foreign-owned id is an indistinguishable
 * 404 (never a 403 — that would confirm the id belongs to someone, the exact
 * existence oracle M7 removed). First-write and self-overwrite stay open.
 *
 * Route-level, not service-level: the authorization boundary is only observable
 * through the HTTP surface with two distinct tenant sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';

describe('ADR 0440 P4 — cross-tenant workflow overwrite guard', () => {
  let server: http.Server;
  let BASE: string;

  /** A cookie-jar client bound to one test-auth session (one tenant). */
  function client() {
    let cookie = '';
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const ck of getSetCookies(res.headers) as string[]) {
        const m = /(__session=[^;]+)/.exec(ck);
        if (m) cookie = m[1];
      }
      return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
    };
  }

  const defBody = (workflowId: string, marker: string) => ({
    workflowId,
    metadata: { name: marker },
    nodes: [{ nodeId: 'a', typeId: 'core.noop', config: { marker } }],
    edges: [],
  });

  let alice: ReturnType<typeof client>;
  let bob: ReturnType<typeof client>;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    alice = client();
    bob = client();
    expect((await alice('POST', '/v1/host/openwop-app/test/login', { email: 'alice@acme.test', tenantId: 'org:alice' })).status).toBe(201);
    expect((await bob('POST', '/v1/host/openwop-app/test/login', { email: 'bob@acme.test', tenantId: 'org:bob' })).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('a tenant can create + overwrite its OWN workflow', async () => {
    expect((await alice('POST', '/v1/host/openwop-app/workflows', defBody('wf-alice-owns', 'v1'))).status).toBe(201);
    // Self-overwrite (the builder's autosave) must stay open.
    expect((await alice('POST', '/v1/host/openwop-app/workflows', defBody('wf-alice-owns', 'v2'))).status).toBe(201);
  });

  it('another tenant CANNOT overwrite it — indistinguishable 404, and A keeps its content', async () => {
    const attack = await bob('POST', '/v1/host/openwop-app/workflows', defBody('wf-alice-owns', 'HIJACKED'));
    expect(attack.status).toBe(404); // NOT 403 — no existence oracle
    // Alice's content is intact.
    const read = await alice('GET', '/v1/workflows/wf-alice-owns');
    expect(read.status).toBe(200);
    expect((read.body?.nodes as Array<{ config?: { marker?: string } }>)[0]?.config?.marker).toBe('v2');
    // And Bob's list never picked up a phantom ownership row.
    const bobList = await bob('GET', '/v1/host/openwop-app/workflows');
    expect((bobList.body?.workflows as Array<{ workflowId: string }>).some((w) => w.workflowId === 'wf-alice-owns')).toBe(false);
  });

  it('READ parity — a non-owner also gets an indistinguishable 404 on GET (M7 preserved)', async () => {
    // The guard was extracted from GET into the shared isForeignOwned helper;
    // this pins that the read side still refuses a foreign-owned id the same way.
    const read = await bob('GET', '/v1/workflows/wf-alice-owns');
    expect(read.status).toBe(404);
    // Alice still reads her own.
    expect((await alice('GET', '/v1/workflows/wf-alice-owns')).status).toBe(200);
  });

  it('a FREE id (owned by no one) stays open — ordinary create works for anyone', async () => {
    expect((await bob('POST', '/v1/host/openwop-app/workflows', defBody('wf-bob-brand-new', 'x'))).status).toBe(201);
  });

  it('a tenant CANNOT overwrite a host SYSTEM definition (grade-pass blocker)', async () => {
    // `openwop-app.channel.turn` drives inbound omnichannel processing for every
    // tenant; it is registered at boot with NO ownership row. The first cut of
    // this guard refused only foreign-OWNED ids, so it treated this unowned
    // system def as free — a data audit proved a tenant got 201 and could poison
    // it. isWriteProtected keys on REGISTRATION, not ownership, so it refuses.
    //
    // ADR 0703 — this leg caught the pin-site migration REOPENING that hole. Draining
    // this workflow to a chain pack moved it out of the raw registry into
    // `chainBackedWorkflows`' own, and the guard consulted only the raw one: 201 where
    // 404 is required. The guard now consults BOTH. Generalisable: a migration that
    // changes WHICH REGISTRY holds a definition changes every predicate keyed on "is it
    // registered" — and those predicates are the authz layer.
    const attack = await bob('POST', '/v1/host/openwop-app/workflows', defBody('openwop-app.channel.turn', 'POISONED'));
    expect(attack.status, 'a tenant overwrote a host system workflow — regression of the P4 grade-pass').toBe(404);
    // Its definition is intact: still the host DEF, not the poison marker.
    const read = await alice('GET', '/v1/workflows/openwop-app.channel.turn');
    if (read.status === 200) {
      expect((read.body?.nodes as Array<{ config?: { marker?: string } }>).some((n) => n.config?.marker === 'POISONED')).toBe(false);
    }
  });

  it('ADR 0703 — the SAME protection holds for every chain-backed host workflow', async () => {
    // `openwop-app.scheduled-chat.turn` was drained to a chain pack by ADR 0701, one
    // iteration BEFORE the channel one — so it carried this same hole from the moment
    // that merged, and nothing tested it. Both drained ids are pinned here now, and
    // the next drain inherits the coverage instead of re-discovering the hole.
    for (const id of ['openwop-app.scheduled-chat.turn', 'openwop-app.channel.turn']) {
      const attack = await bob('POST', '/v1/host/openwop-app/workflows', defBody(id, 'POISONED'));
      expect(attack.status, `${id}: a chain-backed host workflow must not be tenant-overwritable`).toBe(404);
    }
  });

  it('a seeded / owned public-namespace id stays self-overwritable', async () => {
    // A tenant that OWNS its copy (seeders recordOwnership directly) self-saves
    // via getOwned, not via a namespace exemption. Simulate: first create is a
    // free id in the namespace (open), the re-save is a self-overwrite.
    expect((await alice('POST', '/v1/host/openwop-app/workflows', defBody('tmpl.alice.custom', 'v1'))).status).toBe(201);
    expect((await alice('POST', '/v1/host/openwop-app/workflows', defBody('tmpl.alice.custom', 'v2'))).status).toBe(201);
    // And another tenant cannot then clobber it.
    expect((await bob('POST', '/v1/host/openwop-app/workflows', defBody('tmpl.alice.custom', 'x'))).status).toBe(404);
  });
});
