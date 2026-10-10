# ADR 0777 — Embed focus: bind an embedded chat to the entity on screen

Status: implemented — CANVAS only (see §Correction); P1 + the CAD half of P2 shipped; the workflow rows moved to ADR 0773

## Context

ADR 0768 put an embedded chat beside a feature surface (the builder's open
workflow, the CAD editor's canvas). The follow-up audit found that NONE of the
scoped agents is bound to what is on screen: the CAD Modeler reads whichever
canvas id the model supplies, and the Workflow Architect reads any workflow in
the workspace. The "can see" labels therefore say so honestly ("CAD models you
can open in this workspace"). This ADR makes "Can see: this canvas" TRUE, and
unblocks the builder proposal preview (ADR 0768 follow-up B1), which needs the
Architect to know the open workflow.

Measured on origin/main (b1fed15bd):

- A conversation is an RFC 0005 run started by `POST /runs`; its only
  client-supplied metadata is `chatSessionId`. `ConversationMeta`
  (`host/conversationStore.ts`) has no open-ended context field.
- **Precedent:** notebooks, projects and boards SERVER-SET
  `ConversationMeta.ownerSubject`, and a tool falls back to it when the model
  omits an id (`features/notebooks/agentTools.ts` `resolveNotebookId`).
- But `ownerSubject` ALSO governs who may SEE the conversation
  (`isVisibleToAsync`), and `Subject.kind` admits only
  agent/user/project/board. Reusing it for a canvas would silently change
  visibility. The binding must be a separate field.
- Tool scope already carries `scope.conversationId` during a chat turn
  (`conversationToolLoop.ts`), and a tool may read the meta from it.
- Replay: exchanges are not re-executed; recorded tool results replay. A
  default read live at tool time is replay-safe, like `capabilityScope`.

## Decision

1. **`ConversationMeta.focus?: { kind: 'canvas' | 'workflow'; id: string }`**
   — a NEW field, separate from `ownerSubject`, never affecting visibility.
2. **Server-set only, after an access check.** `PUT
   /v1/host/openwop-app/chat/sessions/:id/focus` `{ kind, id }` stores the focus
   ONLY if the caller may read that entity through THE predicate for its kind
   (canvas: `getCanvasForCaller`; workflow: the builder's readable-workflow
   check). A client value is never copied in. It creates a minimal meta for an
   ephemeral (`persist:false`) embed session, as `setConversationRun` does.
   `DELETE` clears it.
3. **Tools default to it, never widen with it.** A shared
   `resolveFocusedId(scope, kind)` (the `resolveNotebookId` shape): an explicit
   id wins; otherwise the focus. The tool STILL applies its own access
   predicate to the resolved id, so a stale or forged focus reads nothing the
   caller could not.
   - `cad.get-design` / `cad.render`: `canvasId` becomes optional (focus default).
   - `workflow-author nodes.get`: an explicit `workflowId: "current"` resolves
     the focus. The EMPTY argument keeps its meaning (list the index) — changing
     what "no argument" means would silently alter existing behaviour.
4. **The label follows the binding, not the wish.** `EmbeddedChatPanel` takes
   `focus?: { kind, id, label }`; it calls the route once the session exists,
   and switches the context strip to "this canvas: {label}" only after the
   server ACCEPTS the focus. On refusal it keeps the honest workspace label.
5. **Fork:** a branch does not inherit the focus (it belongs to the embed that
   set it).

## Correction (2026-09-29) — CANVAS only; workflows belong to ADR 0773

While rebasing this onto main, ADR 0773 (**builder Pair Canvas**, #4228, another
session) had landed. It already binds a builder WORKFLOW to a conversation: a
server-side `PairContext` keyed by conversation (`workflowId`, the user's
selection, and a `boundRunId` fork guard), set through generic embed hooks
(`beforeSend`, `onConversationId`) and read by its own tools (`read-canvas`,
`suggest-edits`). Adding `focus.kind: 'workflow'` here would have been a SECOND
owner of "which workflow is this chat about", the exact duplication the
architecture contract forbids.

So this ADR binds **canvases only** (the CAD Modeler first). Removed from the
decision above: the `'workflow'` kind, the workflow validator registration, and
`nodes.get "current"`. With one kind, the per-kind validator registry was
dropped too (`focusReadable` calls the canvas predicate directly). If another
entity kind ever needs a binding, the question is first whether ADR 0773's
pairing context generalises, not whether to add a kind here.

Worth adopting from ADR 0773 later: its `boundRunId` fork guard (a `:fork`
copies `chatSessionId`; a focus is only a DEFAULT and every read re-checks the
predicate, so the exposure is nil, but the guard makes intent explicit).

## Alternatives rejected

- **Reuse `ownerSubject`** — changes who can see the conversation; wrong kinds.
- **Seed the id into the first message** — the model may ignore or misquote
  it; the label would claim a binding the tools do not honour.
- **A client-supplied run metadata field** — client-set, so a forged value
  would be trusted; the server must verify access before binding.

## Phases

| Phase | Scope |
| --- | --- |
| P1 | `focus` field + setter + route (access-checked, creates minimal meta) + `resolveFocusedId`; CAD tools default to it |
| P2 | `nodes.get` `"current"`; builder + CAD panels pass `focus`; labels switch on acceptance |
| P3 | (ADR 0768 B1) the builder proposal preview builds on the bound workflow |

> **Correction (2026-09-29, at merge):** after §Correction, P2's `nodes.get "current"`
> and the builder panel's `focus`, and all of P3, are ADR 0773 PairContext's to
> build. They are not pending here. This ADR ships the canvas binding and the CAD panel.

### Implementation record

| Item | Where | Test |
| --- | --- | --- |
| `ConversationMeta.focus` + `setConversationFocus` (creates a caller-owned meta for an ephemeral session) | `host/conversationStore.ts` | `embed-focus-binding.test.ts` › binds… |
| `PUT`/`DELETE …/chat/sessions/:id/focus`: canvas only, `focusReadable` through `getCanvasForCaller`, uniform 404, nothing stored on refusal, no re-focusing another user's conversation | `routes/chatSessions.ts` | › refuses… (removing the route check turns it red) / › re-focus / › any kind but canvas |
| `resolveFocusedId`: explicit id wins, else focus; re-checked by the ONE predicate at tool time | `host/conversationFocus.ts`, `features/cad/agentTools.ts` | › cad.get-design reads the bound canvas / › unreadable focus → not_found (held under the route sabotage) |
| Label switches only on acceptance; the ADR 0768 honest label is the fallback | `chat/EmbeddedConversation.tsx`, `features/cad/CadAssistPanel.tsx` | `embedFocusLabel.test.tsx` (showing it without acceptance turns 2 red), `embedCanSeeLabels.test.tsx` |

## Tests required

- Route: a caller who cannot read the canvas gets 404 and NO focus is stored
  (sabotage: drop the check → red). Minimal meta created for an unpersisted session.
- Tool: with a focus, `cad.get-design` without `canvasId` reads the bound
  canvas; with a focus the caller lost access to, it returns not_found.
- `nodes.get` with no argument still lists the index; `"current"` reads the focus.
- UI: the label changes only after the server accepts.

## RFC gate

None. `ConversationMeta` and `/v1/host/openwop-app/chat/*` are host-local;
tool defaults are host behaviour; no run-event or capability change.
