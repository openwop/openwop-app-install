/**
 * Agent profile — host-extension routes (non-normative).
 *
 * The reference implementation of ADR 0031 §2:
 *   GET /v1/host/openwop-app/agents/:id/profile   read the rich profile
 *   PUT /v1/host/openwop-app/agents/:id/profile   create-or-replace it
 *
 * `:id` is the owning agent id — a standing-agent `rosterId` (`host:<slug>`).
 * Both routes are gated by the SAME tenant rule the roster routes enforce
 * (`host/rosterService.ts`): the caller must own the roster member, or the
 * route 404s — so one tenant can neither read nor write another's profile, and
 * an unknown/foreign agent fails closed (ADR 0031 §2 "fail closed on
 * unknown/disabled"). The profile is vendor-prefixed host-extension config; it
 * never touches the RFC 0003 manifest wire shape.
 *
 * @see src/host/agentProfileService.ts
 * @see src/routes/roster.ts — the gating + tenant pattern this mirrors
 * @see docs/adr/0031-agent-profile-and-seeding.md
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { getRosterEntry, autonomyOf, type RosterEntry } from '../host/rosterService.js';
import {
  getAgentProfile,
  upsertAgentProfile,
  specLevelForLevel,
  type AgentProfileInput,
} from '../host/agentProfileService.js';
import { resolveConnectionReadiness, gateAutonomyByReadiness } from '../host/connectionReadiness.js';

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

type SpecLevel = AgentProfileInput['autonomy']['specLevel'];
type RosterLevel = NonNullable<AgentProfileInput['autonomy']['level']>;

const SPEC_LEVELS = new Set<SpecLevel>([
  'draft-only',
  'recommend',
  'execute-with-approval',
  'autonomous-within-policy',
]);
const ROSTER_LEVELS = new Set<RosterLevel>(['auto', 'guided', 'review']);

/** Resolve the owning agent, fail-closed: a missing OR cross-tenant agent
 *  yields a generic 404 (never leaks that the id exists in another tenant).
 *  Returns the entry so callers can read `autonomyLevel` (ADR 0101 SSoT). */
async function requireOwnedAgent(req: Request): Promise<RosterEntry> {
  const id = req.params.id;
  const entry = await getRosterEntry(id);
  if (!entry || entry.tenantId !== tenantOf(req)) {
    throw new OpenwopError('not_found', 'Agent not found.', 404, { id });
  }
  return entry;
}

function optStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new OpenwopError('validation_error', `Field \`${field}\` MUST be an array of strings.`, 400, { field });
  }
  return value as string[];
}

function parseProfileBody(raw: unknown): AgentProfileInput {
  if (!raw || typeof raw !== 'object') {
    throw new OpenwopError('validation_error', 'Request body MUST be an object.', 400);
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.roleKey !== 'string' || body.roleKey.trim().length === 0) {
    throw new OpenwopError('validation_error', 'Field `roleKey` is required and MUST be a non-empty string.', 400, {
      field: 'roleKey',
    });
  }

  if (!body.autonomy || typeof body.autonomy !== 'object') {
    throw new OpenwopError('validation_error', 'Field `autonomy` is required and MUST be an object.', 400, {
      field: 'autonomy',
    });
  }
  const autonomy = body.autonomy as Record<string, unknown>;
  if (typeof autonomy.specLevel !== 'string' || !SPEC_LEVELS.has(autonomy.specLevel as SpecLevel)) {
    throw new OpenwopError(
      'validation_error',
      `Field \`autonomy.specLevel\` MUST be one of [${[...SPEC_LEVELS].join(', ')}].`,
      400,
      { field: 'autonomy.specLevel', allowed: [...SPEC_LEVELS] },
    );
  }
  const specLevel = autonomy.specLevel as SpecLevel;
  let level: RosterLevel | undefined;
  if (autonomy.level !== undefined) {
    if (typeof autonomy.level !== 'string' || !ROSTER_LEVELS.has(autonomy.level as RosterLevel)) {
      throw new OpenwopError(
        'validation_error',
        `Field \`autonomy.level\` MUST be one of [${[...ROSTER_LEVELS].join(', ')}].`,
        400,
        { field: 'autonomy.level', allowed: [...ROSTER_LEVELS] },
      );
    }
    level = autonomy.level as RosterLevel;
  }

  let department: AgentProfileInput['department'];
  if (body.department !== undefined) {
    const d = body.department as Record<string, unknown>;
    if (!d || typeof d !== 'object' || typeof d.departmentId !== 'string' || typeof d.name !== 'string') {
      throw new OpenwopError(
        'validation_error',
        'Field `department` MUST be an object with string `departmentId` and `name`.',
        400,
        { field: 'department' },
      );
    }
    department = {
      departmentId: d.departmentId,
      name: d.name,
      ...(typeof d.roleId === 'string' ? { roleId: d.roleId } : {}),
      ...(typeof d.roleName === 'string' ? { roleName: d.roleName } : {}),
    };
  }

  let permissions: AgentProfileInput['permissions'];
  if (body.permissions !== undefined) {
    const p = body.permissions as Record<string, unknown>;
    const read = optStringArray(p?.read, 'permissions.read');
    const write = optStringArray(p?.write, 'permissions.write');
    const never = optStringArray(p?.never, 'permissions.never');
    if (read === undefined || write === undefined || never === undefined) {
      throw new OpenwopError(
        'validation_error',
        'Field `permissions` MUST carry string arrays `read`, `write`, and `never`.',
        400,
        { field: 'permissions' },
      );
    }
    permissions = { read, write, never };
  }

  let escalation: AgentProfileInput['escalation'];
  if (body.escalation !== undefined) {
    const e = body.escalation as Record<string, unknown>;
    const contacts = optStringArray(e?.contacts, 'escalation.contacts');
    const triggers = optStringArray(e?.triggers, 'escalation.triggers');
    if (contacts === undefined || triggers === undefined) {
      throw new OpenwopError(
        'validation_error',
        'Field `escalation` MUST carry string arrays `contacts` and `triggers`.',
        400,
        { field: 'escalation' },
      );
    }
    escalation = { contacts, triggers };
  }

  let channels: AgentProfileInput['channels'];
  if (body.channels !== undefined) {
    const c = body.channels as Record<string, unknown>;
    if (!c || typeof c !== 'object') {
      throw new OpenwopError('validation_error', 'Field `channels` MUST be an object.', 400, { field: 'channels' });
    }
    if (c.approval !== undefined && typeof c.approval !== 'string') {
      throw new OpenwopError('validation_error', 'Field `channels.approval` MUST be a string.', 400, { field: 'channels.approval' });
    }
    if (c.delivery !== undefined && typeof c.delivery !== 'string') {
      throw new OpenwopError('validation_error', 'Field `channels.delivery` MUST be a string.', 400, { field: 'channels.delivery' });
    }
    channels = {
      ...(typeof c.approval === 'string' ? { approval: c.approval } : {}),
      ...(typeof c.delivery === 'string' ? { delivery: c.delivery } : {}),
    };
  }

  if (body.configParameters !== undefined) {
    if (typeof body.configParameters !== 'object' || body.configParameters === null || Array.isArray(body.configParameters)) {
      throw new OpenwopError('validation_error', 'Field `configParameters` MUST be a JSON object.', 400, {
        field: 'configParameters',
      });
    }
  }

  // ADR 0038 — optional per-agent knowledge bindings (additive). Validates the
  // shape; the curation feature is the primary writer, but the PUT also accepts it.
  let knowledge: AgentProfileInput['knowledge'];
  if (body.knowledge !== undefined) {
    const k = body.knowledge as Record<string, unknown>;
    if (!k || typeof k !== 'object' || Array.isArray(k)) {
      throw new OpenwopError('validation_error', 'Field `knowledge` MUST be an object.', 400, { field: 'knowledge' });
    }
    const collectionIds = optStringArray(k.collectionIds, 'knowledge.collectionIds');
    if (k.memoryWritable !== undefined && typeof k.memoryWritable !== 'boolean') {
      throw new OpenwopError('validation_error', 'Field `knowledge.memoryWritable` MUST be a boolean.', 400, { field: 'knowledge.memoryWritable' });
    }
    let retrieval: NonNullable<AgentProfileInput['knowledge']>['retrieval'];
    if (k.retrieval !== undefined) {
      const r = k.retrieval as Record<string, unknown>;
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        throw new OpenwopError('validation_error', 'Field `knowledge.retrieval` MUST be an object.', 400, { field: 'knowledge.retrieval' });
      }
      if (r.topK !== undefined && (typeof r.topK !== 'number' || !Number.isFinite(r.topK) || r.topK <= 0)) {
        throw new OpenwopError('validation_error', 'Field `knowledge.retrieval.topK` MUST be a positive number.', 400, { field: 'knowledge.retrieval.topK' });
      }
      let sources: ('kb' | 'memory')[] | undefined;
      if (r.sources !== undefined) {
        if (!Array.isArray(r.sources) || r.sources.some((s) => s !== 'kb' && s !== 'memory')) {
          throw new OpenwopError('validation_error', 'Field `knowledge.retrieval.sources` MUST be an array of "kb" | "memory".', 400, { field: 'knowledge.retrieval.sources' });
        }
        sources = r.sources as ('kb' | 'memory')[];
      }
      retrieval = {
        ...(typeof r.topK === 'number' ? { topK: r.topK } : {}),
        ...(sources !== undefined ? { sources } : {}),
      };
    }
    knowledge = {
      ...(collectionIds !== undefined ? { collectionIds } : {}),
      ...(typeof k.memoryWritable === 'boolean' ? { memoryWritable: k.memoryWritable } : {}),
      ...(retrieval !== undefined ? { retrieval } : {}),
    };
  }

  // Parse each optional string-array once (the parse also validates shape).
  const hitl = optStringArray(body.hitl, 'hitl');
  const adminControls = optStringArray(body.adminControls, 'adminControls');
  const riskCompliance = optStringArray(body.riskCompliance, 'riskCompliance');
  const requiredConnections = optStringArray(body.requiredConnections, 'requiredConnections');
  const metrics = optStringArray(body.metrics, 'metrics');
  const withinPolicyActions = optStringArray(autonomy.withinPolicyActions, 'autonomy.withinPolicyActions');

  return {
    roleKey: body.roleKey.trim(),
    ...(department !== undefined ? { department } : {}),
    ...(body.configParameters !== undefined ? { configParameters: body.configParameters as Record<string, unknown> } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(hitl !== undefined ? { hitl } : {}),
    ...(escalation !== undefined ? { escalation } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(adminControls !== undefined ? { adminControls } : {}),
    ...(riskCompliance !== undefined ? { riskCompliance } : {}),
    ...(requiredConnections !== undefined ? { requiredConnections } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(knowledge !== undefined ? { knowledge } : {}),
    autonomy: {
      ...(level !== undefined ? { level } : {}),
      specLevel,
      ...(withinPolicyActions !== undefined ? { withinPolicyActions } : {}),
    },
  };
}

export function registerAgentProfileRoutes(app: Express): void {
  app.get('/v1/host/openwop-app/agents/:id/profile', async (req, res, next) => {
    try {
      const entry = await requireOwnedAgent(req);
      const profile = await getAgentProfile(tenantOf(req), entry.rosterId);
      if (!profile) {
        throw new OpenwopError('not_found', 'Agent profile not found.', 404, { id: entry.rosterId });
      }
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/openwop-app/agents/:id/profile', async (req, res, next) => {
    try {
      const entry = await requireOwnedAgent(req);
      const input = parseProfileBody(req.body);
      // ADR 0101 — `roster.autonomyLevel` is the single autonomy source of truth
      // (owned by the Edit-details modal). Derive the profile's enforced `level`
      // + provenance `specLevel` from it, never from the request body, so the two
      // can't disagree. `withinPolicyActions` (the auto allowlist) is preserved.
      const level = autonomyOf(entry);
      const derived: AgentProfileInput = {
        ...input,
        autonomy: {
          level,
          specLevel: specLevelForLevel(level, input.autonomy.specLevel),
          ...(input.autonomy.withinPolicyActions !== undefined
            ? { withinPolicyActions: input.autonomy.withinPolicyActions }
            : {}),
        },
      };
      const profile = await upsertAgentProfile(tenantOf(req), entry.rosterId, derived);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  // ADR 0033 §3.3 — the activation-honesty advertisement. Reflects which of the
  // agent's `requiredConnections` are configured vs missing, and the effective
  // autonomy after the connection gate (the same gate `heartbeatService` applies
  // at pick time). A twin with unmet connections reports `gatedAutonomy:'review'`
  // and `effective.acting:false` — the honest `supported:false` signal the FE
  // connection-status surface renders. Same fail-closed tenant gate as /profile.
  app.get('/v1/host/openwop-app/agents/:id/connection-readiness', async (req, res, next) => {
    try {
      const entry = await requireOwnedAgent(req);
      const id = entry.rosterId;
      const profile = await getAgentProfile(tenantOf(req), id);
      const actingUserId = (req as Request & { userId?: string }).userId;
      const readiness = await resolveConnectionReadiness(tenantOf(req), id, actingUserId);
      const declaredLevel = profile?.autonomy.level ?? 'review';
      const gatedAutonomy = gateAutonomyByReadiness(declaredLevel, readiness);
      res.json({
        agentId: id,
        ...readiness,
        declaredAutonomy: declaredLevel,
        gatedAutonomy,
        // `acting` is the honest "can this twin autonomously act?" bit: only when
        // every required connection is configured AND its level permits action.
        effective: { acting: readiness.allConfigured && gatedAutonomy !== 'review' },
      });
    } catch (err) {
      next(err);
    }
  });
}
