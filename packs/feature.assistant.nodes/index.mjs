/**
 * feature.assistant.nodes — the THIN graph/logic pack for the Executive Assistant
 * (ADR 0023 / 0014). Every node operates on the memory graph + prioritization via
 * `ctx.features.assistant` (+ the host board for populate-board). NO external I/O
 * lives here — Drive/Gmail/Calendar reads and mail sends are the existing core
 * packs (core.openwop.{mcp,http,integration}), composed in the loop workflows.
 *
 * role:"action" nodes read/write the tenant graph (recorded → replay/fork read the
 * recorded output). prioritize is role:"pure" (deterministic, cacheable).
 * Pure-JS, Node-20 stdlib only.
 */

import { createHash } from 'node:crypto';

function ensureAssistant(ctx) {
  const a = ctx.features && ctx.features.assistant;
  if (!a || typeof a.upsertCommitment !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.assistant — the Executive Assistant feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.assistant' },
    );
  }
  return a;
}

const I = (ctx) => ctx.inputs ?? {};
const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const str = (v) => (typeof v === 'string' ? v : '');
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export async function upsertCommitment(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  if (!str(i.description)) {
    throw Object.assign(new Error('upsert-commitment requires `description`'), { code: 'validation_error' });
  }
  const out = await a.upsertCommitment({
    owner: i.owner ?? { kind: 'self' },
    description: i.description,
    source: i.source ?? { kind: 'manual', externalId: '', text: i.description },
    ...(i.dueAt !== undefined ? { dueAt: i.dueAt } : {}),
    ...(i.confidence !== undefined ? { confidence: i.confidence } : {}),
    ...(i.projectId !== undefined ? { projectId: i.projectId } : {}),
  });
  return { status: 'success', outputs: { commitment: out.commitment, created: out.created } };
}

export async function populateBoard(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  if (!str(i.commitmentId)) {
    throw Object.assign(new Error('populate-board requires `commitmentId`'), { code: 'validation_error' });
  }
  const out = await a.projectToBoard({
    commitmentId: i.commitmentId,
    ...(i.boardId !== undefined ? { boardId: i.boardId } : {}),
    ...(i.ownerUserId !== undefined ? { ownerUserId: i.ownerUserId } : {}),
  });
  return { status: 'success', outputs: { card: out.card ?? null, created: !!out.created } };
}

export async function prioritize(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  const out = await a.prioritize({
    senderImportance: numOr(i.senderImportance, 0),
    deadlineProximity: numOr(i.deadlineProximity, 0),
    projectPriority: numOr(i.projectPriority, 0),
    priorEngagement: numOr(i.priorEngagement, 0),
    ...(i.profile !== undefined ? { profile: i.profile } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function composeBriefing(ctx) {
  const a = ensureAssistant(ctx);
  // ADR 0023 §12 T3 — prefer the host's single briefing composer (source
  // citations + "why surfaced" + the notify delivery, briefing.ts). The
  // inline composition below remains as the fallback for hosts that expose
  // the graph surface but not the composer.
  if (typeof a.composeBriefing === 'function') {
    const cfg = ctx.config ?? {};
    const out = await a.composeBriefing({
      ...(cfg.notify === true ? { notify: true } : {}),
      ...(typeof cfg.profile === 'string' ? { profile: cfg.profile } : {}),
    });
    return { status: 'success', outputs: { brief: out.brief } };
  }
  const [open, meetings, pending] = await Promise.all([
    a.listCommitments({ status: 'open' }),
    a.listMeetings({}),
    a.listPendingActions({ status: 'pending' }),
  ]);
  const commitments = open.commitments ?? [];
  const upcoming = (meetings.meetings ?? []).slice(0, 5);
  const awaiting = pending.pendingActions ?? [];
  const brief = {
    generatedAt: new Date().toISOString(),
    headline: `${commitments.length} open commitment(s), ${upcoming.length} upcoming meeting(s), ${awaiting.length} awaiting your approval`,
    topCommitments: commitments.slice(0, 10),
    upcomingMeetings: upcoming,
    awaitingApproval: awaiting,
  };
  return { status: 'success', outputs: { brief } };
}

export async function enqueueAction(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  if (!str(i.kind) || !str(i.draft)) {
    throw Object.assign(new Error('enqueue-action requires `kind` and `draft`'), { code: 'validation_error' });
  }
  const out = await a.enqueueAction({
    kind: i.kind,
    draft: i.draft,
    payload: i.payload ?? {},
    ...(i.sourceCommitmentId !== undefined ? { sourceCommitmentId: i.sourceCommitmentId } : {}),
  });
  return { status: 'success', outputs: { pendingAction: out.pendingAction } };
}


/**
 * ingest-commitments — the deterministic perception leg of Loops 1/6 (ADR 0023
 * §12 T2). Takes the upstream HTTP node's fetched provider listing (Calendar
 * events / Drive files via `core.openwop.http.fetch` + the ADR 0024 Phase D
 * `config.connection` credential), derives candidate commitments, and upserts
 * them through `ctx.features.assistant` — idempotently (the source contentHash
 * keys on the item's PROVIDER IDENTITY, so a re-listed item updates in place
 * and re-runs never duplicate).
 *
 * Every SourceRef is stamped `contentTrust:'untrusted'` (ADR 0027 — provider-
 * derived content is data, never authority). `maxItemsPerTick` caps a tick's
 * graph writes (ADR 0029 — bounded ingestion ahead of full indexing); overflow
 * is reported via `capped`, picked up next tick.
 *
 * The LLM `extractor` agent (loop 2) supersedes this transform for free-text
 * sources once deploy-gated Google MCP + agent dispatch are live; this node is
 * the deterministic, replayable floor.
 */
export async function ingestCommitments(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  const cfg = ctx.config ?? {};
  const sourceKind = cfg.sourceKind === 'drive' ? 'drive' : 'calendar';
  const cap = Math.max(1, numOr(cfg.maxItemsPerTick, 25));
  // Upstream `core.openwop.http.fetch` outputs {status, headers, body}.
  const body = i && typeof i === 'object' && 'body' in i ? i.body : i;
  const listed = sourceKind === 'calendar' ? body?.items : body?.files;
  const items = Array.isArray(listed) ? listed : [];
  const capturedAt = new Date().toISOString();

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of items.slice(0, cap)) {
    const externalId = str(item?.id);
    const title = sourceKind === 'calendar' ? str(item?.summary) : str(item?.name);
    if (!externalId || !title) {
      skipped += 1;
      continue;
    }
    const description = sourceKind === 'calendar'
      ? `Prepare for "${title}"`
      : `Review updates to "${title}"`;
    const url = sourceKind === 'calendar' ? str(item?.htmlLink) : str(item?.webViewLink);
    const dueAt = sourceKind === 'calendar' ? str(item?.start?.dateTime ?? item?.start?.date) : '';
    const out = await a.upsertCommitment({
      owner: { kind: 'self' },
      description,
      source: {
        kind: sourceKind,
        externalId,
        // Identity-keyed (not content-keyed): a moved/edited item keeps the
        // same commitment row and updates in place. A renamed item derives a
        // new description and therefore a new row — acceptable sample-grade.
        contentHash: hashOf(`${sourceKind}:${externalId}`),
        capturedAt,
        contentTrust: 'untrusted',
        ...(url ? { url } : {}),
      },
      confidence: 0.6,
      ...(dueAt ? { dueAt } : {}),
    });
    if (out.created) created += 1;
    else updated += 1;
  }
  return {
    status: 'success',
    outputs: { sourceKind, created, updated, skipped, capped: items.length > cap, scanned: Math.min(items.length, cap) },
  };
}


/**
 * prepare-action-request — pure transform for the T6 execution workflows
 * (ADR 0023 §12 T6). Maps an approved PendingAction (kind/payload/draft)
 * into the HTTP request shape the downstream `core.openwop.http.fetch`
 * node dispatches under the approving principal's WRITE-scoped connection
 * (ADR 0024 Phase C/D). Deterministic — replay reproduces the same request.
 */
export async function prepareActionRequest(ctx) {
  const i = I(ctx);
  const action = i && typeof i === 'object' && i.action && typeof i.action === 'object' ? i.action : i;
  const kind = str(action?.kind);
  const payload = action?.payload && typeof action.payload === 'object' ? action.payload : {};
  const draft = str(action?.draft);

  if (kind === 'email.send') {
    // SECURITY — header-injection defense: `to`/`subject` interpolate into
    // RFC-822 HEADER LINES and may derive from untrusted connected content
    // (ADR 0027). A CR/LF inside either would inject arbitrary headers
    // (e.g. a silent Bcc) into a message sent AS the approving user. Strip
    // all CR/LF; additionally drop `to` entries that don't look like a
    // bare address after stripping.
    const headerSafe = (v) => str(v).replace(/[\r\n]+/g, ' ').trim();
    const to = (Array.isArray(payload.to) ? payload.to.filter((t) => typeof t === 'string') : typeof payload.to === 'string' ? [payload.to] : [])
      .map(headerSafe)
      .filter((t) => /^[^\s,;@]+@[^\s,;@]+$/.test(t));
    if (to.length === 0) {
      throw Object.assign(new Error('email.send requires at least one valid recipient address'), { code: 'validation_error' });
    }
    const subject = headerSafe(payload.subject) || 'Follow-up from your assistant';
    const rfc822 = [`To: ${to.join(', ')}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', draft].join('\r\n');
    // Gmail wants base64url of the raw RFC-822 message.
    const raw = Buffer.from(rfc822, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { status: 'success', outputs: { body: { raw }, variables: {} } };
  }
  if (kind === 'calendar.invite') {
    const event = payload.event && typeof payload.event === 'object' ? payload.event : { summary: draft };
    return { status: 'success', outputs: { body: event, variables: {} } };
  }
  if (kind === 'calendar.reschedule') {
    const eventId = str(payload.eventId);
    if (!eventId) {
      throw Object.assign(new Error('calendar.reschedule requires payload.eventId'), { code: 'validation_error' });
    }
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
    return { status: 'success', outputs: { body: patch, variables: { eventId } } };
  }
  throw Object.assign(new Error(`prepare-action-request: unsupported kind '${kind}'`), { code: 'validation_error' });
}


/**
 * confirm-action-send — the execution verdict (ADR 0023 §12 T6 under ADR 0024
 * Option C). `core.openwop.http.fetch` NEVER fails its node — non-2xx and even
 * pure network failure complete with `outputs.status` (side-effect-once
 * caching) — so without this gate an unauthenticated 401 from the provider
 * would complete the run and the terminal projection would mark the action
 * `sent`. This node fails the run unless the provider answered 2xx, which is
 * what flips the action to `failed` honestly.
 */
export async function confirmActionSend(ctx) {
  const i = I(ctx);
  const status = typeof i.status === 'number' ? i.status : 0;
  if (status >= 200 && status < 300) {
    return { status: 'success', outputs: { providerStatus: status } };
  }
  throw Object.assign(
    new Error(`provider send failed (HTTP ${status || 'network error'})${typeof i.networkError === 'string' ? `: ${i.networkError}` : ''}`),
    { code: 'send_failed' },
  );
}

export const nodes = {
  'feature.assistant.nodes.upsert-commitment': upsertCommitment,
  'feature.assistant.nodes.populate-board': populateBoard,
  'feature.assistant.nodes.prioritize': prioritize,
  'feature.assistant.nodes.compose-briefing': composeBriefing,
  'feature.assistant.nodes.enqueue-action': enqueueAction,
  'feature.assistant.nodes.ingest-commitments': ingestCommitments,
  'feature.assistant.nodes.prepare-action-request': prepareActionRequest,
  'feature.assistant.nodes.confirm-action-send': confirmActionSend,
};

export default nodes;
