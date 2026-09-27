/**
 * ADR 0552 P0/P2 — the A2A version is a single-sourced profile choice, and the
 * host does not claim a version it cannot serve.
 *
 * What P0 pinned is the property that made it worth doing: `protocolVersion`
 * used to be a bare literal inside the Agent Card builder, so there was nothing
 * to negotiate against, nothing to refuse with, and nothing stopping the legacy
 * subset from being presented as generic A2A support — the risk ADR 0552's
 * Context names explicitly.
 *
 * P2 (2026-08-16) added `'1.0'`. The honesty assertion this file carried —
 * "does NOT claim 1.0" — has therefore been INVERTED rather than deleted, and
 * the inversion is the interesting part: the old assertion existed to stop the
 * entry landing WITHOUT the codec, so its replacement is the same rule read
 * forwards — every entry in the SSoT has a codec, a profile id, and a card
 * shape. Deleting it and moving on would have retired the guard at exactly the
 * moment it started being able to catch something.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  A2A_PROFILES,
  A2A_SUPPORTED_VERSIONS,
  LEGACY_A2A_PROTOCOL_VERSION,
  a2aProfileIdFor,
  advertisedA2AProtocolVersion,
  cardVersionFor,
  codecVersionFor,
  dispositionForA2AVersionHeader,
  servesA2AVersion,
} from '../src/host/a2aProfile.js';
import { buildA2aCard03, buildA2aCard10 } from '../src/host/a2aCard.js';
import { STORED_TASK_STATES, toWireState10 } from '../src/host/a2aCodec10.js';

describe('ADR 0552 P0/P2 — the served A2A profile is explicit', () => {
  it('advertises exactly what it serves, preferred first', () => {
    expect(A2A_SUPPORTED_VERSIONS).toEqual(['1.0', '0.3']);
    expect(A2A_SUPPORTED_VERSIONS[0]).toBe(advertisedA2AProtocolVersion());
  });

  it('P2 — every served version has a codec, a profile id, and a card shape', () => {
    // The inverted honesty assertion. P0's version said "does NOT claim 1.0 —
    // the codec does not exist yet"; the rule underneath was never about the
    // string, it was "the entry and the behaviour land together or not at all"
    // (ADR 0548 invariant 3). Read forwards, that is: for EVERY entry in the
    // SSoT there must be a profile id derived from it, a card the host can
    // build for it, and a codec the route will dispatch to. An entry added
    // without one of the three reds here, which is the same protection the old
    // negative gave, extended to versions nobody has thought of yet.
    for (const v of A2A_SUPPORTED_VERSIONS) {
      expect(A2A_PROFILES, `no profile id for A2A ${v}`).toContain(a2aProfileIdFor(v));
      const card = v === LEGACY_A2A_PROTOCOL_VERSION ? buildA2aCard03('https://h.test') : buildA2aCard10('https://h.test');
      expect(card, `no card shape for A2A ${v}`).toBeTruthy();
      // The codec the route dispatches to for an explicit header of `v`.
      expect(codecVersionFor(dispositionForA2AVersionHeader(v)), `no codec for A2A ${v}`).toBe(v);
    }
  });

  it('P2 — `profiles` is DERIVED from the versions, never a second list', () => {
    // §A: "a host MUST NOT list `a2a-X.Y` in `profiles` unless `X.Y` is in
    // `protocolVersions`". Deriving makes that structural; this pins that it
    // stays derived rather than becoming a hand-kept twin.
    expect(A2A_PROFILES).toEqual(A2A_SUPPORTED_VERSIONS.map(a2aProfileIdFor));
    expect(A2A_PROFILES).toContain('a2a-1.0');
    expect(A2A_PROFILES).toContain('a2a-0.3-legacy');
  });

  it('refuses unknown versions rather than assuming the legacy one', () => {
    expect(servesA2AVersion('0.2')).toBe(false);
    expect(servesA2AVersion('2.0')).toBe(false);
    expect(servesA2AVersion('')).toBe(false);
    expect(servesA2AVersion('0.3')).toBe(true);
    expect(servesA2AVersion('1.0')).toBe(true);
  });

  it('an ABSENT header still resolves to 0.3 for operations', () => {
    // The upstream receiver rule §B restates. Once 1.0 is preferred it becomes
    // tempting to default operations to it too; that would silently reinterpret
    // every legacy peer's request under a codec it did not write for.
    expect(codecVersionFor(dispositionForA2AVersionHeader(undefined))).toBe('0.3');
    expect(codecVersionFor(dispositionForA2AVersionHeader('0.2'))).toBeNull();
  });

  it('P2 CORRECTION — an ABSENT header resolves to 0.3 for the CARD too, while 0.3 is served', () => {
    // a2a-integration.md §C, decided 2026-08-16 (openwop#1028 / RFC 0152 S18
    // Q1). P2 shipped `absent → preferred`, which serves a 1.0 card with no
    // top-level `url` to every 0.3 client that discovers this host header-less.
    // One receiver rule now covers discovery and operations alike.
    expect(cardVersionFor(dispositionForA2AVersionHeader(undefined))).toBe('0.3');
    expect(cardVersionFor(dispositionForA2AVersionHeader('1.0'))).toBe('1.0');
    expect(cardVersionFor(dispositionForA2AVersionHeader('0.3'))).toBe('0.3');
    // Not a refusal: a card GET is discovery, and the preferred card is the
    // document that tells the caller which versions exist.
    expect(cardVersionFor(dispositionForA2AVersionHeader('0.2'))).toBe(advertisedA2AProtocolVersion());
    // The rule is CONDITIONAL on 0.3 still being served — this is what makes
    // ADR 0552 P4 (the legacy sunset) a one-line change in A2A_SUPPORTED_VERSIONS
    // rather than a second edit here. Pinned so a future P4 cannot leave the
    // header-less card pointing at a profile the host no longer serves.
    expect(A2A_SUPPORTED_VERSIONS.includes(LEGACY_A2A_PROTOCOL_VERSION)).toBe(true);
  });

  it('P2 — the D.4 state bijection is total over the stored vocabulary', () => {
    // Guards the one thing a codec split can silently lose: a stored state with
    // no 1.0 spelling would render `status.state: undefined` on the wire.
    for (const s of STORED_TASK_STATES) {
      expect(toWireState10(s), `no 1.0 spelling for stored state ${s}`).toMatch(/^TASK_STATE_[A-Z_]+$/);
    }
  });
});

describe('ADR 0552 P0/P2 — the Agent Card does not re-hard-code the version', () => {
  it('host/a2aCard.ts derives every protocolVersion instead of pinning a literal', () => {
    // Source-pinned because the regression is a one-character edit: someone
    // types `protocolVersion: '1.0'` into a card and the host advertises a
    // profile it has no codec for. Deriving makes that edit land in the profile
    // module, where the honesty test above is watching. RE-POINTED at P2 from
    // routes/agents.ts, which no longer builds cards — the builder moved to
    // host/a2aCard.ts so the card and the routing facts share one module (§C's
    // "generated from the same source the runtime routes on").
    const src = readFileSync(join(__dirname, '..', 'src', 'host', 'a2aCard.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).toContain('protocolVersion: LEGACY_A2A_PROTOCOL_VERSION');
    expect(code).not.toMatch(/protocolVersion: '[0-9]/);
    // And no card builder survives in the route layer.
    const routeSrc = readFileSync(join(__dirname, '..', 'src', 'routes', 'agents.ts'), 'utf8');
    expect(routeSrc).not.toMatch(/protocolVersion: '[0-9]/);
  });

  it('P2 — the 1.0 card carries NO 0.3 top-level shape (§C: a card with both is neither)', () => {
    const card = buildA2aCard10('https://h.test') as Record<string, unknown>;
    expect(card.url).toBeUndefined();
    expect(card.protocolVersion).toBeUndefined();
    const ifaces = card.supportedInterfaces as Array<{ protocolVersion: string; protocolBinding: string }>;
    // §C: the SET of interface versions MUST equal `protocolVersions`.
    expect([...new Set(ifaces.map((i) => i.protocolVersion))].sort()).toEqual([...A2A_SUPPORTED_VERSIONS].sort());
    // §C: the mandatory floor is the JSON-RPC binding AT 1.0.
    expect(ifaces.some((i) => i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0')).toBe(true);
    // SHOULD: the preferred interface first.
    expect(ifaces[0]!.protocolVersion).toBe(advertisedA2AProtocolVersion());
  });

  it('P2 — the 0.3 card keeps its own shape and its own version', () => {
    const card = buildA2aCard03('https://h.test') as Record<string, unknown>;
    expect(card.protocolVersion).toBe('0.3');
    expect(card.url).toBe('https://h.test/v1/host/openwop-app/a2a');
    expect(card.supportedInterfaces).toBeUndefined();
  });
});
