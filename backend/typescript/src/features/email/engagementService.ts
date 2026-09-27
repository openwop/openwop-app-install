/**
 * Email engagement tracking (ADR 0218 / campaign gap plan §5C C4) — clicks +
 * unsubscribes for campaign sends. Plain-text-honest v1:
 *
 *  - **Clicks**: at send time each URL in the rendered body is rewritten to
 *    `<base>/v1/host/openwop-app/public-email/c/<token>` (an opaque server-side
 *    token row — NO contact id or address ever rides a link). The public route
 *    records the click and 302s to the original URL.
 *  - **Unsubscribe**: every send gets an appended unsubscribe line in the BODY.
 *    Following it records the event, revokes marketing consent
 *    (`consentService.recordConsent` — the subject's choice), and adds a
 *    `crm:suppression` row (the operational overlay).
 *    **This host emits NO `List-Unsubscribe` / `List-Unsubscribe-Post` header**
 *    (review MEDIUM-4). This line used to say "`List-Unsubscribe` support
 *    upstream", which read as a claim that we do; `grep -rn 'List-Unsubscribe'`
 *    over backend src + test and frontend src returns exactly this comment and
 *    nothing else, and `EmailSendArgs` (`host/emailAdapter.ts`) carries no
 *    custom-header field for either provider body builder to render. So the only
 *    caller of `POST /public-email/u/:token` is a HUMAN BROWSER submitting the
 *    page's form — there is no RFC 8058 one-click machine retry loop. Emitting
 *    the headers is a real deliverability feature (it needs a header field on
 *    `EmailSendArgs` plus the SendGrid `headers` and Postmark `Headers` shapes);
 *    it is deliberately NOT smuggled in here.
 *  - **Preferences** (ADR 0227): every send also gets a preference-center line
 *    (`/public-email/p/<token>`) — the same opaque-token pattern, backing the
 *    per-channel (email/sms/push) consent page in `routes.ts`.
 *  - **Identity link** (ADR 0226): click destinations carry an opaque
 *    `owx=<token>` param appended at instrumentation time; the destination
 *    page's analytics beacon echoes it and the beacon writes the deterministic
 *    session↔contact link. No PII ever rides a URL.
 *  - Opens ARE tracked (`recordOpen` + the pixel route) and bounce/complaint
 *    ingestion ships in `bounceWebhooks.ts` with per-provider signature
 *    verification. (Corrected 2026-09-11 — EM-26: this header said both were
 *    deferred for weeks after they landed; a reviewer reading it concluded the
 *    feature had no public attack surface.)
 *
 * Engagement rows feed `CampaignStats` (clicks/uniqueClicks/unsubscribes) and
 * mirror into the analytics event log at record time is NOT done here — the C5
 * attribution join reads these rows directly (one store, no copy).
 */

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { createLogger } from '../../observability/logger.js';
import { mergeConsentCategories, fullMarketingOptOut } from '../consent/consentService.js';
import { addSuppression } from '../crm/suppressionService.js';
import { vendorPublicBase } from '../featureRoute.js';

const log = createLogger('email.engagement');

/** Opaque link-token row. `kind:'click'` carries the destination URL;
 *  `kind:'preferences'` backs the ADR 0227 public preference-center page. */
interface EngagementToken {
  /** `tok:<uuid>` — the path segment. */
  token: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  kind: 'click' | 'unsubscribe' | 'preferences' | 'open';
  /** ANLWF-1 / ADR 0651 D1 — the FIRST analytics session that linked through this
   *  click token. A token bound to nothing but tenant+contact, never expiring and
   *  never consumed, let ANY caller-chosen `sessionKey` link to the contact — a
   *  forwarded newsletter was enough. Set once by CAS; later sessions do not link. */
  claimedBySession?: string;
  url?: string;
  /** The contact's address at mint time (unsubscribe needs it for suppression;
   *  lower-cased; never rides a URL). */
  email?: string;
  /**
   * EM-UX-2 — on an `unsubscribe` row ONLY: the SIBLING `preferences` token
   * minted for the same (campaign, contact) in the same `instrumentBody` pass.
   *
   * The unsubscribe page offers a "choose which messages instead" escape hatch,
   * and it used to build that link from the token it was handed — an
   * `unsubscribe`-kind token — which `resolvePreferencesToken` hard-rejects, so
   * BOTH instances of the link 404'd by construction, always. The preferences
   * token has always existed; the page simply never had it. Carrying the pair
   * on the row is a point read, not a scan, which is what a public
   * unauthenticated route can afford.
   *
   * Absent on every row minted before this landed (and whenever the preferences
   * mint failed), so the page must OMIT the link rather than emit a dead one.
   */
  prefsToken?: string;
  createdAt: string;
}
/**
 * EM-5b (review MEDIUM-5) — `tenantOf` is set so this collection maintains the
 * GOV-1 tenant secondary index. The row id is the OPAQUE TOKEN (it has to be —
 * the token IS the unauthenticated public-page credential and its links are
 * already in recipients' inboxes), so there is no tenant prefix to scan and
 * `list()` is a FULL-COLLECTION scan. The collection grows per
 * (campaign × contact × 4 kinds) and unsubscribe/preferences rows are kept
 * forever, while `eraseSubject` invokes every eraser once per resolved identity
 * key — so the erasure path was K unbounded all-tenant scans per DSAR.
 * `listForTenantIndexed` replaces that with a bounded index read.
 *
 * Backfillable without a migration: `ensureTenantIndex()` backfills legacy rows
 * once on first indexed read, and every `put` after this lands maintains the
 * marker. Rows written before this change are therefore reached by the FIRST
 * indexed call, not left orphaned.
 */
const tokens = new DurableCollection<EngagementToken>('email:engagement-token', (t) => t.token, undefined, (t) => t.tenantId);

export interface EngagementEvent {
  id: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  kind: 'clicked' | 'unsubscribed' | 'opened';
  url?: string;
  at: string;
  /**
   * EM-2/EM-UX-1 — on an `unsubscribed` row ONLY: which send-stopping durable
   * writes did NOT persist. Absent/empty ⇒ the opt-out is ENFORCED. Non-empty ⇒
   * the recipient asked to leave and the next campaign will still reach them,
   * so the operator's Engagement panel must not read this as a clean unsubscribe.
   * Cleared in place when a retry (the recipient re-POSTing, or the RFC 8058
   * one-click retry a 5xx provokes) finally lands both writes.
   */
  unenforced?: UnsubscribeGate[];
}
const events = new DurableCollection<EngagementEvent>('email:engagement', (e) => `${e.tenantId}::${e.id}`);

// MKT-2 (ADR 0077/0081 retention seam) — PER-KIND retention for the two append-only
// engagement stores (behavioral PII → `confidential-pii`, riding the operator opt-in
// `retention.confidentialPiiDays`, consistent with the analytics:event purger). The
// per-kind SURVIVE-CONDITIONS are the whole point: some kinds carry a legal/functional hold
// and must NEVER be proactively aged (a data-subject ERASURE still removes them via the
// emailEraser — retention only forbids proactive ageing, not subject-requested erasure).
//
// EM-3 CORRECTION (2026-08-18): that parenthetical was FALSE for two years' worth
// of rows. `emailEraser` was `deleteSubjectSends` and nothing else, so it reached
// `email:sendlog` only — and this store, whose unsubscribe/preferences kinds are
// exempt from the purger right below, therefore kept the recipient's raw address
// FOREVER with no path to removal at all. It is true NOW, and only because
// `deleteSubjectEngagement` (bottom of this file) exists and the eraser fans out
// to it. Left as a correction rather than a silent edit: the sentence was the
// reason nobody looked.
//
// `email:engagement-token`: age `click`/`open` (dead click/open beacons after a campaign);
// KEEP `unsubscribe`/`preferences` forever — they back the live unsubscribe link + the
// ADR 0227 preference center (CAN-SPAM/GDPR opt-out), and `recordUnsubscribe(token)` reads
// the unsubscribe token, so ageing it would break the opt-out path itself.
// ANL-20 — the token row carries a contact id, an address AND (post-ADR 0651 D1) the
// claiming analytics session key; declare all three to the classification seam.
// Global-by-name masking stays off: `email`/`contactId` are already governed by
// their owners' declarations, and `claimedBySession` is only re-identifying here.
declarePiiFields('email.engagement-token', ['email', 'contactId', 'claimedBySession'], { maskGloballyByFieldName: false });

registerRetentionPurger({
  feature: 'email:engagement-token',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    // ADR 0655 D7 (EMWF-16) — tenant-INDEXED, never the cross-tenant `list()` the eraser was fixed away from (EM-5b).
    const ageable = (await tokens.listForTenantIndexed(tenantId)).filter((t) => t.kind === 'click' || t.kind === 'open');
    return purgeRowsByAge('email:engagement-token', ageable, tenantId, cutoffIso,
      (t) => ({ tenantId: t.tenantId, updatedAt: t.createdAt, id: t.token }),
      (id) => tokens.delete(id));
  },
});

// `email:engagement` events: age `opened`/`clicked` (pure behavioral analytics); KEEP
// `unsubscribed` forever — it is the dedup marker `recordUnsubscribe` reads (below) AND the
// consent/suppression record.
registerRetentionPurger({
  feature: 'email:engagement',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    const ageable = (await events.listByPrefix(`${tenantId}::`)).filter((e) => e.kind === 'opened' || e.kind === 'clicked');
    return purgeRowsByAge('email:engagement', ageable, tenantId, cutoffIso,
      (e) => ({ tenantId: e.tenantId, updatedAt: e.at, id: `${e.tenantId}::${e.id}` }),
      (id) => events.delete(id));
  },
});

/** D4 (ADR 0226): append the opaque click token as `owx=<token>` onto the
 *  DESTINATION URL (fragment-safe), so the landing page's analytics beacon can
 *  echo it back and the beacon path can write the session↔contact link. The
 *  token is opaque — no address or contact id ever rides a URL. */
function appendOwx(url: string, token: string): string {
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const frag = hashAt === -1 ? '' : url.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}owx=${encodeURIComponent(token)}${frag}`;
}

export async function mintToken(input: {
  tenantId: string; campaignId: string; contactId: string; kind: 'click' | 'unsubscribe' | 'preferences' | 'open'; url?: string; email?: string;
  /** EM-UX-2 — the sibling preferences token, on an `unsubscribe` mint only. */
  prefsToken?: string;
}): Promise<string> {
  const token = `tok:${randomUUID()}`;
  // Click destinations gain `owx=<token>` AT MINT (instrumentation) TIME — the
  // 302 then lands the recipient on `dest?owx=…` and the destination page's
  // beacon carries it (ADR 0226).
  const url = input.kind === 'click' && input.url ? appendOwx(input.url, token) : input.url;
  await tokens.put({
    token, tenantId: input.tenantId, campaignId: input.campaignId, contactId: input.contactId,
    kind: input.kind, ...(url ? { url } : {}), ...(input.email ? { email: input.email.toLowerCase() } : {}),
    ...(input.kind === 'unsubscribe' && input.prefsToken ? { prefsToken: input.prefsToken } : {}),
    createdAt: new Date().toISOString(),
  });
  return token;
}

/** D4 (ADR 0226): resolve an `owx` click token back to its owning tenant +
 *  contact — the analytics beacon's link-writer input. Opaque in, ids out.
 *  ADR 0651 D1 / ANL-24 — the UNCLAIMED resolver (`resolveClickToken`) is DELETED,
 *  not kept beside the claiming one: it had zero callers after D1 and was the
 *  exact shape the next caller would reach for to re-open the forwarded-token link. */
/** ANLWF-1 / ADR 0651 D1 — resolve a click token FOR A SPECIFIC analytics session,
 *  claiming it on first use. Returns the contact only when this session is the
 *  claimant (or becomes it); a foreign session gets `null` and writes no link. The
 *  first landing is the only binding the email lane can assert, so a token
 *  forwarded BEFORE its first landing is still wrong — once, not unboundedly. */
export async function claimClickTokenForSession(token: string, sessionKey: string): Promise<{ tenantId: string; contactId: string } | null> {
  if (typeof token !== 'string' || !token || token.length > 256 || !sessionKey) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await tokens.get(token).catch(() => null);
    if (!row || row.kind !== 'click') return null;
    if (row.claimedBySession === sessionKey) return { tenantId: row.tenantId, contactId: row.contactId };
    if (row.claimedBySession) return null; // claimed by another session
    if (await tokens.compareAndSwap(row, { ...row, claimedBySession: sessionKey })) {
      return { tenantId: row.tenantId, contactId: row.contactId };
    }
    // lost the race — re-read and re-evaluate
  }
  return null; // contention exhausted: refuse to link rather than guess
}


/** ADR 0227: resolve a preference-center token for the public page. */
export async function resolvePreferencesToken(token: string): Promise<
  { tenantId: string; campaignId: string; contactId: string; email?: string; createdAt: string } | null
> {
  if (typeof token !== 'string' || !token || token.length > 256) return null;
  const row = await tokens.get(token).catch(() => null);
  if (!row || row.kind !== 'preferences') return null;
  // ADR 0655 D3 — `createdAt` rides out so the public page can tell a FRESH link
  // (may widen consent) from a stale one (may only narrow it).
  return { tenantId: row.tenantId, campaignId: row.campaignId, contactId: row.contactId, createdAt: row.createdAt, ...(row.email ? { email: row.email } : {}) };
}

/** Test-only — back-date a token so the D3 freshness rule can be witnessed. Never routed. */
export async function __setTokenCreatedAtForTests(token: string, createdAt: string): Promise<void> {
  const row = await tokens.get(token);
  if (row) await tokens.put({ ...row, createdAt });
}

/** grade-code AUDIT-3: resolve an unsubscribe token for the GET confirm page
 *  (no mutation). Unknown/non-unsubscribe tokens resolve to null → the route 404s.
 *  EM-UX-2: also returns the SIBLING preferences token when the row carries one,
 *  so the page can link a preferences URL that actually resolves. */
export async function resolveUnsubscribeToken(token: string): Promise<
  { tenantId: string; campaignId: string; contactId: string; prefsToken?: string } | null
> {
  if (typeof token !== 'string' || !token || token.length > 256) return null;
  const row = await tokens.get(token).catch(() => null);
  if (!row || row.kind !== 'unsubscribe') return null;
  return {
    tenantId: row.tenantId, campaignId: row.campaignId, contactId: row.contactId,
    ...(row.prefsToken ? { prefsToken: row.prefsToken } : {}),
  };
}

/** EM-UX-2: the sibling preferences token for an unsubscribe token, or null.
 *  Used by the POST lane, which resolves the token inside `recordUnsubscribe`
 *  and still has to render a page carrying the escape hatch. */
export async function siblingPreferencesToken(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !token || token.length > 256) return null;
  const row = await tokens.get(token).catch(() => null);
  if (!row || row.kind !== 'unsubscribe' || !row.prefsToken) return null;
  return row.prefsToken;
}

const URL_RE = /https?:\/\/[^\s<>()"']+/g;

/** Rewrite every URL in a rendered plain-text body to a tracked redirect and
 *  append the unsubscribe line. Best-effort: a mint failure leaves the original
 *  URL in place (delivery beats tracking). */
export async function instrumentBody(
  body: string,
  base: string,
  mintArgs: { tenantId: string; campaignId: string; contactId: string; email: string },
): Promise<string> {
  // Longest-first (grade-code AUDIT-4): replacing a shorter URL before a longer
  // one that has it as a prefix would split the shorter out of the middle of
  // the longer and mangle it. Sort descending by length so each replacement is
  // whole-URL.
  const urls = [...new Set(body.match(URL_RE) ?? [])].sort((a, b) => b.length - a.length);
  let out = body;
  for (const url of urls) {
    // Already tracked in either spelling: bodies rendered before ADR 0656 carry the /v1 twin.
    if (url.startsWith(`${vendorPublicBase(base)}/public-email/`) || url.startsWith(`${base}/v1/host/openwop-app/public-email/`)) continue;
    try {
      const token = await mintToken({ ...mintArgs, kind: 'click', url });
      out = out.split(url).join(`${vendorPublicBase(base)}/public-email/c/${encodeURIComponent(token)}`);
    } catch (e) {
      log.warn('click token mint failed — leaving the original URL', { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // ADR 0227: the per-channel preference center rides its own token (separate
  // try — a preferences mint failure must never cost the unsubscribe line).
  //
  // EM-UX-2 — minted FIRST so the unsubscribe row can carry it. The unsubscribe
  // page's "choose which messages instead" link used to be built from the
  // unsubscribe token itself, which `/p/:token` rejects by kind, so it 404'd on
  // every recipient, always. Order is the whole fix: nothing else changes, and
  // a preferences failure still costs only the preferences line + the page's
  // optional link, never the opt-out.
  let prefs: string | undefined;
  try {
    prefs = await mintToken({ ...mintArgs, kind: 'preferences' });
  } catch (e) {
    log.warn('preferences token mint failed', { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    const unsub = await mintToken({ ...mintArgs, kind: 'unsubscribe', ...(prefs ? { prefsToken: prefs } : {}) });
    out += `\n\n--\nUnsubscribe: ${vendorPublicBase(base)}/public-email/u/${encodeURIComponent(unsub)}`;
  } catch (e) {
    // ADR 0655 D9 (EM-19) — a marketing email WITHOUT an unsubscribe line is
    // non-compliant, not a warning: the send is REFUSED (typed, retryable — the
    // campaign loop counts it in `passFailed`), never shipped and ledgered 'sent'.
    log.warn('unsubscribe token mint failed — send refused', { error: e instanceof Error ? e.message : String(e) });
    throw new OpenwopError('internal_error', 'unsubscribe_link_unavailable: the unsubscribe link could not be minted; the message was not sent', 503);
  }
  if (prefs) {
    out += `\nPreferences: ${vendorPublicBase(base)}/public-email/p/${encodeURIComponent(prefs)}`;
  }
  return out;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * ADR 0242: render the ALREADY-INSTRUMENTED plain-text body (tracked `/c` links +
 * the unsubscribe/preferences lines) as the HTML part, with the open pixel.
 * XSS gate: ESCAPE FIRST, then linkify — the body is operator-authored +
 * interpolated contact fields, so a malicious name/body must not inject markup;
 * only recognizable http(s) URLs (post-`instrumentBody`, all host-owned tracked
 * links) become anchors. Blank lines → paragraphs, single newlines → `<br>`.
 */
export function renderHtmlBody(instrumentedText: string, pixelUrl: string): string {
  const escaped = escapeHtml(instrumentedText);
  const linked = escaped.replace(/https?:\/\/[^\s<>()"']+/g, (u) => `<a href="${u}">${u}</a>`);
  const paras = linked
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const pixel = `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="border:0;width:1px;height:1px">`;
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1c;font-size:15px;line-height:1.5">
${paras}
${pixel}
</body>
</html>`;
}

/** Record a click; returns the destination URL (null ⇒ unknown token). */
export async function recordClick(token: string): Promise<string | null> {
  const row = await tokens.get(token).catch(() => undefined);
  if (!row || row.kind !== 'click' || !row.url) return null;
  await events.put({
    id: `eng:${randomUUID()}`, tenantId: row.tenantId, campaignId: row.campaignId,
    contactId: row.contactId, kind: 'clicked', url: row.url, at: new Date().toISOString(),
  }).catch((e) => log.warn('click record failed', { error: e instanceof Error ? e.message : String(e) }));
  return row.url;
}

/** ADR 0242: record an OPEN from the tracking pixel. Best-effort (the route
 *  serves the 1×1 GIF regardless); an unknown/non-open token is a silent no-op.
 *  Re-opens are REAL (no dedup on the raw event); uniqueOpens dedups in the
 *  stats projection. Returns whether an open was recorded. */
export async function recordOpen(token: string): Promise<boolean> {
  const row = await tokens.get(token).catch(() => undefined);
  if (!row || row.kind !== 'open') return false;
  await events.put({
    id: `eng:${randomUUID()}`, tenantId: row.tenantId, campaignId: row.campaignId,
    contactId: row.contactId, kind: 'opened', at: new Date().toISOString(),
  }).catch((e) => log.warn('open record failed', { error: e instanceof Error ? e.message : String(e) }));
  return true;
}

/**
 * EM-2/EM-UX-1 — the two durable writes that actually stop the next send.
 * `consent` is what `isAllowed(…, 'marketing.email')` reads at
 * `emailService.ts:531`; `suppression` is the overlay `suppressionBlocksSend`
 * reads at `:546`. Nothing else on this path changes whether the recipient is
 * mailed again, so these are the ONLY two the done page may claim.
 */
export type UnsubscribeGate = 'consent' | 'suppression';

export interface UnsubscribeOutcome {
  /**
   * `'unknown'` — the token did not resolve (the route 404s).
   * `'revoked'` — every send-stopping write landed; the done page may claim it.
   * `'partial'` — at least one did NOT. The recipient is still on the list, so
   *   the caller MUST render a failure with a retry rather than the done page.
   */
  status: 'unknown' | 'revoked' | 'partial';
  /** Which gates failed to persist. Empty on `'unknown'`/`'revoked'`. */
  unenforced: UnsubscribeGate[];
}

/** EM-6 (review LOW-1) — set equality over the gate names. Order-insensitive so a
 *  reordered retry is not mistaken for a change, and CONTENT-sensitive so
 *  `['consent'] → ['suppression']` (identical LENGTH, different failing gate) is. */
function sameGates(a: readonly UnsubscribeGate[] | undefined, b: readonly UnsubscribeGate[]): boolean {
  const x = new Set(a ?? []);
  if (x.size !== new Set(b).size) return false;
  return b.every((g) => x.has(g));
}

/**
 * Record an unsubscribe: marketing-consent revocation (the subject's choice) +
 * suppression (the operational overlay) + the engagement row. Idempotent — every
 * leg is a latest-wins upsert, so a retry after a partial failure completes it.
 *
 * EM-2 (grade-code) / EM-UX-1 (grade-ux): this used to swallow BOTH write
 * failures into `log.warn` and `return true` unconditionally, so the route
 * rendered "You are unsubscribed. No further marketing email will be sent to
 * this address." over a person who was still on the list — a CAN-SPAM/GDPR
 * exposure, not a cosmetic one. It is the symmetric twin of the CRM B5 fix,
 * which made the SEND side fail closed on an unreadable suppression list: the
 * send side refuses rather than sending, so the opt-out side must refuse to
 * CLAIM rather than claiming. Both halves now decline to assert an unverified
 * consent state.
 *
 * Ordering note: the two gate writes run FIRST and the engagement row is stamped
 * with their outcome, so the operator's Engagement panel can distinguish
 * "unsubscribe recorded" from "unsubscribe attempted but not enforced". The row
 * write is also no longer able to abort the opt-out — previously an `events.put`
 * throw escaped before either gate write was attempted.
 */
export async function recordUnsubscribe(token: string): Promise<UnsubscribeOutcome> {
  const row = await tokens.get(token).catch(() => undefined);
  if (!row || row.kind !== 'unsubscribe') return { status: 'unknown', unenforced: [] };
  const unenforced: UnsubscribeGate[] = [];

  try {
    // CONS-3 / review F4 — MERGE, never replace.
    //
    // This was the hand-preserve-`analytics` AUDIT-5 shape that CONS-3 removed
    // as a CLASS — and the census that closed CONS-3 ("all three wholesale
    // writers") missed this one and the preference centre, both PUBLIC and
    // unauthenticated. `recordConsent` builds the row from `input` alone, so
    // clicking one-click unsubscribe DESTROYED the subject's stored
    // `legalBasis`, `purposes` and `region` — the Art. 6 lawful-basis evidence
    // the controller has to be able to produce. `mergeConsentCategories`
    // carries all three forward; `analytics` no longer needs hand-preserving
    // because an unmentioned category keeps its stored value by construction.
    //
    // EVERY CHANNEL EXPLICITLY OFF, not just the umbrella. Under merge
    // semantics a stored `marketing.email: true` would survive a bare
    // `{ marketing: false }` and `isAllowed` prefers the specific over the
    // umbrella — an unsubscribe that does not unsubscribe. The wholesale write
    // masked that by dropping every specific. `fullMarketingOptOut()` is
    // derived from `MARKETING_CHANNELS` so a channel added later is covered
    // without anyone remembering this line.
    await mergeConsentCategories({
      tenantId: row.tenantId, subjectKey: row.contactId,
      categories: fullMarketingOptOut(),
      source: `email-unsubscribe:${row.campaignId}`,
    });
  } catch (e) {
    unenforced.push('consent');
    log.warn('unsubscribe consent revoke failed', { error: e instanceof Error ? e.message : String(e) });
  }
  // A token with no address predates/skipped the address stamp, so there is no
  // suppression row to write — that is inapplicable, NOT a failed write. Consent
  // is keyed by contactId and remains the gate the send loop reads.
  if (row.email) {
    try { await addSuppression(row.tenantId, row.email, 'unsubscribed', `contact:${row.contactId}`, `campaign:${row.campaignId}`); }
    catch (e) {
      unenforced.push('suppression');
      log.warn('unsubscribe suppression failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // The engagement row is the OPERATOR's record, never a gate — a failure to
  // write it must not downgrade a genuinely-enforced opt-out to 'partial', and
  // must not abort the gate writes above (it no longer can: they already ran).
  try {
    const prior = await listEngagement(row.tenantId, row.campaignId);
    const existing = prior.find((e) => e.kind === 'unsubscribed' && e.contactId === row.contactId);
    if (!existing) {
      await events.put({
        id: `eng:${randomUUID()}`, tenantId: row.tenantId, campaignId: row.campaignId,
        contactId: row.contactId, kind: 'unsubscribed', at: new Date().toISOString(),
        ...(unenforced.length ? { unenforced: [...unenforced] } : {}),
      });
    } else if (!sameGates(existing.unenforced, unenforced)) {
      // A retry that finally landed the writes CLEARS the warning (and a fresh
      // failure re-raises it) — the panel tracks the live state, not the first try.
      // EM-6 (review LOW-1): compared by CONTENTS, not length. A first attempt
      // failing `['consent']` and a retry failing `['suppression']` are both
      // length 1, so the length comparison left the row naming the WRONG gate —
      // an operator reading the panel would chase the enforced one.
      const { unenforced: _drop, ...rest } = existing;
      await events.put({ ...rest, ...(unenforced.length ? { unenforced: [...unenforced] } : {}) });
    }
  } catch (e) {
    log.warn('unsubscribe engagement row failed', { error: e instanceof Error ? e.message : String(e) });
  }

  return unenforced.length ? { status: 'partial', unenforced } : { status: 'revoked', unenforced: [] };
}

export async function listEngagement(tenantId: string, campaignId?: string): Promise<EngagementEvent[]> {
  const all = await events.listByPrefix(`${tenantId}::`);
  return all.filter((e) => !campaignId || e.campaignId === campaignId).sort((a, b) => b.at.localeCompare(a.at));
}

export interface EngagementStats {
  clicks: number; uniqueClicks: number; unsubscribes: number;
  /** EM-2/EM-UX-1: of `unsubscribes`, how many did NOT persist every
   *  send-stopping write — i.e. recipients who asked to leave and whom the next
   *  campaign will still reach. `0` is the only state an operator may read as
   *  "the opt-outs are honoured"; the panel surfaces a warning above it. */
  unsubscribesUnenforced: number;
  /** ADR 0242: opens are APPROXIMATE — image-load dependent. They UNDERCOUNT
   *  image-blocking clients and may OVERCOUNT proxy-prefetchers (Apple Mail
   *  Privacy). Never a precise readership count. */
  opens: number; uniqueOpens: number;
}

export async function engagementStats(tenantId: string, campaignId: string): Promise<EngagementStats> {
  const rows = await listEngagement(tenantId, campaignId);
  const clicks = rows.filter((r) => r.kind === 'clicked');
  const opens = rows.filter((r) => r.kind === 'opened');
  const unsubs = rows.filter((r) => r.kind === 'unsubscribed');
  return {
    clicks: clicks.length,
    uniqueClicks: new Set(clicks.map((r) => r.contactId)).size,
    unsubscribes: unsubs.length,
    unsubscribesUnenforced: unsubs.filter((r) => (r.unenforced?.length ?? 0) > 0).length,
    opens: opens.length,
    uniqueOpens: new Set(opens.map((r) => r.contactId)).size,
  };
}

/** Test-only. */
export async function __clearEngagement(): Promise<void> {
  await tokens.__clear();
  await events.__clear();
}

/**
 * EM-3 — GDPR data-subject erasure for the two engagement stores.
 *
 * `email:engagement-token` is the one that mattered most: it stores the
 * recipient's raw lower-cased address, and its `unsubscribe`/`preferences` kinds
 * are DELIBERATELY excluded from the retention purger (they back the live
 * opt-out link), so those rows are kept FOREVER. The docblock above the purger
 * asserted "a data-subject ERASURE still removes them via the emailEraser" —
 * which was false: that eraser's entire body was `deleteSubjectSends`, which
 * touches `email:sendlog` and nothing else. The claim is now true because this
 * function exists, not because a comment said so.
 *
 * Matched on EITHER identity space — the fan-out delivers a `contactId` or an
 * email-shaped key depending on which lane the DSAR arrived through, and a key
 * from the wrong space simply matches nothing (the contract's harmless no-op).
 *
 * DELETE, not anonymize. Unlike a CRM contact, an engagement row is not the
 * anchor for any business record: nothing references it by id, and the stats it
 * feeds are a projection that recomputes. There is no `crm:suppression`-shaped
 * argument for retention here — the suppression row itself, which is the
 * mechanism that HONOURS the refusal, lives in CRM and is deliberately kept
 * (redacted) by `crm/erasure.ts`. Erasing a token does not make anyone mailable
 * again; it only retires a link that can no longer be clicked.
 *
 * Idempotent (a second run finds no rows) — required, because the seam invokes
 * every eraser once per linked identity key.
 */
export async function deleteSubjectEngagement(tenantId: string, subjectKey: string): Promise<{ removed: number; failed: number }> {
  if (!tenantId || !subjectKey) return { removed: 0, failed: 0 };
  const needle = subjectKey.toLowerCase();
  let removed = 0;
  let failed = 0;
  // EM-5b — BOUNDED by the tenant secondary index (see the `tokens` declaration).
  // This was `tokens.list()`, an unbounded ALL-TENANT scan, run once per resolved
  // identity key on the DSAR path. A per-SUBJECT index would be tighter still, but
  // the token is the row id and the subject fields are not prefixable, so that
  // needs its own keyspace — recorded as `DATA-EM-1` in `docs/steward/DATA-ASSESSMENT.md`,
  // not left as an unowned comment.
  for (const row of await tokens.listForTenantIndexed(tenantId).catch(() => [])) {
    if (row.tenantId !== tenantId) continue;
    // ANL-20 (grade-code 2026-09-10) — `claimedBySession` is an ANALYTICS session key
    // (ADR 0651 D1), and the ADR 0381 resolver erases in exactly that key space;
    // without this leg a DSAR by session deleted nothing here and the receipt was
    // green. The row is DELETED (not just un-claimed): un-claiming would re-open the
    // token to the next holder, linking the erased subject's contact to a stranger.
    if (row.contactId !== subjectKey && (row.email ?? '') !== needle && row.claimedBySession !== subjectKey) continue;
    // ANL-2's lesson: the delete's OUTCOME is the finding, not the attempt — a
    // swallowed failure here would produce a green DSAR receipt over data that
    // is still there.
    try { await tokens.delete(row.token); removed += 1; }
    catch (e) { failed += 1; log.error('engagement_token_erase_failed', { tenantId, error: e instanceof Error ? e.message : String(e) }); }
  }
  for (const row of await events.listByPrefix(`${tenantId}::`).catch(() => [])) {
    if (row.contactId !== subjectKey) continue;
    try { await events.delete(`${row.tenantId}::${row.id}`); removed += 1; }
    catch (e) { failed += 1; log.error('engagement_event_erase_failed', { tenantId, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { removed, failed };
}
