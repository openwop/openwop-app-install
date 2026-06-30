/**
 * CodeBlock — a fenced code segment with a copy button (extracted from
 * MessageRenderer so MermaidDiagram can reuse it as its degrade target without a
 * MessageRenderer↔MermaidDiagram import cycle; ADR 0129 Phase 2).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon } from '../ui/icons/index.js';

export interface CodeBlockProps { source: string; language?: string | undefined }

export function CodeBlock({ source, language }: CodeBlockProps): JSX.Element {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable; silently ignore */
    }
  }

  return (
    <div className="msgrender-code">
      <div className="u-flex u-items-center u-justify-between u-pad-4x8 u-bg-surface u-border-b u-fs-11 muted">
        <span>{language ?? t('codeLabel')}</span>
        <button
          type="button"
          className="secondary msgrender-copy-btn"
          onClick={copy}
          aria-label={t('copyCode')}
        >
          {copied ? (
            <span className="u-iflex u-items-center u-gap-1">
              <CheckIcon size={12} /> {t('copied')}
            </span>
          ) : t('copy')}
        </button>
      </div>
      <pre className="msgrender-code-pre">
        <code>{source}</code>
      </pre>
    </div>
  );
}
