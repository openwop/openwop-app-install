/**
 * `ctx.launchStudio` host surface (`host.launchStudio`,
 * `spec/v1/host-capabilities.md` §host.launchStudio) — the
 * `vendor.myndhyve.launch-studio` pack's multi-canvas studio backbone.
 *
 * A studio is a configuration record (steps + shared artifacts + brand/design/
 * PRD ids); the surface is a lookup + pure-computation context derivation. Task
 * dispatch (`dispatchStackItems`) delegates to `ctx.kanban` (already wired), so
 * launch-studio is fully real once both surfaces exist. The demo seeds one
 * studio so `getStudio` returns real data; unknown ids return null per spec.
 */

import { createLogger } from '../observability/logger.js';
import type { BundleScope } from './inMemorySurfaces.js';

const log = createLogger('host.launchStudio');

interface Studio {
  studioId: string;
  brandId?: string;
  designSystemId?: string;
  prdId?: string;
  /** A shared artifact ref MAY point at a real owned Document (ADR 0056) — the
   *  single-owner direction (launch-studio references documents, never forks them). */
  sharedArtifactRefs: Array<{ artifactId: string; artifactTypeId: string; documentId?: string }>;
  steps: Array<{ stepId: string; canvasTypeId: string; projectId?: string }>;
}

/**
 * Fill-a-seam (ADR 0056): the documents feature installs a resolver so launch-studio
 * can resolve a `sharedArtifactRef.documentId` to the owned Document's projection —
 * without `core`/host importing the feature (mirrors `setKnowledgeBackend`).
 */
export type LaunchStudioDocumentResolver = (tenantId: string, documentId: string) => Promise<{ documentId: string; title: string; status: string } | null>;
let _docResolver: LaunchStudioDocumentResolver | null = null;
export function setLaunchStudioDocumentResolver(fn: LaunchStudioDocumentResolver | null): void { _docResolver = fn; }

// Seeded demo studio so getStudio returns real data out of the box. Keyed per
// studioId; tenant-agnostic (studio config is shared reference data in the demo).
const STUDIOS = new Map<string, Studio>([
  ['demo-launch-studio', {
    studioId: 'demo-launch-studio',
    brandId: 'brand-acme',
    designSystemId: 'ds-acme-v2',
    prdId: 'prd-launch-q3',
    sharedArtifactRefs: [
      { artifactId: 'art-brand-kit', artifactTypeId: 'brand.kit' },
      { artifactId: 'art-prd', artifactTypeId: 'doc.prd' },
    ],
    steps: [
      { stepId: 'step-brief', canvasTypeId: 'canvas.brief' },
      { stepId: 'step-design', canvasTypeId: 'canvas.design' },
      { stepId: 'step-launch', canvasTypeId: 'canvas.launch' },
    ],
  }],
]);

export interface LaunchStudioSurface {
  getStudio(studioId: string): Promise<Studio | null>;
  buildProjectContext(args: { studio: Studio; userId?: string; canvasTypeId: string }): Promise<Record<string, unknown>>;
  resolveLinkedArtifacts(args: { studio: Studio; userId?: string; sourceCanvasTypeId: string }): Promise<Record<string, unknown>>;
}

export function createLaunchStudioSurface(scope: BundleScope): LaunchStudioSurface {
  const tenantId = scope.tenantId;
  return {
    async getStudio(studioId) {
      return STUDIOS.get(studioId) ?? null;
    },

    async buildProjectContext({ studio, userId, canvasTypeId }) {
      const step = studio.steps.find((s) => s.canvasTypeId === canvasTypeId);
      log.info('launch-studio buildProjectContext', { studioId: studio.studioId, canvasTypeId });
      return {
        studioId: studio.studioId,
        canvasTypeId,
        ...(userId ? { userId } : {}),
        ...(step?.projectId ? { projectId: step.projectId } : {}),
        ...(studio.brandId ? { brandId: studio.brandId } : {}),
        ...(studio.designSystemId ? { designSystemId: studio.designSystemId } : {}),
        ...(studio.prdId ? { prdId: studio.prdId } : {}),
      };
    },

    async resolveLinkedArtifacts({ studio, sourceCanvasTypeId }) {
      // The linked artifacts inherited at this step are the studio's shared
      // refs plus any earlier-step canvases (descriptive — no run wiring).
      const priorSteps = studio.steps
        .slice(0, Math.max(0, studio.steps.findIndex((s) => s.canvasTypeId === sourceCanvasTypeId)))
        .map((s) => ({ stepId: s.stepId, canvasTypeId: s.canvasTypeId }));
      // ADR 0056: resolve any ref that references a real owned Document, attaching
      // its live projection (title/status). Refs without a documentId pass through.
      const sharedArtifacts = await Promise.all(studio.sharedArtifactRefs.map(async (ref) => {
        if (ref.documentId && _docResolver) {
          const doc = await _docResolver(tenantId, ref.documentId).catch(() => null);
          if (doc) return { ...ref, document: doc };
        }
        return ref;
      }));
      return {
        sourceCanvasTypeId,
        sharedArtifacts,
        inheritedSteps: priorSteps,
      };
    },
  };
}
