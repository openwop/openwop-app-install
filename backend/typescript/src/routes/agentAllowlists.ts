/**
 * Agent tool-allowlist admin routes (ADR 0104) — super-admin-gated host extension
 * under /v1/host/openwop-app/agent-allowlists/admin/*.
 *
 * Lets a platform operator read any dispatchable agent's effective tool allowlist
 * (manifest vs override) + the catalog of mountable tools, and set/clear a
 * per-(tenant, agentId) override the dispatcher applies (Phase 1). The agent's
 * ADVERTISED manifest is never mutated — host-local policy only. Every route is
 * `requireSuperadmin` (the ADR 0028 shared gate); the override store fail-closes
 * per tenant. Keyed by the DISPATCH agentId (the manifest id the registry lists),
 * so the admin can only target what dispatch actually resolves.
 *
 * @see docs/adr/0104-superadmin-agent-toolallowlist-editor.md
 * @see src/routes/featureToggles.ts — the admin-route precedent this mirrors
 */
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { requireSuperadmin as requireSuperadminShared } from '../host/superadmin.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { hostExtStorage } from '../host/hostExtPersistence.js';
import { builtinAgentToolIds } from '../host/agentToolProvider.js';
import {
  listAgentToolAllowlistOverrides,
  getAgentToolAllowlistOverride,
  upsertAgentToolAllowlistOverride,
  clearAgentToolAllowlistOverride,
  type AgentToolAllowlistOverride,
} from '../host/agentToolAllowlistService.js';

const BASE = '/v1/host/openwop-app/agent-allowlists/admin';
const TOOL_ID = /^openwop:[A-Za-z0-9._:-]+$/;
const ALLOWLIST_CAP = 64;
const NOTE_MAX = 500;

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actorOf = (req: Request): string => req.userId ?? req.principal?.principalId ?? 'superadmin';

function requireSuperadmin(req: Request): void {
  requireSuperadminShared(req, 'Agent tool-allowlist administration');
}

/** Agents a tenant can dispatch: global pack agents (no `ownerTenant`) + this
 *  tenant's own user agents. Mirrors routes/agents.ts `visibleTo`. */
function visibleTo(a: ResolvedAgentManifest, tenant: string): boolean {
  return !a.ownerTenant || a.ownerTenant === tenant;
}

/** The catalog of tool ids an agent COULD be allowlisted to: the built-in agent
 *  tools + every installed node typeId (as `openwop:<typeId>`). Sorted + deduped. */
function buildToolCatalog(): string[] {
  const ids = new Set<string>(builtinAgentToolIds());
  for (const t of getNodeRegistry().listTypeIds()) ids.add(`openwop:${t}`);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function validateAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new OpenwopError('validation_error', '`toolAllowlist` MUST be an array of tool ids.', 400, { field: 'toolAllowlist' });
  }
  if (value.length > ALLOWLIST_CAP) {
    throw new OpenwopError('validation_error', `\`toolAllowlist\` MUST have at most ${ALLOWLIST_CAP} entries.`, 400, { field: 'toolAllowlist', cap: ALLOWLIST_CAP });
  }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !TOOL_ID.test(v)) {
      throw new OpenwopError('validation_error', `Invalid tool id \`${String(v)}\` — expected \`openwop:<id>\`.`, 400, { field: 'toolAllowlist' });
    }
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Resolve a dispatchable agent visible to the caller's tenant, or 404 (no
 *  existence leak of another tenant's user agent; an unknown id is also 404). */
function loadVisibleAgent(req: Request): ResolvedAgentManifest {
  const agent = getAgentRegistry().get(req.params.agentId);
  if (!agent || !visibleTo(agent, tenantOf(req))) {
    throw new OpenwopError('not_found', 'Agent not found.', 404, { agentId: req.params.agentId });
  }
  return agent;
}

interface AgentAllowlistRow {
  agentId: string;
  label: string;
  persona: string;
  manifestAllowlist: string[];
  override: AgentToolAllowlistOverride | null;
}

export function registerAgentAllowlistRoutes(app: Express): void {
  // List the dispatchable agents + their manifest allowlist + any override.
  app.get(`${BASE}/agents`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const tenant = tenantOf(req);
      const overrides = await listAgentToolAllowlistOverrides(tenant); // one read, then map
      const byAgent = new Map(overrides.map((o) => [o.agentId, o]));
      const rows: AgentAllowlistRow[] = getAgentRegistry().list()
        .filter((a) => visibleTo(a, tenant))
        .map((a) => ({
          agentId: a.agentId,
          label: a.label ?? a.agentId,
          persona: a.persona,
          manifestAllowlist: a.toolAllowlist ?? [],
          override: byAgent.get(a.agentId) ?? null,
        }))
        .sort((x, y) => x.label.localeCompare(y.label));
      res.json({ agents: rows });
    } catch (err) { next(err); }
  });

  // One agent: manifest allowlist + override + effective + the tool catalog.
  app.get(`${BASE}/agents/:agentId`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const agent = loadVisibleAgent(req);
      const override = await getAgentToolAllowlistOverride(tenantOf(req), agent.agentId);
      const manifestAllowlist = agent.toolAllowlist ?? [];
      res.json({
        agentId: agent.agentId,
        label: agent.label ?? agent.agentId,
        persona: agent.persona,
        manifestAllowlist,
        override,
        effective: override ? override.toolAllowlist : manifestAllowlist,
        toolCatalog: buildToolCatalog(),
      });
    } catch (err) { next(err); }
  });

  // Upsert the override (full-replace).
  app.put(`${BASE}/agents/:agentId`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const agent = loadVisibleAgent(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const toolAllowlist = validateAllowlist(body.toolAllowlist);
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.slice(0, NOTE_MAX) : undefined;
      const row = await upsertAgentToolAllowlistOverride(tenantOf(req), agent.agentId, {
        toolAllowlist,
        ...(note ? { note } : {}),
        updatedBy: actorOf(req),
      });
      // ADR 0104 Phase 4 — audit the grant via the existing audit log (ADR 0028, no
      // second store). Best-effort: an audit hiccup must not fail the admin action.
      try {
        await hostExtStorage().appendAudit({
          timestamp: row.updatedAt,
          principalId: actorOf(req),
          action: 'agent-allowlist.upsert',
          resource: `${tenantOf(req)}:${agent.agentId}`,
          outcome: 'ok',
          payload: { toolAllowlist, ...(note ? { note } : {}) },
        });
      } catch { /* best-effort audit */ }
      res.json(row);
    } catch (err) { next(err); }
  });

  // Clear the override (revert to the manifest allowlist).
  app.delete(`${BASE}/agents/:agentId`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const agent = loadVisibleAgent(req);
      const ok = await clearAgentToolAllowlistOverride(tenantOf(req), agent.agentId);
      if (!ok) throw new OpenwopError('not_found', 'No override set for this agent.', 404, { agentId: agent.agentId });
      try {
        await hostExtStorage().appendAudit({
          timestamp: new Date().toISOString(),
          principalId: actorOf(req),
          action: 'agent-allowlist.clear',
          resource: `${tenantOf(req)}:${agent.agentId}`,
          outcome: 'ok',
        });
      } catch { /* best-effort audit */ }
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
