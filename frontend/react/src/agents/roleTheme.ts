/**
 * Role THEME resolution (glyph + label per role family) — split from
 * `roleTemplates.ts` so the chat entry path (MessageBubble, ConversationLineup)
 * doesn't drag the full role-template catalog (persona prompts + workflow
 * metadata, ~7 kB min) into the entry chunk. This leaf holds only the theme map
 * and the portfolio-FREE resolver; the portfolio-inference variant
 * (`roleThemeForAgent`) stays in `roleTemplates.ts` for the lazy feature pages
 * that pass a real workflow portfolio.
 */

import type { CSSProperties } from 'react';
import {
  ActivityIcon,
  BotIcon,
  BriefcaseIcon,
  BuildingIcon,
  FileTextIcon,
  LifeBuoyIcon,
  SparklesIcon,
  MegaphoneIcon,
  ScaleIcon,
  UserIcon,
  WrenchIcon,
} from '../ui/icons/index.js';

type IconComponent = (props: { size?: number; strokeWidth?: number; style?: CSSProperties }) => JSX.Element;

export interface RoleTheme {
  key: string;
  /** Human label for the role family (e.g. "Sales", "Support"). */
  label: string;
  Icon: IconComponent;
}

export const ROLE_THEMES: Record<string, RoleTheme> = {
  // ADR 0023 (corrected) — the Chief of Staff is a real roster agent; its
  // theme glyph is the sparkles mark the assistant has always carried.
  'chief-of-staff': { key: 'chief-of-staff', label: 'Chief of Staff', Icon: SparklesIcon },
  // ADR 0032 — the ten canonical Enterprise Digital Work Twins. Each new roleKey
  // gets a distinct glyph so a seeded roster reads at a glance (the seeder stamps
  // RosterEntry.roleKey → roleThemeForKey resolves the glyph). Icon-only
  // differentiation per DESIGN.md §3 (no per-role colour). Chief of Staff (=Iris)
  // is above; Executive Operations rides the same assistant surface (ADR 0032
  // §Exec-vs-Iris) but is a distinct roster instance, so it carries its own glyph.
  'sales-execution': { key: 'sales-execution', label: 'Sales Execution', Icon: BriefcaseIcon },
  'customer-success': { key: 'customer-success', label: 'Customer Success', Icon: LifeBuoyIcon },
  'finance-close': { key: 'finance-close', label: 'Finance Close', Icon: ScaleIcon },
  'it-service-desk': { key: 'it-service-desk', label: 'IT Service Desk', Icon: WrenchIcon },
  'internal-comms': { key: 'internal-comms', label: 'Internal Comms', Icon: MegaphoneIcon },
  'recruiting-coordinator': { key: 'recruiting-coordinator', label: 'Recruiting', Icon: UserIcon },
  'people-ops': { key: 'people-ops', label: 'People Ops', Icon: BuildingIcon },
  'contract-procurement': { key: 'contract-procurement', label: 'Contract & Procurement', Icon: FileTextIcon },
  'executive-ops': { key: 'executive-ops', label: 'Executive Ops', Icon: ActivityIcon },
};

export const CUSTOM_THEME: RoleTheme = { key: 'custom', label: 'Custom', Icon: BotIcon };

/** Map a role-template key (or anything) to its theme; unknown → the custom (Bot) theme. */
export function roleThemeForKey(key: string | undefined): RoleTheme {
  return (key && ROLE_THEMES[key]) || CUSTOM_THEME;
}

/**
 * Portfolio-FREE theme resolution: the persisted roleKey wins, else the seeded
 * `host:<example|demo>-<key>` agentRef. Exactly what the chat surfaces need —
 * they call with an empty portfolio, so the roleTemplates inference loop was
 * dead code there. Callers with a real portfolio use `roleThemeForAgent`
 * (roleTemplates.ts), which layers the overlap inference on top of this.
 */
export function roleThemeForAgentId(agentId: string | undefined, explicitRoleKey?: string): RoleTheme {
  if (explicitRoleKey && ROLE_THEMES[explicitRoleKey]) return ROLE_THEMES[explicitRoleKey];
  if (agentId) {
    const m = /^host:(?:example|demo)-(.+)$/.exec(agentId);
    const key = m?.[1];
    if (key && ROLE_THEMES[key]) return ROLE_THEMES[key];
  }
  return CUSTOM_THEME;
}
