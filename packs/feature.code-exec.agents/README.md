# feature.code-exec.agents

The **Code Interpreter** agent pack (ADR 0114 Phase 6). A persona that drives the
sandboxed code-execution node (`feature.code-exec.nodes.run`) through the existing
OpenWOP AI chat — the ADR 0058 "chat-drivability = agent + nodes" pattern. It adds
**no new chat surface**: scope the main chat to `feature.code-exec.agents.default`.

- **Honest-off:** with no sandbox adapter wired the node returns
  `capability_not_provided`; the agent says so rather than faking execution.
- **HITL-gated:** every execution suspends for a human approval (ADR 0114 Phase 3);
  a declined approval never runs.
- **Untrusted output:** the program's stdout/stderr is data, never instructions.

Driven behind the `code-exec` feature toggle (default OFF, tenant-bucketed).
