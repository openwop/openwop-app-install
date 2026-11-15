/**
 * ADR 1040 D7 F2 (Book AI P47) — a feature's inline RESULT card for a finished
 * run, rendered under the run's bubble in the chat (`WorkflowCompletionCard`).
 *
 * A renderer is chosen by what the run PRODUCED, read through the same
 * authorized run read the run surfaces use (`listRunArtifacts`): it matches an
 * output artifact type, and optionally the workflow id (for a chain bound under
 * its own id). It receives only that authorized artifact list plus the run's
 * own state, which the viewer already holds, and loads any content through the
 * artifact client (access-checked server-side). Nothing here widens a read.
 *
 * No renderer matches → today's completion line, unchanged. A renderer that
 * throws is contained: the completion line still renders.
 *
 * Chain ORIGIN matching (P47 asked for it) is not offered yet: a run does not
 * record which chain pack it was instantiated from (the workflow is a
 * tenant-minted copy), so there is nothing authoritative to match on.
 */
import type { ComponentType } from 'react';
import type { RunArtifact } from '../RunArtifactCards.js';
import type { WorkflowRunState } from '../types.js';

export interface RunResultRendererProps {
  run: WorkflowRunState;
  /** The run's artifacts the viewer may read, from the authorized run read. */
  artifacts: readonly RunArtifact[];
}

export interface RunResultRenderer {
  /** `<featureId>.<name>`; unique. */
  id: string;
  match: {
    /** Matches when the run produced an artifact of one of these types. */
    artifactTypes: readonly string[];
    /** Optionally ALSO require one of these workflow ids. */
    workflowIds?: readonly string[];
  };
  Component: ComponentType<RunResultRendererProps>;
}

const RENDERERS = new Map<string, RunResultRenderer>();

/** Register at module load of the owning feature. Throws on a duplicate id or
 *  a renderer that matches nothing (a programming error, never runtime state). */
export function registerRunResultRenderer(r: RunResultRenderer): void {
  if (RENDERERS.has(r.id)) throw new Error(`run result renderer "${r.id}" is already registered.`);
  if (r.match.artifactTypes.length === 0) throw new Error(`run result renderer "${r.id}" must match at least one artifact type.`);
  RENDERERS.set(r.id, r);
}

/** Test seam. */
export function __unregisterRunResultRenderer(id: string): void {
  RENDERERS.delete(id);
}

/** Could any renderer match this run? Lets the completion card skip the
 *  artifact read when none could: no renderers, or every one is scoped to other
 *  workflows. Register at the owning feature's module load, before the chat
 *  mounts: a card does not re-check after it has rendered. */
export function mayMatchRunResult(run: Pick<WorkflowRunState, 'workflowId'>): boolean {
  for (const r of RENDERERS.values()) {
    if (!r.match.workflowIds || r.match.workflowIds.includes(run.workflowId)) return true;
  }
  return false;
}

/** The first renderer (in registration order) that matches this run's outputs. */
export function findRunResultRenderer(run: WorkflowRunState, artifacts: readonly RunArtifact[]): RunResultRenderer | undefined {
  const produced = new Set(artifacts.map((a) => a.artifactTypeId).filter((t): t is string => typeof t === 'string'));
  for (const r of RENDERERS.values()) {
    if (r.match.workflowIds && !r.match.workflowIds.includes(run.workflowId)) continue;
    if (r.match.artifactTypes.some((t) => produced.has(t))) return r;
  }
  return undefined;
}
