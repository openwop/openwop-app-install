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
import { buildAccessibilitySurface, ACCESSIBILITY_SURFACE_POLICY } from './surface.js';
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
  // ADR 1100 D1 — before the policy, a viewer's run could spend the vision
  // provider on an image its person may not edit (the floor's default is read).
  surface: { id: 'accessibility', build: buildAccessibilitySurface, orgPolicy: ACCESSIBILITY_SURFACE_POLICY },
  requiredPacks: [
    'feature.accessibility.nodes',
    'vendor.openwop-app.accessibility.agents',
  ],
  toggleDefault: {
    id: 'accessibility',
    label: 'Accessibility',
    description:
      'Authored-content accessibility: AI-generated alt text for image assets (Media), which fills the alt of a picture placed in a CMS page or document; and an Accessibility Reviewer agent in the AI chat that reads pages, documents and the media library and checks them (missing alt, heading order, link text, low contrast). The editor accessibility check in CMS and documents runs without this toggle. Composes the existing vision, contrast, and a11y-issue seams — no live-DOM auditor.',
    category: 'Content',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'accessibility',
  },
};
