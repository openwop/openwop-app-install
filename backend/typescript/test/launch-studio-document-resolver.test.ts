/**
 * Launch-studio → document resolution (ADR 0056). A sharedArtifactRef carrying a
 * documentId resolves to the owned Document's projection via the seam; refs without
 * one pass through unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createLaunchStudioSurface, setLaunchStudioDocumentResolver } from '../src/host/launchStudioSurface.js';

afterEach(() => setLaunchStudioDocumentResolver(null));

describe('launch-studio document resolution', () => {
  it('resolves a ref.documentId via the seam (tenant-scoped); passes other refs through', async () => {
    setLaunchStudioDocumentResolver(async (tenantId, documentId) =>
      tenantId === 't1' && documentId === 'doc:x' ? { documentId, title: 'Linked PRD', status: 'approved' } : null);

    const surf = createLaunchStudioSurface({ tenantId: 't1' });
    const studio = {
      studioId: 's1',
      sharedArtifactRefs: [
        { artifactId: 'a1', artifactTypeId: 'doc.prd', documentId: 'doc:x' },
        { artifactId: 'a2', artifactTypeId: 'brand.kit' },
      ],
      steps: [],
    };
    const out = (await surf.resolveLinkedArtifacts({ studio, sourceCanvasTypeId: 'canvas.brief' })) as { sharedArtifacts: Array<Record<string, unknown>> };
    const linked = out.sharedArtifacts.find((r) => r.artifactId === 'a1');
    expect(linked?.document).toMatchObject({ title: 'Linked PRD', status: 'approved' });
    const plain = out.sharedArtifacts.find((r) => r.artifactId === 'a2');
    expect(plain?.document).toBeUndefined();
  });

  it('passes refs through unchanged when no resolver is installed', async () => {
    const surf = createLaunchStudioSurface({ tenantId: 't1' });
    const studio = { studioId: 's2', sharedArtifactRefs: [{ artifactId: 'a1', artifactTypeId: 'doc.prd', documentId: 'doc:x' }], steps: [] };
    const out = (await surf.resolveLinkedArtifacts({ studio, sourceCanvasTypeId: 'canvas.brief' })) as { sharedArtifacts: Array<Record<string, unknown>> };
    expect(out.sharedArtifacts[0].document).toBeUndefined();
  });
});
