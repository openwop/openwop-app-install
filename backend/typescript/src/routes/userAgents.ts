/**
 * User-authored agent CRUD — host-extension surface backing the
 * Agents-tab "+ Author new" form (phase E1, 2026-05-28).
 *
 * Endpoints:
 *   POST   /v1/host/openwop-app/agents              create
 *   DELETE /v1/host/openwop-app/agents/{agentId}    delete (user records only)
 *
 * READ surface stays unified with pack-installed agents — the existing
 * `GET /v1/agents` + `GET /v1/agents/:agentId` in `routes/agents.ts`
 * project both sources because both register into the same
 * `AgentRegistry`. Boot-time `loadUserAgentsIntoRegistry()` reads every
 * `user_agents` row at startup and registers them; this route
 * registers freshly-created ones inline.
 *
 * Namespace: vendor-prefixed (`/v1/host/openwop-app/*`) because the create
 * surface is host-extension, not normative. A future RFC could
 * promote it to `/v1/agents` POST.
 */

import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import type { UserAgentRecord } from '../types.js';
import { OpenwopError } from '../types.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import { createLogger } from '../observability/logger.js';
import {
  canonicalRequestDigest,
  idempotencyLeaseMs,
  redactKey,
  type IdempotentEndpoint,
} from '../host/idempotentResponse.js';
import { idempotencyOutcomeOf, recordIdempotencyClaim } from '../observability/metricSeams.js';

const log = createLogger('routes.userAgents');

interface CreateBody {
  persona?: unknown;
  label?: unknown;
  description?: unknown;
  modelClass?: unknown;
  systemPrompt?: unknown;
  toolAllowlist?: unknown;
  memoryShape?: unknown;
  confidenceThreshold?: unknown;
}

/** Known model classes per `bootstrap/nodes.ts`'s chat-responder
 *  surface. Strict allowlist so a typo doesn't silently fall through
 *  to a 500 at dispatch time. */
const KNOWN_MODEL_CLASSES = new Set([
  'chat',
  'reasoning',
  'coding',
  'extraction',
]);

const PERSONA_MAX_LEN = 64;
const LABEL_MAX_LEN = 80;
const DESCRIPTION_MAX_LEN = 280;
const SYSTEM_PROMPT_MAX_LEN = 16_000;
const TOOL_ALLOWLIST_MAX_LEN = 32;

interface Deps {
  storage: Storage;
}

/** ADR 0549 P0 — this route's entry in the ledger's closed endpoint union. */
const AGENTS_ENDPOINT: IdempotentEndpoint = 'POST:/v1/host/openwop-app/agents';

/* ADR 0549 P0 — the local `idempotencyBodyHashes` Map and `hashRequestBody`
 * are gone, and so is the reasoning that kept them here: "Kept local to this
 * module rather than shared so each route's idempotency surface evolves
 * independently." Independent evolution of one contract across two copies IS
 * the drift, not a defence against it — and while the copies sat here they
 * shared a single raw-key storage row, so the two endpoints could serve each
 * other's cached bodies. One owner now: `host/idempotentResponse.ts`. */

export function registerUserAgentRoutes(app: Express, deps: Deps): void {
  const { storage } = deps;

  app.post('/v1/host/openwop-app/agents', async (req, res, next) => {
    // ADR 0549 P1 — hoisted above the try so the `finally` can release a claim
    // this handler won but never committed.
    let heldClaimToken: string | undefined;
    let heldKey: string | undefined;
    let heldTenantId: string | undefined;
    try {
      const tenantId = readTenantId(req);
      // Idempotency-Key handling per spec/v1/idempotency.md Layer 1.
      // The flow matches `routes/runs.ts` POST /v1/runs:
      //   1. claim atomically — first caller proceeds, concurrent
      //      callers either get the cached response or 409.
      //   2. same key + different body → 409 idempotency_key_mismatch.
      //   3. cache the response after persisting so a same-key replay
      //      returns the identical 201 body + the
      //      `openwop-Idempotent-Replay: true` marker header.
      //
      // ADR 0549 P0 — keyed (tenantId, endpoint, key). `readTenantId` returns
      // the middleware-bound tenant, never a body value. Note that wildcard
      // bearer callers all resolve to `default` and therefore share one
      // keyspace — that is the pre-existing shared-demo-tenant posture this
      // route already documents, not a new collision introduced here.
      const idempotencyKey = req.header('idempotency-key') ?? undefined;
      if (idempotencyKey) {
        heldKey = idempotencyKey;
        heldTenantId = tenantId;
        const claim = await storage.claimIdempotentResponse({
          tenantId,
          endpoint: AGENTS_ENDPOINT,
          key: idempotencyKey,
          requestDigest: canonicalRequestDigest(req.body, AGENTS_ENDPOINT),
          createdAt: new Date().toISOString(),
          leaseMs: idempotencyLeaseMs(),
        });
        // ADR 0556 P1 — same ledger counter as POST /v1/runs, same helper, so
        // the two participating endpoints cannot classify an outcome differently.
        recordIdempotencyClaim(AGENTS_ENDPOINT, idempotencyOutcomeOf(claim));
        if (claim.outcome === 'claimed') heldClaimToken = claim.claimToken;
        if (claim.outcome === 'mismatch') {
          throw new OpenwopError(
            'idempotency_key_mismatch',
            'Idempotency-Key was previously used with a different request body.',
            409,
            { idempotencyKey },
          );
        }
        if (claim.outcome === 'replay') {
          res
            .status(claim.responseStatus)
            .set('openwop-Idempotent-Replay', 'true')
            .type('application/json')
            .send(claim.responseBody);
          return;
        }
        if (claim.outcome === 'in-flight') {
          throw new OpenwopError(
            'idempotency_key_conflict',
            'A request with this Idempotency-Key is currently in flight; retry after it completes.',
            409,
            { idempotencyKey },
          );
        }
      }

      const parsed = validateCreate(req.body as CreateBody);
      const personaSlug = slugify(parsed.persona);
      // Per-tenant scoping so two tenants can each have a
      // `user.acme.code-reviewer` / `user.beta.code-reviewer` without
      // collision. Pack-installed ids never start with `user.`, so
      // the prefix is sufficient discrimination.
      // ADR 0379 P2 — persona-scoped: the tenant lives in the ROW (and the
      // composite PK), never the id string, so an adopt fold collides instead
      // of duplicating. Uniqueness is per-tenant via the (tenant_id, agent_id)
      // PK; the dup-check below reads with the caller's tenant.
      const agentId = `user.${personaSlug}`;
      // 409 on duplicate persona — the user's first attempt creates,
      // a retry with the same persona name gets a clear error rather
      // than silently overwriting their previous work.
      const existing = await storage.getUserAgent(tenantId, agentId);
      if (existing) {
        throw new OpenwopError(
          'idempotency_key_conflict',
          `An agent named "${parsed.persona}" already exists in your workspace. Pick a different name or delete the existing one first.`,
          409,
          { agentId },
        );
      }
      const record: UserAgentRecord = {
        agentId,
        tenantId,
        persona: parsed.persona,
        ...(parsed.label !== undefined ? { label: parsed.label } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        modelClass: parsed.modelClass,
        systemPrompt: parsed.systemPrompt,
        toolAllowlist: parsed.toolAllowlist,
        memoryShape: parsed.memoryShape,
        ...(parsed.confidenceThreshold !== undefined
          ? { confidenceThreshold: parsed.confidenceThreshold }
          : {}),
        createdAt: new Date().toISOString(),
      };
      await storage.insertUserAgent(record);
      registerUserAgent(record);
      const responseBody = {
        agentId: record.agentId,
        persona: record.persona,
        label: record.label ?? record.persona,
        description: record.description,
        modelClass: record.modelClass,
        // Echo the caller's own systemPrompt (consistent with the PATCH
        // response). Not an SR-1 leak: the caller just authored it. The
        // cross-agent read projection on GET /v1/agents still omits it.
        systemPrompt: record.systemPrompt,
        packName: `user:${tenantId}`,
        packVersion: '0',
        toolAllowlist: record.toolAllowlist,
        memoryShape: record.memoryShape,
        confidenceThreshold: record.confidenceThreshold,
        hasHandoffSchemas: false,
      };
      // Persist the cached response under the idempotency key so a
      // same-key retry post-restart still returns the identical body.
      if (idempotencyKey && heldClaimToken) {
        // Guarded rather than asserted (`heldClaimToken!`): reaching here with
        // a key but no token would mean the claim returned something other
        // than `claimed`, and every such outcome above either returns or
        // throws. An explicit guard states that instead of asserting it, and
        // matches how `routes/runs.ts` writes the same block.
        await storage.completeIdempotentResponse({
          tenantId,
          endpoint: AGENTS_ENDPOINT,
          key: idempotencyKey,
          responseStatus: 201,
          responseBody: JSON.stringify(responseBody),
          updatedAt: record.createdAt,
          claimToken: heldClaimToken,
        });
        heldClaimToken = undefined; // committed — the finally must not release
      }
      res.status(201).json(responseBody);
    } catch (err) {
      next(err);
    } finally {
      if (heldKey && heldClaimToken && heldTenantId) {
        const key = heldKey;
        await storage
          .releaseIdempotentResponse({
            tenantId: heldTenantId,
            endpoint: AGENTS_ENDPOINT,
            key,
            claimToken: heldClaimToken,
          })
          .catch((e: unknown) =>
            log.warn('idempotency_release_failed', {
              key: redactKey(key),
              error: e instanceof Error ? e.message : String(e),
            }),
          );
      }
    }
  });

  // Editable "Instructions" panel (PRD §9) — patch a user-authored agent's
  // mutable fields. `agentId`/`tenantId`/`createdAt` are immutable; persona is
  // immutable too (it derives the agentId). Pack-installed agents are NOT
  // editable here (different storage) — the UI forks them instead.
  app.patch('/v1/host/openwop-app/agents/:agentId', async (req, res, next) => {
    try {
      const tenantId = readTenantId(req);
      const { agentId } = req.params;
      // ADR 0379 P1 — tenant is in the storage predicate: a cross-tenant id is
      // null here, so the old 403 forbidden_tenant branch is unreachable and
      // the uniform 404 (no existence oracle) is the only denial.
      const record = await storage.getUserAgent(tenantId, agentId);
      if (!record) {
        throw new OpenwopError(
          'not_found',
          `User-authored agent ${agentId} not found. Pack-installed agents are not editable through this route.`,
          404,
        );
      }
      const patch = validatePatch(req.body as CreateBody);
      const updated: UserAgentRecord = {
        ...record,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.modelClass !== undefined ? { modelClass: patch.modelClass } : {}),
        ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
        ...(patch.toolAllowlist !== undefined ? { toolAllowlist: patch.toolAllowlist } : {}),
        ...(patch.memoryShape !== undefined ? { memoryShape: patch.memoryShape } : {}),
        ...(patch.confidenceThreshold !== undefined
          ? { confidenceThreshold: patch.confidenceThreshold }
          : {}),
      };
      await storage.updateUserAgent(tenantId, updated);
      // Re-register so the in-process registry (GET /v1/agents, the chat `@`
      // picker, the chat-responder system prompt) reflects the edit at once.
      registerUserAgent(updated);
      res.json({
        agentId: updated.agentId,
        persona: updated.persona,
        label: updated.label ?? updated.persona,
        description: updated.description,
        modelClass: updated.modelClass,
        systemPrompt: updated.systemPrompt,
        packName: `user:${tenantId}`,
        packVersion: '0',
        toolAllowlist: updated.toolAllowlist,
        memoryShape: updated.memoryShape,
        confidenceThreshold: updated.confidenceThreshold,
        hasHandoffSchemas: false,
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/agents/:agentId', async (req, res, next) => {
    try {
      const tenantId = readTenantId(req);
      const { agentId } = req.params;
      // ADR 0379 P1 — tenant is in the storage predicate: a cross-tenant id is
      // null (uniform 404, no existence leak — this route previously answered
      // 403 for other tenants' ids, which WAS an existence oracle).
      const record = await storage.getUserAgent(tenantId, agentId);
      if (!record) {
        throw new OpenwopError(
          'not_found',
          `User-authored agent ${agentId} not found. Pack-installed agents are not deletable through this route.`,
          404,
        );
      }
      const removed = await storage.deleteUserAgent(tenantId, agentId);
      // Drop from the in-process registry too so subsequent
      // `GET /v1/agents` lists, the `@`-mention picker, and the
      // chat-responder lookup all stop seeing it immediately rather
      // than waiting for the next process restart. The remove() is
      // idempotent (returns false when the agent isn't in the
      // registry — possible if the storage row outlived an earlier
      // partial-load), so calling it on a missing entry is safe.
      getAgentRegistry().remove(agentId, tenantId);
      res.status(removed ? 204 : 404).end();
    } catch (err) {
      next(err);
    }
  });
}

/** Boot-time loader — read every user-authored agent across every
 *  tenant and register it with the in-process `AgentRegistry`. Wired
 *  from `index.ts` at boot after the BYOK + pack loaders so user
 *  agents merge with pack ones in the same registry surface.
 *
 *  Idempotent — re-running just re-registers (the registry is a Map
 *  keyed by agentId; the last insertion wins). The registry is not
 *  itself tenant-scoped; tenant-isolation lives at the storage +
 *  route layers (creation requires authenticated tenant; the chat
 *  dispatcher passes only agentId so the registry lookup is global). */
export async function loadUserAgentsIntoRegistry(storage: Storage): Promise<number> {
  const records = await storage.listAllUserAgents();
  let migrated = 0;
  for (const record of records) {
    // One-time legacy-tenant migration: before the bearer-shared posture work,
    // API-key callers' agents were bucketed under the `_anon` fallback tenant.
    // The fallback is now `default`, so without this rewrite those rows orphan
    // (invisible to GET /v1/agents and undeletable for bearer-shared callers).
    // The agentId is immutable — a legacy id keeps its `user._anon.` prefix;
    // only the owning tenant moves. Idempotent: once rewritten, the branch
    // never matches again.
    let effective = record;
    if (record.tenantId === '_anon') {
      effective = { ...record, tenantId: 'default' };
      try {
        // ADR 0379 P1 — the ONE legitimate tenant move: expected tenant '_anon'
        // is passed explicitly; any other cross-tenant write no-ops at the predicate.
        if (await storage.updateUserAgent('_anon', effective)) migrated += 1;
      } catch (err) {
        // Keep boot resilient: register under the new tenant either way; the
        // durable rewrite retries on the next boot.
        log.warn('user_agent_anon_migration_failed', {
          agentId: record.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    registerUserAgent(effective);
  }
  if (migrated > 0) {
    log.info('user_agents_anon_tenant_migrated', { migrated });
  }
  if (records.length > 0) {
    log.info('user_agents_loaded', { count: records.length });
  }
  return records.length;
}

/** Durably persist a user-authored agent (insert-if-absent) AND register it
 *  with the in-process `AgentRegistry`, so it is both (a) visible to
 *  `GET /v1/agents` after a boot/rehydrate on any instance and (b) immediately
 *  live on THIS instance. Used by the demo seed (`exampleDataSeed.ts`) to make its
 *  named personas chat-callable through the same isolation-correct path the
 *  create-wizard uses — `ownerTenant` scopes them per-tenant. Idempotent:
 *  skips the durable insert when the record already exists, and the registry
 *  register is last-write-wins.
 *
 *  NOTE (multi-instance): the registry is boot-hydrated, not read-through —
 *  an instance that was already running before this insert won't carry the
 *  agent until it reboots/rehydrates (the same eventual-consistency property
 *  user-created agents already have). A redeploy or scale-up heals it. */
export async function ensureUserAgentRegistered(
  storage: Storage,
  record: UserAgentRecord,
): Promise<void> {
  const existing = await storage.getUserAgent(record.tenantId, record.agentId);
  if (!existing) {
    await storage.insertUserAgent(record);
  }
  registerUserAgent(record);
}

/** Read-through hydration: load ONE user-authored agent from durable storage
 *  into the in-process `AgentRegistry`, returning true if it existed. This is
 *  the miss-path for `getAgentRegistry().resolve()` — the registry is
 *  boot-hydrated (not refreshed per request), so an instance that booted before
 *  an agent was created/seeded won't carry it until it reboots. Wiring this into
 *  the agent-pack resolver (`agentPackResolver.ts`) makes every `.resolve()`
 *  caller (the chat-responder dispatch, the by-id inventory routes) read through
 *  to storage on a miss, closing the multi-instance eventual-consistency gap for
 *  chat-callable seeded personas. Idempotent: register is last-write-wins. */
export async function hydrateUserAgentIntoRegistry(storage: Storage, agentId: string, tenant?: string): Promise<boolean> {
  // ADR 0379 P2 — tenant-scoped whenever the resolve carried a tenant (all
  // user-agent paths do, post-Phase-1). The any-tenant read remains ONLY for
  // tenant-less resolves (pack-agent misses probing storage; a2a existence
  // checks) — still the ONE tripwire-pinned escape hatch, retired with the
  // old-scheme rows in Phase 3.
  const record = tenant !== undefined
    ? await storage.getUserAgent(tenant, agentId)
    : await storage.getUserAgentAnyTenant(agentId);
  if (!record) return false;
  registerUserAgent(record);
  return true;
}

/** Project a user-authored record into the registry's resolved-manifest
 *  shape. `systemPrompt` is inlined (RFC 0070 stores resolved bodies,
 *  not refs); `packName/packVersion` use the synthetic `user:<tenant>`
 *  prefix so projection in `GET /v1/agents` carries provenance.
 *
 *  `ownerTenant` is the linchpin of the cross-tenant isolation: the
 *  list route filters on it, and the chat-responder dispatch path
 *  rejects an `inputs.agentId` whose `ownerTenant` doesn't match the
 *  run's tenant. Pack-installed agents OMIT the field (tenant-agnostic). */
function registerUserAgent(record: UserAgentRecord): void {
  getAgentRegistry().register({
    agentId: record.agentId,
    persona: record.persona,
    modelClass: record.modelClass,
    systemPrompt: record.systemPrompt,
    ...(record.label !== undefined ? { label: record.label } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    toolAllowlist: record.toolAllowlist,
    memoryShape: record.memoryShape,
    ...(record.confidenceThreshold !== undefined
      ? { confidence: { defaultThreshold: record.confidenceThreshold } }
      : {}),
    packName: `user:${record.tenantId}`,
    packVersion: '0',
    ownerTenant: record.tenantId,
  });
}

interface ValidatedCreate {
  persona: string;
  label?: string;
  description?: string;
  modelClass: string;
  systemPrompt: string;
  toolAllowlist: string[];
  memoryShape: { scratchpad: boolean; conversation: boolean; longTerm: boolean };
  confidenceThreshold?: number;
}

function validateCreate(body: CreateBody): ValidatedCreate {
  if (!body || typeof body !== 'object') {
    throw new OpenwopError('validation_error', 'Request body MUST be an object.', 400);
  }
  if (typeof body.persona !== 'string' || body.persona.trim().length === 0) {
    throw new OpenwopError('validation_error', '`persona` is required and MUST be a non-empty string.', 400);
  }
  if (body.persona.length > PERSONA_MAX_LEN) {
    throw new OpenwopError('validation_error', `\`persona\` MUST be ≤ ${PERSONA_MAX_LEN} characters.`, 400);
  }
  if (typeof body.modelClass !== 'string' || !KNOWN_MODEL_CLASSES.has(body.modelClass)) {
    throw new OpenwopError(
      'validation_error',
      `\`modelClass\` MUST be one of [${[...KNOWN_MODEL_CLASSES].join(', ')}].`,
      400,
      { allowed: [...KNOWN_MODEL_CLASSES] },
    );
  }
  if (typeof body.systemPrompt !== 'string' || body.systemPrompt.trim().length === 0) {
    throw new OpenwopError('validation_error', '`systemPrompt` is required and MUST be a non-empty string.', 400);
  }
  if (body.systemPrompt.length > SYSTEM_PROMPT_MAX_LEN) {
    throw new OpenwopError(
      'validation_error',
      `\`systemPrompt\` MUST be ≤ ${SYSTEM_PROMPT_MAX_LEN} characters.`,
      400,
    );
  }
  const toolAllowlist = parseToolAllowlist(body.toolAllowlist);
  const memoryShape = parseMemoryShape(body.memoryShape);
  const confidenceThreshold = parseConfidenceThreshold(body.confidenceThreshold);
  const label = optionalString(body.label, 'label', LABEL_MAX_LEN);
  const description = optionalString(body.description, 'description', DESCRIPTION_MAX_LEN);
  return {
    persona: body.persona.trim(),
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
    modelClass: body.modelClass,
    systemPrompt: body.systemPrompt,
    toolAllowlist,
    memoryShape,
    ...(confidenceThreshold !== undefined ? { confidenceThreshold } : {}),
  };
}

interface ValidatedPatch {
  label?: string;
  description?: string;
  modelClass?: string;
  systemPrompt?: string;
  toolAllowlist?: string[];
  memoryShape?: { scratchpad: boolean; conversation: boolean; longTerm: boolean };
  confidenceThreshold?: number;
}

/** Validate a PATCH body: only the fields present are checked + returned.
 *  `persona` is immutable (it derives the agentId) — a present `persona` is
 *  rejected so the UI can't silently fail to rename. */
function validatePatch(body: CreateBody): ValidatedPatch {
  if (!body || typeof body !== 'object') {
    throw new OpenwopError('validation_error', 'Request body MUST be an object.', 400);
  }
  if ((body as { persona?: unknown }).persona !== undefined) {
    throw new OpenwopError(
      'validation_error',
      '`persona` is immutable — it identifies the agent. Create a new agent to use a different name.',
      400,
    );
  }
  const out: ValidatedPatch = {};
  if (body.modelClass !== undefined) {
    if (typeof body.modelClass !== 'string' || !KNOWN_MODEL_CLASSES.has(body.modelClass)) {
      throw new OpenwopError(
        'validation_error',
        `\`modelClass\` MUST be one of [${[...KNOWN_MODEL_CLASSES].join(', ')}].`,
        400,
        { allowed: [...KNOWN_MODEL_CLASSES] },
      );
    }
    out.modelClass = body.modelClass;
  }
  if (body.systemPrompt !== undefined) {
    if (typeof body.systemPrompt !== 'string' || body.systemPrompt.trim().length === 0) {
      throw new OpenwopError('validation_error', '`systemPrompt` MUST be a non-empty string.', 400);
    }
    if (body.systemPrompt.length > SYSTEM_PROMPT_MAX_LEN) {
      throw new OpenwopError('validation_error', `\`systemPrompt\` MUST be ≤ ${SYSTEM_PROMPT_MAX_LEN} characters.`, 400);
    }
    out.systemPrompt = body.systemPrompt;
  }
  if (body.toolAllowlist !== undefined) out.toolAllowlist = parseToolAllowlist(body.toolAllowlist);
  if (body.memoryShape !== undefined) out.memoryShape = parseMemoryShape(body.memoryShape);
  if (body.confidenceThreshold !== undefined) {
    out.confidenceThreshold = parseConfidenceThreshold(body.confidenceThreshold);
  }
  const label = optionalString(body.label, 'label', LABEL_MAX_LEN);
  if (label !== undefined) out.label = label;
  const description = optionalString(body.description, 'description', DESCRIPTION_MAX_LEN);
  if (description !== undefined) out.description = description;
  return out;
}

function parseToolAllowlist(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new OpenwopError('validation_error', '`toolAllowlist` MUST be an array of strings.', 400);
  }
  if (input.length > TOOL_ALLOWLIST_MAX_LEN) {
    throw new OpenwopError(
      'validation_error',
      `\`toolAllowlist\` MUST contain ≤ ${TOOL_ALLOWLIST_MAX_LEN} entries.`,
      400,
    );
  }
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new OpenwopError(
        'validation_error',
        '`toolAllowlist` entries MUST be non-empty strings.',
        400,
      );
    }
    out.push(item.trim());
  }
  return out;
}

function parseMemoryShape(input: unknown): { scratchpad: boolean; conversation: boolean; longTerm: boolean } {
  if (input === undefined || input === null) {
    return { scratchpad: false, conversation: false, longTerm: false };
  }
  if (typeof input !== 'object') {
    throw new OpenwopError('validation_error', '`memoryShape` MUST be an object.', 400);
  }
  const shape = input as Record<string, unknown>;
  return {
    scratchpad: shape.scratchpad === true,
    conversation: shape.conversation === true,
    longTerm: shape.longTerm === true,
  };
}

function parseConfidenceThreshold(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new OpenwopError('validation_error', '`confidenceThreshold` MUST be a number.', 400);
  }
  if (input < 0 || input > 1) {
    throw new OpenwopError(
      'validation_error',
      '`confidenceThreshold` MUST be between 0 and 1 (inclusive).',
      400,
    );
  }
  return input;
}

function optionalString(input: unknown, field: string, max: number): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'string') {
    throw new OpenwopError('validation_error', `\`${field}\` MUST be a string.`, 400);
  }
  if (input.length > max) {
    throw new OpenwopError('validation_error', `\`${field}\` MUST be ≤ ${max} characters.`, 400);
  }
  return input;
}

function readTenantId(req: { tenantId?: unknown }): string {
  const tid = req.tenantId;
  if (typeof tid === 'string' && tid.length > 0 && tid !== '*') {
    return tid;
  }
  // Bearer-authed demo callers reach this route with `req.tenantId ===
  // undefined` because the API-key allowlist path doesn't bind a tenant
  // (`tenants: ['*']` instead). Bucket them under the shared demo tenant so
  // POST /v1/host/openwop-app/agents and GET /v1/agents agree in bearer-shared
  // posture. Cookie-anon sessions get their own real `anon:<sid>`.
  return 'default';
}

function slugify(name: string): string {
  // Used only for the agentId synthesis — duplicates between
  // personas that slugify identically (e.g. "Code Reviewer" and
  // "code-reviewer") collide and the second create returns 409.
  // Cleaner than auto-appending `-2`, which would silently mask
  // the user's choice. Up to the FE to surface the conflict.
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length === 0) return `agent-${randomUUID().slice(0, 8)}`;
  return s;
}
