/**
 * WF-DOC-4 — the `render` durable lane is idempotent per (version, format).
 *
 * Before the fix every invocation minted a fresh Media library asset + serve
 * token, and the pdf lane REWROTE the immutable version's
 * `renderedMediaToken` — invalidating previously shared PDF links. Now:
 *   - a re-render of the SAME version converges on the SAME asset + token
 *     (pdf, slides, sheet — the durable formats);
 *   - the version's stamp is written once and never rewritten;
 *   - a NEW version renders its own asset (the stamp is per version, not
 *     per document).
 * Scratch exports (docx/epub/odt/latex) are TTL'd download-and-go and stay
 * per-call by design — this test does not cover them (stated non-coverage).
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import {
  createDocument, addVersion, getVersion, getDocument, renderDocument, _putVersionForTest,
} from '../src/features/documents/documentsService.js';
import { listAssetsForTenant } from '../src/features/media/mediaService.js';

const TENANT = 'org:doc-render-idem';
let ORG = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  ORG = org.orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function docWithContent(title: string): Promise<string> {
  const doc = await createDocument({ tenantId: TENANT, orgId: ORG, title, kind: 'doc', provenance: { producedBy: { kind: 'user', id: 'u-1' } }, createdBy: 'u-1' });
  await addVersion(TENANT, ORG, doc.documentId, { content: '# Hello\n\nA render probe.', producedBy: { kind: 'user', id: 'u-1' } });
  return doc.documentId;
}

const assetCount = async (): Promise<number> => (await listAssetsForTenant(TENANT)).length;

describe('WF-DOC-4 — durable render converges on one asset + token', () => {
  it('pdf: re-render returns the SAME token, mints NO second asset, never rewrites the stamp', async () => {
    const documentId = await docWithContent('Render idem pdf');
    const before = await assetCount();
    const first = await renderDocument(TENANT, ORG, documentId, 'actor', 'pdf');
    const afterFirst = await assetCount();
    expect(afterFirst).toBe(before + 1);

    const second = await renderDocument(TENANT, ORG, documentId, 'actor', 'pdf');
    expect(second.renderedMediaToken).toBe(first.renderedMediaToken);
    expect(second.url).toBe(first.url);
    expect(await assetCount(), 'a re-render must not mint a second library asset').toBe(afterFirst);

    const doc = await getDocument(TENANT, ORG, documentId);
    const version = await getVersion(TENANT, ORG, documentId, doc!.currentVersionId!);
    expect(version?.renderedMediaToken, 'the stamp must survive unrewritten').toBe(first.renderedMediaToken);
  });

  it('slides + sheet: each durable format converges on its own single asset', async () => {
    const documentId = await docWithContent('Render idem slides');
    const before = await assetCount();
    const s1 = await renderDocument(TENANT, ORG, documentId, 'actor', 'slides');
    const s2 = await renderDocument(TENANT, ORG, documentId, 'actor', 'slides');
    expect(s2.renderedMediaToken).toBe(s1.renderedMediaToken);
    const c1 = await renderDocument(TENANT, ORG, documentId, 'actor', 'sheet');
    const c2 = await renderDocument(TENANT, ORG, documentId, 'actor', 'sheet');
    expect(c2.renderedMediaToken).toBe(c1.renderedMediaToken);
    expect(c1.renderedMediaToken).not.toBe(s1.renderedMediaToken); // per-format, not per-version-global
    expect(await assetCount()).toBe(before + 2);
  });

  it('a NEW version gets its own render — the stamp is per version', async () => {
    const documentId = await docWithContent('Render idem versions');
    const v1 = await renderDocument(TENANT, ORG, documentId, 'actor', 'pdf');
    await addVersion(TENANT, ORG, documentId, { content: '# Hello v2\n\nChanged.', producedBy: { kind: 'user', id: 'u-1' } });
    const v2 = await renderDocument(TENANT, ORG, documentId, 'actor', 'pdf');
    expect(v2.renderedMediaToken).not.toBe(v1.renderedMediaToken);
    expect(v2.versionId).not.toBe(v1.versionId);
  });

  it('review F6 — two CONCURRENT renders of different formats both land their stamp (no lost update)', async () => {
    // Both calls read the version row before either writes: with a blind
    // last-writer-wins put, the loser's format stamp was ERASED from
    // `renderedTokens`, so the next render of that format minted a duplicate
    // asset (and, for pdf, restamped the token). The CAS retry loop merges
    // from the FRESH row, so both stamps survive.
    const documentId = await docWithContent('Render concurrent formats');
    const [pdf, sheet] = await Promise.all([
      renderDocument(TENANT, ORG, documentId, 'actor', 'pdf'),
      renderDocument(TENANT, ORG, documentId, 'actor', 'sheet'),
    ]);
    const doc = await getDocument(TENANT, ORG, documentId);
    const version = await getVersion(TENANT, ORG, documentId, doc!.currentVersionId!);
    expect(version?.renderedTokens?.pdf?.token, 'the pdf stamp was lost to the concurrent sheet write').toBe(pdf.renderedMediaToken);
    expect(version?.renderedTokens?.sheet?.token, 'the sheet stamp was lost to the concurrent pdf write').toBe(sheet.renderedMediaToken);
    // And the survivor property this whole stamp exists for: re-renders of
    // BOTH formats converge with no new asset.
    const before = await assetCount();
    expect((await renderDocument(TENANT, ORG, documentId, 'actor', 'pdf')).renderedMediaToken).toBe(pdf.renderedMediaToken);
    expect((await renderDocument(TENANT, ORG, documentId, 'actor', 'sheet')).renderedMediaToken).toBe(sheet.renderedMediaToken);
    expect(await assetCount()).toBe(before);
  });

  it('LEGACY pdf stamp (pre-renderedTokens row) is honored, not rewritten', async () => {
    const documentId = await docWithContent('Render idem legacy');
    const first = await renderDocument(TENANT, ORG, documentId, 'actor', 'pdf');
    // Simulate a pre-fix row: keep renderedMediaToken, strip the new map.
    const doc = await getDocument(TENANT, ORG, documentId);
    const version = await getVersion(TENANT, ORG, documentId, doc!.currentVersionId!);
    const { renderedTokens: _drop, ...legacy } = version!;
    // Write the legacy shape back through the same collection the service uses.
    await _putVersionForTest(legacy);
    const before = await assetCount();
    const again = await renderDocument(TENANT, ORG, documentId, 'actor', 'pdf');
    expect(again.renderedMediaToken).toBe(first.renderedMediaToken);
    expect(await assetCount()).toBe(before);
  });
});
