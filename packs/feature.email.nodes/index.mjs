/**
 * feature.email.nodes — Email read/render nodes over the `ctx.features.email`
 * surface (ADR 0014). role:"read" — pure reads, NOT replay-served (they re-execute
 * on a fork and re-read live templates; ADR 0655 D4 corrected the old docblock's
 * "outputs recorded so replay/fork read the recorded result", which was never true
 * — only `side-effect` nodes are served from the recorded outcome). Pure-JS,
 * Node-20 stdlib only.
 *
 * Inputs are read from `{...ctx.config, ...ctx.inputs}` (inputs win) so an author
 * may bind via either; a missing `orgId`/`templateId` is a TYPED failure raised by
 * the surface (`validation_error`), never a coerced '' that answers for nobody.
 */

function ensureEmail(ctx) {
  const email = ctx.features && ctx.features.email;
  if (!email || typeof email.listTemplates !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.email — the Email feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.email' },
    );
  }
  return email;
}

const argsOf = (ctx) => ({ ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) });
const strOf = (v) => (typeof v === 'string' ? v : undefined);

export async function listTemplates(ctx) {
  const email = ensureEmail(ctx);
  const a = argsOf(ctx);
  const out = await email.listTemplates({ orgId: strOf(a.orgId) });
  return { status: 'success', outputs: { templates: out.templates ?? [] } };
}

export async function getTemplate(ctx) {
  const email = ensureEmail(ctx);
  const a = argsOf(ctx);
  const out = await email.getTemplate({ orgId: strOf(a.orgId), templateId: strOf(a.templateId) });
  if (!out.template) {
    throw Object.assign(new Error('email template not found for this tenant'), { code: 'not_found' });
  }
  return { status: 'success', outputs: { template: out.template } };
}

export async function render(ctx) {
  const email = ensureEmail(ctx);
  const a = argsOf(ctx);
  const out = await email.render({
    orgId: strOf(a.orgId),
    templateId: strOf(a.templateId),
    contact: typeof a.contact === 'object' && a.contact !== null ? a.contact : {},
  });
  if (!out.rendered) {
    throw Object.assign(new Error('email template not found for this tenant'), { code: 'not_found' });
  }
  return { status: 'success', outputs: { rendered: out.rendered } };
}

export const nodes = {
  'feature.email.nodes.list-templates': listTemplates,
  'feature.email.nodes.get-template': getTemplate,
  'feature.email.nodes.render': render,
};

export default nodes;
