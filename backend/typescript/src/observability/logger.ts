/**
 * Structured JSON logger for the workflow-engine sample.
 *
 * Emits one JSON object per line on stdout — Cloud Run's logging
 * pipeline auto-promotes structured fields. Levels: debug, info, warn,
 * error. Filtered by OPENWOP_LOG_LEVEL (default: info).
 *
 * SEC-8: every emitted `msg` + `fields` value is run through the BYOK
 * free-text scrubber before serialization — a global log-sink backstop so a
 * secret-shaped token (`sk-*`, `xai-*`, `Bearer *`, 32+ hex) that slips past
 * call-site redaction can never reach stdout/stderr verbatim. Defense-in-depth,
 * NOT a substitute for call-site redaction at persistence boundaries. Disable
 * (perf-sensitive deployments) with OPENWOP_LOG_SCRUB=off.
 */

import { sanitizeFreeText, sanitizeFreeTextDeep } from '../byok/textRedaction.js';
import { maskPiiDeep } from '../host/dataClassification.js';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const ENV_LEVEL = (process.env.OPENWOP_LOG_LEVEL as Level | undefined) ?? 'info';
const MIN_LEVEL_INDEX = LEVELS.indexOf(ENV_LEVEL);

const SCRUB_ENABLED = process.env.OPENWOP_LOG_SCRUB !== 'off';
// ADR 0077 P2 — PII log masking. INDEPENDENT of the secret scrub (privacy vs
// secret-leak are separate controls). Default ON: the pass is key-targeted (only
// values under a declared/heuristic PII field name are masked), so it cannot
// over-mask operational fields. Heuristic sub-pass also default ON (high precision).
const MASK_PII = process.env.OPENWOP_LOG_MASK_PII !== 'off';
const MASK_PII_HEURISTIC = process.env.OPENWOP_LOG_MASK_PII_HEURISTIC !== 'off';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

function shouldEmit(level: Level): boolean {
  return LEVELS.indexOf(level) >= MIN_LEVEL_INDEX;
}

function scrubFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return fields;
  // Two independent passes, composed: (1) secret scrub (substring redaction in string
  // leaves), then (2) PII mask (whole-value pseudonymization keyed on PII field NAMES).
  // Each gates on its own flag. Both preserve shape; runs inside emit()'s try/catch.
  let out: unknown = fields;
  if (SCRUB_ENABLED) out = sanitizeFreeTextDeep(out);
  if (MASK_PII) out = maskPiiDeep(out, { heuristic: MASK_PII_HEURISTIC });
  return out as Record<string, unknown>;
}

function emit(level: Level, component: string, msg: string, fields?: Record<string, unknown>): void {
  if (!shouldEmit(level)) return;
  let line: string;
  try {
    line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      component,
      msg: SCRUB_ENABLED ? sanitizeFreeText(msg) : msg,
      ...scrubFields(fields),
    });
  } catch (err) {
    // A logger must NEVER throw into its caller. A malformed `fields` (circular
    // reference → JSON.stringify throws, or a stack-overflow from the deep
    // scrub) degrades to a safe line that still records the component + message,
    // rather than crashing the code path that was only trying to log.
    line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      component,
      msg: SCRUB_ENABLED ? sanitizeFreeText(msg) : msg,
      logFieldsError: err instanceof Error ? err.message : String(err),
    });
  }
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export function createLogger(component: string): Logger {
  return {
    debug: (msg, fields) => emit('debug', component, msg, fields),
    info: (msg, fields) => emit('info', component, msg, fields),
    warn: (msg, fields) => emit('warn', component, msg, fields),
    error: (msg, fields) => emit('error', component, msg, fields),
    child: (sub) => createLogger(`${component}.${sub}`),
  };
}
