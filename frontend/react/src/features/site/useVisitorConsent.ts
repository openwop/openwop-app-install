/**
 * React binding for the visitor consent core (`visitorConsent.ts`). Split out so
 * the core stays React-free for the tenant site runtime (ADR 1015 D2).
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  decisionFor, loadPosture, regimeFor, storedChoice, subscribeVisitorConsent, visitorConsentVersion,
  type ConsentDecision, type ConsentRegime,
} from './visitorConsent.js';

/** Re-renders on any choice or posture change, and loads the posture for
 *  `orgId` once. */
export function useVisitorConsent(orgId: string): { decision: ConsentDecision; regime: ConsentRegime | null | undefined; choice: ReturnType<typeof storedChoice> } {
  useSyncExternalStore(subscribeVisitorConsent, visitorConsentVersion, visitorConsentVersion);
  useEffect(() => { if (orgId) void loadPosture(orgId); }, [orgId]);
  return { decision: decisionFor(orgId), regime: regimeFor(orgId), choice: storedChoice(orgId) };
}
