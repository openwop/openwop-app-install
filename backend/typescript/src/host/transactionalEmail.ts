/**
 * Transactional email — the ONE seam (ADR 0905 D6; hoisted from
 * `features/commerce/transactionalEmail.ts`, ADR 0177 / ecommerce gap plan §5B B4).
 *
 * Two halves:
 *
 *  1. The SEND seam: a pluggable transport. The `email` feature registers the
 *     brokered one at boot (the acting human's Connection + the org's sender address +
 *     the ONE sent-ledger, ADR 0193); tests inject a mock. Unwired, or a transport that
 *     declines, is the documented honest no-op (`{sent:false}`), never a throw: a
 *     confirmation must never block the flow that triggered it.
 *
 *  2. The TEMPLATE registry: each sender registers a `kind` with a string catalog in the
 *     four product locales and a `compose` function. Data reaches the output ONLY
 *     through the filler, which escapes per destination by construction — a subject
 *     value can never carry a line break (header injection), a text value carries no
 *     control characters, an HTML value is escaped — and an undeclared or missing
 *     `{{var}}` is a render error, never an empty string. A white-label build may
 *     REPLACE a registered kind (`overrideTransactionalTemplate`, ADR 0366 load hooks);
 *     there is no per-tenant editing (transactional copy is product copy, and
 *     tenant-edited security mail is a phishing vector).
 *
 * Core: imports nothing under `features/`.
 */
import { hostDefaultLocale } from './i18n/index.js';

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  /** Resolution context for a brokered transport (gap plan §5B B4): the tenant/org
   *  whose sender-address setting applies, the acting human whose email Connection
   *  the broker resolves, and a deterministic key for the ONE email sent-ledger
   *  (a webhook re-delivery must never re-send). Absent ⇒ a context-needing
   *  transport reports an honest no-op. */
  context?: { tenantId: string; orgId: string; actingUserId: string; idempotencyKey?: string };
}
export type EmailTransport = (email: TransactionalEmail) => Promise<boolean>;

let transport: EmailTransport | null = null;
/** Wire the transactional sender (a deployment sets the real one; unwired ⇒ honest no-op). */
export function setTransactionalEmailTransport(t: EmailTransport | null): void { transport = t; }

/** Send a transactional email. Returns `sent` (false when no recipient or no transport —
 *  an honest no-op, never a throw; a failure must never block the order flow). */
export async function sendTransactionalEmail(email: TransactionalEmail): Promise<{ sent: boolean; reason?: 'no_recipient' | 'no_transport' }> {
  if (!email.to || !email.to.includes('@')) return { sent: false, reason: 'no_recipient' };
  if (!transport) return { sent: false, reason: 'no_transport' };
  try { return { sent: await transport(email) }; } catch { return { sent: false, reason: 'no_transport' }; }
}

export function __resetTransactionalEmail(): void { transport = null; }

// ── the template registry ────────────────────────────────────────────────────

/** The four product locales every kind must ship. */
export const TRANSACTIONAL_LOCALES = ['en', 'es', 'fr', 'pt-BR'] as const;
export type TransactionalLocale = (typeof TRANSACTIONAL_LOCALES)[number];
export type TransactionalCatalog = Record<TransactionalLocale, Record<string, string>>;
export type TransactionalVars = Record<string, string | number>;

/** The ONLY way data reaches a rendered message: each method looks up a catalog
 *  string for the resolved locale and fills its `{{var}}`s for that destination. */
export interface TransactionalFiller {
  readonly locale: TransactionalLocale;
  subject(key: string, vars?: TransactionalVars): string;
  text(key: string, vars?: TransactionalVars): string;
  /** A localized money amount (major units), e.g. `$12.50`; falls back to `12.5 USD`. */
  money(amount: number, currency: string): string;
}

export interface TransactionalTemplate<D> {
  kind: string;
  catalog: TransactionalCatalog;
  compose(f: TransactionalFiller, data: D): { subject: string; text: string };
}

const registry = new Map<string, TransactionalTemplate<never>>();

function assertCatalog(kind: string, catalog: TransactionalCatalog): void {
  const keys = Object.keys(catalog.en ?? {}).sort();
  if (keys.length === 0) throw new Error(`transactional template '${kind}': the en catalog is empty`);
  for (const l of TRANSACTIONAL_LOCALES) {
    const got = Object.keys(catalog[l] ?? {}).sort();
    if (JSON.stringify(got) !== JSON.stringify(keys)) throw new Error(`transactional template '${kind}': locale '${l}' does not carry exactly the en keys`);
    for (const k of got) if (!catalog[l][k]?.trim()) throw new Error(`transactional template '${kind}': '${l}.${k}' is empty`);
  }
}

/** Register a kind (its owner, at boot). Re-registering the SAME definition is a no-op
 *  (a host booted twice in one process); a DIFFERENT definition for a taken kind throws —
 *  two owners must not silently shadow each other. Use the override for white-label. */
export function registerTransactionalTemplate<D>(def: TransactionalTemplate<D>): void {
  const prior = registry.get(def.kind);
  if (prior === (def as unknown as TransactionalTemplate<never>)) return;
  if (prior) throw new Error(`transactional template '${def.kind}' is already registered`);
  assertCatalog(def.kind, def.catalog);
  registry.set(def.kind, def as unknown as TransactionalTemplate<never>);
}

/** White-label build-time override: REPLACE an already-registered kind's copy. */
export function overrideTransactionalTemplate<D>(def: TransactionalTemplate<D>): void {
  if (!registry.has(def.kind)) throw new Error(`transactional template '${def.kind}' is not registered; nothing to override`);
  assertCatalog(def.kind, def.catalog);
  registry.set(def.kind, def as unknown as TransactionalTemplate<never>);
}

export function transactionalTemplateKinds(): string[] { return [...registry.keys()].sort(); }

/** Explicit locale (when one of the four) → the host default (when one of the four) → `en`. */
export function resolveTransactionalLocale(requested?: string): TransactionalLocale {
  const pick = (l: string | undefined): TransactionalLocale | undefined => (TRANSACTIONAL_LOCALES as readonly string[]).find((x) => x.toLowerCase() === (l ?? '').toLowerCase()) as TransactionalLocale | undefined;
  return pick(requested) ?? pick(hostDefaultLocale()) ?? 'en';
}

// eslint-disable-next-line no-control-regex
const C0_ALL = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const C0_EXCEPT_NL_TAB = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const clean = { subject: (v: string): string => v.replace(C0_ALL, ' '), text: (v: string): string => v.replace(/\r\n?/g, '\n').replace(C0_EXCEPT_NL_TAB, ' ') };

function fill(kind: string, template: string, vars: TransactionalVars, mode: 'subject' | 'text'): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`transactional template '${kind}': no value for {{${name}}}`);
    return clean[mode](String(vars[name]));
  });
}

/** Render a registered kind. Throws on an unknown kind or a missing variable (a
 *  programming error — the caller's data contract is wrong), never sends a blank. */
export function renderTransactional<D>(kind: string, data: D, opts: { locale?: string } = {}): { subject: string; text: string; locale: TransactionalLocale } {
  const def = registry.get(kind) as unknown as TransactionalTemplate<D> | undefined;
  if (!def) throw new Error(`transactional template '${kind}' is not registered`);
  const locale = resolveTransactionalLocale(opts.locale);
  const lookup = (key: string): string => {
    const s = def.catalog[locale][key];
    if (s === undefined) throw new Error(`transactional template '${kind}': no catalog key '${key}'`);
    return s;
  };
  const filler: TransactionalFiller = {
    locale,
    subject: (key, vars = {}) => fill(kind, lookup(key), vars, 'subject'),
    text: (key, vars = {}) => fill(kind, lookup(key), vars, 'text'),
    money: (amount, currency) => {
      try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount); }
      catch { return `${amount} ${clean.subject(currency)}`; }
    },
  };
  const out = def.compose(filler, data);
  // Belt and braces on the one header-bound field: a subject is ONE line, whatever compose did.
  const subject = out.subject.replace(C0_ALL, ' ').replace(/\s+/g, ' ').trim().slice(0, 250);
  return { subject, text: out.text, locale };
}

/** Render a kind and send it through the seam. Never throws for a send failure (the
 *  seam's honest no-op); a render error does throw — it is a code defect, not an outage. */
export async function sendTransactional<D>(
  kind: string,
  input: { to: string; data: D; locale?: string; context?: TransactionalEmail['context'] },
): Promise<{ sent: boolean; reason?: 'no_recipient' | 'no_transport' }> {
  const { subject, text } = renderTransactional(kind, input.data, input.locale !== undefined ? { locale: input.locale } : {});
  return sendTransactionalEmail({ to: input.to, subject, text, ...(input.context ? { context: input.context } : {}) });
}
