# feature.kb.nodes

## Full description

_Moved from `pack.json` `description`, which the v2 manifest schema caps at 1024 characters._

Knowledge Base feature node pack — workflow nodes over the `ctx.features.kb` surface shipped by the KB feature. `search` retrieves chunks from one collection; `rag` retrieves + builds an augmented prompt + citations for an agent/callPrompt downstream; `list-collections` discovers a collectionId. Those three are role:"action" reads (recorded → replay/fork serve the recorded result). v1.2.0 (ADR 0643 D2) adds `reindex-drain`, the ONLY role:"side-effect" node here: it drives one bounded slice of an already-started embedding-spec reindex, and its terminal branch flips the collection's serving namespace and DELETES the old one — so the derived side-effect floor is what stops a `mode:'replay'` fork re-executing it. It is NOT a general-purpose verb: the surface refuses it unless a `running`/`paused` job already exists (only the `host:org:manage` REST door can create one) AND the executing run's workflowId is the host-minted `kb.reindex:<tenantId>:<orgId>:<collectionId>` — declaring the node in an arbitrary tenant chain is a typed refusal. v1.2.0 also gives ALL FOUR nodes ADR 0525 `$id` input/output schemas. Ingest is deliberately NOT on this surface: the media-extraction path is replay-unsafe by design and every ingest lane already has an owner.
