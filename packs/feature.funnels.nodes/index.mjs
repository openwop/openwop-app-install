/**
 * feature.funnels.nodes — Funnel A nodes over `ctx.features.funnels` (ADR 0294 /
 * ADR 0058). Writes author DRAFT state only — publishing is human (public-surface
 * change): `request-publish` (ADR 0948 P1b) only queues the human review. Reads are role:"action"; `create` and `set-steps` are role:"side-effect"
 * (ADR 0948 P1), so a replay fork is served their recorded output. The old header
 * said "All role:'action' (recorded)": the executor does not serve `action` nodes on
 * replay, so a fork re-ran `create` and minted a second draft. Pure-JS, Node-20
 * stdlib only. Calls the SAME service functions the REST routes call.
 */
function ensureFunnels(ctx) {
  const s = ctx.features && ctx.features.funnels;
  if (!s || typeof s.list !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.funnels — the funnels feature must be composed (ADR 0294)'), { code: 'host_capability_missing', capability: 'host.funnels' });
  }
  return s;
}
const merged = (ctx) => ({ ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) });
/** A refusal the host typed (`details.code` or `details.reason`, else `code`) as a node FAILURE: the
 *  error code is the channel a chain receives (the loader drops failed outputs). */
const refused = (e) => ({ status: 'failed', error: { code: (e && e.details && (e.details.code || e.details.reason)) || (e && e.code) || 'failed', message: e instanceof Error ? e.message : String(e) } });
const loopKey = (v) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '');
const need = (i, keys, node) => {
  for (const k of keys) if (!i[k]) throw Object.assign(new Error(`${node} requires \`${k}\``), { code: 'validation_error' });
};

export async function list(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId'], 'list');
  return { status: 'success', outputs: await s.list(i) };
}

export async function get(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'funnelId'], 'get');
  return { status: 'success', outputs: await s.get(i) };
}

export async function create(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'name'], 'create');
  // ADR 0948 P1 — the node key (+ an optional loop key); the surface derives the
  // funnel id from it plus the run's tenant and id, so a re-delivered call returns
  // the same draft, and a different create under the same key is refused.
  const k = loopKey(i.key);
  try {
    return { status: 'success', outputs: await s.create({ ...i, key: `${ctx.nodeId ?? ''}${k ? `:${k}` : ''}` }) };
  } catch (e) { return refused(e); }
}

export async function setSteps(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'funnelId', 'steps'], 'set-steps');
  let out;
  try { out = await s.setSteps(i); } catch (e) { return refused(e); }
  // A missing funnel is a typed failure, never a recorded empty success.
  if (!out || out.funnelId === null) return { status: 'failed', error: { code: 'not_found', message: 'No such funnel in this org.' } };
  return { status: 'success', outputs: out };
}

/** ADR 0948 P1b — REQUEST a publish. Queues a `funnel-publish` review pinned to the
 *  funnel's content and returns `{status:'pending_approval', approvalId}` without
 *  waiting (the cms submit-page precedent). A human's approve publishes; this node
 *  never does. Refusals are typed: funnel_not_draft, step_pages_unpublished, not_found. */
export async function requestPublish(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'funnelId'], 'request-publish');
  if (typeof s.requestPublish !== 'function') {
    throw Object.assign(new Error('host ctx.features.funnels does not expose requestPublish — needs ADR 0948 P1b'), { code: 'host_capability_missing', capability: 'host.funnels' });
  }
  let out;
  try { out = await s.requestPublish({ orgId: i.orgId, funnelId: i.funnelId }); } catch (e) { return refused(e); }
  if (!out || out.status === 'not_found') return { status: 'failed', error: { code: 'not_found', message: 'No such funnel in this org.' } };
  return { status: 'success', outputs: out };
}

export async function stepStats(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'funnelId'], 'step-stats');
  return { status: 'success', outputs: await s.stepStats(i) };
}

// ── ADR 0948 P2 — blueprint step plumbing. Pure: no surface call, no clock, no
// randomness, so a replay re-derives the same output from the recorded inputs. ──

const BLUEPRINT_KINDS = ['optin', 'thankyou', 'sales', 'checkout', 'upsell', 'downsell'];
/** Steps that sell: their page is copy; the viewer adds the buy UI from the step's offer (ADR 0948 P2c). */
const MONEY_KINDS = ['checkout', 'upsell', 'downsell'];
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const lines = (v, maxItems, max) => (Array.isArray(v) ? v.map((x) => text(x, max)).filter(Boolean).slice(0, maxItems) : []);
const invalid = (code, message) => ({ status: 'failed', error: { code, message } });

/** Build a step page's sections from model-written copy, closed-world: only the
 *  fields named here reach the page, and the form is the one the caller chose
 *  (checked against the org's own forms), never one the model names. The CMS
 *  sanitizes the result again like an editor save. */
export async function composeStepPage(ctx) {
  const i = merged(ctx);
  const kind = text(i.kind, 32);
  if (!BLUEPRINT_KINDS.includes(kind)) return invalid('unsupported_kind', `compose-step-page supports ${BLUEPRINT_KINDS.join(', ')}; got \`${kind}\`.`);
  const copy = i.copy && typeof i.copy === 'object' && !Array.isArray(i.copy) ? (i.copy.data && typeof i.copy.data === 'object' ? i.copy.data : i.copy) : null;
  const headline = copy ? text(copy.headline, 200) : '';
  if (!headline) return invalid('invalid_copy', 'The step copy needs a non-empty `headline`.');
  const bullet = (xs) => xs.map((x) => `- ${x}`).join('\n');
  if (kind === 'optin') {
    const formId = text(i.formId, 128);
    if (!formId) return invalid('form_required', 'An opt-in page needs the form that captures the lead (`formId`).');
    const forms = Array.isArray(i.forms) ? i.forms : null;
    if (!forms) return invalid('form_check_missing', 'compose-step-page needs the org\'s `forms` list to check the opt-in form.');
    if (!forms.some((f) => f && (f.formId === formId || f.id === formId))) return invalid('form_not_found', 'That form is not one of this client\'s forms.');
    const points = lines(copy.bullets, 6, 300);
    const sections = [
      { type: 'hero', data: { heading: headline, ...(text(copy.subheadline, 600) ? { subheading: text(copy.subheadline, 600) } : {}) } },
      ...(points.length ? [{ type: 'richText', data: { ...(text(copy.bulletsHeading, 200) ? { heading: text(copy.bulletsHeading, 200) } : {}), text: bullet(points) } }] : []),
      { type: 'form', data: { formId, ...(text(copy.formHeading, 200) ? { heading: text(copy.formHeading, 200) } : {}) } },
    ];
    return { status: 'success', outputs: { title: headline, sections } };
  }
  if (kind !== 'thankyou') {
    // sales, checkout, upsell, downsell: a promise and its points. The checkout and
    // offer steps' buy controls come from the step's OFFER in the viewer (P2c),
    // never from copy, so no price, product id or link reaches the page from here.
    const points = lines(copy.bullets, 6, 300);
    const sections = [
      { type: 'hero', data: { heading: headline, ...(text(copy.subheadline, 600) ? { subheading: text(copy.subheadline, 600) } : {}) } },
      ...(points.length ? [{ type: 'richText', data: { ...(text(copy.bulletsHeading, 200) ? { heading: text(copy.bulletsHeading, 200) } : {}), text: bullet(points) } }] : []),
    ];
    return { status: 'success', outputs: { title: headline, sections } };
  }
  const message = text(copy.message, 1200);
  const steps = lines(copy.nextSteps, 5, 300);
  const sections = [
    { type: 'hero', data: { heading: headline, ...(message ? { subheading: message } : {}) } },
    ...(steps.length ? [{ type: 'richText', data: { ...(text(copy.nextStepsHeading, 200) ? { heading: text(copy.nextStepsHeading, 200) } : {}), text: bullet(steps) } }] : []),
  ];
  return { status: 'success', outputs: { title: headline, sections } };
}

/** A step sub-chain's result: the funnel step for the page it drafted, written to
 *  the run's variable bag (`variable`, default `step`) so the parent's
 *  `outputMapping` can carry it out of the child run, and `pageId` as a flat port
 *  for the next node (submit-page). */
export async function stepResult(ctx) {
  const i = merged(ctx);
  const kind = text(i.kind, 32);
  if (!BLUEPRINT_KINDS.includes(kind)) return invalid('unsupported_kind', `step-result supports ${BLUEPRINT_KINDS.join(', ')}; got \`${kind}\`.`);
  const page = i.page && typeof i.page === 'object' ? i.page : null;
  const pageId = page ? text(page.pageId, 300) : '';
  if (!pageId) return invalid('page_missing', 'step-result needs the drafted `page` (with its `pageId`).');
  // ADR 0948 P2c tripwire — a fixed `stepId` lets the parent's routing name this
  // step; a money step carries its offer, built from the caller's product ids (the
  // funnels write validates them against the org's catalog).
  const stepId = text(i.stepId, 64).replace(/[^A-Za-z0-9_-]/g, '');
  const productId = text(i.offerProductId, 120);
  const bumpId = text(i.offerBumpProductId, 120);
  if (MONEY_KINDS.includes(kind) && !productId) return invalid('offer_missing', `A ${kind} step needs the product it sells (\`offerProductId\`).`);
  const offer = productId && MONEY_KINDS.includes(kind)
    ? { productIds: [productId], ...(kind === 'checkout' && bumpId ? { bumpProductIds: [bumpId] } : {}), ...(kind !== 'checkout' ? { oneClickProductId: productId } : {}) }
    : undefined;
  const step = { kind, pageId, ...(stepId ? { stepId } : {}), ...(text(i.name, 120) ? { name: text(i.name, 120) } : {}), ...(offer ? { offer } : {}) };
  const variable = text(i.variable, 64) || 'step';
  if (!ctx.variables || typeof ctx.variables.set !== 'function') {
    throw Object.assign(new Error('step-result needs the run variable bag (ctx.variables)'), { code: 'host_capability_missing' });
  }
  ctx.variables.set(variable, step);
  return { status: 'success', outputs: { pageId, step } };
}

/** The parent's ordered step list, read from the variables its step sub-chains
 *  returned (`variables`, in funnel order). A missing one is a typed failure,
 *  never a funnel with a step silently dropped. */
export async function collectSteps(ctx) {
  const i = merged(ctx);
  const names = Array.isArray(i.variables) ? i.variables.map((v) => text(v, 64)).filter(Boolean) : [];
  if (names.length === 0) return invalid('validation_error', 'collect-steps needs `variables` (the step variables, in funnel order).');
  if (!ctx.variables || typeof ctx.variables.get !== 'function') {
    throw Object.assign(new Error('collect-steps needs the run variable bag (ctx.variables)'), { code: 'host_capability_missing' });
  }
  const steps = [];
  for (const name of names) {
    const s = ctx.variables.get(name);
    if (!s || typeof s !== 'object' || !BLUEPRINT_KINDS.includes(s.kind) || typeof s.pageId !== 'string' || !s.pageId) {
      return invalid('step_missing', `The step \`${name}\` was not produced; the funnel is not created without it.`);
    }
    const routing = i.routing && typeof i.routing === 'object' && typeof s.stepId === 'string' ? i.routing[s.stepId] : undefined;
    steps.push({
      kind: s.kind, pageId: s.pageId,
      ...(typeof s.stepId === 'string' && s.stepId ? { stepId: s.stepId } : {}),
      ...(typeof s.name === 'string' && s.name ? { name: s.name } : {}),
      ...(s.offer && typeof s.offer === 'object' ? { offer: s.offer } : {}),
      // Routing is the BLUEPRINT's (a literal map keyed by stepId); the funnels write
      // checks every goto names a sibling step.
      ...(Array.isArray(routing) ? { routing } : {}),
    });
  }
  return { status: 'success', outputs: { steps } };
}

export const nodes = {
  'feature.funnels.nodes.list': list,
  'feature.funnels.nodes.get': get,
  'feature.funnels.nodes.create': create,
  'feature.funnels.nodes.set-steps': setSteps,
  'feature.funnels.nodes.step-stats': stepStats,
  'feature.funnels.nodes.request-publish': requestPublish,
  'feature.funnels.nodes.compose-step-page': composeStepPage,
  'feature.funnels.nodes.step-result': stepResult,
  'feature.funnels.nodes.collect-steps': collectSteps,
};
export default nodes;
