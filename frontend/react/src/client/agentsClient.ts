/**
 * Agents inventory client — the RFC 0072 §A normative inventory (`GET /agents`,
 * `/agents/{agentId}`, via the SDK) plus this host's OWN agent-management
 * surface (`POST/DELETE /host/openwop-app/agents`,
 * `GET/POST /host/openwop-app/registry/agent-packs`) called directly.
 *
 * CORRECTED 2026-09-10 (ADR 0647). The four management calls used to ride the
 * v1 SDK's `userAgents.*`, whose paths are `/v1/host/sample/...` — the
 * conformance SAMPLE namespace, which this host rewrites onto its product
 * surface ONLY under `OPENWOP_TEST_SEAM_ENABLED` (`routes/testSeam.ts`), a flag
 * production sets to `false`. MEASURED live: `/api/v1/host/sample/agents` → 404,
 * `/api/host/openwop-app/agents` → 200. The backend renamed the route on
 * 2026-06-14 (#260) and the SPA kept the SDK's address, so create / delete /
 * pack-install have answered 404 in production since — two of them SILENTLY
 * (the SDK mapped 404 to `false` / `null`, which the UI showed as "nothing to
 * install"). 22 of the 24 tests around these surfaces mock this module, which
 * is why nothing was red. `@openwop/openwop@2` removes `userAgents` entirely;
 * the honest address was always the product one.
 *
 * The frontend pattern is one thin module per backend surface (see
 * `runsClient.ts`, `interruptsClient.ts`, etc.); these wrappers adapt the
 * SDK's `null`-on-404 convention to the frontend's "empty array means none,
 * error means broken" convention so call sites don't have to dance around the
 * gating semantics.
 */
import { getSdkClient } from './runsClient.js';
import { authedHeaders, config, fetchOpts } from './config.js';
import { cachedRead } from './requestCache.js';
import type { AgentInventoryEntry } from '@openwop/openwop';
import { requestJson, ApiError } from './requestJson.js';

export type AgentEntry = AgentInventoryEntry;

/** `POST /host/openwop-app/agents` response — this host's record shape. */
export interface UserAgentRecord {
  agentId: string;
  persona: string;
  label: string;
  description?: string;
  modelClass: string;
  packName: string;
  packVersion: string;
  toolAllowlist: string[];
  systemPrompt?: string;
  memoryShape?: { scratchpad?: boolean; conversation?: boolean; longTerm?: boolean };
  confidenceThreshold?: number;
  createdAt?: string;
}
/** One row of `GET /host/openwop-app/registry/agent-packs`. */
export interface AgentPackSummary {
  name: string;
  version: string;
  description?: string;
  personas: string[];
  installed: boolean;
}

/** List all manifest agents the host has installed. Returns an empty
 *  array (not null) when the host doesn't advertise
 *  `capabilities.agents.manifestRuntime` — call sites care about
 *  "what can I show in the UI", not about the discovery gate. */
export async function listAgents(): Promise<readonly AgentEntry[]> {
  // Coalesce concurrent reads (every chat tab's @-mention picker mounts one) into
  // one request. TTL 0 = in-flight-only, so a create/delete reflects on the next
  // read — the dedup only collapses the simultaneous mount burst that 429s.
  return cachedRead('agents.list', 0, async () => {
    const resp = await getSdkClient().agents.list();
    if (!resp) return [];
    return resp.agents;
  });
}

/** Fetch a single agent by id. Returns `null` when the host doesn't
 *  advertise the capability OR when the id is unknown — call sites
 *  treat both as "not available", same as a missing pack. */
export async function getAgent(agentId: string): Promise<AgentEntry | null> {
  return getSdkClient().agents.get(agentId);
}

/** Create a user-authored agent via `POST /host/openwop-app/agents`
 *  (host-extension). Returns the projected record on success;
 *  the underlying SDK throws on validation / conflict / forbidden
 *  with the server error body in the message. */
export interface CreateUserAgentInput {
  persona: string;
  label?: string;
  description?: string;
  modelClass: 'chat' | 'reasoning' | 'coding' | 'extraction';
  systemPrompt: string;
  toolAllowlist?: string[];
  memoryShape?: {
    scratchpad?: boolean;
    conversation?: boolean;
    longTerm?: boolean;
  };
  confidenceThreshold?: number;
}

const AGENTS = '/host/openwop-app/agents';
const AGENT_PACKS = '/host/openwop-app/registry/agent-packs';

export async function createUserAgent(input: CreateUserAgentInput): Promise<UserAgentRecord> {
  return requestJson<UserAgentRecord>(AGENTS, { json: input });
}

/** The pack list plus whether THIS caller may install (UX_UPGRADE-agents AG-G1).
 *  `canInstall` is server-computed from the same superadmin predicate the
 *  install route enforces. Read defensively: the field is additive on a
 *  host-extension route, and a host that predates it simply reports `false`,
 *  which fails CLOSED (we offer nothing rather than offering a 403). */
export async function listAvailableAgentPacks(): Promise<{ packs: readonly AgentPackSummary[]; canInstall: boolean }> {
  // A failed read THROWS. The SDK path returned `null` on 404 and this wrapper
  // turned it into an empty catalogue — the exact "failed read presenting as
  // empty" shape that hid the production 404 behind a blank install page.
  const resp = await requestJson<{ packs?: unknown; canInstall?: unknown }>(AGENT_PACKS);
  const packs = Array.isArray(resp.packs) ? (resp.packs as AgentPackSummary[]) : [];
  return { packs, canInstall: resp.canInstall === true };
}

export async function installAgentPack(name: string, version?: string): Promise<void> {
  await requestJson(`${AGENT_PACKS}/install`, { json: version !== undefined ? { name, version } : { name } });
}

/** Delete a user-authored agent. Returns `true` when the row was
 *  removed; `false` when the agent didn't exist. Throws when the
 *  agent belongs to a different workspace (403) or is
 *  pack-installed. */
/** `true` when the agent existed and is gone (204); `false` when there was
 *  nothing to delete (404). Any other refusal throws — a 401/403/5xx must not
 *  read as "already gone". */
export async function deleteUserAgent(agentId: string): Promise<boolean> {
  const res = await fetch(
    `${config.baseUrl}${AGENTS}/${encodeURIComponent(agentId)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `deleteUserAgent failed (${res.status})` });
}

/** Projection returned by the editable-instructions PATCH. */
export interface UserAgentProjection {
  agentId: string;
  persona: string;
  label?: string;
  description?: string;
  modelClass: string;
  systemPrompt: string;
  toolAllowlist: string[];
  memoryShape: { scratchpad: boolean; conversation: boolean; longTerm: boolean };
  confidenceThreshold?: number;
}

/** Edit a user-authored agent's instructions + persona-shaping metadata via
 *  `PATCH /host/openwop-app/agents/:id` (host-extension; not in the SDK).
 *  `persona` is immutable — omit it. The response carries the saved
 *  `systemPrompt` (the read projection on `GET /v1/agents` omits it). */
export async function updateUserAgent(
  agentId: string,
  patch: {
    label?: string;
    description?: string;
    modelClass?: 'chat' | 'reasoning' | 'coding' | 'extraction';
    systemPrompt?: string;
    toolAllowlist?: string[];
    memoryShape?: { scratchpad?: boolean; conversation?: boolean; longTerm?: boolean };
    confidenceThreshold?: number;
  },
): Promise<UserAgentProjection> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/agents/${encodeURIComponent(agentId)}`,
    fetchOpts({ method: 'PATCH', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(patch) }),
  );
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch { /* ignore */ }
    throw new Error(`updateUserAgent failed: ${detail}`);
  }
  return (await res.json()) as UserAgentProjection;
}
