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
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * ADR 0051 §5 — the host-pinned A2UI catalog this producer targets. Mirrors the
 * renderer's `A2UI_CATALOG_VERSION` (frontend `chat/a2ui/catalog.ts`) and the
 * core wire schema's `catalogVersion` enum (RFC 0102 `ui.a2ui-surface`). Kept as
 * a literal here (same posture as the `local.openwop-app.a2ui-clarify` node) so
 * the pure-JS pack carries no cross-package import.
 */
const A2UI_CATALOG_VERSION = '0.9.1';

/** A `calendar.invite` is sendable only with a title, a start, and ≥1 attendee.
 *  Returns the subset of those a drafted Google-Calendar `event` still lacks —
 *  the fields the A2UI clarification surface will ask for. */
function missingCalendarInviteFields(event) {
  const e = event && typeof event === 'object' ? event : {};
  const missing = [];
  if (!str(e.summary)) missing.push('summary');
  const start = e.start && typeof e.start === 'object' ? e.start : {};
  if (!str(start.dateTime) && !str(start.date)) missing.push('start');
  const attendees = Array.isArray(e.attendees)
    ? e.attendees.filter((x) => (x && typeof x === 'object' && str(x.email)) || (typeof x === 'string' && x.trim()))
    : [];
  if (attendees.length === 0) missing.push('attendees');
  return missing;
}

/** Start-time options for the clarification surface — 30-minute slots across a
 *  working day (08:00–18:00). A constrained `field.select` (not a free-text
 *  field) so the user can only pick a valid `HH:MM`: the day-1 catalog 0.9.1 has
 *  no native time picker, but `field.select` IS in the catalog, so this is the
 *  best time UX achievable WITHOUT a wire/catalog change. `value` is the 24-hour
 *  `HH:MM` `mergeCalendarInviteResume` parses; `label` is 12-hour for humans. */
const TIME_SLOTS = (() => {
  const out = [];
  for (let mins = 8 * 60; mins <= 18 * 60; mins += 30) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const h12 = ((h + 11) % 12) + 1;
    out.push({ value: `${pad2(h)}:${pad2(m)}`, label: `${h12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}` });
  }
  return out;
})();

/** Shared meeting-duration options for the clarification surfaces. */
const DURATION_OPTIONS = [
  { value: '30', label: '30 minutes' },
  { value: '60', label: '60 minutes' },
  { value: '90', label: '90 minutes' },
];

/**
 * Build the `{ start, end }` Google-Calendar dateTime pair from the resume
 * `date` / `time` / `durationMinutes` values, shared by the invite and
 * reschedule clarifiers. The resume value is UNTRUSTED (a non-conforming client
 * or A2A agent can post anything), so it is validated, never interpolated
 * blindly: an unparseable `time` falls back to 09:00, and an unparseable DATE
 * (e.g. "2026-13-45" passes a regex yet `new Date` rejects it) returns `null` so
 * the caller leaves the slot unset rather than emitting a `NaN`-laced dateTime.
 * Deterministic — only the recorded resume string is parsed, never the wall
 * clock — so the resumed run replays exactly. The offset-less dateTime is
 * stamped `timeZone:'UTC'` (the frame the end arithmetic is anchored in) so the
 * Google Calendar API accepts it (sample-grade; a real host resolves the user's
 * zone). Returns `null` when no usable date was supplied.
 */
function buildEventTimes(values) {
  const v = values && typeof values === 'object' ? values : {};
  if (!str(v.date)) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(v.time));
  const hh = m ? parseInt(m[1], 10) : Number.NaN;
  const mm = m ? parseInt(m[2], 10) : Number.NaN;
  const timeOk = m !== null && hh >= 0 && hh < 24 && mm >= 0 && mm < 60;
  const h = timeOk ? hh : 9;
  const min = timeOk ? mm : 0;
  const durationParsed = parseInt(str(v.durationMinutes), 10);
  const durationMinutes = Number.isFinite(durationParsed) && durationParsed > 0 ? durationParsed : 30;
  const startDateTime = `${str(v.date)}T${pad2(h)}:${pad2(min)}:00`;
  const start = new Date(`${startDateTime}Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const fmt = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:00`;
  return {
    start: { dateTime: startDateTime, timeZone: 'UTC' },
    end: { dateTime: fmt(end), timeZone: 'UTC' },
  };
}

/**
 * Build the A2UI clarification surface for an incomplete `calendar.invite`,
 * asking ONLY for the missing essentials (RFC 0102 `ui.a2ui-surface` shape, the
 * `data.surface` the chat's `a2uiInterruptCard` bridge renders). Uses only the
 * day-1 catalog (0.9.1) components — `text`/`field.text`/`field.date`/
 * `field.select`/`action.button` — so the renderer's closed-catalog validation
 * accepts it; the confirm button's `action.target:'resume'` confines the action
 * to the interrupt-resume path. Returns `{ missing, surface }`.
 */
function buildCalendarInviteClarifySurface(event) {
  const missing = missingCalendarInviteFields(event);
  const components = [
    { component: 'text', text: "A few details and I'll send the calendar invite." },
  ];
  if (missing.includes('summary')) {
    components.push({ component: 'field.text', id: 'summary', label: 'Title', placeholder: 'Kickoff with Acme', required: true });
  }
  if (missing.includes('start')) {
    components.push({ component: 'field.date', id: 'date', label: 'Date', required: true });
    // A constrained slot picker (not free text) — the user can only pick a valid
    // time, so a malformed `time` is unreachable through the UI (the server-side
    // guard in mergeCalendarInviteResume remains for non-conforming clients).
    components.push({ component: 'field.select', id: 'time', label: 'Start time', required: true, options: TIME_SLOTS });
    components.push({ component: 'field.select', id: 'durationMinutes', label: 'Duration', options: DURATION_OPTIONS });
  }
  if (missing.includes('attendees')) {
    components.push({ component: 'field.text', id: 'attendees', label: 'Attendees (comma-separated emails)', placeholder: 'sam@acme.com, lee@acme.com', required: true });
  }
  components.push({ component: 'action.button', id: 'confirm', label: 'Confirm invite', action: { target: 'resume' } });
  return { missing, surface: { title: 'Confirm the invite', components } };
}

/**
 * Merge the resume values from the A2UI clarification surface back into the
 * Google-Calendar `event`. Sample-grade: a floating (no-timezone) local
 * `dateTime` is built from `date` + `time`; `end = start + durationMinutes`.
 * Deterministic — the only time read is parsing the user-supplied (recorded)
 * date/time string, never the wall clock — so the resumed run replays exactly.
 * Existing event fields survive where the surface didn't ask (it only asks for
 * the missing ones).
 */
function mergeCalendarInviteResume(event, values) {
  const e = { ...(event && typeof event === 'object' ? event : {}) };
  const v = values && typeof values === 'object' ? values : {};
  if (str(v.summary)) e.summary = str(v.summary);
  const times = buildEventTimes(v);
  if (times) {
    e.start = times.start;
    e.end = times.end;
  }
  if (str(v.attendees)) {
    const emails = parseEmailList(str(v.attendees));
    if (emails.length > 0) e.attendees = emails.map((email) => ({ email }));
  }
  return e;
}

/** Split a comma-separated string into validated bare email addresses. The
 *  regex excludes whitespace/comma/semicolon, so a result can never carry a
 *  CR/LF — the header-injection defense `prepare-action-request` relies on. */
function parseEmailList(s) {
  return str(s)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^[^\s,;@]+@[^\s,;@]+$/.test(x));
}

/** An `email.send` cannot go out without a recipient; subject has a default
 *  (`prepare-action-request`) so it is asked-but-not-blocking. Returns the
 *  missing fields the clarification surface offers. */
function missingEmailSendFields(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const to = Array.isArray(p.to) ? p.to : typeof p.to === 'string' ? [p.to] : [];
  const validTo = to.filter((t) => typeof t === 'string' && /^[^\s,;@]+@[^\s,;@]+$/.test(t.trim()));
  const missing = [];
  if (validTo.length === 0) missing.push('to');
  if (!str(p.subject)) missing.push('subject');
  return missing;
}

/** Build the A2UI clarification surface for an `email.send` the assistant
 *  drafted without a recipient (and optionally without a subject). Same closed
 *  catalog + `action.target:'resume'` confinement as the calendar surface. */
function buildEmailSendClarifySurface(payload) {
  const missing = missingEmailSendFields(payload);
  const components = [
    { component: 'text', text: 'I drafted the email — confirm where it should go.' },
  ];
  if (missing.includes('to')) {
    components.push({ component: 'field.text', id: 'to', label: 'Recipients (comma-separated emails)', placeholder: 'sam@acme.com, lee@acme.com', required: true });
  }
  if (missing.includes('subject')) {
    components.push({ component: 'field.text', id: 'subject', label: 'Subject', placeholder: 'Quick follow-up' });
  }
  components.push({ component: 'action.button', id: 'confirm', label: 'Queue for approval', action: { target: 'resume' } });
  return { missing, surface: { title: 'Confirm the email', components } };
}

/** Merge the resumed recipient / subject back into the `email.send` payload.
 *  Recipients are re-validated (untrusted resume value); a blank result leaves
 *  the existing `to` untouched. */
function mergeEmailSendResume(payload, values) {
  const p = { ...(payload && typeof payload === 'object' ? payload : {}) };
  const v = values && typeof values === 'object' ? values : {};
  if (str(v.to)) {
    const emails = parseEmailList(str(v.to));
    if (emails.length > 0) p.to = emails;
  }
  if (str(v.subject)) p.subject = str(v.subject);
  return p;
}

/** A `calendar.reschedule` carries `{ eventId, patch }` (`prepare-action-request`).
 *  Whether the drafted `patch` already names a new start. */
function rescheduleHasNewStart(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const patch = p.patch && typeof p.patch === 'object' ? p.patch : {};
  const start = patch.start && typeof patch.start === 'object' ? patch.start : {};
  return !!(str(start.dateTime) || str(start.date));
}

/** Build the A2UI surface for a `calendar.reschedule` whose new time is unset —
 *  a date + slot picker + duration (the same constrained controls as the invite
 *  surface). The catalog has no event picker, so a missing `eventId` is NOT
 *  clarified here (the dispatcher only offers this when the event is known). */
function buildRescheduleClarifySurface() {
  return {
    surface: {
      title: 'Pick a new time',
      components: [
        { component: 'text', text: 'When should I move this to?' },
        { component: 'field.date', id: 'date', label: 'New date', required: true },
        { component: 'field.select', id: 'time', label: 'New start time', required: true, options: TIME_SLOTS },
        { component: 'field.select', id: 'durationMinutes', label: 'Duration', options: DURATION_OPTIONS },
        { component: 'action.button', id: 'confirm', label: 'Reschedule', action: { target: 'resume' } },
      ],
    },
  };
}

/** Merge the resumed new time into the reschedule `patch.start`/`patch.end`,
 *  reusing the shared (validated, replay-safe) time builder. Other patch fields
 *  and the `eventId` survive untouched. */
function mergeRescheduleResume(payload, values) {
  const p = { ...(payload && typeof payload === 'object' ? payload : {}) };
  const times = buildEventTimes(values);
  if (times) {
    const patch = p.patch && typeof p.patch === 'object' ? p.patch : {};
    p.patch = { ...patch, start: times.start, end: times.end };
  }
  return p;
}

/**
 * ADR 0051 §3/§5 — per-`PendingAction`-kind clarification dispatcher. For a
 * drafted action the assistant can't yet complete, returns a plan to raise ONE
 * A2UI clarification surface on the shared interrupt→`a2uiInterruptCard` bridge,
 * or `null` when nothing is missing (the enqueue proceeds untouched). Each kind
 * owns how it reads/writes its own payload shape, so adding a kind is one branch
 * here — no parallel surface. `merge` folds the resumed values back into the
 * payload that the single `enqueueActionWithApproval` path then enqueues.
 */
function planClarification(kind, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (kind === 'calendar.invite') {
    const event = p.event && typeof p.event === 'object' ? p.event : {};
    const { missing, surface } = buildCalendarInviteClarifySurface(event);
    if (missing.length === 0) return null;
    return {
      resumeKey: 'calendar-invite-clarify',
      question: "A few details and I'll send the calendar invite.",
      surface,
      merge: (values) => ({ ...p, event: mergeCalendarInviteResume(event, values) }),
    };
  }
  if (kind === 'email.send') {
    // Only a MISSING RECIPIENT is blocking — a subject-only gap has a default,
    // so we don't interrupt for it (would duplicate the human approval step).
    const { missing, surface } = buildEmailSendClarifySurface(p);
    if (!missing.includes('to')) return null;
    return {
      resumeKey: 'email-send-clarify',
      question: 'Who should this email go to?',
      surface,
      merge: (values) => mergeEmailSendResume(p, values),
      // After clarification a recipient is REQUIRED. If the resume value carried
      // no valid address (all entries dropped by re-validation), fail fast with
      // a clear error here rather than enqueue an email that can't be sent — the
      // user learns at the point of clarification, not at a downstream send.
      requireAfter: (merged) => (missingEmailSendFields(merged).includes('to') ? 'a valid recipient' : null),
    };
  }
  if (kind === 'calendar.reschedule') {
    // Clarify only when we know WHICH event but not the new time — the catalog
    // has no event picker, so a missing `eventId` isn't clarifiable here (it
    // fails downstream in `prepare-action-request`, honestly).
    const eventId = str(p.eventId);
    if (eventId === '' || rescheduleHasNewStart(p)) return null;
    return {
      resumeKey: 'calendar-reschedule-clarify',
      question: 'When should I move this to?',
      surface: buildRescheduleClarifySurface().surface,
      merge: (values) => mergeRescheduleResume(p, values),
      // If the resumed date was unusable, the patch still has no new start —
      // fail fast rather than enqueue a no-op reschedule.
      requireAfter: (merged) => (rescheduleHasNewStart(merged) ? null : 'a new time'),
    };
  }
  return null;
}

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
  let payload = i.payload && typeof i.payload === 'object' ? i.payload : {};

  // ADR 0051 §3/§5 — when the assistant drafts an action it can't yet complete
  // (a `calendar.invite` missing essentials, an `email.send` with no recipient),
  // it clarifies IN CHAT via an A2UI surface on the SAME interrupt→
  // `a2uiInterruptCard` bridge as `local.openwop-app.a2ui-clarify`, instead of
  // enqueuing a half-formed action. `ctx.suspend` (interrupt.md awaitable
  // primitive) raises a `clarification` interrupt whose `data` carries
  // `{catalogVersion, surface}`; the chat renders the missing-field form, and
  // the collected values resume here and merge into the payload before the
  // single enqueue path runs. Strictly additive — gated on the awaitable
  // primitive being present (a real executor run) AND the per-kind dispatcher
  // finding something to ask; in every other case the enqueue below is unchanged.
  if (typeof ctx.suspend === 'function') {
    const plan = planClarification(i.kind, payload);
    if (plan) {
      const values = await ctx.suspend({
        reason: 'clarification',
        resumeKey: plan.resumeKey,
        // Free-text fallback for any consumer that doesn't render A2UI surfaces.
        question: plan.question,
        catalogVersion: A2UI_CATALOG_VERSION,
        surface: plan.surface,
      });
      payload = plan.merge(values && typeof values === 'object' ? values : {});
      const stillMissing = plan.requireAfter ? plan.requireAfter(payload) : null;
      if (stillMissing) {
        throw Object.assign(
          new Error(`enqueue-action: ${i.kind} still needs ${stillMissing} after clarification`),
          { code: 'validation_error' },
        );
      }
    }
  }

  const out = await a.enqueueAction({
    kind: i.kind,
    draft: i.draft,
    payload,
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

// ── Memory-graph reads (ADR 0023) — role:"action": they read the tenant graph
//    (a side-effect), so the engine records each output and replay/fork read the
//    recorded result rather than re-querying. Thin wrappers over ctx.features.assistant.
export async function listProjects(ctx) {
  const a = ensureAssistant(ctx);
  const out = await a.listProjects({});
  return { status: 'success', outputs: { projects: out.projects ?? [] } };
}

export async function getProject(ctx) {
  const a = ensureAssistant(ctx);
  const out = await a.getProject({ projectId: str(I(ctx).projectId) });
  return { status: 'success', outputs: { project: out.project ?? null } };
}

export async function listCommitments(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  const out = await a.listCommitments({
    ...(str(i.status) ? { status: str(i.status) } : {}),
    ...(str(i.projectId) ? { projectId: str(i.projectId) } : {}),
  });
  return { status: 'success', outputs: { commitments: out.commitments ?? [] } };
}

export async function listDecisions(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  const out = await a.listDecisions({ ...(str(i.projectId) ? { projectId: str(i.projectId) } : {}) });
  return { status: 'success', outputs: { decisions: out.decisions ?? [] } };
}

export async function getMeeting(ctx) {
  const a = ensureAssistant(ctx);
  const out = await a.getMeeting({ meetingId: str(I(ctx).meetingId) });
  return { status: 'success', outputs: { meeting: out.meeting ?? null } };
}

export async function listMeetings(ctx) {
  const a = ensureAssistant(ctx);
  const out = await a.listMeetings({});
  return { status: 'success', outputs: { meetings: out.meetings ?? [] } };
}

export async function listStakeholders(ctx) {
  const a = ensureAssistant(ctx);
  const out = await a.listStakeholders({});
  return { status: 'success', outputs: { stakeholders: out.stakeholders ?? [] } };
}

export async function listPendingActions(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  const out = await a.listPendingActions({ ...(str(i.status) ? { status: str(i.status) } : {}) });
  return { status: 'success', outputs: { pendingActions: out.pendingActions ?? [] } };
}

// ── Memory-graph writes (ADR 0023) — role:"action": outputs recorded, so a
//    replay/fork reads the recorded result rather than re-issuing the write.
export async function setCommitmentCard(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  if (!str(i.commitmentId) || !str(i.kanbanCardId)) {
    throw Object.assign(new Error('set-commitment-card requires `commitmentId` and `kanbanCardId`'), { code: 'validation_error' });
  }
  const out = await a.setCommitmentCard({ commitmentId: str(i.commitmentId), kanbanCardId: str(i.kanbanCardId) });
  return { status: 'success', outputs: { commitment: out.commitment ?? null } };
}

export async function logDecision(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  if (!str(i.statement)) {
    throw Object.assign(new Error('log-decision requires `statement`'), { code: 'validation_error' });
  }
  const out = await a.logDecision({
    statement: str(i.statement),
    decidedBy: i.decidedBy ?? { kind: 'self' },
    source: i.source ?? { kind: 'manual', externalId: '', text: str(i.statement) },
    ...(str(i.rationale) ? { rationale: str(i.rationale) } : {}),
    ...(str(i.projectId) ? { projectId: str(i.projectId) } : {}),
  });
  return { status: 'success', outputs: { decision: out.decision } };
}

export async function recordMeeting(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  if (!str(i.calendarEventId) || !str(i.title) || !str(i.startAt)) {
    throw Object.assign(new Error('record-meeting requires `calendarEventId`, `title`, and `startAt`'), { code: 'validation_error' });
  }
  const out = await a.recordMeeting({
    calendarEventId: str(i.calendarEventId),
    title: str(i.title),
    startAt: str(i.startAt),
    ...(str(i.endAt) ? { endAt: str(i.endAt) } : {}),
    ...(str(i.prepBriefRef) ? { prepBriefRef: str(i.prepBriefRef) } : {}),
    ...(str(i.transcriptKbDocId) ? { transcriptKbDocId: str(i.transcriptKbDocId) } : {}),
  });
  return { status: 'success', outputs: { meeting: out.meeting } };
}

export async function upsertStakeholder(ctx) {
  const a = ensureAssistant(ctx);
  const i = I(ctx);
  if (i.person === undefined) {
    throw Object.assign(new Error('upsert-stakeholder requires `person`'), { code: 'validation_error' });
  }
  const out = await a.upsertStakeholder({
    person: i.person,
    ...(i.importance !== undefined ? { importance: i.importance } : {}),
    ...(i.intendedCadenceDays !== undefined ? { intendedCadenceDays: i.intendedCadenceDays } : {}),
    ...(str(i.lastMeaningfulContactAt) ? { lastMeaningfulContactAt: str(i.lastMeaningfulContactAt) } : {}),
  });
  return { status: 'success', outputs: { stakeholder: out.stakeholder } };
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
  'feature.assistant.nodes.list-projects': listProjects,
  'feature.assistant.nodes.get-project': getProject,
  'feature.assistant.nodes.list-commitments': listCommitments,
  'feature.assistant.nodes.list-decisions': listDecisions,
  'feature.assistant.nodes.get-meeting': getMeeting,
  'feature.assistant.nodes.list-meetings': listMeetings,
  'feature.assistant.nodes.list-stakeholders': listStakeholders,
  'feature.assistant.nodes.list-pending-actions': listPendingActions,
  'feature.assistant.nodes.set-commitment-card': setCommitmentCard,
  'feature.assistant.nodes.log-decision': logDecision,
  'feature.assistant.nodes.record-meeting': recordMeeting,
  'feature.assistant.nodes.upsert-stakeholder': upsertStakeholder,
};

export default nodes;
