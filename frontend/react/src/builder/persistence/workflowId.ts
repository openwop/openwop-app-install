/**
 * ADR 0794 — the browser half of the ONE workflow-id grammar.
 *
 *     wf.<origin>.<name>[.<suffix>]
 *
 * The server module (`backend/typescript/src/host/workflowId.ts`) is the source
 * of truth. The builder mints here because a draft needs an id before its first
 * save, including offline. `workflow-id-grammar.test.ts` (backend) pins every
 * function below to the server's — change one, change both.
 *
 * Nothing outside these two modules may build or pattern-match a workflow id.
 * The server refuses a tenant route that tries to CREATE any origin other than
 * the two minted here, so a hand-built id does not get far.
 */

/** The origins the BROWSER may mint. The server's closed set is a superset. */
export const BROWSER_MINTED_ORIGINS = ['blank', 'dup'] as const;

/** 64 random bits — the registry is one keyspace for every tenant. */
function rand16(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/** A workflow started in the builder. No name segment: it has no name yet, and
 *  the id must not change when it gets one (ADR 0794 D4). */
export function blankWorkflowId(): string {
  return `wf.blank.${rand16()}`;
}

/** A duplicate of one of the user's own workflows. */
export function dupWorkflowId(): string {
  return `wf.dup.${rand16()}`;
}

/** A walkthrough recorded in this browser (another id family, ADR 0794 D7). */
export function recordedWalkthroughId(slug: string): string {
  return `walkthrough.recorded.${slug}.${rand16()}`;
}

/**
 * The provider TOOL name a workflow is offered to a model under. Not a workflow
 * id: tool names allow no dots and at most 64 characters. The unique part of an
 * id is its SUFFIX, so truncating the sanitized id could hand two copies of one
 * long-named template the same tool name. A hash of the whole id closes that.
 */
export function workflowToolName(workflowId: string): string {
  let h = 0x811c9dc5; // FNV-1a, 32-bit
  for (let i = 0; i < workflowId.length; i += 1) {
    h ^= workflowId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hash = h.toString(16).padStart(8, '0');
  const readable = workflowId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 46);
  return `workflow_${readable}_${hash}`;
}
