/**
 * Standing agent roster + org-chart client (RFCS/0086 + 0087 reference impl).
 *
 *   GET/POST/DELETE /v1/host/openwop-app/roster[/{rosterId}]   — named agents + portfolios
 *   GET/PUT/DELETE  /v1/host/openwop-app/org-chart              — departments/roles/reportsTo
 *   GET            /v1/host/openwop-app/org-chart/{departmentId} — responsibility roll-up
 *
 * Tenant scoping is the backend's job (ownership from the caller's principal);
 * the client never sends a tenantId.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { cachedRead } from '../client/requestCache.js';

export interface RosterAgentRef {
  agentId: string;
  version?: string;
  channel?: string;
}

export interface RosterEntry {
  rosterId: string;
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
 * host-local product config under `/v1/host/openwop-app/agents/:id/profile`, NOT a
 * field on the RFC 0003 manifest. `:id` is the owning `rosterId`.
 */
export interface AgentProfile {
  profileId: string;
  tenantId: string;
  roleKey: string;
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
  configParameters?: Record<string, unknown>;
  permissions?: { read: string[]; write: string[]; never: string[] };
  hitl?: string[];
  escalation?: { contacts: string[]; triggers: string[] };
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

/** Create-or-replace the agent profile (PUT is a full replace). Returns the
 *  persisted profile, including the derived enforced `autonomy.level`. */
export async function putAgentProfile(rosterId: string, input: AgentProfileInput): Promise<AgentProfile> {
  const res = await fetch(profileUrl(rosterId), fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch { /* ignore */ }
    throw new Error(`putAgentProfile failed: ${detail}`);
  }
  return (await res.json()) as AgentProfile;
}

export interface OrgRole { roleId: string; name: string }
export interface OrgDepartment { departmentId: string; name: string; parentDepartmentId: string | null; roles: OrgRole[] }
export interface OrgMember { rosterId: string; departmentId: string; roleId: string; reportsTo: string | null }
export interface OrgChart { tenantId: string; departments: OrgDepartment[]; members: OrgMember[]; updatedAt: string | null }
export interface ResponsibilityView { department: OrgDepartment; members: OrgMember[]; responsibilities: string[] }

const rosterBase = `${config.baseUrl}/v1/host/openwop-app/roster`;
const orgBase = `${config.baseUrl}/v1/host/openwop-app/org-chart`;
const jsonHeaders = (): HeadersInit => authedHeaders({ 'content-type': 'application/json' });

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

export async function updateRosterEntry(
  rosterId: string,
  patch: { persona?: string; workflows?: string[]; enabled?: boolean; label?: string; description?: string; avatarUrl?: string | null; heartbeatIntervalMs?: number; autonomyLevel?: 'auto' | 'guided' | 'review' },
): Promise<RosterEntry> {
  const res = await fetch(`${rosterBase}/${encodeURIComponent(rosterId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  if (!res.ok) throw new Error(`updateRosterEntry returned ${res.status}`);
  return (await res.json()) as RosterEntry;
}

export async function deleteRosterEntry(rosterId: string): Promise<void> {
  const res = await fetch(`${rosterBase}/${encodeURIComponent(rosterId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteRosterEntry returned ${res.status}`);
}

/** "Load demo data" — idempotently seed the built-in demo domains for the
 *  caller's tenant. A no-op when the tenant already has those demo rows. */
export async function seedExampleAgents(opts: { heal?: boolean } = {}): Promise<{
  seeded: boolean;
  agents: number;
  domains?: string[];
  healed?: { boards: number; schedules: number; orgChart: boolean };
}> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/example-data/seed`, fetchOpts({
    method: 'POST',
    headers: jsonHeaders(),
    // heal:true = explicit restore (the "Load demo data" buttons); the silent
    // auto-seed on page entry sends {} so it never resurrects deletions.
    body: JSON.stringify(opts.heal ? { heal: true } : {}),
  }));
  if (!res.ok) throw new Error(`seedExampleAgents returned ${res.status}`);
  return (await res.json()) as {
    seeded: boolean; agents: number; domains?: string[];
    healed?: { boards: number; schedules: number; orgChart: boolean };
  };
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
    `${config.baseUrl}/v1/host/openwop-app/agents/${encodeURIComponent(rosterId)}/connection-readiness`,
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
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/fleet/activity${suffix}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`getFleetActivity returned ${res.status}`);
  const body = (await res.json()) as { items: AgentActivityItem[]; truncated?: boolean };
  return { items: body.items, truncated: body.truncated ?? false };
}

export async function getOrgChart(): Promise<OrgChart> {
  const res = await fetch(orgBase, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`getOrgChart returned ${res.status}`);
  return (await res.json()) as OrgChart;
}

export async function putOrgChart(input: { departments: OrgDepartment[]; members: OrgMember[] }): Promise<OrgChart> {
  const res = await fetch(orgBase, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch { /* ignore */ }
    throw new Error(`putOrgChart failed: ${detail}`);
  }
  return (await res.json()) as OrgChart;
}

export async function getDepartmentRollup(departmentId: string): Promise<ResponsibilityView> {
  const res = await fetch(`${orgBase}/${encodeURIComponent(departmentId)}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`getDepartmentRollup returned ${res.status}`);
  return (await res.json()) as ResponsibilityView;
}
