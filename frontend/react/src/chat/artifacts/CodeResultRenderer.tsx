/**
 * ADR 0995 D10 — the `code.execution-result` renderer. Without one the workbench fell back to
 * inert Markdown and showed the result as a JSON blob with escaped newlines. The payload is
 * program output, UNTRUSTED (ADR 0114 Phase 4b), so every field renders as a text child: an
 * exit-status chip, then stdout and stderr in their own blocks. Nothing is interpreted.
 */
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

interface CodeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  language?: string;
}

/** Parse the artifact body; null when it is not a code result (the caller says so). */
export function parseCodeResult(content: string): CodeResult | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.exitCode !== 'number' || typeof r.stdout !== 'string' || typeof r.stderr !== 'string') return null;
  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut === true,
    ...(typeof r.language === 'string' ? { language: r.language } : {}),
  };
}

export function CodeResultRenderer({ content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const result = parseCodeResult(content);
  if (!result) return <Notice variant="warning">{t('codeResultUnreadable')}</Notice>;
  const status = result.timedOut
    ? { cls: 'chip chip--warning', label: t('codeResultTimedOut') }
    : result.exitCode === 0
      ? { cls: 'chip chip--success', label: t('codeResultOk') }
      : { cls: 'chip chip--danger', label: t('codeResultFailed', { code: result.exitCode }) };
  return (
    <div className="u-flex u-flex-col u-gap-2" data-testid="code-result">
      <div className="u-flex u-items-center u-gap-1-5">
        <span className={status.cls}>{status.label}</span>
        {result.language ? <span className="chip chip--muted">{result.language}</span> : null}
      </div>
      <section aria-label={t('codeResultStdout')}>
        <p className="muted u-fs-12 u-m-0">{t('codeResultStdout')}</p>
        {result.stdout
          ? <pre className="msgrender-code-pre u-fs-12" tabIndex={0}><code>{result.stdout}</code></pre>
          : <p className="muted u-fs-12 u-m-0">{t('codeResultEmpty')}</p>}
      </section>
      {result.stderr ? (
        <section aria-label={t('codeResultStderr')}>
          <p className="muted u-fs-12 u-m-0">{t('codeResultStderr')}</p>
          <pre className="msgrender-code-pre u-fs-12" tabIndex={0}><code>{result.stderr}</code></pre>
        </section>
      ) : null}
    </div>
  );
}
