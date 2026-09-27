/**
 * ADR 0552 P0 — the version-neutral seam for the A2A surface.
 *
 * ONE owner for "which A2A protocol version(s) does this host actually serve".
 * Before this, `protocolVersion: '0.3'` was a bare literal inside the Agent Card
 * builder (`routes/agents.ts:962`) with nothing naming it as a *profile choice*.
 * A version pinned as a literal in the object it decorates cannot be reasoned
 * about, negotiated against, or refused — it can only be edited, which is how a
 * legacy subset quietly starts being presented as generic A2A support.
 *
 * ADR 0552's Context is precise about the risk: the v0.3 implementation "is
 * useful, but it is not current A2A 1.0 interoperability and must not be
 * presented as generic A2A support."
 *
 * ADR 0552 P2 (2026-08-16) — `'1.0'` joined the union, TOGETHER with the codec
 * P0's docblock said it had to land with (`host/a2aCodec10.ts`, the 1.0 card
 * builder in `host/a2aCard.ts`, the 1.0 branch of `host/a2aServer.ts`, and the
 * 1.0 client in `host/a2aSurface.ts`). The rule the original text stated —
 * "the entry and the behaviour land together or not at all" — is the reason
 * this file is still one line of truth rather than four literals.
 */

/**
 * An A2A protocol version this host can serve. Closed on purpose.
 *
 * `'1.0'` = A2A 1.0.0 as published 2026-03-12, the `a2a-1.0` profile of
 * `spec/v1/a2a-integration.md` §"A2A 1.0 versioned composition".
 * `'0.3'` = the `a2a-0.3-legacy` profile (everything above that heading).
 */
export type A2AProtocolVersion = '1.0' | '0.3';

/**
 * Every version this host SERVES — not every version it knows the name of.
 * ORDER IS MEANINGFUL: newest-preferred first (RFC 0152 §A convention), and
 * `advertisedA2AProtocolVersion()` reads element 0.
 *
 * Adding an entry here without the codec behind it would be a dishonest
 * advertisement of exactly the kind ADR 0548 invariant 3 exists to prevent
 * ("a capability is absent unless the active deployment profile passes its
 * behavioral evidence"). The entry and the behaviour land together or not
 * at all.
 */
export const A2A_SUPPORTED_VERSIONS: readonly A2AProtocolVersion[] = ['1.0', '0.3'];

/**
 * The 0.3 wire's own spelling of itself.
 *
 * The legacy Agent Card carries a single top-level `protocolVersion`, and that
 * field means "this document is a 0.3 card" — NOT "this host prefers 0.3".
 * Before P2 the two were the same string and one constant served both; they are
 * not the same fact, and stamping the preferred version onto a 0.3-shaped card
 * would make the card lie about its own shape.
 */
export const LEGACY_A2A_PROTOCOL_VERSION: A2AProtocolVersion = '0.3';

/**
 * The version this host PREFERS — `capabilities.a2a.preferredVersion`, and the
 * version the outbound client asks a peer for by default (RFC 0152 §B: "the
 * value MUST be one the host lists in `protocolVersions`, and by default the
 * `preferredVersion`").
 */
export function advertisedA2AProtocolVersion(): A2AProtocolVersion {
  return A2A_SUPPORTED_VERSIONS[0]!;
}

/**
 * The named composition profiles (RFC 0152 §A `capabilities.a2a.profiles`),
 * DERIVED from the served versions rather than listed a second time.
 *
 * §A: "a host MUST NOT list `a2a-X.Y` in `profiles` unless `X.Y` is in
 * `protocolVersions`". Deriving makes that structurally true instead of
 * test-enforced — there is no second list to drift.
 */
export function a2aProfileIdFor(version: A2AProtocolVersion): string {
  return version === '0.3' ? 'a2a-0.3-legacy' : `a2a-${version}`;
}

/** Every profile this host claims, in `A2A_SUPPORTED_VERSIONS` order. */
export const A2A_PROFILES: readonly string[] = A2A_SUPPORTED_VERSIONS.map(a2aProfileIdFor);

/**
 * The date after which this host SHOULD NOT advertise `a2a-0.3-legacy`
 * (`a2a-integration.md` §A "Legacy window", resolved from RFC 0152 UQ1: A2A
 * 1.0.0 published 2026-03-12 + the 12-month window). ADR 0552 P4 is the
 * retirement; this constant is what P4 acts on, and what keeps the date out of
 * a comment nobody greps.
 */
export const A2A_LEGACY_PROFILE_SUNSET = '2027-03-12';

/** Does this host serve `version`? */
export function servesA2AVersion(version: string): version is A2AProtocolVersion {
  return (A2A_SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

/**
 * The A2A 1.0 version header (RFC 0152 §B). Lower-cased because Node normalises
 * incoming header names; the wire spelling is `A2A-Version`.
 */
export const A2A_VERSION_HEADER = 'a2a-version';

/** What a request's version header means for this host. */
export type A2AVersionDisposition =
  /** No header. A2A 1.0 senders MUST send one, so this is a legacy 0.3 peer. */
  | { kind: 'absent' }
  /** An explicit version this host serves. */
  | { kind: 'served'; version: A2AProtocolVersion }
  /** An explicit version this host does NOT serve — must be refused, not downgraded. */
  | { kind: 'unsupported'; requested: string };

/**
 * Classify the `A2A-Version` header of an inbound request — RFC 0152 §B:
 *
 *   "For A2A 1.0 requests, the sender MUST send `A2A-Version: 1.0` … Unsupported
 *    versions MUST fail … A host MUST NOT silently downgrade an authenticated
 *    request."
 *
 * WHY A MISSING HEADER IS NOT A REFUSAL. §B puts the obligation to send the
 * header on the 1.0 SENDER, and states the receiver rule directly: "An absent
 * header means 0.3 (upstream rule)". A request without one is therefore a
 * 0.3-era peer, and 0.3 remains a served profile (`a2a-0.3-legacy`, until
 * {@link A2A_LEGACY_PROFILE_SUNSET}). Refusing it would break every existing
 * peer to enforce a rule that does not apply to them. What §B forbids is
 * answering an EXPLICIT "1.0" with 0.3 semantics and saying nothing — that is
 * the silent downgrade.
 *
 * This function only classifies. The refusal — and the content-free audit event
 * §B asks for — belong to the route, which owns the response shape.
 */
export function dispositionForA2AVersionHeader(raw: unknown): A2AVersionDisposition {
  // Node collapses a repeated header into an array; a peer sending two
  // conflicting versions has not stated one version, so it cannot be served.
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || value.trim() === '') return { kind: 'absent' };
  const requested = value.trim();
  return servesA2AVersion(requested) ? { kind: 'served', version: requested } : { kind: 'unsupported', requested };
}

/**
 * Which CODEC an accepted request is decoded with (ADR 0552 P2).
 *
 * `absent` resolves to `'0.3'` — the upstream receiver rule §B restates, and
 * the reason the 0.3 codec cannot simply be deleted when 1.0 ships: a
 * header-less request IS a 0.3 request, not an under-specified 1.0 one.
 *
 * The Agent Card follows the SAME rule — see {@link cardVersionFor}. (This
 * docblock used to name a deliberate asymmetry there; the spec owner reversed
 * that decision on 2026-08-16, so there is one receiver rule, not two.)
 */
export function codecVersionFor(disposition: A2AVersionDisposition): A2AProtocolVersion | null {
  if (disposition.kind === 'absent') return LEGACY_A2A_PROTOCOL_VERSION;
  if (disposition.kind === 'served') return disposition.version;
  return null;
}

/**
 * Which card SHAPE a `GET /.well-known/agent-card.json` is answered with
 * (ADR 0552 P2 CORRECTION, `a2a-integration.md` §C decided 2026-08-16 —
 * openwop#1028, RFC 0152 register S18 Q1).
 *
 *   "While a host advertises `a2a-0.3-legacy` (`protocolVersions ∋ 0.3`) it
 *    MUST serve the 0.3-shaped card for a header-less `GET agentCardUrl`, and
 *    the 1.0-shaped card when the request carries `A2A-Version: 1.0`; a 1.0
 *    client MUST send that header on the card GET. … A host that has dropped
 *    0.3 serves the card of its `preferredVersion` header-less."
 *
 * P2 shipped the opposite (preferred-shape header-less) on the reasoning that
 * "a card is the host describing itself" and so the §B receiver rule did not
 * reach discovery. The spec owner reversed it, and the reason is the one P2's
 * own docblock named as the cost and then accepted: an external 0.3 client that
 * discovers this host header-less and resolves the RPC endpoint from `card.url`
 * finds no `url`. Serving 1.0 header-less breaks those clients NOW rather than
 * at {@link A2A_LEGACY_PROFILE_SUNSET}, which is the entire point of still
 * advertising the legacy profile. So discovery and operations share one rule.
 *
 * An UNSUPPORTED version is not an absent one, so the receiver rule does not
 * reach it: the card GET is discovery, and refusing it would deny the client
 * the very document that tells it which versions exist. It gets the preferred
 * card — which names every served version — rather than a refusal.
 */
export function cardVersionFor(disposition: A2AVersionDisposition): A2AProtocolVersion {
  if (disposition.kind === 'served') return disposition.version;
  if (disposition.kind === 'absent' && servesA2AVersion(LEGACY_A2A_PROTOCOL_VERSION)) {
    return LEGACY_A2A_PROTOCOL_VERSION;
  }
  return advertisedA2AProtocolVersion();
}
