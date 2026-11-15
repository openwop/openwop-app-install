/**
 * ADR 1040 D7 F1 (Book AI P47) — a feature's own words on an approval gate,
 * read by BOTH inline approval cards (the chat's `registry/defaultCards` and the
 * run-detail `interrupts/ApprovalCard`) so the two cannot drift (the ADR 0600 §2
 * lesson: one shared helper, not two copies).
 *
 * The gate's data may carry (validated server-side by
 * `host/approvalGateWording.ts`):
 *  - `actionLabels: { <verb>: "<ns>:<key>" }` — DISPLAY ONLY; the button still
 *    resolves the canonical verb.
 *  - `promptKey: "<ns>:<key>"` — the prompt, localized.
 *  - `declineExpected: true` — reject is an expected answer, confirmed gently.
 *
 * A key is used only when it EXISTS in a loaded catalog: a missing key renders
 * the surface's own canonical label, never the raw key. Feature catalogs are
 * LAZY (ADR 0490), so a card calls `useGateWordingNamespaces(data)` first: it
 * loads the namespaces the gate names and re-renders the card once they land
 * (grade-code/grade-ux M2: without it a cold chat never showed the wording).
 */
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import i18n from '../../i18n/index.js';

const I18N_KEY = /^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9_.-]{1,128}$/;

function usableKey(v: unknown): string | undefined {
  return typeof v === 'string' && I18N_KEY.test(v) && i18n.exists(v) ? v : undefined;
}

function record(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/** The i18n namespaces this gate's wording names (deduplicated, sorted). */
export function gateWordingNamespaces(data: unknown): string[] {
  const d = record(data);
  const keys = [...Object.values(record(d.actionLabels)), d.promptKey];
  const ns = new Set<string>();
  for (const k of keys) if (typeof k === 'string' && I18N_KEY.test(k)) ns.add(k.slice(0, k.indexOf(':')));
  return [...ns].sort();
}

/** Load the gate's wording namespaces and re-render when they arrive. Until
 *  then (and if a load fails) the card shows its canonical labels. */
export function useGateWordingNamespaces(data: unknown): void {
  const key = gateWordingNamespaces(data).join(',');
  const [, setLoaded] = useState(0);
  useEffect(() => {
    if (!key) return undefined;
    const missing = key.split(',').filter((n) => !i18n.hasLoadedNamespace(n));
    if (missing.length === 0) return undefined;
    let live = true;
    void i18n.loadNamespaces(missing).then(() => { if (live) setLoaded((n) => n + 1); }, () => { /* canonical labels stay */ });
    return () => { live = false; };
  }, [key]);
}

/** The feature's label for `action`, or `fallback` (the surface's canonical one). */
export function gateActionLabel(t: TFunction, data: unknown, action: string, fallback: string): string {
  const labels = record(record(data).actionLabels);
  const key = usableKey(labels[action]);
  return key ? t(key) : fallback;
}

/** The feature's localized prompt, or `fallback`. */
export function gatePrompt(t: TFunction, data: unknown, fallback: string): string {
  const key = usableKey(record(data).promptKey);
  return key ? t(key) : fallback;
}

/** Does this gate treat reject as an expected decline (not a failure)? */
export function gateDeclineExpected(data: unknown): boolean {
  return record(data).declineExpected === true;
}

export interface RejectConfirmCopy { title: string; body: string; danger: boolean; confirmLabel: string }

/**
 * The confirm shown before REJECT. Reject still ends the gate; what changes is
 * how it is described: an expected decline is not presented as a failure.
 * Precedence: a browser-action gate (ADR 0894) keeps its own copy.
 */
export function gateRejectConfirm(t: TFunction, data: unknown, opts: { browserGate: boolean }): RejectConfirmCopy {
  const confirmLabel = gateActionLabel(t, data, 'reject', t('interrupts:actionReject'));
  if (opts.browserGate) {
    return { title: t('interrupts:cuRejectConfirmTitle'), body: t('interrupts:cuRejectConfirmBody'), danger: true, confirmLabel };
  }
  if (gateDeclineExpected(data)) {
    // Deliberately NOT `danger` although the answer is final: declining is an
    // expected answer on this gate, and danger styling would teach people it is
    // a mistake. The body still says it ends the step and cannot be changed.
    return {
      title: t('interrupts:declineConfirmTitle'),
      body: t('interrupts:declineConfirmBody'),
      danger: false,
      confirmLabel: gateActionLabel(t, data, 'reject', t('interrupts:declineConfirmLabel')),
    };
  }
  return { title: t('interrupts:rejectConfirmTitle'), body: t('interrupts:rejectConfirmBody'), danger: true, confirmLabel };
}
