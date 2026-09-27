// Ambient declaration for importing the vendored core.openwop.flow node pack's
// runtime functions in tests (ADR 0200 — the data-ops pack test executes the
// real aggregate-* node implementations to pin their contract). The pack is
// plain ESM with no bundled types; a narrow wildcard makes the import resolvable
// without a per-symbol declaration. Test-scope only.
declare module '*core.openwop.flow/index.mjs';

// ADR 0355 — the channels pack's platform-limits helpers (same pattern).
declare module '*feature.campaign-channels.nodes/platformLimits.mjs';

// ADR 0356 — the production pack (spine-slotted plan-generate).
declare module '*feature.production.nodes/index.mjs';

// XCH-CORE-3 / XCH-CORE-4 (LLM-EXCHANGE-AUDIT 2026-07-13) — the guardrails
// honesty contract + the MCP sampling untrusted-fencing tests execute the
// real pack implementations (same pattern).
declare module '*core.openwop.ai/index.mjs';
declare module '*core.openwop.mcp/index.mjs';

// LLM-EXCHANGE-AUDIT Wave 2 — typed-failure regressions execute the real
// vendor pack implementations (same pattern).
declare module '*vendor.myndhyve.market-intel-community-rank/index.mjs';
declare module '*vendor.myndhyve.landing-page/index.mjs';

// LLM-EXCHANGE-AUDIT round 2 — bounded-repair regressions execute the real
// pack implementations (same pattern).
declare module '*core.openwop.rag/index.mjs';
