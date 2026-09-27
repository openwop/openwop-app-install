# ADR 0503 — Cloud SDKs: optionalDependencies vs optional peerDependencies

Status: Rejected

## Context

Four cloud SDKs back the BYOK KMS layer, all declared `optionalDependencies` in
`backend/typescript/package.json` and loaded through a lazy, non-literal
`import()` so typecheck and build stay green when a deployment omits them:

```
@aws-sdk/client-kms   @azure/identity   @azure/keyvault-keys   @google-cloud/kms
```

That declaration has now produced two distinct problems.

**1. npm ≥ 11.5 prunes their transitive dependencies.** On `npm install`,
`@azure/identity` and `@azure/keyvault-keys` install *without*
`@azure/core-rest-pipeline`, so `import('@azure/identity')` throws
`ERR_MODULE_NOT_FOUND` naming a package nobody chose. Measured A/B inside the
runtime image, same lockfile and command, only npm differs:

| npm | packages | `@azure/identity` |
| --- | --- | --- |
| 10.9.8 (what `node:22-slim` pins) | 466 | loads |
| 11.6.2 | 464 | `ERR_MODULE_NOT_FOUND` |

#2680 switched the Dockerfile to `npm ci` so the build installs the lockfile
exactly and is immune to whichever npm the base image bundles. That closes the
*build* exposure. It does not change the fact that a local `npm install` on a
modern npm still produces a broken tree and rewrites the lockfile with the
pruned resolution — churn that must never be committed, because `npm ci` would
then install it faithfully for everyone.

**2. Every deployment pays for all four clouds.** `optionalDependencies` are
installed by default, so a GCP-only deployment (the demo, and the common
white-label case) ships the AWS and Azure SDKs it will never load.

## Decision: REJECTED

The proposal below was **rejected** on review (2026-08-01). It is kept in full
because the reasoning trail is the point — the alternatives it weighed are still
the right ones, and the evidence that killed it is what a future revival needs.

**Why it was rejected.**

1. **The cited precedents do not transfer.** MongoDB's driver and the Snowflake
   connector are LIBRARIES; `peerDependencies` means "the consuming package must
   provide this." `backend/typescript` is the ROOT application package — there is
   no consumer. npm does not auto-install optional peers of the root, so the
   operator would need an explicit `npm install @azure/keyvault-keys
   @azure/identity`. The pattern's precondition simply does not hold here.

2. **It does not achieve its own second goal.** pnpm's `autoInstallPeers` defaults
   to TRUE and installs optional peers anyway (pnpm/pnpm#11155), recording them as
   direct deps; yarn berry has its own non-honoring bug (yarnpkg/berry#4653).
   Operators pick their own package manager, so the image-size benefit evaporates
   for two of three major ones while the breaking change lands on all three.

3. **The status quo already works for self-hosters.** The `/install` bundle is
   `git archive HEAD` and `package-lock.json` is tracked, so adopters receive the
   correct lockfile; `scripts/check-whitelabel-build.sh` smoke-tests the adopter
   path with `npm ci`. The distributed path is already the immune one.

4. **The closest real comparable disagrees.** Directus — a mature, heavily
   self-hosted Node app with the same shape — uses `optionalDependencies` for its
   multi-backend drivers (`pg`, `mysql2`, `oracledb`, `sqlite3`, `tedious`) and
   wraps cloud SDKs in thin FIRST-PARTY adapter packages. It does not use
   peerDependencies for this.

**What was done instead.** The affected npm range is now bounded by measurement,
inside the runtime image, same lockfile and command:

| npm | packages | `@azure/identity` |
| --- | --- | --- |
| 10.9.8 | 466 | loads |
| 11.6.2 | 464 | `ERR_MODULE_NOT_FOUND` |
| 12.0.2 | 466 | loads |

So the bug is confined to a 11.5–11.x window and is FIXED in npm 12. `engines.npm`
now records `>=10 <11.5 || >=12`. Deliberately advisory (npm warns; no
`engine-strict`): the fault is in `npm install`'s fresh resolution, while `npm ci`
produces a correct tree even on 11.6.2 — so hard-enforcement would block a safe,
documented command for no safety gain. The real detector is already shipped:
`test/kms-backend-preflight.test.ts` fails loudly if any of the four SDKs cannot
import, and `preflight()` reports it at boot.

### Alternatives weighed

- **Keep `optionalDependencies`, rely on `npm ci`.** The status quo after #2680.
  Correct today and zero migration cost, but it leaves every deployment carrying
  three unused cloud SDKs, and it keeps the local-dev breakage and the lockfile
  churn trap alive for anyone on npm ≥ 11.5.
- **Promote them to hard `dependencies`.** Kills the pruning bug outright and is
  the simplest change, but forces all four SDKs on every deployment
  unconditionally — the worst outcome for image size and supply-chain surface,
  and it contradicts the "a non-using host never installs it" intent recorded in
  `kmsBackends.ts`.
- **Vendor a thin KMS client per cloud instead of the vendor SDKs.** Removes the
  dependency question entirely, but re-implements request signing and credential
  discovery for three clouds. Not justified by the size of the problem.

## Consequences

This is a **breaking change for existing self-hosters** and for the `/install`
white-label bundle: an operator on AWS or Azure who upgrades and does not install
their SDK will boot to an explicit error instead of a working KMS backend. That
is the cost, and it is why this is Proposed rather than Accepted — it needs a
release note, a `DEPLOY.md` entry naming the per-backend install command, and a
decision about whether the `/install` bundle pins a default.

The demo deployment is unaffected: it uses GCP KMS, which would remain installed.

Two things do NOT change: `npm ci` in the Dockerfile stays (it is correct
independently, and still guards a future base-image npm bump), and the
never-commit-the-lockfile-churn rule stays until the pruning path is gone.

## Open questions

1. Does the `/install` bundle ship with one backend pre-selected, or none?
2. Should `preflight()` escalate from "log an error" to "fail boot" once the SDK
   is an explicit operator choice rather than something npm may have silently
   pruned? The current lenient posture was chosen precisely because the absence
   might not be the operator's fault. Under this ADR it always would be.
