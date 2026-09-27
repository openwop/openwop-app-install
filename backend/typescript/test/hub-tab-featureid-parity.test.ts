/**
 * ADR 0719 — every frontend `hubTab.featureId` must name a feature that actually
 * REGISTERS a toggle default.
 *
 * WHY THIS LIVES IN THE BACKEND. The frontend cannot perform this check: it has no
 * access to the toggle registry, and that is precisely why the defect was invisible.
 * `useFeatureVisible` is `!featureId || byId[featureId]?.enabled === true`, and `byId`
 * comes from `/assignments`, which lists REGISTERED toggles only. A feature that
 * graduated to always-on declares no `toggleDefault`, so it never appears — and
 * `undefined?.enabled === true` is `false`. **The hook cannot tell "this toggle does not
 * exist" from "this toggle is off."**
 *
 * MEASURED before the fix: two tabs named retired toggles and were filtered out of their
 * consoles entirely —
 *     models:          declared=2 visible=1  LOST=leaderboard      (featureId 'evals')
 *     chat-deployment: declared=2 visible=1  LOST=scheduled-chats  (featureId 'scheduled-agent-chats')
 * and because both consoles take a "one visible destination ⇒ render the pane directly"
 * branch, the tab strip vanished too. The loss left NO trace in the UI.
 *
 * This repo already reads `frontend/react` from backend tests (access-header-parity and
 * others), so the cross-workspace check is idiomatic; the SSoT it needs — the registry
 * and RETIRED_TOGGLE_IDS — lives on this side.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listToggleDefaults, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { BACKEND_FEATURES } from '../src/features/index.js';

const FE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'react', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every `featureId:` that appears INSIDE a `hubTab: { … }` literal. */
function hubTabFeatureIds(): { file: string; id: string }[] {
  const found: { file: string; id: string }[] = [];
  for (const file of walk(FE_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/hubTab:\s*\{([^}]*)\}/g)) {
      const id = /featureId:\s*'([^']+)'/.exec(m[1] ?? '');
      if (id?.[1]) found.push({ file: file.slice(FE_SRC.length + 1), id: id[1] });
    }
  }
  return found;
}

describe('ADR 0719 — hub tabs cannot be gated on a toggle that does not exist', () => {
  it('non-vacuity: the walker finds the manifest and some hubTabs declare a featureId', () => {
    // Without this, a broken path or a regex drift would make the assertion below pass
    // over an EMPTY set — a check that cannot fail, which is the family this ADR is about.
    const ids = hubTabFeatureIds();
    expect(ids.length, 'the walker must find real hubTab featureIds').toBeGreaterThan(0);
  });

  it('every hubTab.featureId names a feature that REGISTERS a toggle default', () => {
    // Register the defaults the way boot does, so `listToggleDefaults()` is populated.
    for (const f of BACKEND_FEATURES) {
      if (f.toggleDefault) registerToggleDefault(f.toggleDefault);
    }
    const registered = new Set(listToggleDefaults().map((t) => t.id));
    const offenders = hubTabFeatureIds().filter((x) => !registered.has(x.id));
    expect(
      offenders.map((o) => `${o.file} → featureId '${o.id}'`),
      'a hubTab gated on an UNREGISTERED toggle is filtered out of its console and leaves no trace — '
      + 'omit `featureId` for an always-on/graduated feature (see model-router, chat-widget)',
    ).toEqual([]);
  });
});
