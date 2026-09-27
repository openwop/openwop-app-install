# ADR 0631 — The origin serves the major-2 path space (and the SPA) on the same roots

Status: implemented (2026-09-05)

## Context — measured, not inferred

`spec/v2/path-manifest.json` roots the whole major-2 path space at the discovery
host (`serverUrl: https://{host}`). On production `app.openwop.dev` published a
v2 discovery document (`protocolVersions: ["1.1","2.0"]`, the 11-key closed root
under `OpenWOP-Version: 2`), but Firebase Hosting rewrote only `/api/**`,
`/.well-known/**`, `/v1/**`, `/`, `/p/**`, `/llms.txt` to Cloud Run; everything
else was `** → /app-shell.html`. So **14 of the 15 manifest roots answered
`200 text/html` with no `OpenWOP-Version` at the origin**, while the same paths
answered correctly on the direct `run.app` URL. The corpus steward's second-party
witness (crosstalk `fdc6`, 2026-09-05 03:07Z) found it: all 17 of its failures
were this one shape. This host's own witnesses had run against localhost or
`run.app` and were right about the code and wrong about the front door.
P4-SPEC-15 — *advertising a major is a claim about the path space* — was unmet
where it matters and met one hop behind it.

The constraint that makes this a decision rather than a config edit: the SPA's
own client routes intersect the manifest roots in exactly two segments,
**`agents`** (`/agents/:agentId`) and **`runs`** (`/runs/:runId`,
`/runs/:runId/audit`, 9 `navigate()` sites). Hosting cannot key a rewrite on a
request header.

## Options weighed

| | cost now | debt | forecloses | reversible |
|---|---|---|---|---|
| **A — route all 15 roots to the backend; the backend serves the SPA shell to a headerless HTML navigation and the API to anything naming a major** | small (hosting entries derived from the manifest, ~25 lines in one feature, `Vary`) | dual-purpose paths need `Vary` + `no-store`; SSE through the CDN stays buffered (already true for `/v1` at the origin) | nothing | yes |
| B — route the 13 non-colliding roots only | smallest | the two most-used roots stay dishonest; the rewritten corpus scenario fails on exactly those | — | yes |
| C — move the SPA's `/agents`, `/runs` pages | 9 navigate sites, deep links in the wild, i18n ×4 | UI churn for a wire concern; breaks bookmarks | — | painful |
| D — `api.openwop.dev` mapped straight to Cloud Run | domain mapping, CSP, `requestOrigin`, **and** `app.openwop.dev`'s discovery must stop claiming 2.0 (the path space is rooted at the discovery host) | two origins each claiming to be the host; every bundle/signature story doubles | keeps SSE off the CDN | yes |

**Dominant force: one host identity.** Discovery and its path space on one origin,
with no second owner for anything: the negotiator already owns "what an
unversioned path means", the ADR 0384 shell cache already owns the shell, the
ADR 0614 guard already owns "the wire is reachable at the origin". D solves a
symptom by splitting the identity the v2 charter is about. **Decision: A.**

## Decision

1. **Hosting** (`firebase.json`): every manifest root routes to Cloud Run ahead of
   the catch-all — both `/x` and `/x/**` (Firebase's `/x/**` does not match `/x`)
   and each `:`-operation (`/runs:bulk-cancel`, `/prompts:render`) as its own
   source. 26 sources, **generated from the vendored manifest**, never typed.
2. **Guard** (`check-hosting-wire-rewrites.cjs`, ADR 0614): derives the same
   sources from `schemas/v2/path-manifest.json` and fails on any missing one, one
   placed after the catch-all, an unreadable manifest, or a derivation that
   yields fewer than a plausible floor. A corpus root added upstream is red here
   until hosting routes it.
3. **Negotiator** (`middleware/protocolVersion.ts`): unchanged in behaviour —
   a request naming major 2 on a manifest root is rewritten onto `/v1` before any
   router; a headerless one stays major 1. Adds `Vary: OpenWOP-Version` on every
   unversioned response and exports the derived root list
   (`v2MountedRootPrefixes()`) so the one other consumer cannot drift.
4. **Fallthrough** (`features/publishing/routes.ts`, the shell's owner): on the
   manifest roots, a request with no version header whose `Accept` prefers HTML
   gets the cached SPA shell (`Cache-Control: no-store`, `Vary: Accept`); any
   other headerless request keeps the JSON 404 — a shell would be a lie to a
   program. Registered in the feature, not in core middleware, so no core→feature
   import exists.
5. **Witness**: `test/v2-origin-shell-fallthrough.test.ts` — six legs, red-first
   3/6 on the unfixed tree, and four sabotages each failing one leg (drop the
   Accept check → leg 3; register `/runs` only → leg 4; drop either `Vary` → leg 5).
   `verify-deploy.sh` probes a manifest root at the ORIGIN both ways after every
   deploy, so the front door is measured, not assumed.

## Known limitation, stated

SSE through the Firebase CDN is buffered. That is already true for
`/v1/runs/{id}/events` at the origin and was never witnessed there, because
`deploy.sh`'s certify lane boots locally. The first origin witness will measure
it; if red, the remedy is an absolute stream URL in discovery (if v2 admits one)
before any thought of option D. This ADR does not claim SSE at the origin.

## Companion — the deploy that could not be verified (same day)

`gcloud run deploy` built `5c5806778`, created revision `00668-224`, and printed
"revision [00691-hay] has been deployed and is serving 100 percent" — naming the
PREVIOUS day's revision: traffic was pinned by name, and Cloud Run resolves
"latest" by revision serial, which is not monotonic on this service. Only
`verify-deploy.sh`'s commit stamp (ADR 0518) noticed. `deploy.sh` now reads
`status.latestCreatedRevisionName`, proves it carries `$SHA` and is Ready, and
shifts 100% to it **by name**; `preflight-deploy.sh` prints the newest revisions
by creation time beside the serving one. Never `--to-latest`.

## Falsifiers

The origin witness shows the v2 SSE scenario failing on CDN buffering *and* v2
discovery cannot carry an absolute stream URL → D for streams; or the corpus
rules that a shell body on a v2 root under any request is itself a violation →
only C or D satisfy it.

> **CORRECTION 2026-09-05 05:05Z — two more front-door defects, found by the
> second-party witness against the origin the moment the rewrites were live
> (crosstalk `1d29`; 17 fails → 4).** (1) **Firebase Hosting decodes `%2F`
> before forwarding**, so a tenant-bound id `tenant%2Fopaque` reached the
> backend as `/runs/tenant/opaque` — a path it correctly had no route for —
> and every read, poll, cancel and stream of a run created at the origin
> answered 404 at the origin. The negotiator now re-encodes the decoded
> spelling before routing (`DECODED_BOUND_RUN_ID`): unambiguous because no
> sub-resource under `/runs/{id}` exceeds 12 characters and the opaque grammar
> is 16–128; the path guard's tenant check is unchanged. Witness
> `test/v2-origin-decoded-bound-id.test.ts` (5 legs, 3 disjoint sabotages).
> (2) **Create/fork links were built from `req.protocol` + `req.get('host')`**
> — behind the rewrite that is the internal `http://…run.app` — instead of the
> forwarded-aware `requestOrigin()` the rest of the host uses; a client
> following them left the origin and downgraded the scheme. Fixed at the three
> sites; witness `test/v2-create-links-origin.test.ts`. rc.44 makes the link
> rule normative. The `poll-cursor-v2` red at the origin was (1), not Gap C.
> **Lesson for §Decision:** a hosting layer is part of the wire; every id
> encoding and every absolute URL the backend emits must be witnessed THROUGH
> it, not beside it. The direct `run.app` witness could not see either defect.
