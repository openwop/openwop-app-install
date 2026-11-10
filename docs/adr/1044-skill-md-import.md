# ADR 1044 — SKILL.md import: scanned, tenant-local, never executed

Status: Accepted (David, 2026-11-03: "do the full implementation of all of these features in waves")

Phase P5 of [ADR 1041](1041-all-surfaces-channels-program.md), the channels and
surfaces program. Tracker items
`CHAN-P5-1` and `CHAN-P5-2`.

## Context

A SKILL.md is a folder with a Markdown file. The file has YAML frontmatter
(`name`, `description`, optional `allowed-tools`) and a body of instructions.
Anthropic's Agent Skills and agentskills.io use this shape. OpenClaw and its
ClawHub registry add `metadata.openclaw`: `requires.{bins,anyBins,env,config}`,
`os`, and `install` (installer specs). A folder can also bundle `scripts/`,
`references/` and `assets/`.

What this host has today (measured on `c1f72df8d`):

1. `packs/core.openwop.skills-bridge` 1.0.2 converts a SKILL.md into an agent
   manifest. Nothing calls it. No feature lists it in `requiredPacks`. It is
   vendored from `openwop-registry` (`scripts/sync-packs.sh` overwrites it), its
   YAML subset reads two levels of nesting, it does not read `allowed-tools`
   (only `allowed_tools`), it cannot read OpenClaw's one-line JSON `metadata`,
   and on a bad input it answers `status: 'success'` with `agentManifest: null`.
   That last one breaks the CLAUDE.md rule that invalid input is a typed failure.
2. ADR 0312 and RFC 0131 (Accepted) define a Skill as an agent manifest with
   `role: "skill"`, a `handoff`, and scratchpad-only memory. It is not a new
   pack type.
3. The marketplace install lane (`POST /marketplace/install`, ADR 0826 D4) is
   superadmin-only, process-global, and signed-only: it verifies SHA-256 SRI and
   an Ed25519 signature over `pack.json`. `OPENWOP_PACK_TRUST_ENFORCE` refuses
   unattested packs. A pasted SKILL.md has no signature and never will.
4. A tenant already authors agents without a pack: `POST /agents`
   (`routes/userAgents.ts`) stores a `user_agents` row, registers it with
   `ownerTenant`, and ADR 0379's one visibility rule keeps it inside that tenant.
   It is prompt and allowlist data. No code runs.

The ClawHavoc incident (February 2026) put 341 malicious skills on ClawHub. They
asked the user or agent to run a "prerequisite" installer: a `curl | bash`, a
`base64 -D | bash`, or a password-protected zip. The payload was a macOS
infostealer. The skill files themselves were plain Markdown.

## Decision

### D1. An imported skill is a tenant-owned agent, not a pack

The import writes the same `user_agents` row the Agents tab create form writes,
through `ensureUserAgentRegistered`, with `ownerTenant` set. It never writes to
the pack directory, never enters the process-global registry as a pack agent,
and is never published to a registry. Its runtime id is `user.<name>`, like any
user-authored agent.

The task asked for install "through the existing marketplace/pack install path".
That path cannot take an unsigned bundle without weakening signature
enforcement, and it is global, not per tenant. The user-agent path is the
existing per-tenant install path, and it already holds exactly what a skill
without code is: instructions and a tool allowlist.

### D2. The pack lane stays signed-only; `OPENWOP_PACK_TRUST_ENFORCE` is untouched

Nothing here changes the pack loader, `packTrust`, or the install lane. A
skill that should reach every tenant, or that needs code, ships as a signed
pack (ADR 0312) through the marketplace as before.

### D3. Who may import, and the approval step

- Both the `marketplace` toggle and the new `marketplace.skill-import`
  sub-toggle must be on. The sub-toggle is default off.
- The caller must be a signed-in workspace owner or admin
  (`host:members:manage`) or the host operator. That is the same predicate as
  feature-bundle activation (ADR 0892), passed in, not copied.
- Import is two calls. `POST …/skills/import/preview` converts, scans and
  validates, and returns the result with a `sourceSha256`. `POST …/skills/import`
  repeats every check, requires `expectedSha256` to equal the hash of what it
  receives, and requires `acknowledgeWarnings: true` when the preview had
  warnings. So the admin approves the exact bytes they saw.
- Each import writes a durable audit row (`marketplace.skill.imported`).
- The imported agent is marked unverified in its provenance row
  (`verified: false`, source hash, format, what was ignored). There is no path
  that marks it verified.

### D4. Signed or scanned, never neither

This is the ADR 1041 D3 rule for skills ("install only signed and scanned"). Every file in the import is scanned
as text before anything is stored. A blocking finding refuses the import with
`skill_import_refused` / `reason: "install_lure"` and the findings. Blocking
rules: pipe to a shell or interpreter, `bash <(curl …)`, base64-decode then
run, PowerShell encoded commands, Gatekeeper or quarantine bypass, a prompt for
the system or keychain password, download then `chmod +x` and run, a link to an
executable or installer file, a password-protected archive, and invisible
Unicode (bidi controls and zero-width characters). Warning rules, which need
acknowledgement: package-manager installs, `sudo`, "run this in your terminal",
and HTML comments. The scanner never runs anything.

### D5. Bundled scripts are refused (`CHAN-P5-2`)

A bundle with a file under `scripts/`, an executable extension, a shebang, or a
frontmatter `scripts` or `hooks` key is refused (`scripts_refused` /
`hooks_refused`). No sandbox lane is offered in this phase. The code sandbox
(ADR code-exec) runs a node's code under a tenant's run, and wiring an imported
script into it would need a per-skill node, a manifest for its inputs, and
secret isolation that this phase does not build. Refusing is the default the
program asked for. Other bundled files (`references/`, `assets/`) are scanned,
not installed, and listed as `notInstalled` with a warning that the agent cannot
read them.

### D6. Bundle limits

At most 64 files, 256 KiB each, 1 MiB in total, 512 KiB compressed. Paths must
be relative, with no `..`, backslash, control character or drive letter.
Symlink entries are refused. Sizes are checked from the zip directory before
decompressing and again after. One `SKILL.md` at the root, or inside one
top-level folder. Instructions longer than the user-agent prompt limit (16,000
characters) are refused, never cut.

### D7. Frontmatter is closed-world

The importer has its own strict frontmatter reader (block and flow YAML, block
scalars, and one-line JSON for OpenClaw's `metadata`). It does not call the
vendored bridge parser, for the reasons in Context 1. It keeps the bridge's
contract: the converted manifest uses the bridge adapter's handoff schemas
(`core.openwop.skills-bridge/1.0.2/adapter.{task,return}.schema.json`).

| Field | Handling |
|---|---|
| `name` | Required. agentskills.io rule: 1–64 lowercase letters, digits and single hyphens. Becomes the persona and `user.<name>`. |
| `description` | Required, at most 1,024 characters. Cut to 280 on the agent row (that row's limit); the full text stays in the manifest. |
| `allowed-tools` / `allowed_tools` | See D8. |
| `license`, `compatibility`, `version` | Kept in provenance only. |
| `model`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `homepage` | Ignored, listed in `ignored`. |
| `hooks`, `scripts` | Refused (D5). |
| `metadata.openclaw` (or `clawdbot`) `requires.bins/anyBins/env/config` | Refused (`requirement_unmet`). This host gives agents no shell, no binaries and no environment variables. Secrets ride BYOK and Connections. |
| `metadata.openclaw.install` | Refused (`installer_refused`). |
| `metadata.openclaw.os`, `emoji`, `homepage`, `always`, `skillKey`, `primaryEnv` | Ignored, listed. |
| other `metadata` keys | Ignored, listed. |
| any other key | Refused (`frontmatter_unknown_key`). |

An empty body is refused (`empty_instructions`). There is no success with an
empty or placeholder prompt.

### D8. Tools resolve or the import is refused

Each `allowed-tools` entry must name a tool registered on this host
(`builtinAgentToolIds()`), as `openwop:<id>`, or be `WebSearch`, which maps to
`openwop:ai.research.web`. Claude Code's local tools (`Bash`, `Read`, `Write`,
`Edit`, `Glob`, `Grep`, `WebFetch`, `NotebookEdit`, `Task`) are refused as
`tool_unavailable`: this host has no shell or file system for agents. Anything
else is `tool_unknown`. Two registered tools are never grantable by an import
(`tool_not_grantable`): code execution (`openwop:feature.code-exec.nodes.run`)
and raw HTTP egress (`openwop:core.openwop.http.fetch`). An admin can still
grant them later through the ADR 0104 override, as a separate, visible act.

The resolved tools go only into the imported agent's own allowlist. Nothing is
added to the ADR 0315 default-on baseline. As for every user agent, the
baseline is still offered on top (`effectiveToolAllowlist`).

### D9. Manifest validation

The converted manifest (`role: "skill"`, `handoff`, scratchpad-only memory,
`modelClass: "general"`, portable id `private.imported-skills.<name>`) is
validated with Ajv against the vendored `schemas/agent-manifest.schema.json`,
which carries the RFC 0131 Skill profile. A failure is `manifest_invalid`. The
validated manifest is stored in the provenance row as the portable form. The
runtime agent is the `user.<name>` row with `modelClass: "chat"` (the
user-agent enum).

### D10. Chat drivability is not offered

There is no chat tool or node for import. The source is a file an admin
uploads and reviews. A chat tool would let a model install a persona from text
it was shown, which is the injection path this ADR exists to close. It would
also be a registered tool no agent pack allowlists, which
`agent-tool-reach-ratchet` refuses.

### D11. No wire change

Routes live under `/v1/host/openwop-app/marketplace/skills/*` (host extension,
non-normative). RFC 0131 already defines `role`. No RFC is needed.

## Alternatives considered

- **Install through the signed marketplace lane with a trust exception.**
  Rejected. It needs either `ALLOW_UNSIGNED` or a per-pack bypass of
  `OPENWOP_PACK_TRUST_ENFORCE`, and it makes a tenant's import visible to every
  tenant.
- **Sign the import with a host key at import time.** Rejected. A signature
  would then mean "this host received it", not "a publisher vouches for it",
  and the trust tier would lie.
- **Fix the vendored bridge parser and call it.** Deferred. The pack is
  registry-owned. The fix belongs in `openwop-registry` and should land there
  (follow-up below). The host must not depend on a parser that reports bad input
  as success.
- **Run bundled scripts in the code sandbox.** Deferred (D5).
- **Warn on lures instead of refusing.** Rejected for the blocking rules. The
  ClawHavoc lures were all in this class, and an admin skimming a long skill
  file is the target.

## Consequences

- Most Claude Code skills that list `Bash` or `Read` are refused. That is
  correct for this host, and the error names the tool.
- A skill that needs a local binary or environment variable cannot be imported.
- An imported skill runs as a chat agent in its workspace (mention or scoped
  chat). Typed handoff dispatch of user agents is not wired; the manifest's
  `handoff` is recorded, not enforced, until user agents carry handoff schemas.
- Bundled reference files are not available to the agent.
- Deleting the agent from the Agents tab leaves a provenance row. The list
  route drops rows whose agent is gone. The row has no actor field; the actor is
  in the audit log and in the agent's revision 0 (ADR 1014 D8).

## Follow-ups

- `openwop-registry`: make `core.skills-bridge.convert` read `allowed-tools`,
  full YAML and JSON `metadata`, and fail with an error instead of
  `success` + `null`.
- A marketplace UI for import (preview, findings, acknowledge, install). Not in
  this slice.
- Handoff schemas on user agents, so an imported skill can be dispatched as a
  typed skill.

## Implementation record

| Item | Change | Tests |
|---|---|---|
| `CHAN-P5-1` | `features/marketplace/skillImport/*`, routes in `skillImportRoutes.ts`, sub-toggle `marketplace.skill-import` | `test/adr1044-skill-import.test.ts`, `test/adr1044-skill-import-routes.test.ts` |
| `CHAN-P5-2` | scripts and hooks refused (D5) | same files |
