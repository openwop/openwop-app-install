/**
 * ADR 0440 P4 — the WRITE half of the M7 tenant-isolation fix.
 *
 * `POST /host/openwop-app/workflows` calls `registerWorkflow(def)`, which
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
 *
 * Guard layering (named, so a vacuous single-guard probe is read correctly):
 *  - a FREE shared-namespace id is refused by `isWriteProtected`'s shared branch
 *    AND, behind it, by `forkSharedWorkflow` (no ownership row to claim) — and a
 *    `wf.seed.*` id is also server-minted (ADR 0794). The shared piece both read,
 *    `SHARED_WORKFLOW_ID`, is probed (8fw5g5-wotg-shared-r2).
 *  - an `openwop-app.*` host workflow is refused by the shared branch BEFORE the
 *    chain-backed check, so the ADR 0703 leg also uses `campaign-ops.change-request`,
 *    a chain-backed id OUTSIDE the shared namespace (8fw5g5-wotg-chainbacked-r2).
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
      return { status: res.status, body: (await res.json().catch(() => undefined)) as Body | undefined };
    };
  }

  /** The fields these cases read back: a definition, a list, or an envelope. */
  interface Body {
    nodes?: Array<{ config?: { marker?: string } }>;
    workflows?: Array<{ workflowId: string }>;
    error?: string; message?: string; details?: Record<string, unknown>;
  }
  /** The uniform refusal, as a LITERAL (never another response's body). */
  const notFound = (workflowId: string) => ({ status: 404, body: { error: 'workflow_not_found', message: 'workflow not found', details: { workflowId } } });

  let seq = 0;
  /** A fresh id per case, so no case depends on another having run (shuffle-safe). */
  const freshId = (stem: string) => `${stem}-${seq++}`;

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
    expect((await alice('POST', '/host/openwop-app/test/login', { email: 'alice@acme.test', tenantId: 'org:alice' })).status).toBe(201);
    expect((await bob('POST', '/host/openwop-app/test/login', { email: 'bob@acme.test', tenantId: 'org:bob' })).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('a tenant can create + overwrite its OWN workflow', async () => {
    const id = freshId('wf-alice-owns');
    expect((await alice('POST', '/host/openwop-app/workflows', defBody(id, 'v1'))).status).toBe(201);
    // Self-overwrite (the builder's autosave) must stay open — and must LAND.
    expect((await alice('POST', '/host/openwop-app/workflows', defBody(id, 'v2'))).status).toBe(201);
    const read = await alice('GET', `/workflows/${id}`);
    expect(read.status).toBe(200);
    expect(read.body?.nodes?.[0]?.config?.marker).toBe('v2');
  });

  it('another tenant CANNOT overwrite it — indistinguishable 404, and A keeps its content', async () => {
    const id = freshId('wf-alice-owns');
    expect((await alice('POST', '/host/openwop-app/workflows', defBody(id, 'v2'))).status).toBe(201);
    const attack = await bob('POST', '/host/openwop-app/workflows', defBody(id, 'HIJACKED'));
    expect(attack).toEqual(notFound(id)); // NOT 403 — no existence oracle
    // Alice's content is intact.
    const read = await alice('GET', `/workflows/${id}`);
    expect(read.status).toBe(200);
    expect(read.body?.nodes?.[0]?.config?.marker).toBe('v2');
    // And Bob's list never picked up a phantom ownership row.
    const bobList = await bob('GET', '/host/openwop-app/workflows');
    expect(bobList.body?.workflows?.some((w) => w.workflowId === id)).toBe(false);
  });

  it('READ parity — a non-owner also gets an indistinguishable 404 on GET (M7 preserved)', async () => {
    // The guard was extracted from GET into the shared isForeignOwned helper;
    // this pins that the read side still refuses a foreign-owned id the same way.
    const id = freshId('wf-alice-owns');
    expect((await alice('POST', '/host/openwop-app/workflows', defBody(id, 'v1'))).status).toBe(201);
    const read = await bob('GET', `/workflows/${id}`);
    expect(read.status).toBe(404);
    // Alice still reads her own.
    expect((await alice('GET', `/workflows/${id}`)).status).toBe(200);
  });

  it('a FREE id (owned by no one) stays open — ordinary create works for anyone', async () => {
    const id = freshId('wf-bob-brand-new');
    expect((await bob('POST', '/host/openwop-app/workflows', defBody(id, 'x'))).status).toBe(201);
    expect((await bob('GET', `/workflows/${id}`)).body?.nodes?.[0]?.config?.marker).toBe('x');
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
    const attack = await bob('POST', '/host/openwop-app/workflows', defBody('openwop-app.channel.turn', 'POISONED'));
    expect(attack, 'a tenant overwrote a host system workflow — regression of the P4 grade-pass').toEqual(notFound('openwop-app.channel.turn'));
    // Its definition is intact: still the host DEF, not the poison marker
    // (a public-namespace id is readable by any tenant, so this read is 200).
    const read = await alice('GET', '/workflows/openwop-app.channel.turn');
    expect(read.status).toBe(200);
    expect(read.body?.nodes?.some((n) => n.config?.marker === 'POISONED')).toBe(false);
  });

  it('ADR 0703 — the SAME protection holds for every chain-backed host workflow', async () => {
    // `openwop-app.scheduled-chat.turn` was drained to a chain pack by ADR 0701, one
    // iteration BEFORE the channel one — so it carried this same hole from the moment
    // that merged, and nothing tested it. Both drained ids are pinned here now, and
    // the next drain inherits the coverage instead of re-discovering the hole.
    // The two `openwop-app.*` ids are ALSO refused by the shared-namespace branch
    // (ADR 0789) — `campaign-ops.change-request` is chain-backed and OUTSIDE that
    // namespace, so it is the leg that reaches the chain-backed check itself.
    for (const id of ['openwop-app.scheduled-chat.turn', 'openwop-app.channel.turn', 'campaign-ops.change-request']) {
      const attack = await bob('POST', '/host/openwop-app/workflows', defBody(id, 'POISONED'));
      expect(attack, `${id}: a chain-backed host workflow must not be tenant-overwritable`).toEqual(notFound(id));
    }
  });

  it('a FREE public-namespace id is NOT creatable through a tenant route (ADR 0789)', async () => {
    // §Correction (ADR 0789): this leg used to pin the opposite — a tenant could
    // create `tmpl.alice.custom` and self-overwrite it. A public namespace is one
    // shared row per id, and the seeders are register-if-missing, so a tenant
    // that created a free `wf.seed.*` id first would hand its steps to every
    // tenant seeded afterwards. The self-overwrite half of the old claim is now
    // a fork, witnessed in `seeded-workflow-tenant-isolation.test.ts`.
    for (const id of ['tmpl.alice.custom', 'wf.seed.alice-squat']) {
      expect(await alice('POST', '/host/openwop-app/workflows', defBody(id, 'v1')), id).toEqual(notFound(id));
    }
    // The three-segment id's echoed `details.workflowId` is over-redacted by the
    // error sanitizer (ERR-REDACT-JWT-1, pinned below), so this leg asserts the
    // refusal itself — status, code and message — and leaves `details` to the pin.
    const authored = await alice('POST', '/host/openwop-app/workflows', defBody('openwop-app.authored.alice-squat', 'v1'));
    expect(authored).toMatchObject({ status: 404, body: { error: 'workflow_not_found', message: 'workflow not found' } });
  });

  // ERR-REDACT-JWT-1 (BLOCKED-ON-PRODUCT, grade-tests wave 64): the error
  // envelope's `sanitizeDetails` runs `JWT_RE` (src/middleware/sanitize.ts:15,
  // three dot-separated runs of 8+ chars) over every detail value, so an ordinary
  // workflow id such as `openwop-app.authored.alice-squat` is echoed back as
  // `<redacted:jwt>`. A real JWT's header segment is base64url JSON and always
  // starts `eyJ`. Fix-probe: 8fw5g5-wotg-jwt-fix-r2.
  it.fails('echoes a three-segment workflowId verbatim in the refusal body (ERR-REDACT-JWT-1)', async () => {
    const id = 'openwop-app.authored.alice-squat';
    expect(await alice('POST', '/host/openwop-app/workflows', defBody(id, 'v1'))).toEqual(notFound(id));
  });
});
