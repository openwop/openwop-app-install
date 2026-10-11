/**
 * DOC2-B1 / UX_UPGRADE-documents ROUND 3 — the R2 known-open retention gap, closed
 * (the approved-version pin is also retained, ADR 0838 D2 — covered by the purger's
 * current-set, not asserted here).
 *
 * Sabotage-witnessed (grade-tests w14): dropping `currentVersionId` from the
 * retained set, or returning 0 unconditionally, reds the purge case; dropping the
 * classification guard reds the non-PII case; ignoring the operator cutoff reds the
 * past-cutoff case.
 *
 * R2 deferred the purger because "the correct retention age for a business
 * document is a product decision" — and it is, but the AGE is the operator's
 * input to the host seam (`purgeRetained` passes the cutoff in), not the
 * purger's to decide. What was missing was the MECHANISM. Scope is narrow by
 * design: only NON-CURRENT versions (history) older than the cutoff go; the
 * document row and its current version are never touched, so live content can
 * never age away — what goes is stale PII in superseded revisions (the
 * declared `documents:version.content` field).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import {
  createDocument, getDocument, addVersion, listVersions,
} from '../src/features/documents/documentsService.js';
import { purgeRetained } from '../src/host/retentionPurger.js';

const TENANT = 'org:doc-retention';
let ORG = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // createApp registers the documents retention purger; no listener is needed.
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  ORG = org.orgId;
});

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

async function docWithHistory(): Promise<{ documentId: string; v1: string; v2: string }> {
  const doc = await createDocument({ tenantId: TENANT, orgId: ORG, title: 'Plan', kind: 'note', provenance: { producedBy: { kind: 'user', id: 'u-1' } }, createdBy: 'u-1' });
  const v1 = await addVersion(TENANT, ORG, doc.documentId, { content: 'draft one — names Alice', producedBy: { kind: 'user', id: 'u-1' } });
  const v2 = await addVersion(TENANT, ORG, doc.documentId, { content: 'final — no names', producedBy: { kind: 'user', id: 'u-1' } });
  return { documentId: doc.documentId, v1: v1.versionId, v2: v2.versionId };
}

describe('R3 — age-based retention reaches document version HISTORY, and only history', () => {
  it('purges the superseded version, never the current one or the document row', async () => {
    const { documentId, v1, v2 } = await docWithHistory();
    const results = await purgeRetained(TENANT, 'confidential-pii', FUTURE);
    const docsResult = results.find((r) => r.feature === 'documents');
    expect(docsResult?.ok).toBe(true);
    expect(docsResult!.deleted).toBeGreaterThanOrEqual(1);
    const remaining = (await listVersions(TENANT, ORG, documentId)).map((v) => v.versionId);
    expect(remaining).not.toContain(v1);   // history purged
    expect(remaining).toContain(v2);       // the CURRENT version survives any cutoff
    expect((await getDocument(TENANT, ORG, documentId))?.currentVersionId).toBe(v2); // the row is untouched
  });

  it('a non-PII classification purges NOTHING (fail-closed polarity)', async () => {
    const { documentId, v1, v2 } = await docWithHistory();
    await purgeRetained(TENANT, 'internal', FUTURE);
    const remaining = (await listVersions(TENANT, ORG, documentId)).map((v) => v.versionId);
    expect(remaining).toContain(v1);
    expect(remaining).toContain(v2);
  });

  it('a cutoff OLDER than the history purges nothing (the age comparison is real)', async () => {
    const { documentId, v1, v2 } = await docWithHistory();
    await purgeRetained(TENANT, 'confidential-pii', PAST);
    const remaining = (await listVersions(TENANT, ORG, documentId)).map((v) => v.versionId);
    expect(remaining).toContain(v1); // superseded, but younger than the cutoff
    expect(remaining).toContain(v2);
  });
});
