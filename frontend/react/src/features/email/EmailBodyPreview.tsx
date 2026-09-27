import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { previewMarkdown } from './emailClient.js';

/**
 * ADR 0256 — live preview of a Markdown email body. The HTML comes from the
 * server's authoritative safe renderer (escape-first, scheme-allowlisted links —
 * the same renderer that builds the sent HTML part), so the preview is what
 * actually sends. Rendered in a `sandbox=""` iframe: no scripts, no same-origin —
 * defence-in-depth over the server sanitization, and it isolates the email's own
 * styles from the app shell (a truer preview than inlining into the page).
 */
export function EmailBodyPreview({ orgId, body }: { orgId: string; body: string }): JSX.Element {
  const { t } = useTranslation('email');
  const [html, setHtml] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      previewMarkdown(orgId, body)
        .then((h) => { if (alive) { setHtml(h); setError(false); } })
        .catch(() => { if (alive) setError(true); });
    }, 300); // debounce keystrokes
    return () => { alive = false; clearTimeout(timer); };
  }, [orgId, body]);

  return (
    <div className="u-grid u-gap-1">
      <span className="u-label-sm">{t('previewLabel')}</span>
      {error ? (
        <span className="muted u-fs-13" role="status">{t('previewError')}</span>
      ) : html === '' ? (
        // First render only — `wrapDocument` always returns a non-empty shell, so
        // once rendered the iframe updates in place without flashing back to this.
        <span className="muted u-fs-13" role="status">{t('common:loading')}</span>
      ) : (
        <div className="surface-inset u-p-2">
          <iframe title={t('previewLabel')} sandbox="" srcDoc={html} className="emailpreview-frame" />
        </div>
      )}
    </div>
  );
}
