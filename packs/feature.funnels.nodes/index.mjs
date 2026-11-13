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
  const out = await s.get(i);
  // ADR 1023 FN72WF-5 — a missing funnel is a typed failure, never `{funnel:null}`
  // recorded as success and handed to a model as the funnel.
  if (!out || !out.funnel) return { status: 'failed', error: { code: 'not_found', message: 'No such funnel in this org.' } };
  // ADR 1023 (grade-code FN72CD-2) — `view: 'model'` is what a model reads: a CLOSED
  // projection (the shape, never the row: no experiment salt, receipts, ids of other
  // runs or timestamps that differ between a run and its replay).
  if (text(i.view, 16) === 'model') return { status: 'success', outputs: { funnel: funnelForModel(out.funnel) } };
  return { status: 'success', outputs: out };
}

function funnelForModel(f) {
  const steps = Array.isArray(f.steps) ? f.steps : [];
  return omitEmpty({
    name: text(f.name, 200),
    status: text(f.status, 16),
    steps: steps.filter((st) => st && typeof st === 'object').map((st) => omitEmpty({
      stepId: text(st.stepId, 64), kind: text(st.kind, 32), name: text(st.name, 120),
      routing: Array.isArray(st.routing) ? st.routing.filter((r) => r && typeof r === 'object').map((r) => omitEmpty({
        goto: text(r.goto, 64),
        when: r.when && typeof r.when === 'object' ? omitEmpty({ outcome: text(r.when.outcome, 16), utm: r.when.utm && typeof r.when.utm === 'object' ? omitEmpty({ key: text(r.when.utm.key, 64), value: text(r.when.utm.value, 200) }) : undefined }) : undefined,
      })) : [],
      sells: st.offer && typeof st.offer === 'object' ? true : undefined,
      experiment: st.experiment && typeof st.experiment === 'object'
        ? omitEmpty({ status: text(st.experiment.status, 16), variants: Array.isArray(st.experiment.variants) ? st.experiment.variants.length : undefined })
        : undefined,
    })),
  });
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
  // ADR 1023 FN72WF-5 — the surface refuses an unknown funnel `not_found`.
  try { return { status: 'success', outputs: await s.stepStats(i) }; } catch (e) { return refused(e); }
}

/** ADR 1023 D3 — a blueprint's FIRST node: every offer product id (each `…ProductId`
 *  input and `productIds`; empty entries skipped) must be an ACTIVE product of the org, checked by THE offer
 *  rule on the host, before any step sub-chain drafts a page. Typed failure
 *  `offer_not_found`. */
export async function checkOffers(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId'], 'check-offers');
  if (typeof s.checkOffers !== 'function') {
    throw Object.assign(new Error('host ctx.features.funnels does not expose checkOffers — needs ADR 1023'), { code: 'host_capability_missing', capability: 'host.funnels' });
  }
  // Each id arrives as its OWN whole-value input (`productId`, `bumpProductId`, …):
  // deferred expansion binds only whole-value `{{params.x}}` tokens, so an array of
  // tokens would freeze. `productIds` (an array) is accepted too.
  const productIds = [
    ...(Array.isArray(i.productIds) ? i.productIds : []),
    ...Object.entries(i).filter(([k]) => /(^p|P)roductId$/.test(k)).map(([, v]) => v),
  ].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  try { return { status: 'success', outputs: await s.checkOffers({ orgId: i.orgId, productIds }) }; } catch (e) { return refused(e); }
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

// ── ADR 1023 D1 — what a step's copy model reads. ──
// The copy node used to be fed by two BARE edges (brief→copy, products→copy): the
// scheduler maps a bare edge to port `input`, so the second overwrote the first, and
// `toMessages` then sent the first string-valued input — the product id — as the
// whole prompt. This node is the copy model's ONE input. It returns CLOSED
// projections, never a raw row: a brief row carries `kernelReview.runId`, `budget`,
// `createdBy` and timestamps, and a product row carries `cost`, download tokens and
// stock (a run id in model text breaks the ADR 1002 replay digest; stock drifts).

const strs = (v, maxItems, max) => (Array.isArray(v) ? v.map((x) => text(x, max)).filter(Boolean).slice(0, maxItems) : []);
const omitEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && !(Array.isArray(v) && v.length === 0) && !(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)));

function briefProjection(b) {
  const m = b.messaging && typeof b.messaging === 'object' ? b.messaging : {};
  const k = b.kernel && typeof b.kernel === 'object' ? b.kernel : null;
  return omitEmpty({
    name: text(b.name, 200),
    objective: text(b.objective, 2000),
    productName: text(b.productName, 200),
    productDescription: text(b.productDescription, 4000),
    industryVertical: text(b.industryVertical, 200),
    competitors: strs(b.competitors, 20, 200),
    messaging: omitEmpty({
      primaryValueProp: text(m.primaryValueProp, 2000), toneOverride: text(m.toneOverride, 400),
      proofPoints: strs(m.proofPoints, 12, 600), ctaStrategy: text(m.ctaStrategy, 1000),
    }),
    kernel: k ? omitEmpty({
      headline: text(k.headline, 400), supportingStatement: text(k.supportingStatement, 2000),
      proofPoints: strs(k.proofPoints, 12, 600), primaryCta: text(k.primaryCta, 200),
      secondaryCta: text(k.secondaryCta, 200), tone: text(k.tone, 400),
    }) : undefined,
  });
}

function productProjection(p) {
  const attrs = Array.isArray(p.attributes)
    ? p.attributes.filter((a) => a && typeof a === 'object').map((a) => omitEmpty({ label: text(a.label, 120), value: text(a.value, 400) })).filter((a) => a.label).slice(0, 20)
    : [];
  return omitEmpty({
    name: text(p.name, 200), description: text(p.description, 4000), type: text(p.type, 40),
    categories: strs(p.categories, 20, 120), tags: strs(p.tags, 20, 120), attributes: attrs,
  });
}

/** ADR 1023 D1 — the copy model's context: the brief (closed projection) and, for a
 *  money step, the ONE active catalog product the step sells (+ the checkout's bump).
 *  Inputs: brief (port, a get-brief output or the brief), products (port, a
 *  list-products output; required when productId is given), productId?,
 *  bumpProductId?. Typed failures: brief_not_found, offer_not_found. Pure. */
export async function offerContext(ctx) {
  const i = merged(ctx);
  const rawBrief = i.brief && typeof i.brief === 'object' ? (i.brief.brief && typeof i.brief.brief === 'object' ? i.brief.brief : i.brief) : null;
  if (!rawBrief || !text(rawBrief.name, 200)) return invalid('brief_not_found', 'offer-context needs the campaign `brief`.');
  // CC-KERNEL-1 / ADR 1020 D8 — a STALE kernel (the brief changed after it was
  // approved) is not usable content: the channel generators refuse it, and a
  // funnel step wrote and submitted a page from one (live, build 373d4863a).
  // Same refusal, same words. A brief with no kernel is still fine here.
  if (rawBrief.kernelStale === true) {
    return invalid('kernel_stale', 'The brief changed after its messaging kernel was approved. Regenerate and approve the kernel before generating funnel pages.');
  }
  const context = { brief: briefProjection(rawBrief) };
  const productId = text(i.productId, 120);
  const bumpId = text(i.bumpProductId, 120);
  if (productId || bumpId) {
    const list = Array.isArray(i.products) ? i.products : (i.products && Array.isArray(i.products.products) ? i.products.products : null);
    if (!list) return invalid('offer_check_missing', 'offer-context needs the org\'s `products` to find the offer.');
    const find = (id) => list.find((p) => p && p.productId === id && p.active !== false);
    if (productId) {
      const p = find(productId);
      if (!p) return invalid('offer_not_found', `The offer product is not an active product of this client: ${productId}`);
      context.product = productProjection(p);
    }
    if (bumpId) {
      const b = find(bumpId);
      if (!b) return invalid('offer_not_found', `The order-bump product is not an active product of this client: ${bumpId}`);
      context.bumpProduct = productProjection(b);
    }
  }
  return { status: 'success', outputs: { context } };
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
  'feature.funnels.nodes.check-offers': checkOffers,
  'feature.funnels.nodes.offer-context': offerContext,
  'feature.funnels.nodes.create': create,
  'feature.funnels.nodes.set-steps': setSteps,
  'feature.funnels.nodes.step-stats': stepStats,
  'feature.funnels.nodes.request-publish': requestPublish,
  'feature.funnels.nodes.compose-step-page': composeStepPage,
  'feature.funnels.nodes.step-result': stepResult,
  'feature.funnels.nodes.collect-steps': collectSteps,
};
export default nodes;
