/**
 * GateEvidence — the concrete content a HITL approval gate is asking a human to
 * sign off on, rendered from an interrupt's `data`.
 *
 * ── WHY IT EXISTS (ADR 0600 §2, `ISU-10`) ───────────────────────────────────
 *
 * There were TWO approval cards over the same payload, and they disagreed. The
 * chat card (`chat/registry/defaultCards.tsx`) auto-loaded the gate-preview
 * artifact and rendered it. The runs-page / notifications-inbox card
 * (`interrupts/ApprovalCard.tsx`) read exactly two keys — `data.prompt` and
 * `data.actions` — and never touched `options`, `artifactId` or `revisionId`.
 *
 * **The default route lands on the blind one.** `notify.ts` sets the interrupt
 * notification's `actionUrl` to `/inbox`, and `/inbox` renders the interrupts
 * card. So the surface the app actually sends approvers to was the one that
 * showed them nothing: "Confirm the variance figures before surfacing." with no
 * figures, "Review the recognition draft." with no draft. Approve blind or
 * reject blind were the only two real options.
 *
 * The evidence was ALWAYS on the wire. `executor.ts` persists the gate's
 * upstream output as a durable run-artifact and binds `artifactId`/`revisionId`
 * onto the interrupt data, and `listOpenInterrupts` returns that data verbatim.
 * The inbox card had it in hand and dropped it.
 *
 * ONE component, not a second copy — the same rule the ADR 0083 fix reached for
 * and then applied to only one of the two cards. A second implementation is how
 * these two drifted apart in the first place.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not render the ≥2-option PICKER. That picker chooses a resume VALUE,
 * which is a chat-card capability (`onAction` carries the pick); the interrupts
 * card resolves with `{action, comment}` and has nothing to pick with. Rendering
 * a picker there would offer a control that cannot do what it looks like it
 * does. Multiple options are shown as read-only evidence instead.
 *
 * ── THE HOLE IT CANNOT CLOSE ────────────────────────────────────────────────
 *
 * `executor.ts` SKIPS artifact persistence when `run.forkMode === 'replay'`, so
 * a replayed or forked run's gate has NEITHER inline options nor an artifactId
 * and there is nothing to render. Closing that means changing what replay
 * persists — a replay-safety decision, not a rendering one, and out of scope
 * here. What IS in scope is not letting it pass silently: this component says
 * "nothing was captured" rather than rendering an empty box, so a blind card
 * announces that it is blind.
 *
 * The two callers differ deliberately on that last point. The chat card gates
 * the block on `hasGateEvidence`, so its no-evidence rendering is unchanged.
 * The interrupts card renders it unconditionally, because THAT is the surface
 * approvers are routed to and a silent blind card there is the whole defect.
 *
 * ── CORRECTION (ADR 0600 §Correction 1) — THE FIRST VERSION MADE A FALSE CLAIM ─
 *
 * The rule above ("say when you are blind") shipped reading exactly THREE keys —
 * `options`, `artifactId`, `revisionId` — and then asserting *"Nothing was
 * captured for this gate"* whenever it found none of them. That sentence is a
 * claim about the INTERRUPT, made from a measurement of three fields.
 *
 * `core.email.send` (ADR 0193) raises `kind:'approval'` with
 * `profile:'openwop-send-approval'` and **`data.message = {to, subject,
 * bodyPreview, html, provider}`** — the exact bytes about to leave the user's
 * mailbox. None of the three. So on the highest-stakes gate in the app, the
 * inbox card told the approver nothing had been captured while the message sat
 * in the payload it was rendering from. Before ADR 0600 §2 that card was blind
 * and SILENT; §2 made it blind and WRONG. That is the family §1 exists to close,
 * committed by the fix that closes it.
 *
 * Two changes, because the defect has two halves:
 *
 * 1. **The send envelope is evidence** — it is extracted, `hasGateEvidence`
 *    counts it, and it RENDERS (winning over the gate-preview artifact, which
 *    for a send gate is the node's upstream port inputs — not the message). The
 *    chat card's own copy of this block is deleted, so the two surfaces really
 *    are one component now, which is what §2 claimed and did not deliver.
 * 2. **The claim is conditional on RECOGNITION, not on three fields.** `data`
 *    carrying any key this component does not know about no longer produces
 *    "nothing was captured" — it produces neutral copy that says this card
 *    cannot show it. `core.interrupt` forwards `config.data` VERBATIM
 *    (`bootstrap/nodes.ts`), so a pack author can put an arbitrary payload here;
 *    the next such payload must degrade to silence-about-the-gate, not to a
 *    fresh false claim. Silence makes no claim; a false claim does.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/index.js';
import { FileTextIcon, MailCheckIcon, SearchIcon } from '../../ui/icons/index.js';
import { getArtifact, getArtifactRevision } from '../artifacts/artifactClient.js';
import type { ReviewAsset } from './reviewClient.js';

// Entry-weight: pulls the shared Markdown renderer + modal chrome, and renders
// only inside an open gate — lazy, as the chat card already had it.
const AssetPreview = lazy(() => import('./AssetPreview.js').then((m) => ({ default: m.AssetPreview })));
const AssetPreviewModal = lazy(() => import('./AssetPreviewModal.js').then((m) => ({ default: m.AssetPreviewModal })));

interface GateOption { key: string; label: string; content: string }

/** ADR 0193 — the rendered, about-to-be-sent envelope `core.email.send` puts on
 *  its approval interrupt. These are the bytes that leave AS the user. */
export interface GateSendMessage {
  to?: string | readonly string[];
  subject?: string;
  bodyPreview?: string;
  provider?: string;
}

/** The evidence fields an approval interrupt's `data` may carry. */
export interface GateEvidenceData {
  options?: readonly GateOption[];
  artifactId?: string;
  revisionId?: string;
  sendMessage?: GateSendMessage;
}

/**
 * Every `data` key this component KNOWS about — the evidence lanes plus the
 * approval envelope's own chrome/control fields (from `core.approvalGate`,
 * `core.email.send`, `core.clarificationGate` and the resolve-time quorum
 * reader). It exists so the "nothing was captured" claim can be conditioned on
 * RECOGNITION: a key outside this set means there IS a payload here that this
 * card cannot render, which is a different statement from "the gate captured
 * nothing" and must not be collapsed into it.
 *
 * Adding a new payload lane to an approval interrupt means adding its key here
 * AND rendering it — listing it without rendering it re-opens the same hole in
 * the quieter direction.
 */
const RECOGNIZED_GATE_KEYS: ReadonlySet<string> = new Set([
  // evidence lanes, rendered below
  'options', 'artifactId', 'revisionId', 'message',
  // envelope chrome — control, not content
  'prompt', 'title', 'actions', 'profile', 'key', 'kind',
  'requiredApprovals', 'rejectionPolicy', 'approversList',
  'approverRefs', 'approverGroupRefs', 'approverRoleRefs', 'overrideScopes',
  'question', 'schema', 'resumeSchema',
]);

/** Narrow an interrupt's opaque `data` to the evidence fields, without casting. */
export function gateEvidenceOf(data: unknown): GateEvidenceData {
  if (!data || typeof data !== 'object') return {};
  const d = data as Record<string, unknown>;
  const options = Array.isArray(d.options)
    ? (d.options.filter(
        (o): o is GateOption =>
          !!o && typeof o === 'object'
          && typeof (o as GateOption).key === 'string'
          && typeof (o as GateOption).label === 'string'
          && typeof (o as GateOption).content === 'string',
      ))
    : undefined;
  // Discriminated by `profile`, exactly as the chat card did (mirrors ADR 0189's
  // `openwop-connection`): a bare `message` on some other gate is NOT this shape.
  const raw = d.profile === 'openwop-send-approval' && d.message && typeof d.message === 'object' && !Array.isArray(d.message)
    ? (d.message as Record<string, unknown>)
    : undefined;
  const sendMessage: GateSendMessage | undefined = raw
    ? {
        ...(typeof raw.to === 'string' || Array.isArray(raw.to) ? { to: raw.to as string | readonly string[] } : {}),
        ...(typeof raw.subject === 'string' ? { subject: raw.subject } : {}),
        ...(typeof raw.bodyPreview === 'string' ? { bodyPreview: raw.bodyPreview } : {}),
        ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
      }
    : undefined;
  return {
    ...(options && options.length > 0 ? { options } : {}),
    ...(typeof d.artifactId === 'string' ? { artifactId: d.artifactId } : {}),
    ...(typeof d.revisionId === 'string' ? { revisionId: d.revisionId } : {}),
    ...(sendMessage ? { sendMessage } : {}),
  };
}

/** True when this gate carries evidence at all — lets a caller skip the block
 *  entirely rather than render a box that says nothing. */
export function hasGateEvidence(data: unknown): boolean {
  const e = gateEvidenceOf(data);
  return (e.options?.length ?? 0) > 0 || !!e.artifactId || !!e.sendMessage;
}

/**
 * True when `data` carries a key this component has never heard of — so there is
 * SOMETHING here and we cannot show it. Distinct from "nothing was captured",
 * which is a claim about the gate rather than about this card.
 */
export function hasUnrecognizedGatePayload(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return Object.keys(data as Record<string, unknown>).some((k) => !RECOGNIZED_GATE_KEYS.has(k));
}

export function GateEvidence({
  data,
  title,
}: {
  /** The interrupt's raw `data`. */
  data: unknown;
  /** Modal heading — normally the gate's prompt. */
  title: string;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const evidence = gateEvidenceOf(data);
  const { artifactId, revisionId, sendMessage } = evidence;
  const inlineAssets: ReviewAsset[] = (evidence.options ?? []).map((o) => ({ label: o.label, content: o.content }));

  const [artifactAssets, setArtifactAssets] = useState<ReviewAsset[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A send gate renders its envelope, so the gate-preview artifact (the node's
    // upstream PORT INPUTS, not the message) is never fetched or shown for it.
    if (sendMessage || inlineAssets.length > 0 || !artifactId || !revisionId) return;
    setLoading(true);
    setFailed(false);
    (async () => {
      try {
        // Fetch the artifact (to learn source/format — the revision alone has no
        // discriminator) alongside its content. ADR 0458 §2.4: a media artifact
        // renders inline (image/video), so its revision `content` IS the serve URL
        // and its `format` IS the MIME type — never treat that URL as text.
        const [artifact, rev] = await Promise.all([
          getArtifact(artifactId),
          getArtifactRevision(artifactId, revisionId),
        ]);
        if (cancelled) return;
        setArtifactAssets([
          artifact.source === 'media'
            ? {
                label: title, artifactId, revisionId,
                ...(rev.content ? { url: rev.content } : {}),
                ...(artifact.format ? { mimeType: artifact.format } : {}),
              }
            // ADR 0459 grade-fix — carry the artifactTypeId so AssetPreview can dispatch a
            // TYPED artifact to its humanized renderer instead of rendering raw JSON as markdown.
            : { label: title, content: rev.content ?? '', artifactId, revisionId,
                ...(artifact.artifactTypeId ? { artifactTypeId: artifact.artifactTypeId } : {}) },
        ]);
      } catch {
        // A FAILED evidence read must NOT render as "no preview available".
        // The code this was extracted from did exactly that
        // (`setArtifactAssets([])  // surface the empty-state inline rather
        // than failing`) — and the one place that claim must never be made is
        // in front of someone about to sign an approval, because "there was
        // nothing to review" and "we could not show you what you are signing"
        // are opposite instructions. Same shape as ADR 0600 §1's "No events
        // yet"; carried in a separate flag so it cannot collapse into empty.
        if (!cancelled) { setArtifactAssets([]); setFailed(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inlineAssets is derived from `data`
  }, [artifactId, revisionId, title]);

  const assets: ReviewAsset[] = inlineAssets.length > 0 ? inlineAssets : (artifactAssets ?? []);
  const first = assets[0];
  // THE claim, and it is conditional on RECOGNITION rather than on the three
  // fields this component happens to read (see the correction note above): a
  // `data` carrying a payload we don't understand says so, and never says the
  // gate captured nothing.
  const nothingCaptured = !hasGateEvidence(data) && !hasUnrecognizedGatePayload(data);
  const sendTo = sendMessage
    ? (Array.isArray(sendMessage.to) ? sendMessage.to.join(', ') : (sendMessage.to as string | undefined) ?? '')
    : '';

  return (
    <div className="approval-preview u-mbox-b2" data-testid="gate-evidence">
      <div className="approval-preview-head">
        <span className="approval-preview-label u-iflex u-items-center u-gap-1-5">
          {sendMessage
            ? <><MailCheckIcon size={13} aria-hidden /> {t('sendReviewHeading')}</>
            : <><FileTextIcon size={13} aria-hidden /> {t('underReview')}</>}
        </span>
        {sendMessage?.provider ? (
          <span className="chip u-fs-11">{sendMessage.provider}</span>
        ) : first?.content ? (
          <Button
            variant="quiet" className="u-fs-11 u-pad-2x8 u-iflex u-items-center u-gap-1"
            onClick={() => setOpen(true)}
          >
            <SearchIcon size={12} aria-hidden /> {t('viewFull')}
          </Button>
        ) : null}
      </div>
      <div className="approval-preview-body">
        {sendMessage ? (
          // ADR 0193's approved-bytes-verbatim preview, now on BOTH cards. This
          // is the one gate that sends AS the human, and the inbox is where the
          // notification routes them.
          <div className="u-flex u-flex-col u-gap-1-5" data-testid="gate-evidence-send">
            <div className="u-fs-12"><span className="muted">{t('sendReviewTo')} </span>{sendTo}</div>
            <div className="u-fs-12"><span className="muted">{t('sendReviewSubject')} </span>{sendMessage.subject ?? ''}</div>
            {sendMessage.bodyPreview ? (
              <pre className="email-send-preview-body u-fs-12 u-m-0">{sendMessage.bodyPreview}</pre>
            ) : null}
          </div>
        ) : loading
          ? <p className="muted u-fs-12 u-m-0">{t('previewLoading')}</p>
          : failed
            ? (
              // ADR 0600 §Correction 7 (the `ISU-27` family, committed by the
              // fix for `ISU-10`). This shipped as a hand-rolled
              // `<p role="alert">` — a CONDITIONALLY MOUNTED inline live region
              // arriving with its text already inside, which is the exact
              // mechanism §3 spends eleven lines removing from `CompletionShell`
              // and which `ui/Notice.tsx` explicitly refuses to treat as
              // established ("`role='alert'` … is NOT verified here and MUST NOT
              // be treated as established — assuming it is exactly the mistake
              // that shipped #2615"). It carried this PR's most consequential
              // sentence — "Don't decide from this card" — and all four a11y
              // gates are blind to it (§3's own measured table). `<Notice
              // announce>` delegates to ADR 0363's `GlobalLiveRegion`, mounted
              // once at `App.tsx` long before any message, and drops its own
              // region so there is no double-announce.
              <div data-testid="gate-evidence-failed">
                <Notice variant="error" announce={t('gateEvidenceUnreadable')}>
                  {t('gateEvidenceUnreadable')}
                </Notice>
              </div>
            )
            : first
              ? <Suspense fallback={null}><AssetPreview asset={first} hideLabel /></Suspense>
              : (
                <p className="muted u-fs-12 u-m-0" data-testid="gate-evidence-none">
                  {nothingCaptured
                    ? t('gateEvidenceNone')
                    : hasUnrecognizedGatePayload(data)
                      ? t('gateEvidenceUnrenderable')
                      : t('assetPreviewNone')}
                </p>
              )}
        {!sendMessage && assets.length > 1 ? (
          <p className="muted u-fs-11 u-mbox-t1 u-m-0">{t('gateEvidenceMore', { count: assets.length - 1 })}</p>
        ) : null}
      </div>
      {open ? (
        <Suspense fallback={null}>
          <AssetPreviewModal open assets={assets} title={title} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
