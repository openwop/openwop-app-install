/**
 * Claude Code frontend feature (ADR 0785) — route + nav manifest.
 * The nav entry carries `featureId: 'claude-code'`, so it hides unless the
 * toggle resolves enabled for the caller. The approval page carries no nav: it
 * is reached from the link the companion prints.
 */
import { lazy, Suspense, type JSX } from 'react';
import i18n from '../../i18n/index.js';
import { registerDeckTabKind, type DeckRailSectionProps, type DeckTabKindProps } from '../../chat/tabDeck/tabKindRegistry.js';
import { registerRouteCommandSource } from '../../ui/commandContributions.js';
import { StateCard } from '../../ui/StateCard.js';
import { TerminalIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ClaudeCodeDevicesPage = lazy(() => import('./ClaudeCodeDevicesPage.js').then((m) => ({ default: m.ClaudeCodeDevicesPage })));
const ClaudeCodePairPage = lazy(() => import('./ClaudeCodePairPage.js').then((m) => ({ default: m.ClaudeCodePairPage })));

const routes: FeatureRoute[] = [
  {
    path: '/claude-code',
    element: <ClaudeCodeDevicesPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Developer',
      label: 'Claude Code', labelKey: 'claudeCodeLabel',
      icon: TerminalIcon,
      hint: 'Your paired Claude Code devices', hintKey: 'claudeCodeHint',
      order: 40,
      featureId: 'claude-code',
    },
  },
  {
    path: '/claude-code/pair',
    element: <ClaudeCodePairPage />,
    tier: 'workspace', archetype: 'narrow-form',
  },
];

// ADR 0785 D5 — the Claude Code terminal as a chat-deck tab kind. Registered at
// import (the registry file is core; this feature is excludable), and lazy so the
// xterm chunk loads only when someone opens one.
const ClaudeCodeTerminalTab = lazy(() => import('./ClaudeCodeTerminalTab.js').then((m) => ({ default: m.ClaudeCodeTerminalTab })));
function TerminalTabKind(props: DeckTabKindProps): JSX.Element {
  return (
    <Suspense fallback={<StateCard loading title={i18n.t('claude-code:terminalLoading')} />}>
      <ClaudeCodeTerminalTab {...props} />
    </Suspense>
  );
}
// ADR 0785 D5 follow-on — the user's running sessions as a section of the chat
// rail, so leaving the chat never loses them. Lazy: off the entry chunk.
const ClaudeCodeRailSection = lazy(() => import('./ClaudeCodeRailSection.js').then((m) => ({ default: m.ClaudeCodeRailSection })));
function RailSection(props: DeckRailSectionProps): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ClaudeCodeRailSection {...props} />
    </Suspense>
  );
}
registerDeckTabKind({
  kind: 'claude-code',
  RailSection,
  label: () => i18n.t('claude-code:terminalTabLabel'),
  featureId: 'claude-code',
  Component: TerminalTabKind,
  // Closing the TAB stops Claude Code on the device; merely navigating away does not.
  onClose: (tabId) => {
    void import('./terminalTabStore.js').then(({ tabStore }) => {
      const sessionId = tabStore.get(tabId);
      tabStore.clear(tabId);
      if (sessionId) void import('./claudeCodeClient.js').then(({ stopTerminal }) => stopTerminal(sessionId).catch(() => undefined));
    });
  },
});

// ADR 0785 D5 (corrected) — "Open in Claude Code" on the pages where work lives,
// through the ⌘K palette's route-aware seam: the pages never import this feature.
// The launch prompt tells Claude Code WHAT to open and to read it over MCP (P3)
// rather than trusting a pasted copy.
export function claudeCodeLaunchFor(pathname: string): { id: string; context: string } | null {
  const m = /^\/(builder|runs|app-builder)\/([^/?#]+)\/?$/.exec(pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[2]!);
  const what = m[1] === 'builder' ? 'workflow' : m[1] === 'runs' ? 'run' : 'app-builder canvas';
  return { id: `${m[1]}:${id}`, context: `Open the ${what} ${id} in this workspace. Read it with the openwop MCP tools before changing anything.` };
}
registerRouteCommandSource('claude-code', (pathname) => {
  const launch = claudeCodeLaunchFor(pathname);
  if (!launch) return [];
  return [{
    id: `claude-code-open-${launch.id}`,
    label: i18n.t('claude-code:cmdkOpenHere'),
    hint: i18n.t('claude-code:cmdkOpenHereHint'),
    group: i18n.t('claude-code:eyebrow'),
    icon: TerminalIcon,
    to: `/chat?newTab=claude-code&tabContext=${encodeURIComponent(launch.context)}`,
    featureId: 'claude-code',
  }];
});

export const claudeCodeFeature: FrontendFeature = { id: 'claude-code', routes };
