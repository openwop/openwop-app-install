/**
 * Standing agent roster + org-chart client (RFCS/0086 + 0087 reference impl).
 *
 *   GET/POST/DELETE /host/openwop-app/roster[/{rosterId}]   — named agents + portfolios
 *   GET/PUT/DELETE  /host/openwop-app/org-chart              — departments/roles/reportsTo
 *   GET            /host/openwop-app/org-chart/{departmentId} — responsibility roll-up
 *
 * Tenant scoping is the backend's job (ownership from the caller's principal);
 * the client never sends a tenantId.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { ApiError, apiErrorFrom } from '../client/errorEnvelope.js';
import { cachedRead } from '../client/requestCache.js';
import { client } from '../client/runsClient.js';

export interface RosterAgentRef {
  agentId: string;
  version?: string;
  channel?: string;
}

export interface RosterEntry {
  rosterId: string;
  /** ADR 0775 P4 — content version; echo it as `ifMatch` on an edit built from
   *  this copy. Ignores the heartbeat stamp. */
  etag?: string;
  persona: string;
  agentRef: RosterAgentRef;
  workflows: string[];
  tenantId: string;
  enabled: boolean;
  label?: string;
  description?: string;
  /** Profile picture as a `data:image/*;base64,…` URI, or absent for the
   *  initials fallback. Host-extension only (not on the normative inventory). */
  avatarUrl?: string;
  /** ISO-8601 timestamp of the last "Check now" heartbeat that ran; absent ⇒
   *  never checked. Surfaced as "last checked …". */
  lastHeartbeatAt?: string;
  /** Opt-in autonomous heartbeat cadence (ms). When > 0, the background daemon
   *  auto-runs this agent's "Check now" on this interval. Absent ⇒ manual only. */
  heartbeatIntervalMs?: number;
  /** Heartbeat autonomy: `auto` (default) starts picked runs immediately;
   *  `review` queues a proposal for human sign-off (the approval inbox).
   *  Absent ⇒ `auto`. */
  autonomyLevel?: 'auto' | 'guided' | 'review';
  /** Seed role template (e.g. 'chief-of-staff') — exact theme + role identity. */
  roleKey?: string;
  /** ADR 0313 D3 — read-time heartbeat decoration from the backend (never
   *  stored): the resolved autonomous cadence (0 = checks off) and whether
   *  bare todo cards have a registered agent-turn fallback. */
  heartbeat?: { effectiveIntervalMs: number; agentTurnFallback: boolean };
  createdAt: string;
  updatedAt: string;
}

/** The spec's four-level autonomy model (provenance/display). The enforced
 *  roster `level` is derived from it server-side (ADR 0031 mapping table). */
export type AgentSpecLevel = 'draft-only' | 'recommend' | 'execute-with-approval' | 'autonomous-within-policy';
/** The enforced three-level roster autonomy. */
export type AgentRosterLevel = 'auto' | 'guided' | 'review';

/**
 * Rich `agentProfile` host-extension (ADR 0031) — the full "enterprise digital
 * work twin" property set attached to a standing agent. NON-NORMATIVE: this is
 * host-local product config under `/host/openwop-app/agents/:id/profile`, NOT a
 * field on the RFC 0003 manifest. `:id` is the owning `rosterId`.
 */
export interface AgentProfile {
  profileId: string;
  /** ADR 0775 P4 — content version; echo it as `ifMatch` on the next save. */
  etag?: string;
  tenantId: string;
  roleKey: string;
  /** AST-UX-2 — the CORE capabilities activated on this agent (ADR 0031 /
   *  ADR 0023 §Correction, e.g. `['assistant']`). The backend resolves the
   *  assistant runtime by THIS, never by `roleKey`
   *  (`features/assistant/capability.ts`), and the field was already persisted
   *  and returned by `GET …/agents/:id/profile` — it simply was not declared
   *  here, which is why the SPA's only assistant control surface was still
   *  gated on the roleKey the backend calls an architecture violation. Typed
   *  as a widenable string list rather than a closed union: the host owns the
   *  capability vocabulary, and a capability the SPA has never heard of must
   *  not make this read fail. */
  capabilities?: string[];
  department?: { departmentId: string; name: string; roleId?: string; roleName?: string };
  /** Free-form per-twin config (thresholds, calendars, approval matrices). */
  configParameters?: Record<string, unknown>;
  /** Advisory access controls (day-1: metadata only). */
  permissions?: { read: string[]; write: string[]; never: string[] };
  /** Action types that always require human approval. */
  hitl?: string[];
  escalation?: { contacts: string[]; triggers: string[] };
  channels?: { approval?: string; delivery?: string };
  adminControls?: string[];
  riskCompliance?: string[];
  /** Connections provider ids that gate activation (ADR 0033). */
  requiredConnections?: string[];
  /** Success/analytics metric keys. */
  metrics?: string[];
  autonomy: {
    /** Enforced roster level — derived from `specLevel` when not set explicitly. */
    level: AgentRosterLevel;
    specLevel: AgentSpecLevel;
    /** Allowlisted actions when `level === 'auto'`. */
    withinPolicyActions?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

/** PUT body for an agent profile. `autonomy.level` is omitted — the backend
 *  derives the enforced level from `specLevel`, so the UI only sends specLevel. */
export interface AgentProfileInput {
  roleKey: string;
  department?: AgentProfile['department'];
  /** `null` clears (the PUT merges, ADR 0775 P4). */
  configParameters?: Record<string, unknown> | null;
  /** `null` clears (the PUT merges, ADR 0775 P4). */
  permissions?: { read: string[]; write: string[]; never: string[] } | null;
  hitl?: string[];
  /** `null` clears (the PUT merges, ADR 0775 P4). */
  escalation?: { contacts: string[]; triggers: string[] } | null;
  channels?: { approval?: string; delivery?: string };
  adminControls?: string[];
  riskCompliance?: string[];
  requiredConnections?: string[];
  metrics?: string[];
  autonomy: { specLevel: AgentSpecLevel; withinPolicyActions?: string[] };
}

const profileUrl = (rosterId: string): string =>
  `${rosterBase}/${encodeURIComponent(rosterId)}/profile`;

/** Read the rich agent profile. Returns `null` on 404 (no profile yet OR a
 *  foreign/unknown agent — the route fails closed), so call sites render the
 *  "no profile" empty state instead of an error. */
export async function getAgentProfile(rosterId: string): Promise<AgentProfile | null> {
  const res = await fetch(profileUrl(rosterId), fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getAgentProfile returned ${res.status}`);
  return (await res.json()) as AgentProfile;
}

/** Save the agent profile. ADR 0775 P4: the PUT MERGES — an omitted field keeps
 *  its stored value; send `null` (or `[]` for a list) to clear one. Pass the
 *  profile's `etag` as `ifMatch` so an edit made elsewhere since it was loaded is
 *  refused rather than overwritten. Returns the persisted profile. */
export async function putAgentProfile(rosterId: string, input: AgentProfileInput, opts: { ifMatch?: string | undefined } = {}): Promise<AgentProfile> {
  const headers = jsonHeadersIfMatch(opts.ifMatch);
  const res = await fetch(profileUrl(rosterId), fetchOpts({ method: 'PUT', headers, body: JSON.stringify(input) }));
  // ADR 0775 D1 — a typed `ApiError` (status + the server's message) so a
  // refusal is classified by STATUS, never by sniffing the message text.
  if (!res.ok) throw await apiErrorFrom(res, `putAgentProfile failed (${res.status})`);
  return (await res.json()) as AgentProfile;
}

export interface OrgRole { roleId: string; name: string }
export interface OrgDepartment { departmentId: string; name: string; parentDepartmentId: string | null; roles: OrgRole[] }
export interface OrgMember { rosterId: string; departmentId: string; roleId: string; reportsTo: string | null }
/** The chart the page renders. `tenantId` is the wire's `owner.tenantId`;
 *  `updatedAt` is only on the host-extension write's response (the normative
 *  read does not carry it). */
export interface OrgChart { tenantId: string; departments: OrgDepartment[]; members: OrgMember[]; updatedAt?: string | null }
export interface ResponsibilityView { department: OrgDepartment; members: OrgMember[]; responsibilities: string[] }

const rosterBase = `${config.baseUrl}/host/openwop-app/roster`;
const orgBase = `${config.baseUrl}/host/openwop-app/org-chart`;
const jsonHeaders = (): HeadersInit => authedHeaders({ 'content-type': 'application/json' });
/** JSON headers plus `If-Match` when a version is given (ADR 0775 P4). */
const jsonHeadersIfMatch = (ifMatch: string | undefined): HeadersInit =>
  authedHeaders({ 'content-type': 'application/json', ...(ifMatch !== undefined ? { 'If-Match': `"${ifMatch}"` } : {}) });

/** The named agents. Advisor-subject agents (ADR 0040) are excluded by default —
 *  they live only in the Board of Advisors feature; pass `includeAdvisors` to get
 *  them (the advisory picker + the chat `@@`-convene do). */
export async function listRoster(opts?: { includeAdvisors?: boolean }): Promise<RosterEntry[]> {
  // Read on mount by the welcome card + roster pickers. Coalesce concurrent reads
  // (TTL 0 = in-flight-only), keyed by the includeAdvisors variant so the two
  // shapes don't share a slot; roster edits reflect on the next read.
  return cachedRead(`roster.list:${opts?.includeAdvisors ? 'all' : 'named'}`, 0, async () => {
    const res = await fetch(`${rosterBase}${opts?.includeAdvisors ? '?includeAdvisors=true' : ''}`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) throw new Error(`listRoster returned ${res.status}`);
    return ((await res.json()) as { roster: RosterEntry[] }).roster;
  });
}

export async function getRosterEntry(rosterId: string): Promise<RosterEntry> {
  const res = await fetch(`${rosterBase}/${encodeURIComponent(rosterId)}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`getRosterEntry returned ${res.status}`);
  return (await res.json()) as RosterEntry;
}

export async function createRosterEntry(input: {
  persona: string;
  agentRef: RosterAgentRef;
  workflows?: string[];
  label?: string;
  description?: string;
  enabled?: boolean;
  heartbeatIntervalMs?: number;
  /** Host-ext heartbeat autonomy: `review` = "agents propose, humans dispose". */
  autonomyLevel?: 'auto' | 'guided' | 'review';
}): Promise<RosterEntry> {
  const res = await fetch(rosterBase, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (!res.ok) throw new Error(`createRosterEntry returned ${res.status}`);
  return (await res.json()) as RosterEntry;
}

/** ADR 0775 P4 — pass `ifMatch` (the entry's `etag` as read) when the patch was
 *  built from a copy of the entry, e.g. a whole workflow list. If the agent
 *  changed since, the server refuses (`isStaleWrite`) instead of overwriting. */
export async function updateRosterEntry(
  rosterId: string,
  patch: { persona?: string; workflows?: string[]; enabled?: boolean; label?: string; description?: string; avatarUrl?: string | null; heartbeatIntervalMs?: number; autonomyLevel?: 'auto' | 'guided' | 'review' },
  opts: { ifMatch?: string | undefined } = {},
): Promise<RosterEntry> {
  const headers = jsonHeadersIfMatch(opts.ifMatch);
  const res = await fetch(`${rosterBase}/${encodeURIComponent(rosterId)}`, fetchOpts({ method: 'PATCH', headers, body: JSON.stringify(patch) }));
  if (!res.ok) throw await apiErrorFrom(res, `updateRosterEntry returned ${res.status}`);
  return (await res.json()) as RosterEntry;
}

/** Append a workflow to an agent's portfolio without dropping one added since
 *  `entry` was read (ADR 0775 P4): the write carries the entry's version, and a
 *  stale-version refusal re-reads the agent and appends to its current list.
 *  Returns the saved entry, or the fresh one when the workflow was already there. */
export async function appendRosterWorkflow(entry: RosterEntry, workflowId: string): Promise<RosterEntry> {
  try {
    return await updateRosterEntry(entry.rosterId, { workflows: [...entry.workflows, workflowId] }, { ifMatch: entry.etag });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409 && err.reason === 'stale_write')) throw err;
    const fresh = await getRosterEntry(entry.rosterId);
    if (fresh.workflows.includes(workflowId)) return fresh;
    return updateRosterEntry(fresh.rosterId, { workflows: [...fresh.workflows, workflowId] }, { ifMatch: fresh.etag });
  }
}

export async function deleteRosterEntry(rosterId: string): Promise<void> {
  const res = await fetch(`${rosterBase}/${encodeURIComponent(rosterId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteRosterEntry returned ${res.status}`);
}

export interface SeedExampleAgentsResult {
  seeded: boolean;
  agents: number;
  domains?: string[];
  healed?: { boards: number; schedules: number; orgChart: boolean };
}

/** "Load demo data" — idempotently seed the built-in demo domains for the
 *  caller's tenant. A no-op when the tenant already has those demo rows.
 *
 *  Streamed (#4239): the full reseed runs 90–170 s in prod and the `/api`
 *  rewrite cuts at 60 s, so this goes to the direct backend URL (the
 *  `sseBaseUrl` bypass `/run` already uses) and asks for NDJSON — keepalive
 *  lines, then one `result` (or `error`) line. */
export async function seedExampleAgents(opts: { heal?: boolean } = {}): Promise<SeedExampleAgentsResult> {
  const res = await fetch(`${config.sseBaseUrl}/host/openwop-app/example-data/seed`, fetchOpts({
    method: 'POST',
    headers: { ...jsonHeaders(), accept: 'application/x-ndjson' },
    // heal:true = explicit restore (the "Load demo data" buttons); the silent
    // auto-seed on page entry sends {} so it never resurrects deletions.
    body: JSON.stringify(opts.heal ? { heal: true } : {}),
  }));
  if (!res.ok) throw await apiErrorFrom(res, `seedExampleAgents returned ${res.status}`);
  return readSeedStream(res);
}

/** The terminal line of a streamed seed. A non-NDJSON 200 (a host without the
 *  stream mode) is read as the plain JSON body. Never resolves without a
 *  `result`: an `error` line or a stream that ends early is a thrown error. */
export async function readSeedStream(res: Response): Promise<SeedExampleAgentsResult> {
  if (!(res.headers.get('content-type') ?? '').includes('application/x-ndjson') || !res.body) {
    return (await res.json()) as SeedExampleAgentsResult;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outcome: { result: SeedExampleAgentsResult } | { error: string } | null = null;
  const take = (line: string): void => {
    if (!line.trim()) return;
    let evt: { type?: string; result?: SeedExampleAgentsResult; message?: string };
    try { evt = JSON.parse(line) as typeof evt; } catch { return; }
    if (evt.type === 'result' && evt.result) outcome = { result: evt.result };
    else if (evt.type === 'error') outcome = { error: evt.message ?? 'The demo seed failed.' };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) { take(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); nl = buffer.indexOf('\n'); }
  }
  take(buffer);
  const done = outcome as { result: SeedExampleAgentsResult } | { error: string } | null;
  if (!done) throw new Error('The demo seed stream ended without a result.');
  if ('error' in done) throw new Error(done.error);
  return done.result;
}

export interface HeartbeatResult {
  picked: boolean;
  reason?: string;
  boardId?: string;
  cardId?: string;
  cardTitle?: string;
  runId?: string;
  persona?: string;
  /** When the heartbeat ran (absent if the agent was paused). */
  lastHeartbeatAt?: string;
}

/** Agent heartbeat "Check now" — claim the first eligible To Do card on the
 *  agent's board and start its workflow. */
export async function checkAgent(rosterId: string): Promise<HeartbeatResult> {
  const res = await fetch(`${rosterBase}/${encodeURIComponent(rosterId)}/check`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  if (!res.ok) throw new Error(`checkAgent returned ${res.status}`);
  return (await res.json()) as HeartbeatResult;
}

/** Per-provider readiness for one `requiredConnections` entry (ADR 0033 §3.3). */
export interface ConnectionReadinessEntry {
  provider: string;
  configured: boolean;
  /** Present when a (possibly non-active) connection exists — lets the UI tell
   *  "missing" apart from "needs-reconsent"/"expired". */
  status?: 'active' | 'needs-reconsent' | 'expired' | 'revoked';
}

/** The agent's resolved connection readiness + the gated autonomy it produces. */
export interface ConnectionReadiness {
  agentId: string;
  required: string[];
  entries: ConnectionReadinessEntry[];
  allConfigured: boolean;
  missing: string[];
  declaredAutonomy: 'auto' | 'guided' | 'review';
  /** The autonomy AFTER the connection gate — forced to `review` when any
   *  required connection is unconfigured (the heartbeat applies the same gate). */
  gatedAutonomy: 'auto' | 'guided' | 'review';
  effective: { acting: boolean };
}

/** Read an agent's `requiredConnections` activation readiness (ADR 0033 §3.3).
 *  Honest "can this twin act?" view — which connections are configured vs
 *  missing, and the effective autonomy after the fail-closed gate. */
export async function getConnectionReadiness(rosterId: string): Promise<ConnectionReadiness> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/agents/${encodeURIComponent(rosterId)}/connection-readiness`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`getConnectionReadiness returned ${res.status}`);
  return (await res.json()) as ConnectionReadiness;
}

/** One activity item — a run attributed to the agent, with its outcome + time. */
export interface AgentActivityItem {
  runId: string;
  workflowId: string;
  /** RunStatus: pending | running | completed | failed | … */
  status: string;
  /** How the run was triggered. */
  source: 'heartbeat' | 'schedule' | 'kanban' | 'approval';
  /** The board card that triggered it (heartbeat / kanban / approval), when known. */
  cardId?: string;
  /** Attribution — present on the fleet feed so items can name their agent. */
  rosterId?: string;
  agentId?: string;
  persona?: string;
  /** ISO-8601 — terminal time, else last-update / creation. */
  timestamp: string;
  /** ISO-8601 run creation time. */
  createdAt?: string;
  /** ISO-8601 terminal time; absent while still running. */
  completedAt?: string;
  /** Wall-clock run duration in ms (when both bookends are known). */
  durationMs?: number;
  /** RFC 0040 — the trigger event that caused this run, when recorded. */
  causationId?: string;
}

/** Per-agent activity: recent runs (heartbeat / schedule / card triggers) with
 *  timestamps + outcomes, newest first. `truncated` ⇒ the scan window was hit
 *  and older runs may exist beyond what's shown. */
export async function getAgentActivity(rosterId: string): Promise<{ items: AgentActivityItem[]; truncated: boolean }> {
  const res = await fetch(`${rosterBase}/${encodeURIComponent(rosterId)}/activity`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`getAgentActivity returned ${res.status}`);
  const body = (await res.json()) as { items: AgentActivityItem[]; truncated?: boolean };
  return { items: body.items, truncated: body.truncated ?? false };
}

/** Fleet-wide activity: recent agent-attributed runs across the whole roster,
 *  newest first. `status` narrows to one run status (e.g. 'failed' for the
 *  failures view); `rosterId` narrows to one member. `truncated` ⇒ the scan
 *  window was hit. */
export async function getFleetActivity(
  opts: { status?: string; rosterId?: string; limit?: number } = {},
): Promise<{ items: AgentActivityItem[]; truncated: boolean }> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set('status', opts.status);
  if (opts.rosterId) qs.set('rosterId', opts.rosterId);
  if (opts.limit) qs.set('limit', String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${config.baseUrl}/host/openwop-app/fleet/activity${suffix}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`getFleetActivity returned ${res.status}`);
  const body = (await res.json()) as { items: AgentActivityItem[]; truncated?: boolean };
  return { items: body.items, truncated: body.truncated ?? false };
}

/** RFC 0087 §D — the NORMATIVE read at major 2 (`GET /agents/org-chart`),
 *  through the SDK. It used to read the host-extension alias. The SDK answers
 *  `null` for a 404 (the read is unadvertised); that stays an error here, as
 *  the alias's non-ok did, so the page's failed-read state still renders. */
export async function getOrgChart(): Promise<OrgChart> {
  const chart = await client.agents.getOrgChart();
  if (!chart) throw new Error('getOrgChart returned 404');
  return { tenantId: chart.owner.tenantId, departments: chart.departments as OrgDepartment[], members: chart.members as OrgMember[] };
}

export async function putOrgChart(input: { departments: OrgDepartment[]; members: OrgMember[] }): Promise<OrgChart> {
  const res = await fetch(orgBase, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  // ADR 0775 D1 — a typed `ApiError` (status + the server's message) so a
  // refusal is classified by STATUS, never by sniffing the message text.
  if (!res.ok) throw await apiErrorFrom(res, `putOrgChart failed (${res.status})`);
  return (await res.json()) as OrgChart;
}

export async function getDepartmentRollup(departmentId: string): Promise<ResponsibilityView> {
  const view = await client.agents.getOrgChartDepartment(departmentId);
  if (!view) throw new Error('getDepartmentRollup returned 404');
  return view as ResponsibilityView;
}
