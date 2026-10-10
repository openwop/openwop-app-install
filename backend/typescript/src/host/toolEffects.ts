/**
 * ADR 0784 P2 — the effect of the tools a caller SAW, by name.
 *
 * The turn receipt joins `agent.toolCalled.toolName` to this answer to say
 * "2 reads · 1 change". Ask-by-name, never the whole catalog: the answer only
 * covers names the client already holds from its own turns, so nothing about
 * the host's tool list is disclosed. An unknown name (an MCP tool, a tool added
 * later) is OMITTED — the receipt then says nothing about it rather than guess.
 * Display only (ADR 0784 §2): never an input to gating.
 */
import { builtinAgentTool, builtinAgentToolIds } from './agentToolProvider.js';
import { sanitizeToolName } from '../providers/dispatchProviderTools.js';

export const TOOL_EFFECTS_MAX_NAMES = 50;
export type ToolEffect = 'read' | 'write';

/** Resolve by exact id, else by the provider-sanitized spelling (`openwop_crm_list-companies`),
 *  in case a surface recorded the name the model used. Built per call: the
 *  registry is small and a cache would go stale on a late registration. */
export function toolEffectsFor(names: readonly string[]): Record<string, ToolEffect> {
  const out: Record<string, ToolEffect> = {};
  let bySanitized: Map<string, string> | null = null;
  for (const name of names.slice(0, TOOL_EFFECTS_MAX_NAMES)) {
    let tool = builtinAgentTool(name);
    if (!tool) {
      bySanitized ??= new Map(builtinAgentToolIds().map((id) => [sanitizeToolName(id), id]));
      const id = bySanitized.get(name);
      tool = id ? builtinAgentTool(id) : undefined;
    }
    if (tool) out[name] = tool.effect;
  }
  return out;
}
