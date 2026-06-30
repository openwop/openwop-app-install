/**
 * Sandboxed code execution (ADR 0114, backlog B4). A pluggable EXTERNAL-sandbox
 * code interpreter, driven through the existing chat via an agent pack and
 * projecting results into the artifact workbench. COMPOSES existing seams (the
 * `ctx.runSandboxedCode` adapter, ADR 0055 artifact registry, ADR 0069/0083
 * workbench, ADR 0051/0102 HITL gate, RFC 0076 egress broker) — no new core
 * route/nav edits, no in-process runtime.
 *
 * Phase 1 (this): the capability-honest seam — the `feature.code-exec.nodes.run`
 * node + the `ctx.runSandboxedCode` adapter method (optional, UNWIRED by default).
 * With no sandbox adapter, the node throws `capability_not_provided` (honest-off).
 * Toggle OFF, bucketed per TENANT (a paid, high-blast-radius B2B surface).
 *
 * @see docs/adr/0114-sandboxed-code-execution-node.md
 */
import type { BackendFeature } from '../types.js';
import { registerCodeExecArtifactType } from './artifactTypes.js';

export const codeExecFeature: BackendFeature = {
  id: 'code-exec',
  // Phase 1 ships no HTTP routes — the surface is the node pack + the ctx adapter
  // seam (real execution + the HITL/artifact workflow land in later phases).
  registerRoutes: () => { registerCodeExecArtifactType(); /* ADR 0114 Phase 4a — register the result artifact type */ },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
  requiredPacks: [
    { name: 'feature.code-exec.nodes', version: '1.0.0' },
    { name: 'feature.code-exec.agents', version: '1.0.0' }, // ADR 0114 Phase 6 — the Code Interpreter persona
  ],
};
