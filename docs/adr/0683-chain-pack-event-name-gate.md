# ADR 0683 — a chain pack must not name an event it does not own

Status: Accepted (implemented; see § Implementation record)

## Context

`openwop-1` found (crosstalk `1892`) that three chain packs bound triggers to
event names no conformant host may emit — two of them `core.openwop.*`, the
protocol's own packs. The root cause was a config schema:
`core.openwop.triggers/schemas/event.config.json` constrained `eventName` as
`^[a-z][a-zA-Z0-9._-]*$`, which admits any number of segments, uppercase and
underscores. They tightened it in `core.openwop.triggers@1.1.2` and added a
registry-side gate.

This repo vendors those packs and **never followed**. Measured here:

| pack | bound | |
| --- | --- | --- |
| `examples/workflow-chain-packs/crm-ops` | `host.crm.contact.created` | 4 segments, org `host` unregistered |
| `examples/workflow-chain-packs/people-hr` | `host.users.user.deactivated` | same |
| `examples/workflow-chain-packs/forms-intake` | `host.forms.submission.created` | same |

## Decision

**Two changes, and the structural one is the point.**

**1. The packs stop naming the event.** `crm-ops` and `people-hr` now bind
`{{params.triggerEventName}}` with the name as a parameter DEFAULT — the shape
`openwop-1` published. The event belongs to the **installing host**, not to the
pack; a pack that hardcodes one is binding a name it does not own. `expandChain`
honours `spec.default`, so an install that supplies nothing behaves exactly as
before.

The defaults deliberately name **what this host emits today**, not the corrected
spelling. Renaming `host.crm.contact.created` (25 files) and
`host.users.user.deactivated` (17) is its own change; doing it here would make
the pack default name an event nothing emits, which is precisely the mismatch
that leaves a chain firing and filing nothing.

**2. `scripts/check-pack-event-names.mjs`, wired into `ci.sh`.**

Keyed on **codemap membership, not grammar**, which is `openwop-1`'s argument
mechanised: a protocol event is spelled `run.started` — two kebab segments, no
`openwop.` prefix — character for character the shape of a vendor type. Grammar
alone accepts `node.progres` as a fine vendor name, and a typo of a protocol
event then travels as opaque vendor data nothing ever reports. Only membership
separates the two.

**It scans parameter DEFAULTS as well as `eventName`.** Templating a binding
*moves* the name into the default, so a gate reading only `eventName` would have
gone green on exactly the change that hid the problem from it — the
"fix that satisfies the check without satisfying the invariant" shape.

**The ledger is shrink-only.** Three names are admitted with the reason each is
still there, and an admission that stops matching **fails** as stale. A bare
allowlist is a gate that tolerates what it never mentions.

| admitted | why |
| --- | --- |
| `host.crm.contact.created` | 25 emitting files; rename is its own change, and the pack no longer hardcodes it |
| `host.users.user.deactivated` | 17 files via `USER_DEACTIVATED_EVENT`; same |
| `host.forms.submission.created` | **handed back** to `openwop-1` (`180c`) — renaming it leaves `forms-intake-chain-execution` 4/9 red, five hypotheses falsified, cause unfound |

## Sabotage

| sabotage | caught |
| --- | --- |
| a new binding under an unregistered org | yes |
| an invalid name hidden in the parameter **default** | yes |
| a **stale** admission (name no longer present) | yes |
| the vendored corpus tree missing (vacuous green) | yes |

## Implementation record

| phase | what |
| --- | --- |
| 1 | `crm-ops` + `people-hr` templated, defaults = currently-emitted names |
| 2 | the gate, keyed on codemap membership, scanning bindings AND defaults |
| 3 | shrink-only ledger of 3, each with its reason |
| 4 | wired into `ci.sh`; 4 sabotages; chain-loader + crm chain tests 3 files / 25 tests |
