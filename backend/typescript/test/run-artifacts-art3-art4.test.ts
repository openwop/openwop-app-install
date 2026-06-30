/**
 * ADR 0083 Run-Artifacts — the two guards the first hardening pass left inspection-only
 * (post-`/code-review` follow-up):
 *   ART-3 — a per-org access resolver that REJECTS must fail-CLOSED (exclude that org) AND be
 *           LOGGED (a silent fail-closed under-populates the Library with no trail).
 *   ART-4 — the O(n·m) revision diff has a reachable size ceiling (was dead code at 2 MB, the
 *           exact max combined size; lowered to 1.5 MB so a pair of near-max docs 422s).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

// Partial mock: keep the real module (createDocument uses resolveOwnerSubject etc.) but make
// the per-org access resolver THROW for one org so we can exercise the rejection path.
vi.mock('../src/host/accessControlService.js', async (orig) => {
  const actual = await orig<typeof import('../src/host/accessControlService.js')>();
  return {
    ...actual,
    resolveEffectiveAccess: vi.fn(async (_tenantId: string, opts: { orgId: string }) => {
      if (opts.orgId === 'org-bad') throw new Error('access resolver down');
      return { roles: ['owner'], scopes: ['workspace:read'], basis: 'tenant-owner' };
    }),
  };
});

import { listArtifacts, diffArtifact } from '../src/host/artifactProjection.js';
import { createDocument, addVersion } from '../src/features/documents/documentsService.js';
import { __resetRunArtifactStore } from '../src/host/runArtifactStore.js';
import { __resetMedia } from '../src/features/media/mediaService.js';

function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    lines.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  });
  return fn().finally(() => spy.mockRestore()).then(() => lines.join(''));
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetRunArtifactStore();
  await __resetMedia();
});
afterEach(() => vi.restoreAllMocks());

describe('ART-3 — Library per-org access rejection is fail-closed AND logged', () => {
  it('excludes the org whose resolver threw, keeps the readable org, and logs the failure', async () => {
    await createDocument({ tenantId: 't', orgId: 't', title: 'Readable', kind: 'sow', provenance: { producedBy: { kind: 'user', id: 'u' } }, createdBy: 'u' });
    await createDocument({ tenantId: 't', orgId: 'org-bad', title: 'Unresolvable', kind: 'sow', provenance: { producedBy: { kind: 'user', id: 'u' } }, createdBy: 'u' });

    let titles: string[] = [];
    const out = await capture(async () => {
      titles = (await listArtifacts('t', 'u')).map((a) => a.title);
    });

    expect(titles).toEqual(['Readable']);                          // bad org fail-closed out — NOT a 500
    expect(out).toContain('artifact_library_org_access_failed');   // …and the rejection is logged
    expect(out).toContain('org-bad');
  });
});

describe('ART-4 — diff size ceiling is reachable', () => {
  it('422s when two near-max-size revisions exceed MAX_DIFF_CHARS (no O(n·m) spike)', async () => {
    const doc = await createDocument({ tenantId: 't', orgId: 't', title: 'Big', kind: 'sow', provenance: { producedBy: { kind: 'user', id: 'u' } }, createdBy: 'u' });
    const v1 = await addVersion('t', 't', doc.documentId, { content: 'a'.repeat(800_000), producedBy: { kind: 'user', id: 'u' } });
    const v2 = await addVersion('t', 't', doc.documentId, { content: 'b'.repeat(800_000), producedBy: { kind: 'user', id: 'u' } });

    // combined 1.6 MB > MAX_DIFF_CHARS (1.5 MB) ⇒ a 422, not a gigabyte LCS matrix.
    await expect(diffArtifact('t', 'u', `document:${doc.documentId}`, v1.versionId, v2.versionId))
      .rejects.toThrow(/too large to diff/);
  });

  it('diffs a normal pair of small revisions without tripping the cap', async () => {
    const doc = await createDocument({ tenantId: 't', orgId: 't', title: 'Small', kind: 'sow', provenance: { producedBy: { kind: 'user', id: 'u' } }, createdBy: 'u' });
    const v1 = await addVersion('t', 't', doc.documentId, { content: 'line one\nline two', producedBy: { kind: 'user', id: 'u' } });
    const v2 = await addVersion('t', 't', doc.documentId, { content: 'line one\nline TWO', producedBy: { kind: 'user', id: 'u' } });
    const res = await diffArtifact('t', 'u', `document:${doc.documentId}`, v1.versionId, v2.versionId);
    expect(res?.diff.format).toBe('text');
  });
});
