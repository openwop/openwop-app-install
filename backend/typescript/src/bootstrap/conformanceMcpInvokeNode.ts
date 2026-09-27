/**
 * `core.conformance.mcp-invoke` — the reference host's MCP invoke bridge for the
 * `conformance-mcp-tool-roundtrip` fixture (H21; `mcp-integration.md`
 * §"Trust boundary", RFC 0153, ADR 0553).
 *
 * ── Why this node exists ────────────────────────────────────────────────────
 *
 * The fixture declares ONE node, spelled `core.conformance.mcp-invoke` — a
 * conformance-RESERVED typeId — carrying `config.mcp = { tool, arguments }` and
 * NO serverId: "a host-configured MCP server; the conformance suite stands up a
 * synthetic MCP server at startup; operators configure the host to use that
 * server". The corpus states the rule with the id (`node-packs.md`,
 * `fixtures.md`, `mcp-integration.md` §Conformance): a host that consumes MCP
 * MUST map it to its own MCP invoke bridge and honour `config.mcp`; a host that
 * does not MUST NOT advertise the fixture. This node is that mapping.
 *
 * No operator config path existed for an outbound MCP server, so a call with no
 * serverId had nowhere to go — closed by `host/mcpOperatorServer.ts` (H21).
 *
 * ── History: the loader rewrite that used to sit in front of this ───────────
 *
 * Until suite 1.136.0 the fixture spelled its node `core.ai.callPrompt`, which
 * on THIS host is the `vendor.myndhyve.ai` pack's prompt-library node
 * (`packs/vendor.myndhyve.ai/index.mjs`): it requires `config.promptId`, never
 * reads `config.mcp`, and failed `prompt_not_found` on this fixture. Hijacking
 * that typeId globally would have broken a real node for every workflow using
 * it, so the fixture LOADER (`host/index.ts`) rewrote that ONE node onto the id
 * below, under this file's own `config.mcp` predicate. openwop#1060 (suite
 * 1.136.0, S33) renamed the fixture's node to the reserved id, which is exactly
 * the exit condition that rewrite was written against; the pin is now `^1.136.0`,
 * the fixture is re-vendored, and the rewrite is DELETED (H47). This node is
 * unaffected by that deletion — it is what the renamed fixture resolves to
 * directly.
 *
 * ── What it does (a bridge, never a stub) ───────────────────────────────────
 *
 * `ctx.mcp.invokeTool(...)` — the SAME client every other outbound MCP caller
 * uses, so the run genuinely exercises provider resolution, the ADR 0028
 * governance gate, the operator credential, the RFC 0093 egress dispatcher, the
 * `connectionUse[]` stamp and the ADR 0027 `untrustedContent` marking. A stub
 * returning a canned `{ content: [...] }` would satisfy the scenario's event-log
 * assertion while proving nothing about the trust boundary it measures.
 *
 * The result is returned with the untrusted marker INTACT in the node outputs,
 * which is what puts it in the run's event log where the scenario looks for it.
 * It is never merged into trusted state and never advances an approval gate
 * (`prompt-injection-mcp-no-approval`): this node has no gate to advance.
 *
 * ── Server address ──────────────────────────────────────────────────────────
 *
 * `config.serverId` when the fixture names one, else the operator-configured
 * server (`OPENWOP_MCP_SERVER_URL` → `operatorMcpServerId()`). With neither, the
 * node fails TYPED rather than succeeding empty — a run that "passed" without
 * reaching a server is the failure mode this item exists to remove.
 *
 * Gated behind `conformanceNodesEnabled()` — never registered on a real deploy.
 */

import type { NodeModule, NodeContext, NodeOutcome } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { operatorMcpServerId } from '../host/mcpOperatorServer.js';
import { conformanceNodesEnabled } from './conformanceMockAgent.js';

/** The conformance-reserved typeId this host maps the roundtrip fixture onto. */
export const CONFORMANCE_MCP_INVOKE_TYPE_ID = 'core.conformance.mcp-invoke';

/** `config.mcp` as the fixture spells it. */
interface McpNodeConfig {
  readonly serverId?: unknown;
  readonly mcp?: { readonly tool?: unknown; readonly arguments?: unknown };
}

async function invokeMcpTool(ctx: NodeContext): Promise<NodeOutcome> {
  const config = ctx.config as McpNodeConfig | undefined;
  const tool = typeof config?.mcp?.tool === 'string' ? config.mcp.tool : null;
  if (!tool) {
    return {
      status: 'failure',
      error: { code: 'mcp_tool_not_configured', message: 'node config.mcp.tool is required' },
    };
  }
  const serverId = typeof config?.serverId === 'string' && config.serverId.length > 0
    ? config.serverId
    : operatorMcpServerId();
  if (!serverId) {
    // TYPED, never success-with-empty: the scenario would otherwise record a
    // roundtrip that never left this host.
    return {
      status: 'failure',
      error: {
        code: 'mcp_server_not_configured',
        message: 'No MCP server configured — set OPENWOP_MCP_SERVER_URL (operator config) or node config.serverId.',
      },
    };
  }
  // `ctx.mcp.invokeTool` is optional on `NodeContext` (a host may not wire the
  // outbound client at all). Absent ⇒ typed failure, never a silent success.
  const invokeTool = ctx.mcp?.invokeTool;
  if (!invokeTool) {
    return {
      status: 'failure',
      error: { code: 'mcp_client_unavailable', message: 'this host wired no outbound MCP client (ctx.mcp.invokeTool)' },
    };
  }
  const args = (config?.mcp?.arguments ?? {}) as unknown;
  const res = await invokeTool.call(ctx.mcp, serverId, tool, args);
  return {
    status: 'success',
    outputs: {
      serverId,
      tool,
      isError: res.isError,
      result: res.result,
      // The marker travels WITH the payload into the event log — an observer
      // reading the run must be able to attribute this content to the MCP
      // server rather than to trusted user input.
      untrustedContent: res.untrustedContent,
    },
  };
}

const bridgeNode = (): NodeModule => ({
  typeId: CONFORMANCE_MCP_INVOKE_TYPE_ID,
  version: '1.0.0',
  // The call leaves this host and runs a tool on a peer — ADR 0341's classifier
  // must treat a replay as a recorded-outcome read, not a re-send.
  sideEffecting: true,
  execute: invokeMcpTool,
});

let registered = false;

/** Register the MCP invoke bridge. Idempotent; self-gates like its A2A twin. */
export function registerConformanceMcpInvokeNode(): void {
  if (registered) return;
  if (!conformanceNodesEnabled()) return;
  getNodeRegistry().register(bridgeNode());
  registered = true;
}
