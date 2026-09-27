/**
 * reviewProjection media-asset enrichment (ADR 0458 §2.4) — the reviews inbox
 * `ReviewCard` renders `review.assets` directly, so the projection must populate
 * a media asset's serve URL + MIME (lockstep with the FE `ReviewAsset`). A
 * media-source artifact gets `url` + `mimeType`; a document/text artifact gets
 * neither (a MIME is never guessed); an inline-content asset is never fetched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../artifactProjection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../artifactProjection.js')>();
  return { ...actual, getArtifact: vi.fn(), getArtifactRevision: vi.fn() };
});

import { withMediaAssets, type ReviewRequest, type ReviewAsset } from '../reviewProjection.js';
import {
  getArtifact,
  getArtifactRevision,
  type ArtifactProjection,
  type ArtifactRevisionProjection,
} from '../artifactProjection.js';

const mockGetArtifact = vi.mocked(getArtifact);
const mockGetRevision = vi.mocked(getArtifactRevision);

const ctx = { tenantId: 't1', subjectRef: 'user:1' };

function reviewWithAsset(asset: ReviewAsset): ReviewRequest {
  return {
    reviewId: 'interrupt:it-1',
    source: 'interrupt',
    kind: 'approval',
    status: 'pending',
    tenantId: 't1',
    requestedAt: '2026-07-21T00:00:00Z',
    actions: [],
    provenanceRefs: [],
    assets: [asset],
  };
}

function mediaArtifact(): ArtifactProjection {
  return {
    artifactId: 'media:asset-1', tenantId: 't1', orgId: 'org-1',
    source: 'media', sourceId: 'asset-1', title: 'Cover',
    kind: 'image', format: 'image/png', status: 'final',
    latestRevisionId: 'asset-1:1',
    createdBy: { kind: 'user', id: 'u1' }, createdAt: '2026-07-21T00:00:00Z',
    provenance: {},
  };
}

function docArtifact(): ArtifactProjection {
  return {
    artifactId: 'document:doc-1', tenantId: 't1', orgId: 'org-1',
    source: 'document', sourceId: 'doc-1', title: 'Outline',
    kind: 'markdown', format: 'markdown', status: 'draft',
    latestRevisionId: 'v1',
    createdBy: { kind: 'user', id: 'u1' }, createdAt: '2026-07-21T00:00:00Z',
    provenance: {},
  };
}

function mediaRevision(): ArtifactRevisionProjection {
  return {
    revisionId: 'asset-1:1', artifactId: 'media:asset-1', version: 1,
    content: '/v1/host/openwop-app/assets/tok123', // the serve URL
    createdBy: { kind: 'user', id: 'u1' }, createdAt: '2026-07-21T00:00:00Z',
  };
}

describe('withMediaAssets', () => {
  beforeEach(() => { mockGetArtifact.mockReset(); mockGetRevision.mockReset(); });

  it('populates url + mimeType for a media-source artifact binding', async () => {
    mockGetArtifact.mockResolvedValue(mediaArtifact());
    mockGetRevision.mockResolvedValue(mediaRevision());
    const out = await withMediaAssets(reviewWithAsset({ label: 'Cover', artifactId: 'media:asset-1', revisionId: 'asset-1:1' }), ctx);
    expect(out.assets?.[0]).toMatchObject({
      artifactId: 'media:asset-1',
      mimeType: 'image/png',
      url: '/v1/host/openwop-app/assets/tok123',
    });
  });

  it('leaves url + mimeType undefined for a document (text) artifact — never guesses a MIME', async () => {
    mockGetArtifact.mockResolvedValue(docArtifact());
    const out = await withMediaAssets(reviewWithAsset({ label: 'Outline', artifactId: 'document:doc-1', revisionId: 'v1' }), ctx);
    expect(out.assets?.[0]?.mimeType).toBeUndefined();
    expect(out.assets?.[0]?.url).toBeUndefined();
    expect(mockGetRevision).not.toHaveBeenCalled(); // early return before any content fetch
  });

  it('does not resolve an artifact for an inline-content asset', async () => {
    const out = await withMediaAssets(reviewWithAsset({ label: 'Option A', content: 'a drafted lesson' }), ctx);
    expect(out.assets?.[0]).toEqual({ label: 'Option A', content: 'a drafted lesson' });
    expect(mockGetArtifact).not.toHaveBeenCalled();
  });

  it('returns the review unchanged when it carries no assets', async () => {
    const review = { ...reviewWithAsset({ content: 'x' }), assets: undefined };
    const out = await withMediaAssets(review, ctx);
    expect(out).toBe(review);
    expect(mockGetArtifact).not.toHaveBeenCalled();
  });
});
