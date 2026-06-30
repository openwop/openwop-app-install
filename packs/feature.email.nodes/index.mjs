/**
 * feature.email.nodes — Email read/render nodes over the `ctx.features.email`
 * surface (ADR 0014). role:"action"; outputs recorded so replay/fork read the
 * recorded result. Pure-JS, Node-20 stdlib only.
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

export async function listTemplates(ctx) {
  const email = ensureEmail(ctx);
  const orgId = typeof (ctx.inputs ?? {}).orgId === 'string' ? ctx.inputs.orgId : '';
  const out = await email.listTemplates({ orgId });
  return { status: 'success', outputs: { templates: out.templates ?? [] } };
}

export async function getTemplate(ctx) {
  const email = ensureEmail(ctx);
  const i = ctx.inputs ?? {};
  const out = await email.getTemplate({
    orgId: typeof i.orgId === 'string' ? i.orgId : '',
    templateId: typeof i.templateId === 'string' ? i.templateId : '',
  });
  if (!out.template) {
    throw Object.assign(new Error('email template not found for this tenant'), { code: 'not_found' });
  }
  return { status: 'success', outputs: { template: out.template } };
}

export async function render(ctx) {
  const email = ensureEmail(ctx);
  const i = ctx.inputs ?? {};
  const out = await email.render({
    orgId: typeof i.orgId === 'string' ? i.orgId : '',
    templateId: typeof i.templateId === 'string' ? i.templateId : '',
    contact: typeof i.contact === 'object' && i.contact !== null ? i.contact : {},
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
