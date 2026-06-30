/**
 * Artifact-renderer registry (ADR 0153 Phase 0) — the seam that replaced the
 * hardcoded artifactTypeId chain in ArtifactWorkbench. Verifies exact-vs-predicate
 * precedence, the unknown-type null fallback, and overwrite semantics (mirrors the
 * CardRegistry contract).
 */
import { type ComponentType } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerArtifactRenderer,
  getArtifactRenderer,
  listArtifactRenderers,
  clearArtifactRenderers,
  type ArtifactRendererProps,
} from '../artifacts/rendererRegistry.js';

// A function component may legitimately return null (ReactNode) — type the stubs
// as ComponentType so no cast is needed (the `as unknown as` form is banned).
const Stub: ComponentType<ArtifactRendererProps> = () => null;

describe('artifact renderer registry', () => {
  beforeEach(() => clearArtifactRenderers());

  it('returns null for an unknown type (Markdown fallback in the workbench)', () => {
    expect(getArtifactRenderer('canvas.nope')).toBeNull();
    expect(getArtifactRenderer(undefined)).toBeNull();
  });

  it('resolves an exact artifactTypeId match', () => {
    registerArtifactRenderer({ artifactTypeId: 'canvas.slides', Component: Stub });
    expect(getArtifactRenderer('canvas.slides')?.Component).toBe(Stub);
  });

  it('prefers an exact match over a predicate', () => {
    const Exact: ComponentType<ArtifactRendererProps> = () => null;
    registerArtifactRenderer({ match: (id) => id.startsWith('interactive.'), Component: Stub });
    registerArtifactRenderer({ artifactTypeId: 'interactive.mermaid', Component: Exact });
    expect(getArtifactRenderer('interactive.mermaid')?.Component).toBe(Exact);
    // a non-exact interactive.* still falls to the predicate
    expect(getArtifactRenderer('interactive.html')?.Component).toBe(Stub);
  });

  it('uses predicate registration order for the first match', () => {
    const First: ComponentType<ArtifactRendererProps> = () => null;
    registerArtifactRenderer({ match: (id) => id.startsWith('canvas.'), Component: First });
    registerArtifactRenderer({ match: (id) => id === 'canvas.slides', Component: Stub });
    expect(getArtifactRenderer('canvas.slides')?.Component).toBe(First);
  });

  it('warns and overwrites on a duplicate exact registration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const A: ComponentType<ArtifactRendererProps> = () => null;
    registerArtifactRenderer({ artifactTypeId: 'canvas.slides', Component: Stub });
    registerArtifactRenderer({ artifactTypeId: 'canvas.slides', Component: A });
    expect(getArtifactRenderer('canvas.slides')?.Component).toBe(A);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('canvas.slides'));
    warn.mockRestore();
  });

  it('ignores a registration with neither artifactTypeId nor match', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerArtifactRenderer({ Component: Stub });
    expect(listArtifactRenderers()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
