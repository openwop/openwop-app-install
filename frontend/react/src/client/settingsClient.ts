/**
 * Personal-settings client (ADR 0396) — the server-authoritative prefs tier
 * only (budget / escalation / privacy). Self-scoped: the backend keys by the
 * authenticated user; no ids ride the request.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const URL_ = () => `${config.baseUrl}/host/openwop-app/settings/prefs`;

export interface PersonalBudgetPref { dailyTokenCap: number; softWarningPct?: number }
export interface PrivacyPrefs { analyticsOptOut?: boolean; crashReportsOptOut?: boolean; recentFilesOptOut?: boolean }
export type ReasoningDirective = 'off' | 'advisory' | 'mandatory';

export interface UserPrefsView {
  personalBudget: PersonalBudgetPref | null;
  reasoningDirective: ReasoningDirective | null;
  privacy: PrivacyPrefs | null;
  usageToday?: { day: string; tokens: number };
  /** ADR 0693 phase 5 — the MANAGED free tier's own-usage figure, beside the
   *  BYOK one. `null`/absent on a deployment with no free tier configured,
   *  which is a different claim from "you have used none of it". */
  managedUsageToday?: {
    providerId: string; day: string; tokens: number;
    dailyTokenCap: number; remaining: number;
    /** Whose allowance this is. `tenant` means it is still shared. */
    scope: 'subject' | 'tenant';
  } | null;
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `${ctx} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function getPrefs(): Promise<UserPrefsView> {
  const res = await fetch(URL_(), fetchOpts({ headers: authedHeaders() }));
  return asJson<UserPrefsView>(res, 'load settings');
}

export async function putPrefs(input: {
  personalBudget?: PersonalBudgetPref | null;
  reasoningDirective?: ReasoningDirective | null;
  privacy?: PrivacyPrefs | null;
}): Promise<UserPrefsView> {
  const res = await fetch(URL_(), fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(input) }));
  return asJson<UserPrefsView>(res, 'save settings');
}
