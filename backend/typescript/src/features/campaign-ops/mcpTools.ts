/**
 * ADR 0962 P1 — Campaign Studio's MCP read tools: the chain pack
 * `core.openwop.workflows.campaign-studio-mcp` (`campaign-studio.mcp.*`),
 * registered chain-backed with the ADR 0087 MCP gates merged into the expanded
 * definition (the `registerMcpProjectionWorkflows` shape: MERGE, never replace).
 * Every chain-backed workflow is `host`-sourced on the MCP mount, so this
 * registration IS the exposure. The `campaign-` chain id also puts any gate on
 * these runs under ADR 0962 D4.1's MCP refusal.
 */
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';

export const CAMPAIGN_MCP_READ_TOOLS = [
  { chainId: 'campaign-studio.mcp.list', tool: 'campaign_list' },
  { chainId: 'campaign-studio.mcp.get', tool: 'campaign_get' },
  { chainId: 'campaign-studio.mcp.performance', tool: 'campaign_performance' },
  { chainId: 'campaign-studio.mcp.pending-gates', tool: 'campaign_pending_gates' },
  { chainId: 'campaign-studio.mcp.run-status', tool: 'campaign_run_status' },
  { chainId: 'campaign-studio.mcp.explain', tool: 'campaign_explain' },
  // ADR 0962 P2 — a REQUEST: write tier (it writes a request row), approval
  // `never`. An MRTR confirmation would be the agent confirming itself (X1); the
  // change's effect waits on the ADR 0924 human approval instead.
  { chainId: 'campaign-studio.mcp.request-change', tool: 'campaign_request_change', tier: 'write' },
] as const satisfies ReadonlyArray<{ chainId: string; tool: string; tier?: 'write' }>;

export function registerCampaignMcpReadTools(featureId: string): void {
  for (const entry of CAMPAIGN_MCP_READ_TOOLS) {
    const { chainId, tool } = entry;
    const tier = 'tier' in entry ? entry.tier : 'read';
    registerChainBackedWorkflow(chainId, {
      featureId,
      postProcess: (def) => {
        def.metadata = {
          ...(def.metadata ?? {}),
          kind: 'meta-workflow', feature: featureId, mcpTool: tool,
          mcpFeatureToggle: 'campaign-orchestration', mcpRequiresAuth: true, mcpSafetyTier: tier, mcpApproval: 'never',
        };
        // The backing node's output is the tool result; the expose head is secondary.
        for (const node of def.nodes) {
          if (node.nodeId === 'backing' || node.nodeId.endsWith('_backing')) node.outputRole = 'primary';
          else if (node.nodeId === 'expose' || node.nodeId.endsWith('_expose')) node.outputRole = 'secondary';
          else if (node.outputRole !== undefined) delete node.outputRole;
        }
      },
    });
  }
}
