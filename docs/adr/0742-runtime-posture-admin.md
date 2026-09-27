# ADR 0742 — Runtime posture admin: read live, request changes, never self-apply

Status: implemented

## Context

ADR 0741 switched `openwop-app-backend` to CPU always allocated after measuring
that throttling starved every in-process background loop. The owner then asked
(relayed through the corpus session) for a superadmin setting to flip the
posture between WARM (min 1 instance, CPU always allocated) and COLD (min 0, CPU
throttled) from the admin UI. The relayed design had the backend hold a
dedicated service account with `run.services.update` on its own service.

## Decision

**The host reads its posture live and issues audited change requests. It never
applies one.** The owner chose this over the relayed design (2026-09-22) after
this constraint was put to him directly: **`run.services.update` cannot be
scoped to min-instances and CPU.** The same permission changes the container
image, env and secrets, so "accepts only `{ warm: boolean }`" would be enforced
by our code and not by IAM. A compromised backend holding it could redeploy
itself with an attacker's image, a persistence path that does not exist today.

- `GET /v1/host/openwop-app/runtime-posture` (superadmin) reads the Cloud Run
  Admin API v2 as the runtime SA. The only IAM change is **`roles/run.viewer` on
  `openwop-app-backend`**, read-only, granted with the owner's approval. The
  posture shown is the **serving revision's** own config (the one holding 100 %
  of traffic), never the service template. A config change whose revision sits
  at 0 % (ADR 0631: traffic is pinned by name) is reported as `not-live`, naming
  both revisions. Split traffic is also `not-live`. Off Cloud Run it answers
  `available: false`: the page never shows a posture it did not read back.
- `POST …/runtime-posture/change-requests` accepts **exactly** `{ warm: boolean }`.
  Any other key or shape gets `400`, and nothing is written. It audits
  `runtime_posture.change_requested` with who, when, from, to, the serving
  revision and any pending one, and returns the exact commands:
  `update --min-instances N --[no-]cpu-throttling`, read the created revision,
  confirm it is Ready, then `update-traffic --to-revisions "$REV=100"`. The
  commands are built from the two named postures only; no caller string reaches
  them. If the posture is unreadable, no request is issued (`409`).
- The page shows both options with a cost estimate computed from the serving
  revision's own CPU and memory at list price (clearly labelled an estimate), and
  says that a change rolls out a new revision that is live only once it serves
  100 %.

## Alternatives weighed

- **As relayed (host holds `run.services.update`).** Rejected for the reason
  above: the scope cannot be narrowed in IAM.
- **Cloud Function / Workflow with the write permission, called by the host.**
  Moves the credential out of the web tier, but the host could still trigger
  arbitrary calls unless the function itself pins the two postures. That is a
  reasonable later step if one-click apply is wanted.

## Finding recorded, not acted on: the runtime SA is also the build SA

Investigated on the owner's instruction ("investigate, don't change"). The
runtime service account is the project's default compute SA, and **Cloud Build
runs as the same account**: `gcloud builds list` shows its `serviceAccount`.
That is why it holds `roles/artifactregistry.writer`: builds push images with
it. Nothing at runtime needs it. The app-builder Cloud Run deploy adapter uses
the host identity, but it needs `OPENWOP_APP_DEPLOY_GCP_PROJECT`, which
production does not set, and `run.admin`, which the SA does not hold. So today
the web tier can write to the registry that deploys pull from.
**Recommendation (owner decision):** give the service a dedicated runtime SA
with only what the app uses (`cloudsql.client`, `logging.logWriter`,
`storage.objectViewer` on the evidence bucket, `secretAccessor` on the bound
secrets, `run.viewer` on this service) and leave the compute SA to Cloud Build.
Tracked as `WHD-30`.

## Verification

- `backend/typescript/test/adr0742-runtime-posture.test.ts` (13): the exact-body
  validation, including extra `image` / `env` / `maxInstances` keys; the
  0 %-traffic revision reported `not-live` with the SERVING posture; split
  traffic; posture mapping; cost; commands with no `--to-latest` / `--image` /
  env flags. HTTP tests: anon 403; off Cloud Run `available:false` and `409`; an
  extra field refused `400` **with the posture readable** and no audit row
  written; a 0 %-traffic change reported not-live; `{warm:true}` → `201`, an
  audit row, and **no non-GET call to the Admin API**.
- `frontend/react/src/settings/__tests__/runtimePosturePage.test.tsx` (3): a
  failed or unavailable read offers no change request; a 0 %-traffic change is
  shown not-live, naming both revisions.
- Sabotage: see the PR.

## Correction 2026-09-23 — three defects found on rev 00737-vkq, and one of them was not in this feature

A peer session exercised the shipped page against production and reported three
defects. The first two were in this ADR's own code; the third was pre-existing and
is the one worth reading.

1. **The page read before the caller's authority resolved, and reported the 403 as
   a broken read.** `useEffectiveAccessState()` answers `superadmin:false` while it
   is still resolving, so the first fetch went out unauthorized and the page
   rendered the "could not read posture" card — a failure card blaming Cloud Run
   for an authorization outcome. Fixed: the read waits for `resolved`, and a 401/403
   renders a distinct denied card (`rpDenied*`, four locales) carrying
   `superadminHint()`. `client/runtimePostureClient.ts` now throws a typed
   `RuntimePostureRequestError` carrying the status, because a page cannot tell those
   apart from a message string.

2. **`superadminHint()` named a way in that does not exist.** It offered an
   admin-bearer clause unconditionally, including on deploys with no wildcard key
   configured. It now names the allowlist always and the cross-tenant-key clause
   only when `wildcardApiKeyConfigured()` is true. Extracting that predicate
   required a new leaf module (`middleware/apiKeyTenants.ts`): importing it from
   `middleware/auth.ts` created an ESM cycle that put `undefined` into
   `BACKEND_FEATURES`, which surfaced as an unrelated cross-org test failure.
   `test/feature-registration-order.test.ts` now has a tripwire for that class.

3. **Superadmin was scoped to the ACTIVE WORKSPACE, so an allowlisted operator lost
   it by switching workspaces** (`host/superadmin.ts`, pre-dating this ADR and
   affecting every admin surface, not just this page). `isSuperadmin` matched
   `OPENWOP_SUPERADMIN_TENANTS` against `req.tenantId` only, which becomes
   `ws:<uuid>` after a switch. **Decision (owner, "follow the person"): the
   allowlist is also matched against the caller's own `personalTenant`, guarded by
   `isPersonalTenantId` so only the single-principal shapes (`user:` / `anon:`)
   count.** The guard is the load-bearing half — the SAML ACS mints ONE
   host-global `OPENWOP_SAML_TENANT` for every SAML user (USERS-19 / ADR 0617 D2),
   and honouring that shape would hand superadmin to a whole workforce. The
   workspace-scoped check protected nothing (the same human switches back and
   acts); what it produced was an unexplained 403 plus a hidden nav entry, since
   `routes/accessControl.ts` projects this same predicate to the SPA.
   `isSuperadminTenant` is deliberately NOT widened: its one caller
   (`host/approvalAudience.ts`) asks about a ROW's tenant and has no caller
   identity to guard by shape.

- Verification: `test/superadmin-follows-person.test.ts` (10),
  `test/adr0742-runtime-posture.test.ts` (+2 hint cases, 15),
  `frontend/react/src/settings/__tests__/runtimePosturePage.test.tsx` (7).
  Sabotage-proved both ways: dropping the shape guard reds the SAML case;
  dropping the personal branch reds the workspace-switch case.

  The two branches this change did NOT touch are now pinned too, because
  "unchanged" had been established by reading the diff and a diff does not
  survive the next edit. Removing the wildcard-bearer branch reds one leg;
  loosening it from `includes('*')` to a truthy-tenants test reds a different
  one (ADR 0561 made scoped keys the default, so `tenants: ['acme']` must grant
  nothing); making dev-open fire on truthiness instead of the exact string
  `"true"` reds two. Each was run and reverted, not asserted.

- **How the allowlisted identity was established**, recorded because it took a
  layered 403 to find and the next person should not repeat it. The tenant is
  `"user:" + sha256(`${OPENWOP_OIDC_ISSUER}:${firebase_uid}`).hexdigest()[:32]`
  (`middleware/auth.ts` `personalTenantForSubject`). With the deployed issuer
  `https://securetoken.google.com/openwop-dev`, the uid from the Identity
  Toolkit lookup derives:

  | account | derives | listed in `OPENWOP_SUPERADMIN_TENANTS` |
  | --- | --- | --- |
  | the owner's account | `user:c51185914124375f328788edbc4a29f8` | **yes** — it is the single entry |
  | `admin@myndhyve.ai` | `user:b8b86275b3eead07eaa4d3a1136a22b2` | no |

  So the owner always WAS the superadmin, and the MyndHyve account never would
  have worked whatever the gate did — the SPA's `tier: 'admin'` workspace-role
  guard stopped it one layer earlier, with different copy, which is what made
  the two failures look like one problem. Deriving the hash is how to answer
  "is this person the superadmin" without guessing; the uid comes from
  `POST https://identitytoolkit.googleapis.com/v1/projects/openwop-dev/accounts:lookup`
  with an `x-goog-user-project` header (ADC refuses without it).

  Diagnostic order for any future 403 on an admin surface, cheapest first: the
  Cloud Run service IAM policy, then the SPA's client-side `tier: 'admin'`
  workspace-role gate (`chrome/features.tsx` — a different refusal with
  different copy), then this server-side allowlist. Cloud Run request logs
  redact the hash as `user:***` but leave `anon:` ids in the clear, so a
  pre-auth request is identifiable from the logs even when the identity is not.
