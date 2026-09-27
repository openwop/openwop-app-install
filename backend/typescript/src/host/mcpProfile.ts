/**
 * ADR 0553 P1/P2 — the version-neutral seam for the MCP surface.
 *
 * ONE owner for "which MCP protocol version does this host actually serve".
 * Before P1 the version was a bare literal in three unrelated places, and they
 * did not agree:
 *
 *   - `mcpServerRouter.ts` answered `initialize` with `'2025-06-18'`;
 *   - `mcpClient.ts` PROBED peers with `'2024-11-05'`;
 *   - `packs/core.openwop.mcp/pack.json` described itself as tracking 2025-06-18.
 *
 * A host that speaks one version as a server and a different one as a client has
 * no single answer to "what do you support", which is the question RFC 0153 §A
 * exists to make answerable. Mirrors `host/a2aProfile.ts` deliberately — the
 * same problem deserves the same shape.
 *
 * P2 ADDS THE CURRENT PROFILE. `2026-07-28` is not a newer dialect of
 * `2025-06-18`; it is a different protocol. There is no `initialize`, no
 * session, and no server-initiated request. Every request self-describes in
 * `params._meta`, three headers MUST agree with the body, `server/discover`
 * replaces the handshake, every result carries `resultType`, lists carry cache
 * hints, and a server that needs input answers the CLIENT's request with
 * `input_required` (MRTR) instead of calling back. So the two are served by two
 * CODECS over one version-neutral semantic service (`host/mcpSemantics.ts`),
 * not by one codec with branches.
 *
 * THIS FILE IS THE ONLY PLACE AN MCP DATE LITERAL MAY APPEAR. `mcp-profile.test.ts`
 * fails if `mcpServerRouter.ts`, `mcpClient.ts`, `mcpCurrentCodec.ts` or
 * `mcpSemantics.ts` re-pins one in executable code (comments may cite versions —
 * that is the reasoning trail).
 */

/** An MCP protocol version this host can serve. Closed on purpose. */
export type McpProtocolVersion = '2026-07-28' | '2025-06-18';

/** RFC 0153 §A/§B — the current profile. Stateless, header-described, MRTR. */
export const MCP_CURRENT_VERSION: McpProtocolVersion = '2026-07-28';

/** The pre-existing profile: `initialize` handshake, sessions, live callbacks. */
export const MCP_LEGACY_VERSION: McpProtocolVersion = '2025-06-18';

/**
 * Every version this host SERVES — not every version it knows the name of.
 *
 * Adding `'2026-07-28'` here without the RFC 0153 codec behind it would be the
 * dishonest advertisement ADR 0548 invariant 3 exists to prevent. The entry and
 * the behaviour land together or not at all — which is why this line and
 * `host/mcpCurrentCodec.ts` are in one commit.
 *
 * ORDER IS MEANING: the first entry is `preferredVersion` (RFC 0153 §A) and the
 * revision the outbound client opens with.
 */
export const MCP_SUPPORTED_VERSIONS: readonly McpProtocolVersion[] = [
  MCP_CURRENT_VERSION,
  MCP_LEGACY_VERSION,
];

/** RFC 0153 §A — the named composition profiles this host meets in full. */
export const MCP_CURRENT_PROFILE = 'mcp-2026-07-28';
export const MCP_LEGACY_PROFILE = 'mcp-2025-06-18-legacy';
export const MCP_PROFILES: readonly string[] = [MCP_CURRENT_PROFILE, MCP_LEGACY_PROFILE];

/**
 * RFC 0153 §A — the closed `features[]` set, and a MUST for a current-profile
 * host: `server-discover`, `mrtr`, `cacheable-lists` are MUSTs of the upstream
 * revision, so a host claiming the profile without them is not implementing it.
 *
 * `extensions` is the optional fourth and is deliberately ABSENT: it means "the
 * host advertises and honours `capabilities.extensions`", and this host honours
 * NO extension (§D — every extension is opaque; the only named mappings are the
 * OTel `_meta` keys and `logLevel`, neither of which is a negotiated extension).
 * Claiming it would be the same class of lie as claiming a version.
 */
export const MCP_CURRENT_FEATURES: readonly string[] = ['server-discover', 'mrtr', 'cacheable-lists'];

/**
 * RFC 0153 §Compatibility, resolved for the date in `mcp-integration.md` §A: the
 * legacy profile was accepted 2026-08-12 and the window is 12 months, so this
 * host SHOULD NOT advertise `mcp-2025-06-18-legacy` after this date. Recorded
 * rather than enforced — removing the legacy code path is a v2 decision, and a
 * host that silently stopped answering `initialize` on the date would break
 * every peer that had not moved.
 */
export const MCP_LEGACY_PROFILE_SUNSET = '2027-08-12';

/**
 * The version this host PREFERS — `capabilities.mcp.preferredVersion`, and the
 * revision the outbound client opens a conversation with.
 *
 * NOTE this is no longer the version the legacy `initialize` handshake reports.
 * `initialize` does not exist under the current revision, so a peer that sends
 * it is by construction a legacy peer and must be answered with the legacy
 * version — see `initializeVersionOutcome`.
 */
export function advertisedMcpProtocolVersion(): McpProtocolVersion {
  return MCP_SUPPORTED_VERSIONS[0]!;
}

/** Does this host serve `version`? */
export function servesMcpVersion(version: string): version is McpProtocolVersion {
  return (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

/**
 * ADR 0553 P3 — a named composition profile → the revision it implies.
 *
 * §A: "A profile implies its version, not the reverse." A provider manifest
 * pins a PROFILE (`mcpServer.profile`) rather than a bare date, because a
 * profile is the thing an operator can reason about ("this peer meets the
 * current document in full") and the date falls out of it. One map, so a
 * manifest pin and the advert cannot drift into naming different revisions.
 */
const PROFILE_VERSIONS: Readonly<Record<string, McpProtocolVersion>> = {
  [MCP_CURRENT_PROFILE]: MCP_CURRENT_VERSION,
  [MCP_LEGACY_PROFILE]: MCP_LEGACY_VERSION,
};

/** The revision a named profile implies, or `undefined` for an unknown name. */
export function versionForMcpProfile(profile: string): McpProtocolVersion | undefined {
  return PROFILE_VERSIONS[profile];
}

// ─────────────────────────────────────────────────────────────────────────────
// Current-profile wire vocabulary (RFC 0153 §B)
// ─────────────────────────────────────────────────────────────────────────────

/** Streamable-HTTP headers. Lower-cased: Node normalises inbound header names. */
export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';
export const MCP_METHOD_HEADER = 'mcp-method';
export const MCP_NAME_HEADER = 'mcp-name';

/** `params._meta` / result `_meta` keys, upstream spellings verbatim. */
export const MCP_META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const MCP_META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const MCP_META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const MCP_META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
/** §D named mapping: honoured per request; `notifications/message` only with it. */
export const MCP_META_LOG_LEVEL = 'io.modelcontextprotocol/logLevel';

/**
 * Spec-reserved JSON-RPC error codes for the current revision (the -32020..-32099
 * range is reserved by the MCP specification, so these do NOT belong in
 * `mcpJsonRpc.ts` alongside the JSON-RPC 2.0 canon).
 */
export const MCP_ERR_HEADER_MISMATCH = -32020;
export const MCP_ERR_MISSING_CLIENT_CAPABILITY = -32021;
export const MCP_ERR_UNSUPPORTED_VERSION = -32022;

/**
 * Which codec serves a request, decided from `MCP-Protocol-Version` alone.
 *
 * `absent` is NOT a refusal and NOT the current profile. Upstream: a request
 * without the header is at most a pre-header revision, and a host that speaks
 * one serves it under those semantics. This host speaks `2025-06-18`, so a
 * header-less request is a legacy peer — which is what keeps every existing
 * client, and every legacy conformance leg, working unchanged.
 */
export type McpCodecSelection =
  | { kind: 'current'; version: McpProtocolVersion }
  | { kind: 'legacy'; version: McpProtocolVersion; headerPresent: boolean }
  | { kind: 'unsupported'; requested: string };

/**
 * RFC 0153 §B version selection. There is no negotiation handshake: each
 * request declares its revision and is accepted or rejected independently.
 *
 * THIS IS THE FAIL-CLOSED PATH ADR 0553 P1 DEFERRED. P1's note said plainly
 * that refusing an unserved version on the LEGACY profile would break every
 * standard client (upstream's legacy rule is that the server answers with a
 * version it supports and the client decides), and that §B's "unsupported
 * versions fail closed" governs the CURRENT profile's header-based selection.
 * That is exactly the split encoded here: an explicit header naming a revision
 * this host does not serve is refused `-32022`; no header at all still gets
 * legacy semantics.
 */
export function selectMcpCodec(
  rawHeader: unknown,
  /**
   * ADR 0553 P3 — the revisions the host actually serves. Defaulted, so every
   * production call site is unchanged; a PARAMETER because the header-less
   * branch below is a claim about this set, and a claim that can only ever be
   * evaluated against one value is a guard that cannot fail.
   */
  served: readonly McpProtocolVersion[] = MCP_SUPPORTED_VERSIONS,
): McpCodecSelection {
  const servesLegacy = served.includes(MCP_LEGACY_VERSION);
  // Node collapses a repeated header into an array; a peer sending two
  // conflicting revisions has not stated one, so it cannot be served.
  const value = Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader;
  if (typeof value !== 'string' || value.trim() === '') {
    // §B: "A request without `MCP-Protocol-Version` is, per upstream, at most
    // `2025-03-26`; a host whose `protocolVersions` does not include a
    // pre-header revision MUST reject it."
    //
    // THIS BRANCH USED TO ANSWER `legacy` UNCONDITIONALLY (ADR 0553 P2), which
    // was correct only by coincidence: this host happens to serve the legacy
    // revision. On a host that had dropped it — the state the legacy sunset
    // (`MCP_LEGACY_PROFILE_SUNSET`) exists to reach — a header-less request
    // would still have been dispatched into a codec the host no longer claims,
    // which is the inbound half of "no silent downgrade". Derived now, so the
    // sunset cannot turn this into a lie by deleting one array entry.
    return servesLegacy
      ? { kind: 'legacy', version: MCP_LEGACY_VERSION, headerPresent: false }
      : { kind: 'unsupported', requested: '' };
  }
  const requested = value.trim();
  if (requested === MCP_CURRENT_VERSION && served.includes(MCP_CURRENT_VERSION)) {
    return { kind: 'current', version: MCP_CURRENT_VERSION };
  }
  if (requested === MCP_LEGACY_VERSION && servesLegacy) {
    return { kind: 'legacy', version: MCP_LEGACY_VERSION, headerPresent: true };
  }
  return { kind: 'unsupported', requested };
}

/**
 * What the LEGACY `initialize` handshake should report given the peer's
 * requested version.
 *
 * DELIBERATELY NOT A HARD FAILURE, and this is a departure from RFC 0153 §B's
 * "unsupported versions fail closed" that is worth stating plainly rather than
 * hiding in a default.
 *
 * §B governs the CURRENT profile, whose whole negotiation model is header-based
 * and stateless — and `initialize` does not exist there at all (the current
 * codec answers it `-32601`, loudly). A peer that sends `initialize` is by
 * construction a legacy peer, and upstream MCP's rule for that profile is the
 * opposite of fail-closed: the server responds with a version it DOES support
 * and the client decides whether to proceed. Failing closed here would break
 * every standard MCP client that opens with an older version.
 *
 * So the honest legacy-profile behaviour is: always report the LEGACY version we
 * actually serve, and never pretend to have accepted something else. Note the
 * served value is `MCP_LEGACY_VERSION`, not `advertisedMcpProtocolVersion()` —
 * since P2 those differ, and reporting the preferred (current) revision from a
 * handshake that only exists in the legacy one would be a version claim the
 * subsequent legacy traffic contradicts.
 */
export function initializeVersionOutcome(requested: unknown): {
  /** The version to report. Always the legacy one — `initialize` is legacy-only. */
  served: McpProtocolVersion;
  /** The peer's requested version, when it stated a usable one. */
  requested?: string;
  /** True when the peer asked for something this host does not serve. */
  mismatch: boolean;
} {
  const served = MCP_LEGACY_VERSION;
  if (typeof requested !== 'string' || requested.trim() === '') return { served, mismatch: false };
  const asked = requested.trim();
  return { served, requested: asked, mismatch: !servesMcpVersion(asked) };
}
