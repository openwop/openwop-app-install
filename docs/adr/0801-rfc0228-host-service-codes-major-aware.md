# ADR 0801 — RFC 0228 host-service error codes: renamed on the major-2 wire, kept on major 1

Status: implemented (2026-10-02)

Relates to: RFC 0228 (`Active`, wire shape locked; gap G3 names this host),
ADR 0654 (v1 deprecated, served until its end-of-support date), openwop#1698
(run-carried codes must be registered or vendor codes).

## Context

RFC 0228 decided what v2 calls the per-service error names v1 used for `ctx`
rejections. Three of its rows are this host's:

- `ctx.fs` rejects a sandbox escape with `path_outside_sandbox`
  (`host/durable/durableFs.ts`, `host/inMemorySurfaces.ts`).
- `ctx.table` rejects a mistyped column with `table_schema_violation`
  (`host/durable/durableTable.ts`, `host/inMemorySurfaces.ts`).
- The three `ads-publish-*` packs branch on five `secret_*` names.

v2 has no row for any of them: a sandbox escape is `forbidden` with
`details.reason: path-outside-sandbox`, a schema violation is
`validation_error`, and a generic code MUST carry `details.service`.

The obvious fix, renaming at the throw site, breaks conformance on the major
this host still serves. Read from the pinned suite: `table-schema-enforcement`
asserts `table_schema_violation` by equality, and `fs-path-traversal` accepts
`path_outside_sandbox`, `fs_path_traversal` or `invalid_path` — not `forbidden`.

## Decision

1. **The host code does not change.** Throw sites keep the v1 names, so the
   major-1 wire and stored failures are untouched.
2. **The major-2 egress projection renames.** `V2_EVENT_CODE_ALIASES` gains
   `path_outside_sandbox → forbidden` and `table_schema_violation →
   validation_error`, and `projectV2ErrorObject` adds the required details from
   a table keyed by host code (`service: fs` + `reason: path-outside-sandbox`;
   `service: tableStorage`). Details already on the failure win. The host code
   still rides `details.hostCode`, as for every alias.
3. **Event lane only.** These reach a run's failure, not an HTTP refusal; an
   HTTP alias would also have to agree on status (see the comment on
   `V2_EVENT_CODE_ALIASES`).
4. **The packs check both spellings.** `mapSecretError` in each of the three
   packs accepts the `secret_*` names and the registered codes
   (`credential_not_found` with optional `details.reason` `revoked` /
   `expired`, `credential_forbidden`, `rate_limited`), as RFC 0228
   §Compatibility prescribes for a pack that runs on both majors. Packs
   1.0.2 → 1.0.3.

## Alternatives weighed

- **Rename at the throw site.** Fails the major-1 suite today, and rewrites
  nothing already stored.
- **Branch on the negotiated major inside `ctx`.** A `ctx` service has no
  request in scope, and a run started at one major can be read at the other.
  The projection is the one place both facts are known.
- **Leave the packs on `secret_*` only.** No host emits those at major 2; the
  branches would be dead there and every state would fall to the generic,
  non-retryable outcome.

## Consequences

- When v1 is retired, the throw sites can take the v2 names and the two alias
  rows can go; until then both wires are correct.
- This host does not itself emit the `secret_*` names (no emitter in
  `backend/typescript/src`); the pack change is for portability and for
  RFC 0228's measured row.

## Implementation record

| Change | Witness |
|---|---|
| alias rows + `V2_HOST_SERVICE_DETAILS` in `middleware/protocolVersion.ts` | `test/rfc0228-host-service-codes.test.ts` |
| `mapSecretError` in the three `ads-publish-*` packs, 1.0.3 | same file, 11 cases per pack |

## Open questions

- [ ] `v2-fs-sandbox-escape-refused` (suite 2.45.x) needs the
      `conformance-fs-probe` fixture advertised to observe this end to end. This
      host does not carry that fixture yet, and the pinned suite (2.45.2)
      predates the scenario; both move with the next suite pin.
