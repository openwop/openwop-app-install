/**
 * ADR 0601 — the MCP tool lane ENFORCES the RBAC scope its descriptor ADVERTISES
 * (NBC-3).
 *
 * `routes/toolCatalog.ts` serves every MCP tool as an RFC 0078 `ToolDescriptor`
 * carrying `auth.scopes: ['workspace:write']` for a `safetyTier:'write'` tool.
 * Before ADR 0601 `isToolAllowed` checked exactly two things — non-anonymous
 * principal, and the feature toggle — so a `workspace:read` member 403'd by every
 * HTTP sibling (`requireNotebook(req,'workspace:write')`) could point an MCP client
 * at the same host and write. The descriptor was a claim the host did not honour.
 *
 * MEASUREMENT that motivated the host-level fix site (the assessment's
 * `grep -rn "mcpSafetyTier: 'write'"` found ONE feature; it greps a SPELLING, and
 * two features set the field from a variable — `mcpSafetyTier: spec.safetyTier`):
 *   notebooks   — notebook-add-source, notebook-create-note
 *   commerce    — ucp-place-order
 *   app-builder — app-builder-create-project, app-builder-render-design,
 *                 app-builder-resolve-paused-task
 * SIX write tools across THREE features. `assertsEveryWriteToolIsGated` below is
 * the ratchet: it derives the population from the LIVE registry, so a seventh
 * write tool cannot be added without this file having an opinion about it.
 *
 * @see docs/adr/0601-notebooks-trust-boundary-and-mcp-authz.md
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { listTools, isToolAllowed, requiredScopeForTool } from '../src/host/mcpServerRegistry.js';
import { toDescriptor } from '../src/routes/toolCatalog.js';
import { createMember } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Principal } from '../src/types.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';

const T = 'tenant-scope-gate';

/** Bob: a `workspace:read` member. The HTTP notebooks write routes 403 him. */
const reader: Principal = { principalId: 'bob-reader', tenants: [T], token: '' };
/** Alice: a `workspace:write` member. The HTTP routes let her write. */
const writer: Principal = { principalId: 'alice-writer', tenants: [T], token: '' };
/** Mallory: authenticated, tenant-resolvable, but a member of NOTHING. */
const stranger: Principal = { principalId: 'mallory-nobody', tenants: [T], token: '' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // Demo mode grants an unknown subject OWNER scope (accessControlService's
  // documented single-principal-sandbox exception). It must be OFF or `stranger`
  // would resolve to owner and the fail-closed case would pass vacuously.
  delete process.env.OPENWOP_DEMO_MODE;
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['notebooks', 'kb', 'users', 'commerce-ucp', 'app-builder', 'docs']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  await createMember({ tenantId: T, orgId: 'org-scope-gate', subject: reader.principalId, displayName: 'Bob', roles: ['viewer'] });
  await createMember({ tenantId: T, orgId: 'org-scope-gate', subject: writer.principalId, displayName: 'Alice', roles: ['editor'] });
});

// An UNGATED tool — no `mcpRequiresAuth`, no `mcpFeatureToggle` — i.e. the shape
// the conformance sample tools take. Registered here on purpose: without one in
// the registry, the `requiredScopeForTool` → `null` branch is NEVER exercised,
// and the parity assertions below would agree with a catalog that re-derived its
// own scope. (That is not hypothetical — a first draft of this file was GREEN
// under exactly that sabotage. See ADR 0601 § Witnesses.)
registerWorkflow({
  workflowId: 'test.adr0601.ungated-tool',
  nodes: [{ nodeId: 'expose', typeId: 'core.openwop.mcp.expose-tool', config: { name: 'adr0601-ungated-sample', description: 'An ungated sample tool.', inputSchema: { type: 'object', additionalProperties: true } } }],
  edges: [],
} as never);

const tool = (name: string) => {
  const t = listTools().find((x) => x.name === name);
  expect(t, `tool ${name} is not registered — the assertion below would be vacuous`).toBeTruthy();
  return t!;
};

describe('ADR 0601 / NBC-3 — a write tool enforces the scope it advertises', () => {
  it('the named escalation: a workspace:read member CANNOT call notebook-add-source or notebook-create-note', async () => {
    for (const name of ['notebook-add-source', 'notebook-create-note']) {
      expect(requiredScopeForTool(tool(name)), name).toBe('workspace:write');
      expect(await isToolAllowed(tool(name), reader), name).toBe(false);
    }
  });

  it('CONTROL — the same reader CAN still call the READ tools (the gate is not a blanket denial)', async () => {
    for (const name of ['notebook-search', 'notebook-list', 'notebook-ask']) {
      expect(requiredScopeForTool(tool(name)), name).toBe('workspace:read');
      expect(await isToolAllowed(tool(name), reader), name).toBe(true);
    }
  });

  it('CONTROL — a workspace:write member CAN call the write tools (the gate has an exit)', async () => {
    for (const name of ['notebook-add-source', 'notebook-create-note', 'notebook-search']) {
      expect(await isToolAllowed(tool(name), writer), name).toBe(true);
    }
  });

  it('a principal who is a member of NOTHING is denied every gated tool, read and write', async () => {
    for (const name of ['notebook-search', 'notebook-add-source']) {
      expect(await isToolAllowed(tool(name), stranger), name).toBe(false);
    }
  });

  it('CROSS-FEATURE — the fix is host-level, so commerce + app-builder write tools are gated too', async () => {
    for (const name of ['ucp-place-order', 'app-builder-render-design', 'app-builder-resolve-paused-task']) {
      expect(requiredScopeForTool(tool(name)), name).toBe('workspace:write');
      expect(await isToolAllowed(tool(name), reader), name).toBe(false);
      expect(await isToolAllowed(tool(name), writer), name).toBe(true);
    }
  });

  it('RATCHET — EVERY registered write tool requires workspace:write and denies a reader', async () => {
    const writeTools = listTools().filter((t) => t.mcpSafetyTier === 'write');
    // A floor is not a guard: assert the measured population so an empty registry
    // (which would make the loop below iterate zero times) fails loudly instead of
    // reporting green. Six as of ADR 0601; a NEW write tool must land with a
    // deliberate bump here, not silently.
    expect(writeTools.map((t) => t.name).sort()).toEqual([
      'app-builder-create-project',
      'app-builder-render-design',
      'app-builder-resolve-paused-task',
      'notebook-add-source',
      'notebook-create-note',
      'ucp-place-order',
    ]);
    for (const t of writeTools) {
      expect(requiredScopeForTool(t), t.name).toBe('workspace:write');
      expect(await isToolAllowed(t, reader), t.name).toBe(false);
    }
  });

  it('an UNGATED tool claims NO scope and is open — the null branch is real, not decorative', async () => {
    const sample = tool('adr0601-ungated-sample');
    expect(sample.mcpRequiresAuth).toBeUndefined();
    expect(sample.mcpFeatureToggle).toBeUndefined();
    // No claim…
    expect(requiredScopeForTool(sample)).toBeNull();
    // …and correspondingly no check: it stays reachable for a member of nothing,
    // preserving the pre-existing conformance-sample behaviour.
    expect(await isToolAllowed(sample, stranger)).toBe(true);
  });

  it('ADVERT ≡ ENFORCEMENT — the scope each SERVED descriptor claims predicts what the gate does', async () => {
    // REWRITTEN (ADR 0601 § Corrections / MEDIUM-7). This test used to compare
    // `requiredScopeForTool(t)` against `Boolean(t.mcpRequiresAuth || …)` — i.e.
    // it restated that function's own first line, never touched the advert, and
    // could not fail. MEASURED: sabotage H (`toDescriptor` re-derives its own
    // scope, the exact drift the name promises to catch) reddened the real
    // witness in `notebooks-mcp.test.ts` and left this one GREEN through 20
    // consecutive passes.
    //
    // It now reads the ADVERT — `toolCatalog.toDescriptor`, the function the
    // route serializes — and asserts a BEHAVIOURAL consequence of it, never
    // touching `requiredScopeForTool` at all. The property: whatever a
    // descriptor claims, the gate honours, and whatever it claims nothing for,
    // the gate lets through. Drift in either direction is red.
    const seen = { claimed: 0, unclaimed: 0 };
    for (const t of listTools()) {
      const advertised = (toDescriptor(t).auth as { scopes: string[] }).scopes;
      if (advertised.length === 0) {
        // Claims nothing ⇒ must be reachable by a principal holding nothing.
        expect(await isToolAllowed(t, stranger), `${t.name} advertises no scope`).toBe(true);
        seen.unclaimed++;
      } else {
        // Claims a scope ⇒ a principal holding exactly that scope gets in, and a
        // principal holding none is refused. The advert is a true statement.
        const holder = advertised.includes('workspace:write') ? writer : reader;
        expect(await isToolAllowed(t, holder), `${t.name} claims ${advertised.join(',')}`).toBe(true);
        expect(await isToolAllowed(t, stranger), `${t.name} vs a member of nothing`).toBe(false);
        seen.claimed++;
      }
    }
    // Both branches must actually have been walked, or the loop proves half a
    // property. (The `unclaimed` count is why the ungated sample tool above is
    // registered — sabotage H's first green was exactly this branch being empty.)
    expect(seen.claimed, 'tools advertising a scope').toBeGreaterThanOrEqual(19);
    expect(seen.unclaimed, 'tools advertising none').toBeGreaterThanOrEqual(1);
  });
});
