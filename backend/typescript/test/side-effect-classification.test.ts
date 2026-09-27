/**
 * ADR 0341 — a node that reaches OUTSIDE the run must be replay-classified.
 *
 * The regression this exists for: #2871 retargeted 55 chain nodes off
 * `core.openwop.integration.notification-push` — matched by the
 * `^core\.openwop\.integration\.` family — onto
 * `feature.notifications.nodes.notify`, which matched NOTHING. All 55 silently
 * left ADR 0341 protection, so a `replay` fork would emit a second real
 * notification, while the node's own docblock claimed the opposite
 * ("outputs are recorded so replay/fork read the recorded verdict rather than
 * re-notifying"). Nothing in ~9600 tests noticed: `isSideEffectingNode` had no
 * test of its own, and the chain suites only check that a typeId RESOLVES.
 *
 * The generalisable rule below is anchored on the emitter seam rather than on
 * node NAMES. A name heuristic flagged 7 internal writes (`create-order`,
 * `create-task`, …) whose classification is a genuine open ADR 0341 question —
 * a gate that needs a 7-deep allowlist on day one is not a gate. "Calls the
 * notification emitter" is mechanically true and has no judgement in it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

describe('the classifier covers the families it claims', () => {
  it('classifies the in-app notify node — the #2871 regression', () => {
    expect(isSideEffectingNode('feature.notifications.nodes.notify')).toBe(true);
  });

  it('classifies the node that reaches the emitter through a HOST SURFACE', () => {
    // `feature.kicktodo.nodes.session-reminder` delivers a cohort session reminder
    // via `features/kicktodo-accountability/sessionService.ts`, which imports
    // `getNotificationEmitter`. Its own pack `.mjs` is clean, so the seam scan
    // below is structurally blind to it — it needs an explicit entry, and this
    // assertion is the only thing holding that entry in place.
    expect(isSideEffectingNode('feature.kicktodo.nodes.session-reminder')).toBe(true);
  });

  it('still classifies the retired push node and the rest of the integration family', () => {
    for (const typeId of [
      'core.openwop.integration.notification-push',
      'core.openwop.integration.email-send',
      'core.openwop.integration.slack-message',
      'core.openwop.http.fetch',
      'feature.whatsapp.nodes.send',
      'core.openwop.a2a.send-message',
    ]) {
      expect(isSideEffectingNode(typeId), `${typeId} lost its classification`).toBe(true);
    }
  });

  it('leaves read/pure nodes live — the classification is not blanket', () => {
    // A classifier that returned true for everything would pass every assertion
    // above while breaking replay for pure nodes.
    for (const typeId of ['core.ai.chatCompletion', 'core.flow.if', 'feature.crm.nodes.get-company']) {
      expect(isSideEffectingNode(typeId), `${typeId} should replay live`).toBe(false);
    }
  });

  it('honours an explicit module flag for programmatically-registered nodes', () => {
    expect(isSideEffectingNode('some.programmatic.node', { sideEffecting: true })).toBe(true);
  });
});

describe('any node pack that reaches the notification emitter IN PACK SOURCE is classified', () => {
  // SCOPE, stated precisely because the first version of this docblock over-claimed
  // and the grade pass produced a live counterexample within minutes:
  //
  // This scan sees ONE of the two ways a node reaches the emitter — a direct
  // reference in the pack's own `.mjs`. It CANNOT see the other: a node that
  // delegates to a host feature surface which emits.
  // `feature.kicktodo.nodes.session-reminder` is exactly that — its pack source
  // is clean, while `features/kicktodo-accountability/sessionService.ts` imports
  // `getNotificationEmitter`. It is classified by an explicit entry in
  // `sideEffects.ts`, not by this scan.
  //
  // So this block protects new PACK-SOURCE emitters, and the explicit assertions
  // above protect the host-surface ones. Claiming it catches "any emitting node"
  // would be this repo's own recurring defect — a check whose summary line
  // describes a corpus wider than the one it scanned.
  const EMITTER_USE = /features\s*\.\s*notifications|notifications\s*\.\s*emit\b/;

  const emitting: string[] = [];
  for (const manifest of globSync(join(REPO, 'packs', '*', 'pack.json'))) {
    const impl = join(dirname(manifest), 'index.mjs');
    if (!existsSync(impl)) continue;
    if (!EMITTER_USE.test(readFileSync(impl, 'utf8'))) continue;
    const pack = JSON.parse(readFileSync(manifest, 'utf8')) as { nodes?: { typeId?: string; id?: string }[] };
    for (const n of pack.nodes ?? []) {
      const typeId = n.typeId ?? n.id;
      if (typeId) emitting.push(typeId);
    }
  }

  it('fixture guard: at least one emitting pack node was found', () => {
    // Zero would make the assertion below pass without checking anything — the
    // exact "summary line describes a corpus it did not scan" failure.
    expect(emitting, 'no pack reaches the notification emitter — the scan found nothing to check').not.toEqual([]);
  });

  it('every one of them is side-effecting', () => {
    const unclassified = emitting.filter((t) => !isSideEffectingNode(t));
    expect(
      unclassified,
      'this node emits a user-visible notification but a replay fork would re-emit it (ADR 0341)',
    ).toEqual([]);
  });
});
