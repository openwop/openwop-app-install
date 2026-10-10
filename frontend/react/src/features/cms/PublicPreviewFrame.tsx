import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders `children` inside an isolated <iframe> that links the app's OWN
 * stylesheet(s) but whose document contains ONLY the given markup. So the CMS
 * "Public" preview shows the real published front page — the `.fp-*` / token
 * CSS the live site uses — WITHOUT the admin app's layout/theme context bleeding
 * in (the editor lives deep inside the admin shell; an iframe removes all of it).
 *
 * `children` are portaled into the iframe body, so React context (router, i18n,
 * the media/asset resolvers the sections use) still resolves — the same tree the
 * live FrontPage renders, just re-homed into a clean document.
 */
export function PublicPreviewFrame({ children, title, onDocument }: {
  children: ReactNode;
  title: string;
  /** The frame's document, each time it is (re)mounted, so the editor can bind
   *  its keyboard shortcuts inside the frame as well as outside it. */
  onDocument?: ((doc: Document) => void) | undefined;
}): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);

  const sync = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    // Mirror the light/dark theme (the live front page is token-driven, so it
    // follows whichever theme the root carries) — cheap, runs on every sync.
    doc.documentElement.className = document.documentElement.className;
    doc.documentElement.style.colorScheme = getComputedStyle(document.documentElement).colorScheme;
    // Clone the parent's stylesheets + fonts into the iframe head ONCE so tokens
    // + `.fp-*` rules resolve exactly as on the live site (Vite ships <style> in
    // dev, <link> in prod — clone both). A marker guards against re-cloning on
    // theme toggles / re-loads, which would churn the DOM under the portal.
    if (doc.getElementById('cms-pv-stylesheets')) { setMount(doc.body); onDocument?.(doc); return; }
    const marker = doc.createElement('meta'); marker.id = 'cms-pv-stylesheets'; doc.head.appendChild(marker);
    document.querySelectorAll('link[rel="stylesheet"], style').forEach((n) => doc.head.appendChild(n.cloneNode(true)));
    doc.body.className = 'cms-public-page';
    doc.body.style.margin = '0';
    setMount(doc.body);
    onDocument?.(doc);
  }, [onDocument]);

  // Mount as soon as the frame has a document. Chromium completes a src-less
  // iframe's about:blank document at insertion and fires its `load` before
  // React listens, so with `onLoad` alone the preview stayed blank. `onLoad`
  // still covers a browser that swaps the initial document later: `sync`
  // re-clones into the new one and re-mounts there.
  useEffect(() => {
    if (ref.current?.contentDocument?.body) sync();
  }, [sync]);

  // Re-clone the stylesheets when the operator flips the app theme.
  useEffect(() => {
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [sync]);

  return (
    <>
      {/* onLoad is the iframe's document-ready signal (not a mouse/keyboard
          interaction) — the a11y rule is a false positive here. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <iframe ref={ref} title={title} className="cms-public-frame" onLoad={sync} />
      {mount ? createPortal(children, mount) : null}
    </>
  );
}
