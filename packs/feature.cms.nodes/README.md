# feature.cms.nodes

## Full description

_Moved from `pack.json` `description`, which the v2 manifest schema caps at 1024 characters._

CMS feature node pack (write verbs C6) — workflow nodes over the `ctx.features.cms` surface shipped by the CMS feature. Reads: `get-page` (published page resolved for a target locale, exact → language-family → base) and `list-pages`. Generative: `translate-section` (sparse per-locale overlay via the run-scoped ctx.callAI). Governed writes: `update-section-draft` (DRAFT-only section patch, sanitized like an editor save) and `submit-page` (the SAME approval-gate composition as the editor submit — a node can draft and submit but NEVER publish). Reads are role:action (outputs recorded; replay/fork read the recorded result). The three WRITERS are role:side-effect (ADR 0668 D5): `update-section-draft` and `submit-page` mutate the pages store and are replay-SERVED; `translate-section` also writes and is additionally NON-DETERMINISTIC (it calls the model), so the generator holds it back from the served set as an ai-invocation-log and it re-executes on replay by design — RFC 0041 §B divergence injection depends on that, and the ADR 0326 invocation log is its discharge. Overlays are sanitized on persist.
