/**
 * Campaign autopilot node pack (ADR 0961).
 *
 * `preflight` asks ctx.features['campaign-autopilot'] for the checklist of the
 * campaign THIS run is tagged with. It takes no campaign input: the surface reads
 * the run's own tag, so a node cannot check (or be pointed at) another campaign.
 * A blocking item that is not ok suspends the run on a checklist card (a
 * `clarification` interrupt, ADR 0961 D7) that "Check again" resumes; it is never
 * a silent skip.
 */

function ensureAutopilot(ctx) {
  const s = ctx.features && ctx.features['campaign-autopilot'];
  if (!s || typeof s.preflight !== 'function' || typeof s.startStage !== 'function') {
    throw Object.assign(new Error("host surface ctx.features['campaign-autopilot'] missing (campaign-autopilot toggle off?)"), {
      code: 'host_capability_missing', capability: 'features.campaign-autopilot',
    });
  }
  return s;
}

const ITEM_LABEL = {
  brief: 'Brief linked to this campaign',
  'brief-complete': 'Brief is complete',
  'brief-setup': 'Brand, persona and knowledge set up',
  'ad-account': "The client's ad account is connected",
  goal: 'Campaign goal set',
};

/** The ids of the blocking items that are not ok. */
function blockedOf(items) {
  return items.filter((i) => i && i.blocking && i.status !== 'ok');
}

/** A resume key that names WHAT is blocked, so a changed checklist always asks
 *  afresh, and an unchanged one alternates `k` / `k:again` (the executor seeds
 *  only the latest resolution, so the key that was just answered short-circuits
 *  and the other one suspends again). */
function blockKey(blocked) {
  return 'autopilot-preflight:' + blocked
    .map((i) => `${i.id}=${Array.isArray(i.missing) ? i.missing.join('|') : ''}`)
    .sort()
    .join(',');
}

function checklistCard(items, blocked) {
  const lines = blocked.map((i) => {
    const what = Array.isArray(i.missing) && i.missing.length ? ` (${i.missing.join(', ')})` : '';
    return `• ${ITEM_LABEL[i.id] || i.id}${what}`;
  });
  return {
    reason: 'clarification',
    question: `This campaign is not ready for the autopilot yet. Fix the items below, then check again.\n${lines.join('\n')}`,
    catalogVersion: '0.9.1',
    surface: {
      title: 'Campaign autopilot: preflight',
      components: [
        { component: 'text', text: 'This campaign is not ready for the autopilot yet. Fix these, then check again:' },
        ...blocked.map((i) => ({ component: 'text', text: lines[blocked.indexOf(i)] })),
        { component: 'action.button', id: 'recheck', label: 'Check again', action: { target: 'resume' } },
      ],
    },
  };
}

export async function preflight(ctx) {
  const s = ensureAutopilot(ctx);
  const out = await s.preflight({});
  const items = Array.isArray(out && out.items) ? out.items : [];
  if (out && out.ready === true) return { status: 'success', outputs: { ready: true, items } };
  const blocked = blockedOf(items);
  // A run with no human interrupt seam (a bare test harness) cannot wait: say so, typed.
  if (typeof ctx.suspend !== 'function') {
    return {
      status: 'failed',
      error: { code: 'preflight_blocked', message: `The campaign is not ready for the autopilot: ${blocked.map((i) => i.id).join(', ') || 'unknown'}.` },
    };
  }
  // ADR 0961 D7 — suspend on the checklist instead of failing; "Check again"
  // resumes, and the node re-reads the checklist on re-entry.
  const key = blockKey(blocked);
  const card = checklistCard(items, blocked);
  await ctx.suspend({ ...card, resumeKey: key });
  // Reached only on re-entry after `key` was answered while the SAME items are
  // still blocked: ask again under the alternate key.
  await ctx.suspend({ ...card, resumeKey: `${key}:again` });
  return { status: 'failed', error: { code: 'preflight_blocked', message: 'The preflight could not be re-asked.' } };
}

/**
 * Start a stage as its own campaign run (ADR 0961 D4) and complete with its run
 * id. A gated stage (the campaign spine waits on a kernel approval) cannot be a
 * nested sub-chain on this host: a suspended child is never resumed into its
 * parent. Role `side-effect`: a replay fork serves the recorded run id and
 * starts nothing; a retry resolves the same run (the id is derived).
 */
export async function startStage(ctx) {
  const i = ctx.inputs ?? {};
  const cfg = ctx.config ?? {};
  const stage = typeof cfg.stage === 'string' ? cfg.stage : '';
  const out = await ensureAutopilot(ctx).startStage({
    stage,
    ...(typeof i.provider === 'string' && i.provider ? { provider: i.provider } : {}),
    ...(typeof i.model === 'string' && i.model ? { model: i.model } : {}),
  });
  return { status: 'success', outputs: { stage: out.stage, runId: out.runId, workflowId: out.workflowId } };
}

export const nodes = {
  'feature.campaign-autopilot.nodes.preflight': preflight,
  'feature.campaign-autopilot.nodes.start-stage': startStage,
};

export default nodes;
