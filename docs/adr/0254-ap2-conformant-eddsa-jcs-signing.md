# ADR 0254 — Conformant AP2 mandate signing (eddsa-jcs-2022); MCP transport finding

Status: implemented (ecommerce-deferral follow-on, Group D — conformant signing);
MCP transport DEFERRED with a documented dependency (below).

Relates to: ADR 0188 (UCP buyer / AP2), ADR 0240 (DEF-2 — the first Ed25519 signing +
the MCP-transport deferral), ADR 0030 (outbound MCP client). No OpenWOP wire change
(UCP/AP2 are external client protocols); no migration.

## Context

ADR 0240 (DEF-2) shipped a real Ed25519 AP2 signature but was **honestly labelled
non-conformant**: `OpenwopAp2Ed25519Json` — a raw EdDSA over `JSON.stringify(mandate)`
with an embedded JWK. It proved integrity, not authenticity, and a standards VC verifier
couldn't check it. Two follow-ons: make it **conformant**, and give the buyer **MCP
transport** (its plan claimed "compose `host/mcpClient`").

## Decision — conformant `eddsa-jcs-2022` (implemented)

Replace the proof with a conformant **W3C Data-Integrity `eddsa-jcs-2022`** proof
(VC-DI-EDDSA), in a self-contained `ucpBuyer/dataIntegrity.ts` (no new dependency):

- **JCS canonicalization** (RFC 8785) — restricted to the mandate value space (objects,
  arrays, strings, booleans, integer numbers; non-integer numbers are rejected rather than
  risk a non-canonical float rendering — all AP2 amounts are minor-unit integers).
- **Ed25519 `did:key`** verificationMethod — the did:key IS the key (multicodec `0xed01` +
  base58-btc multibase), so a standards-conformant relying party can resolve the key and
  verify the signature from the proof alone.
  **Trust model (honest — corrected after code-review proved a same-suite forgery):**
  verification proves **integrity** (the mandate wasn't altered) + **self-consistency** (the
  embedded did:key signed it) — it does **NOT** prove **authenticity**. An attacker can sign a
  forged mandate with their own key and embed their own did:key, and it verifies. Authenticity
  still requires the relying party to **pin/authorize the `verificationMethod`** against an
  expected issuer out-of-band — the ADR 0240 authenticity gap is NARROWED (now a conformant,
  standards-verifiable signature) but NOT closed. `verifyPaymentMandate` takes an optional
  `expectedDidKey` for callers that gate a decision; the app itself never gates on the proof
  (the spend cap + approval run before signing).
- **Suite hashing** — `sign( SHA-256(JCS(proofConfig)) ‖ SHA-256(JCS(document)) )`;
  `proofValue` is the multibase base58-btc signature; `proof.type = DataIntegrityProof`,
  `cryptosuite = eddsa-jcs-2022`, `proofPurpose = assertionMethod`.

`signPaymentMandate`/`verifyPaymentMandate` keep their API and their **never-throw**
contract: unconfigured ⇒ the honest unsigned warning; a bad key ⇒ a failure warning; a
configured key ⇒ a conformant proof + cleared warning. The secured document is the mandate
minus `warnings`/`proof` (host annotations, not the attested authorization).

## Finding — MCP transport is DEFERRED (a real dependency, not scope-cutting)

The plan assumed the buyer could "compose `host/mcpClient`" for MCP-native merchants. The
architect pass found that **`host/mcpClient` (ADR 0030) is coupled to the run-execution
context**: `McpClientDeps.runId` is required and every call stamps **run-scoped** provenance
(`stampConnectionUse(storage, deps.runId, …)`). The UCP buyer's discover/search/checkout are
**runless** (they record via `recordCommerceAction`, not a run). Composing the client would
need a **runless MCP-invocation seam** that doesn't exist yet. Combined with the
`merchantUrl`-centric purchase model (MCP addresses a merchant by a `reach:'mcp'` serverId,
not a URL) and the fact that MCP **checkout** is autonomous real-money movement, this is a
**phase-sized change on the highest-risk surface**, not a follow-on. It is deferred at a real
gate (missing runless seam + model change + money-surface review), and this finding is the
deliverable that de-risks it.

**Scoped path for the future phase:** (1) a runless MCP-call seam (or thread a synthetic
run context) so `mcpClient` can be invoked outside the executor; (2) a `MerchantRef` =
`{url}` | `{serverId}` abstraction with `UcpPurchase.merchantServerId`; (3) branch
discover/search/checkout/track on the ref, preserving the spend gate + org cap + fail-closed
semantics for the MCP checkout; (4) test against a mock MCP server (the `outbound-mcp.test.ts`
+ `registerProvider`/`createSecretConnection` precedent, which retires the "no conformance
target" concern).

## Alternatives weighed

- *Conformant `Ed25519Signature2020` (URDNA2015/RDF)* — rejected; needs `jsonld` +
  `rdf-canonize` deps. `eddsa-jcs-2022` (JCS) is the modern, dependency-free conformant suite.
- *Cram MCP transport in with a synthetic runId* — rejected; stamping run-scoped provenance
  for a runless commerce call is semantically wrong, and the money-path/model change needs
  its own review.

## Wire honesty (no RFC)

Host-side only: the proof lives on the buyer's own AP2 mandate objects (not the OpenWOP
wire); UCP/AP2 are external client protocols. No run-event/capability/endpoint change; no
migration.

## Implementation

| Piece | Files |
|---|---|
| JCS + base58-btc + did:key + eddsa-jcs-2022 sign/verify | `features/commerce/ucpBuyer/dataIntegrity.ts` (new) |
| Mandate proof rewired to the conformant suite | `features/commerce/ucpBuyer/ap2Mandates.ts` |
| Tests (JCS vectors, base58/did:key round-trip, sign/verify/tamper, mandate signing) | `test/commerce-followon-d.test.ts` (11) |

## Open questions / follow-ons

- ~~**MCP transport for the buyer** — deferred as above (runless MCP seam + `MerchantRef` +
  money-path review). This ADR is the de-risking finding.~~
  **SHIPPED / CORRECTION (ADR 0258):** the run-coupling was overstated — `stampConnectionUse`
  already no-ops a missing run, so the "runless seam" was a 3-line `runId?`-optional change,
  not a phase. MCP transport shipped as a feature-package change with the money gate preserved
  transport-agnostically (incl. the MCP-timeout→`unknown` invariant). See ADR 0258.
- **Full RFC-8785 number formatting** — the JCS serializer covers the integer/string mandate
  value space; ECMAScript float formatting (§3.2.2.3) is out of scope until a mandate needs it.
