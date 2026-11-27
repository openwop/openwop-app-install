# Client portal: an adopter's guide (ADR 1099)

How an adopter (a white-label deployment, its own features under
`src/adopter/features/<id>/`, ADR 1031) gives a firm's outside client a portal on
one project: a chat with an agent that can read the project and **propose**
answers, read-only sections on the page, and an interview the agent runs (for
example room by room, for a residential design firm). Everything here is on the
host extension surface (`/host/openwop-app/*`); nothing touches the OpenWOP wire.

The firm's members never lose the decision: a client's answer is a **proposal**,
held as an approval until a member decides it. Nothing a client says reaches the
firm's records before that.

## 1. What the host already gives you

| Piece | Where | What it does |
|---|---|---|
| The grant | `projects` feature, `project` grant kind (ADR 1099 P1) | A firm member invites someone and grants them ONE project (`view`, or `view` + `comment`), for a limited time, from the project's **Client access** tab. |
| The switch | `projects.client-portal` (tenant bucket, default **off**) | Off: no invite, no grant, no portal, no turn, no section. |
| Audiences | `registerGrantAudience('project', '<label>', '<featureId>')` | Labels a grant at invite time (e.g. `client`, `builder`). The label reaches every tool and section as `scope.audience`. **No label means the least view.** |
| The chat | the portal page, `POST /collab/grants/:id/turn` | One turn with the project agent (`vendor.openwop-app.projects.agents.client-guide`) on the **firm's** credential. Day caps per grant and per tenant. The client's words are fenced as untrusted. |
| Turn memory | P3d | The host remembers the conversation per grant (last 40 lines, 30 days without a turn). |
| Client messages | P3c, `openwop:client.project.message-send` | A client message to the firm is held for review, then joins that person's thread. |
| The review card | P3b | A member sees who proposed it, what, and who may decide. |
| Sections | P4, D10 | Read-only blocks on the portal page (§4). |

## 2. Client tools: reading and proposing

Register them from your backend feature with `registerClientProjectTool`
(`host/clientProjectTools.ts`). Every registered tool for the kind is offered in
the collaborator's turn, and only those: never the member baseline.

- **Id:** `openwop:client.project.<your-feature>-<name>`.
- **Scope:** `run(scope, input)` receives the grant's scope (tenant, org,
  project, grant, collaborator, audience). **Never put a scope key** (`projectId`,
  `tenantId`, …) in `inputSchema`: registration refuses it, at any depth and in
  any spelling, and scope keys in model input are dropped.
- **`effect: 'read'`:** returns what the model reads. Answer from
  `scope.audience`, with the least view when it is absent.
- **`effect: 'propose'`:** `run` returns `{ proposals: [{ groupKey,
  idempotencyKey, summary, payload }] }` and **writes nothing**. Each item becomes
  one approval. The same `idempotencyKey` on the same grant and tool is the same
  approval, so re-running an interview adds nothing. On approve the host calls
  `apply(scope, payload, { approvalId, decidedBy })` once. Make it idempotent on
  `approvalId`; throwing reopens the approval. Optional `mayDecide` and
  `deciderLabel` say who may decide (e.g. only the project's lead designer).
- **Refusals:** throw a typed 4xx `OpenwopError` ("That day has passed"). Its
  code and sentence reach the model fenced, so the agent can tell the person why.
  A 5xx or a raw `Error` reaches the model as a generic sentence.
- **Re-checks:** the grant is checked again before every call. A revoke between
  two calls refuses the second.

## 3. The room interview

The interview is the agent asking, the client answering, and each answer held as
a proposal. A firm member approves it before it lands in the room record.

1. A **read** tool gives the agent what to ask next for this project and audience
   (e.g. the rooms, and per room the open questions), from the firm's own data.
2. A **propose** tool takes the client's answer for one question. Use
   `groupKey` = the room (or the interview session) and `idempotencyKey` =
   `<room>:<question>`. `summary` is the sentence a member reviews.
3. `apply` writes the approved answer into your room record.
4. A **section** (§4) shows the client what is still open and what was accepted,
   so the page and the agent read the same function and can never disagree.

The agent's instructions come from the project agent. Keep your tool
descriptions concrete: they are what the model reads to decide when to call each
tool.

## 4. Sections on the portal page (D10)

- **Server:** `registerGrantViewSection({ kind: 'project', id:
  '<featureId>.<name>', featureId, order, read(scope), enabledFor? })`
  (`host/grantViewSections.ts`).
  - `read` takes the scope and nothing else.
  - Return a JSON object of at most 64 KB. Cap your own lists well below that
    (e.g. 40 rows and an "and N more" count).
  - Return `{ available: false, message, code? }` for the least view.
  - `enabledFor(tenantId)` hides the section for a firm that switched your
    feature off.
- **Frontend:** `lazyExtensions` → `portalSections: [{ kind: 'project', id,
  titleKey, i18nNamespace, component }]`. The component receives
  `{ grantId, data, refresh }`, its own section's data only. The host draws the
  heading, loading, failure and least view.
- **Tests:** mount your component with fixture data in the host's frame with
  `PortalSectionFrame` (`features/collab/ProjectPortal.tsx`).
- **Your obligation, which the host cannot check:** answer from `scope.audience`,
  and never return another party's rows. A builder's grant must never receive a
  client's rows.

## 5. Erasure (D8)

When a collaborator is erased (a DSAR through `eraseSubject`), the host clears
everything it stores for them:

- their turn memory;
- their client thread, including the firm's replies addressed to them;
- their held proposals, cancelled so they can never apply;
- the text of every proposal they made (summary, payload, the firm's label for
  them). An approved proposal's row stays as the firm's record, without their
  words.
- their grants, revoked and kept as the firm's record of what it shared.

The witness is `test/adr1099-p5-erasure.test.ts`. It plants a marker in every
store, erases through the DSAR lane, and checks no store still holds it, while a
second collaborator keeps theirs.

**What `apply` wrote is yours.** If your record keeps the collaborator's own
words (a note, a free-text answer) or their id, register an eraser for it:

- `registerCollaboratorEraseHook(async (c) => …)` (`host/externalCollaborators.ts`)
  for rows keyed by the collaborator (`c.tenantId`, `c.collaboratorId`). Return the
  number of rows touched.
- `registerSubjectEraser` for anything keyed another way.

An approved choice that is just the firm's data (option B for the kitchen
floor) can stay; the person's attribution and words must go. Sections store
nothing, so they need no eraser.

## 6. Turning it on

`projects.client-portal` is off by default. Turn it on per tenant, starting with
a test tenant. An invite creates real outside access to the project, so the firm
should know what a client will see (the project view, your sections, and what
your read tools return) before the first invite.
