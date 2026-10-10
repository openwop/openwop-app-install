# ADR 0809 — Connection-pack provider identity at major 2, and `connections` declared

Status: Accepted (implemented)

Related: RFC 0095 (connection packs, v1 §B.6 precedence), ADR 0670 (why
`connections` was ledgered off), `docs/steward/V2-COMPLETION-PLAN.md` W4.

## Context

`connection-packs.md` §"Provider identity" (RFC 0177 §D.1) changes one rule
between majors:

- **v1 §B.6:** an installed pack overrides a built-in of the same id (the
  built-in is a version floor), and two packs with the same id resolve by
  SemVer (`>=` wins).
- **v2:** a `provider.id` is unique per host, and "version-based precedence is
  gone". When a definition already holds the id, the later registration MUST
  be refused with `connection_provider_conflict` (409). A connector MAY name a
  provider by the qualified form `<packName>#<id>`, which resolves only to the
  named pack's definition.

`connections` sat on `conformance/major2Ledger.ts` because
`v2-provider-conflict` failed. The host applied v1 precedence to every pack, so
a later, higher-versioned bare id installed over the first, and the qualified
form did not resolve.

This host serves both majors from ONE provider registry, so it cannot simply
switch rules.

## Decision

1. **The rule follows the pack's own engine range.** A pack whose
   `engines.openwop` admits major 2 but not major 1 (`rangeAdmitsMajor`, the
   RFC 0177 §A.1 reader the v2 install gate already uses) is a v2 pack and
   gets the v2 rule. Every other pack, including one that admits both majors,
   keeps v1 §B.6 unchanged, so nothing installed today changes behaviour.
2. **One rule owner for both install paths.** `assertProviderIdentity` in
   `connectionPackLoader.ts` is called by the boot loader and by the seam
   install. For a v2 pack:
   - if any definition already holds the id, a built-in or another pack, the
     registration is refused, and the message names the owner and the
     qualified form;
   - re-registering the SAME pack is not a second definition.
3. **The registry records each provider's owning pack** (`registerProvider(…,
   { packName })`). `getProvider('<packName>#<id>')` resolves only when that
   pack owns `id`, never to a built-in or another pack. The product lookup and
   the seam resolve both read it.
4. **Declare `connections` at major 2** with `packsSupported: true` (the v1
   facet), and remove the ledger row in the same commit (RFC 0148 §B). This
   leaves `family.sandbox` as the only ledgered family, an honest opt-out with
   no isolation model to declare.

## Alternatives weighed

- **Apply the v2 rule to every pack.** v1 §B.6 is still this host's major-1
  contract, and `connection-provider-resolution` (v1) asserts precedence.
  Rejected.
- **Choose the rule by the request's negotiated major.** Registration happens
  at boot and at install, not per request, and one registry serves both
  majors. The pack's declared engine range is the only stable signal.
  Rejected.

## Implementation record

| What | Where |
|---|---|
| `assertProviderIdentity` (v2 refusal / v1 precedence), both install paths | `features/connections/connectionPackLoader.ts` |
| owner map, qualified-form `getProvider`, `providerPackOwner` | `features/connections/providerRegistry.ts` |
| seam resolve understands `<packName>#<id>` | `features/connections/connectionPackLoader.ts` (`seamResolveProvider`) |
| v2 record; ledger row removed | `routes/discovery.ts`, `conformance/major2Ledger.ts` |
| tests: later registration refused even at a higher version; a v2 pack may not shadow a built-in; same-pack re-register; qualified form resolves only to its owner; v1 precedence kept for a dual-major pack | `test/adr0809-connection-provider-identity.test.ts` |
| ADR 0670 guard: the three September failures are now positive; `sandbox` is pinned as the opt-out | `test/adr0670-v2-advert-validates.test.ts` |
| suite: `v2-provider-conflict` 2/2 executed-pass at major 2; v1 `connection-provider-resolution` 3/3 at major 1 (filtered lanes) | `npm run test:conformance -- --filter provider` / `--filter connection-provider` |
