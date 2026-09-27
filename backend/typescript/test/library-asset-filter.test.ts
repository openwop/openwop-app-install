/**
 * Library asset filter (ADR 0083 §Amendment 2026-07-05) — the Library is an ASSET
 * library, not a run log. `isLibraryAsset` keeps documents + media + typed/file run
 * artifacts and drops the raw inline run-output fallback (kind data/text/markdown,
 * no artifactTypeId) that produced the `{`-named rows.
 */
import { describe, it, expect } from 'vitest';
import { isLibraryAsset, type ArtifactProjection } from '../src/host/artifactProjection.js';

function proj(p: Partial<ArtifactProjection>): ArtifactProjection {
  return {
    artifactId: 'a', tenantId: 't', orgId: 'o', source: 'run-event', sourceId: 's',
    title: 'x', kind: 'data', format: 'application/json', status: 'ready',
    createdBy: { kind: 'run', id: 'r' }, createdAt: '2026-07-05T00:00:00Z', provenance: {},
    ...p,
  };
}

describe('isLibraryAsset — the Library is an asset library, not a run log', () => {
  it('excludes raw inline run outputs (data / text / markdown, no artifactTypeId)', () => {
    expect(isLibraryAsset(proj({ source: 'run-event', kind: 'data' }))).toBe(false);
    expect(isLibraryAsset(proj({ source: 'run-event', kind: 'text' }))).toBe(false);
    expect(isLibraryAsset(proj({ source: 'run-event', kind: 'markdown' }))).toBe(false);
  });

  it('keeps typed run artifacts — slide decks, CAD, designs, code results, …', () => {
    for (const artifactTypeId of ['canvas.slides', 'canvas.cad', 'canvas.campaign', 'canvas.app-builder', 'code.execution-result', 'interactive.chart']) {
      expect(isLibraryAsset(proj({ source: 'run-event', kind: 'data', artifactTypeId })), artifactTypeId).toBe(true);
    }
  });

  it('keeps concrete run-event file links', () => {
    expect(isLibraryAsset(proj({ source: 'run-event', kind: 'file' }))).toBe(true);
  });

  it('always keeps documents and media (assets by construction)', () => {
    expect(isLibraryAsset(proj({ source: 'document', kind: 'sow' }))).toBe(true);
    expect(isLibraryAsset(proj({ source: 'media', kind: 'image' }))).toBe(true);
    expect(isLibraryAsset(proj({ source: 'media', kind: 'video' }))).toBe(true);
    expect(isLibraryAsset(proj({ source: 'media', kind: 'pdf' }))).toBe(true);
  });
});
