/**
 * feature.computer-use.nodes — the ADR 0418 browser-agent verbs over
 * ctx.features['computer-use']. The chain shape is `task → decide`: `task`
 * starts/resumes a session and runs until completion OR a commit-tier action
 * halts it (`awaiting_approval`); `decide` asks the opener about THAT action
 * and resumes or ends the session. Recorded side-effect nodes — replay reads
 * the recorded trajectory and never re-drives a browser.
 *
 * ADR 0894 D3 — `decide` no longer takes `approve` from its inputs. It raises
 * its own approval interrupt for the pending action (one resume key per action,
 * the opener as the only approver), and the surface verifies the recorded
 * resolution before any commit proceeds. A boolean wired into this node — a
 * literal, or an LLM node's reading of page text — cannot approve anything.
 */
function ensure(ctx, method) {
  const s = ctx.features && ctx.features['computer-use'];
  if (!s || typeof s[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features['computer-use'].${method} — the feature must be composed (ADR 0014)`),
      { code: 'host_capability_missing', capability: 'host.sample.computer-use' },
    );
  }
  return s;
}
function str(v) { return typeof v === 'string' ? v : ''; }

/**
 * ADR 0894 addendum G-D — a credential step is refused (no broker exists), and
 * the refusal must be VISIBLE: a session that ended on it fails the node with the
 * typed code, so the run fails and the completion card shows why. Every other
 * terminal session state is reported in the output, as before.
 */
function credentialRefusal(session) {
  if (!session || session.status !== 'failed' || session.error !== 'credential_entry_unsupported') return null;
  return {
    status: 'failure',
    error: {
      code: 'credential_entry_unsupported',
      message: 'The browser agent reached a sign-in step. It cannot enter credentials yet, so the session stopped there. Sign in to the site yourself, or give it a task that does not need an account.',
    },
  };
}

export async function task(ctx) {
  const cu = ensure(ctx, 'startTask');
  const i = ctx.inputs ?? {};
  const out = await cu.startTask({
    orgId: str(i.orgId),
    task: str(i.task),
    startUrl: str(i.startUrl),
    allowedOrigins: Array.isArray(i.allowedOrigins) ? i.allowedOrigins : [],
    // ADR 0541 D2 / WF-JS-2 — forward the apply-grant context. This was READ by
    // the surface (closed-world normalised there) and FORWARDED by nothing: the
    // career.apply chain's `applyContext` param silently vanished here, so the
    // commit gate could never consult a grant for a chain-driven session — the
    // exact "reachability was not proven" defect StartTaskInput's own docblock
    // records, reintroduced one layer up. Pinned by career-apply-chain-gate.test.ts.
    applyContext: i.applyContext,
  });
  return credentialRefusal(out && out.session) ?? { status: 'success', outputs: out };
}

const MAX_ROUNDS = 40; // the session's step ceiling and wall clock bound this anyway

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

/**
 * Drives a session from wherever `task` left it to a terminal state:
 *  - `awaiting_approval` → raise an approval for exactly that action (its own
 *    resume key, the opener as the only approver), then record the answer;
 *  - `running` (the provider is still working) → advance it, and wait on a
 *    timer between polls (keyed by the session's own idle count, so every wait
 *    is a fresh durable key) — grade-code CU2CD-1: without this the chain ended
 *    while the session was still live and nothing ever drove it again.
 * Re-invoked after each suspend; every pass re-reads the session first, so an
 * approval answered after the session ended (stopped, run cancelled, opener
 * removed, time ceiling) finds it terminal and returns it — no error
 * (grade-ux CU2UX-4).
 */
export async function decide(ctx) {
  const cu = ensure(ctx, 'decide');
  ensure(ctx, 'status');
  ensure(ctx, 'resume');
  const i = ctx.inputs ?? {};
  const sessionId = str(i.sessionId) || str(i.session && i.session.sessionId);
  if (!sessionId) {
    throw Object.assign(new Error('decide needs `sessionId` (or the `session` output of a task node)'), { code: 'validation_error' });
  }
  let session = (await cu.status({ sessionId })).session;
  for (let n = 0; n < MAX_ROUNDS && session; n += 1) {
    if (session.status !== 'awaiting_approval' && session.status !== 'running' && session.status !== 'starting') break;
    if (!session.decidable) {
      throw Object.assign(new Error('Only the person who started this browser session can decide its actions.'), { code: 'forbidden' });
    }
    if (typeof ctx.suspend !== 'function') {
      throw Object.assign(new Error('host does not support suspend — a browser session cannot be driven here'), { code: 'host_capability_missing' });
    }
    if (session.status !== 'awaiting_approval' || !session.pendingAction) {
      const before = session;
      session = (await cu.resume({ sessionId })).session;
      if (session && session.status === 'running' && session.steps === before.steps) {
        await ctx.suspend({
          reason: 'duration',
          resumeKey: `cu-wait:${sessionId}:${session.steps}:${session.idleRounds}`,
          seconds: typeof before.waitSeconds === 'number' ? before.waitSeconds : 5,
        });
        session = (await cu.status({ sessionId })).session;
      }
      continue;
    }
    const action = session.pendingAction;
    // Addendum 2 — the host's own projection of what the card shows, copied
    // verbatim: the digest it carries is of exactly these fields.
    const shown = session.pendingShown || { kind: action.kind, url: action.url || '', origin: originOf(action.url) || originOf(session.startUrl || ''), note: '' };
    const origin = shown.origin;
    const note = shown.note;
    const verdict = await ctx.suspend({
      reason: 'approval',
      // G-A — keyed by the action's DIGEST too: a changed action under the same
      // provider id is a new question, never the old answer.
      resumeKey: `cu-approve:${sessionId}:${action.actionId}:${session.pendingDigest}`,
      // Host-composed, and the fallback for a client that does not render the
      // structured `computerUse` block. The provider's description is
      // page-derived text, so it is never the instruction the approver reads —
      // it rides `providerNote`, which the card labels as unverified.
      prompt: `Allow the browser agent to ${action.kind}${origin ? ` on ${origin}` : ''}?`,
      actions: ['approve', 'reject'],
      approverRefs: [session.approverRef],
      computerUse: { sessionId, actionId: action.actionId, kind: shown.kind, url: shown.url, origin, digest: session.pendingDigest },
      ...(note ? { providerNote: note } : {}),
    });
    const verb = verdict && typeof verdict === 'object' ? verdict.action : undefined;
    const approve = verb === 'approve' || verb === 'accept';
    session = (await cu.decide({ sessionId, approve, nodeId: ctx.nodeId })).session;
  }
  return credentialRefusal(session) ?? { status: 'success', outputs: { session } };
}

export async function status(ctx) {
  const cu = ensure(ctx, 'status');
  const i = ctx.inputs ?? {};
  const out = await cu.status({ sessionId: str(i.sessionId) });
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.computer-use.nodes.task': task,
  'feature.computer-use.nodes.decide': decide,
  'feature.computer-use.nodes.status': status,
};
export default nodes;
