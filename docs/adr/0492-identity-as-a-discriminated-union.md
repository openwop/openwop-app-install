# ADR 0492 — The viewer's identity is a discriminated union, not a nullable id

Status: implemented

## Context

The 2026-07-25 `/upgrade-ux` programme found the same defect three times, in three
files, each fixed independently and each with a slightly different shape:

| Surface | Ownership test | What a failed identity read did |
|---|---|---|
| `/team` (`profiles/TeamPage`) | `p.userId === myId` | Your own skill chips became **enabled** — which the app's own `cannotEndorseOwn` copy forbids and the server answers **403** — and `aria-pressed={false}` reported endorsements you *had* made as un-made |
| Agent "Twin of…" (`twin/AgentTwinPanel`) | `link.userId === myUserId` | `isMine` went false for a twin that **was** yours → the **"Allow recall" grant panel vanished**, and the header announced "Twin of `<your own opaque id>`" |
| My Profile → Memory (`profile-memory`) | *(403 arm)* | The memory-learning **consent control disappeared entirely** |

They share one mechanism. The identity is held as `string | null`:

```ts
const [myId, setMyId] = useState<string | null>(null);
getMyProfile().then(p => setMyId(p.userId)).catch(() => setMyId(null));
...
const isMine = row.userId === myId;   // null compares unequal to everything
```

A failed read leaves `myId === null`, and `null` is unequal to every real id — so
**every ownership test silently answers "not yours"**. That is:

- the **permissive** answer for *"is this mine?"* — own-row guards stop firing, and
  the UI offers actions the server will refuse; and
- the **restrictive** answer for *"may I manage it?"* — owner-only controls vanish,
  and their absence reads as *"you don't have permission"*.

Both are wrong, **neither throws**, and nothing in the type system objects. Fixing it
per-site had already worked three times, and would keep working — badly. Three
independent re-derivations of the same guard is the signature of a **missing
primitive**, not of three bugs.

## Decision

Model the viewer's identity as a **discriminated union** and expose one comparison
helper, in `features/profiles/useMyIdentity.ts`:

```ts
export type MyIdentity =
  | { status: 'loading' }
  | { status: 'known'; userId: string; profile: Profile }
  | { status: 'unknown'; error: string };   // deliberately carries NO userId

export function isMine(id: MyIdentity, ownerId: string | null | undefined): boolean | 'unknown';
```

Two properties do the work:

1. **There is no bare `myId` to compare against.** A new call site cannot reintroduce
   the bug by writing `row.userId === myId`, because that does not typecheck. The
   `unknown` arm carries no `userId` at all, so reaching for one forces you through
   the narrowing.
2. **`isMine` returns `'unknown'`, never a silent `false`.** The caller must decide
   what unknown means *for their surface*, rather than inheriting `false` by accident.
   Both correct answers are in use:
   - a control that **acts** on your own row → treat unknown as "don't offer it"
     (fail closed: `/team` disables the endorse chip **and says why**);
   - a **claim** about ownership → say you don't know, never assert the negative
     (the twin panel stops announcing "Twin of *someone else*").

### Where it lives, and why not in core

`features/profiles/`, not a new core module. **ADR 0446** found that moving
cross-feature coupling to core is almost always the wrong instinct — its genuine
primitive-extraction yield across a whole audit was **one** — and named the
god-core trap explicitly. `features/twin` already imports `getMyProfile` from
`features/profiles`; this hook rides that **existing** edge rather than minting a
core module for two consumers. If a third feature outside that edge needs it, that is
the moment to reconsider.

## Alternatives considered

- **Keep fixing per site.** Rejected: three sites, three shapes, and each fix had to
  re-derive the same reasoning. The fourth would too.
- **Throw on a failed identity read.** Rejected: identity is a *companion* read on
  most of these surfaces. `/team`'s directory is still useful when we can't tell which
  row is yours; failing the page would be a worse trade than degrading the control.
- **Return `false` with a separate `identityKnown` boolean** (what I hand-rolled
  twice). Rejected: it keeps the silent-`false` default one careless line away, and
  two of my three hand-rolled fixes named the flag differently — which is how a
  reviewer misses one.
- **A React context / provider.** Rejected as premature: `getMyProfile` already
  coalesces concurrent reads (`cachedRead('profiles.me', 0)`), so several components
  calling the hook on one paint share a single request. A provider adds wiring for no
  measured gain.

## Consequences

- **A hazard the union introduces, and how it is handled.** `boolean | 'unknown'`
  means the string `'unknown'` is **truthy** — so a bare `self ? …` marks *every* row
  as your own. Migrating `TeamPage` surfaced exactly this in four places; all seven
  checks there are now explicit `=== true`. Recorded because it is the predictable
  cost of this design and the next migration will meet it.
- **An effect-ordering trap.** `isMine` inside an effect whose deps omit `identity`
  captures it while still `loading`. `AgentTwinPanel`'s linked-name lookup was split
  into its own effect keyed on `[view, identity]` for this reason.
- Sites that read the profile for something other than ownership — pin state
  (`AgentWorkspacePage`, `PinnedAgentsNav`), the welcome card — are **not** migrated.
  They make no ownership claim; converting them would be churn. That is a deliberate
  boundary, not an oversight.

## Implementation record

| Phase | Change | Verify |
|---|---|---|
| P1 | `useMyIdentity.ts` + `isMine` | `useMyIdentity.test.tsx` — all three arms, plus "no owner is a real false, not unknown" |
| P2 | `TeamPage` migrated; 7 truthiness checks made explicit | frontend build green |
| P3 | `AgentTwinPanel` migrated; name lookup split to its own effect | frontend build green |

Prior per-site fixes this supersedes: #2557 (`TeamPage`, `AgentTwinPanel` hand-rolled
`identityKnown`). The `profile-memory` consent control is a **403-arm** instance of the
same family and is left as-is — it has no ownership comparison to route through
`isMine`.
