/**
 * UCP over MCP (ADR 0178 Phase 2) — the commerce UCP tools are registered on the inbound
 * MCP server (RFC 0020) and gated: listed/callable ONLY for a non-anonymous caller whose
 * tenant has `commerce-ucp` enabled (fail-closed). Verifies the ADR 0087 expose-tool
 * shape + the metadata gate, without the raw REST.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { listTools, isToolAllowed, findToolByName } from '../src/host/mcpServerRegistry.js';
import { createMember } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Principal } from '../src/types.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // createApp registers the backend features → their builtinWorkflows (the UCP MCP tools).
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

const enable = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
// ADR 0601 — `isToolAllowed` also enforces the scope the tool's RFC 0078
// descriptor advertises, so the "authed" principal must be a MEMBER holding it.
// Without this the toggle-off assertions below would pass for the wrong reason.
beforeAll(async () => {
  await createMember({ tenantId: 'org:ucp-mcp', orgId: 'org-ucp-mcp', subject: 'user-1', displayName: 'user-1', roles: ['editor'] });
});
const authed: Principal = { principalId: 'user-1', tenants: ['org:ucp-mcp'], token: '' };
const anon: Principal = { principalId: 'mcp-anonymous', tenants: ['*'], token: '' };

describe('UCP-over-MCP — registration + gating', () => {
  it('exposes the UCP tools with the expose-tool manifest', () => {
    const names = listTools().map((t) => t.name);
    expect(names).toContain('ucp-catalog-search');
    expect(names).toContain('ucp-place-order');
    const search = findToolByName('ucp-catalog-search');
    expect(search?.mcpFeatureToggle).toBe('commerce-ucp');
    expect(search?.mcpRequiresAuth).toBe(true);
    expect((search?.inputSchema as { required?: string[] }).required).toContain('orgId');
  });

  it('gates the tools: anonymous denied; authed+enabled allowed; authed+disabled denied', async () => {
    const search = findToolByName('ucp-catalog-search')!;
    const order = findToolByName('ucp-place-order')!;

    await enable('commerce-ucp', 'on');
    expect(await isToolAllowed(search, anon)).toBe(false);        // anonymous → fail-closed
    expect(await isToolAllowed(search, authed)).toBe(true);       // authed + UCP on
    expect(await isToolAllowed(order, authed)).toBe(true);

    await enable('commerce-ucp', 'off');
    expect(await isToolAllowed(search, authed)).toBe(false);      // UCP off → not exposed
    expect(await isToolAllowed(order, authed)).toBe(false);
  });
});
