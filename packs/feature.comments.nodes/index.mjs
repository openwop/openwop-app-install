/**
 * feature.comments.nodes — Comment read/post/resolve nodes over the
 * `ctx.features.comments` surface (ADR 0014/0021). role:"action"; outputs recorded
 * so replay/fork read the recorded result (a post is not re-issued on replay).
 * Pure-JS, Node-20 stdlib only.
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

export async function list(ctx) {
  const comments = ensureComments(ctx);
  const i = ctx.inputs ?? {};
  const out = await comments.list({ orgId: str(i.orgId), resourceType: str(i.resourceType), resourceId: str(i.resourceId) });
  return { status: 'success', outputs: { comments: out.comments ?? [] } };
}

export async function post(ctx) {
  const comments = ensureComments(ctx);
  const i = ctx.inputs ?? {};
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
  const i = ctx.inputs ?? {};
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
