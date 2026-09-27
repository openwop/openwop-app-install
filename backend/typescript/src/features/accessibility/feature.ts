/**
 * Authored-Content Accessibility (ADR 0363) — an in-app a11y layer that COMPOSES
 * existing seams rather than forking MyndHyve's `src/core/accessibility/`
 * singleton (4 of its 6 primitives already ship here: focus-trap = `ui/
 * useFocusTrap`, announcer exists per-surface, contrast = the build-time token
 * gate + ADR 0171 solve, an `A11yIssue` model = ADR 0334). This feature adds only
 * the genuinely-missing slice.
 *
 * Phase 1 (this file) ships the toggle only. AI alt-text generation lives beside
 * `autotagAsset` in the MEDIA package (where the byte + vision seams are) and is
 * exposed by a media route GATED on this `accessibility` toggle — so Phase 1 adds
 * no routes of its own. Phases 2–3 add the shared content-a11y checker route, the
 * `ctx.features.accessibility` surface, and the `feature.accessibility.{nodes,
 * agents}` packs here.
 *
 * @see docs/adr/0363-authored-content-accessibility.md
 */

import type { BackendFeature } from '../types.js';
import { buildAccessibilitySurface } from './surface.js';
import { registerAccessibilityAgentTools } from './agentTools.js';

export const accessibilityFeature: BackendFeature = {
  id: 'accessibility',
  // P1: the alt-text route is media-hosted (gated on this toggle). P3: register
  // the agent tools (the chat-drivability seam) here; the workflow surface + packs
  // are declared below.
  registerRoutes: () => {
    registerAccessibilityAgentTools();
  },
  // P3 (ADR 0014) — `ctx.features.accessibility`: checkContent (read) +
  // generateAltText (write). Auto-advertised at /.well-known as host.sample.accessibility.
  surface: { id: 'accessibility', build: buildAccessibilitySurface },
  requiredPacks: [
    { name: 'feature.accessibility.nodes', version: '1.0.0' },
    { name: 'feature.accessibility.agents', version: '1.0.0' },
  ],
  toggleDefault: {
    id: 'accessibility',
    label: 'Accessibility',
    description:
      'Authored-content accessibility: AI-generated alt text for image assets (Media), a shared authored-content a11y checker (missing alt, heading order, low-contrast on authored colors) surfaced in the CMS / documents / app-builder editors, and an Accessibility Reviewer agent driven from the AI chat. Composes the existing vision, contrast, and a11y-issue seams — no live-DOM auditor. OFF by default.',
    category: 'Content',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'accessibility',
  },
};
