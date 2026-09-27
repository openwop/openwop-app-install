/**
 * ADR 0553 P1/P2 — the MCP version seam.
 *
 * THE DEFECT THIS PINS. The MCP version was a bare literal in more than one
 * place, and the places disagreed: `mcpServerRouter.ts` answered `initialize`
 * with `2025-06-18` while `mcpClient.ts` PROBED peers with `2024-11-05`. The
 * same host advertised two different MCP versions depending on which direction
 * you asked from, and nothing compared them — no test asserted what
 * `initialize` returns, and none asserted what the client sends.
 *
 * `initialize` also never READ `params.protocolVersion`. `params` was bound in
 * `dispatch` and never passed on; `initializeResult()` took no arguments. The
 * peer's requested version was structurally unreachable, so the host could not
 * have agreed or disagreed with it.
 *
 * The source-level legs mirror `a2a-profile.test.ts`, which has had exactly this
 * assertion since ADR 0552 P0 — applied to the MCP files it would have failed
 * the whole time.
 *
 * ── UPDATED FOR P2 (2026-08-16) ────────────────────────────────────────────
 * P1's version of this file asserted `MCP_SUPPORTED_VERSIONS === ['2025-06-18']`
 * and `servesMcpVersion('2026-07-28') === false`, under the heading "does NOT
 * claim the current profile, whose codec is unwritten". That was the correct
 * assertion for as long as it was true, and it went red the moment the entry
 * landed — which is what it was for. It is REPLACED, not deleted, by the
 * obligations the codec brings with it: the two revisions map to two codecs,
 * `initialize` reports the LEGACY version (it does not exist in the current
 * revision, so a peer sending it is a legacy peer by construction), and an
 * explicit unserved revision FAILS CLOSED — the path P1 deliberately deferred
 * (`mcpProfile.ts` P1 note, ADR 0553 `:165-173`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCP_CURRENT_FEATURES,
  MCP_CURRENT_PROFILE,
  MCP_CURRENT_VERSION,
  MCP_LEGACY_PROFILE,
  MCP_LEGACY_PROFILE_SUNSET,
  MCP_LEGACY_VERSION,
  MCP_PROFILES,
  MCP_SUPPORTED_VERSIONS,
  advertisedMcpProtocolVersion,
  initializeVersionOutcome,
  selectMcpCodec,
  servesMcpVersion,
} from '../src/host/mcpProfile.js';
import { dispatch } from '../src/host/mcpServerRouter.js';

const SRC = join(__dirname, '..', 'src', 'host');

describe('ADR 0553 P1 — the served MCP version has one owner', () => {
  it('the advertised version is one this host serves', () => {
    expect(MCP_SUPPORTED_VERSIONS).toEqual([MCP_CURRENT_VERSION, MCP_LEGACY_VERSION]);
    expect(MCP_SUPPORTED_VERSIONS).toContain(advertisedMcpProtocolVersion());
    // Order is meaning: the first entry IS `preferredVersion` and the revision
    // the outbound client opens with.
    expect(advertisedMcpProtocolVersion()).toBe(MCP_CURRENT_VERSION);
  });

  it('rejects near-misses and junk', () => {
    for (const v of ['2024-11-05', '2025-06-17', '', 'latest', '2026-7-28']) expect(servesMcpVersion(v)).toBe(false);
    expect(servesMcpVersion(MCP_LEGACY_VERSION)).toBe(true);
    expect(servesMcpVersion(MCP_CURRENT_VERSION)).toBe(true);
  });
});

describe('ADR 0553 P2 — the profile advert is a claim about behaviour', () => {
  it('every profile implies its version (RFC 0153 §A)', () => {
    expect(MCP_PROFILES).toEqual([MCP_CURRENT_PROFILE, MCP_LEGACY_PROFILE]);
    for (const profile of MCP_PROFILES) {
      const date = profile.replace(/^mcp-/, '').replace(/-legacy$/, '');
      expect(MCP_SUPPORTED_VERSIONS as readonly string[], `${profile} implies ${date}`).toContain(date);
    }
  });

  it('the closed features set names the three current-revision MUSTs and NOT extensions', () => {
    expect([...MCP_CURRENT_FEATURES].sort()).toEqual(['cacheable-lists', 'mrtr', 'server-discover']);
    // `extensions` means "the host advertises and honours `capabilities.extensions`".
    // This host honours NO extension (§D — every extension is opaque), so
    // claiming it would be the same class of lie as claiming a version.
    expect(MCP_CURRENT_FEATURES).not.toContain('extensions');
  });

  it('records the legacy window rather than silently outliving it', () => {
    // RFC 0153 §Compatibility, resolved for the date in mcp-integration.md §A.
    expect(MCP_LEGACY_PROFILE_SUNSET).toBe('2027-08-12');
  });
});

describe('ADR 0553 P2 — codec selection fails closed on an explicit unserved revision', () => {
  it('a header naming the current revision selects the current codec', () => {
    expect(selectMcpCodec(MCP_CURRENT_VERSION)).toEqual({ kind: 'current', version: MCP_CURRENT_VERSION });
  });

  it('a header naming the legacy revision selects the legacy codec', () => {
    expect(selectMcpCodec(MCP_LEGACY_VERSION)).toEqual({ kind: 'legacy', version: MCP_LEGACY_VERSION, headerPresent: true });
  });

  it('NO header is legacy semantics, not a refusal', () => {
    // Upstream: a request without the header is at most a pre-header revision,
    // and a host that speaks one serves it under those semantics. Refusing here
    // would break every existing client to enforce a rule that is not theirs —
    // and would break every legacy conformance leg.
    expect(selectMcpCodec(undefined)).toEqual({ kind: 'legacy', version: MCP_LEGACY_VERSION, headerPresent: false });
    expect(selectMcpCodec('   ')).toEqual({ kind: 'legacy', version: MCP_LEGACY_VERSION, headerPresent: false });
  });

  it('an EXPLICIT unserved revision is refused — the fail-closed path P1 deferred', () => {
    expect(selectMcpCodec('1999-01-01')).toEqual({ kind: 'unsupported', requested: '1999-01-01' });
    // 2025-11-25 is a real upstream revision this host does not speak, and
    // `mcp-integration.md` §A says it is NOT an OpenWOP composition profile.
    // Silently serving it as legacy is precisely the downgrade §B forbids.
    expect(selectMcpCodec('2025-11-25')).toEqual({ kind: 'unsupported', requested: '2025-11-25' });
  });

  it('two conflicting headers state no version, so they cannot be served', () => {
    expect(selectMcpCodec([MCP_CURRENT_VERSION, MCP_LEGACY_VERSION])).toEqual({
      kind: 'unsupported',
      requested: `${MCP_CURRENT_VERSION},${MCP_LEGACY_VERSION}`,
    });
  });
});

describe('ADR 0553 P1 — initialize reads the peer version instead of discarding it', () => {
  const init = async (params: Record<string, unknown>) =>
    (await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params }, {} as never)) as {
      result?: { protocolVersion?: string };
    };

  it('reports the LEGACY version — initialize exists only on that profile', async () => {
    const res = await init({ protocolVersion: MCP_LEGACY_VERSION });
    expect(res.result?.protocolVersion).toBe(MCP_LEGACY_VERSION);
  });

  it("reports the served version — never the peer's — on a mismatch", async () => {
    // The legacy-profile contract: answer with what we serve. The failure this
    // guards is ECHOING the request back, which would claim a version the host
    // does not implement on this profile.
    const res = await init({ protocolVersion: '2024-11-05' });
    expect(res.result?.protocolVersion).toBe(MCP_LEGACY_VERSION);
  });

  it('does NOT report the preferred (current) revision from a legacy handshake', async () => {
    // P2 made `advertisedMcpProtocolVersion()` and the legacy handshake's answer
    // DIFFER. Reporting the current revision here would claim a protocol the
    // subsequent legacy traffic contradicts — the peer would think it had
    // negotiated a stateless wire and then be answered with sessions.
    const res = await init({ protocolVersion: MCP_CURRENT_VERSION });
    expect(res.result?.protocolVersion).not.toBe(MCP_CURRENT_VERSION);
    expect(res.result?.protocolVersion).toBe(MCP_LEGACY_VERSION);
  });

  it('still answers when the peer states no version', async () => {
    expect((await init({})).result?.protocolVersion).toBe(MCP_LEGACY_VERSION);
  });

  it('classifies the request rather than ignoring it', () => {
    expect(initializeVersionOutcome('2024-11-05')).toEqual({ served: MCP_LEGACY_VERSION, requested: '2024-11-05', mismatch: true });
    expect(initializeVersionOutcome(MCP_LEGACY_VERSION)).toEqual({ served: MCP_LEGACY_VERSION, requested: MCP_LEGACY_VERSION, mismatch: false });
    // The current revision IS served by this host — just not through this
    // handshake — so it is not a mismatch, it is a peer on the wrong door.
    expect(initializeVersionOutcome(MCP_CURRENT_VERSION)).toEqual({ served: MCP_LEGACY_VERSION, requested: MCP_CURRENT_VERSION, mismatch: false });
    // No stated version is not a mismatch — there is nothing to mismatch with.
    expect(initializeVersionOutcome(undefined)).toEqual({ served: MCP_LEGACY_VERSION, mismatch: false });
    expect(initializeVersionOutcome('   ')).toEqual({ served: MCP_LEGACY_VERSION, mismatch: false });
  });
});

describe('ADR 0553 P1 — no MCP version literal survives in source', () => {
  // The drift guard. Both halves derive from mcpProfile now; a future edit that
  // re-pins a date in either file fails here, which is what would have caught
  // the server/client disagreement in the first place. P2 kept the guard and
  // extended it to the new codec — the current revision multiplied the places a
  // date could be pinned (headers, `_meta`, `server/discover`), which makes one
  // owner more important, not less.
  const versionLiteral = /['"]20\d\d-\d\d-\d\d['"]/;

  for (const file of ['mcpServerRouter.ts', 'mcpClient.ts', 'mcpCurrentCodec.ts', 'mcpSemantics.ts']) {
    it(`${file} derives the version, not a literal`, () => {
      const code = readFileSync(join(SRC, file), 'utf8');
      expect(stripComments(code)).not.toMatch(versionLiteral);
    });
  }

  it('mcpServerRouter.ts still routes the legacy handshake through the seam', () => {
    expect(readFileSync(join(SRC, 'mcpServerRouter.ts'), 'utf8')).toContain('initializeVersionOutcome(');
  });

  it('mcpClient.ts opens at the version the seam prefers', () => {
    expect(readFileSync(join(SRC, 'mcpClient.ts'), 'utf8')).toContain('advertisedMcpProtocolVersion()');
  });
});

/** Comments legitimately cite version dates (that is the reasoning trail); only
 *  executable code may not pin one. Without this the guard would force the
 *  history out of the files, which is the opposite of what is wanted. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
