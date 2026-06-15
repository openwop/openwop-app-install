/**
 * Agent Knowledge frontend feature (ADR 0038). It contributes NO top-level
 * route/nav entry — the "Agent Knowledge" panel mounts as a tab on the EXISTING
 * agent workspace surface (`AgentWorkspacePage`), gated on the `agent-knowledge`
 * toggle via `useFeatureAccess` at render time. Registered here so the feature
 * is listed in `FRONTEND_FEATURES` for parity with the backend registry (the
 * single composition seam, ADR 0001 §2.2).
 */
import type { FrontendFeature } from '../registry.js';

export const agentKnowledgeFeature: FrontendFeature = {
  id: 'agent-knowledge',
  routes: [],
};
