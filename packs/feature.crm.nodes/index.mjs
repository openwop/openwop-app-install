/**
 * feature.crm.nodes — CRM nodes (ADR 0001 §4 / ADR 0014 reference feature).
 *
 * Two PURE nodes back the CRM toggle's A/B variant bindings: `triage` (basic
 * stage-only scoring) and `triage-enriched` (adds a company-signal bump). Pure
 * + deterministic — same inputs → same outputs — so a run that uses them
 * replays identically.
 *
 * Nine role:"action" READ nodes expose the `ctx.features.crm` surface
 * (companies / deals / tasks / segments / bookings / sign status). Thirteen
 * role:"side-effect" WRITE nodes (ADR 0208 §2; classified ADR 0627 D1) expose
 * the surface's governed mutation verbs (create/update/convert/move/complete/
 * log/persist/book/sign). Every surface-backed node reads the SAME merged args shape —
 * `{ ...ctx.config, ...ctx.inputs }` (the `core.openwop.ai`/`core.openwop.agents`
 * idiom): `ctx.config` carries chain-authored, param-templated values (resolved
 * by the executor from `{{inputs.*}}` before the node runs); `ctx.inputs` carries
 * whatever the DAG's incoming edge forwarded (an upstream node's output, or — for
 * a source node — the run's raw input payload). Reading both lets the SAME node
 * work whether it's driven by an agent tool call (args land in `ctx.inputs`) or a
 * chain-pack DAG (values may land in either, depending on node position).
 *
 * They read/write the tenant store, so the engine records their outputs and a
 * replay reads the recorded result rather than re-querying. The WRITE nodes are
 * `role:"side-effect"` + `side-effectful` (ADR 0627 D1): the derived floor /
 * served set (`scripts/gen-side-effect-floor.mjs`) is what makes a
 * `mode:'replay'` fork SERVE the source run's recorded outcome instead of
 * re-executing the write; a `branch` fork re-runs the tail live by design. The
 * `ctx.features.crm` surface enforces the tenant+org key (CTI-1) — a cross-tenant
 * id is simply not found — and every write there calls the SAME service function
 * the HTTP routes call, emitting the same host event + audit row (ADR 0208 §1/§3).
 *
 * Creation nodes (create-contact/create-company/create-deal/create-task/
 * log-activity/persist-segment/booking-create-link/sign-request) default their id
 * to a deterministic `<prefix>:${ctx.runId}:${ctx.nodeId}` when the caller doesn't
 * supply one (ADR 0162). That is a PER-RUN dedupe key — a retried node in the same
 * run converges on one row — NOT a cross-run fork guard: a fork has its own runId,
 * so the key alone would mint a second row. The classification above is the guard.
 *
 * Pure-JS, Node-20 stdlib only.
 */

/** Resolve the CRM feature surface, or fail with the canonical capability error
 *  (workflow-register should refuse a workflow needing it on a host that doesn't
 *  expose it — ADR 0014 Phase 4 gating; this is the runtime backstop). */
function ensureCrm(ctx) {
  const crm = ctx.features && ctx.features.crm;
  if (!crm || typeof crm.listCompanies !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.crm — the CRM feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.crm' },
    );
  }
  return crm;
}

const str = (v) => (typeof v === 'string' ? v : '');

/** Merge chain-authored config with DAG-forwarded inputs (inputs win on
 *  conflict) — see the file header. */
function args(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}

/** ADR 0162 deterministic id: explicit id wins; else `<prefix>:<runId>:<nodeId>`.
 *  A PER-RUN dedupe key (a retried node converges) — not a cross-run fork guard,
 *  since a fork runs under its own runId. The node's `role:"side-effect"`
 *  classification is the fork guard (ADR 0627 D1). */
function idFor(ctx, prefix, provided) {
  const p = str(provided);
  return p || `${prefix}:${ctx.runId}:${ctx.nodeId}`;
}

const STAGE_SCORE = { lead: 10, qualified: 40, customer: 80, churned: 5 };

function score(contact, { enriched }) {
  const base = STAGE_SCORE[contact?.stage] ?? 0;
  // Enriched variant weights a known company higher (a deterministic bump).
  const companyBump = enriched && typeof contact?.company === 'string' && contact.company.length > 0 ? 15 : 0;
  const total = Math.min(100, base + companyBump);
  const priority = total >= 70 ? 'high' : total >= 30 ? 'normal' : 'low';
  return { score: total, priority };
}

export async function triage(ctx) {
  const contact = ctx.inputs?.contact ?? ctx.inputs ?? {};
  return { status: 'success', outputs: { triage: { variant: 'basic', ...score(contact, { enriched: false }) } } };
}

export async function triageEnriched(ctx) {
  const contact = ctx.inputs?.contact ?? ctx.inputs ?? {};
  return { status: 'success', outputs: { triage: { variant: 'enriched', ...score(contact, { enriched: true }) } } };
}

/* ─── Reads ──────────────────────────────────────────────────── */

export async function listCompanies(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.listCompanies({ orgId: str(i.orgId), ...(str(i.q) ? { q: str(i.q) } : {}) });
  return { status: 'success', outputs: { companies: out.companies ?? [] } };
}

export async function getCompany(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.getCompany({ orgId: str(i.orgId), companyId: str(i.companyId) });
  return { status: 'success', outputs: { company: out.company ?? null } };
}

/** ADR 0251 — suppression-cause analytics (counts by reason + source; no
 *  addresses). Chat-drivable: "why is my suppression list growing?". */
export async function suppressionSummary(ctx) {
  const crm = ensureCrm(ctx);
  if (typeof crm.suppressionSummary !== 'function') {
    throw Object.assign(new Error('host CRM surface does not expose suppressionSummary (ADR 0251)'), { code: 'host_capability_missing', capability: 'host.sample.crm' });
  }
  const out = await crm.suppressionSummary();
  return { status: 'success', outputs: { summary: out.summary ?? null } };
}

export async function listDeals(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.listDeals({
    orgId: str(i.orgId),
    ...(str(i.pipelineId) ? { pipelineId: str(i.pipelineId) } : {}),
    ...(str(i.stageId) ? { stageId: str(i.stageId) } : {}),
    ...(str(i.companyId) ? { companyId: str(i.companyId) } : {}),
    ...(str(i.q) ? { q: str(i.q) } : {}),
  });
  return { status: 'success', outputs: { deals: out.deals ?? [] } };
}

export async function getDeal(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.getDeal({ orgId: str(i.orgId), dealId: str(i.dealId) });
  return { status: 'success', outputs: { deal: out.deal ?? null } };
}

export async function listTasks(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.listTasks({
    orgId: str(i.orgId),
    ...(str(i.status) ? { status: str(i.status) } : {}),
    ...(str(i.dealId) ? { dealId: str(i.dealId) } : {}),
  });
  return { status: 'success', outputs: { tasks: out.tasks ?? [] } };
}

/** ADR 0211 §2 — a saved segment's LIVE membership (never materialized). */
export async function listSegmentMembers(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.listSegmentMembers({ segmentId: str(i.segmentId) });
  return { status: 'success', outputs: { members: out.members ?? [] } };
}

/* ─── Writes (ADR 0208 §2) ───────────────────────────────────── */

export async function createContact(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.createContact({
    contactId: idFor(ctx, 'crm', i.contactId),
    name: str(i.name),
    ...(str(i.email) ? { email: str(i.email) } : {}),
    ...(str(i.company) ? { company: str(i.company) } : {}),
    ...(str(i.stage) ? { stage: str(i.stage) } : {}),
    ...(str(i.owner) ? { owner: str(i.owner) } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function updateContactStage(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.updateContactStage({ contactId: str(i.contactId) || str(i.entityId), stage: str(i.stage) });
  return { status: 'success', outputs: out };
}

/** `contactId` falls back to `entityId` — the ids-only shape a `host.crm.
 *  contact.*` event payload carries (ADR 0208 §1) when this node is driven
 *  directly off a trigger edge (`{"from": "trigger.payload", "to": "..."}`),
 *  which forwards `{entityType, entityId, orgId?, changed?}` with no
 *  `contactId` key. */
export async function updateContactOwner(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.updateContactOwner({ contactId: str(i.contactId) || str(i.entityId), owner: str(i.owner) });
  return { status: 'success', outputs: out };
}

export async function convertContact(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.convertContact({
    contactId: str(i.contactId) || str(i.entityId),
    orgId: str(i.orgId),
    ...(str(i.companyName) ? { companyName: str(i.companyName) } : {}),
    ...(str(i.pipelineId) ? { pipelineId: str(i.pipelineId) } : {}),
    ...(str(i.dealTitle) ? { dealTitle: str(i.dealTitle) } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function createCompany(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.createCompany({
    orgId: str(i.orgId),
    companyId: idFor(ctx, 'cmp', i.companyId),
    name: str(i.name),
    ...(str(i.domain) ? { domain: str(i.domain) } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function createDeal(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.createDeal({
    orgId: str(i.orgId),
    dealId: idFor(ctx, 'deal', i.dealId),
    title: str(i.title),
    ...(typeof i.amount === 'number' ? { amount: i.amount } : {}),
    ...(str(i.companyId) ? { companyId: str(i.companyId) } : {}),
    ...(str(i.contactId) ? { contactId: str(i.contactId) } : {}),
    ...(str(i.pipelineId) ? { pipelineId: str(i.pipelineId) } : {}),
    ...(str(i.stageId) ? { stageId: str(i.stageId) } : {}),
    ...(str(i.closeDate) ? { closeDate: str(i.closeDate) } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function moveDealStage(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.moveDealStage({ orgId: str(i.orgId), dealId: str(i.dealId), stageId: str(i.stageId) });
  return { status: 'success', outputs: out };
}

export async function createTask(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.createTask({
    orgId: str(i.orgId),
    taskId: idFor(ctx, 'task', i.taskId),
    title: str(i.title),
    ...(str(i.dueDate) ? { dueDate: str(i.dueDate) } : {}),
    ...(str(i.dealId) ? { dealId: str(i.dealId) } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function completeTask(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.completeTask({ orgId: str(i.orgId), taskId: str(i.taskId) });
  return { status: 'success', outputs: out };
}

export async function logActivity(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.logActivity({
    orgId: str(i.orgId),
    activityId: idFor(ctx, 'act', i.activityId),
    kind: str(i.kind),
    body: str(i.body),
    ...(str(i.dealId) ? { dealId: str(i.dealId) } : {}),
    ...(str(i.contactId) ? { contactId: str(i.contactId) } : {}),
    ...(str(i.companyId) ? { companyId: str(i.companyId) } : {}),
  });
  return { status: 'success', outputs: out };
}

/* ─── Gmail inbox sync (ADR 0252 P2) ─────────────────────────── */

/** Parse a Gmail `From`/`To` header value ("Name <a@b.com>, c@d.com") into
 *  lowercase bare email addresses. Pure-JS — no mail-parser dependency. */
function parseAddresses(headerText) {
  if (typeof headerText !== 'string' || !headerText) return [];
  return headerText
    .split(',')
    .map((part) => {
      const m = /<([^<>]+)>/.exec(part);
      const addr = (m ? m[1] : part).trim();
      return addr.toLowerCase();
    })
    .filter((addr) => addr.length > 0);
}

/** One header's raw value by name (case-insensitive), or ''. */
function headerValue(headers, name) {
  const found = Array.isArray(headers)
    ? headers.find((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === name.toLowerCase())
    : undefined;
  return found && typeof found.value === 'string' ? found.value : '';
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Gmail messages.list returns newest-first, 50/page. We follow nextPageToken so
// a busy mailbox (>50 messages since the last cursor — realistic at daily
// cadence) doesn't have its older messages skipped past the cursor and lost.
// Bounded per run so one pass can't fan out unboundedly; if the cap is hit we
// still advance to the newest processed and report `truncated` (the remaining
// backlog is documented in ADR 0252's open questions — History-API sync).
const GMAIL_MAX_PAGES = 10; // ≤ 500 messages/run.
/** How many passes an unsettled message may HOLD the cursor before it is
 *  released (and the loss logged) — the bound on horn (1) above. */
const GMAIL_UNSETTLED_BUDGET = 5;
/** Bound on the per-sync unsettled map; beyond it a new unsettled message is
 *  released immediately (logged), so the row cannot grow without limit. */
const GMAIL_UNSETTLED_MAX = 200;

/**
 * ADR 0252 §5 — scheduler-fired (or "sync now"): pulls the connected user's
 * recent Gmail messages, matches From/To participants to EXISTING CRM
 * contacts only (never creates one), and appends metadata-only email
 * activities (no subject/body/snippet/email — ADR 0252 §1) for each match.
 * Pages messages.list (nextPageToken) up to GMAIL_MAX_PAGES/run and advances
 * the cursor only past fully-processed messages — a backlog beyond the per-run
 * cap reports `truncated:true` and the next fire continues (ADR 0252's open
 * question: a time cursor now, the Gmail History API is a deferred follow-on).
 *
 * `gmailSyncId` arrives via `ctx.config`, FROZEN in at chain expansion (RFC
 * 0013 Path A — `gmailSyncService.ts`'s `ensureGmailSyncWorkflow` expands the
 * chain with `params.gmailSyncId`; expandChain substitutes the config token
 * with the literal value, so the persisted node config carries no run-time
 * token — see that file's header).
 *
 * ADR 0627 D5 — three honesty rules on top:
 *   - every `ctx.connectors.invoke('google', …)` PINS the sync row's
 *     owner-verified `connectionId`; the broker honours the pin EXACTLY (no
 *     user→org→workspace fall-through), so a `needs-reconsent` mailbox can never
 *     silently become the workspace's. A refused pin
 *     (`connector_pinned_connection_unusable`) marks the sync `needs-reconsent`.
 *   - the cursor advances only past messages whose every append returned
 *     `logged | duplicate` (the typed `logGmailActivity` outcome). Gmail lists
 *     NEWEST-FIRST, so a single high-water mark would carry every OLDER
 *     `failed`/`capped`/unreached message past the cursor forever; instead the
 *     pass tracks the OLDEST unsettled message and lands the cursor one second
 *     BEFORE `min(newest settled, oldest unsettled)` (`after:` is seconds-
 *     granular; `duplicate` makes the re-scan cheap).
 *   - a TRUNCATED pass (> GMAIL_MAX_PAGES × 50 messages after the cursor) does
 *     NOT advance: it persists a scan WINDOW on the row (`scan.before` = the
 *     oldest date it reached, `scan.newest` = the newest settled date so far)
 *     and later passes query `after:cursor before:scan.before` until a pass is
 *     not truncated, then clear the window and advance past `scan.newest`. A
 *     plain hold would livelock on the same newest 500 every tick.
 *   - THE REAL HORNS, stated: (1) an unsettled message HOLDS the cursor for at
 *     most GMAIL_UNSETTLED_BUDGET passes (tracked per messageId on the row,
 *     ≤ GMAIL_UNSETTLED_MAX ids); after that it is RELEASED — the loss is
 *     logged at warn with the id by the surface (`recordGmailSyncScan`) and is
 *     never silent; (2) a message Gmail stops listing inside an unbounded,
 *     un-truncated pass is treated as gone (its hold is dropped, logged);
 *     (3) each held pass costs one bounded re-scan (≤ 500 metadata GETs) —
 *     everything already logged is a cheap `duplicate`.
 *   - `capped` pauses the sync (`status:'paused', pausedReason:'capped'`) — the
 *     scheduler has no failure count or backoff, so a bare failure would re-fail
 *     every tick forever. A sync that is already paused / needs-reconsent is a
 *     typed refusal, never a run.
 */
export async function gmailSync(ctx) {
  if (!ctx.connectors) {
    return { status: 'failure', error: { code: 'host_capability_missing', message: 'ctx.connectors is not available on this host.' } };
  }
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const gmailSyncId = str(i.gmailSyncId);
  if (!gmailSyncId) {
    return { status: 'failure', error: { code: 'validation_error', message: 'gmailSyncId is required.' } };
  }

  const resolved = await crm.getGmailSyncForRun({ syncId: gmailSyncId });
  const sync = resolved && resolved.sync;
  if (!sync) {
    return { status: 'failure', error: { code: 'not_found', message: `Gmail sync ${gmailSyncId} not found.` } };
  }
  if (sync.status === 'paused') {
    return { status: 'failure', error: { code: 'validation_error', message: `Gmail sync ${gmailSyncId} is paused${sync.pausedReason ? ` (${sync.pausedReason})` : ''} — resume it to run.` } };
  }
  if (sync.status === 'needs-reconsent') {
    return { status: 'failure', error: { code: 'credential_unavailable', message: `Gmail sync ${gmailSyncId} needs re-consent — reconnect Google, then resume it.` } };
  }
  const connectionId = str(sync.connectionId);
  if (!connectionId) {
    return { status: 'failure', error: { code: 'validation_error', message: `Gmail sync ${gmailSyncId} has no bound connection.` } };
  }
  /** A refused pin: the broker withheld THIS connection (dead / revoked /
   *  not the acting user's) and substituted nothing. Mark the sync so the
   *  scheduler stops firing it, then fail typed. */
  const needsReconsent = async () => {
    await crm.markGmailSyncRunStatus({ syncId: gmailSyncId, status: 'needs-reconsent' });
    return { status: 'failure', error: { code: 'credential_unavailable', message: `Gmail sync ${gmailSyncId}: the bound Google connection was refused — marked needs-reconsent.` } };
  };

  const afterMs = sync.cursor ? Date.parse(sync.cursor) : Date.now() - SEVEN_DAYS_MS;
  const startMs = Number.isFinite(afterMs) ? afterMs : Date.now() - SEVEN_DAYS_MS;
  const afterEpochSeconds = Math.floor(startMs / 1000);
  // An open truncation window (see the docblock): bound the listing to what
  // the previous truncated pass did NOT reach.
  const scan = sync.scan && typeof sync.scan === 'object' && typeof sync.scan.before === 'string' && Number.isFinite(Date.parse(sync.scan.before)) ? sync.scan : null;
  const beforeEpochSeconds = scan ? Math.floor(Date.parse(scan.before) / 1000) + 1 : null; // +1: `before:` is exclusive; the oldest reached re-lists as a cheap duplicate.
  const scanNewestMs = scan && typeof scan.newest === 'string' ? Date.parse(scan.newest) : NaN;
  // Per-message hold budget, carried on the row across passes.
  const unsettled = sync.unsettled && typeof sync.unsettled === 'object' ? { ...sync.unsettled } : {};
  const hadState = scan !== null || Object.keys(unsettled).length > 0;
  const released = [];
  const query = `after:${afterEpochSeconds}${beforeEpochSeconds !== null ? ` before:${beforeEpochSeconds}` : ''}`;

  // Page through messages.list following nextPageToken (newest-first) so a
  // backlog >50 isn't skipped past the cursor. Bounded by GMAIL_MAX_PAGES.
  const stubs = [];
  let pageToken = '';
  let truncated = false;
  for (let page = 0; page < GMAIL_MAX_PAGES; page += 1) {
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const listRes = await ctx.connectors.invoke('google', { url: listUrl, method: 'GET', connectionId });
    if (listRes && listRes.error === 'connector_pinned_connection_unusable') return needsReconsent();
    if (!listRes || !listRes.ok) {
      return { status: 'failure', error: { code: 'connector_error', message: `Gmail messages.list failed: ${(listRes && listRes.error) || (listRes && listRes.status) || 'unknown'}` } };
    }
    const pageMsgs = Array.isArray(listRes.data && listRes.data.messages) ? listRes.data.messages : [];
    for (const m of pageMsgs) { if (m && typeof m.id === 'string' && m.id) stubs.push(m.id); }
    pageToken = (listRes.data && typeof listRes.data.nextPageToken === 'string') ? listRes.data.nextPageToken : '';
    if (!pageToken) break;
    if (page === GMAIL_MAX_PAGES - 1) truncated = true; // more remain past the cap.
  }
  const listed = new Set(stubs);

  let scanned = 0;
  let matched = 0; // `logged` appends only — a re-synced duplicate is not a match.
  let newestMs = startMs;
  let oldestScannedMs = Infinity;
  let unreachedAfterCap = false;
  let capped = false;
  const noteUnsettled = (id, dateMs) => {
    const prev = unsettled[id];
    if (!prev && Object.keys(unsettled).length >= GMAIL_UNSETTLED_MAX) { released.push(id); return; } // map full: released, logged.
    unsettled[id] = { passes: (prev && Number.isFinite(prev.passes) ? prev.passes : 0) + 1, ...(Number.isFinite(dateMs) ? { at: new Date(dateMs).toISOString() } : (prev && prev.at ? { at: prev.at } : {})) };
  };

  for (let idx = 0; idx < stubs.length; idx += 1) {
    const id = stubs[idx];
    if (capped) { unreachedAfterCap = true; break; } // unreached, older, dates unknown.
    scanned += 1;
    let internalDateMs = NaN;
    try {
      const metaUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`;
      const metaRes = await ctx.connectors.invoke('google', { url: metaUrl, method: 'GET', connectionId });
      if (metaRes && metaRes.error === 'connector_pinned_connection_unusable') return needsReconsent();
      if (!metaRes || !metaRes.ok || !metaRes.data) { noteUnsettled(id, NaN); continue; }
      const msg = metaRes.data;
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : id;
      internalDateMs = Number(msg.internalDate);
      if (Number.isFinite(internalDateMs) && internalDateMs < oldestScannedMs) oldestScannedMs = internalDateMs;
      const at = Number.isFinite(internalDateMs) ? new Date(internalDateMs).toISOString() : new Date().toISOString();

      const headers = msg.payload && msg.payload.headers;
      const fromEmails = parseAddresses(headerValue(headers, 'From'));
      const toEmails = parseAddresses(headerValue(headers, 'To'));

      const seen = new Set();
      let fullyLogged = true;
      for (const addr of [...fromEmails, ...toEmails]) {
        if (seen.has(addr)) continue;
        seen.add(addr);
        const contactMatch = await crm.findContactByEmail({ email: addr });
        const contactId = contactMatch && contactMatch.contactId;
        if (!contactId) continue;
        // Direction is relative to the MATCHED CONTACT (not the connected
        // user's own address — avoids an extra Gmail profile fetch): the
        // contact's address in `From` ⇒ the user received it ('in'); in
        // `To` ⇒ the user sent it ('out').
        const direction = fromEmails.includes(addr) ? 'in' : 'out';
        const logged = await crm.logGmailActivity({ orgId: sync.orgId, contactId, messageId: id, threadId, direction, at });
        const outcome = logged && logged.outcome;
        if (outcome === 'capped') { capped = true; fullyLogged = false; break; }
        if (outcome !== 'logged' && outcome !== 'duplicate') { fullyLogged = false; continue; }
        if (outcome === 'logged') matched += 1;
      }
      if (fullyLogged) {
        delete unsettled[id];
        if (Number.isFinite(internalDateMs) && internalDateMs > newestMs) newestMs = internalDateMs;
      } else {
        noteUnsettled(id, internalDateMs);
      }
    } catch {
      // Per-message isolation (mirrors knowledge-sync's per-file isolation) —
      // one malformed/unreadable message never aborts the whole pass. It is
      // unsettled: it must not be carried past the cursor.
      noteUnsettled(id, internalDateMs);
      continue;
    }
  }

  // Budget: a message held for more than GMAIL_UNSETTLED_BUDGET passes is
  // released (loss made visible by the surface's warn). A message Gmail no
  // longer lists inside an UNBOUNDED, un-truncated pass is gone: drop its hold.
  for (const [id, entry] of Object.entries(unsettled)) {
    if (entry.passes > GMAIL_UNSETTLED_BUDGET || (!scan && !truncated && !listed.has(id))) { released.push(id); delete unsettled[id]; }
  }
  const holdCursor = unreachedAfterCap || Object.values(unsettled).some((e) => !e.at);
  let oldestUnsettledMs = Infinity;
  for (const e of Object.values(unsettled)) { const ms = Date.parse(e.at); if (Number.isFinite(ms) && ms < oldestUnsettledMs) oldestUnsettledMs = ms; }

  if (truncated) {
    // Hold the cursor; persist the window so the next pass continues BELOW
    // what this one reached instead of re-listing the same newest 500.
    const windowNewest = Math.max(Number.isFinite(scanNewestMs) ? scanNewestMs : startMs, newestMs);
    const before = Number.isFinite(oldestScannedMs) ? new Date(oldestScannedMs).toISOString() : (scan ? scan.before : null);
    await crm.recordGmailSyncScan({
      syncId: gmailSyncId,
      scan: before ? { before, newest: new Date(windowNewest).toISOString() } : null,
      unsettled,
      released,
    });
  } else {
    // Land the cursor one second BEFORE min(newest settled, oldest unsettled)
    // (`after:` is seconds-granular; uniform − 1000). Hold it entirely when an
    // unsettled message's date is unknown. A closed window advances past the
    // window's newest settled message, not just this pass's.
    const finalNewest = Math.max(Number.isFinite(scanNewestMs) ? scanNewestMs : startMs, newestMs);
    const targetMs = holdCursor ? startMs : Math.min(finalNewest, oldestUnsettledMs) - 1000;
    if (targetMs > startMs) {
      await crm.advanceGmailSyncCursor({ syncId: gmailSyncId, cursor: new Date(targetMs).toISOString() });
    }
    if (hadState || Object.keys(unsettled).length > 0 || released.length > 0) {
      await crm.recordGmailSyncScan({ syncId: gmailSyncId, scan: null, unsettled, released });
    }
  }

  if (capped) {
    // The org's activity cap is hit: nothing later can land, so pause the sync
    // (job disabled in the same write) rather than re-fail every tick. The
    // cursor above landed before the capped message (or was held when older
    // messages were never reached), so nothing is lost across the pause.
    await crm.markGmailSyncRunStatus({ syncId: gmailSyncId, status: 'paused', pausedReason: 'capped' });
    return { status: 'failure', error: { code: 'validation_error', message: `Gmail sync ${gmailSyncId}: the org reached its activity cap — sync paused (pausedReason: capped).` } };
  }

  return { status: 'success', outputs: { scanned, matched, truncated } };
}

export async function segmentVocabulary(ctx) {
  const crm = ensureCrm(ctx);
  const out = await crm.segmentVocabulary();
  return { status: 'success', outputs: out };
}

export async function validateSegment(ctx) {
  const crm = ensureCrm(ctx);
  const out = await crm.validateSegment({ filters: (ctx.inputs ?? {}).filters });
  return { status: 'success', outputs: out };
}

/** ADR 0265 CDP-C — persist a validated segment (the draft→validate→persist
 *  trio; surface re-validates + fail-closes on an invalid draft, never writing).
 *  Deterministic `seg:` id as a per-run dedupe key (createTask precedent). */
export async function persistSegment(ctx) {
  const crm = ensureCrm(ctx);
  const i = args(ctx);
  const out = await crm.persistSegment({
    name: str(i.name),
    filters: (ctx.inputs ?? {}).filters,
    segmentId: idFor(ctx, 'seg', i.segmentId),
  });
  return { status: 'success', outputs: out };
}

/* ─── Booking (ADR 0402 §a) ──────────────────────────────────── */

/** Create/publish a public booking link. Idempotent within a run via the
 *  deterministic `booking-link:<runId>:<nodeId>` id; the side-effect
 *  classification is what keeps a replay fork from double-creating. */
export async function createBookingLink(ctx) {
  const crm = ensureCrm(ctx);
  if (typeof crm.createBookingLink !== 'function') {
    throw Object.assign(new Error('host CRM surface does not expose createBookingLink (ADR 0402)'), { code: 'host_capability_missing', capability: 'host.sample.crm' });
  }
  const i = args(ctx);
  const out = await crm.createBookingLink({
    bookingLinkId: idFor(ctx, 'booking-link', i.bookingLinkId),
    orgId: str(i.orgId),
    title: str(i.title),
    timezone: str(i.timezone),
    weeklyHours: Array.isArray(i.weeklyHours) ? i.weeklyHours : [],
    durations: Array.isArray(i.durations) ? i.durations : [],
    ...(str(i.description) ? { description: str(i.description) } : {}),
    ...(str(i.status) ? { status: str(i.status) } : {}),
    ...(str(i.ownerUserId) ? { ownerUserId: str(i.ownerUserId) } : {}),
    ...(str(i.location) ? { location: str(i.location) } : {}),
    ...(str(i.videoLink) ? { videoLink: str(i.videoLink) } : {}),
    ...(typeof i.bufferBeforeMin === 'number' ? { bufferBeforeMin: i.bufferBeforeMin } : {}),
    ...(typeof i.bufferAfterMin === 'number' ? { bufferAfterMin: i.bufferAfterMin } : {}),
    ...(typeof i.minNoticeMin === 'number' ? { minNoticeMin: i.minNoticeMin } : {}),
    ...(typeof i.maxAdvanceDays === 'number' ? { maxAdvanceDays: i.maxAdvanceDays } : {}),
    ...(str(i.slug) ? { slug: str(i.slug) } : {}),
  });
  return { status: 'success', outputs: out };
}

/** List an org's bookings (optionally filtered by link + status). */
export async function listBookings(ctx) {
  const crm = ensureCrm(ctx);
  if (typeof crm.listBookings !== 'function') {
    throw Object.assign(new Error('host CRM surface does not expose listBookings (ADR 0402)'), { code: 'host_capability_missing', capability: 'host.sample.crm' });
  }
  const i = args(ctx);
  const out = await crm.listBookings({
    orgId: str(i.orgId),
    ...(str(i.bookingLinkId) ? { bookingLinkId: str(i.bookingLinkId) } : {}),
    ...(str(i.status) ? { status: str(i.status) } : {}),
  });
  return { status: 'success', outputs: { bookings: out.bookings ?? [] } };
}

/* ─── E-signature (ADR 0402 §b) ──────────────────────────────── */

/** Request signatures on a commerce quote / document. Idempotent within a run
 *  via the deterministic `sign-request:<runId>:<nodeId>` id; a replay fork is
 *  SERVED the recorded outcome (side-effect classification) — that, not the id,
 *  is what stops a re-mint of signer tokens + a second signer email. */
export async function requestSignature(ctx) {
  const crm = ensureCrm(ctx);
  if (typeof crm.requestSignature !== 'function') {
    throw Object.assign(new Error('host CRM surface does not expose requestSignature (ADR 0402)'), { code: 'host_capability_missing', capability: 'host.sample.crm' });
  }
  const i = args(ctx);
  const out = await crm.requestSignature({
    signRequestId: idFor(ctx, 'sign-request', i.signRequestId),
    orgId: str(i.orgId),
    target: i.target ?? {},
    signers: Array.isArray(i.signers) ? i.signers : [],
  });
  return { status: 'success', outputs: out };
}

/** Read a sign request's status (signers + audit + certificate URL). */
export async function signatureStatus(ctx) {
  const crm = ensureCrm(ctx);
  if (typeof crm.getSignatureStatus !== 'function') {
    throw Object.assign(new Error('host CRM surface does not expose getSignatureStatus (ADR 0402)'), { code: 'host_capability_missing', capability: 'host.sample.crm' });
  }
  const i = args(ctx);
  const out = await crm.getSignatureStatus({ orgId: str(i.orgId), signRequestId: str(i.signRequestId) });
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.crm.nodes.segment-vocabulary': segmentVocabulary,
  'feature.crm.nodes.validate-segment': validateSegment,
  'feature.crm.nodes.persist-segment': persistSegment,
  'feature.crm.nodes.triage': triage,
  'feature.crm.nodes.triage-enriched': triageEnriched,
  'feature.crm.nodes.list-companies': listCompanies,
  'feature.crm.nodes.get-company': getCompany,
  'feature.crm.nodes.suppression-summary': suppressionSummary,
  'feature.crm.nodes.list-deals': listDeals,
  'feature.crm.nodes.get-deal': getDeal,
  'feature.crm.nodes.list-tasks': listTasks,
  'feature.crm.nodes.list-segment-members': listSegmentMembers,
  'feature.crm.nodes.create-contact': createContact,
  'feature.crm.nodes.update-contact-stage': updateContactStage,
  'feature.crm.nodes.update-contact-owner': updateContactOwner,
  'feature.crm.nodes.convert-contact': convertContact,
  'feature.crm.nodes.create-company': createCompany,
  'feature.crm.nodes.create-deal': createDeal,
  'feature.crm.nodes.move-deal-stage': moveDealStage,
  'feature.crm.nodes.create-task': createTask,
  'feature.crm.nodes.complete-task': completeTask,
  'feature.crm.nodes.log-activity': logActivity,
  'feature.crm.nodes.gmail-sync': gmailSync,
  'feature.crm.nodes.booking-create-link': createBookingLink,
  'feature.crm.nodes.booking-list': listBookings,
  'feature.crm.nodes.sign-request': requestSignature,
  'feature.crm.nodes.sign-status': signatureStatus,
};

export default nodes;
