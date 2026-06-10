/**
 * Publish-to-registry checklist banner. Extracted from BuilderShell.tsx
 * (pure extraction — no behavior change). Renders the inline checklist
 * for the PR-based registry submission flow.
 */

interface PublishHelp {
  slug: string;
  size: number;
  manifestJson: string;
}

interface PublishHelpBannerProps {
  publishHelp: PublishHelp;
  onClose(): void;
}

export function PublishHelpBanner({ publishHelp, onClose }: PublishHelpBannerProps) {
  return (
    <div
      className="alert alert--publish builder-toolbar-error"
      role="status"
      aria-live="polite"
    >
      <strong>Publish <code>{publishHelp.slug}</code> to packs.openwop.dev</strong>
      <p className="muted publishhelp-intro">
        Registry submission is PR-based ({(publishHelp.size / 1024).toFixed(1)} KB manifest).
        In-browser publishing is intentionally off — Ed25519 signing happens at PR-merge time by the
        registry maintainers, per <code>PUBLISHING.md</code> + <code>spec/v1/registry-operations.md</code>.
      </p>
      <ol className="publishhelp-steps">
        <li>
          <button
            type="button"
            className="linklike"
            onClick={() => {
              const blob = new Blob([publishHelp.manifestJson], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${publishHelp.slug}.manifest.json`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }}
          >
            Download <code>manifest.json</code>
          </button>{' '}
          (you may want to rename <code>{publishHelp.slug}</code> + replace fully-bound values with{' '}
          <code>{'{{params.*}}'}</code> placeholders before submitting).
        </li>
        <li>
          Fork{' '}
          <a href="https://github.com/openwop/openwop" target="_blank" rel="noreferrer">openwop/openwop</a>{' '}
          and add the manifest at{' '}
          <code>registry/packs/{publishHelp.slug}/manifest.json</code>{' '}
          — see{' '}
          <a href="https://github.com/openwop/openwop/tree/main/registry/packs" target="_blank" rel="noreferrer">
            existing entries
          </a>{' '}
          for the directory shape.
        </li>
        <li>
          Run <code>npm run openwop:check</code> locally to validate (the 9-step gate includes pack-manifest +
          signature checks).
        </li>
        <li>
          Open a PR; the maintainers run signing + final validation at merge time, then the pack appears at{' '}
          <a href="https://packs.openwop.dev" target="_blank" rel="noreferrer">packs.openwop.dev</a>.
        </li>
      </ol>
      <div className="button-row">
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
