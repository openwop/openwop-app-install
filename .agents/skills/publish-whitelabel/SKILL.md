---
name: publish-whitelabel
description: Build the downloadable white-label demo-app zip from this repo (openwop-app) and publish it as a public GitHub release asset for the /install/ download on openwop.dev. Builds via scripts/build-whitelabel-zip.sh (git archive HEAD → strip .env*/steward meta → sha256), uploads the zip + sidecar to a rolling `whitelabel` release on openwop/openwop-app (stable download URL), and verifies the public download + sha256 match. Use after demo-app changes merge and the /install/ download should reflect them.
---

# Publish the white-label demo-app download

The downloadable white-label app advertised on **openwop.dev/install/** is a
source zip of THIS repo (`openwop/openwop-app` — the app, now **public**). The
zip is published as an asset on a **rolling GitHub release** here, which gives a
stable public URL that the openwop-site `/install/` page links to:

```
https://github.com/openwop/openwop-app/releases/download/whitelabel/openwop-demo-app.zip
https://github.com/openwop/openwop-app/releases/download/whitelabel/openwop-demo-app.zip.sha256
```

openwop-app owns the whole publish (build + release). openwop-site only links the
URL — no cross-repo file copy, no binary committed to git anywhere.

## Prerequisites

- `gh` authed with write access to `openwop/openwop-app`.
- `zip` / `unzip` on PATH (the build script uses them).
- You're on a clean `main` at the commit you want to ship — the zip is
  `git archive HEAD`, so uncommitted changes are NOT included.

## 1. Build the zip

```bash
bash scripts/build-whitelabel-zip.sh
# → dist-whitelabel/openwop-demo-app.zip + .sha256
```

Expect `[whitelabel-zip] done — NNNN KB` and the printed sha256. The build is
deterministic per commit — re-running on the same HEAD yields an identical zip.

## 2. Sanity-check the bundle (no secrets, has the app)

```bash
Z=dist-whitelabel/openwop-demo-app.zip
unzip -l "$Z" | grep -ciE '/\.env'                                 # MUST be 0 (no leaked steward env)
unzip -l "$Z" | grep -c 'openwop-demo-app/backend/'                # > 0
unzip -l "$Z" 'openwop-demo-app/frontend/react/WHITE-LABEL.md' >/dev/null && echo "WHITE-LABEL.md present"
unzip -l "$Z" | grep -c 'openwop-demo-app/.Codex/'                # MUST be 0 (steward agent tooling)
```

The zip intentionally ships `firebase.json` / `.firebaserc` / `deploy/` with the
steward's target names — `WHITE-LABEL.md` walks adopters through reconfiguring.
Only `.env*` (secrets) and steward repo-meta (`.Codex/`, `.github/`,
`MIGRATION-TODO.md`) are stripped.

## 3. Publish as a rolling release asset

> **Prefer the attested CI path for real publishes.** Triggering the
> **`Publish white-label zip`** workflow (Actions tab →
> `.github/workflows/publish-whitelabel.yml` → *Run workflow*) does this same
> build + upload from a trusted CI runner AND attaches a sigstore
> build-provenance attestation, so downloaders can `gh attestation verify` the
> zip (see step 4). The local `gh release upload` below is fine for a quick
> manual push but produces **no** attestation.

```bash
TAG=whitelabel
# Create the rolling release once; thereafter just re-upload with --clobber.
gh release view "$TAG" --repo openwop/openwop-app >/dev/null 2>&1 || \
  gh release create "$TAG" --repo openwop/openwop-app \
    --title "White-label demo app (rolling)" \
    --notes "Latest white-label source bundle of openwop-app, rebuilt from HEAD on each publish. Download from /install/ on openwop.dev. Verify with the .sha256 sidecar." \
    --latest=false

gh release upload "$TAG" --repo openwop/openwop-app --clobber \
  dist-whitelabel/openwop-demo-app.zip \
  dist-whitelabel/openwop-demo-app.zip.sha256
```

Re-uploading with `--clobber` keeps the URL stable across publishes (the tag does
not move; only the assets are replaced). Note the published commit in the release
notes if you want per-publish provenance: `gh release edit "$TAG" --notes "… (HEAD $(git rev-parse --short HEAD))"`.

## 4. Verify the public download

```bash
URL=https://github.com/openwop/openwop-app/releases/download/whitelabel/openwop-demo-app.zip
curl -sL -o /dev/null -w "zip: HTTP %{http_code}\n" "$URL"
echo -n "published sha: "; curl -sL "$URL.sha256" | awk '{print $1}'
echo -n "local sha:     "; awk '{print $1}' dist-whitelabel/openwop-demo-app.zip.sha256
# ^ the two MUST match (GitHub serves the asset directly; no CDN-staleness window)
```

If the asset was published via the **`Publish white-label zip` GitHub Actions
workflow** (`.github/workflows/publish-whitelabel.yml`), it also carries a
sigstore build-provenance attestation. Verify the download was built by this
repo (not just that a hash matches whoever wrote the sidecar):

```bash
curl -sL -o openwop-demo-app.zip "$URL"
gh attestation verify openwop-demo-app.zip --repo openwop/openwop-app
```

## 5. Point the site at it (openwop-site — one-time / on URL change)

The openwop.dev `/install/` page links the stable release URL above. That edit
lives in **openwop-site** (`public/index.html` / the install page + its sha256
display), not here. It only changes when the URL changes — with the rolling
`whitelabel` tag, it never does, so step 5 is a one-time wiring, not per-publish.

## Notes

- **openwop-app is the source of truth for the white-label bundle** (build +
  release). openwop-site may carry a legacy `publish-whitelabel` skill from the
  split that builds from `public/downloads/` + `firebase deploy` — that's stale
  (it has no app source to build from). Slim it to "the /install/ page links the
  openwop-app release asset," or remove it in favor of this one.
- **Rolling tag, not per-version.** A single `whitelabel` tag with `--clobber`
  keeps the /install/ URL stable. If you ever want immutable per-release bundles,
  switch to `gh release create vX.Y.Z` and update the /install/ link each time.
