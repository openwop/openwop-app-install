/**
 * Read-only pack catalog. Public — no auth required per
 * spec/v1/node-packs.md §"Registry HTTP API".
 *
 * Routes:
 *   GET /v1/packs                            — list installed packs
 *   GET /v1/packs/-/search?q=                — search (sample returns empty results)
 *   GET /v1/packs/{name}                     — pack metadata
 *   GET /v1/packs/{name}/-/{version}.json    — version manifest (or 404 / 400)
 *   GET /v1/packs/{name}/-/{version}.sig     — version signature (or 404)
 *
 * Sample only serves what's been registered in the in-process
 * NodeRegistry. No publish/yank/SBOM surface — that's the scope of
 * `examples/node-pack-publishing/` and the postgres reference host.
 */

import type { Express } from 'express';
import type { Storage } from '../storage/storage.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { OpenwopError } from '../types.js';

interface Deps {
  storage: Storage;
}

/** Reverse-DNS pack-name pattern from spec/v1/node-packs.md §Naming. */
const PACK_NAME_RE = /^(core|vendor|community|private|local|sample)\.[a-z][a-z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)+$/;
/** SemVer 2.0.0 — major.minor.patch with optional pre-release / build metadata. */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/** AgentManifest wire projection for the pack-registry surfaces, per
 *  `schemas/agent-manifest.schema.json` (required: agentId / persona /
 *  modelClass). Deliberately content-trimmed relative to the runtime
 *  `ResolvedAgentManifest`: pre-compiled validators + parsed schemas stay
 *  host-internal; the schema REFS round-trip so a re-install can resolve
 *  them per RFC 0003 §C/§D. */
function projectAgentManifest(a: ResolvedAgentManifest): Record<string, unknown> {
  return {
    agentId: a.agentId,
    persona: a.persona,
    modelClass: a.modelClass,
    systemPrompt: a.systemPrompt,
    ...(a.toolAllowlist !== undefined ? { toolAllowlist: a.toolAllowlist } : {}),
    ...(a.requiresCapabilities !== undefined ? { requiresCapabilities: a.requiresCapabilities } : {}),
    ...(a.memoryShape !== undefined ? { memoryShape: a.memoryShape } : {}),
    ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
    ...(a.handoff
      ? {
          handoff: {
            ...(a.handoff.taskSchemaRef !== undefined ? { taskSchemaRef: a.handoff.taskSchemaRef } : {}),
            ...(a.handoff.returnSchemaRef !== undefined ? { returnSchemaRef: a.handoff.returnSchemaRef } : {}),
          },
        }
      : {}),
    ...(a.label !== undefined ? { label: a.label } : {}),
    ...(a.description !== undefined ? { description: a.description } : {}),
  };
}

/** The pack-installed (tenant-agnostic) slice of the agent registry.
 *  User-authored agents (`ownerTenant` set) are tenant-owned IP and MUST
 *  NOT surface on the public pack-registry routes (agent-memory.md
 *  CTI-1 / agentRegistry.ts §ownerTenant). */
function listPackInstalledAgents(): readonly ResolvedAgentManifest[] {
  return getAgentRegistry().list().filter((a) => a.ownerTenant === undefined);
}

export function registerPackRoutes(app: Express, _deps: Deps): void {
  // ── search (more-specific routes registered first so they win over
  //     the wildcard `:name` route below) ──
  app.get('/v1/packs/-/search', (req, res) => {
    const q = String(req.query.q ?? '');
    const registry = getNodeRegistry();
    const matches = registry.listTypeIds().filter((id) => !q || id.includes(q));
    res.json({
      results: matches.map((typeId) => ({ typeId, version: 'in-process' })),
      total: matches.length,
      q,
    });
  });

  // ── version-scoped routes (.json + .sig). MUST be registered BEFORE
  //     the bare `/v1/packs/:name` route so Express doesn't bind
  //     `:name = "<pkname>"` and miss the `.json` suffix. ──
  app.get(/^\/v1\/packs\/([^/]+)\/-\/([^/]+)\.json$/, (req, _res, next) => {
    try {
      const params = req.params as Record<string, string>;
      const name = decodeURIComponent(params['0'] ?? '');
      const version = params['1'] ?? '';
      if (!PACK_NAME_RE.test(name)) {
        throw new OpenwopError(
          'invalid_pack_name',
          `Pack name "${name}" does not match the reverse-DNS pattern (scope.org.subname).`,
          400,
          { name },
        );
      }
      if (!SEMVER_RE.test(version)) {
        throw new OpenwopError(
          'invalid_version',
          `Version "${version}" is not a valid semver 2.0.0 string.`,
          400,
          { version },
        );
      }
      // Sample doesn't ship a real catalog — every (name, version) lookup misses.
      throw new OpenwopError(
        'pack_not_found',
        `Pack ${name}@${version} not found in this registry.`,
        404,
        { name, version },
      );
    } catch (err) {
      next(err);
    }
  });

  app.get(/^\/v1\/packs\/([^/]+)\/-\/([^/]+)\.sig$/, (req, _res, next) => {
    try {
      const params = req.params as Record<string, string>;
      const name = decodeURIComponent(params['0'] ?? '');
      const version = params['1'] ?? '';
      if (!PACK_NAME_RE.test(name)) {
        throw new OpenwopError('invalid_pack_name', `Pack name "${name}" malformed.`, 400, { name });
      }
      if (!SEMVER_RE.test(version)) {
        throw new OpenwopError('invalid_version', `Version "${version}" not semver.`, 400, { version });
      }
      // Per spec: nonexistent / yanked / unsigned / storage-unwired all
      // collapse to the same canonical 404.
      throw new OpenwopError(
        'signature_not_available',
        `Signature for ${name}@${version} not available.`,
        404,
        { name, version },
      );
    } catch (err) {
      next(err);
    }
  });

  // ── agent-manifest export ──
  // RFC 0003 round-trip surface: project the installed (tenant-agnostic)
  // agent registry into the canonical AgentManifest shape so a manifest
  // set exported here re-installs cleanly elsewhere. `sourceManifestId`
  // carries install provenance per `agent-ref.schema.json` — for a
  // pack-installed agent the export originated from its own manifest id.
  // Registered BEFORE the `/v1/packs/:name` wildcard so "export" is never
  // parsed as a (malformed) pack name.
  app.get('/v1/packs/export', (_req, res) => {
    const manifests = listPackInstalledAgents().map((a) => ({
      ...projectAgentManifest(a),
      sourceManifestId: a.agentId,
      packName: a.packName,
      packVersion: a.packVersion,
    }));
    res.json({ manifests, total: manifests.length });
  });

  // ── catalog list (root) ──
  app.get('/v1/packs', (_req, res) => {
    const registry = getNodeRegistry();
    const typeIds = registry.listTypeIds();
    const packs = new Map<
      string,
      { name: string; version?: string; nodes: string[]; agents?: Array<Record<string, unknown>> }
    >();
    for (const typeId of typeIds) {
      const segments = typeId.split('.');
      const packName = segments.slice(0, -1).join('.') || typeId;
      const existing = packs.get(packName) ?? { name: packName, nodes: [] };
      existing.nodes.push(typeId);
      packs.set(packName, existing);
    }
    // RFC 0003: a pack's `agents[]` entries surface as AgentManifest rows
    // on the registry listing (keyed by the pack they were installed
    // from). Agent-only packs (nodes: []) appear here too — without this
    // they'd be invisible on the catalog despite being dispatchable. The
    // installed manifest carries the pack's pinned version, so the entry
    // gains `version` (the agentPackCatalog scenarios assert it; the
    // node-only grouping above has no version source — in-process node
    // registrations are versioned per-node, not per-pack).
    for (const agent of listPackInstalledAgents()) {
      const existing = packs.get(agent.packName) ?? { name: agent.packName, nodes: [] };
      if (existing.version === undefined) existing.version = agent.packVersion;
      const agents = existing.agents ?? [];
      agents.push(projectAgentManifest(agent));
      existing.agents = agents;
      packs.set(agent.packName, existing);
    }
    res.json({
      packs: Array.from(packs.values()),
      total: packs.size,
    });
  });

  // ── pack-name lookup. Registered LAST so the more-specific routes above
  //     get first crack at matching. ──
  app.get('/v1/packs/:name', (req, res, next) => {
    try {
      const name = req.params.name;
      // The `-` token is reserved for sub-routes (e.g., /v1/packs/-/search)
      // — we shouldn't get here for that, but reject defensively.
      if (name === '-') {
        throw new OpenwopError('invalid_pack_name', 'Reserved name token.', 400, { name });
      }
      if (!PACK_NAME_RE.test(name)) {
        throw new OpenwopError(
          'invalid_pack_name',
          `Pack name "${name}" does not match the reverse-DNS pattern.`,
          400,
          { name },
        );
      }
      const registry = getNodeRegistry();
      const matches = registry.listTypeIds().filter((id) => id.startsWith(name + '.') || id === name);
      if (matches.length === 0) {
        throw new OpenwopError(
          'pack_not_found',
          `Pack "${name}" not found in this registry.`,
          404,
          { name },
        );
      }
      res.json({ name, nodes: matches });
    } catch (err) {
      next(err);
    }
  });
}
