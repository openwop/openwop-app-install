/**
 * Sandboxed interactive-artifact renderer (ADR 0128 Phase 2, ADR 1017 D1).
 * SECURITY-CRITICAL: renders UNTRUSTED model- or peer-authored HTML.
 *
 * Two modes, and the viewer picks the second one per view:
 *  - STATIC (the default): `sandbox=""` and the `inert` attribute. No script runs,
 *    nothing can be clicked or focused, and nothing reaches the network. ADR 1017
 *    measured every egress channel blocked here, including the one-click link that
 *    `sandbox=""` alone still allows (a sandboxed frame may always navigate itself,
 *    and the content can draw its own fake "Run" button to get that click).
 *  - RUNNING: `sandbox="allow-scripts"` after the viewer presses Run in the PARENT
 *    chrome, next to a notice. The null origin still holds (no parent DOM, cookies,
 *    storage or credentialed requests), but a script CAN reach the network: a frame
 *    may navigate itself, a meta refresh fires, and WebRTC ignores the CSP. CSP has
 *    no directive for either (ADR 1017 M1). So scripts run only on consent.
 *
 * Consent is keyed by `consentKey` (default: the body). A different key starts static
 * again, so consent never carries from one artifact, revision or peer edit to the
 * next. It is never persisted. The frame remounts on every mode change, because the
 * browser reads `sandbox` flags only at navigation.
 *
 * The CSP stays in both modes: it still blocks fetch, images, fonts and frames.
 * The body goes ONLY into the iframe `srcdoc`, never into the parent document.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { ARTIFACT_SANDBOX, ARTIFACT_SANDBOX_STATIC, buildArtifactSrcdoc } from './artifactSandbox.js';

export { ARTIFACT_CSP, ARTIFACT_SANDBOX, ARTIFACT_SANDBOX_STATIC, buildArtifactSrcdoc } from './artifactSandbox.js';

interface Props {
  body: string;
  title?: string;
  /** What the viewer's Run consent is for. Defaults to the body, so new content
   *  starts static. A caller whose body changes while the same thing is shown (a
   *  live-edit draft) passes a stable key instead. */
  consentKey?: string;
}

/** IART-6: an upper bound on the untrusted body fed to the iframe (the backend inline cap is
 *  the authority; this is a defense-in-depth FE bound so a pathological local-edit draft can't
 *  re-paint an unbounded iframe). */
const MAX_BODY_CHARS = 512_000;
/** How much of the static preview's text a screen reader is given. */
const MAX_TEXT_CHARS = 4_000;

/** The readable text of an untrusted HTML body, for the screen-reader alternative to
 *  the static (inert, so unreadable) frame. `DOMParser` builds an inert document: it
 *  runs no script and loads no resource. Rendered as a React text child (escaped). */
/** Does the body have anything that only works with scripts or clicks (scripts, inline
 *  handlers, `javascript:` URLs, links, forms, controls)? When it does not, the static
 *  preview IS the whole content, and the viewer is not asked to grant scripts for nothing.
 *  A heuristic for the PROMPT only: the sandbox, not this test, is the boundary. */
export function hasInteractiveContent(body: string): boolean {
  return /<script|\son[a-z]+\s*=|javascript:|<a[\s>]|<form|<button|<input|<select|<textarea|<iframe|<object|<embed/i.test(body);
}

export function artifactTextAlternative(body: string): string {
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(body, 'text/html');
  doc.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
  // Text node by text node, joined by spaces: `textContent` runs block elements
  // together ("Quarterly planShip it"), which a screen reader reads as one word.
  const parts: string[] = [];
  if (doc.body) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue ?? '');
    // An image's text alternative is part of what the content says.
    doc.body.querySelectorAll('img[alt]').forEach((img) => { const alt = img.getAttribute('alt')?.trim(); if (alt) parts.push(alt); });
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

export function SandboxedArtifactFrame({ body, title, consentKey }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const noticeId = useId();
  const key = consentKey ?? body;
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const running = runningKey === key;
  const frameRef = useRef<HTMLIFrameElement>(null);

  // React 18 has no `inert` prop, so set the attribute directly, before paint.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    if (running) el.removeAttribute('inert');
    else el.setAttribute('inert', '');
  }, [running]);

  let safeBody = body;
  if (body.length > MAX_BODY_CHARS) {
    if (typeof console !== 'undefined') console.warn('[artifact] body exceeds the render cap; truncating', { length: body.length });
    safeBody = body.slice(0, MAX_BODY_CHARS);
  }

  // ADR 1017 D1 (grade-ux B1) — `inert` takes the static frame out of the
  // accessibility tree, so a screen reader gets the content's text here instead,
  // without having to run scripts to read it. Computed from a SETTLED body: a live
  // editor changes it on every keystroke, and the parse is up to 512k chars.
  const [settledBody, setSettledBody] = useState(safeBody);
  useEffect(() => {
    const id = setTimeout(() => setSettledBody(safeBody), 300);
    return () => clearTimeout(id);
  }, [safeBody]);
  const textAlt = useMemo(() => (running ? '' : artifactTextAlternative(settledBody)), [running, settledBody]);
  const interactive = useMemo(() => hasInteractiveContent(settledBody), [settledBody]);
  // The note is a live region only once the viewer has toggled it: a document with N
  // embeds must not mount N live regions that all speak on load.
  const [toggled, setToggled] = useState(false);

  const run = (): void => {
    setToggled(true);
    setRunningKey(key);
    // Focus lands on the frame the viewer just started (after the remount).
    requestAnimationFrame(() => frameRef.current?.focus());
  };

  return (
    <div className="artifact-sandbox">
      <div className="artifact-sandbox__bar">
        <p id={noticeId} className="artifact-sandbox__note" {...(toggled ? { role: 'status' } : {})}>
          {running ? t('artifactScriptsRunning') : interactive ? t('artifactScriptsOff') : t('artifactStaticComplete')}
        </p>
        {running ? (
          <Button variant="secondary" aria-describedby={noticeId} onClick={() => { setToggled(true); setRunningKey(null); }}>{t('artifactStopScripts')}</Button>
        ) : interactive ? (
          <Button variant="secondary" aria-describedby={noticeId} onClick={run}>{t('artifactRunScripts')}</Button>
        ) : null}
      </div>
      {/* Untrusted text as a React text child (escaped), never interpolated into a
          translation string (i18next would HTML-escape it into visible entities). */}
      {textAlt ? <div className="sr-only"><span>{t('artifactTextAlternative')}</span>{' '}<span>{textAlt}</span></div> : null}
      <iframe
        // A new element per mode: sandbox flags are read only at navigation.
        key={running ? 'running' : 'static'}
        ref={frameRef}
        className="artifact-sandbox-frame"
        sandbox={running ? ARTIFACT_SANDBOX : ARTIFACT_SANDBOX_STATIC}
        srcDoc={buildArtifactSrcdoc(safeBody)}
        title={title ?? t('interactiveArtifactTitle')}
        // Strips the referrer from anything the frame is allowed to load.
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
