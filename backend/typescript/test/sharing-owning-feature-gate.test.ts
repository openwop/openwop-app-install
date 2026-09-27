/**
 * SHARE-1 — the owning-feature gate on the PUBLIC share lane.
 *
 * ADR 0434 graduated `sharing` off its own toggle, which removed the kill-switch
 * that had covered all twelve resource types; only five resolvers replaced it,
 * while `feature.ts`, `FEATURES.md` and `auth.ts` all kept claiming every
 * resolver applied one. This file is the ratchet for the fix.
 *
 * WHAT EACH TEST DISCRIMINATES, and what it does NOT:
 *  - the two behavioural cases drive REAL resolvers (`document` → `documents`,
 *    `commerce_quote` → `commerce`) through the real service. They discriminate
 *    the gate's presence on resolve AND on mint. They do NOT discriminate the
 *    frame-view or card lanes — those share `resolveActiveLink`, which is the
 *    reason the gate was put there rather than in each resolver, and the
 *    structural test below is what holds that line.
 *  - the parity test is the DRIFT guard: every non-null `toggleId` must be a
 *    registered toggle default, so an owning feature graduating to always-on
 *    turns CI red instead of silently darkening a public surface.
 *  - the null-inventory test pins the FOUR types that deliberately have no gate,
 *    so a fifth cannot be added by omission.
 *
 * ADDED IN R2 (adversarial review of this same change):
 *  - the OWNER-LIST test. The gate made three resource families darkenable,
 *    which made a state reachable that the management list had no vocabulary
 *    for — it rendered "Live". This pins the server half (`featureDisabled` on
 *    the wire, and no `cardTitle`/`resourceMissing` alongside it). It does NOT
 *    pin the chip or the copy; `frontend/.../deadLinkHonesty.test.tsx` does.
 *  - the SECOND drift direction. The parity guard above only fires when a NAMED
 *    toggle DISAPPEARS. The likelier drift is one APPEARING for `cms`/`kb`/
 *    `prompts` (all three previously had one), which would leave those types
 *    ungated behind a `toggleId: null` whose comment says no toggle exists.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { saveConfig, resolveOne } from '../src/host/featureToggles/service.js';
import { getToggleDefault, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { documentsFeature } from '../src/features/documents/feature.js';
import { commerceFeature } from '../src/features/commerce/feature.js';
import { createDocument, updateDocument, addVersion } from '../src/features/documents/documentsService.js';
import { createQuote, sendQuote } from '../src/features/commerce/quotes.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import {
  createLink,
  listLinks,
  resolveShared,
  resolveSharedCard,
  RESOURCE_TYPES,
  __resolverToggleIds,
  recordSharedFrameView,
  assertLiveLinkFor,
  resolveActiveResource,
} from '../src/features/sharing/sharingService.js';

const T = 'shr-gate-tenant';
let ORG = '';

/** Flip an owning feature's toggle for the whole tenant. */
async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default registered for '${id}' — the test harness is wrong, not the code`);
  await saveConfig({ ...d, status }, 'test');
}

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-sharegate-')) });
  initHostExtPersistence(await openStorage('memory://'));
  // No app boot in a service test — declare the two toggles under test.
  for (const f of [documentsFeature, commerceFeature]) {
    if (f.toggleDefault) registerToggleDefault(f.toggleDefault);
  }
  const org = await createOrg({ tenantId: T, createdBy: 'u1', name: 'Org' });
  ORG = org.orgId;
});

describe('SHARE-1 — a public link darkens when its OWNING feature is toggled off', () => {
  it('document: ON serves, OFF refuses, ON serves again (and the OFF state also blocks a fresh mint)', async () => {
    await setToggle('documents', 'on');
    const doc = await createDocument({
      tenantId: T, orgId: ORG, title: 'Statement of work', kind: 'sow',
      provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1',
    });
    await addVersion(T, ORG, doc.documentId, { content: 'THE SOW BODY', producedBy: { kind: 'user', id: 'u1' } });
    await updateDocument(T, ORG, doc.documentId, 'u1', { status: 'approved' });

    const link = await createLink(T, ORG, 'u1', { resourceType: 'document', resourceId: doc.documentId });

    // ON — the public lane serves it.
    const served = await resolveShared(link.token);
    expect(served.resourceType).toBe('document');
    expect(String(served.resource.content)).toContain('THE SOW BODY');

    // OFF — the SAME token now refuses, with the uniform 404 (never a reason
    // that would tell the holder which gate closed).
    await setToggle('documents', 'off');
    await expect(resolveShared(link.token)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    // …and the social-card lane refuses too. This is the SHARE-3 asymmetry:
    // before the one-gate fix, `card` could keep leaking title/description for
    // content whose `load` had gone dark.
    await expect(resolveSharedCard(link.token, 'https://example.test')).rejects.toMatchObject({ code: 'not_found' });
    // …and no NEW link can be minted while the owning feature is off.
    await expect(createLink(T, ORG, 'u1', { resourceType: 'document', resourceId: doc.documentId }))
      .rejects.toMatchObject({ code: 'not_found' });

    // ON again — the same token works. The gate is a live read, not a
    // destructive one-way flip.
    await setToggle('documents', 'on');
    expect((await resolveShared(link.token)).resourceType).toBe('document');
  });

  // SHWF-4 / ADR 0644 D4 — `resolveActiveLink`'s comment claims the gate covers
  // "EVERY public entry point (resolve, card, frame-view, and the two
  // capability-proof helpers)". Only `resolve` and `card` were asserted. The
  // centralization is the whole argument for not testing each of the eight gated
  // types — so it has to be the thing that is pinned. Before this test, moving
  // `owningFeatureEnabled` out of `resolveActiveLink` into the two resolve methods
  // left the entire suite GREEN while the three lanes below went ungated: an
  // unauthenticated analytics writer, commerce's public Accept capability proof,
  // and CRM's booking-reschedule / e-sign resolver.
  it('the gate covers the OTHER three public entry points, not just resolve + card', async () => {
    await setToggle('documents', 'on');
    const doc = await createDocument({
      tenantId: T, orgId: ORG, title: 'Gate coverage', kind: 'sow',
      provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1',
    });
    await addVersion(T, ORG, doc.documentId, { content: 'BODY', producedBy: { kind: 'user', id: 'u1' } });
    await updateDocument(T, ORG, doc.documentId, 'u1', { status: 'approved' });
    const link = await createLink(T, ORG, 'u1', { resourceType: 'document', resourceId: doc.documentId });

    // Non-vacuity: all three lanes work while the owning feature is ON.
    await expect(recordSharedFrameView(link.token, 3)).resolves.toBeUndefined();
    await expect(assertLiveLinkFor(link.token, 'document', doc.documentId, ORG)).resolves.toBeUndefined();
    expect((await resolveActiveResource(link.token, 'document')).resourceId).toBe(doc.documentId);

    // OFF: every one of them refuses with the same uniform 404.
    await setToggle('documents', 'off');
    await expect(recordSharedFrameView(link.token, 3)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    await expect(assertLiveLinkFor(link.token, 'document', doc.documentId, ORG)).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolveActiveResource(link.token, 'document')).rejects.toMatchObject({ code: 'not_found' });

    await setToggle('documents', 'on');
  });

  // SHWF-7 / ADR 0644 D6 — a REAL concurrency witness for the view cap. Every other
  // cap test is strictly sequential, so a regression replacing the compare-and-swap
  // in `countShareViewOrThrow` with a plain put went undetected. Driven at the
  // SERVICE level on purpose: routed through HTTP the two requests do not interleave
  // at the read-modify-write, so a route-level `Promise.all` is a VACUOUS version of
  // this test (measured — it stayed green under exactly that sabotage).
  it('two CONCURRENT views of a maxViews:1 link cannot both be served', async () => {
    await setToggle('documents', 'on');
    const doc = await createDocument({
      tenantId: T, orgId: ORG, title: 'Racy', kind: 'sow',
      provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1',
    });
    await addVersion(T, ORG, doc.documentId, { content: 'BODY', producedBy: { kind: 'user', id: 'u1' } });
    await updateDocument(T, ORG, doc.documentId, 'u1', { status: 'approved' });
    const link = await createLink(T, ORG, 'u1', { resourceType: 'document', resourceId: doc.documentId, maxViews: 1 });

    const settled = await Promise.allSettled([resolveShared(link.token), resolveShared(link.token)]);
    const served = settled.filter((r) => r.status === 'fulfilled').length;
    // EXACTLY one. Not "at least one" — over-serving a burn-after-reading link is
    // the defect, and it is only reachable under concurrency, which is precisely
    // the condition an attacker controls.
    expect(served).toBe(1);
  });

  // SHCD-1 / ADR 0644 D8 — the cap was enforced at THREE of six public entry
  // points. ADR 0644 D2 fixed the card lane and STOPPED THERE, which is fixing an
  // instance instead of the class. The sharpest consequence is an ORACLE: an
  // exhausted-but-real token still got 204 from the unauthenticated frame-view
  // writer while a fabricated one got 404, which is exactly the distinction the
  // uniform-404 posture exists to deny.
  it('an EXHAUSTED link is refused by the frame-view lane too, not just resolve + card', async () => {
    await setToggle('documents', 'on');
    const doc = await createDocument({
      tenantId: T, orgId: ORG, title: 'Oracle', kind: 'sow',
      provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1',
    });
    await addVersion(T, ORG, doc.documentId, { content: 'BODY', producedBy: { kind: 'user', id: 'u1' } });
    await updateDocument(T, ORG, doc.documentId, 'u1', { status: 'approved' });
    const link = await createLink(T, ORG, 'u1', { resourceType: 'document', resourceId: doc.documentId, maxViews: 1 });

    // Non-vacuity: the analytics lane works while the budget is unspent.
    await expect(recordSharedFrameView(link.token, 1)).resolves.toBeUndefined();

    await resolveShared(link.token);                       // burns the only view
    await expect(resolveShared(link.token)).rejects.toMatchObject({ code: 'not_found' });

    // The oracle, closed: a spent-but-real token must be indistinguishable from a
    // fabricated one on EVERY public lane.
    await expect(recordSharedFrameView(link.token, 1)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });

  it('commerce_quote: a priced offer with a public Accept stops resolving when `commerce` is off', async () => {
    await setToggle('commerce', 'on');
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u1', type: 'service', name: 'Implementation', price: 1000 });
    const quote = await createQuote({
      tenantId: T, orgId: ORG, createdBy: 'u1',
      lines: [{ productId: product.productId, quantity: 1 }],
    });
    await sendQuote(T, ORG, quote.quoteId, { actor: 'u1' });
    const link = await createLink(T, ORG, 'u1', { resourceType: 'commerce_quote', resourceId: quote.quoteId });

    expect((await resolveShared(link.token)).resourceType).toBe('commerce_quote');

    await setToggle('commerce', 'off');
    await expect(resolveShared(link.token)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });

    await setToggle('commerce', 'on');
    expect((await resolveShared(link.token)).resourceType).toBe('commerce_quote');
  });

  it('the gate reads the LINK tenant, not the caller — the public caller has no tenant at all', async () => {
    // The public lane is unauthenticated: there IS no caller tenant, so a gate
    // keyed on one (the org-invitations defect) could only ever fail open or
    // fail closed for everyone. Proven by construction: `resolveShared` takes a
    // token and nothing else, and toggling a DIFFERENT tenant's copy of the
    // feature off leaves this link alone.
    await setToggle('documents', 'on');
    const doc = await createDocument({
      tenantId: T, orgId: ORG, title: 'Owner-tenant doc', kind: 'sow',
      provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1',
    });
    await addVersion(T, ORG, doc.documentId, { content: 'body', producedBy: { kind: 'user', id: 'u1' } });
    await updateDocument(T, ORG, doc.documentId, 'u1', { status: 'approved' });
    const link = await createLink(T, ORG, 'u1', { resourceType: 'document', resourceId: doc.documentId });

    const other = 'shr-gate-other-tenant';
    const d = getToggleDefault('documents')!;
    await saveConfig({ ...d, status: 'on', tenantOverrides: { [other]: { status: 'off' } } }, 'test');
    // The OTHER tenant is off; the link's tenant is on ⇒ still served.
    expect(await resolveOne('documents', { tenantId: other })).toMatchObject({ enabled: false });
    expect((await resolveShared(link.token)).resourceType).toBe('document');
    // Flip the LINK's tenant off instead ⇒ dark. Same token, same call, the
    // only variable moved is whose toggle it is.
    await saveConfig({ ...d, status: 'on', tenantOverrides: { [T]: { status: 'off' } } }, 'test');
    await expect(resolveShared(link.token)).rejects.toMatchObject({ code: 'not_found' });
    await saveConfig({ ...d, status: 'on' }, 'test');
  });

  it('the OWNER’s list says the feature is off — it does not report the link as Live', async () => {
    // R2 review F1. The gate made `document` darkenable; `listLinks` computed
    // the same boolean and then THREW IT AWAY, so the management row rendered a
    // green "Live" chip for a link the resolver now refuses — the exact class of
    // lie the rest of this change closes, reintroduced on the owner's side.
    //
    // What this discriminates: the presence of `featureDisabled` on the wire, and
    // that the row does NOT also claim the resource is missing (the gate skips
    // the card lookup, so "gone" is a thing the server does not know here). It
    // does NOT discriminate the chip/copy — `deadLinkHonesty.test.tsx` owns that.
    await setToggle('documents', 'on');
    const doc = await createDocument({
      tenantId: T, orgId: ORG, title: 'Gated list doc', kind: 'sow',
      provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1',
    });
    await addVersion(T, ORG, doc.documentId, { content: 'body', producedBy: { kind: 'user', id: 'u1' } });
    await updateDocument(T, ORG, doc.documentId, 'u1', { status: 'approved' });
    const link = await createLink(T, ORG, 'u1', { resourceType: 'document', resourceId: doc.documentId });

    const on = (await listLinks(T, ORG)).find((l) => l.tokenHash === link.tokenHash)!;
    expect(on.featureDisabled, 'the feature is ON — nothing to flag').toBeUndefined();
    expect(on.cardTitle).toBe('Gated list doc');

    await setToggle('documents', 'off');
    const off = (await listLinks(T, ORG)).find((l) => l.tokenHash === link.tokenHash)!;
    expect(off.featureDisabled, 'the resolver refuses this link — the owner must be told why').toBe(true);
    expect(off.cardTitle, 'a darkened feature must not keep leaking its card title').toBeUndefined();
    expect(off.resourceMissing, 'the gate skipped the lookup, so “gone” is not something the server knows').toBeUndefined();

    await setToggle('documents', 'on');
  });
});

describe('SHARE-1 — the structural guards', () => {
  it('every resource type declares a toggleId (no type can be added by omission)', () => {
    const declared = Object.keys(__resolverToggleIds()).sort();
    expect(declared).toEqual([...RESOURCE_TYPES].sort());
  });

  it('DRIFT GUARD: every non-null toggleId is a REGISTERED toggle default', async () => {
    // Why this exists: `resolveOne` returns null for a feature that declares no
    // default, and the gate is fail-closed — so if an owning feature graduates
    // to always-on, every link of that type would go permanently dark with no
    // error anywhere. This test is the tripwire for that graduation. It needs
    // the full feature registry, so it boots the app.
    const { createApp } = await import('../src/index.js');
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    const ids = __resolverToggleIds();
    const unregistered = Object.entries(ids)
      .filter(([, toggleId]) => toggleId !== null && getToggleDefault(toggleId) === null)
      .map(([type, toggleId]) => `${type} → '${toggleId}'`);
    expect(unregistered, 'a resolver names a toggle no feature declares — the public lane for that type would fail closed forever').toEqual([]);
  });

  it('exactly FOUR types are deliberately ungated, and they are named', () => {
    // The honest half of SHARE-1: `cms`, `kb` and `prompts` graduated to
    // always-on and conversations are the core chat store, so no toggle exists
    // to consult for these four. Pinned by NAME so a fifth ungated type is a
    // deliberate, reviewable edit rather than a silent omission.
    const ungated = Object.entries(__resolverToggleIds())
      .filter(([, id]) => id === null)
      .map(([type]) => type)
      .sort();
    expect(ungated).toEqual(['cms_page', 'conversation', 'kb_collection', 'prompt']);
  });

  it('DRIFT GUARD, the OTHER direction: the ungated types still declare NO toggle', () => {
    // R2 review F4 — the guard above this one is one-directional. It turns red
    // when a NAMED toggle disappears, and says nothing when one APPEARS. That is
    // the likelier drift: `cms`, `kb` and `prompts` each HAD a toggle and
    // graduated off it (ADR 0434), so re-introducing one is a normal product
    // decision — and it would leave those resource types silently ungated on the
    // public lane behind a `toggleId: null` whose source comment asserts no
    // toggle exists. This test is the tripwire for that direction. (Runs after
    // the guard above, which boots the full feature registry.)
    for (const id of ['cms', 'kb', 'prompts']) {
      expect(
        getToggleDefault(id),
        `'${id}' now declares a toggle default — its share resolver must stop claiming \`toggleId: null\` and start gating on it`,
      ).toBeNull();
    }
  });
});
