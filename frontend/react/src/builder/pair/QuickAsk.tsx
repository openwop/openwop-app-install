/**
 * ADR 0773 D1/D6 — the one-line ask. Docked at the foot of the Inspect tab, and
 * reused inline (⌘. / the near-selection "Ask"). It never opens a second chat:
 * submitting hands the text to the ONE Pair conversation (`usePairStore.ask`),
 * which switches to the Pair tab and sends it through the embed's normal submit.
 */

import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { SendIcon } from '../../ui/icons/index.js';
import { useBuilderStore } from '../store/builderStore.js';
import { usePairStore } from './pairStore.js';

export function QuickAsk({ autoFocus = false, onDone, framing, inline = false }: {
  autoFocus?: boolean;
  /** An inline surface (node/edge/selection): a small result also offers Keep
   *  in a toast where the person is looking (G-02c). */
  inline?: boolean;
  onDone?: () => void;
  /** Prefix the question with what it is about (e.g. an edge), so the Architect
   *  reads the right scope even when the selection chip says it too. */
  framing?: string;
}): JSX.Element {
  const { t } = useTranslation('builder');
  const [text, setText] = useState('');
  const subject = useBuilderStore((s) => {
    const n = s.nodes.find((x) => x.id === (s.selectedNodeId ?? s.selectedNodeIds[0]));
    return n?.name ?? null;
  });
  const ask = usePairStore((s) => s.ask);
  // Several QuickAsks can be mounted at once (Inspect dock, edge ask, node
  // toolbar) — a fixed id would pair each label with the wrong input (CR-8).
  const inputId = useId();

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    ask(framing ? `${framing}\n\n${v}` : v, { inline });
    setText('');
    onDone?.();
  };

  const label = subject ? t('pairAskAbout', { name: subject }) : t('pairAskAnything');
  return (
    <form className="pair-quick-ask" onSubmit={submit}>
      <label className="sr-only" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="pair-quick-ask__input"
        value={text}
        placeholder={label}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onDone?.(); }}
      />
      <Button type="submit" variant="accent-solid" size="sm" aria-label={t('pairAskSend')} disabled={!text.trim()}>
        <SendIcon size={14} aria-hidden />
      </Button>
    </form>
  );
}
