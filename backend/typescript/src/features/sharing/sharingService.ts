/**
 * Sharing (ADR 0013). Mints unguessable capability links to a SPECIFIC resource
 * and resolves them on a public, unauthenticated surface. It does NOT copy
 * resource data — a link stores a `(resourceType, resourceId)` reference and a
 * RESOLVER for that type loads a read-only projection at resolve time (so an
 * edited/revoked/deleted resource is reflected live). Resource types are
 * pluggable via a static resolver registry, not special-cased per route.
 *
 * @see docs/adr/0013-sharing.md
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { hashToken, isTokenHash, mintToken } from '../../host/capabilityToken.js';
import { OpenwopError } from '../../types.js';
import { PREAUTHORIZED_CALLER, type SubjectCaller } from '../../host/subjectAccess.js'; // KBC-1 — `PREAUTHORIZED_CALLER` only on the PUBLIC read lane of an already-minted link (see `kb_collection`)
import { cleanOpaqueToken, optionalCleanString } from '../../host/boundedStrings.js';
import { getOrg } from '../../host/accessControlService.js';
import { getCanvasForTenant } from '../../host/canvasSurface.js';
import { getBrief as getCreativeBrief } from '../creative-briefs/creativeBriefsService.js';
import { briefToSharedMarkdown as creativeBriefToSharedMarkdown } from '../creative-briefs/routes.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getPage, resolveSharedRefs, type Section } from '../cms/cmsService.js';
import { getQuote, projectQuotePublic, SHAREABLE_QUOTE_STATUSES } from '../commerce/quotes.js';
import { getOrder } from '../commerce/commerceService.js';
import { bookingShareValidate, bookingShareLoad } from '../crm/bookingService.js';
import { signShareValidate, signShareLoad } from '../crm/signService.js';
import { getCollection, listDocuments } from '../kb/kbService.js';
import { publicDocumentView } from '../documents/documentsService.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { transcriptToMarkdown } from '../chat-export/transcriptRenderer.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { getEntryUnfiltered, resolvePromptRef, readableBy as promptReadableBy } from '../prompts/promptLibraryService.js';
import { projectAppForShare } from '../app-builder/shareProjection.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { onCanvasDeleted } from '../../host/canvasLifecycle.js';
import { onConversationDeleted } from '../../host/conversationLifecycle.js';
import { vendorPublicBase } from '../featureRoute.js';

const MAX = {
  label: 160,
  expiresInDays: 3650,
  /** Documents listed in a shared KB-collection overview (public, bounded). */
  collectionDocs: 200,
  descr: 320,
  /** PUB-7 — upper bound on a per-link view cap. */
  maxViews: 1_000_000,
} as const;

export type ResourceType = 'cms_page' | 'kb_collection' | 'document' | 'conversation' | 'prompt' | 'commerce_quote' | 'commerce_order' | 'app_builder_canvas' | 'slides_canvas' | 'creative_brief' | 'booking_manage' | 'sign_request';
export const RESOURCE_TYPES: readonly ResourceType[] = ['cms_page', 'kb_collection', 'document', 'conversation', 'prompt', 'commerce_quote', 'commerce_order', 'app_builder_canvas', 'slides_canvas', 'creative_brief', 'booking_manage', 'sign_request'];

export interface ShareLink {
  /** sha256 of the raw token — the ONLY at-rest identifier (ADR 0448 P2).
   *  The raw token is returned once at mint and never stored. */
  tokenHash: string;
  tenantId: string;
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  label?: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  /** PUB-7 — optional per-link view cap; once `viewCount` reaches it the content 404s
   *  (the card/preview path is exempt). Absent ⇒ uncapped. */
  maxViews?: number;
  /** PUB-7 — content views served (the audit signal); incremented on `resolveShared`. */
  viewCount?: number;
  /** R3-SH1 — WHEN the link was last viewed, stamped in the same CAS write the
   *  count rides (no extra write, no extra race). The market's "who/when last
   *  viewed" (Dropbox viewer-info) — the WHO is impossible for anonymous public
   *  viewers by design and deliberately not approximated. */
  lastViewedAt?: string;
  revoked: boolean;
  /** Grade fix #5 — when the link was revoked (the retention sweep's 30-day
   *  grace anchors HERE, not createdAt, so a long-lived link's audit trail
   *  isn't purged the moment it's revoked). Absent on pre-fix rows. */
  revokedAt?: string;
  /** WF-SHARE-1 — the single DERIVED instant this link became dead: `revokedAt`
   *  when revoked, else `expiresAt` when the owner set one. It exists because
   *  the sanctioned retention lane (`registerKvAgeOut`) ages out on ONE
   *  timestamp field, and a row with two possible death dates has none it can
   *  read. Absent ⇒ the link is live, or predates this field (backfilled at
   *  boot by `backfillLinkDeadAt`). A row with no `deadAt` is SKIPPED by the
   *  sweep, never deleted on a guess. */
  deadAt?: string;
}

interface Card { title: string; description: string; imageToken?: string }

interface ShareResolver {
  /**
   * SHARE-1 — the OWNING feature's toggle id, consulted against the **link's**
   * tenant (never the caller's — that was the org-invitations defect) on every
   * public read and at mint. ONE gate, driven from this table, rather than a
   * per-resolver `resolveOne` call: repeating the check per method is how
   * `creative_brief.card` ended up serving an OG card for content its own
   * `load` had already darkened (SHARE-3).
   *
   * `null` is a DECISION recorded in place, never silence. `resolveOne` returns
   * `null` for a feature that declares no toggle default — so a fail-closed
   * gate keyed on an always-on feature would darken every link of that type
   * forever, which is strictly worse than the gap it closes. Each `null` below
   * carries the reason it is null.
   *
   * DRIFT GUARD: `test/sharing-owning-feature-gate.test.ts` asserts every non-null
   * id is a REGISTERED toggle default. If an owning feature later graduates to
   * always-on, CI goes red — instead of the public lane silently going dark.
   */
  toggleId: string | null;
  /** Mint-time: assert the resource exists in (tenant, org); throw 404 otherwise.
   *  `caller` (ADR 0643 R3 Blocker 2) is the MINTING principal — a resolver whose
   *  resource can be subject-bound (a KB collection) MUST resolve it, so a non-member
   *  cannot publish a private corpus through a public link. */
  validate(tenantId: string, orgId: string, resourceId: string, caller?: SubjectCaller): Promise<void>;
  /** Public read-only projection (or null if the resource is gone). `opts.snapshotAt`
   *  (ADR 0122 Phase 3) is the link's mint time — a resolver that snapshots
   *  time-ordered content (a conversation) MUST NOT expose anything created after it. */
  load(tenantId: string, orgId: string, resourceId: string, opts?: { snapshotAt?: string }): Promise<Record<string, unknown> | null>;
  /** Social-card metadata (or null if gone). */
  card(tenantId: string, orgId: string, resourceId: string, opts?: { snapshotAt?: string }): Promise<Card | null>;
}

const RESOLVERS: Record<ResourceType, ShareResolver> = {
  // ADR 0353 P4 — a creative brief an external designer executes from.
  // APPROVED-ONLY (the documents precedent): a draft/review brief never mints,
  // and demotion purges links (routes). The projection is the SHARED markdown
  // (CB-CODE-6): mood-board items render as resolvable asset NAMES only — raw
  // `masset:` ids, serve tokens, and the internal needsAsset note never reach
  // the public page, and ids that no longer resolve (deleted assets) drop.
  creative_brief: {
    toggleId: 'creative-briefs',
    async validate(tenantId, orgId, resourceId) {
      const b = await getCreativeBrief(tenantId, orgId, resourceId);
      if (!b) throw notFound(resourceId);
      if (b.status !== 'approved') {
        throw new OpenwopError('validation_error', 'Only an APPROVED creative brief can be shared.', 409, { status: b.status });
      }
    },
    async load(tenantId, orgId, resourceId) {
      const b = await getCreativeBrief(tenantId, orgId, resourceId);
      if (!b || b.status !== 'approved') return null; // demoted after mint ⇒ dark
      return { kind: 'creative_brief', title: b.title, markdown: await creativeBriefToSharedMarkdown(b) };
    },
    async card(tenantId, orgId, resourceId) {
      const b = await getCreativeBrief(tenantId, orgId, resourceId);
      if (!b || b.status !== 'approved') return null;
      return { title: b.title, description: `Creative brief — ${b.assetType}. ${b.directions.length} direction(s).` };
    },
  },
  // ADR 0305 Phase D — a shared app design (the `canvas.app-builder` working copy),
  // rendered interactively by the public viewer. LIVING document: `load` serves the
  // CURRENT state (the cms_page precedent), NOT a mint-time snapshot — only
  // time-ordered content (conversations) snapshots. Canvases are TENANT-scoped
  // (no org column, ADR 0153 §R6): tenant isolation is enforced by
  // `getCanvasForTenant`; the link's org is the minting org. Mint stays
  // workspace:write — parity with the editor's own PATCH authz.
  app_builder_canvas: {
    // Grade pass 2026-07-07 (F16): a tenant that turns the app-builder feature
    // OFF stops serving designs on existing links (the sharing toggle alone
    // guarded this surface before). SHARE-1 moved the check to the one gate.
    toggleId: 'app-builder',
    async validate(tenantId, _orgId, resourceId) {
      const c = await getCanvasForTenant(tenantId, resourceId);
      if (!c || c.canvasTypeId !== 'canvas.app-builder') throw notFound(resourceId);
    },
    async load(tenantId, _orgId, resourceId) {
      const c = await getCanvasForTenant(tenantId, resourceId);
      if (!c || c.canvasTypeId !== 'canvas.app-builder') return null;
      const state = (c.state ?? {}) as Record<string, unknown>;
      const title = typeof state.name === 'string' && state.name ? state.name : (c.name ?? 'App design');
      // ADR 0345 3a (DS-08): the public wire carries a SANITIZED projection —
      // sample rows redacted by default (sharePolicy opts in), app-contract
      // facets stripped. Never the raw working state.
      return { kind: 'app_builder_canvas', title, app: projectAppForShare(state) };
    },
    async card(tenantId, _orgId, resourceId) {
      const c = await getCanvasForTenant(tenantId, resourceId);
      if (!c || c.canvasTypeId !== 'canvas.app-builder') return null;
      const state = (c.state ?? {}) as Record<string, unknown>;
      const title = typeof state.name === 'string' && state.name ? state.name : (c.name ?? 'App design');
      const description = typeof state.description === 'string' && state.description
        ? state.description
        : `Interactive app design — ${Array.isArray(state.screens) ? state.screens.length : 0} screen(s).`;
      return { title, description };
    },
  },
  // D1 (ecommerce gap plan) — the customer-identity FLOOR: an order-status link
  // the confirmation email carries. PII-free projection rendered as markdown by
  // the generic shared viewer (no accounts, no addresses, no payment ids).
  commerce_order: {
    // SHARE-1 — was UNGATED: a tenant that disabled `commerce` kept serving
    // order status (items, totals) to anyone holding the link.
    toggleId: 'commerce',
    async validate(tenantId, orgId, resourceId) {
      if (!(await getOrder(tenantId, orgId, resourceId))) throw notFound(resourceId);
    },
    async load(tenantId, orgId, resourceId) {
      const o = await getOrder(tenantId, orgId, resourceId);
      if (!o) return null;
      const rows = o.items.map((i) => `| ${i.name} | ${i.quantity} | ${i.unitPrice.toFixed(2)} ${o.currency} |`).join('\n');
      const markdown = [
        `**Status:** ${o.status}${o.status === 'paid' || o.status === 'fulfilled' ? ` · **Fulfillment:** ${o.fulfillmentStatus}` : ''}`,
        '',
        '| Item | Qty | Price |',
        '|---|---|---|',
        rows,
        '',
        `**Total:** ${o.total.toFixed(2)} ${o.currency}`,
      ].join('\n');
      return { kind: 'commerce_order', title: `Order ${o.orderId}`, markdown, status: o.status };
    },
    async card(tenantId, orgId, resourceId) {
      const o = await getOrder(tenantId, orgId, resourceId);
      if (!o) return null;
      return { title: `Order ${o.orderId}`, description: `${o.status} · ${o.total.toFixed(2)} ${o.currency}` };
    },
  },
  // C3 (ecommerce gap plan) — a SENT quote as a shareable offer: the buyer opens
  // a read-only, PII-free projection; acceptance happens on the commerce public
  // route with this link's live token as the capability proof.
  commerce_quote: {
    // SHARE-1 — was UNGATED: a priced offer with a public Accept button kept
    // resolving after the tenant disabled `commerce`.
    toggleId: 'commerce',
    async validate(tenantId, orgId, resourceId) {
      const q = await getQuote(tenantId, orgId, resourceId);
      if (!q) throw notFound(resourceId);
      if (q.status !== 'sent') {
        throw new OpenwopError('validation_error', 'Only a sent quote can be shared.', 409, { status: q.status });
      }
    },
    // SHWF-3 / ADR 0644 D3 — `validate` above demands `sent` at MINT; these two
    // re-check at READ, the asymmetry SHARE-3 already closed for `creative_brief`
    // and `document`. Without it a quote revised back to `draft`, declined, or
    // expired kept resolving on the minted link at its stale price.
    async load(tenantId, orgId, resourceId) {
      const q = await getQuote(tenantId, orgId, resourceId);
      if (!q || !SHAREABLE_QUOTE_STATUSES.includes(q.status)) return null;
      return { kind: 'commerce_quote', orgId, ...projectQuotePublic(q) };
    },
    async card(tenantId, orgId, resourceId) {
      const q = await getQuote(tenantId, orgId, resourceId);
      if (!q || !SHAREABLE_QUOTE_STATUSES.includes(q.status)) return null;
      return { title: `Quote — ${q.total} ${q.currency}`, description: `${q.lines.length} item${q.lines.length === 1 ? '' : 's'}${q.expiresAt ? ` · valid until ${q.expiresAt.slice(0, 10)}` : ''}` };
    },
  },

  cms_page: {
    // SHARE-1 — `null` BY MEASUREMENT, not by omission: `cms` declares no
    // `toggleDefault` (ALWAYS-ON since ADR 0027), so there is no owning toggle
    // to consult and `resolveOne('cms', …)` returns null for every tenant. A
    // fail-closed gate here would dark-fail every CMS preview link that has
    // ever been minted. The honest consequence — no kill-switch exists for this
    // type — is now stated in `feature.ts`, `FEATURES.md` and ADR 0013 rather
    // than papered over by a claim that a gate is applied.
    toggleId: null,
    async validate(tenantId, orgId, resourceId) {
      if (!(await getPage(tenantId, orgId, resourceId))) throw notFound(resourceId);
    },
    async load(tenantId, orgId, resourceId) {
      const raw = await getPage(tenantId, orgId, resourceId);
      if (!raw) return null;
      // ADR 0204 C4 — a shared/preview view renders CONTENT, so shared-section
      // refs resolve here just as they do on the published delivery path.
      const p = await resolveSharedRefs(raw);
      // R2 SR-1 — the shared viewer renders MARKDOWN (the commerce_order
      // precedent); without this prerender the picker's DEFAULT type rendered
      // "Nothing to show here". Sections stay on the wire for future rich
      // rendering; `markdown` is what the generic viewer shows today.
      return { kind: 'cms_page', title: p.title, slug: p.slug, status: p.status, sections: p.sections, updatedAt: p.updatedAt, markdown: cmsSectionsToMarkdown(p.sections) };
    },
    async card(tenantId, orgId, resourceId) {
      const p = await getPage(tenantId, orgId, resourceId);
      if (!p) return null;
      const c: Card = { title: p.title, description: describeSections(p.sections, p.title) };
      const hero = heroImageToken(p.sections);
      if (hero) c.imageToken = hero;
      return c;
    },
  },
  kb_collection: {
    // SHARE-1 — null: `kb` graduated off its toggle (ADR 0010/0024). Same
    // reasoning as `cms_page` above.
    toggleId: null,
    async validate(tenantId, orgId, resourceId, caller) {
      // ADR 0643 R3 (Blocker 2) — the MINT gate resolves the minter against the
      // collection's subject (an omitted caller is `{ subject: undefined }`: fail-closed
      // on a bound collection). `load`/`card` below stay PREAUTHORIZED: they serve the
      // PUBLIC lane of a link this gate already admitted, to viewers who are anonymous
      // by design.
      if (!(await getCollection(tenantId, orgId, resourceId, caller ?? { subject: undefined }))) throw notFound(resourceId); // KBC-1
    },
    async load(tenantId, orgId, resourceId) {
      const col = await getCollection(tenantId, orgId, resourceId, PREAUTHORIZED_CALLER); // KBC-1 — public lane after mint
      if (!col) return null;
      // `.catch(() => [])`: listDocuments re-validates the collection, so a delete
      // racing between getCollection and here would throw — degrade to an empty
      // doc list rather than surfacing an inconsistent error.
      const docs = (await listDocuments(tenantId, orgId, resourceId, PREAUTHORIZED_CALLER).catch(() => [])).slice(0, MAX.collectionDocs); // KBC-1
      // R2 SR-1 — prerender the collection as markdown for the generic viewer
      // (description + document list); the structured fields stay on the wire.
      const lines = [
        ...(col.description ? [col.description, ''] : []),
        `**${col.documentCount} document(s)**`,
        '',
        ...docs.map((d) => `- ${d.title}`),
        ...(col.documentCount > docs.length ? ['', `…and ${col.documentCount - docs.length} more.`] : []),
      ];
      return {
        kind: 'kb_collection',
        name: col.name,
        description: col.description,
        documentCount: col.documentCount,
        chunkCount: col.chunkCount,
        documents: docs.map((d) => ({ documentId: d.documentId, title: d.title })),
        markdown: lines.join('\n'),
      };
    },
    async card(tenantId, orgId, resourceId) {
      const col = await getCollection(tenantId, orgId, resourceId, PREAUTHORIZED_CALLER); // KBC-1
      if (!col) return null;
      return { title: col.name, description: (col.description ?? `${col.documentCount} document(s)`).slice(0, MAX.descr) };
    },
  },
  // ADR 0053 — a business document. Confidentiality: a link may only be minted
  // for an APPROVED/FINAL document, and the public projection re-checks status
  // (a later revert to draft makes the link go dark). Draft SOW/RFP never leaks.
  document: {
    // SHARE-1 — was UNGATED: an approved SOW/RFP kept resolving on the public
    // internet after the tenant disabled `documents`.
    toggleId: 'documents',
    async validate(tenantId, orgId, resourceId) {
      if (!(await publicDocumentView(tenantId, orgId, resourceId))) throw notFound(resourceId);
    },
    async load(tenantId, orgId, resourceId) {
      return publicDocumentView(tenantId, orgId, resourceId);
    },
    async card(tenantId, orgId, resourceId) {
      // Gate the social card on the SAME approved/final-only rule as `load` — else
      // the public OG card would keep leaking a document's title after it reverts
      // to draft (the link's content already goes dark via `load`).
      const view = await publicDocumentView(tenantId, orgId, resourceId);
      if (!view) return null;
      return { title: String(view.title), description: `${String(view.documentKind)} · ${String(view.status)}`.slice(0, MAX.descr) };
    },
  },
  // ADR 0122 — a read-only public conversation snapshot. The projection is the
  // ADR 0119 transcript render (no parallel renderer); read-only (no composer).
  // Phase 1: validate = exists-in-tenant; the owner-only-mint gate is Phase 2.
  conversation: {
    // SHARE-1 — null: conversations are the CORE chat primitive (RFC 0005), a
    // host-owned store with no feature toggle of its own. Same reasoning as
    // `cms_page`; the owner-only mint gate (`createLink`) is what bounds this
    // type, not a toggle.
    toggleId: null,
    async validate(tenantId, _orgId, resourceId) {
      if (!(await hostExtStorage().getChatSession(tenantId, resourceId))) throw notFound(resourceId);
    },
    async load(tenantId, _orgId, resourceId, opts) {
      const session = await hostExtStorage().getChatSession(tenantId, resourceId);
      if (!session) return null;
      // ADR 0122 Phase 3 — snapshot-up-to-marker: expose ONLY messages that existed
      // when the link was minted; turns added to the conversation afterwards stay
      // private (the public link can't leak the live thread forward).
      const messages = snapshotMessages(await hostExtStorage().listChatSessionMessages(resourceId), opts?.snapshotAt);
      return {
        kind: 'conversation',
        title: session.title,
        messageCount: messages.length,
        // Read-only rendered transcript (markdown). Untrusted content stays inert
        // (rendered as text/fenced blocks by the renderer; the public view is
        // composer-less).
        markdown: transcriptToMarkdown(session, [...messages]),
      };
    },
    async card(tenantId, _orgId, resourceId, opts) {
      const session = await hostExtStorage().getChatSession(tenantId, resourceId);
      if (!session) return null;
      const messages = snapshotMessages(await hostExtStorage().listChatSessionMessages(resourceId), opts?.snapshotAt);
      const first = messages[0]?.content ?? '';
      return { title: session.title || 'Conversation', description: first.slice(0, MAX.descr) };
    },
  },
  // ADR 0116 Phase 2b — a read-only public PROMPT (a library entry + its resolved
  // template body). Org-scoped; the template text is the org's own (trusted).
  prompt: {
    // SHARE-1 — null: `prompts` graduated off its toggle (ADR 0134). Same
    // reasoning as `cms_page`.
    toggleId: null,
    // SHWF-1 / ADR 0644 D1 — `validate` is the ENTITLEMENT hook: it answers "may
    // THIS actor grant public access?", so it must apply the resource's own
    // visibility predicate. `load`/`card` below deliberately keep the unfiltered
    // read — they answer "what does an already-granted link show?", they have no
    // caller to compare against, and filtering them would break an owner sharing
    // their OWN private prompt. `promptLibraryService`'s "a minted public link IS
    // the grant" rationale is sound for the read hooks and CIRCULAR here, where
    // whether the minter was entitled to mint is the open question.
    async validate(tenantId, orgId, resourceId, caller) {
      const entry = await getEntryUnfiltered(tenantId, orgId, resourceId);
      if (!entry) throw notFound(resourceId);
      if (!promptReadableBy(entry, caller?.subject)) {
        throw new OpenwopError('forbidden', 'Only the owner may share a private prompt.', 403, { resourceId });
      }
    },
    async load(tenantId, orgId, resourceId) {
      const entry = await getEntryUnfiltered(tenantId, orgId, resourceId);
      if (!entry) return null;
      const resolved = resolvePromptRef(entry.promptRef); // honor the @version pin (PLC-2)
      const body = resolved && resolved !== 'ambiguous' ? resolved.template.text : '';
      return { kind: 'prompt', name: entry.name, description: entry.description ?? '', body };
    },
    async card(tenantId, orgId, resourceId) {
      const entry = await getEntryUnfiltered(tenantId, orgId, resourceId);
      if (!entry) return null;
      return { title: entry.name, description: (entry.description ?? 'Shared prompt').slice(0, MAX.descr) };
    },
  },
  // ADR 0328 Phase 7 — a shared slide DECK (the `canvas.slides` working copy),
  // rendered by the public one-frame pager (SlideFrame — speaker notes are
  // structurally absent from the audience path, the S7 posture). Same LIVING-
  // document + tenant-isolation + toggle-fail-closed contract as app designs.
  slides_canvas: {
    toggleId: 'slides',
    async validate(tenantId, _orgId, resourceId) {
      const c = await getCanvasForTenant(tenantId, resourceId);
      if (!c || c.canvasTypeId !== 'canvas.slides') throw notFound(resourceId);
    },
    async load(tenantId, _orgId, resourceId) {
      const c = await getCanvasForTenant(tenantId, resourceId);
      if (!c || c.canvasTypeId !== 'canvas.slides') return null;
      const state = (c.state ?? {}) as Record<string, unknown>;
      const title = typeof state.title === 'string' && state.title ? state.title : (c.name ?? 'Slide deck');
      // R2 SL-SP-1 — the AUDIENCE projection, on the WIRE. `deck: state`
      // verbatim served every slide's speaker `notes` and the FULL content of
      // `skip:true` slides to any anonymous link holder: the S7 posture
      // ("notes are STRUCTURALLY absent from the audience path") was true only
      // of the DOM. Notes are stripped from every slide; a skipped slide is
      // reduced to a positional `{skip:true}` stub — never removed, because
      // the per-frame analytics contract is pinned to RAW deck indices.
      const slides = Array.isArray(state.slides)
        ? (state.slides as Record<string, unknown>[]).map((s) => {
          // Review F2 — a primitive entry must not launder into an
          // indexed-char object on the public wire (rest-spread of a string).
          if (!s || typeof s !== 'object') return {};
          if (s.skip === true) return { skip: true };
          const { notes: _notes, ...audience } = s as Record<string, unknown>;
          return audience;
        })
        : state.slides;
      return { kind: 'slides_canvas', title, deck: { ...state, ...(slides !== undefined ? { slides } : {}) } };
    },
    async card(tenantId, _orgId, resourceId) {
      const c = await getCanvasForTenant(tenantId, resourceId);
      if (!c || c.canvasTypeId !== 'canvas.slides') return null;
      const state = (c.state ?? {}) as Record<string, unknown>;
      const title = typeof state.title === 'string' && state.title ? state.title : (c.name ?? 'Slide deck');
      const n = Array.isArray(state.slides) ? state.slides.length : 0;
      return { title, description: `${n} slide${n === 1 ? '' : 's'}` };
    },
  },
  // ADR 0402 — the reschedule/cancel capability token a booking confirmation
  // carries. A CAPABILITY link (an action, not shareable content): `load` serves
  // the manage projection behind the token; `card` is null (never a social
  // preview — it's a private management link). crm toggle-gated (fail-closed).
  booking_manage: {
    toggleId: 'crm',
    async validate(tenantId, orgId, resourceId) {
      await bookingShareValidate(tenantId, orgId, resourceId);
    },
    async load(tenantId, orgId, resourceId) {
      return bookingShareLoad(tenantId, orgId, resourceId);
    },
    async card() {
      return null; // private management link — no social card
    },
  },
  // ADR 0402 §b — the per-signer e-signature capability token. A CAPABILITY link
  // (an action, not shareable content): `load` serves the signing projection +
  // the legal notice behind the token; `card` is null. crm toggle-gated.
  sign_request: {
    toggleId: 'crm',
    async validate(tenantId, orgId, resourceId) {
      await signShareValidate(tenantId, orgId, resourceId);
    },
    async load(tenantId, orgId, resourceId) {
      return signShareLoad(tenantId, orgId, resourceId);
    },
    async card() {
      return null; // private signing link — no social card
    },
  },
};

// Grade pass 2026-07-07 (DATA finding 9): validate guard — this row backs the
// PUBLIC unauthenticated surface; a corrupt/drifted row must fail closed (null →
// uniform 404), never blind-cast into the resolver.
const links = new DurableCollection<ShareLink>(
  'sharing:link',
  (l) => l.tokenHash,
  (parsed) => {
    const l = parsed as ShareLink | null;
    return l && typeof l.tokenHash === 'string' && typeof l.tenantId === 'string'
      && typeof l.orgId === 'string' && typeof l.resourceType === 'string'
      && typeof l.resourceId === 'string' && typeof l.revoked === 'boolean'
      ? l : null;
  },
  (l) => l.tenantId,
  undefined,
  // WF-SHARE-1 — the frame-view cascade, on the collection's own delete rather
  // than inline in one sweep. The kvAgeOut tick and `purgeLinksForResource` both
  // reclaim through `delete()`, so both cascade identically; the previous
  // arrangement reclaimed them only from the bespoke sweep, so moving that sweep
  // would have made the analytics rows the new orphans.
  //
  // CORRECTED (R2 review, F2) — this used to list "tenant teardown" as a third
  // path that fires the cascade, and it does not. Teardown resolves this
  // namespace's registry entry, which is `legacyLinksView` (last construction
  // wins), and `purgeTenantRows` sends validator-REJECTED rows down its raw
  // `kvDelete` branch — which never calls `delete()` and so never fires this
  // hook. Every new-shape link row is validator-rejected by that view, so
  // teardown reclaims them ALL on the raw branch. The frame-view rows are
  // nevertheless removed, because `sharing:frameview` is its own registered
  // collection and teardown walks the full registry — i.e. the outcome is
  // correct, but by a different mechanism than this comment claimed. Stated so
  // nobody "simplifies" the frameview registration away on the strength of a
  // cascade that never runs there.
  (tokenHash) => purgeFrameViewsForToken(tokenHash),
);
/** ADR 0328 P7 — per-FRAME view analytics for shared decks (and any framed
 *  canvas type later): one row per (link token, frame index), CAS-incremented
 *  from the public viewer. Read back only through the owner-gated management
 *  surface; nothing here is exposed on the public token. */
interface FrameView { tokenHash: string; tenantId: string; frame: number; count: number }
const frameViews = new DurableCollection<FrameView>(
  'sharing:frameview',
  (v) => `${v.tokenHash}:${v.frame}`,
  (parsed) => {
    const v = parsed as FrameView | null;
    return v && typeof v.tokenHash === 'string' && typeof v.tenantId === 'string'
      && Number.isInteger(v.frame) && Number.isInteger(v.count)
      ? v : null;
  },
  (v) => v.tenantId,
);

const log = createLogger('features.sharing');
const nowIsoSharing = (): string => new Date().toISOString();

/**
 * SHARE-1 — the ONE owning-feature gate for this whole feature.
 *
 * ADR 0434 graduated `sharing` off its own toggle, which removed the kill-switch
 * that had covered all twelve resource types; only five resolvers replaced it,
 * while `feature.ts`, `FEATURES.md` and `auth.ts` all kept asserting that every
 * resolver applied one. Seven types (`cms_page`, `kb_collection`, `document`,
 * `conversation`, `prompt`, `commerce_quote`, `commerce_order`) served on the
 * public internet with no toggle check at all, and their backing services do not
 * gate either.
 *
 * MEASURED before fixing, because the honest count is not seven: of those seven,
 * only `document` (`documents`) and the two commerce types (`commerce`) have an
 * owning feature that DECLARES a toggle. `cms`, `kb`, `prompts` and the core
 * conversation store are always-on and declare none, so there is no toggle to
 * consult for four of them — see each resolver's `toggleId: null` reason. The
 * fix is therefore "gate every type that HAS an owning toggle, and say plainly
 * that four types have none", not a claim that all twelve are gated.
 *
 * Subject: the **link's** tenant (`link.tenantId`), never the caller's — the
 * caller on this lane is anonymous, and gating a public resource route on the
 * CALLER's tenant toggle is the org-invitations defect.
 */
/** The resolver→toggle table, for the structural tests that keep it honest
 *  (never routed). Exposed rather than re-parsed from source so the drift guard
 *  reads the SAME values the gate reads. */
export function __resolverToggleIds(): Record<ResourceType, string | null> {
  return Object.fromEntries(
    (Object.keys(RESOLVERS) as ResourceType[]).map((t) => [t, RESOLVERS[t].toggleId]),
  ) as Record<ResourceType, string | null>;
}

async function owningFeatureEnabled(resourceType: ResourceType, tenantId: string): Promise<boolean> {
  const toggleId = RESOLVERS[resourceType].toggleId;
  if (toggleId === null) return true; // no owning toggle exists — recorded at the resolver
  const toggled = await resolveOne(toggleId, { tenantId });
  return Boolean(toggled?.enabled);
}

// ADR 0448 P2 — tokens are HASHED AT REST (the raw token appears exactly once,
// in the mint response). TWO lookup postures (grade fix #1 — the stored hash
// must NEVER be replayable as a credential):
//  - PUBLIC paths hash UNCONDITIONALLY: presenting a leaked tokenHash to
//    /shared/:token double-hashes and misses (the kicktodo posture);
//  - AUTHED management ops (revoke, frame analytics — RBAC-gated) accept
//    raw-or-hash, because the list surface only holds the hash.
const keyOf = (t: string): string => (isTokenHash(t) ? t : hashToken(t));

/** PUB-7 — count one CONTENT view (the audit signal) and enforce the per-link cap.
 *  Atomic compare-and-swap; over the cap → uniform 404 (no increment past the cap). The
 *  card/preview path does NOT call this (an unfurl must not burn a view).
 *
 *  SHARE-4 — on CAS exhaustion the behaviour now SPLITS by whether a cap exists.
 *  It used to fall out of the loop and serve the view uncounted for every link,
 *  which meant "burn after N views" stopped being enforced under exactly the
 *  condition an attacker controls: concurrency. A cap that fails open is not a
 *  cap. So a CAPPED link refuses (503, retryable) and an UNCAPPED link keeps the
 *  best-effort count, where the number really is only analytics. */
async function countShareViewOrThrow(token: string): Promise<void> {
  let capped = false;
  let resourceType = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await links.get(hashToken(token)); // public path — unconditional hash (grade fix #1)
    if (!cur || cur.revoked) throw new OpenwopError('not_found', 'Shared link not found.', 404, {});
    capped = typeof cur.maxViews === 'number';
    resourceType = cur.resourceType;
    const next = (cur.viewCount ?? 0) + 1;
    if (cur.maxViews && next > cur.maxViews) {
      log.info('shared_link_view_cap_reached', { resourceType: cur.resourceType, tenantId: cur.tenantId, orgId: cur.orgId, tokenPrefix: cur.tokenHash.slice(0, 12), maxViews: cur.maxViews });
      throw new OpenwopError('not_found', 'Shared link not found.', 404, {});
    }
    if (await links.compareAndSwap(cur, { ...cur, viewCount: next, lastViewedAt: nowIsoSharing() })) {
      log.info('shared_link_viewed', { resourceType: cur.resourceType, tenantId: cur.tenantId, orgId: cur.orgId, tokenPrefix: cur.tokenHash.slice(0, 12), viewCount: next });
      return;
    }
  }
  if (capped) {
    log.warn('shared_link_view_cap_unenforceable', { resourceType });
    throw new OpenwopError('internal_error', 'Couldn’t record this view right now. Try again in a moment.', 503, { reason: 'view-count-contention', retryAfterSeconds: 1 });
  }
  log.debug('shared_link_view_count_cas_exhausted', { resourceType });
}

/** Grade pass 2026-07-10 (DATA blocker) — the frame-view cascade: rows are
 *  keyed by link token, so every path that DELETES a link must reclaim them
 *  (revoke keeps the link row — the owner's analytics stay readable until the
 *  retention sweep purges the dead link, which cascades here too). */
async function purgeFrameViewsForToken(tokenHash: string): Promise<void> {
  for (const v of await frameViews.listByPrefix(`${tokenHash}:`)) {
    await frameViews.delete(`${v.tokenHash}:${v.frame}`);
  }
}

/** Test affordance — the orphan probe for the cascade tests (never routed). */
export async function _frameViewCountForToken(token: string): Promise<number> {
  return (await frameViews.listByPrefix(`${keyOf(token)}:`)).length;
}

/** ADR 0328 P7 — record one frame view from the PUBLIC viewer. Same
 *  fail-closed posture as resolve (revoked/expired/unknown → uniform 404);
 *  best-effort on CAS contention (analytics never block a reader). */
export async function recordSharedFrameView(token: string, frame: unknown): Promise<void> {
  // Frame indexes are bounded by the largest deck any canvas type allows
  // (slides MAX_SLIDES=100) — a public token must not mint rows past it.
  if (!Number.isInteger(frame) || (frame as number) < 0 || (frame as number) > 99) {
    throw new OpenwopError('validation_error', '`frame` must be an integer frame index.', 400, { field: 'frame' });
  }
  const link = await resolveActiveLink(token);
  const tokenHash = hashToken(token); // public path — unconditional (grade fix #1)
  const key = `${tokenHash}:${frame}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await frameViews.get(key);
    if (!cur) {
      // First view: a plain put — two CONCURRENT first views can collapse to
      // count 1 (no add-if-absent primitive on the collection). Accepted
      // analytics tolerance; every subsequent increment is CAS-exact.
      await frameViews.put({ tokenHash, tenantId: link.tenantId, frame: frame as number, count: 1 });
      return;
    }
    if (await frameViews.compareAndSwap(cur, { ...cur, count: cur.count + 1 })) return;
  }
  log.debug('frame_view_cas_exhausted', { frame });
}

/** Owner-gated per-frame analytics for one link (management surface). */
export async function listFrameViews(tenantId: string, orgId: string, token: string): Promise<{ frame: number; count: number }[]> {
  const tokenHash = keyOf(token);
  const link = await links.get(tokenHash);
  if (!link || link.tenantId !== tenantId || link.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Shared link not found.', 404, {});
  }
  const rows = await frameViews.listByPrefix(`${tokenHash}:`);
  return rows
    .map((v) => ({ frame: v.frame, count: v.count }))
    .sort((a, b) => a.frame - b.frame);
}

// ─── authed management (authorizeOrgScope-gated in routes) ───────────────────

export async function createLink(
  tenantId: string,
  orgId: string,
  actor: string,
  input: { resourceType?: unknown; resourceId?: unknown; label?: unknown; expiresInDays?: unknown; maxViews?: unknown },
): Promise<ShareLink & { token: string }> {
  const resourceType = input.resourceType;
  if (typeof resourceType !== 'string' || !(RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
    throw new OpenwopError('validation_error', `\`resourceType\` MUST be one of: ${RESOURCE_TYPES.join(', ')}.`, 400, { field: 'resourceType' });
  }
  // A resourceId is an OPAQUE REFERENCE, not free text: the free-text secret
  // scrub would mangle any >=40-char id (it silently redacted `canvas-<uuid>`
  // ids to '[REDACTED:secret-shaped]' — the same failure mode ADR 0206 found
  // with CMS media tokens). Charset-validated + capped instead.
  const resourceId = cleanOpaqueToken(input.resourceId, 256) || undefined;
  if (!resourceId) throw new OpenwopError('validation_error', '`resourceId` is required.', 400, { field: 'resourceId' });

  // Validate cheap input (label, expiry) BEFORE the resource lookup, so a bad
  // expiresInDays 400s rather than masking behind the resolver's 404.
  const now = new Date();
  const expiry = expiryFields(input.expiresInDays, now);
  const label = optionalCleanString(input.label, MAX.label);
  // PUB-7 — optional per-link view cap (positive integer, bounded).
  let maxViews: number | undefined;
  if (input.maxViews !== undefined && input.maxViews !== null) {
    const n = typeof input.maxViews === 'number' ? input.maxViews : NaN;
    if (!Number.isInteger(n) || n <= 0 || n > MAX.maxViews) {
      throw new OpenwopError('validation_error', `\`maxViews\` MUST be an integer 1–${MAX.maxViews}.`, 400, { field: 'maxViews' });
    }
    maxViews = n;
  }

  // SHARE-1 — the same owning-feature gate at MINT (this replaces the two
  // per-resolver `validate` checks booking/sign used to carry). A tenant with
  // the owning feature OFF cannot mint a public link to it; uniform 404, same
  // shape as a missing resource.
  if (!(await owningFeatureEnabled(resourceType as ResourceType, tenantId))) throw notFound(resourceId);

  // The resource MUST exist in THIS (tenant, org) — cross-org/tenant id 404s — AND be
  // readable by the MINTER (ADR 0643 R3 Blocker 2; only subject-bindable resolvers use it).
  await RESOLVERS[resourceType as ResourceType].validate(tenantId, orgId, resourceId, { subject: actor });

  // ADR 0122 Phase 2 — a conversation is OWNER-scoped (not org-scoped): only the
  // conversation owner may mint a public link, not any tenant member with
  // workspace:write. An unowned (legacy) conversation stays mintable (consistent
  // with the ADR 0043 visibility model).
  // Grade pass 2026-07-07 (DATA finding 6): a USER-owned canvas (ADR 0153 §R6
  // ownerSubject anchor) is mintable only by its owner — the same posture as
  // conversations. Tenant/org-scoped canvases (no user owner) stay
  // workspace:write-mintable (parity with the editor's own PATCH authz).
  if (resourceType === 'app_builder_canvas' || resourceType === 'slides_canvas') {
    const c = await getCanvasForTenant(tenantId, resourceId);
    if (c?.ownerSubject?.kind === 'user' && c.ownerSubject.id !== actor) {
      throw new OpenwopError('forbidden', 'Only the owner of this canvas may share it.', 403, { resourceId });
    }
  }

  if (resourceType === 'conversation') {
    const meta = await getConversationMeta(tenantId, resourceId);
    if (meta?.ownerUserId && meta.ownerUserId !== actor) {
      throw new OpenwopError('forbidden', 'Only the conversation owner may share it.', 403, { resourceId });
    }
  }

  // ADR 0448 P2 — the raw token exists exactly HERE and in the return value.
  const minted = mintToken('shr');
  const link: ShareLink = {
    tokenHash: minted.hash,
    tenantId,
    orgId,
    resourceType: resourceType as ResourceType,
    resourceId,
    ...(label !== undefined ? { label } : {}),
    createdBy: actor,
    createdAt: now.toISOString(),
    ...expiry,
    ...(maxViews !== undefined ? { maxViews } : {}),
    viewCount: 0,
    revoked: false,
    // WF-SHARE-1 — a link with an expiry is born knowing when it dies, so the
    // age-out lane can read it without a second pass.
    ...(expiry.expiresAt ? { deadAt: expiry.expiresAt } : {}),
  };
  await links.put(link);
  // WF-SHARE-1 — no `void sweepDeadLinks()` here any more: retention rides the
  // daemon tick, not an unrelated write on the request path.
  return { ...link, token: minted.raw }; // shown once — never at rest, never re-readable
}

// ── retention (WF-SHARE-1/2 — moved onto the sanctioned lane) ─────────────────
// PREVIOUSLY: a bespoke `sweepDeadLinks()` fire-and-forgotten from `createLink`
// and throttled by a module-global `lastLinkSweepAt`. Three structural problems,
// all of which the lane below removes: a host that stopped MINTING never purged
// (retention was coupled to unrelated product traffic); the throttle was
// per-process and in-memory, so an N-instance fleet swept N times and a restart
// reset it; and `lastLinkSweepAt = 0` meant the first mint in every process
// full-scanned the entire cross-tenant collection on the request path. It was
// also unexported and gated on process state, so no test could drive it — zero
// test references repo-wide (the ADR 0371 "test the DAEMON WIRING" lesson).
//
// NOW: `registerKvAgeOut` (default-ON, swept from the ADR 0371 retention daemon
// tick BEFORE the opt-in gate) ages out on the derived `deadAt` stamp. Semantics
// are preserved exactly — 30 days from death, where death is `revokedAt` for a
// revoked link and `expiresAt` for a lapsed one — and the frame-view cascade the
// old sweep performed inline now rides the collection's own delete hook, so it
// happens no matter WHICH path reclaims the row (the tick, tenant teardown, or a
// resource cascade). `acceptIndexed` is deliberate: this collection carries a
// `tenantOf` index and the sweep deletes THROUGH the collection.
//
// CORRECTED (R2 review, F2) — "so markers cannot strand" was FALSE as written,
// and the mechanism it named was not the one that runs. `hostExtCollectionForPrefix`
// resolves `hostext:sharing:link:` out of a registry deduped by namespace with
// LAST CONSTRUCTION WINS, and `legacyLinksView` (the ADR 0448 P2 migration view,
// further down this file) is constructed AFTER `links`. So the sweep deleted
// through the LEGACY handle, whose validator returns null for a new-shape row —
// and the marker cleanup was conditional on that read succeeding. Every aged-out
// link stranded a `hostextidx:sharing:link:<tenant>:<hash>` marker. Bounded (the
// next `listForTenantIndexed` self-heals it), but real. Fixed at the layer that
// owns it: `DurableCollection.deleteRow` now resolves the row's tenant with the
// FU-DATA-1 raw-JSON fallback instead of gating on its own validator, so ANY
// namespace with two handles cleans up correctly. `sharing-erasure-retention`
// drives the sweep through the REAL registry entry and asserts the marker is gone.
const LINK_PURGE_GRACE_DAYS = 30;
registerKvAgeOut({
  id: 'sharing:link',
  prefix: 'hostext:sharing:link:',
  ttlDays: LINK_PURGE_GRACE_DAYS,
  timestampField: 'deadAt',
  acceptIndexed: true,
});

/** WF-SHARE-1 — the death instant a dead link is aged out from, or undefined
 *  while it is live. ONE derivation, shared by revoke, mint and the backfill. */
function deadAtFor(l: Pick<ShareLink, 'revoked' | 'revokedAt' | 'createdAt' | 'expiresAt'>): string | undefined {
  // Grade fix #5: anchor a revoked link on revokedAt — createdAt purged an old
  // link the moment it was revoked (the opposite of the grace intent).
  if (l.revoked) return l.revokedAt ?? l.createdAt;
  return l.expiresAt;
}

/** Boot backfill for rows written before `deadAt` existed. Bounded and
 *  idempotent BY SHAPE (it writes only rows that both are dead and lack the
 *  stamp), so a clean store is a no-op — the same posture as the ADR 0448 P2
 *  re-key pass it runs beside. Without it, every pre-existing revoked/expired
 *  row would be SKIPPED by the age-out lane forever: a silent retention
 *  regression that would have looked exactly like success. */
export async function backfillLinkDeadAt(): Promise<number> {
  let stamped = 0;
  for (const l of await links.list()) {
    if (l.deadAt) continue;
    const deadAt = deadAtFor(l);
    if (!deadAt) continue; // live link — nothing to stamp
    await links.put({ ...l, deadAt });
    stamped += 1;
  }
  if (stamped > 0) log.info('sharing_deadat_backfilled', { stamped });
  return stamped;
}

/** Purge every link pointing at one resource (grade pass DATA-3) — the cascade
 *  hook a feature calls when it DELETES a shared resource, so dark links don't
 *  linger. Feature-layer callers only (the host must not import features).
 *
 *  SHARE-5, CORRECTED IN R2: this briefly read `listForTenantIndexed`, and that
 *  was the wrong index for this job. `hostExtPersistence` states the doctrine at
 *  `purgeTenantRows`: the tenant index tolerates a missing marker ("delayed, not
 *  lost" — fine for a retention scan), but a purge that MISSES leaves a live
 *  public URL to a deleted resource forever, which is precisely the permanent
 *  orphan WF-SHARE-3/4 exist to remove. So this is back to the complete scan +
 *  exact filter, the same completeness-over-speed trade teardown takes, and for
 *  the same reason. It runs on resource DELETE (rare), not on a hot path. */
export async function purgeLinksForResource(tenantId: string, resourceType: ResourceType, resourceId: string): Promise<number> {
  if (!tenantId) return 0; // fail-closed — never a global purge
  let purged = 0;
  for (const l of await links.list()) {
    if (l.tenantId === tenantId && l.resourceType === resourceType && l.resourceId === resourceId) {
      // The frame-view cascade rides `links`' own delete hook now (one choke).
      await links.delete(l.tokenHash);
      purged += 1;
    }
  }
  return purged;
}

/** DATA-AB-1 — the retention survive-condition predicate (ADR 0382). Sharing OWNS the
 *  "is this link live" semantics (revoked / expired), so a feature deciding whether to
 *  age-purge a shareable resource asks HERE rather than re-implementing the check: returns
 *  true iff a NON-revoked, NON-expired link references this resource. A resource with a live
 *  public link is "in use externally" and must not be retention-purged. Tenant-scoped scan
 *  (demo-scale; same posture as `purgeLinksForResource`). Read-only. */
export async function hasActiveLinkForResource(tenantId: string, resourceType: ResourceType, resourceId: string): Promise<boolean> {
  if (!tenantId) return false;
  const now = Date.now();
  const isLive = (l: ShareLink): boolean => {
    if (l.tenantId !== tenantId || l.resourceType !== resourceType || l.resourceId !== resourceId) return false;
    if (l.revoked) return false;
    if (l.expiresAt) {
      const exp = Date.parse(l.expiresAt);
      if (Number.isNaN(exp) || exp <= now) return false; // expired / unparseable → not active (matches resolveActiveLink)
    }
    return true;
  };
  // SHARE-5, CORRECTED IN R2 — the FAIL DIRECTION, which the first pass got
  // backwards. This is a retention SURVIVE-condition: `canvasRetention.ts` purges
  // a canvas when it answers false, so a false negative DELETES a resource that
  // still has a live public link. The tenant index is documented as "delayed, not
  // lost", i.e. it may legitimately miss a row — which makes it the wrong sole
  // authority for a destructive decision.
  //
  // But a HIT on the index is authoritative (the row was read and validated), so
  // the shape that is both correct and fast is: indexed slice first, complete
  // scan only when it finds nothing. A shared resource costs the bounded slice;
  // an unshared one costs the full scan the pre-SHARE-5 code paid unconditionally.
  // Never worse than the baseline, strictly better on the hit.
  for (const l of await links.listForTenantIndexed(tenantId)) if (isLive(l)) return true;
  for (const l of await links.list()) if (isLive(l)) return true;
  return false;
}

export async function listLinks(tenantId: string, orgId: string): Promise<Array<ShareLink & { cardTitle?: string; resourceMissing?: boolean; featureDisabled?: boolean }>> {
  // SHARE-5 — the tenant's own slice via the secondary index this collection
  // already maintains (`tenantOf`), not a full cross-tenant `list()` scan.
  // This is the ONE read left on the index (R2 SHARE-5 correction): a miss here
  // is a row absent from a management LIST — the "delayed, not lost" case the
  // index contract is written for. The three sites whose miss DESTROYS or
  // OUTLIVES something (`purgeLinksForResource`, `hasActiveLinkForResource`,
  // `eraseSubjectSharing`) do not ride it; see each.
  const rows = (await links.listForTenantIndexed(tenantId))
    .filter((l) => l.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // Annotate with the resource's current card title (best-effort — a deleted
  // resource just has no title). N+1 by design: this is an AUTHED, low-volume
  // management list (unlike the public sitemap/feed path, which must not fan out).
  const out: Array<ShareLink & { cardTitle?: string; resourceMissing?: boolean; featureDisabled?: boolean }> = [];
  for (const l of rows) {
    // SHARE-1 parity: the management list must not show a card title for a type
    // whose owning feature is OFF (that was the per-resolver behaviour the one
    // gate replaced). Same subject — the link's tenant.
    const gated = await owningFeatureEnabled(l.resourceType, l.tenantId);
    // A THROW is not an absence. The old `.catch(() => null)` collapsed "the
    // card lookup failed" into "the resource is gone", which is exactly the
    // false claim this annotation now feeds — so the two are kept apart and a
    // failed lookup asserts nothing.
    let card: Card | null = null;
    let cardFailed = false;
    if (gated) {
      try { card = await RESOLVERS[l.resourceType].card(l.tenantId, l.orgId, l.resourceId); }
      catch { cardFailed = true; }
    }
    // SHARE-UX-1 — an ORPHANED link (row alive, resource deleted) used to be
    // indistinguishable from a titled one: the owner's list simply fell back to
    // the raw resourceId while the recipient was told the owner had revoked it.
    // The `card` miss is the ONE signal the wire carries about this; spend it on
    // a real status instead of a title fallback. Only asserted when the type is
    // gated-in AND the card path can answer at all (`booking_manage` /
    // `sign_request` return null BY DESIGN — private links have no social card),
    // so those two are never falsely marked missing.
    const cardCapable = l.resourceType !== 'booking_manage' && l.resourceType !== 'sign_request';
    // SHARE-1 HONESTY (R2) — `gated` used to be computed here and then DISCARDED:
    // it suppressed the card lookup and the `resourceMissing` flag, and nothing
    // about the gate reached the wire. So the moment SHARE-1 made `document`,
    // `commerce_*` and `creative_brief` darkenable, this list started rendering a
    // green "Live" chip (with the raw resourceId for a title) for links whose
    // resolver now returns a uniform 404 — reintroducing, on the owner's side,
    // exactly the lie the rest of this change closes. The boolean is the server's
    // to know and the client's to say, so it goes on the wire.
    out.push({
      ...l,
      ...(card ? { cardTitle: card.title } : {}),
      ...(gated && cardCapable && !cardFailed && !card ? { resourceMissing: true } : {}),
      ...(gated ? {} : { featureDisabled: true }),
    });
  }
  return out;
}

export async function revokeLink(tenantId: string, orgId: string, token: string): Promise<void> {
  const link = await links.get(keyOf(token));
  if (!link || link.tenantId !== tenantId || link.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Share link not found.', 404, {});
  }
  const revokedAt = nowIsoSharing();
  await links.put({ ...link, revoked: true, revokedAt, deadAt: revokedAt });
}

// ─── public resolve (unauthed — tenant from the link) ───────────────────────

/** Load a share link by token, enforcing every public gate (charset, existence,
 *  revocation, expiry, org↔tenant). Throws a uniform 404 on ANY failure so the
 *  surface leaks nothing about which condition failed.
 *
 *  § ADR 0434 — the `sharing` toggle graduated to always-on, so the former
 *  toggle gate (and its `enforceSharingToggle: false` carve-out for ADR 0402
 *  capability tokens) is gone. The token remains the credential: unguessable
 *  charset, revocation, expiry, and the org↔tenant binding are the real gates,
 *  and each resolver still applies its OWN feature's toggle before returning
 *  content. The carve-out existed precisely because gating capability tokens on
 *  a content-sharing toggle was wrong — removing the toggle removes the need
 *  for the exception rather than widening it. */
async function resolveActiveLink(token: string, opts: { enforceViewCap?: boolean } = {}): Promise<ShareLink> {
  // SHCD-3 — the WIRE stays a uniform, reason-less 404 (that is the whole
  // non-oracle posture, and it is deliberate). But the justification for
  // collapsing nine distinct refusals on the wire is that the SERVER still knows
  // which one fired — and it did not: eight of the nine logged nothing at all, so
  // "the link my client had stopped working" was undiagnosable. The reason goes
  // to the LOG, never to the envelope. `tokenPrefix` is a prefix of the stored
  // HASH, never of the raw bearer token.
  const gone = (reason: string, l?: ShareLink): never => {
    log.info('shared_link_refused', {
      reason,
      ...(l ? { resourceType: l.resourceType, tenantId: l.tenantId, orgId: l.orgId, tokenPrefix: l.tokenHash.slice(0, 12) } : {}),
    });
    throw new OpenwopError('not_found', 'Shared link not found.', 404, {});
  };
  if (typeof token !== 'string' || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) gone('malformed-token');
  // PUBLIC path: hash UNCONDITIONALLY (grade fix #1 — a leaked at-rest hash
  // presented here double-hashes and misses; only authed management may look
  // up by hash). Grade fix #3: on miss, lazily migrate a legacy raw-keyed row
  // so pre-migration links never 404 while the boot pass is mid-flight.
  let link = await links.get(hashToken(token));
  if (!link) link = await migrateLegacyLinkOnRead(token);
  if (!link) gone('unknown-token');
  if (link!.revoked) gone('revoked', link!);
  if (link!.expiresAt) {
    const exp = Date.parse(link!.expiresAt);
    if (Number.isNaN(exp)) gone('unparseable-expiry', link!); // fail-closed
    // R2 SR-10 — an EXPIRED link gets honest visitor copy (410, the Dropbox
    // convention). Revoked and never-existed stay a UNIFORM 404: revocation is
    // the owner deliberately killing the link, and distinguishing it from
    // "never existed" would make the resolve a token-validity oracle. Expiry
    // is a benign time lapse; admitting a dead token once existed there is the
    // whole point of the message ("ask the owner for a fresh link").
    if (exp <= Date.now()) throw new OpenwopError('not_found', 'This shared link has expired.', 410, { reason: 'expired' });
  }
  const org = await getOrg(link!.orgId);
  if (!org || org.tenantId !== link!.tenantId) gone('org-tenant-mismatch', link!);
  // SHARE-1 — the owning-feature gate, on the LINK's tenant, for EVERY public
  // entry point (resolve, card, frame-view, and the two capability-proof
  // helpers). Placed here rather than in each resolver so a new resource type
  // cannot be added ungated and so `load` and `card` can never disagree.
  if (!(await owningFeatureEnabled(link!.resourceType, link!.tenantId))) gone('owning-feature-off', link!);
  // SHCD-1 / ADR 0644 D8 — the view cap, on the SAME chokepoint and for the same
  // reason SHARE-1 put the toggle here: so a new public lane cannot be added
  // uncapped, and so no two lanes can disagree about whether a link is spent.
  // D2 fixed only `resolveSharedCard` — an instance, not the class — which left
  // three lanes bypassing the cap and made the unauthenticated frame-view writer
  // a TOKEN-VALIDITY ORACLE: 204 for a spent-but-real token, 404 for a fabricated
  // one, the exact distinction the uniform-404 posture exists to deny.
  //
  // Default ON; the two CAPABILITY-PROOF lanes opt out explicitly, and that
  // exemption is load-bearing rather than lazy. A `maxViews:1` quote link spends
  // its only view the moment the buyer OPENS the quote, so capping
  // `assertLiveLinkFor` would refuse the Accept they were invited to make. A cap
  // limits how many times an offer may be READ, not whether its recipient may act
  // on it. Pinned in `commerce-phase-c.test.ts`.
  //
  // This is the non-authoritative read; `countShareViewOrThrow`'s CAS remains the
  // authority that consumes a slot and settles concurrent views.
  if (opts.enforceViewCap !== false && typeof link!.maxViews === 'number' && (link!.viewCount ?? 0) >= link!.maxViews) {
    log.info('shared_link_view_cap_reached', { resourceType: link!.resourceType, tenantId: link!.tenantId, orgId: link!.orgId, tokenPrefix: link!.tokenHash.slice(0, 12) });
    gone('view-cap-reached', link!);
  }
  return link!;
}

/** C3 (commerce) — capability proof for an ACTION on a shared resource: the LIVE
 *  link (charset/revocation/expiry/org-tenant/toggle gates all enforced) must
 *  reference exactly this resource. Does NOT consume a view-cap slot (viewing is
 *  the render path's concern). Uniform 404 on any mismatch. */
export async function assertLiveLinkFor(token: string, resourceType: ResourceType, resourceId: string, orgId: string): Promise<void> {
  // SHCD-1 / D8 — capability proof, NOT a read: exempt from the view cap. See the
  // reasoning at `resolveActiveLink`; capping this refuses the buyer's own Accept.
  const link = await resolveActiveLink(token, { enforceViewCap: false });
  if (link.resourceType !== resourceType || link.resourceId !== resourceId || link.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Shared link not found.', 404, {});
  }
}

/** ADR 0402 — resolve a live capability token to its (tenant, org, resourceId)
 *  after asserting its kind. For ACTION tokens (booking_manage, …) whose holder
 *  proves capability by possession, the resourceId is NOT in the URL — the token
 *  carries it. Uniform 404 on any gate/kind mismatch (same posture as
 *  `assertLiveLinkFor`). Does not consume a view-cap slot. */
export async function resolveActiveResource(token: string, resourceType: ResourceType): Promise<{ tenantId: string; orgId: string; resourceId: string }> {
  // SHCD-1 / D8 — capability proof (booking-manage, e-sign), NOT a read: exempt
  // from the view cap for the same reason as `assertLiveLinkFor` above.
  const link = await resolveActiveLink(token, { enforceViewCap: false });
  if (link.resourceType !== resourceType) {
    throw new OpenwopError('not_found', 'Shared link not found.', 404, {});
  }
  return { tenantId: link.tenantId, orgId: link.orgId, resourceId: link.resourceId };
}

export async function resolveShared(token: string): Promise<{
  resourceType: ResourceType;
  label?: string;
  resource: Record<string, unknown>;
  /** UX_UPGRADE-sharing SH-G1, CORRECTED in R2 (SR-3): WHEN this content was
   *  captured — present ONLY for resource types whose loader actually applies
   *  the snapshot instant (today: conversations, whose messages are filtered
   *  to <= createdAt). Every other resolver serves the CURRENT state (the
   *  cms_page "living document" precedent), so stamping `snapshotAt` on those
   *  made the viewer's "Snapshot from {date}" line FALSE for 8 of 9 types.
   *  Absent ⇒ the view is live and the viewer says so. */
  snapshotAt?: string;
  /** When the link stops working, when the owner set an expiry. */
  expiresAt?: string;
}> {
  // SHARE-UX-1 / SHARE-13 — LOAD FIRST, then count. The count used to be taken
  // before the load, so every hit on an ORPHANED link (row alive, resource
  // deleted) spent a `maxViews` slot on a 404 — a cap-3 link pointed at a
  // deleted document exhausted itself in three failed page loads. The cap is
  // still enforced (authoritatively, under CAS) before anything is returned;
  // only the ORDER changed.
  //
  // R2 F9 — but "one wasted resolver read" understated it. An EXHAUSTED link is
  // an unauthenticated URL that anyone holding the token can hit repeatedly, so
  // moving the load in front of the refusal turned every one of those hits into a
  // kb `getCollection` + `listDocuments`, or a cms `resolveSharedRefs` fan-out —
  // work an attacker gets for free, forever, on a link the owner has already
  // spent. The cheap, non-authoritative pre-check below refuses BEFORE the load
  // when the row already shows the cap reached. It does NOT replace the CAS
  // enforcement (a racing concurrent view is still caught there); it removes the
  // amplification without giving the orphan case its slot-burn back, since a
  // link that is not at its cap still loads first.
  const link = await resolveActiveLink(token);
  // SHCD-16 / ADR 0644 D8 — the cap pre-check that used to sit here (and its twin
  // in `resolveSharedCard`) moved INTO `resolveActiveLink`, the one chokepoint.
  const resource = await RESOLVERS[link.resourceType].load(link.tenantId, link.orgId, link.resourceId, { snapshotAt: link.createdAt });
  // SHARE-UX-1 — the wire already distinguished this case by MESSAGE only, which
  // the client could not read; `reason` makes it machine-readable so the public
  // viewer can stop telling the recipient the owner revoked a link the owner
  // never touched. It leaks nothing: the reader already holds a valid token, so
  // "this token existed" is not news, and a revoked / never-existed / cross-org
  // token still collapses to the uniform reason-less 404 from `resolveActiveLink`.
  if (!resource) throw new OpenwopError('not_found', 'Shared resource not found.', 404, { reason: 'resource-gone' });
  // PUB-7 — count this content view + enforce the per-link cap (the card path is exempt).
  await countShareViewOrThrow(token);
  return {
    resourceType: link.resourceType,
    ...(link.label ? { label: link.label } : {}),
    resource,
    ...(link.resourceType === 'conversation' ? { snapshotAt: link.createdAt } : {}),
    ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}),
  };
}

export async function resolveSharedCard(token: string, baseUrl: string): Promise<{ title: string; description: string; imageUrl?: string }> {
  const link = await resolveActiveLink(token);
  const card = await RESOLVERS[link.resourceType].card(link.tenantId, link.orgId, link.resourceId, { snapshotAt: link.createdAt });
  if (!card) throw new OpenwopError('not_found', 'Shared resource not found.', 404, {});
  return {
    title: card.title,
    description: card.description,
    ...(card.imageToken ? { imageUrl: `${vendorPublicBase(baseUrl)}/assets/${encodeURIComponent(card.imageToken)}` } : {}),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** ADR 0122 Phase 3 — keep only messages created at-or-before the snapshot marker
 *  (the link's mint time). No marker ⇒ all messages (back-compat). */
function snapshotMessages<T extends { createdAt: string }>(messages: readonly T[], snapshotAt: string | undefined): T[] {
  if (!snapshotAt) return [...messages];
  return messages.filter((m) => m.createdAt <= snapshotAt);
}

function notFound(resourceId: string): OpenwopError {
  return new OpenwopError('not_found', 'Resource not found in this organization.', 404, { resourceId });
}

function expiryFields(raw: unknown, now: Date): { expiresAt?: string } {
  if (raw == null || raw === '') return {};
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0 || days > MAX.expiresInDays) {
    throw new OpenwopError('validation_error', `\`expiresInDays\` MUST be an integer 1–${MAX.expiresInDays}.`, 400, { field: 'expiresInDays' });
  }
  return { expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() };
}

/**
 * R2 SR-1 — prerender a cms page's sections to markdown for the shared viewer
 * (the commerce_order precedent: the server renders, the generic viewer shows).
 * Text-bearing sections render their content; LIVE sections (product grids,
 * forms, entity queries, the pricing tier grid) resolve at delivery time on the
 * published site and cannot ride a static share — each leaves an HONEST note
 * instead of vanishing (the "report the list" rule: silence would misrepresent
 * the page as complete). Images are references to tenant media with no public
 * URL on this surface; the caption/alt renders when authored.
 */
function cmsSectionsToMarkdown(sections: Section[]): string {
  const esc = (s: string): string => s.replace(/\|/g, '\\|');
  const parts: string[] = [];
  for (const s of sections) {
    const d = s.data as Record<string, unknown>;
    const str = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
    const head = (): string[] => [
      ...(str('eyebrow') ? [`*${str('eyebrow')}*`, ''] : []),
      ...(str('heading') ? [`## ${str('heading')}`, ''] : []),
      ...(str('lede') ? [str('lede'), ''] : []),
    ];
    switch (s.type) {
      case 'hero':
        parts.push([
          ...(str('eyebrow') ? [`*${str('eyebrow')}*`, ''] : []),
          ...(str('heading') ? [`# ${str('heading')}`, ''] : []),
          ...(str('subheading') ? [str('subheading')] : []),
        ].join('\n'));
        break;
      case 'richText':
        parts.push([...head(), str('text')].join('\n'));
        break;
      case 'cta':
        parts.push([
          ...head(),
          ...(str('subheading') ? [str('subheading'), ''] : []),
          str('url') ? `[${str('label')}](${str('url')})` : `**${str('label')}**`,
        ].join('\n'));
        break;
      case 'columns': {
        const cols = Array.isArray(d.columns) ? d.columns as { title?: string; text?: string }[] : [];
        parts.push([
          ...head(),
          ...cols.map((c) => (c.title ? `- **${c.title}** — ${c.text ?? ''}` : `- ${c.text ?? ''}`)),
        ].join('\n'));
        break;
      }
      case 'faq': {
        const items = Array.isArray(d.items) ? d.items as { q?: string; a?: string }[] : [];
        parts.push([
          ...head(),
          ...items.flatMap((it) => [`### ${it.q ?? ''}`, '', it.a ?? '', '']),
        ].join('\n'));
        break;
      }
      case 'quotes': {
        const items = Array.isArray(d.items) ? d.items as { quote?: string; name?: string; role?: string }[] : [];
        parts.push([
          ...head(),
          ...items.flatMap((it) => {
            const by = [it.name, it.role].filter(Boolean).join(', ');
            return [`> ${it.quote ?? ''}`, ...(by ? [`> — *${by}*`] : []), ''];
          }),
        ].join('\n'));
        break;
      }
      case 'fields': {
        // ADR 0748 — flat named scalars (a protocol-authored section).
        const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
        parts.push(Object.entries(d).map(([k, v]) => [k, text(v)] as const).filter(([, v]) => v).map(([k, v]) => `- **${k}**: ${v}`).join('\n'));
        break;
      }
      case 'comparison': {
        const columns = Array.isArray(d.columns) ? (d.columns as string[]) : [];
        const rows = Array.isArray(d.rows) ? d.rows as { label?: string; cells?: string[] }[] : [];
        parts.push([
          ...head(),
          `| | ${columns.map(esc).join(' | ')} |`,
          `|---|${columns.map(() => '---').join('|')}|`,
          ...rows.map((r) => `| ${esc(r.label ?? '')} | ${(r.cells ?? []).map(esc).join(' | ')} |`),
          ...(str('legend') ? ['', `*${str('legend')}*`] : []),
          ...(str('note') ? ['', `*${str('note')}*`] : []),
        ].join('\n'));
        break;
      }
      case 'image':
        // Media tokens have no public URL on this surface — render the words.
        if (str('caption') || str('alt')) parts.push(`*${str('caption') || str('alt')}*`);
        break;
      case 'productGrid':
      case 'form':
      case 'entityList':
      case 'entityDetail':
      case 'pricing':
        // Live-resolved at delivery time; a static share cannot carry them.
        parts.push([
          ...head(),
          '*This section shows live content on the published page and isn’t included in this shared view.*',
        ].join('\n'));
        break;
      default:
        break;
    }
  }
  return parts.filter((p) => p.trim().length > 0).join('\n\n');
}

/** A short description from the first hero/richText section text, bounded. */
function describeSections(sections: Section[], fallback: string): string {
  for (const s of sections) {
    const d = s.data as Record<string, unknown>;
    const text = typeof d.subheading === 'string' ? d.subheading
      : typeof d.text === 'string' ? d.text
        : typeof d.heading === 'string' ? d.heading : '';
    if (text.trim().length > 0) return text.trim().slice(0, MAX.descr);
  }
  return fallback;
}

/** The first hero/image section's media token, for the social card. */
function heroImageToken(sections: Section[]): string | undefined {
  for (const s of sections) {
    const d = s.data as Record<string, unknown>;
    const token = typeof d.imageToken === 'string' ? d.imageToken : typeof d.token === 'string' ? d.token : '';
    if (token) return token;
  }
  return undefined;
}


// ─── SHARE-2 — per-subject erasure (ADR 0464) ────────────────────────────────
//
// THE DECISION, TAKEN EXPLICITLY AND WRITTEN DOWN (this is what the tripwire
// entry asked the sharing owner to settle, and the entry said only "erasure
// should PLAUSIBLY revoke"): erasing a person REVOKES every link they minted,
// then anonymizes the attribution. It does not merely scrub `createdBy`.
//
// Why revoke rather than re-attribute — the shape used for every other
// `createdBy` store in the repo. A share link is not org collateral that happens
// to carry an author; it is a LIVE, UNAUTHENTICATED CAPABILITY that person
// issued over the org's data. Re-attributing it would leave a working public URL
// to a document, deck, quote or conversation with nobody accountable for its
// existence — an anonymized still-working link is strictly worse than a dead
// one, because the org can no longer answer "who published this, and may I ask
// them to stop?". Revocation is also the only outcome the person themselves
// could have produced by hand before leaving.
//
// Why the ROW SURVIVES revocation: revocation state and the retention trail are
// the audit fact ("this URL stopped working on <date>"), and the row is what
// makes the recipient's later 404 explicable. It ages out on the normal 30-day
// `deadAt` lane, so the residue is bounded rather than permanent.
//
// The consequence, said plainly rather than discovered later: THIS BREAKS LIVE
// LINKS.
//
// CORRECTED (R2 review, F3) — the first version of this paragraph named the ONE
// category erasure does NOT touch, and understated the one it does. It said "a
// booking-reschedule or e-sign token minted by a departing member stops working".
// It does not. The match below is `l.createdBy === subjectKey`, and every
// capability token is minted by a SYSTEM actor, never by a person:
// `crm/bookingService.ts` mints as `'system:crm-booking'`,
// `crm/signService.ts` as `'system:crm-sign'`, `commerce/commerceService.ts` as
// `'system:commerce'`. The ONLY mint site that attributes a link to a human is
// the authed management route (`sharing/routes.ts`, `user.userId`).
//
// So the real blast radius is: every CONTENT link that person minted by hand —
// a CMS page, a KB collection, a document, a prompt, a deck or app design, a
// shared conversation — goes dead, for the recipients as well as the owner. The
// org's booking, e-signature and order-status tokens are UNAFFECTED, because the
// app minted them, not the departing member. That is the intended trade on a
// GDPR erasure path and is the reason the decision is recorded here instead of
// being left to a default. (If capability tokens should die with their subject
// too, that is a different decision requiring a different key than `createdBy` —
// it is not what this code does.)
//
// Idempotent (a second run finds nothing un-revoked and nothing attributed) and
// invoked once per LINKED subject key, per the `SubjectEraser` contract.
const ERASED_ACTOR = 'erased';

export async function eraseSubjectSharing(tenantId: string, subjectKey: string): Promise<{ revoked: number; anonymized: number }> {
  if (!tenantId || !subjectKey) return { revoked: 0, anonymized: 0 };
  let revoked = 0;
  let anonymized = 0;
  // The complete scan, deliberately (R2 F5, same reasoning as
  // `purgeLinksForResource`): a tenant-index miss here would leave a WORKING
  // public URL attributed to a person the host has just told a regulator it
  // erased. "Delayed, not lost" is not an acceptable posture for that. Erasure
  // is a rare, per-subject operation; completeness wins over speed.
  for (const l of await links.list()) {
    if (l.tenantId !== tenantId || l.createdBy !== subjectKey) continue;
    const now = nowIsoSharing();
    const next: ShareLink = { ...l, createdBy: ERASED_ACTOR };
    if (!l.revoked) {
      next.revoked = true;
      next.revokedAt = now;
      next.deadAt = now;
      revoked += 1;
    }
    await links.put(next);
    anonymized += 1;
  }
  if (revoked > 0 || anonymized > 0) log.info('sharing_subject_erased', { tenantId, revoked, anonymized });
  return { revoked, anonymized };
}

declarePiiFields('sharing.link', ['createdBy']);
registerSubjectEraser(async function eraseSharingSubject(tenantId, subjectKey) { await eraseSubjectSharing(tenantId, subjectKey); });

// ─── WF-SHARE-3 — the delete cascade, on the OWNER's seam ────────────────────
//
// `purgeLinksForResource` used to be called from the DELETE ROUTE handlers
// (`canvasEditorRoutes.ts`, `documents/routes.ts`) while the single delete OWNER
// is `deleteCanvasForTenant`, which fires this lifecycle seam precisely so "no
// caller can skip the sidecar cascade". Sharing registered no handler, so every
// non-route deleter — app-builder's retention purger, the demo-clear seeders —
// orphaned its links. And the leftovers did NOT self-heal: the old sweep only
// purged revoked-or-expired rows, and a link orphaned by a retention delete is
// neither, so it was immortal (`canvasRetention.ts` said otherwise; corrected
// there in this change).
//
// Registered from the feature into the host seam — the sanctioned inversion; the
// host never imports features.
onCanvasDeleted('sharing', async ({ tenantId, canvasId, canvasTypeId }) => {
  const type: ResourceType | null = canvasTypeId === 'canvas.app-builder' ? 'app_builder_canvas'
    : canvasTypeId === 'canvas.slides' ? 'slides_canvas'
      : null;
  if (!type) return; // other canvas types are not shareable
  await purgeLinksForResource(tenantId, type, canvasId);
});

// WF-SHARE-4 — the same seam for conversations, whose store the HOST owns (so it
// cannot import this feature). The remaining owners cascade by calling
// `purgeLinksForResource` from their own delete function (cms, kb, documents,
// prompts, commerce orders).
//
// COVERAGE, stated rather than implied. Eleven of the twelve resource types now
// cascade on delete — and R2 review F8 corrected one of those eleven:
// `creative_brief` was counted on the strength of a cascade that lived only in
// `creative-briefs/routes.ts`, so the demo-clear seeder and the bulk delete,
// which call `deleteBrief` directly, orphaned their links. The cascade now sits
// on `deleteBrief` itself (the delete OWNER), which is what the count claimed.
// The twelfth, `commerce_quote`, does NOT and cannot today:
// there is no quote-delete path at all — a quote's lifecycle is
// draft→sent→accepted/declined and the row is a business record that is never
// removed — so there is nothing to cascade from. If quote deletion is ever
// added, its owner must call `purgeLinksForResource(tenantId,
// 'commerce_quote', quoteId)`; until then the link row simply outlives nothing.
onConversationDeleted('sharing', async ({ tenantId, conversationId }) => {
  await purgeLinksForResource(tenantId, 'conversation', conversationId);
});

// ─── ADR 0448 P2 — the hashed-at-rest re-key migration ───────────────────────
// Legacy rows are keyed by (and carry) the RAW token. This boot pass re-keys
// them to sha256 and drops the raw field. Idempotent BY SHAPE: the legacy
// views' validators only surface rows that still carry a raw `token`, so a
// clean store is a no-op and a crash mid-pass resumes safely (new row is
// written BEFORE the raw-keyed row is deleted). Runs every boot — no sentinel
// (the fold lesson: sentinels strand).
// Deploy-skew note (recorded in the ADR): during a rolling deploy, an OLD
// instance cannot read re-keyed rows (its validator wants `token`) — a link
// resolves 404 on old instances until they cycle. Bounded, transient, honest.

interface LegacyShareLink extends Omit<ShareLink, 'tokenHash'> { token: string }
interface LegacyFrameView { token: string; tenantId: string; frame: number; count: number }

const legacyLinksView = new DurableCollection<LegacyShareLink>(
  'sharing:link',
  (l) => l.token,
  (parsed) => {
    const l = parsed as LegacyShareLink | null;
    return l && typeof l.token === 'string' ? l : null; // new-shape rows -> null (invisible here)
  },
  (l) => l.tenantId,
);
const legacyFrameViewsView = new DurableCollection<LegacyFrameView>(
  'sharing:frameview',
  (v) => `${v.token}:${v.frame}`,
  (parsed) => {
    const v = parsed as LegacyFrameView | null;
    return v && typeof v.token === 'string' ? v : null;
  },
  (v) => v.tenantId,
);

/** Migrate ONE legacy raw-keyed link (grade fix #3: shared by the boot pass and
 *  the lazy on-read fallback, so a mid-migration boot never 404s a live link).
 *  A crash-resume merges viewCount with Math.max — the new row may have served
 *  views since (the same rule the frame branch always had). */
async function migrateLegacyLink(l: LegacyShareLink): Promise<boolean> {
  const { token, ...rest } = l;
  const hash = hashToken(token);
  const existing = await links.get(hash);
  await links.put({ ...rest, tokenHash: hash, viewCount: Math.max(existing?.viewCount ?? 0, rest.viewCount ?? 0) });
  await legacyLinksView.delete(token); // write-new-then-delete-old: crash-resumable
  return true;
}

/** The on-read fallback: a public resolve that misses the hash-keyed store
 *  checks the legacy view and migrates in place (bounded: one point-get). */
async function migrateLegacyLinkOnRead(rawToken: string): Promise<ShareLink | null> {
  const legacy = await legacyLinksView.get(rawToken);
  if (!legacy) return null;
  await migrateLegacyLink(legacy);
  return links.get(hashToken(rawToken));
}

export async function rekeySharingAtRest(): Promise<{ links: number; frames: number }> {
  let migratedLinks = 0;
  let migratedFrames = 0;
  for (const l of await legacyLinksView.list()) {
    migratedLinks += (await migrateLegacyLink(l)) ? 1 : 0;
  }
  for (const v of await legacyFrameViewsView.list()) {
    const hash = hashToken(v.token);
    const existing = await frameViews.get(`${hash}:${v.frame}`);
    // A crash between put and delete can leave both rows: keep the LARGER count
    // (the new row may have accrued views since) rather than clobbering it.
    await frameViews.put({ tokenHash: hash, tenantId: v.tenantId, frame: v.frame, count: Math.max(existing?.count ?? 0, v.count) });
    await legacyFrameViewsView.delete(`${v.token}:${v.frame}`);
    migratedFrames += 1;
  }
  if (migratedLinks > 0 || migratedFrames > 0) log.info('sharing_rekeyed_at_rest', { migratedLinks, migratedFrames });
  return { links: migratedLinks, frames: migratedFrames };
}
