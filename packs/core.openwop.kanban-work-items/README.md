# Core Kanban Work Items

`core.openwop.kanban-work-items` is the reusable execution boundary for any
canvas or feature that needs a reviewed plan represented on a Kanban board.

Its only node takes a board id and a producer-owned proposal containing opaque
scope/provenance plus dependency-aware items. It does not know about App
Builder, a particular canvas document, or any task taxonomy. The host supplies
tenant isolation and deterministic delivery; source revisions own plan changes.

Compose it in a workflow chain after whatever review policy the use case needs.
The chain author can choose a manual or bounded automatic execution policy in
the node configuration. Automatic delivery is still performed by the shared
Kanban lease/outbox and normal workflow dispatcher; the pack never embeds a
feature-specific runner. An explicit item policy can override that chain
default when a use case needs mixed review modes.

Each item may carry `facets` (ADR 1155 D1, since 1.3.0): up to eight stable
grouping keys such as `{ "stage": "rough-in", "room": "r-12" }`. A board groups
and filters its cards by them. They are written when the card is created and
rewritten by `refresh`, like the item's other source-owned facts.
