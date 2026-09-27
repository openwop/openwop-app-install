/** ADR 0346 4c — the generic app.* artifact renderer + its registry claim. */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AppFacetArtifactView } from '../AppFacetArtifact.js';
import { registerDefaultArtifactRenderers } from '../defaultRenderers.js';
import { getArtifactRenderer } from '../rendererRegistry.js';
import type { ArtifactProjection } from '../artifactClient.js';

afterEach(cleanup);
const artifact = { artifactId: 'a1', artifactTypeId: 'app.research' } as unknown as ArtifactProjection;

describe('AppFacetArtifactView', () => {
  it('renders sections, labelized keys, arrays, and nested objects as escaped text', () => {
    const content = JSON.stringify({
      personas: [{ name: 'Ada <b>x</b>', goals: ['run more'] }],
      visualDirection: { themePrimary: '#7c5cff' },
    });
    const { container } = render(<AppFacetArtifactView artifact={artifact} content={content} />);
    expect(container.textContent).toContain('Personas');
    expect(container.textContent).toContain('Visual Direction');
    expect(container.textContent).toContain('Theme Primary');
    expect(container.textContent).toContain('Ada <b>x</b>'); // escaped, not parsed
    expect(container.querySelector('b')).toBeNull();
  });
  it('bad JSON shows the error notice, never throws', () => {
    const { container } = render(<AppFacetArtifactView artifact={artifact} content="not json" />);
    expect(container.querySelector('.alert')).toBeTruthy();
  });
  it('every app.* type resolves to a renderer (never inert Markdown; lazy-split)', () => {
    registerDefaultArtifactRenderers();
    for (const id of ['app.research', 'app.prd', 'app.plan', 'app.audit']) {
      expect(getArtifactRenderer(id)?.Component).toBeTruthy();
    }
  });
});
