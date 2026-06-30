/**
 * Host-extension workflow-registration routes used by the in-app
 * builder UI. Vendor-prefixed under `/v1/host/openwop-app/*` per
 * `spec/v1/host-extensions.md` §"Canonical prefixes" — these are NOT
 * part of the v1 wire contract.
 *
 *   POST   /v1/host/openwop-app/workflows           — register / overwrite
 *   GET    /v1/host/openwop-app/workflows           — list registered
 *   DELETE /v1/host/openwop-app/workflows/:workflowId
 *
 * The workflowCatalog (`src/host/index.ts`) consults the in-memory
 * registry after its hardcoded samples, so a registered workflow is
 * immediately resolvable by `POST /v1/runs`.
 *
 * The definition validator + RFC 0022 §C capability gate live in
 * `host/workflowDefinitionValidation.ts` — the SINGLE validation path
 * shared with the AI workflow-author feature (ADR 0072).
 */

import type { Express } from 'express';
import { OpenwopError, type OpenwopErrorCode } from '../types.js';
import {
  deleteRegisteredWorkflow,
  registerWorkflow,
} from '../host/workflowsRegistry.js';
import { validateWorkflowDefinition, WORKFLOW_ID_PATTERN } from '../host/workflowDefinitionValidation.js';
import type { HostAdapterSuite } from '../host/index.js';
import { tenantOf } from '../host/requestSubject.js';
import { recordOwnership, listOwned, getOwned, removeOwnership } from '../host/workflowOwnership.js';
import { getChain, listChains, expandChain, reloadWorkflowChainPacks } from '../host/workflowChainPackLoader.js';
import { buildNodeCatalog } from '../host/nodeCatalogBuilder.js';
import { installPackFromRegistry, resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { requireSuperadmin } from '../host/superadmin.js';
import { randomUUID } from 'node:crypto';

/** Map a thrown install error to a canonical {@link OpenwopErrorCode} + status.
 *  The installer throws bare Errors with a stable `<reason> (...)` prefix;
 *  classify the operator-facing ones (not-found / verification) vs an
 *  upstream-registry failure. Reuses existing codes (no new wire code). */
function installErrorStatus(message: string): { code: OpenwopErrorCode; status: number } {
  if (/manifest_fetch_failed \(404|pack_not_found|tarball_fetch_failed \(404/.test(message)) {
    return { code: 'not_found', status: 404 };
  }
  if (/integrity_mismatch|signature_invalid|signature_unverifiable|manifest_identity_mismatch/.test(message)) {
    return { code: 'validation_error', status: 422 }; // pack failed Ed25519/SRI verification
  }
  return { code: 'internal_error', status: 502 }; // upstream registry / network
}

export function registerWorkflowRoutes(app: Express, deps: { hostSuite: HostAdapterSuite }): void {
  // Tenant-scoped list (ADR 0163 R1): returns only the caller's tenant's owned
  // workflows (list metadata), via the ownership index — NOT the global registry
  // (which would leak every tenant's workflows). The global by-id resolver stays
  // `GET /v1/workflows/{id}` below.
  app.get('/v1/host/openwop-app/workflows', async (req, res, next) => {
    try {
      const owned = await listOwned(tenantOf(req));
      res.json({
        workflows: owned.map((o) => ({
          workflowId: o.workflowId,
          name: o.name ?? o.workflowId,
          nodeCount: o.nodeCount,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt ?? o.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // Spec endpoint: GET /v1/workflows/{workflowId} per
  // `api/openapi.yaml operationId=getWorkflow`. Returns the workflow
  // definition (including `id` and `nodes`) for any advertised
  // workflowId — both runtime-registered workflows (via POST
  // /v1/host/openwop-app/workflows) and conformance fixtures auto-loaded
  // from `conformance/fixtures/`. 404 on unknown ids per `rest-
  // endpoints.md §"Error envelope"`.
  app.get('/v1/workflows/:workflowId', async (req, res, next) => {
    try {
      const wf = await deps.hostSuite.workflowCatalog.getWorkflow(req.params.workflowId);
      if (!wf) {
        throw new OpenwopError(
          'workflow_not_found',
          'workflow not found',
          404,
          { workflowId: req.params.workflowId },
        );
      }
      res.json(wf.definition);
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/workflows', async (req, res, next) => {
    try {
      const def = validateWorkflowDefinition(req.body);
      registerWorkflow(def);
      // ADR 0163 R3: record tenant ownership so the scoped list reflects it.
      const name = typeof def.metadata?.name === 'string' ? def.metadata.name : undefined;
      await recordOwnership(tenantOf(req), def.workflowId, { name, nodeCount: def.nodes.length });
      res.status(201).json({ workflowId: def.workflowId, nodeCount: def.nodes.length });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/workflows/:workflowId', async (req, res, next) => {
    try {
      const id = req.params.workflowId;
      if (!WORKFLOW_ID_PATTERN.test(id)) {
        throw new OpenwopError('validation_error', 'Invalid workflowId.', 400, { workflowId: id });
      }
      // ADR 0163 R2 (IDOR guard): only the owning tenant may delete; a foreign or
      // unknown id is an indistinguishable 404 (no existence leak).
      const owned = await getOwned(tenantOf(req), id);
      if (!owned) {
        throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: id });
      }
      const removed = deleteRegisteredWorkflow(id);
      await removeOwnership(tenantOf(req), id);
      res.json({ workflowId: id, removed });
    } catch (err) {
      next(err);
    }
  });

  // ── ADR 0163 Phase 2 — workflow-chain pack templates ("Use template") ──

  // Discovery: the installed workflow-chain packs (RFC 0013), host-global like the
  // node-catalog (authed, but not tenant data). Feeds the builder template gallery.
  app.get('/v1/host/openwop-app/workflow-chains', (_req, res, next) => {
    try {
      const chains = listChains().map(({ packName, chain }) => ({
        chainId: chain.chainId,
        packName,
        label: chain.label,
        description: chain.description,
        parameters: chain.parameters,
        ...(chain.capabilities ? { capabilities: chain.capabilities } : {}),
        ...(chain.outputs ? { outputs: chain.outputs } : {}),
      }));
      res.json({ chains });
    } catch (err) {
      next(err instanceof OpenwopError ? err : new OpenwopError('internal_error', String(err), 500));
    }
  });

  // Instantiate a chain as a REAL, owned, editable workflow ("Use template").
  // Expands (RFC 0013, ADR 0152) → mints a FRESH unique workflowId per instance
  // (R2; not the deterministic chainId:expansionId) → registers + records tenant
  // ownership. Unresolved node typeIds are returned as `warnings` (install/connect
  // prompts) — NOT a hard failure (ADR 0163 R6: invitation, not breakage).
  app.post('/v1/host/openwop-app/workflows/from-chain', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { chainId?: unknown; params?: unknown };
      if (typeof body.chainId !== 'string') {
        throw new OpenwopError('validation_error', 'chainId is required.', 400, {});
      }
      const found = getChain(body.chainId);
      if (!found) {
        throw new OpenwopError('not_found', 'workflow chain not found', 404, { chainId: body.chainId });
      }
      const params = (body.params ?? {}) as Record<string, unknown>;
      // expandChain throws chain_parameter_invalid (400) on a bad/missing param.
      const expanded = expandChain(found.chain, { params });
      // R2 — a fresh owned instance id (the published chain id is not the instance id).
      const slug = found.chain.chainId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const workflowId = `wf.${slug}.${randomUUID().slice(0, 8)}`;
      const def = { ...expanded, workflowId };
      registerWorkflow(def);
      const name = typeof def.metadata?.name === 'string' ? def.metadata.name : found.chain.label;
      await recordOwnership(tenantOf(req), workflowId, { name, nodeCount: def.nodes.length });
      // R6 — surface node types not installed on this host (best-effort heads-up).
      const known = new Set(buildNodeCatalog().map((n) => n.typeId));
      const warnings = [...new Set(def.nodes.map((n) => n.typeId).filter((t) => !known.has(t)))];
      res.status(201).json({ workflowId, nodeCount: def.nodes.length, ...(warnings.length ? { warnings } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // Install a workflow-chain pack from the registry (packs.openwop.dev) AT RUNTIME
  // — the in-app marketplace (ADR 0163 follow-on). Reuses the same Ed25519 + SHA-256
  // SRI-verified installer the boot path uses (ADR 0163 Phase 7), then HOT-RELOADS
  // the chain registry so the pack's chains appear as templates with no restart.
  //
  // Superadmin-gated: installing a pack mutates GLOBAL host state (the shared chain
  // registry across all tenants), so it is an operator action — the same gate as
  // feature-toggle/governance administration, NOT a per-tenant write. Scoped to
  // `kind:"workflow-chain"` packs (the loader kind-filters; node/agent runtime
  // install needs a catalog rebuild and stays deferred).
  app.post('/v1/host/openwop-app/workflow-chain-packs/install', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Installing workflow packs');
      const body = (req.body ?? {}) as { name?: unknown; version?: unknown };
      if (typeof body.name !== 'string' || typeof body.version !== 'string') {
        throw new OpenwopError('validation_error', 'name and version are required.', 400, {});
      }
      const before = new Set(listChains().map((c) => c.chain.chainId));
      let result: { installed: boolean; reason?: string };
      try {
        result = await installPackFromRegistry(
          { name: body.name, version: body.version },
          { packDir: resolveDefaultPackDir() },
        );
      } catch (e) {
        const { code, status } = installErrorStatus(String(e instanceof Error ? e.message : e));
        throw new OpenwopError(code, String(e instanceof Error ? e.message : e), status, { name: body.name, version: body.version });
      }
      // Hot-reload so a just-installed (or already-present) chain pack is listable
      // without restart; report the chainIds this install made newly available.
      const { errors } = reloadWorkflowChainPacks();
      const newChains = listChains().map((c) => c.chain.chainId).filter((id) => !before.has(id));
      res.status(result.installed ? 201 : 200).json({
        installed: result.installed,
        ...(result.reason ? { reason: result.reason } : {}),
        newChains,
        ...(errors.length ? { loadWarnings: errors } : {}),
      });
    } catch (err) {
      next(err);
    }
  });
}
