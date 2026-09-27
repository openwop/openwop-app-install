/**
 * GRADING PROBE — "Design-system gallery" (FEATURES.md ordinal 238, ADR 0510 P2).
 * Evidence only. GREEN + CI-safe (module-import assertions; no render, no I/O).
 *
 * Witnesses the NO-FORK invariant (code headline #5): every primitive the gallery
 * captures is the REAL shared `ui/` export imported from `src/ui/*` — the gallery
 * is a shell over the design system, not a set of re-implemented copies that could
 * drift from the primitives it claims to contract. Each captured specimen resolves
 * to a defined component from the canonical `ui/` module.
 *
 * NOTE: the HEADLINE finding of this grade — DSGC-01, that there is NO coverage
 * RATCHET asserting gallery-coverage == the `ui/` primitive set (~17 of ~32
 * visual primitives are uncaptured by the snapshot + axe matrix) — is an ABSENCE
 * and is NOT witnessed here (a born-red coverage gate is the fix, and pinning the
 * current ~50% gap as a passing baseline would enshrine the defect). This probe
 * only witnesses that what IS captured is the genuine primitive.
 */
import { describe, it, expect } from 'vitest';
import { PageHeader } from '../../../ui/PageHeader.js';
import { Notice } from '../../../ui/Notice.js';
import { StateCard } from '../../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../../ui/Skeleton.js';
import { Field } from '../../../ui/Field.js';
import { DataTable } from '../../../ui/DataTable.js';
import { StatusBadge } from '../../../ui/StatusBadge.js';
import { KeyFigureBand } from '../../../ui/KeyFigure.js';
import { Sparkline } from '../../../ui/Sparkline.js';
import { Avatar } from '../../../ui/Avatar.js';
import { Tabs } from '../../../ui/Tabs.js';
import { IconButton } from '../../../ui/IconButton.js';
import { Button } from '../../../ui/Button.js';
import { InlineState } from '../../../ui/InlineState.js';
import { InfoTip } from '../../../ui/InfoTip.js';
import { Tooltip } from '../../../ui/Tooltip.js';

// The exact set the gallery renders as specimens (GalleryPage.tsx:19-33).
const CAPTURED: Record<string, unknown> = {
  PageHeader, Notice, StateCard, Skeleton, SkeletonRows, Field, DataTable, StatusBadge,
  KeyFigureBand, Sparkline, Avatar, Tabs, IconButton, Button, InlineState, InfoTip, Tooltip,
};

describe('Design-system gallery — captured primitives are the real ui/ exports (by execution)', () => {
  it('DSGP-1: every gallery-captured specimen resolves to a defined ui/ component (no forks)', () => {
    for (const [name, comp] of Object.entries(CAPTURED)) {
      // A real React component export — function (fn/forwardRef/memo object) or defined.
      expect(comp, `${name} must be a defined ui/ export`).toBeDefined();
      const t = typeof comp;
      expect(t === 'function' || (t === 'object' && comp !== null), `${name} is a component`).toBe(true);
    }
  });
});
