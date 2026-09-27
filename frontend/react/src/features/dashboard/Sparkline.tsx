/** Hoisted to ui/ (ADR 0480 — the builder's online-eval trend needs it and
 *  core must not import a feature package). Re-export keeps dashboard tiles'
 *  import paths stable. */
export { Sparkline } from '../../ui/Sparkline.js';
