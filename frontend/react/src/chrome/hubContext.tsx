/**
 * Hub embedding context (ADR 0144, generalized by ADR 0145).
 *
 * A tabbed console (`features/access-hub/`, `features/models/`,
 * `features/chat-deployment/`) renders existing surfaces — `KeysPage`,
 * `LeaderboardPage`, `WidgetsPage`, … — as tab bodies. Because those elements are
 * pre-constructed in the `FEATURES` manifest (`element: <KeysPage/>`), a console
 * cannot pass them props at render time; it communicates "you are embedded, at
 * this scope" through this context instead.
 *
 * It lives in `chrome/` (core), NOT in a feature directory, on purpose: the
 * surfaces that READ it span core (`byok/KeysPage`) and many features. A context
 * in a feature directory would force `core → feature` and `feature → feature`
 * imports (forbidden by ARCHITECTURE.md). Core is importable by everyone, so this
 * is the only correct home.
 *
 * Outside a console the default applies: `embedded:false`, `scope:'workspace'` —
 * so every existing standalone page renders exactly as before.
 */
import { createContext, useContext, type ReactNode } from 'react';

/** Scope-pill position. Only the Access Hub uses both values; flat consoles
 *  (Models, Chat deployment) leave it at the `'workspace'` default. */
export type HubScope = 'workspace' | 'personal';

export interface HubState {
  /** True when this surface is rendered as a tab INSIDE a console. A page uses
   *  it to drop its own `<PageHeader>` (the console owns the page chrome). */
  embedded: boolean;
  /** The active scope-pill position. Scope-aware surfaces (Keys, Connections)
   *  read it to show the caller's personal vs the workspace catalog (ADR 0144). */
  scope: HubScope;
}

const DEFAULT: HubState = { embedded: false, scope: 'workspace' };

const Ctx = createContext<HubState>(DEFAULT);

/** Wrap an embedded tab body. Marks `embedded:true` and carries the active scope
 *  (defaults to `'workspace'` for consoles without a scope pill). */
export function HubProvider({ scope = 'workspace', children }: { scope?: HubScope; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={{ embedded: true, scope }}>{children}</Ctx.Provider>;
}

/** Read the console embedding state. Defaults to not-embedded / workspace scope. */
export function useHub(): HubState {
  return useContext(Ctx);
}
