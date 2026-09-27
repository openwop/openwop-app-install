# ADR 0730 — Phase C: the surfaces with no v2 home get one

Status: implemented — C.1, C.2, C.3a and C.4 shipped; **C.3b REVERTED** (see the correction below)
Date: 2026-09-18
Relates to: ADR 0642 (v1 EOS 2026-12-04), ADR 0647 (SPA v2 seam), ADR 0654 (run-list/delete/events-token → host-ext), ADR 0652 / RFC 0181 (the vendor path namespace), ADR 0723 / 0726 (bound ids), `spec/v2/core/versioning.md`, `spec/v2/core/capabilities.md` §3.2/§4.

## Context

v1 support ends 2026-12-04 (clock-bound, ADR 0642). `scripts/check-v1-reliance.mjs`
measures the surface that must survive it: **10 SPA protocol call sites**, and two
client reads that go through a v1-only SDK (`v1Client` in `client/runsClient.ts`)
— `discovery.capabilities()` and `runs.debugBundle()`.

Two of those surfaces have **no v2 home at all**, which is why they were left:

- **`/runs/{runId}/debug-bundle`** is absent from `spec/v2/path-manifest.json`
  (43 paths, measured at corpus 2.5.0). The v2 root DOES carry
  `capabilities.production.debugBundle` — but that block advertises truncation
  and redaction BEHAVIOUR, not an endpoint. Raised with the corpus steward.
- **`capabilities.hostSurfaces`** is not a corpus field in either major. It
  appears ZERO times in `spec/v1/capabilities.md`; it is this host's own
  advertisement of the normative `host.*` surfaces from `host-capabilities.md`.
  The v2 root is `additionalProperties: false` over 89 declared keys and does not
  include it — and `capabilities.md` §4 deleted exactly this class of key:
  "advisory self-declarations the wire cannot falsify", which an
  `implementation: 'in-memory'` tag is.

## Decision

**C.1 — `debug-bundle` gets a host-extension TWIN, no RFC.** The handler is
registered on both `v1('/runs/:runId/debug-bundle')` and
`vendorTwin('/runs/:runId/debug-bundle')` — one handler, two addresses, the
established pattern (`routes/streams.ts` events-token, and ADR 0654's run
list/delete). The SPA fetches the twin directly instead of `v1Client.runs.debugBundle`,
so the dependency survives v1 retirement. Host-extension routes are
non-normative (RFC 0181) and need no RFC; if the corpus later gives the
operation a protocol path, the twin becomes the overlap spelling.

**C.2 — `hostSurfaces` moves to `extensions["openwop-app.host-surfaces"]`.**
Registered through the existing `registerV2Extension` seam — which was built,
tested, wired into the v2 root, and carrying **zero records** until now. The
record is a FUNCTION, not a snapshot: the registry is populated by Phase-3
adapters during boot, so a value captured at registration time would advertise
an empty host. The SPA banner reads both homes through the overlap (v1 nest
first, extensions second); the first arm dies with v1.

**C.3 — the capabilities remap, and `v1Client` is RETIRED.**

The architect pass called this "a client-side read remap I own". **That was
wrong, and measuring it first is what caught it:** the live v2 root served
**19 keys** where v1 served 71, and `auth`, `prompts`, `secrets`,
`modelCapabilities` and `aiProviders` were **all absent**. The schema having a
slot is not the host filling it. So C.3 has a prerequisite the plan did not
have:

**C.3a — advertise the five families, derived from the v1 sources.** Each record
is `{status, since, witness, …facets}` and each is gated exactly as its v1
advert is, so a family absent from a deployment means "not served here", never
"we forgot". `spec/v2/declaration.json` gives all five an empty
`floorScenarios`, so advertising them obliges FACETS, not a scenario floor —
and every facet here is something this host genuinely implements (SAML/SCIM/OIDC
lanes, the RFC 0027 prompt endpoints, the BYOK resolver, the model-capability
probe). The emitted root validates against the CLOSED corpus schema.

Two shape differences are recorded rather than papered over:
- `auth.lanes[]` replaces `auth.profiles[]`, and a lane row is a CLAIM
  (`lane`, `issuers`, `revocation`, `minimumAssurance`) — stated conservatively:
  every lane is `bearer` assurance because this host issues no
  sender-constrained credential.
- `aiProviders.authModes` is a flat mode VOCABULARY in v2 where v1 carries a
  per-provider MAP. The map does not fit the core facet, so it travels in
  `extensions["openwop-app.ai-providers"]` — the `hostSurfaces` pattern.

**C.3b — the reads move and the client goes.** `getCapabilities()` reads the v2
root through the v2 SDK with **no v1 fallback** (a fallback would make every
"the SPA is on v2" test pass while production stayed on v1 — the vacuity shape
this host keeps paying for), the four consumers are remapped, and the
`Capabilities` TYPE moves to the v2 SDK because the document genuinely differs
(v1's `supportedEnvelopes` is an array, v2's a record). `v1Client` is deleted.

**C.4** — the SPA's remaining v1 protocol reads move to the major-2 client,
each family behind ONE owner: a shared `getWorkflowDefinitionRaw` for the four
modules that each held their own definition fetch, `getRun` for the walkthrough
snapshot, and the SDK's `prompts` surface for the library.

> **CORRECTED before implementation — the plan's own inventory was wrong, and
> the way it was wrong is the reusable part.** This paragraph read "agents ×6,
> runs ×2, workflows ×3". **MEASURED: all six "agents" sites are PROSE** —
> docstrings and inline comments naming `GET /v1/agents`, with zero `fetch(` in
> any of those six files. The agents family needed no migration at all.
>
> That breakdown came from a grep for the literal `/v1/` that did not separate
> code from comments. The ratchet (`check-v1-reliance.mjs`) was NOT the source
> and does not have this defect — it was corrected for exactly this class on
> 2026-09-10 and its count of 10 was accurate. The planning measurement was the
> polluted one. Re-measured by classifying every hit: **62 mentions, 51 of them
> comments, 11 real code sites** — and of those 11, three were never OpenWOP
> wire dependencies at all (a devtools path-prefix classifier, and two reads of
> the separate pack registry, which versions its own API independently of this
> wire). The true migration surface was **eight**, in different files than the
> plan named.
>
> The lesson is not "greps need care". It is that a count carried forward from
> planning into an ADR acquires authority it never earned: the number was
> written down once and then cited, and nothing between writing and citing
> re-derived it. Re-measure at the point of use.

## Correction recorded during implementation

The first cut of the C.1 witness asserted that the major-2 bare-root path
(`GET /runs/{id}/debug-bundle` with `OpenWOP-Version: 2`) must 404, on the
assumption that the v2 path space is closed. **It is not.**
`spec/v2/core/versioning.md` §21: a host "MUST REACH, under that major, every
operation named in `spec/v2/path-manifest.json`" — a **floor**, not a ceiling.
Nothing forbids serving more, and this host's major-2 routing is a rewrite onto
the v1 handlers (`req.url = '/v1' + req.url`), so every v1 path answers at the
bare root. The assertion was wrong, not the host; it now pins the measured
behaviour, including the detail that makes the twin worth having: the id comes
back in the DIALECT OF THE ADDRESS — tenant-bound on the major-2 protocol path
(ADR 0723/0726), bare on the host-extension twin (v1 dialect, RFC 0181).

## Consequences

- `getDebugBundle` no longer reaches through `v1Client`; one of its two call
  sites is gone, and the other (`discovery.capabilities()`) is C.3.
- The v2 root stays closed and schema-valid; the surface inventory is honestly
  vendor-scoped rather than smuggled into a core key.
- Registration is not reachability: the witnesses assert the SERVED response on
  each address, which is the failure a peer host shipped past 17 green tests
  (a seam mounted where a middleware rewrote the address before routing).

## Implementation record

| Task | Change | Witness |
|---|---|---|
| C.1 | `routes/runs.ts` twin registration; `client/runsClient.ts` fetches the twin | `adr0730-phase-c-v1-retirement.test.ts` — twin serves; v1 path identical; bare-root major-2 answers with a BOUND id while the twin answers bare |
| C.2 | `bootstrap/hostSurfaceRegistry.ts` `registerHostSurfacesV2Extension()`, wired in `index.ts` after the seed; SPA banner reads both homes | same file — record present on the v2 root with the LIVE registry (>5 surfaces, so a captured snapshot fails), root stays closed, v1 read unmoved |
| C.3a | `routes/discovery.ts` — five v2 family records + `registerAiProvidersV2Extension()` | same file — each family is a record with status/since/witness; every auth lane carries all four required fields; gated lanes absent when unconfigured (absent ≠ off); the per-provider map is in the extension; the v1 root is unmoved |
| C.3b | `client/runsClient.ts` (v2 read, no fallback, `v1Client` deleted), `AuthCard`, `SsoPanel`, `promptsClient`, `SubscriptionCredentialCard` | `v2Clients.test.ts` — the block that pinned the v1 dependency is INVERTED, asserting the REQUEST (the cache would hide the value) plus a sabotage leg requiring a failed v2 read to surface rather than fall back |
| C.4 | `client/workflowsClient.ts` `getWorkflowDefinitionRaw` (one owner for four call sites: `workflows/workflowsClient`, `builder/persistence/{backendStore,registerClient}`, `runs/RunsIndexPage`); `walkthroughs/useWalkthroughPlayer` → `getRun`; `prompts/promptsClient` → the SDK `prompts` surface | `v2Clients.test.ts` — address + version per family, a not-found yielding `null`, and a **500 that must THROW** (sabotage-proved: swallowing it makes `getWorkflowRunInputs` report "no inputs" for a workflow that declares several, so the run launches with an empty bag instead of refusing) |
| C.4 (fold-in) | `runs/RunOpsPanel.tsx` — a SECOND debug-bundle fetch on the v1 path, missed by C.1 | covered by the twin assertion; the panel now shares `getDebugBundle` |
| C.4 (fold-in) | `scripts/check-v1-reliance.mjs` — `readConst` → `readExport`, and a miss now THROWS | sabotage: renaming `preferredVersion` away makes the script exit 1; before, it printed `<unreadable>` and exited 0 |

## The ratchet's headline fact was inert

`check-v1-reliance.mjs` opens its report with the header-less default
contract — the single number that says whether this host still answers v1 to a
client that sends no version header. It read a const named `PREFERRED_VERSION`
from `middleware/protocolVersion.ts`. **That symbol does not exist anywhere in
the backend**, and had not since the retirement cut-switch made the value
depend on `v1Retired()`, turning the const into a function. The helper returned
the string `'<unreadable>'` on a miss and the script printed it and exited 0.

An unreadable fact and a healthy one produced the same exit code, so nothing
could have noticed. This is the same shape as every other inert check this
repo has found: a query that cannot fail, reporting success. The probe now
reads either form and **throws** when the symbol is absent, which is
sabotage-proved above. The fix is small; the reason it is recorded here is that
the defect survived inside the very tool built to measure this phase.

## Correction 2026-09-18 — C.3's `aiProviders` family shipped a v1 shape into a v2 field

The full gate caught one violation of the closed v2 capabilities schema:

```
/aiProviders/selfHosted must be boolean
```

`v2AiProvidersFamily()` emitted `selfHosted: hostAdvertisedSelfHosted()`, which
returns a `string[]`. That is correct for **v1**, where the field is the LIST of
advertised self-hosted provider ids — and wrong for **v2**, where
`capabilities.schema.json` types it `boolean`. The expression was copied from the
v1 builder twelve lines up without re-reading the v2 type.

Fixed to `hostAdvertisedSelfHosted().length > 0`. Nothing is lost by the
narrowing: the ids already ride the sibling `providers` array, which spreads the
same call, so v2 says "is a self-hosted class offered" while the identifiers stay
discoverable.

**Why it is recorded rather than quietly fixed.** The defect is the C.3 hazard in
miniature. Giving a family a v2 home means re-deriving every field against the v2
schema, not relocating the v1 object — the two dialects agree on most keys, which
is exactly what makes the one that differs easy to carry across. It is also the
third time in this phase that targeted test runs were green and only the full
gate was not: the other two were nine orphaned imports that `tsc` cannot see and
eslint can, and two test doubles that pinned the old transport. A closed schema
over a root is worth having precisely because it fails on the key you did not
think to check.

## Correction 2026-09-18 — C.3's auth family advertised a revocation rule this host does not perform

The major-2 conformance ratchet went red on `v2-lane-issuer-advertised`:

```
spec/v2/core/identity.md §2.2: lane oidc (revocation exp-and-recheck)
MUST advertise revocationWindowSeconds (integer >= 1)
```

**The scenario was doing exactly its job.** Giving `auth` a v2 home un-skipped a
probe that had never run against this host, and the first thing it found was a
false claim C.3 had just made.

§2.2 defines `exp-and-recheck` as "honor `exp`; re-check the issuer within the
advertised `revocationWindowSeconds`". **MEASURED:** `middleware/oidcVerifier.ts`
verifies signature, `iat`, `exp` and `nbf` and nothing else — no introspection,
no userinfo, no revocation list — and `middleware/auth.ts:978` derives the
subject straight from the claims with no host record consulted (its own comment
notes a pre-MFA token "stays valid ~1h"). A revoked user's token is accepted
until its own expiry.

So there is **no window to advertise**: any integer would tell a verifier that
revocation takes effect within it, which is false. The lane is OMITTED rather
than given a plausible number — under-claiming a lane the host serves is the
safe direction; over-claiming a revocation latency it does not have is not.

**The `revocation` enum has no honest value for this shape.** `next-request`
promises a per-request refusal this host does not perform; `short-lived`
promises a credential lifetime this host neither mints nor bounds. A stateless
JWT bearer with no introspection is the commonest deployment there is, and the
vocabulary pushes it toward claiming `exp-and-recheck` falsely. Reported
upstream as a spec gap; the omission stands until the enum gains an honest value
or this host implements a real recheck.

### The same rule exposed a second, latent defect

§2.2 requires the window for `short-lived` and `rebind` too, and the `workload`
lane declared `short-lived` with no window. The corpus scenario did **not** flag
it — with no workload trust root configured the lane is not emitted, so the
assertion ranged over an empty set. It would have gone red on any deployment
that enabled workload identity.

That one is honestly fixable: this host MINTS those credentials and enforces
`MAX_CREDENTIAL_TTL_S = 300` at mint time, which is precisely the mtls row's
"issue certificates whose lifetime is at most the advertised window". The advert
reads the constant rather than restating it, so it cannot drift from the
enforcement.

**Witness:** `test/adr0730-auth-lane-revocation-windows.test.ts` boots with
workload identity configured and asserts the SERVED v2 root. Its first leg fails
if the lane is not advertised, so the remaining legs cannot pass over an empty
set — the vacuity the corpus scenario fell into. Sabotage-proved both ways:
deleting the window reddens two legs, restoring the false `exp-and-recheck`
reddens two others, and the pristine tree is 4/4.

**The transferable point:** a green from a capability scenario is evidence about
the environment until you have checked that the thing it tests was switched on.

## Correction 2026-09-18 — C.3b is REVERTED. The SPA's discovery read stays on major 1.

C.3b moved `getCapabilities()` to the v2 root and deleted `v1Client`. **It should
not have.** The code it replaced carried the reason verbatim:

> `v1Client` speaks major 1, for exactly two things: `discovery.capabilities()` —
> **14 modules read the v1 document's shape (`caps.auth.profiles`,
> `caps.feedback.supported`, …) and the v2 root is a different, closed
> document**

C.3's commit asserted that C.3a had resolved this. C.3a advertised **five**
families. Measured against the document this host actually serves at major 2:

| the SPA reads | v2 home |
| --- | --- |
| `demoMode` | `extensions[openwop-app.host].demoMode` |
| `capabilities.hostSurfaces` | `extensions[openwop-app.host-surfaces].surfaces` |
| `capabilities.modelCapabilities` | `root.modelCapabilities` |
| `capabilities.aiProviders.input` | **ABSENT** |
| `capabilities.memory.attribution` | **ABSENT — no `memory` family at major 2** |
| `envelopes.tierOneSubsetCompliance` | **ABSENT — no `envelopes` family at major 2** |
| `feedback.supported` | v2 dropped `supported` from every facet |

Two whole families missing, plus a shape change, across ten consumers.

### What it cost, and why nothing caught it

Five UI surfaces regressed silently. `demoMode` gates the BYOK **"Try it free —
no API key needed"** affordance (`ProviderGrid` returns `null` without it), and
`hostSurfaces` gates the in-memory disclosure banner. Both vanished.

**Every consumer of `getCapabilities()` meets a failed or empty read with a
`catch` that renders nothing** — deliberately, to keep network noise off the
screen. That is a reasonable per-component choice which composes into a terrible
system property: the whole capability layer fails silent. 16,131 backend tests,
both conformance lanes, 5,433 frontend tests and every unit test passed over it.
It took a browser, cross-origin, to see it — and then a baseline run against
`origin/main` to prove it was ours (1 pre-existing failure there, 10 here).

### A second, independent defect on the same path

The v2 client sends `OpenWOP-Version`, which the **CORS preflight did not
admit** — so cross-origin the browser blocked the request before it left. That
is fixed separately and is production-reachable on its own merits (the SPA's SSE
path bypasses `/api`), so it stays landed regardless of this revert.

### What is kept

C.3a's v2 family adverts and the two `openwop-app.*` extension records stay: they
are additive, schema-valid, conformance-clean, and they are what a v2 client
reads. **The distinction that matters: advertising a family at major 2 is not the
same as this SPA being able to read the v2 document instead of the v1 one.** C.3
conflated them.

C.1's debug-bundle twin and C.4's path migrations also stay — those are
*addresses*, not document shape, and both are verified.

### What remains

Emit `memory` and `envelopes` at major 2; re-derive the seven consumer reads
against their measured v2 homes; and gate each on a browser-level test, because
this failure class is invisible to unit tests by construction. Half-migrated was
the worst available state, which is why this is a revert and not a patch.
