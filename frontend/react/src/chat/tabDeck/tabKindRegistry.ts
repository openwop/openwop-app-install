/**
 * ADR 0785 D5 — non-conversation tab kinds for the chat deck.
 *
 * The deck is core (`chat/`) and a feature is excludable, so the deck may not
 * import a feature (ADR 0630 layer 1). A feature REGISTERS a kind here at import
 * time (the `CardRegistry` pattern) and the deck renders whatever is registered.
 * A distribution that excludes the feature never imports it, so its kind never
 * exists — no dead menu item, no unreachable tab.
 *
 * This is deliberately NOT a second chat: a kind renders a TOOL surface inside a
 * deck tab (a terminal onto the user's own Claude Code). It gets no composer, no
 * message model, no conversation id. Anything conversational still goes through
 * the one chat (CLAUDE.md, "AI chat — reuse, never recreate").
 */
import type { ComponentType } from 'react';

export interface DeckTabKindProps {
  /** The deck's tab id (stable across reloads). */
  tabId: string;
  /** Whether this tab is the visible one (kind surfaces may pause work when hidden). */
  active: boolean;
  /** Set the tab's label (persisted with the deck). */
  setTitle: (title: string) => void;
  /** Close this tab (e.g. the surface ended for good). */
  close: () => void;
  /** One-shot context from the `?newTab=<kind>&tabContext=…` deep link that opened
   *  this tab (e.g. "work on workflow wf_1"). Undefined for a tab opened any other way. */
  launchContext?: string;
}

/**
 * Props for a kind's OPTIONAL rail section (ADR 0785 D5 follow-on). The deck
 * renders the section inside the Conversations rail, after Agents · Channels ·
 * Groups, only while the kind's feature is visible. The section lists the
 * feature's own resources (e.g. running Claude Code sessions) and opens or
 * focuses tabs through these callbacks — it never reaches into the deck.
 */
export interface DeckRailSectionProps {
  /** Ids of the open tabs of THIS kind, in deck order. */
  openTabIds: readonly string[];
  /** The deck's active tab id (any kind), for the row selection echo. */
  activeTabId: string | null;
  /** Focus an already-open tab. */
  focusTab: (tabId: string) => void;
  /** Open a NEW tab of this kind. `seed(tabId)` runs synchronously BEFORE the tab
   *  joins the deck (so before its Component mounts) — the place to pre-seed
   *  per-tab state the Component reads at mount. `title` labels the new tab. */
  openNewTab: (opts?: { seed?: (tabId: string) => void; title?: string }) => void;
}

export interface DeckTabKind {
  /** Persisted on the tab: `^[a-z][a-z0-9-]{0,31}$`. */
  kind: string;
  /** Menu label (already localized by the registering feature). */
  label: () => string;
  /** The feature toggle that must resolve enabled for the kind to be offered. */
  featureId: string;
  Component: ComponentType<DeckTabKindProps>;
  /** Called when the user CLOSES the tab (not on unmount — navigating away keeps the tool running). */
  onClose?: (tabId: string) => void;
  /** Optional rail section contributed by the feature (see DeckRailSectionProps). */
  RailSection?: ComponentType<DeckRailSectionProps>;
}

const kinds = new Map<string, DeckTabKind>();

export function registerDeckTabKind(k: DeckTabKind): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(k.kind)) throw new Error(`invalid deck tab kind '${k.kind}'`);
  kinds.set(k.kind, k);
}

export function getDeckTabKind(kind: string | undefined): DeckTabKind | undefined {
  return kind ? kinds.get(kind) : undefined;
}

export function listDeckTabKinds(): DeckTabKind[] {
  return [...kinds.values()];
}

/** Test-only. */
export function __clearDeckTabKindsForTest(): void { kinds.clear(); }
