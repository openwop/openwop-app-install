/**
 * Portable tool catalog — `GET /v1/tools` + `GET /v1/tools/{toolId}` (RFC 0078 §B).
 *
 * A read-only, authorization-scoped projection of the host's MCP-exposed tools as
 * normative `ToolDescriptor` records (`tool-descriptor.schema.json`). This is the
 * net-new wire-adjacent surface ADR 0087 P3 calls for — the *implementation* of an
 * already-Accepted RFC, not a new one. Advertised via `capabilities.toolCatalog`
 * (sources: ['mcp']); a host that omits the advertisement serves no catalog and the
 * conformance scenarios skip cleanly.
 *
 * Scope of this projection: the `mcp` source only (the surface this ADR delivers).
 * Other RFC 0078 sources (node-pack / workflow / connector / host-extension) are not
 * yet projected — `capabilities.toolCatalog.sources` advertises exactly `['mcp']`,
 * so the advertisement stays honest.
 *
 * Authorization: same gate as `tools/list` (mcpServerRegistry.listToolsForPrincipal)
 * — a tool the principal can't invoke (anonymous, or `notebooks` toggle off) MUST
 * NOT appear, and `GET /v1/tools/{toolId}` 404s an unknown OR unauthorized id (the
 * RFC 0074 non-disclosure pattern). Unauthenticated ⇒ 401.
 *
 * @see docs/adr/0087-notebooks-as-mcp-tools.md
 * @see ../openwop/spec/v1/tool-catalog.md §B
 */

import type { Express } from 'express';
import type { Storage } from '../storage/storage.js';
import { OpenwopError } from '../types.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import { isToolAllowed, listToolsForPrincipal, type ExposedToolManifest } from '../host/mcpServerRegistry.js';
import { toCompactDescriptor, type FullToolDescriptor } from '../host/compactToolDescriptor.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.toolCatalog');

interface Deps {
  storage: Storage;
}

/** Project an MCP tool manifest → a normative RFC 0078 ToolDescriptor. The notebook
 *  tools need a brokered credential, do no egress, and are replay-idempotent; the
 *  data-effect tier + approval posture come from the workflow metadata (read tools:
 *  `read`/`never`; the HITL write tools: `write`/`always` + the `workspace:write`
 *  scope). Content-free per SR-1 (no credential material). */
function toDescriptor(m: ExposedToolManifest): Record<string, unknown> {
  const safetyTier = m.mcpSafetyTier === 'write' ? 'write' : 'read';
  const d: Record<string, unknown> = {
    toolId: `mcp:${m.name}`,
    source: 'mcp',
    title: m.name,
    safetyTier,
    auth: { scopes: [safetyTier === 'write' ? 'workspace:write' : 'workspace:read'], credentialRef: true },
    egress: 'none',
    approval: m.mcpApproval === 'always' ? 'always' : m.mcpApproval === 'conditional' ? 'conditional' : 'never',
    replayPolicy: 'idempotent',
    inputSchema: m.inputSchema,
  };
  if (m.description !== undefined) d.description = m.description;
  return d;
}

/** The catalog projects the `mcp` source, so it is honestly served ONLY when the
 *  MCP server is mounted (same env switch). When off, `capabilities.toolCatalog` is
 *  NOT advertised and these endpoints 404 ("host does not advertise the catalog",
 *  openapi.yaml §/v1/tools 404). Kept in lockstep with discovery.ts. */
function catalogEnabled(): boolean {
  return process.env.OPENWOP_MCP_SERVER_ENABLED === 'true';
}

/** RFC 0112 — true when the request asks for the compact projection. */
function wantsCompact(req: { query: Record<string, unknown> }): boolean {
  return req.query.view === 'compact';
}

export function registerToolCatalogRoutes(app: Express, _deps: Deps): void {
  // GET /v1/tools — the catalog the authenticated principal may see (authorization-
  // scoped). Optional ?source=<source> filter.
  app.get('/v1/tools', async (req, res, next) => {
    try {
      if (!catalogEnabled()) throw new OpenwopError('not_found', 'Tool catalog not advertised.', 404, {});
      const principal = req.principal;
      if (!principal) throw new OpenwopError('unauthenticated', 'Bearer token required', 401);
      await requireProtocolScope(req, 'runs:read');
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      if (source !== undefined && source !== 'mcp') {
        // This host projects only the `mcp` source; any other filter ⇒ empty.
        res.json([]);
        return;
      }
      const manifests = await listToolsForPrincipal(principal);
      // RFC 0112 — compact projection over the SAME authorization-scoped set, so
      // the compact toolId set == the standard view's by construction (RFC 0074).
      // Enveloped `{ tools: CompactToolDescriptor[] }` (vs the standard bare array).
      if (wantsCompact(req)) {
        res.json({
          tools: manifests.map((m) => toCompactDescriptor(toDescriptor(m) as unknown as FullToolDescriptor)),
        });
        return;
      }
      // RFC 0078 §B / openapi.yaml — the body is a BARE `ToolDescriptor[]`.
      res.json(manifests.map(toDescriptor));
    } catch (err) { next(err); }
  });

  // GET /v1/tools/{toolId} — one descriptor, or 404 for unknown OR unauthorized
  // (non-disclosing). toolId form is `mcp:<tool-name>`.
  app.get('/v1/tools/:toolId', async (req, res, next) => {
    try {
      if (!catalogEnabled()) throw new OpenwopError('not_found', 'Tool catalog not advertised.', 404, {});
      const principal = req.principal;
      if (!principal) throw new OpenwopError('unauthenticated', 'Bearer token required', 401);
      await requireProtocolScope(req, 'runs:read');
      const toolId = req.params.toolId;
      // Resolve against the principal's AUTHORIZED set so an unauthorized id is
      // indistinguishable from an unknown one (RFC 0074 non-disclosure).
      const manifests = await listToolsForPrincipal(principal);
      const match = manifests.find((m) => `mcp:${m.name}` === toolId);
      if (!match || !(await isToolAllowed(match, principal))) {
        throw new OpenwopError('not_found', 'Tool not found.', 404, { toolId });
      }
      // RFC 0112 — single compact descriptor (bare, not enveloped). Same authz
      // path as the standard view, so an unauthorized id is still a 404.
      if (wantsCompact(req)) {
        res.json(toCompactDescriptor(toDescriptor(match) as unknown as FullToolDescriptor));
        return;
      }
      // RFC 0078 §B / openapi.yaml — the body is a BARE `ToolDescriptor`.
      res.json(toDescriptor(match));
    } catch (err) { next(err); }
  });

  log.info('tool-catalog routes registered (GET /v1/tools, GET /v1/tools/:toolId — RFC 0078 §B, mcp source)');
}
