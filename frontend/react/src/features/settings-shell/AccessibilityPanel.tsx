/**
 * Accessibility panel (ADR 0396 P2) — the SAME fields component the Sidebar
 * footer modal renders (`ui/A11yPrefsControl` — one store, one UI; the ADR
 * 0363 reuse-never-recreate ruling).
 */
import { A11yPrefsFields } from '../../ui/A11yPrefsControl.js';

export function AccessibilityPanel(): JSX.Element {
  return <A11yPrefsFields />;
}
