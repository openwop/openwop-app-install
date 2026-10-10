# ADR 0781 — v2: an unadvertised operation answers `404 not_found`

Status: implemented

## Context

errors.md § "Unadvertised operations" (RFC 0228, merged as openwop#1802, suite
2.44.6) says: "An operation gated on a family or facet the host does not advertise
MUST answer `404 not_found`." The new major-2 scenario
`v2-unadvertised-operation-not-found` probes two such operations:

- `GET /prompts`, when `prompts.endpointsSupported` is not `true`;
- `GET /content/settings`, when there is no `content` record.

Each expects `404` with the closed envelope `{ error: "not_found", message }` and
optional `details`. The rule itself covers every gated operation. This host
broke it in two ways:

- **Refused with the wrong status.** Prompts answered `501 capability_not_provided`
  at nine sites (`routes/prompts.ts`). Trigger-subscription ingestion answered
  `501 host_capability_missing` at two sites (`routes/triggerBridge.ts`).
- **Did not refuse at all.** `content` is advertised only when host i18n is on,
  but `features/cms/contentProtocolRoutes.ts` served every content route
  regardless, so an i18n-off host answered 200 on an unadvertised family.

`app.openwop.dev` advertises all three, so the scenario records `inapplicable`
there. The defect bites a white-label deployment that turns one off.

## Decision

1. **One helper.** `host/unadvertised.ts` (`unadvertisedError` / `sendUnadvertised`)
   answers `404 not_found` with `details: { family, facet? }` under major 2, and
   the unchanged major-1 refusal otherwise. Every gate below calls it, so the
   answer cannot drift between routes.
2. **Protocol-surface gates only**, where the flag the handler checks is the flag
   discovery advertises:

   | Family | Facet | Gate |
   |---|---|---|
   | `prompts` | none | `endpointsSupported` |
   | `prompts` | `mutableLibrary` | `mutableLibrary` |
   | `content` | none | all `/content/*` routes, when `hostI18nEnabled()` is false |
   | `triggerBridge` | `ingestion` | `triggerIngestionEnabled()` |

   Host-extension routes keep their refusals: `workforces` eval, the trigger-bridge
   conformance seams (already 404) and `creative-video`.
3. **A merely unconfigured operation is not unadvertised.** Email's "configure the
   sender address" and app-builder's "no GCP project" stay `501
   capability_not_provided` on both majors. Those operations exist and are
   advertised; saying `not_found` would be false.
4. **Major 1 is unchanged.** It keeps its 501s, and content keeps serving on v1.

## Alternatives weighed

| Option | Why not |
|---|---|
| Remap every `501 capability_not_provided` to `404` in the v2 response wrapper | That would also relabel the configured-but-unconfigured refusals in Decision 3, telling a client an existing operation does not exist |
| Change v1 too | v1 clients handle the 501. The rule is a major-2 rule |
| Fix only the two probed routes | The MUST covers every gated operation. A narrower fix passes the scenario and leaves the rule broken |

## Corrections

`routes/discovery.ts` said the content routes are "served unconditionally". It now
carries an inline correction: that holds for major 1 only.

## Tests

`test/adr0781-unadvertised-not-found.test.ts`, with both majors pinned for every gate:

- **Content** (through the real app): with i18n off, v2 discovery omits `content`
  and four content operations return the closed `404 not_found`, while v1 does
  not take the v2 refusal. With i18n on, the family is advertised and not refused.
- **triggerBridge** (through the real app): with ingestion off, discovery omits
  `externalSources`, v2 returns 404 `not_found`, and v1 returns `501
  host_capability_missing`.
- **Prompts** (flags injected, since they are constant in the real app):
  `endpointsSupported` off gives v2 404 and v1 501. `mutableLibrary` off gives
  v2 404 naming the facet, and v1 501.

## Also in this change

The `openwop-app.messaging` record's `servedBy.adr` said `0765`. It now names
`0769`, the ADR that decided that claim, through a per-claim `adr` field.
