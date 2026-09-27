/**
 * `DOCWF-2` / `DOCWF-3` — the document delete cascade honours a legal hold, and it takes the
 * rendered bytes with it.
 *
 * BORN RED on both.
 *
 * `DOCWF-2`: the cascade destroys versions (whose `content` is declared PII), the rendered
 * assets and the public share links, and ran under a legal hold without a word. Same shape as
 * the projects cascade one iteration earlier — and, like it, structurally INVISIBLE to
 * `destructive-lane-census.test.ts`, whose population derives from storage-level deletes plus
 * seam runners. A `DurableCollection.delete()` is neither. That is now two lanes in two
 * iterations found the same way, which is the deeper finding.
 *
 * `DOCWF-3`: the cascade already purged public share links — its own comment says the point is
 * that no row may "report in use externally" — while the rendered PDF/DOCX, the actual content,
 * kept serving from a PUBLIC token-authed route forever. Incomplete against the function's own
 * stated intent, not a missing nicety.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { setRetentionHold, clearRetentionHold, RetentionHoldError } from '../src/host/retentionHold.js';
import {
  createDocument, addVersion, deleteDocument, getDocument, listVersions,
} from '../src/features/documents/documentsService.js';
import { createAsset, listAssets } from '../src/features/media/mediaService.js';

const TENANT = 'default';
let server: http.Server;
let ORG = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, name: 'DocDelete Org', createdBy: 'user:owner' });
  ORG = org.orgId;
  await createMember({ tenantId: TENANT, orgId: ORG, displayName: 'Owner', subject: 'user:owner', roles: ['admin'] });
});
afterAll(async () => {
  await clearRetentionHold(TENANT).catch(() => undefined);
  await new Promise<void>((res) => server.close(() => res()));
});

async function seedDocWithRenderedAsset(title: string, token: string): Promise<string> {
  const doc = await createDocument({
    tenantId: TENANT, orgId: ORG, title, kind: 'sow', format: 'markdown', createdBy: 'user:owner',
    provenance: { producedBy: { kind: 'user', id: 'user:owner' } },
  } as never);
  await addVersion(TENANT, ORG, doc.documentId, {
    content: '# body', producedBy: { kind: 'user', id: 'user:owner' }, renderedMediaToken: token,
  } as never);
  // The rendered artefact the export path mints — served by the PUBLIC token route.
  await createAsset({
    tenantId: TENANT, orgId: ORG, name: `${title}.pdf`, contentType: 'application/pdf',
    sizeBytes: 10, storageRef: `ref-${token}`, serveToken: token, uploadedBy: 'user:owner',
  } as never);
  return doc.documentId;
}

const assetExists = async (token: string): Promise<boolean> =>
  (await listAssets(TENANT, ORG)).some((a) => a.serveToken === token);

describe('DOCWF-2 — a legal hold stops the document cascade', () => {
  it('BORN RED — a held tenant REFUSES, and the document, its versions and its rendered asset all SURVIVE', async () => {
    const token = 'tok-held-0001';
    const id = await seedDocWithRenderedAsset('Held SOW', token);
    await setRetentionHold(TENANT, 'litigation: Acme v. Foo');
    try {
      await expect(deleteDocument(TENANT, ORG, id)).rejects.toBeInstanceOf(RetentionHoldError);
      // Survival, not just the throw — a gate that refuses AFTER destroying is the failure this
      // guards, and the projects witness one iteration ago missed exactly that by asserting the
      // row and not the FIRST thing the cascade destroys.
      expect(await assetExists(token), 'the rendered asset — destroyed FIRST — must survive').toBe(true);
      expect(await listVersions(TENANT, ORG, id), 'versions must survive').toHaveLength(1);
      expect(await getDocument(TENANT, ORG, id), 'the document row must survive').toBeTruthy();
    } finally { await clearRetentionHold(TENANT); }
  });
});

describe('DOCWF-3 — deleting a document takes its rendered bytes with it', () => {
  it('BORN RED — the publicly-served rendered asset is gone after the delete', async () => {
    const token = 'tok-free-0002';
    const id = await seedDocWithRenderedAsset('Free SOW', token);
    expect(await assetExists(token), 'precondition: the rendered asset is servable').toBe(true);

    expect(await deleteDocument(TENANT, ORG, id)).toBe(true);

    expect(await getDocument(TENANT, ORG, id)).toBeNull();
    expect(await assetExists(token), 'the rendered bytes must not outlive the document').toBe(false);
  });

  it('another document’s rendered asset is untouched — the purge is scoped by token', async () => {
    // The cascade looks assets up by the tokens ITS versions carry; a token-set bug would take
    // a bystander's export with it.
    const mine = 'tok-mine-0003';
    const theirs = 'tok-theirs-0004';
    const id = await seedDocWithRenderedAsset('Mine', mine);
    await seedDocWithRenderedAsset('Theirs', theirs);

    await deleteDocument(TENANT, ORG, id);

    expect(await assetExists(mine)).toBe(false);
    expect(await assetExists(theirs), 'a bystander export must survive').toBe(true);
  });
});
