# ADR 0291 — White-label branding + demo/enterprise posture for the native shells

Status: implemented (2026-07-06)

## Context

The app has a complete white-label story for its two deployables: the SPA
(`VITE_BRAND_*` env + `src/brand/brand.css`, per `frontend/react/WHITE-LABEL.md`)
and the backend (`OPENWOP_SERVICE_*` / posture env). The native shells shipped
by ADR 0181 (Electron `clients/desktop/`, SwiftUI `clients/ios/`) predated that
lens: they hardcoded the OpenWOP identity (product name, `dev.openwop.*` ids,
the OpenWOP mark, clay accent) and a demo affordance (the
"Use the hosted demo (app.openwop.dev)" quick-connect, an
`app.openwop.dev` Help link) into source. A white-label adopter — whose bundle
(`scripts/build-whitelabel-zip.sh`, ADR 0052) already includes `clients/` via
`git archive` — had no seam to rebrand the shells and no way to remove the
OpenWOP demo affordances for an enterprise install.

## Decision

1. **The shell brands only its pre-connection chrome.** Setup screen, native
   menu, packaged app name/id/icon. Everything post-connect is the host
   origin's *server-served* SPA, which already carries the `VITE_BRAND_*`
   white-label identity — so the web re-brand IS the shell re-brand, and the
   shell seam must never grow into a second brand resolver. The shell seam
   mirrors the SPA vocabulary (`productName` ↔ `VITE_BRAND_PRODUCT_NAME`).

2. **One config file per shell, tolerant like `settings.js`.**
   - Desktop: `clients/desktop/branding.json`, validated by the pure
     `src/branding.js` (missing/corrupt/partial ⇒ stock OpenWOP defaults,
     field-by-field; never a throw). Consumed at runtime by `main.js` (menu,
     locked-host pinning, the file://-gated `setup:branding` IPC) and the setup
     page; at build time by `tools/apply-branding.js` (syncs
     `build.productName`/`build.appId` into `package.json`, the only fields
     electron-builder can read) and `tools/make-icon.js` (`iconSvg` +
     `iconPlate`). `OPENWOP_SHELL_BRANDING=<path>` overrides the bundled file
     (self-test hook; same local-machine trust as `settings.json`).
   - iOS: `OWP*` Info.plist keys authored in `project.yml`, read by
     `Sources/OpenWOP/Branding.swift` (same fallback rule; host fields
     validated through the existing `HostSettings.parseHostOrigin` parity
     logic).

3. **Two shell postures.**
   - `mode: "demo"` (stock): the setup screen offers the hosted-demo
     quick-connect (`demoHost`, default `app.openwop.dev`).
   - `mode: "enterprise"`: every demo affordance is removed — `demoHost` is
     **force-cleared at validation time** so a leftover config entry can never
     resurface it. Optional `lockedHost` pins the shell to one origin: the
     setup surface and "Change Server…" / the iOS gear never render, and
     `lockedHost` beats any saved host so a stale `settings.json` /
     UserDefaults entry cannot unpin an enterprise build. Access control
     itself stays where it belongs: the SHELL-1 recipe
     (`VITE_BRAND_APP_GATE_MODE=sign-in` + `OPENWOP_DEPLOY_POSTURE=auth` +
     SSO) — the shell inherits the sign-in gate by rendering the host's SPA.

4. **The shells are part of the white-label deliverable.**
   `build-whitelabel-zip.sh` gains a presence guard for
   `clients/desktop/branding.json`, `clients/desktop/src/main.js`,
   `clients/ios/project.yml`, and `clients/ios/Sources/OpenWOP/Branding.swift`
   (same pattern as the deploy-pack/corpora guards). Documentation lands in
   both client READMEs (§ White-labeling), `WHITE-LABEL.md` §6, and the root
   README.

## Alternatives weighed

- **Reuse the SPA's `VITE_BRAND_*` env at shell build time** — rejected: the
  shells are not Vite builds, and env-at-package-time is invisible/undeclared
  config for an adopter editing a checked-in file; a tracked JSON/plist is
  greppable, diffable, and validated.
- **Fetch branding from the connected host** (e.g. `/.well-known/openwop`) —
  rejected for the pre-connection chrome: the setup page renders *before* any
  host exists, and a remote origin must never influence shell chrome (same
  threat model as the file://-gated `setup:save-host` IPC).
- **Separate enterprise build target** (compile-time flag) — rejected: a
  posture field in the same config keeps one artifact pipeline and lets the
  self-test assert both postures.

## Verification

- `clients/desktop`: `node --test` (branding validation, posture rules,
  builder sync — plus the existing url/settings/serverManager suites).
- `npm run selftest` now also asserts the setup page renders the branded
  `productName` and that the demo quick-connect exists exactly when the
  posture says demo; a `lockedHost` build must load the pinned origin directly
  (setup legs recorded as honestly skipped).
- iOS: `xcodegen generate` + simulator build (`CODE_SIGNING_ALLOWED=NO`).
- Bundle: `bash scripts/build-whitelabel-zip.sh` passes the new shells guard.

## Consequences

- Adopters rebrand the desktop shell by editing one JSON + two commands
  (`apply-branding`, `make-icon`); iOS by editing `project.yml` and
  regenerating. No Swift/JS edits, no fork of shell logic.
- The stock build remains byte-identical in behavior (defaults == the tracked
  `branding.json`, pinned by a test so the two can't drift).
- Follow-on (unchanged from ADR 0181's remaining steps): signing/notarization
  and store distribution are credential-gated; a future installer (ADR
  0052/0182) could stamp `branding.json` at download time.

## Addendum (2026-07-06, same day): fork guard + cross-platform packaging

Two follow-ons landed after the initial merge (#1394):

1. **`scripts/check-branding.sh` now scans the shell configs.** The fork
   guard's web-bundle scan gains a source-level pass over
   `clients/desktop/branding.json`, the desktop `package.json` builder
   identity (catches an edited branding.json without `apply-branding`), and
   `clients/ios/project.yml` — flagging a still-OpenWOP product name, a
   `dev.openwop.*` id, or a demo/help host pointing at the steward's
   `app.openwop.dev`. Skippable via `OPENWOP_SKIP_SHELL_BRANDING=1` for forks
   that don't ship the shells. Like the web half, it is EXPECTED to flag
   upstream (upstream IS OpenWOP).

2. **Windows/Linux artifacts build on macOS** — ADR 0181's "platform-gated"
   assumption was too pessimistic for packaging (only *signing* is gated).
   Three metadata defects blocked it, all fixed: the scoped npm name
   (`@openwop/desktop`) produced a path-unsafe Linux `executableName` (now
   explicit, and `apply-branding` slugs it from the branded product name);
   deb required `homepage` (now ridden off the branded `helpUrl`) and an
   `author` email; the package was renamed `openwop-desktop` so artifact
   paths don't nest under `dist/@openwop/`. NSIS (Windows) and AppImage/deb
   (Linux) now build unsigned from macOS.
