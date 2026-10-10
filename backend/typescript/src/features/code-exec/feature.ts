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
 *
 * Toggle: `code-exec`, default ON, per TENANT. ADR 0820 §8.2 restored it (it had
 * graduated to always-on) so the feature can be sold in the Developer bundle. The
 * gate sits in the ONE runner both lanes use (`createSandboxRunner(tenantId)` —
 * the executor's `ctx.runSandboxedCode` and the chat tool), so a refused tenant
 * executes nothing and is charged nothing.
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
  toggleDefault: {
    id: 'code-exec',
    label: 'Code execution',
    description:
      'Run code in an isolated sandbox from chat (the Code Interpreter) and from workflows, with results in the artifact workbench. Needs a sandbox configured by the operator; daily per-workspace budget.',
    category: 'Developer',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'code-exec',
  },
  requiredPacks: [
    { name: 'feature.code-exec.nodes', version: '1.1.1' },
    { name: 'vendor.openwop-app.code-exec.agents', version: '1.0.1' }, // ADR 0114 Phase 6 — the Code Interpreter persona
  ],
};
