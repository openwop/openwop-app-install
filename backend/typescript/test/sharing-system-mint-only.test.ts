/**
 * Security fix 2026-11-24 — a type whose legitimate mint is the host's VISITOR
 * lane (an e-sign signer link, a booker's manage link, a collaborator invite, a
 * buyer's receipt, a client approval or report link) is never minted through the
 * member Sharing API. Before the fix only `campaign_approval` and `client_report`
 * were refused, so a member could mint a signer link, and holding that token IS
 * signing as the external signer.
 *
 * Four layers, because a uniform 404 alone cannot tell a refusal from a missing
 * resource:
 *  1. ROUTE, real resource: a member mint of a REAL signer's `sign_request` is
 *     refused (only the gate can refuse it: the resource exists), and the real
 *     flow (request signature → signer link) still mints a working token.
 *  2. ROUTE, every system type: a member mint answers 404 and mints nothing.
 *  3. GATE, every system type: the mint gate alone refuses the member lane and
 *     admits the visitor lane, so each type's refusal is the gate's, not a lookup.
 *  4. CENSUS: every ResourceType is classified exactly once (SYSTEM_MINT_ONLY or
 *     MEMBER_PUBLISHABLE); every visitor-lane `createLink` site in `src/` mints a
 *     classified type, and every HOST one a system-only type; the frontend's
 *     `SYSTEM_TYPES` names the same set as SYSTEM_MINT_ONLY.
 *
 * Sabotage witness (2026-11-24): removing `sign_request` from SYSTEM_MINT_ONLY
 * reds 7 cases: layer 1 (the member mint succeeds), layer 3's sign_request
 * member case (it iterates the pinned EXPECTED list, not the set) and all five
 * census cases. Layer 2's sign_request case stays green under it, as the ceiling
 * below says: its opaque id 404s at the resolver either way.
 * Census witnesses (2026-11-24, the type-classification correction):
 * - leaving `creative_brief` unclassified reds the classification and the
 *   fail-closed probe;
 * - a temporary `src/adopter/` file minting `document` on the visitor lane (the
 *   CasaVoga shape) stays GREEN;
 * - the same file minting an unclassified type reds the site census.
 *
 * Ceiling: layer 2 uses an opaque id for the types other than sign_request, so it
 * pins the answer, not the reason; layer 3 is what discriminates those.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createDocument, addVersion } from '../src/features/documents/documentsService.js';
import { getSignRequestById } from '../src/features/crm/entities/signRequests.js';
import { RESOURCE_TYPES, SYSTEM_MINT_ONLY, __assertMintAccessForTests, type ResourceType } from '../src/features/sharing/sharingService.js';

/** Pinned, not read from the set: a layer that iterates SYSTEM_MINT_ONLY shrinks
 *  with it, so a removed type would silently drop its own case. */
const EXPECTED: readonly ResourceType[] = ['campaign_approval', 'client_report', 'sign_request', 'booking_manage', 'collab_invite', 'commerce_order'];

/** Member-publishable content: a member may share it, so a visitor-lane mint of it
 *  hands out nothing a member could not already publish. Each needs a reason. */
const MEMBER_PUBLISHABLE: readonly ResourceType[] = [
  'cms_page',           // a published site page
  'kb_collection',      // a knowledge-base collection
  'document',           // a document view (adopters mint these on the visitor lane, e.g. a client portal)
  'conversation',       // a chat transcript the member owns
  'prompt',             // a prompt-library entry
  'commerce_quote',     // a sent quote shared with its buyer (commerceClient.createQuoteShareLink)
  'app_builder_canvas', // an app-builder canvas
  'slides_canvas',      // a slide deck
  'creative_brief',     // a creative brief
];

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(BACKEND, '../..');

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_CRM_ESIGN_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'documents', 'commerce', 'sharing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: Record<string, unknown> & { orgId?: string; signRequestId?: string; links?: unknown[] } }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const raw of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(raw); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: (out ?? {}) as Res['body'] };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg() {
  const tenantId = `org:sysmint-${Date.now()}-${n++}`;
  const owner = client();
  const login = await owner.post('/host/openwop-app/test/login', { email: `sysmint-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId!, tenantId };
}
const mint = (orgId: string): string => `/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`;

async function realSignRequest(owner: ReturnType<typeof client>, tenantId: string, orgId: string) {
  const doc = await createDocument({ tenantId, orgId, title: 'Agreement', kind: 'doc', provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1' });
  await addVersion(tenantId, orgId, doc.documentId, { content: '# Agreement\n\nPlease sign.', producedBy: { kind: 'user', id: 'u1' } });
  const created = await owner.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/sign-requests`, {
    target: { kind: 'document', id: doc.documentId },
    signers: [{ email: 'signer@x.test', name: 'Sam', order: 0 }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const srid = created.body.signRequestId!;
  const req = await getSignRequestById(srid);
  return { srid, signerId: req!.signers[0]!.signerId };
}

describe('layer 1 — sign_request, a REAL signer', () => {
  it('the real flow still mints a working signer link; a member mint of the same signer is refused', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { srid, signerId } = await realSignRequest(owner, tenantId, orgId);

    // The legitimate mint (crm/signService.ts, visitor lane) still works end to end.
    const { __signerTokenForTest } = await import('../src/features/crm/signService.js');
    const token = __signerTokenForTest(srid, signerId);
    expect(token, 'requestSignature minted the signer link').toBeTruthy();
    const view = await client().get(`/host/openwop-app/public-sign/${token}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);

    // The member lane, naming the SAME real signer: only the gate can refuse this.
    const before = await owner.get(`${mint(orgId)}`);
    const refused = await owner.post(mint(orgId), { resourceType: 'sign_request', resourceId: `${srid}:${signerId}` });
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(JSON.stringify(refused.body)).not.toMatch(/"token"/);
    const after = await owner.get(`${mint(orgId)}`);
    expect(after.body.links?.length ?? 0, 'the refusal minted no link').toBe(before.body.links?.length ?? 0);
  });
});

describe('layer 2 — every system type is refused on the member route', () => {
  it.each(EXPECTED)('%s → 404, no token', async (resourceType) => {
    const { owner, orgId } = await ownerOrg();
    const r = await owner.post(mint(orgId), { resourceType, resourceId: `probe-${resourceType}` });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/"token"/);
  });
});

describe('layer 3 — the mint gate alone', () => {
  const visitorAdmitted: ResourceType[] = ['sign_request', 'booking_manage', 'collab_invite', 'commerce_order'];
  it.each(EXPECTED)('%s: the member lane is refused by the gate', async (resourceType) => {
    await expect(__assertMintAccessForTests(resourceType, 'org:gate-probe', 'user:member', 'any', { lane: 'member' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
  it.each(visitorAdmitted)('%s: the visitor lane passes the gate (the control)', async (resourceType) => {
    await expect(__assertMintAccessForTests(resourceType, 'org:gate-probe', 'system:test', 'any', { lane: 'visitor', why: 'test control' }))
      .resolves.toBeUndefined();
  });
  it('commerce_quote stays member-mintable at the gate (sharing a sent quote is the product)', async () => {
    expect(SYSTEM_MINT_ONLY.has('commerce_quote')).toBe(false);
    await expect(__assertMintAccessForTests('commerce_quote', 'org:gate-probe', 'user:member', 'any', { lane: 'member' }))
      .resolves.toBeUndefined();
  });
});

describe('layer 4 — census', () => {
  it('SYSTEM_MINT_ONLY is exactly the audited set', () => {
    expect([...SYSTEM_MINT_ONLY].sort()).toEqual([...EXPECTED].sort());
  });

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
  }

  /** Every `createLink(…, { lane: 'visitor' })` site under `src/` (host AND adopter
   *  code: an adopter's visitor mint of a new capability type must be caught too). */
  function visitorSites(): Array<{ file: string; type: string }> {
    const sites: Array<{ file: string; type: string }> = [];
    for (const file of walk(join(BACKEND, 'src'))) {
      const text = readFileSync(file, 'utf8');
      let at = text.indexOf("lane: 'visitor'");
      while (at !== -1) {
        const call = text.lastIndexOf('createLink(', at);
        if (call !== -1 && at - call < 600) {
          const span = text.slice(call, at);
          const literal = /resourceType: '([a-z_]+)'/.exec(span)?.[1];
          const ident = /resourceType: ([A-Z_][A-Z0-9_]*)/.exec(span)?.[1];
          const type = literal ?? (ident ? new RegExp(`const ${ident}(?::[^=]+)? = '([a-z_]+)'`).exec(text)?.[1] : undefined);
          sites.push({ file: file.slice(BACKEND.length + 1), type: type ?? '<unparsed>' });
        }
        at = text.indexOf("lane: 'visitor'", at + 1);
      }
    }
    return sites;
  }

  // CORRECTED 2026-11-24 (CasaVoga adopter false positive, via 76): this used to
  // require every visitor-lane site to mint a SYSTEM_MINT_ONLY type. An adopter's
  // visitor-lane `document` link (a view a member can already share) failed it,
  // and every white-label adding one would red on sync. The census is now keyed
  // by TYPE: every type is classified exactly once, and a visitor-lane site must
  // mint a CLASSIFIED type. A member-publishable type minted on the visitor lane
  // grants nothing a member could not already publish; a new type fails closed
  // until someone classifies it.
  it('every ResourceType is classified exactly once (system-only XOR member-publishable)', () => {
    const both = MEMBER_PUBLISHABLE.filter((t) => SYSTEM_MINT_ONLY.has(t));
    expect(both, 'a type cannot be both system-only and member-publishable').toEqual([]);
    // RESOURCE_TYPES is read at RUN time, so a type added to the union (by the
    // host, or by an adopter if the union is ever made extensible) lands here.
    const unclassified = RESOURCE_TYPES.filter((t) => !SYSTEM_MINT_ONLY.has(t) && !MEMBER_PUBLISHABLE.includes(t));
    expect(unclassified, 'a new share type: put it in SYSTEM_MINT_ONLY, or in MEMBER_PUBLISHABLE with a reason').toEqual([]);
    const unknown = MEMBER_PUBLISHABLE.filter((t) => !(RESOURCE_TYPES as readonly string[]).includes(t));
    expect(unknown, 'MEMBER_PUBLISHABLE names a type the host does not have').toEqual([]);
  });

  it('every visitor-lane createLink site in src/ mints a classified type', () => {
    const sites = visitorSites();
    // Floor, measured 2026-11-24: 7 host sites (approval, report, two invite
    // routes, order receipt, signer link, booking manage). A marker rename yields zero.
    expect(sites.length, JSON.stringify(sites)).toBeGreaterThanOrEqual(7);
    const classified = (t: string): boolean => SYSTEM_MINT_ONLY.has(t as ResourceType) || MEMBER_PUBLISHABLE.includes(t as ResourceType);
    expect(sites.filter((s) => !classified(s.type)), 'a visitor-lane mint of an unclassified (or unparsed) type').toEqual([]);
    // The host's own visitor mints are all system-only today. Pinned so a NEW host
    // visitor mint of a member-publishable type is a visible, reviewed change.
    const host = sites.filter((s) => !s.file.startsWith('src/adopter/'));
    expect(host.filter((s) => !SYSTEM_MINT_ONLY.has(s.type as ResourceType)), 'a host visitor-lane mint outside SYSTEM_MINT_ONLY').toEqual([]);
  });

  it('the classification fails closed on an unclassified type (the census is not vacuous)', () => {
    const probe = [...RESOURCE_TYPES, 'probe_capability_type'];
    expect(probe.filter((t) => !SYSTEM_MINT_ONLY.has(t as ResourceType) && !MEMBER_PUBLISHABLE.includes(t as ResourceType))).toEqual(['probe_capability_type']);
  });

  it("the frontend's SYSTEM_TYPES names the same set", () => {
    const page = readFileSync(join(REPO, 'frontend/react/src/features/sharing/SharingPage.tsx'), 'utf8');
    const m = /SYSTEM_TYPES[^=]*= new Set\(\[([^\]]*)\]\)/.exec(page);
    expect(m, 'SYSTEM_TYPES marker moved').not.toBeNull();
    const front = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(front).toEqual([...SYSTEM_MINT_ONLY].sort());
  });
});
