/**
 * CodeBlock — a fenced code segment with a copy button (extracted from
 * MessageRenderer so MermaidDiagram can reuse it as its degrade target without a
 * MessageRenderer↔MermaidDiagram import cycle; ADR 0129 Phase 2).
 */
import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon } from '../ui/icons/index.js';
import { copyToClipboard } from '../ui/copyToClipboard.js';

export interface CodeBlockProps { source: string; language?: string | undefined }

export function CodeBlock({ source, language }: CodeBlockProps): JSX.Element {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      const r = await copyToClipboard(source, null);
      if (!r.ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* copyToClipboard reports failure itself; nothing left to swallow */
    }
  }

  return (
    <div className="msgrender-code">
      <div className="u-flex u-items-center u-justify-between u-pad-4x8 u-bg-surface u-border-b u-fs-11 muted">
        <span>{language ?? t('codeLabel')}</span>
        <Button
          variant="secondary" className="msgrender-copy-btn"
          onClick={copy}
          aria-label={t('copyCode')}
        >
          {copied ? (
            <span className="u-iflex u-items-center u-gap-1">
              <CheckIcon size={12} /> {t('copied')}
            </span>
          ) : t('copy')}
        </Button>
      </div>
      <pre className="msgrender-code-pre">
        <code>{source}</code>
      </pre>
    </div>
  );
}
