/**
 * The `challenge-authoring` capability — core-agent level, activated per named
 * agent (ADR 0458 §2.1). Mirrors `features/kicktodo-core/coachingCapability.ts`.
 *
 * **Architecture law (David):** nothing may be unique to a named agent in
 * source. The Challenge Author's behavior (talking a creator through a concept,
 * igniting the `challenge-factory` workflow through its assigned workflows) is
 * NOT fused to `roleKey === 'kicktodo-challenge-author'`; it is this CORE
 * capability, which any agent activates via `AgentProfile.capabilities`. Any
 * runtime that must resolve "the tenant's challenge author" does so by THIS
 * capability — never by `roleKey`.
 *
 * The capability-RESOLVER pair this file once carried (list/find over roster +
 * profile) was removed in the 2026-07-21 cleanup sweep: it was over-built and
 * never wired (zero callers) — reintroduce it from the coachingCapability
 * pattern if a runtime ever needs to resolve "the tenant's challenge author."
 */
import type { AgentCapabilityId } from '../../types.js';

export const CHALLENGE_AUTHORING_CAPABILITY: AgentCapabilityId = 'challenge-authoring';

