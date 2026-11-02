/**
 * Launch-studio → document resolution (ADR 0056). A sharedArtifactRef carrying a
 * documentId resolves to the owned Document's projection via the seam; refs without
 * one pass through unchanged.
 *
 * TST-DKE-2 (grade-tests wave 72). "Tenant-scoped" is shown both ways: the same
 * ref resolves for t1 and not for t2 (the resolver fixture keys on the tenant the
 * surface passes). Red when (w72 probes): the surface passes anything but its own
 * tenant (lst-tenant), or a resolved document is not attached (lst-attach).
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

    // The same ref from another tenant's surface resolves to nothing.
    const other = (await createLaunchStudioSurface({ tenantId: 't2' }).resolveLinkedArtifacts({ studio, sourceCanvasTypeId: 'canvas.brief' })) as { sharedArtifacts: Array<Record<string, unknown>> };
    expect(other.sharedArtifacts.find((r) => r.artifactId === 'a1')?.document).toBeUndefined();
  });

  it('passes refs through unchanged when no resolver is installed', async () => {
    const surf = createLaunchStudioSurface({ tenantId: 't1' });
    const studio = { studioId: 's2', sharedArtifactRefs: [{ artifactId: 'a1', artifactTypeId: 'doc.prd', documentId: 'doc:x' }], steps: [] };
    const out = (await surf.resolveLinkedArtifacts({ studio, sourceCanvasTypeId: 'canvas.brief' })) as { sharedArtifacts: Array<Record<string, unknown>> };
    expect(out.sharedArtifacts[0].document).toBeUndefined();
  });
});
