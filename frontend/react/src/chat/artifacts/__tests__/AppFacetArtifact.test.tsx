/** ADR 0346 4c — the generic app.* artifact renderer + its registry claim. */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AppFacetArtifactView } from '../AppFacetArtifact.js';
import { registerDefaultArtifactRenderers } from '../defaultRenderers.js';
import { getArtifactRenderer } from '../rendererRegistry.js';
import type { ArtifactProjection } from '../artifactClient.js';

afterEach(cleanup);
const artifact: ArtifactProjection = {
  artifactId: 'run-event:r:n', tenantId: 't', orgId: 'org', source: 'run-event', sourceId: 'r:n',
  title: 'Research', kind: 'json', format: 'application/json', status: 'final', artifactTypeId: 'app.research',
  createdBy: { kind: 'run', id: 'run1' }, createdAt: '2026-06-20T00:00:00.000Z', provenance: { runId: 'run1' },
};

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
    expect(container.querySelector('.alert')?.textContent).toBe('This artifact payload could not be read.');
  });
  it('every app.* type resolves to a renderer (never inert Markdown; lazy-split)', () => {
    registerDefaultArtifactRenderers();
    const reg = getArtifactRenderer('app.research');
    expect(reg?.Component).toBeTruthy();
    expect(reg?.editable).toBe(false); // the structured app.* view, not an editable interactive.* renderer
    for (const id of ['app.prd', 'app.plan', 'app.audit']) {
      expect(getArtifactRenderer(id)).toBe(reg); // ONE generic registration claims every app.* type
    }
  });
});
