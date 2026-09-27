/**
 * ADR 0641 test-plan item 1 + decision 3 — tier→shell and posture→gate routing,
 * asserted at the DECISION level.
 *
 * These are the two pure predicates App.tsx's site branch is built from
 * (`shellForTier`, `siteWrapsAppGate`) plus the bootstrap predicate that
 * replaced `showPublic` (`tierIsSessionBearing`). The ADR says routing is
 * "observable ONLY through the routing boundary", and a full render harness for
 * the branch lives with the component tests; what is pinned HERE is the logic
 * the branch delegates to, because that is where the conflation lived and where
 * a regression would be silent.
 *
 * Why that matters rather than being a hedge: the old `showPublic` boolean
 * answered "is this the bare marketing shell" and was then REUSED to answer
 * "should we open a session". One value owning two questions is precisely why a
 * bare-shell-but-authenticated surface was inexpressible. Splitting it is the
 * change; these cases are the split.
 */

import { describe, it, expect } from 'vitest';
import {
  shellForTier,
  siteWrapsAppGate,
  tierIsSessionBearing,
  tierRendersConsoleChrome,
} from '../tierShell.js';
import type { FeatureTier } from '../featureTypes.js';

const ALL_TIERS: FeatureTier[] = ['workspace', 'admin', 'public', 'site'];

describe('ADR 0641 — tier selects the shell', () => {
  it('maps every tier, and the mapping is total', () => {
    expect(ALL_TIERS.map(shellForTier)).toEqual(['app', 'admin', 'public', 'site']);
  });

  it('gives `site` its own shell — not PublicShell, not the workspace shell', () => {
    // The whole reason the ADR made this a TIER rather than a `chrome` variant:
    // chromeFor()'s result is consumed after shell selection, so a chrome value
    // is structurally incapable of choosing a shell.
    expect(shellForTier('site')).not.toBe(shellForTier('public'));
    expect(shellForTier('site')).not.toBe(shellForTier('workspace'));
  });
});

describe('ADR 0641 decision 3 — posture, not tier, decides the gate', () => {
  it("`required` wraps AppGate", () => {
    expect(siteWrapsAppGate('required')).toBe(true);
  });

  it("`optional` MUST NOT wrap AppGate", () => {
    expect(siteWrapsAppGate('optional')).toBe(false);
  });

  it('omission fails CLOSED — an undeclared posture gets the sign-in wall', () => {
    // A route that forgets the field must not silently expose a surface. This
    // is the same default as siteRouteContract and tierShell; all three agree
    // so there is one answer to "what does omission mean", not three.
    expect(siteWrapsAppGate(undefined)).toBe(true);
  });

  it('one tier spans both postures — which is the point', () => {
    // David: all six surfaces are "on the public side of the app, not the
    // private side", regardless of individual auth requirement. So a
    // participant-scoped Leaderboard and an anonymous Discover share a shell
    // and differ only here.
    expect(shellForTier('site')).toBe('site');
    expect(siteWrapsAppGate('required')).not.toBe(siteWrapsAppGate('optional'));
  });
});

describe('ADR 0641 — session bootstrap keys on session-bearing, not on "is public"', () => {
  it('`site` is session-bearing under BOTH postures', () => {
    // `auth:'optional'` still renders richer for a signed-in visitor, so it
    // wants the session when one exists. Keying bootstrap on the old
    // `showPublic` would have denied it one.
    expect(tierIsSessionBearing('site')).toBe(true);
  });

  it('only `public` is genuinely sessionless', () => {
    expect(tierIsSessionBearing('public')).toBe(false);
    expect(tierIsSessionBearing('workspace')).toBe(true);
    expect(tierIsSessionBearing('admin')).toBe(true);
  });
});

describe('ADR 0641 decision 3 — console chrome never reaches a site route', () => {
  it('site and public render NO console chrome', () => {
    // Stated in the ADR concretely: "a participant at /today must not receive a
    // vendor-setup prompt." Also excludes the Sidebar rail, AutoSeedExampleData
    // and InMemoryHostBanner — four omissions that would otherwise be
    // hand-maintained in a JSX branch and silently drift.
    expect(tierRendersConsoleChrome('site')).toBe(false);
    expect(tierRendersConsoleChrome('public')).toBe(false);
  });

  it('workspace and admin still do', () => {
    expect(tierRendersConsoleChrome('workspace')).toBe(true);
    expect(tierRendersConsoleChrome('admin')).toBe(true);
  });

  it('every tier has an answer — no tier falls through to a default', () => {
    for (const t of ALL_TIERS) {
      expect(typeof tierRendersConsoleChrome(t)).toBe('boolean');
      expect(typeof tierIsSessionBearing(t)).toBe('boolean');
    }
  });
});
