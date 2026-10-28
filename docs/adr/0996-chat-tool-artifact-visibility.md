# ADR 0996 — chat tool artifact visibility

Status: implemented

Residue item CE62-F1 from ADR 0995 (the code-exec feature-loop pass, row 62).

## Context

Two chat tools persist their output as run-event artifacts under a synthetic
runId. The code tool (`openwop:feature.code-exec.nodes.run`, in
`host/agentToolProvider.ts`) uses `chat-code:<tenant>:<bucket>`, and the
interactive render tool (`openwop:interactive-artifacts.render`) uses
`chat-viz:<tenant>:<bucket>`. The bucket is the conversation id when the tool ran
inside a conversation. Otherwise it was the acting user id or `adhoc`.

`runArtifactStore.writeRow` stores every run-event row with `orgId = tenantId`,
and `artifactProjection` gated run-event rows by `workspace:read` on that org and
nothing else. So an artifact made in member A's private conversation, one that
member B cannot open, was:

- listed to B by the Library (`GET /host/openwop-app/artifacts`),
- served to B in full by `GET …/artifacts/:id`, `/revisions` and
  `/revisions/:revisionId`, and by the `?runId=` filter,
- readable by B's agent through `openwop:interactive-artifacts.get` given the key.

Prod, measured read-only on 2026-10-28: 24,160 run-artifact rows, **zero** with
a `chat-code:` or `chat-viz:` runId, zero typed `code.execution-result` or
`interactive.*` rows. The leak was latent. Nothing has been exposed yet.

## Decision

1. **A chat-tool artifact is exactly as readable as its conversation.** One
   module, `host/chatArtifactScope.ts`, holds both halves:
   - `chatArtifactRunId(lane, scope)`: the only builder of the synthetic runId.
     Both tools call it.
   - `canReadChatArtifact(row, subject)`: the only read rule. A conversation
     bucket is answered by `authorizeConversationRead` (ADR 0992 D8), the
     conversation read question the export route and tool already share. No
     second visibility rule is written.
2. **Every reader asks it:** `artifactProjection.resolveRunArtifact` (so get,
   revisions, revision, diff, `listArtifactsForRun` and the review-asset
   enrichment), `listArtifacts` (the Library, once per conversation, fail-closed
   per row and logged), and the `interactive-artifacts.get` tool.
3. **Hidden reads exactly like missing:** the same `null` and therefore the same
   404 body as an id that never existed. The tool returns `{ artifact: null }`.
4. **Without a conversation, the bucket becomes `user:<actingUserId>`,** which
   only that user may read. Before, it was a bare user id, which a reader cannot
   tell from a conversation id. `adhoc` (no user) is readable by no one.
5. **A legacy row** whose bucket names no conversation is readable only by the
   user it names, which covers the old bare-user-id spelling. A row from a
   **deleted** conversation therefore disappears from the Library. That fails
   closed. The alternative was to fall back to the org gate, and that is the
   leak.

## Alternatives weighed

- **Stamp an owner on the row** (an `ownerSubject` on `RunArtifactRecord`). This
  freezes the conversation's audience at write time: adding a participant would
  not grant access, and removing one would not revoke it. It is also a second
  visibility rule. Rejected.
- **Exclude chat-tool rows from the Library entirely.** This breaks the
  "open in the Workbench" path for the person who made them. Rejected.
- **Gate in the route only.** The tool and `listArtifactsForRun` would still
  leak. Rejected. The gate sits in the projection, which every door uses.

## Consequences

- One storage read (session + meta) per distinct conversation per Library load,
  memoised.
- The key spelling changes only when there is no conversation (rare, since every
  chat-tool call from the chat lane carries one). An identical retry made after
  the deploy mints a new row instead of deduping onto the old one. That is
  harmless.

## Operations notes

Code execution must not be enabled in prod (OPENWOP_CODE_EXEC_RUNTIME / E2B env) until this fix is live.

The prod count above is not blind. The writer is `runArtifactStore.writeRow`
(`runArtifacts`, `DurableCollection('runartifact')`, keyed by
`${runId}:${nodeId}`), so a chat-code row is stored in `host_ext_kv` at
`hostext:runartifact:chat-code:<tenant>:<bucket>:<nodeId>`. A memory-storage
probe confirmed that key shape. The same query read 24,157 run-artifact rows by
that key prefix, and their `runId` field, and found zero chat-tool rows either
way. No other keyspace names a chat lane, and no media asset was uploaded by one.

## Residue

- Chat-tool artifacts are not removed when their conversation is deleted. They
  stop being readable (decision 5), but the rows remain until run-artifact
  retention removes them.
- Ordinary run outputs (real runs started from a private conversation) are still
  gated by org alone. That is a question about run visibility, not about this
  lane, and is out of scope here.
- A chat-viz output that resolves to a media asset or a document is gated by that
  owner's rule, not the conversation's. The render node emits typed inline
  payloads, so this does not happen today.

## Implementation record

| Phase | What | Test |
| --- | --- | --- |
| 1 | `chatArtifactScope.ts`; projection, Library and tool gated; producers on the one builder | `test/ce62-f1-chat-artifact-privacy.test.ts`, `test/interactive-artifacts-agent-tools.test.ts` |
