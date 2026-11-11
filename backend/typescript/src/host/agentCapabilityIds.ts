/**
 * Leaf module: core agent capability ids that the pack loader and the tool
 * resolver both read (ADR 1055 D4). No runtime imports, so the boot-time pack
 * loader can use it without pulling in the profile store.
 */
import type { AgentCapabilityId } from '../types.js';

/** The agent replies with text and is offered NO ADR 0315 default-on baseline
 *  tools (only its manifest allowlist, which may be empty). */
export const TEXT_ONLY_CAPABILITY: AgentCapabilityId = 'text-only';

/** Capabilities a PACK may activate for its own agents by default, through its
 *  `x-openwop-app.agentCapabilities` extension. Closed-world, like
 *  `TENANT_ELECTABLE_CAPABILITIES`: a pack can only take tools AWAY from its own
 *  agent this way, never grant anything. */
export const PACK_DECLARABLE_AGENT_CAPABILITIES: readonly AgentCapabilityId[] = [TEXT_ONLY_CAPABILITY];
