/**
 * `store: true` is a promise about the TYPE — this pins the premise that makes it true.
 *
 * THE RULING IT ENFORCES (RFC 0142, scope clarified 2026-08-10). `store: true` is
 * universally quantified over paths that persist an artifact carrying a REGISTERED
 * `artifactTypeId`: every such path must emit `artifact.created`. Not "at least
 * one path". A consumer reads the advert to decide whether it may RELY on the
 * event; under an "at least one" reading that reliance breaks exactly when it
 * matters, and the consumer cannot distinguish persisted-without-event from
 * never-produced.
 *
 * THIS HOST HAS TWO PERSISTING PATHS AND ONLY ONE EMITS:
 *   - `feature.documents.nodes.generate-from-template` → persists + EMITS.
 *   - the `outputs.artifact` envelope → `persistRunArtifact`, which emits NOTHING
 *     by explicit design (`runArtifactStore.ts:18`). It gates on
 *     `isRegisteredArtifactType` and writes the row WITH the type, so it is
 *     squarely in scope — the unregistered-tier carve-out does not rescue it.
 *
 * So the advert is honest only while no advertised type can reach the second path.
 * That is a REACHABILITY fact about the installed packs, not a property of the
 * discovery code — which means it can be broken by a future pack that this repo's
 * own tests would otherwise never notice. Hence a ratchet rather than a comment.
 *
 * WHY BOTH A BOOTED HOST AND A SOURCE SCAN. The two halves check different things
 * and neither suffices. The ADVERTISED set is read from the live discovery document,
 * because a test that mirrors the predicate as a constant checks a copy of the rule
 * — v1 did exactly that, and a sabotage widening the advert to every type left it
 * GREEN. The ROUTED set is a source scan, because the defect guarded against is
 * someone ADDING an `outputs.artifact` envelope for an advertised type, which a
 * runtime probe cannot see until that code path actually executes.
 *
 * IF THIS GOES RED, the fix is NOT to widen the allowlist. Either stop routing
 * that type through the non-emitting path, or stop advertising `store: true` for
 * it — the advert is a wire promise, and a red here means the promise became false.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '../../..');
const PACKS = join(REPO, 'packs');
const BACKEND_SRC = join(here, '../src');

/** The advertised set is read from the LIVE discovery document, never mirrored as
 *  a constant here. v1 hard-coded the `doc.` prefix and a sabotage proved the cost:
 *  widening the advert to every type left this test GREEN, because it was checking
 *  a copy of the rule instead of the rule. Same defect as asserting a capability on
 *  a resolver's fallback arm — the check has to read what the host actually says. */
async function advertisedStoreTypes(base: string): Promise<string[]> {
  const doc = (await (await fetch(`${base}/.well-known/openwop`)).json()) as Record<string, unknown>;
  const at = (doc['artifactTypes'] ?? {}) as { types?: Record<string, { store?: boolean }> };
  return Object.entries(at.types ?? {}).filter(([, f]) => f?.store === true).map(([id]) => id);
}

function walk(dir: string, out: string[] = [], exts = ['.mjs', '.ts']): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out, exts);
    else if (exts.some((e) => p.endsWith(e)) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/** Every artifactTypeId written into an `outputs.artifact`-shaped ENVELOPE — i.e.
 *  every type that can reach `persistRunArtifact`'s typed (non-emitting) path.
 *
 *  The envelope must carry `payload`: `detectTypedArtifact` returns null when
 *  `payload` is absent (`runArtifactStore.ts:140`), so a bare `artifactTypeId`
 *  reference cannot reach persistence.
 *
 *  v1 of this scan matched EVERY `artifactTypeId:` literal and reported
 *  `launchStudioSurface.ts:48` — a `sharedArtifactRefs` entry in seeded demo data,
 *  which is a reference, not an envelope. A predicate matching a superset of what
 *  it claims produces a confident wrong answer; requiring `payload` is what makes
 *  this scan describe the thing it is named after. Known limit: the window is
 *  textual, so an envelope that sets `payload` more than ~300 chars away from its
 *  `artifactTypeId` would be missed — no such site exists today, and the second
 *  leg's emitter assertion is the backstop if one appears. */
function typesRoutedToTheNonEmittingPath(): { id: string; where: string }[] {
  const found: { id: string; where: string }[] = [];
  for (const file of [...walk(PACKS), ...walk(BACKEND_SRC)]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/artifactTypeId:\s*['"]([^'"]+)['"]/g)) {
      const window = text.slice(Math.max(0, m.index - 300), m.index + 300);
      if (!/\bpayload\s*:/.test(window)) continue; // a ref, not an envelope
      found.push({ id: m[1]!, where: relative(REPO, file) });
    }
  }
  return found;
}

describe('store: true — the reachability premise', () => {
  it('no type advertised `store: true` is routed through the NON-emitting persist path', async () => {
    const advertised = await advertisedStoreTypes(BASE);
    const routed = typesRoutedToTheNonEmittingPath();

    // Non-vacuity on the ADVERT side too: if the host advertised `store` for
    // nothing, the violation filter below is empty for the wrong reason.
    expect(advertised.length, 'this host advertises store:true for its document types').toBeGreaterThan(0);

    // Non-vacuity: this host really does route types through that path. If the
    // scan finds nothing, the assertion below is satisfied by an empty set and
    // proves nothing — which is the failure mode this whole file exists to avoid.
    expect(routed.length, 'the scan found no envelopes at all — it is not looking where it thinks').toBeGreaterThan(5);

    const advertisedSet = new Set(advertised);
    const violations = routed.filter((r) => advertisedSet.has(r.id));
    expect(
      violations.map((v) => `${v.id} @ ${v.where}`),
      'a doc.* type reaching the outputs-artifact envelope would persist WITHOUT emitting, making `store: true` a false advert',
    ).toEqual([]);
  });

  it('the emitting path is still the ONLY emitter — the other half of the premise', () => {
    let emitSites: string[] = [];
    for (const file of walk(PACKS)) {
      const text = readFileSync(file, 'utf8');
      // Real calls only. The string `artifact.created` also appears in pack
      // COMMENTS that do not emit — one of which claimed an emission that never
      // happened until it was corrected on 2026-08-10.
      for (const _m of text.matchAll(/\bemit\(\s*['"]artifact\.created['"]/g)) {
        const rel = relative(REPO, file);
        // Skip a match that is inside a `//` comment line.
        const lines = text.split('\n').filter((l) => /\bemit\(\s*['"]artifact\.created['"]/.test(l) && !l.trim().startsWith('//'));
        if (lines.length > 0) emitSites.push(rel);
      }
    }
    emitSites = [...new Set(emitSites)];
    expect(emitSites, 'if a SECOND emitter appears, the store partition must be re-derived').toEqual([
      'packs/feature.documents.nodes/index.mjs',
    ]);
  });
});
