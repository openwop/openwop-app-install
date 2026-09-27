/**
 * feature.job-search.nodes — ADR 0540 P4.
 *
 * Four nodes, all role:"action" so the engine records their outputs. That is a
 * determinism requirement, not bookkeeping: replay and fork must read the
 * recorded verdict rather than re-deciding against a profile or a rule table
 * that has since changed (ADR 0540 matrix row 9 — a re-scored application would
 * silently rewrite the reason a past decision was made for).
 *
 * There is deliberately NO node that takes a submission target. The law's
 * substance (ADR 0543 §D3 correction note, WF-JS-1): no node may route AROUND
 * the ADR 0541 apply grant. `run-campaign` below triggers the tenant's standing
 * campaign — it carries no listing/answers/target, and every submission inside
 * the pass goes through the grant's consult → pace → claim-CAS → consume
 * machinery. What stays forbidden is an op a workflow could aim.
 *
 * Pure-JS, Node-20 stdlib only. Composes ctx.features['job-search'] (ADR 0014).
 */

function surface(ctx, op) {
  const js = ctx.features && ctx.features['job-search'];
  if (!js || typeof js[op] !== 'function') {
    throw Object.assign(
      new Error(
        `host does not expose ctx.features['job-search'].${op} — the Job search feature must be enabled (ADR 0014)`,
      ),
      { code: 'host_capability_missing', capability: 'host.sample.job-search' },
    );
  }
  return js;
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

export async function scoreFit(ctx) {
  const js = surface(ctx, 'scoreFit');
  const i = ctx.inputs ?? {};
  const out = await js.scoreFit({ digest: obj(i.digest), profile: obj(i.profile) });
  return { status: 'success', outputs: { score: out.score ?? 0, scores: out.scores ?? {} } };
}

export async function checkEligibility(ctx) {
  const js = surface(ctx, 'checkEligibility');
  const i = ctx.inputs ?? {};
  const out = await js.checkEligibility({ digest: obj(i.digest), applicant: obj(i.applicant) });
  // `quote` is carried through verbatim: a skip the user cannot check against the
  // posting is unfalsifiable, which is the failure mode ADR 0540 D5 rejects.
  return {
    status: 'success',
    outputs: {
      eligible: out.eligible === true,
      ruleId: out.ruleId ?? null,
      reason: out.reason ?? '',
      quote: out.quote ?? null,
    },
  };
}

export async function guardRewriteNode(ctx) {
  const js = surface(ctx, 'guardRewrite');
  const i = ctx.inputs ?? {};
  const out = await js.guardRewrite({
    original: str(i.original),
    reworded: str(i.reworded),
    allowedEmployers: arr(i.allowedEmployers),
  });
  const violations = Array.isArray(out.violations) ? out.violations : [];
  // A failed guard is a SUCCESSFUL check with a negative verdict, not a node
  // failure: the chain needs to branch on it and repair, and a thrown error
  // would look like the host broke rather than the rewrite being dishonest.
  return { status: 'success', outputs: { ok: out.ok === true, violations, violationCount: violations.length } };
}

export async function recordOutcome(ctx) {
  const js = surface(ctx, 'recordOutcome');
  const i = ctx.inputs ?? {};
  const out = await js.recordOutcome({ orgId: str(i.orgId), dealId: str(i.dealId), stage: str(i.stage) });
  return { status: 'success', outputs: { moved: out.moved === true, stageId: out.stageId ?? null } };
}

/**
 * WF-JS-1 — trigger the tenant's standing campaign pass.
 *
 * This is NOT a submit node in the sense the header forbids: it takes no
 * listing, no answers, no target — nothing a workflow could use to choose or
 * widen a submission. It asks the host to run the tenant's OWN campaign, and
 * every submission inside that pass is bounded by the ADR 0541 grant (consult →
 * pace → claim CAS → consume), the steering dailyCap, and the board's submit
 * lane. Declared `side-effectful` in pack.json AND classified in the executor's
 * side-effect patterns (both legs — the #2871 lesson), so a replay serves the
 * recorded digest and never re-fires a pass.
 */
export async function runCampaignPass(ctx) {
  const js = surface(ctx, 'runCampaignPass');
  const out = await js.runCampaignPass({});
  return {
    status: 'success',
    outputs: {
      ranGrants: out.ranGrants ?? 0,
      listings: out.listings ?? 0,
      skippedNoSubmitLane: out.skippedNoSubmitLane ?? 0,
      skippedDailyCap: out.skippedDailyCap ?? 0,
      results: Array.isArray(out.results) ? out.results : [],
    },
  };
}

export const nodes = {
  'feature.job-search.nodes.score-fit': scoreFit,
  'feature.job-search.nodes.check-eligibility': checkEligibility,
  'feature.job-search.nodes.guard-rewrite': guardRewriteNode,
  'feature.job-search.nodes.record-outcome': recordOutcome,
  'feature.job-search.nodes.run-campaign': runCampaignPass,
};

export default nodes;
