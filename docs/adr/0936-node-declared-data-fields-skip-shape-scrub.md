# ADR 0936 — A node declares its data fields; the shape scrub skips only those

Status: Accepted (implemented in this PR)

## Context

This ADR implements Book AI upstream proposal P18 (`bookai/docs/upstream-proposals.md`)
in the shape the host proposed on 2026-10-18 and Book AI accepted. My user approved
it on 2026-10-19 ("proceed with your recommendations").

The executor scrubs text in two places that Book AI reads back as data, not as
audit text:

1. **On resume.** `safeResumeValue` runs `stripSecretsFromPersisted` and then
   `sanitizeFreeTextDeep`. The credential-shape pass rewrites `sk-…`, `Bearer …`,
   `ghp_…` and `gho_…`, and the free-text pass turns any run of 32+ hex characters
   into `***`. An author's recorded answer then reaches the node changed.
2. **On `node.completed`.** The payload goes through `stripSecretsFromPersisted`,
   so a thriller scene that prints a fictional `Bearer …` token is persisted as
   `<<redacted:credential-shape>>`. Book AI's review and apply paths read node
   outputs from the event log.

Book AI's audit rows are XCH-RED-1 and XCH-RED-2.

Book AI first proposed scrubbing only the secrets the run had actually resolved.
The host declined that, because it would let a key the model copied from its
context persist. The host's counter-proposal, which this ADR implements, is that a
node declares its data fields and the shape pass keeps running on everything else.

## Decision

- **D1 — the declaration.** A node-pack manifest entry may carry
  `x-dataFields: { outputs?: string[], resume?: string[] }`. These are the
  top-level output port names and resume-value keys that a later node or feature
  reads back as data.
  - `PackNode` already admits `x-` keys (`^(x-|vendor\.)`), so this is a host
    extension and makes no wire claim.
  - `packs/tarballLoader.ts` stamps the parsed value on the registered
    `NodeModule` as `dataFields`, next to `packOrigin`.
  - `readNodeDataFields` keeps only well-formed names. An entry with no usable
    names declares nothing.
- **D2 — `node.completed`.** Each declared output port is scrubbed with
  `stripKnownRunSecrets` (Tier 1: every secret a run resolved, matched as a
  substring) and nothing else. Every other port keeps both tiers
  (`stripSecretsKeepingData`).
- **D3 — resume.** Each declared resume key gets Tier 1 only. Every other key
  keeps the shape pass and the free-text pass (`scrubResumeValue`). This applies
  to both resume styles:
  - on a re-invoke resume, the node receives the value and its outputs then fall
    under D2;
  - on a native resume, the `node.completed` payload carries the same split.
- **D4 — what stays.**
  - NFR-7 ("MUST NOT contain raw key material") is the Tier 1 scrub, and it runs
    on every field, declared or not.
  - The shape pass is defence in depth (`capabilities.md` §Secrets, "SHOULD
    scrub"). It now skips only the fields a node names.
  - Core nodes declare nothing, so the conformance canary paths are unchanged.

## Alternatives weighed

- **Scrub only the run's resolved secrets everywhere** (Book AI's first
  proposal). Rejected: a key the model echoed from context, which the run never
  resolved, would persist verbatim.
- **Declare data fields per workflow node, in its config.** Rejected: the author
  of a workflow is not the author of the node. Whether a port carries prose is a
  property of the node's code, so it lives in the pack manifest.
- **Declare by path (`scene.paragraphs[*].text`).** More precise, but it needs a
  path grammar and a walker. Top-level ports and keys cover both Book AI cases.
  Paths can be added later, compatibly.

## Trade-offs

- **A pack can declare every field as data.** That does not weaken the boundary
  the shape pass gives: a pack's code already sees its own outputs and could
  encode around any regex. What stays non-negotiable, the Tier 1 scrub, the
  declaration cannot switch off.
- Only pack nodes loaded through `tarballLoader` can declare. An in-process host
  node sets `dataFields` on its module directly; none does today.

## Implementation

| Part | Where |
| --- | --- |
| D1 | `backend/typescript/src/executor/types.ts` (`NodeDataFields`, `readNodeDataFields`); `src/packs/tarballLoader.ts` |
| D2 | `src/byok/ephemeralRunSecrets.ts` (`stripSecretsKeepingData`); `src/executor/executor.ts` (success emit) |
| D3 | `src/executor/executor.ts` (`resumeDataFieldsOf`, `scrubResumeValue`, the native-resume emit) |
| Tests | `backend/typescript/test/adr0936-node-declared-data-fields.test.ts` |

The tests cover:

- a declared port keeps the prose, and an undeclared one is still scrubbed;
- a declared resume key reaches the node unchanged (shape and 32-hex cases), and
  an undeclared one keeps both passes;
- a resolved secret is still redacted inside a data field;
- the parser's edge cases.

Each was checked by sabotage:

| Sabotage | Result |
| --- | --- |
| The helper ignores the declared keys | 3 red |
| The resume scrub ignores the declared keys | 1 red |
| Tier 1 dropped on data keys | 1 red |

## Checklist

- [x] D1–D4 with tests
- [ ] Book AI: declare `x-dataFields` on its prose and answers nodes, then retire
  the answers route's scrub pre-check (XCH-RED-1) and the Review marker note
  (XCH-RED-2)

Recovery correction (2026-10-21): replay-derived accepted interrupt resolutions use the same declared resume-data keys and known-secret boundary as live resumes. A fork cut at interrupt.resolved exercises the derived branch; undeclared comments retain both scrub passes.
