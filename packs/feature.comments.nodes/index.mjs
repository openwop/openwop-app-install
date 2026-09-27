/**
 * feature.comments.nodes — Comment read/post/resolve nodes over the
 * `ctx.features.comments` surface (ADR 0014/0021). Pure-JS, Node-20 stdlib only.
 *
 * REPLAY / FORK (`WF-CMNT-1`, corrected here rather than deleted). This header
 * used to say `role:"action"; outputs recorded so replay/fork read the recorded
 * result (a post is not re-issued on replay)`. **That was false, and it was the
 * only thing standing where the classification should have been.** `role:"action"`
 * is not a replay guarantee: `isSideEffectingNode` consults the derived manifest
 * floor, `module.sideEffecting` (unreachable from a pack `.mjs`), and an explicit
 * typeId pattern — and `feature.comments.nodes.post` was in NONE of them. So a
 * `:fork` re-executed it, posting a SECOND comment (fresh `cmt:${uuid}`, a
 * DIFFERENT `agent:${newRunId}` author) and sending a SECOND notification.
 *
 * What is true NOW, on both legs: `post` declares `"role": "side-effect"` + the
 * `side-effectful` capability in `pack.json`, and `executor/sideEffects.ts`
 * carries `/^feature\.comments\.nodes\.post$/`. It is in the derived floor AND
 * the fast-path SERVED set, so a replay/fork is served the source run's recorded
 * outcome and never re-posts.
 *
 * `list` is a read and `resolve` converges on the same terminal state, so both
 * stay `role:"action"` and DO re-execute on a fork — stated, because "action"
 * meaning "not re-issued" is exactly the belief that shipped the defect.
 */

function ensureComments(ctx) {
  const comments = ctx.features && ctx.features.comments;
  if (!comments || typeof comments.list !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.comments — the Comments feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.comments' },
    );
  }
  return comments;
}

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * WHERE THE ARGUMENTS COME FROM (`WF-CMNT-3`).
 *
 * All three nodes read `ctx.inputs` and NOTHING else. But RFC 0013 **Path A** —
 * the `…/workflows/from-chain` default — freezes a chain's `{{params.orgId}}`
 * into EITHER `config` OR `inputs`, depending on where the author put the token
 * (`workflowChainPackLoader.ts`, `mentions(n.config,p) || mentions(n.inputs,p)`).
 * So a param bound in `config` never arrived, and the org scope silently became
 * `''`.
 *
 * The merged-args contract is the corpus idiom: `packs/feature.crm.nodes` has
 * always done it, and `packs/feature.analytics.nodes` was fixed to
 * (`WF-ANL-1`) after the same defect produced `summarize(tenantId, '')` and an
 * LLM wrote a "Board Update" over an empty summary on three LIVE chains.
 * Comments is the same defect one step earlier — ZERO chains consume this pack
 * today, but it is authorable from the builder palette and the workflow-author
 * catalog right now.
 *
 * INPUTS WIN ON CONFLICT: a DAG-forwarded value is a runtime fact, a config
 * value is an authoring-time default.
 */
function args(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}

export async function list(ctx) {
  const comments = ensureComments(ctx);
  const i = args(ctx);
  const out = await comments.list({ orgId: str(i.orgId), resourceType: str(i.resourceType), resourceId: str(i.resourceId) });
  return { status: 'success', outputs: { comments: out.comments ?? [] } };
}

export async function post(ctx) {
  const comments = ensureComments(ctx);
  const i = args(ctx);
  const out = await comments.post({
    orgId: str(i.orgId), resourceType: str(i.resourceType), resourceId: str(i.resourceId),
    body: str(i.body), ...(typeof i.parentId === 'string' && i.parentId ? { parentId: i.parentId } : {}),
  });
  if (!out.comment) {
    throw Object.assign(new Error('comment not posted — unknown resourceType or resource not found for this tenant'), { code: 'not_found' });
  }
  return { status: 'success', outputs: { comment: out.comment } };
}

export async function resolve(ctx) {
  const comments = ensureComments(ctx);
  const i = args(ctx);
  const out = await comments.resolve({ orgId: str(i.orgId), commentId: str(i.commentId) });
  if (!out.comment) {
    throw Object.assign(new Error('comment not found for this tenant'), { code: 'not_found' });
  }
  return { status: 'success', outputs: { comment: out.comment } };
}

export const nodes = {
  'feature.comments.nodes.list': list,
  'feature.comments.nodes.post': post,
  'feature.comments.nodes.resolve': resolve,
};

export default nodes;
